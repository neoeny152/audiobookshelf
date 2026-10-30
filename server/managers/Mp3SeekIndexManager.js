const Path = require('path')
const SocketAuthority = require('../SocketAuthority')
const Logger = require('../Logger')
const Database = require('../Database')
const fs = require('../libs/fsExtra')
const TaskManager = require('./TaskManager')
const Task = require('../objects/Task')
const fileUtils = require('../utils/fileUtils')
const mp3SeekIndex = require('../utils/mp3SeekIndex')
const { applyChapters } = require('../utils/applyChapters')

/**
 * @typedef SeekIndexFileStatus
 * @property {number} index
 * @property {string} ino
 * @property {string} filename
 * @property {number} duration - stored (probed) duration
 * @property {import('../utils/mp3SeekIndex').Mp3SeekIndexStatus|null} mp3SeekIndex
 * @property {boolean} needsRepair - no seek header and the measured duration is off by more than DRIFT_THRESHOLD_SEC
 * @property {number} [measuredDuration] - frame count duration (files without a seek header)
 * @property {number} [durationError] - measuredDuration - duration
 *
 * @typedef FileResult
 * @property {string} filename
 * @property {string} ino
 * @property {'repaired'|'restored'|'failed'} status
 * @property {number} oldDuration
 * @property {number|null} newDuration - after the rescan
 * @property {string} [error]
 *
 * @typedef ChapterOutcome
 * @property {number} count
 * @property {'keep'|'shift'} mode
 * @property {boolean} shifted - times moved with the files (mode shift)
 * @property {boolean} endExtended - mode keep: only the last end moved from the old total to the new one
 * @property {boolean} restored - restore: saved chapters put back as they were before the repair
 * @property {number} maxShift
 *
 * @typedef RepairResult
 * @property {'repair'|'restore'} type
 * @property {string} libraryItemId
 * @property {number} finishedAt
 * @property {FileResult[]} files
 * @property {number} oldTotalDuration
 * @property {number} newTotalDuration
 * @property {ChapterOutcome} chapters
 * @property {string|null} [backupId] - repair: the backup holding the originals
 *
 * @typedef BackupFile
 * @property {string} relPath - path inside the item folder (and inside the backup's files/ folder)
 * @property {string} filename
 * @property {number} size
 * @property {number|null} oldDuration
 * @property {number|null} newDuration
 *
 * @typedef BackupManifest
 * One per item: a later repair of the same item adds to it (a file already in it keeps its first, original copy), so
 * a restore always brings back every original. Written when a repair round starts and after every file, so a round
 * cut short (server restart) still has a restorable backup; recoverInterrupted() finishes the round on the next start
 * and resumes the files left in `pending`.
 * @property {string} id
 * @property {string} libraryItemId
 * @property {string} title
 * @property {number} createdAt
 * @property {boolean} complete - false while the repair runs or when it was cut short
 * @property {boolean} [interrupted] - a round was cut short (restart or cancel) and files are left in pending
 * @property {BackupFile[]} [pending] - files of the current round not done yet; left over when a round was cut short
 * @property {{startedAt: number, mode: 'keep'|'shift', oldIncluded: {path: string, duration: number}[], chapters: Object[]}} [round]
 *  the timeline and saved chapters when the current round started (its chapter step works from these)
 * @property {string} [userId] - who started the last round (a resume runs as them)
 * @property {'keep'|'shift'} mode
 * @property {{path: string, duration: number}[]} oldIncluded - included audio files before the repair (timeline)
 * @property {BackupFile[]} files
 * @property {number} size - bytes
 * @property {Object[]} chaptersBefore - saved chapters before the first repair (restore puts these back)
 * @property {Object[]|null} chaptersAfter - saved chapters after the repair
 *
 * @typedef RepairOptions
 * @property {'keep'|'shift'} [chapters='keep'] - shift: move saved chapter times by the duration change of earlier files
 */

const BACKUP_ID_RE = /^[0-9]{8}T[0-9]{6}Z(-[0-9]+)?$/
const MANIFEST = 'backup.json'
const TEMP_FILE_RE = /^\..+\.(seekfix|seekrestore)\.tmp$/

class Mp3SeekIndexManager {
  /**
   * @param {Object} [deps] - injectable for tests
   */
  constructor(deps = {}) {
    /** Originals are kept here, outside every library folder, so the scanner never sees them */
    this.backupsDir = deps.backupsDir || Path.join(global.MetadataPath || '', 'seek-repair-backups')
    this.MAX_CONCURRENT_TASKS = 1
    /** @type {Task[]} */
    this.tasksRunning = []
    /** @type {Task[]} */
    this.tasksQueued = []
    /** @type {Map<string, AbortController>} */
    this.abortControllers = new Map()
    /** @type {Map<string, RepairResult>} last result per library item (until restart) */
    this.lastResults = new Map()
    /** @type {Map<string, Promise>} measurements in flight per library item */
    this.measureInFlight = new Map()
    /** @type {Map<string, {oldIncluded: {path:string, duration:number}[], oldChapters: Object[]}>} per task id; kept out of task.data, which is broadcast */
    this.snapshots = new Map()

    this.repairFile = deps.repairFile || mp3SeekIndex.repairFile
    this.restoreFile = deps.restoreFile || mp3SeekIndex.restoreFile
    this.detectSeekIndex = deps.detectSeekIndex || mp3SeekIndex.detectSeekIndex
    this.measureDuration = deps.measureDuration || mp3SeekIndex.measureDuration
    this.scanItem = deps.scanItem || ((libraryItemId) => require('../scanner/LibraryItemScanner').scanLibraryItem(libraryItemId))
    this.getItem = deps.getItem || ((libraryItemId) => Database.libraryItemModel.getExpandedById(libraryItemId))
    this.applyChapters = deps.applyChapters || applyChapters
    this.watcher = deps.watcher || null
    this.now = deps.now || Date.now
    /** Wait before resuming an interrupted repair after a start, so a burst of restarts does not cut it short again */
    this.resumeDelayMs = deps.resumeDelayMs ?? 60000
    /** @type {Map<string, Promise>} resumes scheduled per item (tests await these) */
    this.resumes = new Map()
  }

  getWatcher() {
    return this.watcher || require('../Watcher')
  }

  getIsLibraryItemQueuedOrProcessing(libraryItemId) {
    return this.tasksQueued.some((t) => t.data.libraryItemId === libraryItemId) || this.tasksRunning.some((t) => t.data.libraryItemId === libraryItemId)
  }

  /**
   * Check the seek header of a book's included MP3s and measure those without one. Files without a stored header check
   * get one (~64 KB read); files without a header and no measurement for their current size/mtime are checked again
   * and measured (frame walk, reads the file). Both are stored on the audio file, so later calls only read the
   * database. Concurrent calls for one item share the same run.
   *
   * @param {import('../models/LibraryItem')} libraryItem - expanded book item
   * @returns {Promise<void>}
   */
  async measure(libraryItem) {
    const inFlight = this.measureInFlight.get(libraryItem.id)
    if (inFlight) return inFlight
    const promise = this.measureFiles(libraryItem).finally(() => this.measureInFlight.delete(libraryItem.id))
    this.measureInFlight.set(libraryItem.id, promise)
    return promise
  }

  async measureFiles(libraryItem) {
    const media = libraryItem.media
    let changed = false
    const audioFiles = (media.audioFiles || []).map((af) => ({ ...af }))

    for (const af of audioFiles) {
      if (af.exclude || !mp3SeekIndex.isMp3AudioFile(af)) continue
      try {
        const stale = af.mp3SeekIndex === 'none' && mp3SeekIndex.getDrift(af) === null
        // A file that changed since it was measured may have been given a header (repair cut short before its rescan)
        if (!af.mp3SeekIndex || (stale && af.mp3Measured)) {
          const status = (await this.detectSeekIndex(af.metadata.path)).status
          if (status !== af.mp3SeekIndex) changed = true
          af.mp3SeekIndex = status
        }
        if (af.mp3SeekIndex === 'none' && mp3SeekIndex.getDrift(af) === null) {
          const { duration } = await this.measureDuration(af.metadata.path)
          af.mp3Measured = { duration: Number(duration.toFixed(3)), size: af.metadata.size, mtimeMs: af.metadata.mtimeMs }
          changed = true
        }
      } catch (error) {
        Logger.warn(`[Mp3SeekIndexManager] Seek index check failed for "${af.metadata.path}": ${error.message}`)
      }
    }

    if (changed) {
      media.audioFiles = audioFiles
      media.changed('audioFiles', true)
      await media.save()
    }
  }

  /**
   * Seek index status of a book's included MP3s (measured first, see measure), with its backups.
   *
   * @param {import('../models/LibraryItem')} libraryItem - expanded book item
   * @returns {Promise<{files: SeekIndexFileStatus[], needsRepairCount: number, maxDrift: number, processing: boolean, lastResult: RepairResult|null, backups: BackupManifest[], backupsTotalSize: number}>}
   */
  async getStatus(libraryItem) {
    await this.measure(libraryItem)
    const files = []
    for (const af of libraryItem.media.audioFiles || []) {
      if (af.exclude || !mp3SeekIndex.isMp3AudioFile(af)) continue
      /** @type {SeekIndexFileStatus} */
      const file = {
        index: af.index,
        ino: af.ino,
        filename: af.metadata.filename,
        duration: af.duration,
        mp3SeekIndex: af.mp3SeekIndex || null,
        needsRepair: mp3SeekIndex.needsRepair(af)
      }
      const drift = mp3SeekIndex.getDrift(af)
      if (af.mp3SeekIndex === 'none' && drift !== null) {
        file.measuredDuration = af.mp3Measured.duration
        file.durationError = Number(drift.toFixed(3))
      }
      files.push(file)
    }

    const flagged = files.filter((f) => f.needsRepair)
    const backups = await this.listBackups(libraryItem.id)
    const processing = this.getIsLibraryItemQueuedOrProcessing(libraryItem.id)
    const cutShort = processing ? null : backups.find((b) => b.pending?.length)
    return {
      files,
      needsRepairCount: flagged.length,
      maxDrift: flagged.reduce((max, f) => Math.max(max, Math.abs(f.durationError || 0)), 0),
      processing,
      /** A repair that a restart (or cancel) cut short: these files were never done */
      interrupted: cutShort ? { backupId: cutShort.id, pendingCount: cutShort.pending.length, files: cutShort.pending.map((f) => f.filename), mode: cutShort.round?.mode || cutShort.mode || 'keep' } : null,
      lastResult: this.lastResults.get(libraryItem.id) || null,
      backups,
      backupsTotalSize: await this.getBackupsTotalSize()
    }
  }

  //
  // Backups
  //

  itemBackupsDir(libraryItemId) {
    return Path.join(this.backupsDir, libraryItemId)
  }

  isValidBackupId(backupId) {
    return typeof backupId === 'string' && BACKUP_ID_RE.test(backupId)
  }

  /**
   * @param {string} libraryItemId
   * @param {{includeIncomplete?: boolean}} [options] - by default only finished backups are listed
   * @returns {Promise<BackupManifest[]>} newest first
   */
  async listBackups(libraryItemId, { includeIncomplete = false } = {}) {
    let names = []
    try {
      names = await fs.readdir(this.itemBackupsDir(libraryItemId))
    } catch {
      return []
    }
    const manifests = []
    for (const name of names.filter((n) => this.isValidBackupId(n))) {
      const manifest = await this.readManifest(libraryItemId, name)
      if (manifest && (includeIncomplete || manifest.complete !== false)) manifests.push(manifest)
    }
    return manifests.sort((a, b) => b.createdAt - a.createdAt)
  }

  async readManifest(libraryItemId, backupId) {
    try {
      return JSON.parse(await fs.readFile(Path.join(this.itemBackupsDir(libraryItemId), backupId, MANIFEST), 'utf8'))
    } catch {
      return null
    }
  }

  async saveManifest(manifest) {
    const dir = Path.join(this.itemBackupsDir(manifest.libraryItemId), manifest.id)
    await fs.ensureDir(dir)
    manifest.size = manifest.files.reduce((sum, f) => sum + (f.size || 0), 0)
    await fs.writeFile(Path.join(dir, MANIFEST), JSON.stringify(manifest, null, 2))
  }

  /** Bytes used by every seek repair backup (all items), from the manifests. */
  async getBackupsTotalSize() {
    let total = 0
    let items = []
    try {
      items = await fs.readdir(this.backupsDir)
    } catch {
      return 0
    }
    for (const itemId of items) {
      for (const manifest of await this.listBackups(itemId, { includeIncomplete: true })) total += manifest.size || 0
    }
    return total
  }

  newBackupId() {
    // 20261030T154012Z, unique per item
    return new Date(this.now()).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  }

  uniqueBackupId(libraryItemId) {
    const base = this.newBackupId()
    const dir = this.itemBackupsDir(libraryItemId)
    let id = base
    for (let n = 2; fs.existsSync(Path.join(dir, id)); n++) id = `${base}-${n}`
    return id
  }

  /**
   * @param {string} libraryItemId
   * @param {string} backupId
   * @returns {Promise<boolean>} false when there is no such backup
   */
  async deleteBackup(libraryItemId, backupId) {
    if (!this.isValidBackupId(backupId)) return false
    const dir = Path.join(this.itemBackupsDir(libraryItemId), backupId)
    if (!(await fs.pathExists(dir))) return false
    await fs.remove(dir)
    const left = await fs.readdir(this.itemBackupsDir(libraryItemId)).catch(() => [])
    if (!left.length) await fs.remove(this.itemBackupsDir(libraryItemId))
    Logger.info(`[Mp3SeekIndexManager] Deleted seek repair backup ${backupId} of item ${libraryItemId}`)
    return true
  }

  /**
   * On server start: finish repairs that a restart cut short. Their manifests are incomplete (or missing, for
   * backups made before manifests were written as the repair went). The item's leftover temp files are removed, the
   * item is rescanned so the durations match the files, the chapter step runs as the repair would have, and the
   * backup is marked complete so it can be restored. A backup with no files is removed.
   */
  async recoverInterrupted() {
    let itemIds = []
    try {
      itemIds = await fs.readdir(this.backupsDir)
    } catch {
      return
    }
    for (const libraryItemId of itemIds) {
      let backupIds = []
      try {
        backupIds = (await fs.readdir(this.itemBackupsDir(libraryItemId))).filter((n) => this.isValidBackupId(n))
      } catch {
        continue
      }
      for (const backupId of backupIds) {
        try {
          await this.recoverBackup(libraryItemId, backupId)
        } catch (error) {
          Logger.error(`[Mp3SeekIndexManager] Recovering seek repair backup ${backupId} of item ${libraryItemId} failed`, error)
        }
      }
    }
  }

  async recoverBackup(libraryItemId, backupId) {
    let manifest = await this.readManifest(libraryItemId, backupId)
    if (manifest && manifest.complete !== false) {
      // The round finished but files were left (recovered before this start, or canceled): resume them
      if (manifest.pending?.length && manifest.interrupted) this.scheduleResume(libraryItemId, backupId)
      return
    }

    const backupDir = Path.join(this.itemBackupsDir(libraryItemId), backupId)
    const filesDir = Path.join(backupDir, 'files')
    const onDisk = await listFilesRecursive(filesDir)
    const item = await this.getItem(libraryItemId)
    if (!item?.media) {
      Logger.warn(`[Mp3SeekIndexManager] Seek repair backup ${backupId}: item ${libraryItemId} no longer exists, leaving the backup as it is`)
      return
    }
    if (!onDisk.length && !manifest?.pending?.length) {
      Logger.warn(`[Mp3SeekIndexManager] Removing seek repair backup ${backupId} of item ${libraryItemId}: it holds no files`)
      await this.deleteBackup(libraryItemId, backupId)
      return
    }
    Logger.info(`[Mp3SeekIndexManager] Finishing seek repair ${backupId} of "${item.media.title}" that a restart cut short`)

    if (!manifest) {
      manifest = { id: backupId, libraryItemId, title: item.media.title, createdAt: this.now(), complete: false, mode: 'keep', oldIncluded: null, files: [], size: 0, chaptersBefore: [], chaptersAfter: null }
    }

    // Which originals really were replaced: the backup copy is made just before the rename, so a copy whose library
    // file still has the same size was never replaced (the cut came in between) and is dropped
    const wasReplaced = async (relPath) => {
      const backup = await fs.stat(Path.join(filesDir, relPath)).catch(() => null)
      const current = await fs.stat(Path.join(item.path, relPath)).catch(() => null)
      return !!backup && (!current || current.size !== backup.size)
    }
    const known = new Map([...(manifest.pending || []), ...manifest.files].map((f) => [f.relPath, f]))
    const done = []
    for (const relPath of onDisk) {
      const entry = known.get(relPath) || { relPath, filename: Path.posix.basename(relPath), size: null, oldDuration: null, newDuration: null }
      const inFiles = manifest.files.some((f) => f.relPath === relPath)
      if (inFiles || (await wasReplaced(relPath))) {
        const stat = await fs.stat(Path.join(filesDir, relPath))
        done.push({ ...entry, size: entry.size ?? stat.size })
      } else {
        await fs.remove(Path.join(filesDir, relPath)).catch(() => {})
      }
    }
    manifest.files = done
    manifest.pending = (manifest.pending || []).filter((f) => !done.some((d) => d.relPath === f.relPath))

    // Leftover temp files of the cut-short task (dotfiles the scanner ignores, but they take space)
    for (const name of await fs.readdir(item.path).catch(() => [])) {
      if (TEMP_FILE_RE.test(name)) await fs.remove(Path.join(item.path, name)).catch(() => {})
    }

    await this.scanItem(libraryItemId)
    const fresh = await this.getItem(libraryItemId)
    const newByPath = new Map((fresh?.media?.includedAudioFiles || []).map((af) => [af.metadata.path, af.duration]))
    for (const f of manifest.files) f.newDuration = newByPath.get(Path.join(item.path, f.relPath)) ?? f.newDuration ?? null
    // The chapter step of the cut round for the files it did; the files resumed later move the chapters on from there
    // (each round maps every time from its files' old to new starts, so rounds add up to the same as one)
    const round = manifest.round || (manifest.oldIncluded?.length ? { mode: manifest.mode, oldIncluded: manifest.oldIncluded, chapters: manifest.chaptersBefore || [] } : null)
    if (round && fresh) {
      await this.applyChapterPolicy(fresh, { oldIncluded: round.oldIncluded, oldChapters: round.chapters || [], mode: round.mode || 'keep' })
    }
    const after = fresh ? await this.getItem(libraryItemId) : null
    manifest.chaptersAfter = (after?.media?.chapters || []).map(plainChapter)
    manifest.complete = true
    manifest.interrupted = manifest.pending.length > 0
    if (!manifest.files.length && !manifest.pending.length) {
      await this.deleteBackup(libraryItemId, backupId)
      return
    }
    await this.saveManifest(manifest)
    if (manifest.pending.length) this.scheduleResume(libraryItemId, backupId)
  }

  /**
   * Resume the files an interrupted repair left, after resumeDelayMs, as the user who started it and with the same
   * chapter mode. Files that no longer need repair are dropped from pending. When the item is busy or gone the backup
   * keeps its pending files and the status reports them (the banner offers Resume).
   *
   * @returns {Promise<Task|null>}
   */
  scheduleResume(libraryItemId, backupId) {
    if (this.resumes.has(libraryItemId)) return this.resumes.get(libraryItemId)
    const promise = new Promise((resolve) => {
      const timer = setTimeout(resolve, this.resumeDelayMs)
      timer.unref?.()
    })
      .then(async () => {
        const manifest = await this.readManifest(libraryItemId, backupId)
        if (!manifest?.pending?.length || this.getIsLibraryItemQueuedOrProcessing(libraryItemId)) return null
        const item = await this.getItem(libraryItemId)
        if (!item?.media) return null
        await this.getStatus(item)
        const fresh = await this.getItem(libraryItemId)
        const pending = new Set(manifest.pending.map((f) => f.relPath))
        const stillNeeded = fresh.media.includedAudioFiles.filter((af) => pending.has(toRelPath(fresh.path, af.metadata.path)) && mp3SeekIndex.needsRepair(af))
        if (!stillNeeded.length) {
          manifest.pending = []
          manifest.interrupted = false
          await this.saveManifest(manifest)
          return null
        }
        Logger.info(`[Mp3SeekIndexManager] Resuming the interrupted seek repair of "${fresh.media.title}": ${stillNeeded.length} file(s) left`)
        return this.startRepair(manifest.userId || null, fresh, { chapters: manifest.round?.mode || manifest.mode || 'keep' })
      })
      .catch((error) => {
        Logger.error(`[Mp3SeekIndexManager] Resuming the seek repair of item ${libraryItemId} failed`, error)
        return null
      })
      .finally(() => this.resumes.delete(libraryItemId))
    this.resumes.set(libraryItemId, promise)
    return promise
  }

  //
  // Tasks
  //

  /**
   * Queue a repair of every included MP3 that needs one. getStatus() must have run for the item (it stores the
   * measurements this relies on).
   *
   * @param {string} userId
   * @param {import('../models/LibraryItem')} libraryItem - expanded book item
   * @param {RepairOptions} [options]
   * @returns {Task|null} null when no file needs repair
   */
  startRepair(userId, libraryItem, options = {}) {
    const audioFiles = libraryItem.media.includedAudioFiles
    const targets = audioFiles.filter((af) => mp3SeekIndex.isMp3AudioFile(af) && mp3SeekIndex.needsRepair(af))
    if (!targets.length) return null

    const title = libraryItem.media.title
    const task = new Task()
    task.setData(
      'repair-seek-index',
      { text: 'Repairing MP3 seek index', key: 'MessageTaskRepairingSeekIndex' },
      { text: `Adding a seek index to ${targets.length} MP3 file(s) of "${title}".`, key: 'MessageTaskRepairingSeekIndexDescription', subs: [String(targets.length), title] },
      false,
      {
        libraryItemId: libraryItem.id,
        libraryId: libraryItem.libraryId,
        libraryItemDir: libraryItem.path,
        title,
        userId,
        audioFiles: targets.map((af) => ({ index: af.index, ino: af.ino, filename: af.metadata.filename, path: af.metadata.path, duration: af.duration, size: af.metadata.size })),
        duration: targets.reduce((sum, af) => sum + (af.duration || 0), 0),
        options: { chapters: options.chapters === 'shift' ? 'shift' : 'keep' }
      }
    )
    // The timeline the saved chapters were made on
    this.snapshots.set(task.id, {
      oldIncluded: audioFiles.map((af) => ({ path: af.metadata.path, duration: af.duration })),
      oldChapters: (libraryItem.media.chapters || []).map(plainChapter)
    })
    this.enqueue(task)
    return task
  }

  /**
   * Queue putting a backup's originals back, then rescan. Saved chapters go back to how they were before the repair
   * when nobody changed them since; the backup is deleted once every file is back.
   *
   * @param {string} userId
   * @param {import('../models/LibraryItem')} libraryItem
   * @param {BackupManifest} manifest
   * @returns {Task}
   */
  startRestore(userId, libraryItem, manifest) {
    const title = libraryItem.media.title
    const task = new Task()
    task.setData(
      'restore-seek-index',
      { text: 'Restoring original MP3 files', key: 'MessageTaskRestoringSeekIndex' },
      { text: `Putting back ${manifest.files.length} original MP3 file(s) of "${title}".`, key: 'MessageTaskRestoringSeekIndexDescription', subs: [String(manifest.files.length), title] },
      false,
      {
        libraryItemId: libraryItem.id,
        libraryId: libraryItem.libraryId,
        libraryItemDir: libraryItem.path,
        title,
        userId,
        backupId: manifest.id,
        audioFiles: manifest.files.map((f) => ({ filename: f.filename, relPath: f.relPath, path: Path.join(libraryItem.path, f.relPath), duration: f.newDuration ?? f.oldDuration, size: f.size })),
        duration: manifest.files.reduce((sum, f) => sum + (f.oldDuration || 0), 0)
      }
    )
    this.snapshots.set(task.id, {
      oldIncluded: libraryItem.media.includedAudioFiles.map((af) => ({ path: af.metadata.path, duration: af.duration })),
      oldChapters: (libraryItem.media.chapters || []).map(plainChapter)
    })
    this.enqueue(task)
    return task
  }

  enqueue(task) {
    if (this.tasksRunning.length >= this.MAX_CONCURRENT_TASKS) {
      Logger.info(`[Mp3SeekIndexManager] Queueing ${task.action} for "${task.data.title}"`)
      this.tasksQueued.push(task)
    } else {
      this.runTask(task)
    }
  }

  /**
   * Cancel a queued or running task. Files already replaced stay replaced; the file in progress is left as it was.
   *
   * @param {string} libraryItemId
   * @returns {boolean}
   */
  cancelRepair(libraryItemId) {
    const queued = this.tasksQueued.find((t) => t.data.libraryItemId === libraryItemId)
    if (queued) {
      this.tasksQueued = this.tasksQueued.filter((t) => t !== queued)
      this.snapshots.delete(queued.id)
      return true
    }
    const controller = this.abortControllers.get(libraryItemId)
    if (!controller) return false
    controller.abort()
    return true
  }

  /**
   * @param {Task} task
   */
  async runTask(task) {
    this.tasksRunning.push(task)
    TaskManager.addTask(task)
    const { libraryItemId, libraryItemDir } = task.data
    const isRestore = task.action === 'restore-seek-index'
    const controller = new AbortController()
    this.abortControllers.set(libraryItemId, controller)
    const watcher = this.getWatcher()
    let ignoring = false

    const fail = (text, key, subs) => {
      task.setFailed({ text, key, subs })
      this.handleTaskFinished(task)
    }

    try {
      Logger.info(`[Mp3SeekIndexManager] Starting ${task.action}`, task.description)

      if (!(await fileUtils.isWritable(libraryItemDir))) {
        return fail('Target directory is not writable', 'MessageTaskTargetDirectoryNotWritable')
      }
      if (!isRestore) {
        for (const af of task.data.audioFiles) {
          try {
            await fs.access(af.path, fs.constants.W_OK)
          } catch {
            return fail(`Audio file "${af.filename}" is not writable`, 'MessageTaskAudioFileNotWritable', [af.filename])
          }
        }
      }

      // A repair adds to the item's backup when there is one, so a restore brings back every original at once
      const existing = isRestore ? null : (await this.listBackups(libraryItemId))[0] || null
      const backupId = isRestore ? task.data.backupId : existing?.id || this.uniqueBackupId(libraryItemId)
      const backupDir = Path.join(this.itemBackupsDir(libraryItemId), backupId)
      const snapshot = this.snapshots.get(task.id)
      /** @type {BackupManifest|null} written before the first file is touched and after each one */
      let manifest = null
      if (!isRestore) {
        manifest = existing || {
          id: backupId,
          libraryItemId,
          title: task.data.title,
          createdAt: this.now(),
          mode: task.data.options.chapters,
          oldIncluded: snapshot.oldIncluded,
          files: [],
          size: 0,
          chaptersBefore: snapshot.oldChapters,
          chaptersAfter: null
        }
        manifest.complete = false
        manifest.userId = task.data.userId || manifest.userId || null
        manifest.round = { startedAt: this.now(), mode: task.data.options.chapters, oldIncluded: snapshot.oldIncluded, chapters: snapshot.oldChapters }
        manifest.pending = task.data.audioFiles.map((af) => ({ relPath: toRelPath(libraryItemDir, af.path), filename: af.filename, size: af.size, oldDuration: af.duration, newDuration: null }))
        await this.saveManifest(manifest)
      }

      // Keep the watcher off the folder until our own rescan is done (released 5 s later, as for podcast downloads)
      watcher.addIgnoreDir(libraryItemDir)
      ignoring = true

      /** @type {FileResult[]} */
      const fileResults = []
      let progressBefore = 0
      for (const af of task.data.audioFiles) {
        const weight = task.data.duration > 0 ? (af.duration || 0) / task.data.duration : 1 / task.data.audioFiles.length
        const relPath = af.relPath || toRelPath(libraryItemDir, af.path)
        SocketAuthority.adminEmitter('track_started', { libraryItemId, ino: af.ino })
        const onProgress = (fraction) => {
          SocketAuthority.adminEmitter('task_progress', { libraryItemId, progress: Math.round((progressBefore + fraction * weight) * 1000) / 10 })
          SocketAuthority.adminEmitter('track_progress', { libraryItemId, ino: af.ino, progress: Math.round(fraction * 100) })
        }
        try {
          if (relPath.startsWith('..') || Path.isAbsolute(relPath)) throw new Error('File is outside the item folder')
          // A file the backup already holds keeps its first copy: that one is the original
          const alreadyBackedUp = !isRestore && manifest.files.some((f) => f.relPath === relPath)
          const backupPath = alreadyBackedUp ? null : Path.join(backupDir, 'files', relPath)
          if (isRestore) {
            if (controller.signal.aborted) throw new Error('Canceled')
            await this.restoreFile(backupPath, af.path)
            onProgress(1)
          } else {
            await this.repairFile(af.path, { expectedDuration: af.duration, signal: controller.signal, backupPath, onProgress })
            if (!alreadyBackedUp) manifest.files.push({ relPath, filename: af.filename, size: af.size, oldDuration: af.duration, newDuration: null })
            manifest.pending = manifest.pending.filter((f) => f.relPath !== relPath)
            await this.saveManifest(manifest)
          }
          Logger.info(`[Mp3SeekIndexManager] ${isRestore ? 'Restored' : 'Added seek index to'} "${af.path}"`)
          fileResults.push({ filename: af.filename, ino: af.ino || null, relPath, status: isRestore ? 'restored' : 'repaired', oldDuration: af.duration, newDuration: null })
        } catch (error) {
          const message = controller.signal.aborted ? 'Canceled' : error.message
          if (!controller.signal.aborted) Logger.error(`[Mp3SeekIndexManager] ${task.action} of "${af.path}" failed: ${message}`)
          fileResults.push({ filename: af.filename, ino: af.ino || null, relPath, status: 'failed', oldDuration: af.duration, newDuration: null, error: message })
          if (controller.signal.aborted) break
          // Tried and failed: not left for a resume (it would fail again); the status still flags the file
          if (manifest) {
            manifest.pending = manifest.pending.filter((f) => f.relPath !== relPath)
            await this.saveManifest(manifest)
          }
        }
        SocketAuthority.adminEmitter('track_finished', { libraryItemId, ino: af.ino })
        progressBefore += weight
      }

      const doneCount = fileResults.filter((r) => r.status !== 'failed').length
      const fresh = doneCount ? await this.rescan(task) : null
      const result = await this.buildResult(task, fileResults, fresh)

      if (manifest) {
        if (manifest.files.length || manifest.pending.length) {
          if (fresh) {
            const newByPath = new Map((fresh.media?.includedAudioFiles || []).map((af) => [af.metadata.path, af.duration]))
            for (const f of manifest.files) f.newDuration = newByPath.get(Path.join(libraryItemDir, f.relPath)) ?? f.newDuration ?? null
            const after = await this.getItem(libraryItemId)
            manifest.chaptersAfter = (after?.media?.chapters || []).map(plainChapter)
          }
          // Canceled: what was not done stays pending (the status offers Resume)
          manifest.interrupted = manifest.pending.length > 0
          manifest.complete = true
          await this.saveManifest(manifest)
          result.backupId = backupId
        } else {
          await fs.remove(backupDir).catch(() => {})
          const left = await fs.readdir(this.itemBackupsDir(libraryItemId)).catch(() => [])
          if (!left.length) await fs.remove(this.itemBackupsDir(libraryItemId)).catch(() => {})
        }
      } else if (doneCount === fileResults.length) {
        await this.deleteBackup(libraryItemId, backupId)
      }
      // The client only needs filenames and durations
      result.files = fileResults.map(({ relPath, ...r }) => r)
      this.lastResults.set(libraryItemId, result)
      task.data.result = result

      const failed = fileResults.filter((r) => r.status === 'failed')
      if (controller.signal.aborted) {
        task.setFailed({ text: 'Task canceled by user', key: 'MessageTaskCanceledByUser' })
      } else if (failed.length) {
        task.setFailed({
          text: `Failed to ${isRestore ? 'restore' : 'repair'} "${failed[0].filename}": ${failed[0].error}`,
          key: isRestore ? 'MessageTaskRestoreSeekIndexFailed' : 'MessageTaskRepairSeekIndexFailed',
          subs: [failed[0].filename, failed[0].error]
        })
      } else {
        const delta = result.newTotalDuration - result.oldTotalDuration
        const deltaText = `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}`
        task.setFinished(
          isRestore
            ? { text: `Restored ${doneCount} file(s). Duration changed by ${deltaText}s.`, key: 'MessageTaskRestoreSeekIndexFinished', subs: [String(doneCount), deltaText] }
            : { text: `Repaired ${doneCount} file(s). Duration changed by ${deltaText}s.`, key: 'MessageTaskRepairSeekIndexFinished', subs: [String(doneCount), deltaText] }
        )
      }
      this.handleTaskFinished(task)
    } catch (error) {
      Logger.error(`[Mp3SeekIndexManager] ${task.action} failed`, error)
      fail(`Seek index ${isRestore ? 'restore' : 'repair'} failed: ${error.message}`, isRestore ? 'MessageTaskRestoreSeekIndexFailed' : 'MessageTaskRepairSeekIndexFailed', ['', error.message])
    } finally {
      this.abortControllers.delete(libraryItemId)
      if (ignoring) watcher.removeIgnoreDir(libraryItemDir)
    }
  }

  /**
   * Rescan the item so the new durations are stored.
   *
   * @param {Task} task
   * @returns {Promise<import('../models/LibraryItem')|null>}
   */
  async rescan(task) {
    const { libraryItemId, libraryId } = task.data
    await this.scanItem(libraryItemId)
    await Database.resetLibraryIssuesFilterData?.(libraryId)
    return this.getItem(libraryItemId)
  }

  /**
   * What a repair does with the saved chapters once the item is rescanned: keep them (moving only a last end that
   * ran to the old total), or shift them with the files when asked. Nothing changes when the item's files are not the
   * same set as before.
   *
   * @param {import('../models/LibraryItem')} fresh - item after the rescan
   * @param {{oldIncluded: {path:string, duration:number}[], oldChapters: Object[], mode: 'keep'|'shift'}} params
   * @returns {Promise<{shifted: boolean, endExtended: boolean, maxShift: number, oldTotalDuration: number, newTotalDuration: number}>}
   */
  async applyChapterPolicy(fresh, { oldIncluded, oldChapters, mode }) {
    const newByPath = new Map((fresh?.media?.includedAudioFiles || []).map((af) => [af.metadata.path, af.duration]))
    const oldDurations = oldIncluded.map((f) => f.duration || 0)
    const newDurations = oldIncluded.map((f) => newByPath.get(f.path) ?? f.duration ?? 0)
    const oldTotalDuration = oldDurations.reduce((a, b) => a + b, 0)
    const newTotalDuration = newDurations.reduce((a, b) => a + b, 0)
    const { chapters: shiftedChapters, maxShift } = mp3SeekIndex.shiftChapters(oldChapters, oldDurations, newDurations)
    const outcome = { shifted: false, endExtended: false, maxShift: Number(maxShift.toFixed(3)), oldTotalDuration, newTotalDuration }

    const sameFiles = fresh && fresh.media.includedAudioFiles.length === oldIncluded.length && oldIncluded.every((f) => newByPath.has(f.path))
    // Starts may all stay (only the last file grew) while the last end still moves, so the totals count too
    if (!oldChapters.length || !sameFiles || (maxShift < 0.001 && Math.abs(newTotalDuration - oldTotalDuration) < 0.001)) return outcome
    const current = (fresh.media.chapters || []).map(plainChapter)
    // Only an explicit request moves chapter times, and only chapters nobody changed meanwhile
    if (mode === 'shift') {
      if (!chaptersEqual(current, oldChapters.map(plainChapter))) return outcome
      await this.applyChapters(fresh, shiftedChapters)
      outcome.shifted = true
      return outcome
    }
    // Keep: the times stay, but a last chapter that ran to the old end would stop short of the new one
    const last = current[current.length - 1]
    if (last && Math.abs(last.end - oldTotalDuration) < 0.5 && Math.abs(newTotalDuration - oldTotalDuration) >= 0.001) {
      await this.applyChapters(
        fresh,
        current.map((c, i) => ({ ...c, end: i === current.length - 1 ? Number(newTotalDuration.toFixed(6)) : c.end }))
      )
      outcome.endExtended = true
    }
    return outcome
  }

  /**
   * Durations before/after and the chapter outcome: repair runs applyChapterPolicy; restore puts back the chapters
   * from before the repair if they were not changed since it.
   *
   * @param {Task} task
   * @param {FileResult[]} fileResults
   * @param {import('../models/LibraryItem')|null} fresh - item after the rescan
   * @returns {Promise<RepairResult>}
   */
  async buildResult(task, fileResults, fresh) {
    const isRestore = task.action === 'restore-seek-index'
    const { libraryItemId } = task.data
    const mode = task.data.options?.chapters || 'keep'
    const { oldIncluded, oldChapters } = this.snapshots.get(task.id)
    const newByPath = new Map((fresh?.media?.includedAudioFiles || []).map((af) => [af.metadata.path, af.duration]))
    for (const r of fileResults) {
      const file = task.data.audioFiles.find((af) => af.filename === r.filename && (af.relPath || Path.relative(task.data.libraryItemDir, af.path)) === r.relPath)
      r.newDuration = file ? (newByPath.get(file.path) ?? null) : null
    }
    const oldTotalDuration = oldIncluded.reduce((sum, f) => sum + (f.duration || 0), 0)
    const newTotalDuration = oldIncluded.reduce((sum, f) => sum + (newByPath.get(f.path) ?? f.duration ?? 0), 0)

    /** @type {RepairResult} */
    const result = {
      type: isRestore ? 'restore' : 'repair',
      libraryItemId,
      finishedAt: this.now(),
      files: fileResults,
      oldTotalDuration,
      newTotalDuration,
      chapters: { count: oldChapters.length, mode, shifted: false, endExtended: false, restored: false, maxShift: 0 }
    }
    if (!fresh) return result

    if (isRestore) {
      const sameFiles = fresh.media.includedAudioFiles.length === oldIncluded.length && oldIncluded.every((f) => newByPath.has(f.path))
      const manifest = await this.readManifest(libraryItemId, task.data.backupId)
      const current = (fresh.media.chapters || []).map(plainChapter)
      if (sameFiles && manifest?.chaptersBefore?.length && chaptersEqual(current, manifest.chaptersAfter) && !chaptersEqual(current, manifest.chaptersBefore)) {
        await this.applyChapters(fresh, manifest.chaptersBefore.map(plainChapter))
        result.chapters.restored = true
      }
      return result
    }

    const outcome = await this.applyChapterPolicy(fresh, { oldIncluded, oldChapters, mode })
    Object.assign(result.chapters, { shifted: outcome.shifted, endExtended: outcome.endExtended, maxShift: outcome.maxShift })
    return result
  }

  handleTaskFinished(task) {
    this.snapshots.delete(task.id)
    TaskManager.taskFinished(task)
    this.tasksRunning = this.tasksRunning.filter((t) => t.id !== task.id)

    if (this.tasksRunning.length < this.MAX_CONCURRENT_TASKS && this.tasksQueued.length) {
      this.runTask(this.tasksQueued.shift())
    }
  }
}

/** Path inside the item folder, with / separators (also the path inside the backup's files/ folder) */
function toRelPath(itemDir, filePath) {
  return Path.relative(itemDir, filePath).split(Path.sep).join('/')
}

function plainChapter(c, index) {
  return { id: c.id ?? index, start: c.start, end: c.end, title: c.title }
}

function chaptersEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
  return a.every((c, i) => c.title === b[i].title && Math.abs(c.start - b[i].start) < 0.001 && Math.abs(c.end - b[i].end) < 0.001)
}

/** Paths (relative, POSIX) of every file under dir; [] when it does not exist. */
async function listFilesRecursive(dir, prefix = '') {
  let entries = []
  try {
    entries = await fs.readdir(Path.join(dir, prefix), { withFileTypes: true })
  } catch {
    return []
  }
  const files = []
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) files.push(...(await listFilesRecursive(dir, rel)))
    else if (entry.isFile()) files.push(rel)
  }
  return files
}

module.exports = Mp3SeekIndexManager
