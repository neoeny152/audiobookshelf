const Path = require('path')
const axios = require('axios')
const ssrfFilter = require('ssrf-req-filter')
const fs = require('../libs/fsExtra')
const Logger = require('../Logger')
const Database = require('../Database')
const SocketAuthority = require('../SocketAuthority')
const TaskManager = require('./TaskManager')
const Task = require('../objects/Task')
const chapterbotClient = require('../utils/chapterbotClient')
const chapterSnap = require('../utils/chapterSnap')
const readAlong = require('../utils/readAlong')
const transcripts = require('../utils/transcripts')
const { TranscriptError } = transcripts

/**
 * Transcripts of audiobooks and podcast episodes (fork feature "transcripts"); formats and storage are in
 * utils/transcripts.js. This manager:
 * - lists an item's (or episode's) transcripts and loads one,
 * - fetches feed transcripts (creator-provided, <podcast:transcript>) and caches them in the metadata folder,
 * - generates a transcript from the audio (admin action, or automatically for new podcast episodes when the library
 *   setting autoTranscribePodcastEpisodes is on): from the read-along data of an EPUB made from the book's audio when
 *   there is one, otherwise through the chapterbot sidecar (POST /v1/transcribe, word timings) in overlapping ranges.
 *
 * Generation runs one job at a time (the sidecar does the heavy work); further jobs wait in a queue. Each running job
 * is a Task (action "generate-transcript") with task_progress socket events; transcript_job_updated goes to admins on
 * every change and transcript_updated to everyone who can see the item once a transcript was saved or removed.
 */

/** one transcription range (the sidecar allows up to its maxRangeSec, 600 by default) */
const RANGE_SEC = 300
/** overlap between ranges, so no word is lost at an edge */
const RANGE_OVERLAP_SEC = 4
const RANGE_TIMEOUT_MS = 20 * 60 * 1000
const MAX_RANGE_ATTEMPTS = 5
const RETRY_BASE_MS = 10000
/** finished jobs are kept this long for GET */
const FINISHED_TTL_MS = 60 * 60 * 1000
const FEED_TIMEOUT_MS = 30000
const ACTIVE = new Set(['queued', 'running'])
const METHODS = new Set(['auto', 'transcribe', 'readalong'])

class TranscriptManager {
  constructor() {
    /** @type {Map<string, Object>} jobKey -> job */
    this.jobs = new Map()
    /** @type {Object[]} queued jobs in order */
    this.queue = []
    /** @type {Object|null} */
    this.running = null
    this.client = chapterbotClient
    this.now = Date.now
    this.sleep = (ms, signal) =>
      new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(new Error('aborted'))
        const onAbort = () => {
          clearTimeout(timer)
          reject(new Error('aborted'))
        }
        const timer = setTimeout(() => {
          signal?.removeEventListener('abort', onAbort)
          resolve()
        }, ms)
        signal?.addEventListener('abort', onAbort, { once: true })
      })
    /** @type {(url: string) => Promise<{data: Buffer, contentType: string}>} */
    this.fetchUrl = (url) => this.defaultFetch(url)
    /** @type {Map<string, Promise<string>>} in-flight feed downloads */
    this.feedFetches = new Map()
    this.rangeSec = RANGE_SEC
    this.overlapSec = RANGE_OVERLAP_SEC
    this.retryBaseMs = RETRY_BASE_MS
  }

  get canGenerate() {
    return this.client.isConfigured()
  }

  jobKey(libraryItemId, episodeId) {
    return `${libraryItemId}:${episodeId || transcripts.BOOK_KEY}`
  }

  /**
   * @param {import('../models/LibraryItem')} libraryItem - expanded
   * @param {string|null} episodeId
   * @returns {import('../models/PodcastEpisode')|null}
   * @throws {TranscriptError}
   */
  getEpisode(libraryItem, episodeId) {
    if (libraryItem.isPodcast) {
      if (!episodeId) throw new TranscriptError('episodeId is required for a podcast')
      const episode = (libraryItem.media.podcastEpisodes || []).find((ep) => ep.id === episodeId)
      if (!episode) throw new TranscriptError('Episode not found', 404)
      return episode
    }
    if (episodeId) throw new TranscriptError('episodeId is only for podcasts')
    return null
  }

  /**
   * The audio of a book or an episode on one timeline.
   *
   * @returns {{path: string, offset: number, duration: number}[]}
   */
  timelineFor(libraryItem, episode) {
    if (episode) {
      const af = episode.audioFile
      if (!af?.metadata?.path) return []
      return [{ path: af.metadata.path, offset: 0, duration: Number.isFinite(af.duration) && af.duration > 0 ? af.duration : 0 }]
    }
    return chapterSnap.buildTimeline(libraryItem.media?.includedAudioFiles || []).filter((t) => t.path)
  }

  /**
   * @param {import('../models/LibraryItem')} libraryItem - expanded
   * @param {string|null} episodeId
   * @returns {Promise<Object>} API payload
   */
  async list(libraryItem, episodeId) {
    const episode = this.getEpisode(libraryItem, episodeId)
    const list = []

    if (episode) {
      const feed = transcripts.normalizeFeedTranscripts(episode.extraData?.transcripts)
      for (let i = 0; i < feed.length; i++) {
        const entry = feed[i]
        const format = transcripts.formatFromType(entry.type, entry.url)
        let cached = null
        try {
          cached = await fs.stat(transcripts.feedCachePath(libraryItem.id, episode.id, i, format))
        } catch {
          // not downloaded yet
        }
        list.push({
          id: `feed-${i}`,
          source: 'feed',
          format,
          mimeType: transcripts.MIME_TYPES[format],
          timed: transcripts.TIMED_FORMATS.has(format),
          language: entry.language,
          rel: entry.rel,
          url: entry.url,
          downloaded: !!cached,
          updatedAt: cached ? Math.round(cached.mtimeMs) : null,
          model: null
        })
      }
    }

    const local = await transcripts.findLocalSidecars(this.timelineFor(libraryItem, episode))
    if (local) {
      list.push({
        id: 'local',
        source: 'local',
        format: local.format,
        mimeType: transcripts.MIME_TYPES[local.format],
        timed: true,
        language: null,
        rel: 'captions',
        url: null,
        downloaded: true,
        updatedAt: Math.round(local.updatedAt),
        model: null,
        fileCount: local.files.length
      })
    }

    const generated = await transcripts.readGeneratedMeta(libraryItem.id, episode?.id || null)
    if (generated) {
      list.push({
        id: 'generated',
        source: 'generated',
        format: 'vtt',
        mimeType: transcripts.MIME_TYPES.vtt,
        timed: true,
        language: generated.language,
        rel: 'captions',
        url: null,
        downloaded: true,
        updatedAt: Math.round(generated.updatedAt),
        model: generated.model,
        generatedFrom: generated.from
      })
    }

    return {
      libraryItemId: libraryItem.id,
      episodeId: episode?.id || null,
      transcripts: list,
      preferredId: transcripts.preferredTranscriptId(list),
      canGenerate: await this.canGenerateFor(libraryItem, episode),
      job: this.getJob(libraryItem.id, episode?.id || null)
    }
  }

  /**
   * Whether a transcript can be generated for this book or episode: its audio has a known duration and either
   * chapterbot is configured, or (books only) an EPUB made from the audio has read-along data to reuse.
   *
   * @param {import('../models/LibraryItem')} libraryItem - expanded
   * @param {import('../models/PodcastEpisode')|null} episode
   * @returns {Promise<boolean>}
   */
  async canGenerateFor(libraryItem, episode) {
    if (libraryItem.isMissing) return false
    if (!this.timelineFor(libraryItem, episode).some((t) => t.duration > 0)) return false
    if (this.canGenerate) return true
    if (episode) return false
    for (const libraryFile of libraryItem.libraryFiles || []) {
      if ((libraryFile.metadata?.ext || '').toLowerCase() !== '.epub') continue
      try {
        if (await readAlong.find(libraryItem, libraryFile)) return true
      } catch {
        // not usable
      }
    }
    return false
  }

  /**
   * Load one transcript.
   *
   * @param {import('../models/LibraryItem')} libraryItem - expanded
   * @param {string|null} episodeId
   * @param {string} transcriptId - feed-<n> | local | generated
   * @returns {Promise<{id: string, source: string, format: string, timed: boolean, cues?: Object[], text?: string, originalPath?: string, originalPaths?: string[]}>}
   * @throws {TranscriptError}
   */
  async load(libraryItem, episodeId, transcriptId) {
    const episode = this.getEpisode(libraryItem, episodeId)
    const feedMatch = /^feed-(\d{1,2})$/.exec(transcriptId || '')
    if (feedMatch) {
      if (!episode) throw new TranscriptError('Transcript not found', 404)
      const index = Number(feedMatch[1])
      const entry = transcripts.normalizeFeedTranscripts(episode.extraData?.transcripts)[index]
      if (!entry) throw new TranscriptError('Transcript not found', 404)
      const format = transcripts.formatFromType(entry.type, entry.url)
      const path = await this.ensureFeedTranscript(libraryItem.id, episode.id, index, entry)
      const parsed = transcripts.parseTranscript(await transcripts.readTextFile(path), format)
      return { id: transcriptId, source: 'feed', format, ...parsed, originalPath: path }
    }
    if (transcriptId === 'local') {
      const local = await transcripts.findLocalSidecars(this.timelineFor(libraryItem, episode))
      if (!local) throw new TranscriptError('Transcript not found', 404)
      const parts = []
      for (const file of local.files) {
        parts.push({ offset: file.offset, duration: file.duration, cues: transcripts.parseSubtitles(await transcripts.readTextFile(file.path)) })
      }
      return { id: 'local', source: 'local', format: local.format, timed: true, cues: transcripts.mergeTrackCues(parts), originalPaths: local.files.map((f) => f.path) }
    }
    if (transcriptId === 'generated') {
      const meta = await transcripts.readGeneratedMeta(libraryItem.id, episode?.id || null)
      if (!meta) throw new TranscriptError('Transcript not found', 404)
      return { id: 'generated', source: 'generated', format: 'vtt', timed: true, cues: transcripts.parseSubtitles(await transcripts.readTextFile(meta.path)), originalPath: meta.path }
    }
    throw new TranscriptError('Transcript not found', 404)
  }

  async defaultFetch(url) {
    const filter = global.DisableSsrfRequestFilter?.(url) ? null : ssrfFilter(url)
    const response = await axios({
      url,
      method: 'GET',
      timeout: FEED_TIMEOUT_MS,
      responseType: 'arraybuffer',
      maxContentLength: transcripts.MAX_TRANSCRIPT_BYTES,
      maxRedirects: 5,
      headers: {
        Accept: 'text/vtt, application/x-subrip, application/json, text/html, text/plain, */*;q=0.5',
        'User-Agent': 'audiobookshelf (+https://audiobookshelf.org; like iTMS)'
      },
      httpAgent: filter,
      httpsAgent: filter
    })
    return { data: Buffer.from(response.data), contentType: String(response.headers?.['content-type'] || '') }
  }

  /**
   * The cached copy of an episode's feed transcript, downloaded first when needed. Concurrent callers share one
   * download. The file is checked to be readable in its format before it is cached.
   *
   * @returns {Promise<string>} the cached file
   * @throws {TranscriptError}
   */
  async ensureFeedTranscript(libraryItemId, episodeId, index, entry) {
    const format = transcripts.formatFromType(entry.type, entry.url)
    const path = transcripts.feedCachePath(libraryItemId, episodeId, index, format)
    if (await fs.pathExists(path)) return path
    const key = path
    if (!this.feedFetches.has(key)) {
      const promise = (async () => {
        let result
        try {
          result = await this.fetchUrl(entry.url)
        } catch (error) {
          Logger.warn(`[TranscriptManager] Downloading transcript "${entry.url}" failed: ${error.message}`)
          throw new TranscriptError('The transcript could not be downloaded from the feed', 502)
        }
        if (result.data.length > transcripts.MAX_TRANSCRIPT_BYTES) throw new TranscriptError('The transcript is too large', 502)
        const latin1 = /charset=(iso-8859-1|latin1|windows-1252)/i.test(result.contentType)
        const text = result.data.toString(latin1 ? 'latin1' : 'utf8')
        try {
          const parsed = transcripts.parseTranscript(text, format)
          if (parsed.timed ? !parsed.cues.length : !parsed.text) throw new TranscriptError('empty')
        } catch (error) {
          Logger.warn(`[TranscriptManager] Transcript "${entry.url}" is not a readable ${format} file: ${error.message}`)
          throw new TranscriptError(`The feed transcript is not a readable ${format} file`, 502)
        }
        await transcripts.writeAtomic(path, text)
        Logger.info(`[TranscriptManager] Downloaded transcript "${entry.url}" for episode "${episodeId}"`)
        return path
      })().finally(() => this.feedFetches.delete(key))
      this.feedFetches.set(key, promise)
    }
    return this.feedFetches.get(key)
  }

  /**
   * Download every feed transcript of an episode (library setting downloadPodcastTranscripts).
   *
   * @returns {Promise<number>} how many are cached now
   */
  async downloadFeedTranscripts(libraryItemId, episode) {
    const feed = transcripts.normalizeFeedTranscripts(episode.extraData?.transcripts)
    let count = 0
    for (let i = 0; i < feed.length; i++) {
      try {
        await this.ensureFeedTranscript(libraryItemId, episode.id, i, feed[i])
        count++
      } catch {
        // logged; it is fetched again on demand
      }
    }
    return count
  }

  /**
   * Read the podcast's RSS feed again and store the <podcast:transcript> tags of its episodes (episodes downloaded
   * before this feature, or a feed that added transcripts later). Episodes are matched by guid or enclosure URL.
   *
   * @param {import('../models/LibraryItem')} libraryItem - expanded podcast
   * @param {string|null} [episodeId] - only this episode
   * @returns {Promise<{updated: number, withTranscripts: number}>}
   */
  async refreshFromFeed(libraryItem, episodeId = null) {
    if (!libraryItem.isPodcast) throw new TranscriptError('Only podcasts have feed transcripts')
    const feedURL = libraryItem.media.feedURL
    if (!feedURL) throw new TranscriptError('The podcast has no RSS feed URL')
    const { getPodcastFeed } = require('../utils/podcastUtils')
    const feed = await getPodcastFeed(feedURL)
    if (!feed?.episodes) throw new TranscriptError('The RSS feed could not be read', 502)
    let episodes = libraryItem.media.podcastEpisodes || []
    if (episodeId) episodes = episodes.filter((ep) => ep.id === episodeId)
    let updated = 0
    let withTranscripts = 0
    for (const episode of episodes) {
      const rss = feed.episodes.find((r) => episode.checkMatchesGuidOrEnclosureUrl(r.guid, r.enclosure?.url))
      if (!rss) continue
      const list = transcripts.normalizeFeedTranscripts(rss.transcripts)
      if (list.length) withTranscripts++
      const before = JSON.stringify(transcripts.normalizeFeedTranscripts(episode.extraData?.transcripts))
      if (JSON.stringify(list) === before) continue
      const extraData = { ...(episode.extraData || {}) }
      if (list.length) extraData.transcripts = list
      else delete extraData.transcripts
      episode.extraData = extraData
      episode.changed('extraData', true)
      await episode.save()
      // a changed list may move entries: drop cached copies so they are fetched again
      await this.removeFeedCache(libraryItem.id, episode.id)
      updated++
    }
    if (updated) this.notifyUpdated(libraryItem, null)
    Logger.info(`[TranscriptManager] Feed refresh of "${libraryItem.media.title}": ${withTranscripts} episode(s) with transcripts, ${updated} updated`)
    return { updated, withTranscripts }
  }

  async removeFeedCache(libraryItemId, episodeId) {
    let names
    const folder = transcripts.dir(libraryItemId)
    try {
      names = await fs.readdir(folder)
    } catch {
      return
    }
    const prefix = `${transcripts.keyFor(episodeId)}.feed-`
    for (const name of names) if (name.startsWith(prefix)) await fs.remove(Path.join(folder, name)).catch(() => {})
  }

  /**
   * A new episode was downloaded (PodcastManager). Downloads its feed transcripts and/or queues a generated one, as
   * the library settings say. Never throws.
   *
   * @param {import('../models/LibraryItem')} libraryItem - expanded podcast
   * @param {import('../models/PodcastEpisode')} episode
   */
  async onEpisodeDownloaded(libraryItem, episode) {
    try {
      const library = await Database.libraryModel.findByPk(libraryItem.libraryId)
      const settings = library?.settings || {}
      const feed = transcripts.normalizeFeedTranscripts(episode.extraData?.transcripts)
      if (settings.downloadPodcastTranscripts && feed.length) {
        const count = await this.downloadFeedTranscripts(libraryItem.id, episode)
        if (count) this.notifyUpdated(libraryItem, episode.id)
      }
      // the creator's transcript is preferred: only transcribe episodes without a timed one
      const hasTimedFeed = feed.some((t) => transcripts.TIMED_FORMATS.has(transcripts.formatFromType(t.type, t.url)))
      if (settings.autoTranscribePodcastEpisodes && !hasTimedFeed && this.canGenerate) {
        const fresh = await Database.libraryItemModel.getExpandedById(libraryItem.id)
        if (fresh) this.start(fresh, episode.id, null, { origin: 'auto' })
      }
    } catch (error) {
      Logger.error(`[TranscriptManager] Handling new episode "${episode?.id}" failed`, error)
    }
  }

  /**
   * @returns {Object|null} job JSON
   */
  getJob(libraryItemId, episodeId) {
    const job = this.jobs.get(this.jobKey(libraryItemId, episodeId))
    if (!job) return null
    if (!ACTIVE.has(job.status) && job.finishedAt && this.now() - job.finishedAt > FINISHED_TTL_MS) {
      this.jobs.delete(job.key)
      return null
    }
    return this.toJSON(job)
  }

  /**
   * Queue a transcript generation.
   *
   * @param {import('../models/LibraryItem')} libraryItem - expanded
   * @param {string|null} episodeId
   * @param {{id: string, username?: string}|null} user - null for automatic jobs
   * @param {{origin?: 'user'|'auto', method?: 'auto'|'transcribe'|'readalong'}} [opts]
   * @returns {Object} job JSON
   * @throws {TranscriptError}
   */
  start(libraryItem, episodeId, user, { origin = 'user', method = 'auto' } = {}) {
    const episode = this.getEpisode(libraryItem, episodeId)
    if (!METHODS.has(method)) throw new TranscriptError('method must be auto, transcribe or readalong')
    if (libraryItem.isMissing) throw new TranscriptError('The item is missing')
    const timeline = this.timelineFor(libraryItem, episode)
    if (!timeline.some((t) => t.duration > 0)) throw new TranscriptError('The item has no audio with a known duration')
    if (episode && method === 'readalong') throw new TranscriptError('Read-along data only exists for books')
    if ((method === 'transcribe' || episode) && !this.canGenerate) throw new TranscriptError('Generating transcripts needs chapterbot, which is not configured on this server (CHAPTERBOT_URL, CHAPTERBOT_TOKEN, CHAPTERBOT_PATH_MAP)')
    this.pruneFinished()
    const key = this.jobKey(libraryItem.id, episode?.id || null)
    const existing = this.jobs.get(key)
    if (existing && ACTIVE.has(existing.status)) throw new TranscriptError('A transcript is already being generated for this item', 409)

    const title = episode ? `${episode.title || 'Episode'} (${libraryItem.media.title || ''})` : libraryItem.media.title || 'Untitled'
    const job = {
      key,
      libraryItemId: libraryItem.id,
      libraryId: libraryItem.libraryId,
      episodeId: episode?.id || null,
      title,
      userId: user?.id || null,
      origin: origin === 'auto' ? 'auto' : 'user',
      method,
      status: 'queued',
      progress: 0,
      error: null,
      generatedFrom: null,
      createdAt: this.now(),
      startedAt: null,
      finishedAt: null,
      controller: new AbortController(),
      task: null,
      access: { libraryId: libraryItem.libraryId, media: { explicit: !!libraryItem.media?.explicit, tags: [...(libraryItem.media?.tags || [])] } }
    }
    this.jobs.set(key, job)
    this.queue.push(job)
    Logger.info(`[TranscriptManager] Queued transcript for "${title}" (${job.origin}${user ? ` by "${user.username}"` : ''})`)
    this.emitJob(job)
    this.pump()
    return this.toJSON(job)
  }

  /** Forget finished jobs older than FINISHED_TTL_MS (automatic jobs for many episodes would otherwise pile up). */
  pruneFinished() {
    const now = this.now()
    for (const [key, job] of this.jobs) {
      if (!ACTIVE.has(job.status) && job.finishedAt && now - job.finishedAt > FINISHED_TTL_MS) this.jobs.delete(key)
    }
  }

  /**
   * Cancel a queued or running job.
   *
   * @returns {Object|null} job JSON, null when there was none
   */
  cancel(libraryItemId, episodeId) {
    const job = this.jobs.get(this.jobKey(libraryItemId, episodeId))
    if (!job || !ACTIVE.has(job.status)) return null
    if (job.status === 'queued') {
      this.queue = this.queue.filter((j) => j !== job)
      this.finishJob(job, 'cancelled')
    } else {
      job.controller.abort()
    }
    return this.toJSON(job)
  }

  pump() {
    if (this.running || !this.queue.length) return
    const job = this.queue.shift()
    this.running = job
    this.run(job)
      .catch((error) => Logger.error(`[TranscriptManager] Transcript job for "${job.title}" failed`, error))
      .finally(() => {
        this.running = null
        this.pump()
      })
  }

  /** @returns {Promise<void>} resolves when the queue is empty (tests) */
  async idle() {
    while (this.running || this.queue.length) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }

  async run(job) {
    job.status = 'running'
    job.startedAt = this.now()
    const task = new Task()
    task.setData('generate-transcript', { text: 'Generating transcript', key: 'MessageTaskGeneratingTranscript' }, { text: `Transcribing "${job.title}".`, key: 'MessageTaskGeneratingTranscriptDescription', subs: [job.title] }, false, { libraryItemId: job.libraryItemId, libraryId: job.libraryId, episodeId: job.episodeId })
    job.task = task
    TaskManager.addTask(task)
    this.emitJob(job)

    try {
      const libraryItem = await Database.libraryItemModel.getExpandedById(job.libraryItemId)
      if (!libraryItem?.media) throw new TranscriptError('The library item no longer exists')
      const episode = job.episodeId ? this.getEpisode(libraryItem, job.episodeId) : null

      let result = null
      if (!episode && job.method !== 'transcribe') {
        result = await this.fromReadAlong(libraryItem)
        if (!result && job.method === 'readalong') throw new TranscriptError('The book has no EPUB with read-along data')
      }
      if (!result) {
        if (!this.canGenerate) throw new TranscriptError('Generating transcripts needs chapterbot, which is not configured on this server')
        result = await this.fromAudio(libraryItem, episode, job)
      }
      if (!result.cues.length) throw new TranscriptError('No speech was found in the audio')
      await transcripts.saveGenerated(job.libraryItemId, job.episodeId, result.cues, { source: result.source, model: result.model })
      job.generatedFrom = result.source
      Logger.info(`[TranscriptManager] Saved transcript of "${job.title}" (${result.cues.length} cues, from ${result.source})`)
      task.setFinished({ text: `Transcript saved (${result.cues.length} lines).`, key: 'MessageTaskGeneratingTranscriptFinished', subs: [String(result.cues.length)] })
      this.finishJob(job, 'done')
      this.notifyUpdated(libraryItem, job.episodeId)
    } catch (error) {
      if (job.controller.signal.aborted) {
        task.setFailed({ text: 'Task canceled by user', key: 'MessageTaskCanceledByUser' })
        this.finishJob(job, 'cancelled')
      } else {
        const message = error instanceof TranscriptError ? error.message : 'Transcription failed'
        if (!(error instanceof TranscriptError)) Logger.error(`[TranscriptManager] Transcript of "${job.title}" failed`, error)
        else Logger.warn(`[TranscriptManager] Transcript of "${job.title}" failed: ${error.message}`)
        task.setFailed({ text: `Transcript failed: ${message}`, key: 'MessageTaskGeneratingTranscriptFailed', subs: [message] })
        job.error = message
        this.finishJob(job, 'failed')
      }
    } finally {
      TaskManager.taskFinished(task)
    }
  }

  /**
   * A book with an EPUB made from its audio already has every sentence timed: reuse it instead of transcribing again.
   *
   * @param {import('../models/LibraryItem')} libraryItem - expanded book
   * @returns {Promise<{cues: Object[], source: 'readalong', model: string|null}|null>}
   */
  async fromReadAlong(libraryItem) {
    const epubs = (libraryItem.libraryFiles || []).filter((lf) => (lf.metadata?.ext || '').toLowerCase() === '.epub')
    const duration = chapterSnap.computeDuration(this.timelineFor(libraryItem, null), libraryItem.media.duration)
    for (const libraryFile of epubs) {
      try {
        const path = await readAlong.find(libraryItem, libraryFile)
        if (!path) continue
        const data = JSON.parse(await fs.readFile(path, 'utf8'))
        // made from other audio (replaced files): its times would be wrong
        if (Number.isFinite(data.audioDuration) && duration > 0 && Math.abs(data.audioDuration - duration) > Math.max(5, duration * 0.01)) {
          Logger.info(`[TranscriptManager] Read-along data of "${libraryFile.metadata.filename}" is for audio of another length, not used`)
          continue
        }
        const texts = await transcripts.readEpubSentenceTexts(libraryFile.metadata.path)
        const cues = transcripts.cuesFromReadAlong(data, texts)
        if (!cues.length) continue
        Logger.info(`[TranscriptManager] Using the read-along data of "${libraryFile.metadata.filename}" for the transcript of "${libraryItem.media.title}"`)
        return { cues, source: 'readalong', model: typeof data.model === 'string' ? data.model : null }
      } catch (error) {
        Logger.warn(`[TranscriptManager] Read-along data of "${libraryFile.metadata?.filename}" could not be used: ${error.message}`)
      }
    }
    return null
  }

  /**
   * Transcribe the audio through the sidecar in overlapping ranges.
   *
   * @returns {Promise<{cues: Object[], source: 'transcribe', model: string|null}>}
   */
  async fromAudio(libraryItem, episode, job) {
    const timeline = this.timelineFor(libraryItem, episode)
    let files
    try {
      files = this.client.mapFiles(timeline)
    } catch (error) {
      if (error.code === 'path_unmapped') throw new TranscriptError('The audio files are outside the configured chapterbot path map (CHAPTERBOT_PATH_MAP)')
      throw error
    }
    const total = files.reduce((end, f) => Math.max(end, f.offset + f.duration), 0)
    const ranges = transcripts.planRanges(total, this.rangeSec, this.overlapSec)
    if (!ranges.length) throw new TranscriptError('The item has no audio with a known duration')
    const signal = job.controller.signal
    const results = []
    let model = null
    for (let i = 0; i < ranges.length; i++) {
      const range = ranges[i]
      for (let attempt = 1; ; attempt++) {
        if (signal.aborted) throw new Error('aborted')
        try {
          const response = await this.client.transcribe({ files, ranges: [range], signal, timeoutMs: RANGE_TIMEOUT_MS })
          model = response.model || model
          const r = response.results[0] || { start: range.start, length: range.length, words: [] }
          results.push({ start: range.start, length: range.length, words: r.words })
          break
        } catch (error) {
          if (signal.aborted) throw error
          if (error.status === 404) throw new TranscriptError('The chapterbot sidecar is too old: it has no /v1/transcribe endpoint')
          const transient = error.status === 429 || error.status >= 500 || ['timeout', 'unreachable'].includes(error.code)
          if (!transient || attempt >= MAX_RANGE_ATTEMPTS) {
            Logger.error(`[TranscriptManager] Transcribing ${range.start}s-${range.start + range.length}s of "${job.title}" failed: ${error.message}`)
            throw new TranscriptError(`Chapterbot could not transcribe the audio (${error.code || error.status || 'error'})`)
          }
          Logger.warn(`[TranscriptManager] Transcribing range ${i + 1}/${ranges.length} of "${job.title}" failed (${error.message}), retrying`)
          await this.sleep(this.retryBaseMs * attempt, signal)
        }
      }
      this.setProgress(job, (i + 1) / ranges.length)
    }
    return { cues: transcripts.cuesFromWords(transcripts.joinRangeWords(results)), source: 'transcribe', model }
  }

  setProgress(job, progress) {
    job.progress = Math.min(1, Math.max(0, progress))
    SocketAuthority.adminEmitter('task_progress', { libraryItemId: job.libraryItemId, episodeId: job.episodeId, taskId: job.task?.id, progress: Math.round(job.progress * 1000) / 10 })
    this.emitJob(job)
  }

  finishJob(job, status) {
    job.status = status
    job.finishedAt = this.now()
    if (status === 'done') job.progress = 1
    this.emitJob(job)
  }

  emitJob(job) {
    SocketAuthority.adminEmitter('transcript_job_updated', this.toJSON(job))
  }

  /**
   * transcript_updated to everyone who can see the item: its transcript list changed.
   */
  notifyUpdated(libraryItem, episodeId) {
    const access = { libraryId: libraryItem.libraryId, media: { explicit: !!libraryItem.media?.explicit, tags: [...(libraryItem.media?.tags || [])] } }
    SocketAuthority.emitter('transcript_updated', { libraryItemId: libraryItem.id, episodeId: episodeId || null }, (user) => typeof user.checkCanAccessLibraryItem === 'function' && user.checkCanAccessLibraryItem(access))
  }

  toJSON(job) {
    return {
      libraryItemId: job.libraryItemId,
      episodeId: job.episodeId,
      origin: job.origin,
      method: job.method,
      status: job.status,
      progress: job.progress,
      error: job.error,
      generatedFrom: job.generatedFrom,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt
    }
  }

  /** for tests */
  reset() {
    for (const job of this.jobs.values()) job.controller?.abort()
    this.jobs.clear()
    this.queue = []
    this.feedFetches.clear()
  }
}

const manager = new TranscriptManager()
module.exports = manager
module.exports.TranscriptManager = TranscriptManager
