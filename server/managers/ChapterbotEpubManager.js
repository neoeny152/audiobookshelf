const Path = require('path')
const EventEmitter = require('events')
const fs = require('../libs/fsExtra')
const Logger = require('../Logger')
const Database = require('../Database')
const SocketAuthority = require('../SocketAuthority')
const chapterbotClient = require('../utils/chapterbotClient')
const chapterSnap = require('../utils/chapterSnap')
const readAlong = require('../utils/readAlong')
const { sanitizeFilename, filePathToPOSIX, getIno } = require('../utils/fileUtils')
const { writeJsonAtomic, readJson } = require('../utils/autoPipeline/store')

/**
 * EPUB from audio through the chapterbot sidecar (POST /api/items/:id/epub).
 *
 * The server, not the client, follows each job: it polls the sidecar, downloads the finished EPUB, writes
 * "<Title> (from audio).epub" into the library item's folder (never overwriting: an existing name gets " (2)", " (3)", ...),
 * rescans the item so the file shows up as a supplementary ebook, and emits a socket event to the user who started it.
 *
 * One job per library item. Running jobs, and the latest finished job of an item for FINISHED_TTL_MS, are persisted to
 * MetadataPath/pipeline/epub-jobs.json once init() has run. On boot every running entry is adopted and followed again
 * (a job the sidecar no longer knows is marked failed), so the EPUB of a job that was running across a restart still
 * lands in the library, and a finished one still answers GET. An entry that cannot be adopted for a passing reason
 * (chapterbot not configured at boot, a database error) stays in the file for the next boot.
 * A job started by a build without this file (before the fork's persistence) cannot be recovered: start it again.
 *
 * Progress is broadcast as chapterbot_epub_updated (the toJSON record) to every connected user who can access the
 * item, on start, on every poll that changes it and at the end, so anyone who opens the book sees the job (GET
 * /api/items/:id/epub returns the item's current job without a job id). chapterbot_epub_done / chapterbot_epub_failed
 * still go to the user who started the job. The auto pipeline listens to the 'ended' event (EventEmitter).
 */

const ACTIVE = new Set(['starting', 'queued', 'running', 'downloading'])
const FINISHED = new Set(['done', 'failed', 'cancelled'])
const POLL_MS = 15000
/** Give up following a job after this many failed status polls in a row (about 10 minutes at POLL_MS) */
const MAX_POLL_FAILURES = 40
/** A GET refreshes the status from the sidecar when the last poll is older than this */
const REFRESH_MS = 5000
/** Finished jobs are kept this long for GET */
const FINISHED_TTL_MS = 24 * 3600 * 1000
const MAX_TEXT = 500
const MAX_DESCRIPTION = 20000
const MAX_NAME_ATTEMPTS = 50
const COVER_EXTS = new Set(['.jpg', '.jpeg', '.png'])
const BOOK_ID_RE = /^[A-Za-z0-9._-]{1,128}$/
// XML 1.0 forbids these; the sidecar rejects text that contains them
const XML_ILLEGAL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

class EpubJobError extends Error {
  /**
   * @param {number} status - HTTP status for the API response
   * @param {string} message - safe to return to the client
   * @param {Object} [extra]
   */
  constructor(status, message, extra = {}) {
    super(message)
    this.name = 'EpubJobError'
    this.status = status
    Object.assign(this, extra)
  }
}

function xmlText(value, max) {
  if (typeof value !== 'string') return null
  const text = value.replace(XML_ILLEGAL_RE, '').trim()
  if (!text) return null
  return text.length > max ? text.slice(0, max) : text
}

const JOB_ID_RE = /^[A-Za-z0-9_-]{1,128}$/
const ORIGINS = new Set(['user', 'pipeline'])

class ChapterbotEpubManager extends EventEmitter {
  constructor() {
    super()
    /** @type {Map<string, Object>} libraryItemId -> job record */
    this.jobs = new Map()
    this.client = chapterbotClient
    this.pollMs = POLL_MS
    /** @type {(libraryItemId: string) => Promise<*>} */
    this.scanItem = (libraryItemId) => require('../scanner/LibraryItemScanner').scanLibraryItem(libraryItemId)
    /** @type {string|null} where downloads are staged before the copy into the library (default: MetadataPath/cache/chapterbot) */
    this.tempDir = null
    this.now = Date.now
    /** @type {{addIgnoreDir: Function, removeIgnoreDir: Function}|null} folder watcher (default: server/Watcher) */
    this.watcher = null
    /** @type {string|null} where running jobs are persisted; null until init() (tests that never call it persist nothing) */
    this.persistPath = null
    /** @type {Promise<void>} serialises writes of persistPath */
    this.persistChain = Promise.resolve()
    /** @type {Object[]} persisted running entries not adopted for a passing reason, written back until a later boot */
    this.deferred = []
  }

  /**
   * Turn on persistence and adopt the jobs that were running when the server stopped.
   *
   * @param {{persistPath?: string}} [opts]
   */
  async init({ persistPath } = {}) {
    this.persistPath = persistPath || Path.join(global.MetadataPath, 'pipeline', 'epub-jobs.json')
    const entries = await readJson(this.persistPath)
    let adopted = 0
    this.deferred = []
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (entry && FINISHED.has(entry.status)) {
        this.restoreFinished(entry)
        continue
      }
      try {
        if (await this.adopt(entry)) adopted++
        else if (!this.isConfigured && this.isEntry(entry)) this.deferred.push(entry)
      } catch (error) {
        Logger.error(`[ChapterbotEpubManager] Adopting EPUB job ${entry?.jobId} failed, kept for the next start`, error)
        if (this.isEntry(entry)) this.deferred.push(entry)
      }
    }
    if (adopted) Logger.info(`[ChapterbotEpubManager] Following ${adopted} EPUB job(s) again after the restart`)
    await this.persist()
  }

  isEntry(entry) {
    return !!entry && typeof entry.libraryItemId === 'string' && typeof entry.jobId === 'string' && JOB_ID_RE.test(entry.jobId)
  }

  /**
   * Put back the latest finished job of an item (so GET still answers after a restart). Nothing is polled.
   *
   * @param {Object} entry - persisted finished entry
   * @returns {boolean}
   */
  restoreFinished(entry) {
    if (!this.isEntry(entry) || !Number.isFinite(entry.finishedAt) || this.now() - entry.finishedAt > FINISHED_TTL_MS) return false
    if (this.jobs.has(entry.libraryItemId)) return false
    const access = entry.access && typeof entry.access.libraryId === 'string' ? { libraryId: entry.access.libraryId, media: { explicit: !!entry.access.media?.explicit, tags: Array.isArray(entry.access.media?.tags) ? entry.access.media.tags.filter((t) => typeof t === 'string') : [] } } : null
    const text = (value, max) => (typeof value === 'string' ? value.slice(0, max) : null)
    const record = this.newRecord(
      { id: entry.libraryItemId, libraryId: access?.libraryId, media: access?.media },
      {
        jobId: entry.jobId,
        userId: typeof entry.userId === 'string' ? entry.userId : null,
        origin: ORIGINS.has(entry.origin) ? entry.origin : 'user',
        title: text(entry.title, MAX_TEXT) || 'Untitled',
        status: entry.status,
        stage: entry.status === 'done' ? 'done' : null,
        progress: entry.status === 'done' ? 1 : Number.isFinite(entry.progress) ? Math.min(1, Math.max(0, entry.progress)) : 0,
        chaptersDone: Number.isInteger(entry.chaptersDone) ? entry.chaptersDone : 0,
        chaptersTotal: Number.isInteger(entry.chaptersTotal) ? entry.chaptersTotal : 0,
        error: text(entry.error, MAX_TEXT),
        fileName: text(entry.fileName, 1024),
        createdAt: Number.isFinite(entry.createdAt) ? entry.createdAt : entry.finishedAt,
        finishedAt: entry.finishedAt,
        access
      }
    )
    this.jobs.set(entry.libraryItemId, record)
    return true
  }

  /**
   * Follow a job that was running before a restart.
   *
   * @param {{libraryItemId: string, jobId: string, origin?: string, userId?: string|null, createdAt?: number}} entry
   * @returns {Promise<boolean>} whether the job is followed again
   */
  async adopt(entry) {
    if (!entry || typeof entry.libraryItemId !== 'string' || typeof entry.jobId !== 'string' || !JOB_ID_RE.test(entry.jobId)) return false
    if (this.jobs.has(entry.libraryItemId)) return false
    if (!this.isConfigured) {
      Logger.warn(`[ChapterbotEpubManager] Not following EPUB job ${entry.jobId} after the restart: chapterbot is not configured`)
      return false
    }
    const libraryItem = await Database.libraryItemModel.getExpandedById(entry.libraryItemId)
    if (!libraryItem?.media) {
      Logger.warn(`[ChapterbotEpubManager] Not following EPUB job ${entry.jobId}: library item "${entry.libraryItemId}" no longer exists`)
      this.client.deleteJob(entry.jobId).catch(() => {})
      return false
    }
    const record = this.newRecord(libraryItem, {
      jobId: entry.jobId,
      userId: typeof entry.userId === 'string' ? entry.userId : null,
      origin: ORIGINS.has(entry.origin) ? entry.origin : 'user',
      title: xmlText(libraryItem.media.title, MAX_TEXT) || 'Untitled',
      chaptersTotal: 0,
      createdAt: Number.isFinite(entry.createdAt) ? entry.createdAt : this.now(),
      // the sidecar says where the job is on the first poll (a 404 marks it failed)
      status: 'queued'
    })
    this.jobs.set(libraryItem.id, record)
    this.refresh(record)
      .catch((error) => Logger.error(`[ChapterbotEpubManager] Following EPUB job ${record.jobId} failed`, error))
      .finally(() => this.schedule(record))
    return true
  }

  /**
   * Write the running jobs to persistPath (no-op before init()).
   *
   * @returns {Promise<void>}
   */
  persist() {
    if (!this.persistPath) return Promise.resolve()
    const file = this.persistPath
    const now = this.now()
    const entries = []
    for (const r of this.jobs.values()) {
      if (!r.jobId) continue
      const base = { libraryItemId: r.libraryItemId, jobId: r.jobId, origin: r.origin, userId: r.userId, createdAt: r.createdAt }
      if (ACTIVE.has(r.status)) entries.push(base)
      else if (FINISHED.has(r.status) && r.finishedAt && now - r.finishedAt <= FINISHED_TTL_MS) {
        entries.push({ ...base, status: r.status, finishedAt: r.finishedAt, fileName: r.fileName, error: r.error, title: r.title, progress: r.progress, chaptersDone: r.chaptersDone, chaptersTotal: r.chaptersTotal, access: r.access })
      }
    }
    for (const entry of this.deferred) if (!this.jobs.has(entry.libraryItemId)) entries.push(entry)
    this.persistChain = this.persistChain.then(() => writeJsonAtomic(file, entries)).catch((error) => Logger.warn(`[ChapterbotEpubManager] Saving the EPUB job list failed: ${error.message}`))
    return this.persistChain
  }

  /**
   * @param {import('../models/LibraryItem')} libraryItem
   * @param {Object} fields
   * @returns {Object}
   */
  newRecord(libraryItem, fields) {
    return {
      jobId: null,
      libraryItemId: libraryItem.id,
      userId: null,
      origin: 'user',
      title: 'Untitled',
      status: 'starting',
      stage: null,
      progress: 0,
      chaptersDone: 0,
      chaptersTotal: 0,
      error: null,
      fileName: null,
      cancelRequested: false,
      createdAt: this.now(),
      finishedAt: null,
      lastPolledAt: 0,
      pollFailures: 0,
      timer: null,
      refreshing: null,
      /** @type {Promise<void>|null} the background download/copy/rescan once the sidecar reports done */
      finishing: null,
      /** what SocketAuthority needs to decide who may see the job (User.checkCanAccessLibraryItem) */
      access: { libraryId: libraryItem.libraryId, media: { explicit: !!libraryItem.media?.explicit, tags: [...(libraryItem.media?.tags || [])] } },
      ...fields
    }
  }

  getWatcher() {
    return this.watcher || require('../Watcher')
  }

  get isConfigured() {
    return this.client.isConfigured()
  }

  /**
   * Build the sidecar EpubRequest for a library item.
   *
   * @param {import('../models/LibraryItem')} libraryItem - expanded
   * @returns {Object}
   * @throws {EpubJobError}
   */
  buildRequest(libraryItem) {
    const media = libraryItem.media
    const timeline = chapterSnap.buildTimeline(media.includedAudioFiles)
    let files
    try {
      files = this.client.mapFiles(timeline)
    } catch (error) {
      if (error.code === 'path_unmapped') throw new EpubJobError(400, 'The audio files are outside the configured chapterbot path map (CHAPTERBOT_PATH_MAP)')
      throw error
    }
    if (!files.length) throw new EpubJobError(400, 'Item has no audio with a known duration')
    const total = files.reduce((end, f) => Math.max(end, f.offset + f.duration), 0)

    const title = xmlText(media.title, MAX_TEXT) || 'Untitled'
    const chapters = []
    const seen = new Set()
    const sorted = [...(media.chapters || [])].filter((c) => c && Number.isFinite(c.start)).sort((a, b) => a.start - b.start)
    sorted.forEach((c, i) => {
      if (c.start < 0 || c.start >= total) return
      const key = Math.round(c.start * 1000)
      if (seen.has(key)) return
      seen.add(key)
      chapters.push({ title: xmlText(c.title, MAX_TEXT) || `Chapter ${i + 1}`, start: c.start })
    })
    if (!chapters.length || chapters[0].start > 0) {
      // the text before the first chapter mark still belongs in the book
      chapters.unshift({ title: chapters.length ? 'Opening' : title, start: 0 })
    }

    const payload = {
      files,
      chapters,
      title,
      author: xmlText(media.authorName, MAX_TEXT) || 'Unknown Author'
    }
    const subtitle = xmlText(media.subtitle, MAX_TEXT)
    if (subtitle) payload.subtitle = subtitle
    const narrator = xmlText(Array.isArray(media.narrators) ? media.narrators.join(', ') : null, MAX_TEXT)
    if (narrator) payload.narrator = narrator
    const publisher = xmlText(media.publisher, MAX_TEXT)
    if (publisher) payload.publisher = publisher
    const description = xmlText(media.description, MAX_DESCRIPTION)
    if (description) payload.description = description
    if (BOOK_ID_RE.test(libraryItem.id)) payload.bookId = libraryItem.id

    if (media.coverPath && COVER_EXTS.has(Path.extname(media.coverPath).toLowerCase())) {
      try {
        payload.cover = this.client.mapOnePath(media.coverPath)
      } catch {
        // a cover outside the media root (e.g. in the metadata folder) is left out, never sent
        Logger.debug(`[ChapterbotEpubManager] Cover of "${libraryItem.id}" is outside the path map, building without a cover`)
      }
    }
    return payload
  }

  /**
   * @param {string} libraryItemId
   * @returns {Object|null}
   */
  getRecord(libraryItemId) {
    const record = this.jobs.get(libraryItemId)
    if (!record) return null
    if (!ACTIVE.has(record.status) && record.finishedAt && this.now() - record.finishedAt > FINISHED_TTL_MS) {
      this.jobs.delete(libraryItemId)
      return null
    }
    return record
  }

  /**
   * Start an EPUB job for a library item.
   *
   * @param {import('../models/LibraryItem')} libraryItem - expanded
   * @param {{id: string, username?: string}|null} user - null for a job the server starts itself (auto pipeline)
   * @param {{origin?: 'user'|'pipeline'}} [opts]
   * @returns {Promise<Object>} the job (toJSON)
   * @throws {EpubJobError}
   */
  async start(libraryItem, user, { origin = 'user' } = {}) {
    if (!this.isConfigured) throw new EpubJobError(400, 'EPUB from audio needs chapterbot, which is not configured on this server (CHAPTERBOT_URL, CHAPTERBOT_TOKEN, CHAPTERBOT_PATH_MAP)')
    if (libraryItem.isMissing || !libraryItem.isBook || !libraryItem.media?.hasAudioTracks) throw new EpubJobError(400, 'Item is not a book with audio tracks')
    if (libraryItem.isFile) throw new EpubJobError(400, 'Item is a single file without its own folder, so there is nowhere to put the EPUB')

    const existing = this.getRecord(libraryItem.id)
    if (existing && ACTIVE.has(existing.status)) throw new EpubJobError(409, 'An EPUB job is already running for this item', { jobId: existing.jobId })

    const payload = this.buildRequest(libraryItem)

    // reserve the item before the first await so two requests cannot both start a job
    const record = this.newRecord(libraryItem, {
      userId: user?.id || null,
      origin: ORIGINS.has(origin) ? origin : 'user',
      title: payload.title,
      chaptersTotal: payload.chapters.length
    })
    this.jobs.set(libraryItem.id, record)

    let created
    try {
      created = await this.client.createEpubJob(payload)
    } catch (error) {
      this.jobs.delete(libraryItem.id)
      Logger.error(`[ChapterbotEpubManager] Starting EPUB job for "${libraryItem.id}" failed: ${error.message}`)
      if (error.status === 429) throw new EpubJobError(429, 'Chapterbot already has too many EPUB jobs queued, try again later')
      throw new EpubJobError(502, 'Chapterbot could not start the EPUB job', error.detailCode ? { code: error.detailCode } : {})
    }
    record.jobId = created.jobId
    record.status = created.status === 'running' ? 'running' : 'queued'
    Logger.info(`[ChapterbotEpubManager] EPUB job ${record.jobId} started for "${libraryItem.id}" by ${user ? `"${user.username}"` : record.origin} (${payload.chapters.length} chapters, ${payload.files.length} files)`)
    this.schedule(record)
    this.persist()
    this.broadcast(record)
    return this.toJSON(record)
  }

  schedule(record) {
    clearTimeout(record.timer)
    if (!ACTIVE.has(record.status) || record.status === 'downloading') return
    record.timer = setTimeout(() => {
      record.timer = null
      this.refresh(record)
        .catch((error) => Logger.error(`[ChapterbotEpubManager] Following EPUB job ${record.jobId} failed`, error))
        .finally(() => this.schedule(record))
    }, this.pollMs)
    if (record.timer.unref) record.timer.unref()
  }

  /**
   * Poll the sidecar once (shared by concurrent callers) and act on the result.
   *
   * @param {Object} record
   * @returns {Promise<void>}
   */
  refresh(record) {
    if (!record.refreshing) {
      record.refreshing = this._refresh(record).finally(() => {
        record.refreshing = null
      })
    }
    return record.refreshing
  }

  async _refresh(record) {
    if (!record.jobId || !['queued', 'running'].includes(record.status)) return
    let state
    try {
      state = await this.client.getJob(record.jobId)
      record.pollFailures = 0
    } catch (error) {
      record.lastPolledAt = this.now()
      if (error.status === 404) return this.fail(record, 'The job no longer exists on chapterbot')
      record.pollFailures++
      Logger.warn(`[ChapterbotEpubManager] Polling EPUB job ${record.jobId} failed (${record.pollFailures}): ${error.message}`)
      if (record.pollFailures >= MAX_POLL_FAILURES) return this.fail(record, 'Lost contact with chapterbot')
      return
    }
    record.lastPolledAt = this.now()
    if (!['queued', 'running'].includes(record.status)) return // cancelled meanwhile

    const before = this.progressKey(record)
    try {
      this.applyState(record, state)
    } finally {
      // fail() and cancelled() broadcast themselves; this covers progress and the move to 'downloading'
      if (ACTIVE.has(record.status) && this.progressKey(record) !== before) this.broadcast(record)
    }
  }

  progressKey(record) {
    return [record.status, record.stage, record.progress, record.chaptersDone, record.chaptersTotal, record.cancelRequested].join('|')
  }

  /**
   * Act on one sidecar job status.
   *
   * @param {Object} record
   * @param {Object} state - GET /v1/jobs/:id
   */
  applyState(record, state) {
    if (typeof state.stage === 'string') record.stage = state.stage.slice(0, 64)
    if (Number.isFinite(state.progress)) record.progress = Math.min(1, Math.max(0, state.progress))
    if (Number.isInteger(state.chaptersDone)) record.chaptersDone = state.chaptersDone
    if (Number.isInteger(state.chaptersTotal)) record.chaptersTotal = state.chaptersTotal
    if (state.cancelRequested === true) record.cancelRequested = true

    switch (state.status) {
      case 'queued':
      case 'running':
        record.status = state.status
        return
      case 'done':
        // download, copy and rescan in the background: finish() marks the record 'downloading' before its first
        // await, so a status GET that triggered this poll answers at once and the socket event reports the end
        record.finishing = this.finish(record).catch((error) => {
          Logger.error(`[ChapterbotEpubManager] Finishing EPUB job ${record.jobId} failed`, error)
          if (record.status === 'downloading') this.fail(record, 'Saving the EPUB into the library failed')
        })
        return
      case 'cancelled':
        return this.cancelled(record)
      case 'failed':
        return this.fail(record, typeof state.error === 'string' && state.error ? `Chapterbot: ${state.error.slice(0, 300)}` : 'Chapterbot failed to build the EPUB')
      default:
        Logger.warn(`[ChapterbotEpubManager] Unknown status "${String(state.status).slice(0, 32)}" for EPUB job ${record.jobId}`)
    }
  }

  stagingDir() {
    return this.tempDir || Path.join(global.MetadataPath, 'cache', 'chapterbot')
  }

  /**
   * Copy `src` into `dir` as "<base>.epub", "<base> (2).epub", ... never replacing an existing file.
   *
   * @returns {Promise<string>} the full path written
   */
  async placeFile(src, dir, base) {
    for (let n = 1; n <= MAX_NAME_ATTEMPTS; n++) {
      const target = Path.join(dir, n === 1 ? `${base}.epub` : `${base} (${n}).epub`)
      try {
        // COPYFILE_EXCL opens the target with O_EXCL: fails instead of overwriting, even in a race
        await fs.copyFile(src, target, fs.constants.COPYFILE_EXCL)
        return target
      } catch (error) {
        if (error.code !== 'EEXIST') throw error
      }
    }
    throw new Error(`no free file name for "${base}.epub"`)
  }

  async finish(record) {
    record.status = 'downloading'
    record.stage = 'downloading'
    clearTimeout(record.timer)

    const libraryItem = await Database.libraryItemModel.getExpandedById(record.libraryItemId)
    if (!libraryItem || libraryItem.isMissing) return this.fail(record, 'The library item no longer exists')
    const dir = libraryItem.path
    if (!dir || libraryItem.isFile || !(await fs.pathExists(dir))) return this.fail(record, 'The library item folder no longer exists')
    const hadPrimaryEbook = !!libraryItem.media?.ebookFile

    const staging = this.stagingDir()
    const temp = Path.join(staging, `${record.jobId}.epub`)
    // The folder watcher would rescan the item about 10 s after the file appears and, finding no primary ebook,
    // promote this EPUB to one (stock scanner rule), undoing keepSupplementary(). Keep the watcher off this folder
    // from the copy until our own rescan is done (released 5 s later, as for podcast downloads).
    const watcher = this.getWatcher()
    let ignoring = false
    try {
      return await this.saveAndScan(record, { dir, staging, temp, hadPrimaryEbook }, () => {
        watcher.addIgnoreDir(dir)
        ignoring = true
      })
    } finally {
      if (ignoring) watcher.removeIgnoreDir(dir)
    }
  }

  /**
   * @param {Object} record
   * @param {{dir: string, staging: string, temp: string, hadPrimaryEbook: boolean}} target
   * @param {() => void} beforeCopy - called once the download is complete, right before the file goes into the library
   */
  async saveAndScan(record, { dir, staging, temp, hadPrimaryEbook }, beforeCopy) {
    let finalPath = null
    try {
      await fs.ensureDir(staging)
      await fs.remove(temp)
      const out = fs.createWriteStream(temp, { flags: 'wx' })
      const closed = new Promise((resolve) => out.once('close', resolve))
      // open the staging file before asking the sidecar, so an open() failure is an ordinary error here
      await new Promise((resolve, reject) => {
        out.once('open', resolve)
        out.once('error', reject)
      })
      try {
        await this.client.downloadJobResult(record.jobId, out)
      } catch (error) {
        out.destroy()
        await closed
        throw error
      }
      // 'finish' resolved the download; wait for the file to be closed before copying it
      await closed
      const base = sanitizeFilename(`${record.title} (from audio)`) || 'Book (from audio)'
      beforeCopy()
      finalPath = await this.placeFile(temp, dir, base)
    } catch (error) {
      Logger.error(`[ChapterbotEpubManager] Saving the EPUB of job ${record.jobId} for "${record.libraryItemId}" failed: ${error.message}`)
      return this.fail(record, 'Saving the EPUB into the library failed')
    } finally {
      await fs.remove(temp).catch(() => {})
    }

    record.fileName = Path.basename(finalPath)
    Logger.info(`[ChapterbotEpubManager] Wrote "${finalPath}" from EPUB job ${record.jobId}`)

    try {
      await this.scanItem(record.libraryItemId)
      if (!hadPrimaryEbook) await this.keepSupplementary(record.libraryItemId, finalPath)
    } catch (error) {
      // the file is in place; a later scan will pick it up
      Logger.error(`[ChapterbotEpubManager] Rescan of "${record.libraryItemId}" after EPUB job ${record.jobId} failed`, error)
    }

    await this.saveReadAlong(record, finalPath)

    // the sidecar keeps a finished job's files until it is deleted
    this.client.deleteJob(record.jobId).catch((error) => Logger.warn(`[ChapterbotEpubManager] Deleting finished EPUB job ${record.jobId} on chapterbot failed: ${error.message}`))

    record.status = 'done'
    record.stage = 'done'
    record.progress = 1
    record.finishedAt = this.now()
    this.ended(record, 'chapterbot_epub_done')
  }

  /**
   * Fetch the read-along data built with the EPUB and store it under the item's metadata folder, keyed by the
   * placed EPUB's ino (see utils/readAlong.js). Never fails the job: the EPUB works without it.
   *
   * @param {Object} record
   * @param {string} finalPath - the EPUB in the library item folder
   */
  async saveReadAlong(record, finalPath) {
    try {
      const data = await this.client.downloadJobReadAlong(record.jobId)
      if (!data) {
        Logger.warn(`[ChapterbotEpubManager] EPUB job ${record.jobId} has no read-along data (sidecar older than the feature), saved the EPUB without it`)
        return
      }
      const normalized = readAlong.validate(data)
      const ino = await getIno(finalPath)
      if (!ino) throw new Error('the placed EPUB could not be read')
      await readAlong.save(record.libraryItemId, ino, Path.basename(finalPath), normalized)
      Logger.info(`[ChapterbotEpubManager] Saved read-along data (${normalized.sentences.length} sentences) for "${finalPath}"`)
    } catch (error) {
      Logger.warn(`[ChapterbotEpubManager] Saving the read-along data of EPUB job ${record.jobId} failed: ${error.message}`)
    }
  }

  /**
   * A rescan makes the first ebook of a book without one its primary ebook. This EPUB is a by-product of the audio,
   * so turn it back into a supplementary ebook (as PATCH /api/items/:id/ebook/:fileid/status does).
   * The folder watcher is kept off the folder meanwhile (see finish()). A later library or item scan, while the book
   * still has no primary ebook, may promote it again (stock scanner rule, unchanged here).
   */
  async keepSupplementary(libraryItemId, finalPath) {
    const libraryItem = await Database.libraryItemModel.getExpandedById(libraryItemId)
    if (!libraryItem?.media?.ebookFile) return
    const posixPath = filePathToPOSIX(finalPath)
    const libraryFile = (libraryItem.libraryFiles || []).find((lf) => lf.metadata?.path === posixPath)
    if (!libraryFile || libraryItem.media.ebookFile.ino !== libraryFile.ino) return

    libraryItem.media.ebookFile = null
    libraryItem.media.changed('ebookFile', true)
    await libraryItem.media.save()
    libraryItem.libraryFiles = libraryItem.libraryFiles.map((lf) => (lf.ino === libraryFile.ino ? { ...lf, isSupplementary: true } : lf))
    libraryItem.changed('libraryFiles', true)
    libraryItem.isMissing = !libraryItem.media.hasMediaFiles
    await libraryItem.save()
    SocketAuthority.libraryItemEmitter('item_updated', libraryItem)
  }

  fail(record, message) {
    clearTimeout(record.timer)
    record.status = 'failed'
    record.error = message
    record.finishedAt = this.now()
    Logger.warn(`[ChapterbotEpubManager] EPUB job ${record.jobId} for "${record.libraryItemId}" failed: ${message}`)
    this.ended(record, 'chapterbot_epub_failed')
  }

  cancelled(record) {
    clearTimeout(record.timer)
    record.status = 'cancelled'
    record.finishedAt = this.now()
    this.client.deleteJob(record.jobId).catch(() => {})
    this.ended(record, 'chapterbot_epub_failed')
  }

  /**
   * A job ended (done, failed or cancelled): tell the user who started it, everyone who can see the item and the
   * auto pipeline ('ended' event), and drop it from the persisted list.
   *
   * @param {Object} record
   * @param {string} userEvent
   */
  ended(record, userEvent) {
    this.emitToUser(record, userEvent)
    this.broadcast(record)
    this.persist()
    try {
      this.emit('ended', { ...this.toJSON(record), userId: record.userId })
    } catch (error) {
      Logger.error(`[ChapterbotEpubManager] An 'ended' listener failed for EPUB job ${record.jobId}`, error)
    }
  }

  emitToUser(record, event) {
    if (record.userId) SocketAuthority.clientEmitter(record.userId, event, this.toJSON(record))
  }

  /**
   * chapterbot_epub_updated to every connected user who can access the item.
   *
   * @param {Object} record
   */
  broadcast(record) {
    if (!record.access) return
    SocketAuthority.emitter('chapterbot_epub_updated', this.toJSON(record), (user) => typeof user.checkCanAccessLibraryItem === 'function' && user.checkCanAccessLibraryItem(record.access))
  }

  /**
   * The item's current job, or its latest one (finished jobs are kept for FINISHED_TTL_MS). Refreshes from the
   * sidecar when the last poll is stale.
   *
   * @param {string} libraryItemId
   * @returns {Promise<Object|null>}
   */
  async getCurrent(libraryItemId) {
    const record = this.getRecord(libraryItemId)
    if (!record || !record.jobId) return null
    return this.get(libraryItemId, record.jobId)
  }

  /**
   * GET status. Refreshes from the sidecar when the last poll is stale.
   *
   * @param {string} libraryItemId
   * @param {string} jobId
   * @returns {Promise<Object|null>}
   */
  async get(libraryItemId, jobId) {
    const record = this.getRecord(libraryItemId)
    if (!record || record.jobId !== jobId) return null
    if (['queued', 'running'].includes(record.status) && this.now() - record.lastPolledAt > REFRESH_MS) {
      await this.refresh(record).catch((error) => Logger.warn(`[ChapterbotEpubManager] Refreshing EPUB job ${jobId} failed: ${error.message}`))
    }
    return this.toJSON(record)
  }

  /**
   * Cancel a queued or running job.
   *
   * @param {string} libraryItemId
   * @param {string} jobId
   * @returns {Promise<Object>}
   * @throws {EpubJobError}
   */
  async cancel(libraryItemId, jobId) {
    const record = this.getRecord(libraryItemId)
    if (!record || record.jobId !== jobId) throw new EpubJobError(404, 'No such EPUB job')
    if (!['queued', 'running'].includes(record.status)) throw new EpubJobError(409, `The EPUB job is ${record.status}`)
    // a poll in flight may be about to see the job end; let it land first
    if (record.refreshing) await record.refreshing.catch(() => {})
    if (!['queued', 'running'].includes(record.status)) throw new EpubJobError(409, `The EPUB job is ${record.status}`)
    let state
    try {
      state = await this.client.deleteJob(jobId)
    } catch (error) {
      Logger.error(`[ChapterbotEpubManager] Cancelling EPUB job ${jobId} failed: ${error.message}`)
      throw new EpubJobError(502, 'Chapterbot could not cancel the EPUB job')
    }
    if (!['queued', 'running'].includes(record.status)) {
      // a poll saw the job end while the DELETE was in flight: that path (finish/fail/cancelled) owns the record now
      Logger.info(`[ChapterbotEpubManager] EPUB job ${jobId} ended (${record.status}) while it was being cancelled`)
      return this.toJSON(record)
    }
    record.cancelRequested = true
    this.broadcast(record)
    // "deleted": the job had already finished on the sidecar and its result is gone, so it is cancelled here too
    // a queued job is cancelled at once; a running one stops at its next segment (seen on a later poll)
    if (state?.status === 'cancelled' || state?.status === 'deleted') this.cancelled(record)
    return this.toJSON(record)
  }

  toJSON(record) {
    return {
      jobId: record.jobId,
      libraryItemId: record.libraryItemId,
      origin: record.origin,
      status: record.status === 'starting' ? 'queued' : record.status,
      stage: record.stage,
      progress: record.progress,
      chaptersDone: record.chaptersDone,
      chaptersTotal: record.chaptersTotal,
      cancelRequested: record.cancelRequested,
      error: record.error,
      fileName: record.fileName,
      createdAt: record.createdAt,
      finishedAt: record.finishedAt
    }
  }

  /** for tests: stop timers, forget every job, turn persistence off and drop 'ended' listeners */
  reset() {
    for (const record of this.jobs.values()) clearTimeout(record.timer)
    this.jobs.clear()
    this.persistPath = null
    this.persistChain = Promise.resolve()
    this.deferred = []
    this.removeAllListeners('ended')
  }
}

const manager = new ChapterbotEpubManager()
module.exports = manager
module.exports.ChapterbotEpubManager = ChapterbotEpubManager
module.exports.EpubJobError = EpubJobError
module.exports.ACTIVE = ACTIVE
module.exports.FINISHED = FINISHED
