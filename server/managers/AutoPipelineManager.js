const Path = require('path')
const EventEmitter = require('events')
const fs = require('../libs/fsExtra')
const Logger = require('../Logger')
const Database = require('../Database')
const SocketAuthority = require('../SocketAuthority')
const TaskManager = require('./TaskManager')
const ChapterbotEpubManager = require('./ChapterbotEpubManager')
const chapterbotClient = require('../utils/chapterbotClient')
const chapterbotSpeech = require('../utils/chapterbotSpeech')
const chapterSnap = require('../utils/chapterSnap')
const chapterSnapRunner = require('../utils/chapterSnapRunner')
const { applyChapters, isValidChapterPayload } = require('../utils/applyChapters')
const { PipelineStore } = require('../utils/autoPipeline/store')
const { normalizeAutoPipelineSettings, isGateOn, effectiveProvider, isAudibleProvider, regionForProvider } = require('../utils/autoPipeline/settings')
const { itemForScoring, pickMatch, MAX_CANDIDATES } = require('../utils/autoPipeline/matchScore')
const chapterPlan = require('../utils/autoPipeline/chapterPlan')

/**
 * Auto pipeline (fork only): hands-off processing of newly added books.
 *
 * A new book (scan or folder watcher) is queued; one worker takes the books in order and runs, per library settings
 * (library.settings.autoPipeline):
 * 1. waiting: until the library is not being scanned and the files have settled (no change for settleMinutes, the
 *    same fingerprint on two checks a minute apart), so a copy in progress is not processed
 * 2. matching: Audible search, scored by utils/autoPipeline/matchScore.js; applied (same as quick match) only at or
 *    above autoMatchMinConfidence and when no second edition comes close. Never when the book already has an ASIN.
 * 3. chapters: Audible chapters (raw or without Audible branding, whichever fits the audio), snapped to silence and
 *    speech checked through chapterbot, applied only when every check passes (chapterPlan.evaluatePolicy); otherwise
 *    the proposal waits for review. Chapters a person edited are never changed without review. Every change is backed
 *    up and can be undone.
 * 4. epub: an EPUB from the audio through ChapterbotEpubManager, one pipeline job at a time; the worker does not wait.
 *
 * Gates: ABS_AUTO_PIPELINE=1 on the server (else nothing runs and the feature is not advertised), a per-library mode
 * that defaults to 'off', and 'dryRun', which runs every read step and writes nothing to the item.
 *
 * State is kept in JSON files under MetadataPath/pipeline (utils/autoPipeline/store.js). After a restart, a book whose
 * step was running starts that step again; every step is idempotent.
 */

const STATUSES = Object.freeze(['queued', 'waiting', 'matching', 'chapters', 'epub', 'done', 'needs-review', 'failed', 'skipped'])
const ACTIVE_STATUSES = new Set(['queued', 'waiting', 'matching', 'chapters', 'epub'])
/** a state with one of these statuses was in the middle of a step when the server stopped */
const RUNNING_STEPS = new Set(['matching', 'chapters'])
const STEP_ORDER = Object.freeze(['match', 'chapters', 'epub'])
const STEP_STATUS = Object.freeze({ match: 'matching', chapters: 'chapters', epub: 'epub' })
/** chapters results after which the EPUB step may run */
const EPUB_OK_CHAPTERS = new Set(['applied', 'kept', 'approved', 'not-run', 'would-apply'])
const MAX_ATTEMPTS = 3
const MAX_SNAP_ROUNDS = 3
const SPEECH_CHUNK = chapterbotSpeech.MAX_VERIFY_STARTS
const MIN = 60 * 1000

const DEFAULT_TIMING = Object.freeze({
  /** the two fingerprint checks of the waiting step are this far apart */
  settleCheckMs: MIN,
  /** retry when the library is being scanned */
  libraryBusyMs: 15 * 1000,
  /** retry when no chapter snap slot is free */
  snapBusyMs: MIN,
  snapDeadlineMs: 30 * MIN,
  speechChunkDeadlineMs: 10 * MIN,
  /** chapterbot busy during the speech check: wait this long before try n (up to 6 tries) */
  speechBackoffMs: [2 * MIN, 5 * MIN, 10 * MIN, 10 * MIN, 10 * MIN],
  /** chapterbot busy when starting an EPUB */
  epubBackoffMs: [2 * MIN, 5 * MIN, 10 * MIN, 10 * MIN, 10 * MIN, 30 * MIN],
  /** an unexpected error: retry the step after this */
  errorRetryMs: 5 * MIN
})

class PipelineError extends Error {
  constructor(status, message) {
    super(message)
    this.name = 'PipelineError'
    this.status = status
  }
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function plainChapters(chapters) {
  return (chapters || []).map((c) => ({ title: c.title, start: c.start, end: c.end }))
}

class AutoPipelineManager extends EventEmitter {
  constructor() {
    super()
    /** @type {Map<string, Object>} libraryItemId -> state */
    this.states = new Map()
    /** @type {PipelineStore|null} */
    this.store = null
    this.apiRouter = null
    this.gate = isGateOn()
    this.initialized = false
    this.now = Date.now
    this.timing = { ...DEFAULT_TIMING }
    /** worker */
    this.running = false
    this.rerun = false
    /** @type {string|null} item the worker is on */
    this.current = null
    this.wakeTimer = null
    /** turned off by tests, which drive the worker with drain(): no background runs, no wake-up timers */
    this.autoRun = true
    this.loopPromise = null
    this.onEpubEnded = this.onEpubEnded.bind(this)

    // seams (tests replace these)
    this.bookFinder = null
    this.scanner = null
    this.libraryScanner = null
    this.epubManager = ChapterbotEpubManager
    this.snapRunner = chapterSnapRunner
    this.speechClient = chapterbotClient
    /** @type {Function|undefined} silence detector for runSnap (undefined: ffmpeg) */
    this.detect = undefined
    this.stat = (path) => fs.stat(path)
    this.readdir = (path) => fs.readdir(path, { withFileTypes: true })
    this.scannerChapters = (title, audioFiles) => require('../scanner/AudioFileScanner').getBookChaptersFromAudioFiles(title, audioFiles, { addLog: () => {} })
  }

  /**
   * What the scanner would make of the audio files (embedded chapters, or one per file); [] when that fails.
   */
  getScannerChapters(title, audioFiles) {
    if (!audioFiles?.length) return []
    try {
      return this.scannerChapters(title, audioFiles) || []
    } catch (error) {
      Logger.warn(`[AutoPipeline] Could not rebuild the scanner chapters of "${title}": ${error.message}`)
      return []
    }
  }

  getBookFinder() {
    return this.bookFinder || require('../finders/BookFinder')
  }

  getScanner() {
    return this.scanner || require('../scanner/Scanner')
  }

  getLibraryScanner() {
    return this.libraryScanner || require('../scanner/LibraryScanner')
  }

  /** Whether the pipeline runs on this server (ABS_AUTO_PIPELINE=1 and initialised) */
  get enabled() {
    return this.gate && this.initialized
  }

  /**
   * @param {import('../routers/ApiRouter')} apiRouter
   * @param {{root?: string, gate?: boolean}} [opts]
   */
  async init(apiRouter, { root, gate } = {}) {
    this.apiRouter = apiRouter
    if (gate !== undefined) this.gate = gate
    if (!this.gate) {
      Logger.debug('[AutoPipeline] Off (start the server with ABS_AUTO_PIPELINE=1 to turn it on)')
      return
    }
    this.store = new PipelineStore(root || Path.join(global.MetadataPath, 'pipeline'))
    const states = await this.store.loadAll()
    const ids = states.map((s) => s.libraryItemId)
    const existing = new Set(ids.length ? (await Database.libraryItemModel.findAll({ where: { id: ids }, attributes: ['id'] })).map((li) => li.id) : [])
    for (const state of states) {
      if (!existing.has(state.libraryItemId)) {
        Logger.info(`[AutoPipeline] Removing the state of "${state.title}": the library item no longer exists`)
        await this.store.removeItem(state.libraryItemId, { all: true }).catch(() => {})
        continue
      }
      this.resumeState(state)
      this.states.set(state.libraryItemId, state)
    }
    this.epubManager.removeListener('ended', this.onEpubEnded)
    this.epubManager.on('ended', this.onEpubEnded)
    this.initialized = true

    // EPUB jobs that ended while the server was down (or could not be adopted)
    for (const state of this.states.values()) {
      if (state.status === 'epub' && state.epub?.result === 'running') {
        const job = this.epubManager.getRecord(state.libraryItemId)
        if (!job || job.jobId !== state.epub.jobId) await this.finish(state, 'failed', 'EPUB job was lost in a server restart')
        else if (!ChapterbotEpubManager.ACTIVE.has(job.status)) await this.onEpubEnded(this.epubManager.toJSON(job))
      }
    }
    Logger.info(`[AutoPipeline] On: ${this.states.size} item(s) in the pipeline state`)
    this.kick()
  }

  /**
   * A step that was running when the server stopped starts again from its beginning.
   *
   * @param {Object} state
   */
  resumeState(state) {
    if (RUNNING_STEPS.has(state.status)) {
      state.status = 'queued'
      state.reason = 'resumed after a restart'
    }
    if (state.status === 'epub' && state.epub?.result === 'starting') state.epub.result = 'queued'
  }

  /**
   * Stop the worker and forget everything (tests).
   */
  async reset() {
    clearTimeout(this.wakeTimer)
    this.wakeTimer = null
    if (this.loopPromise) await this.loopPromise.catch(() => {})
    this.states.clear()
    this.store = null
    this.initialized = false
    this.running = false
    this.rerun = false
    this.current = null
    this.epubManager.removeListener('ended', this.onEpubEnded)
  }

  //
  // State helpers
  //

  /**
   * @param {Object} state
   * @returns {Promise<void>}
   */
  async save(state) {
    state.updatedAt = this.now()
    if (this.states.get(state.libraryItemId) !== state) return // dismissed meanwhile
    try {
      await this.store.saveState(state)
    } catch (error) {
      Logger.error(`[AutoPipeline] Saving the state of "${state.title}" failed`, error)
    }
    this.emitState(state)
  }

  emitState(state) {
    const payload = this.toJSON(state)
    SocketAuthority.emitter('pipeline_item_updated', payload, (user) => !!user.canUpdate && typeof user.checkCanAccessLibrary === 'function' && user.checkCanAccessLibrary(state.libraryId))
    this.emit('updated', payload)
  }

  toJSON(state) {
    const { waitCheck, ...rest } = state
    return clone(rest)
  }

  log(state, step, text) {
    Logger.info(`[AutoPipeline] ${step} "${state.title}" (${state.libraryItemId})${state.dryRun ? ' [dry run]' : ''}: ${text}`)
  }

  queued(state, step, reason = null, delayMs = 0) {
    state.status = step === 'epub' ? 'epub' : step === 'waiting' ? 'waiting' : 'queued'
    state.step = step
    state.reason = reason
    state.notBefore = delayMs ? this.now() + delayMs : 0
  }

  async finish(state, status, reason) {
    state.status = status
    state.step = null
    state.reason = reason
    state.notBefore = 0
    state.finishedAt = this.now()
    if (state.dryRun) state.would = this.wouldText(state)
    this.log(state, 'result', `${status}${reason ? ` - ${reason}` : ''}`)
    await this.save(state)
  }

  wouldText(state) {
    const parts = []
    if (state.match?.would) parts.push(state.match.would)
    if (state.chapters?.would) parts.push(state.chapters.would)
    if (state.epub?.would) parts.push(state.epub.would)
    if (state.status === 'needs-review' && !parts.some((p) => p.includes('review'))) parts.push(`would need review: ${state.reason}`)
    return parts.join('; ') || null
  }

  /**
   * The steps a state runs: the explicit list of a manual run, otherwise the library's toggles.
   *
   * @param {Object} state
   * @param {Object} settings
   * @returns {string[]}
   */
  plannedSteps(state, settings) {
    if (Array.isArray(state.steps) && state.steps.length) return STEP_ORDER.filter((s) => state.steps.includes(s))
    return STEP_ORDER.filter((s) => (s === 'match' ? settings.autoMatch : s === 'chapters' ? settings.autoChapters : settings.autoEpub))
  }

  nextStep(state, settings, after) {
    const planned = this.plannedSteps(state, settings)
    const from = after ? STEP_ORDER.indexOf(after) + 1 : 0
    return STEP_ORDER.slice(from).find((s) => planned.includes(s)) || null
  }

  /**
   * Move on to the step after `after`, or finish.
   */
  async advance(state, settings, after) {
    const next = this.nextStep(state, settings, after)
    if (!next) return this.finish(state, 'done', this.doneReason(state))
    if (next === 'epub') {
      const chaptersResult = state.chapters?.result || 'not-run'
      if (!EPUB_OK_CHAPTERS.has(chaptersResult)) return this.finish(state, 'done', this.doneReason(state))
      state.epub = { result: 'queued' }
      this.queued(state, 'epub', 'waiting for the EPUB lane')
    } else {
      this.queued(state, STEP_STATUS[next])
    }
    await this.save(state)
  }

  doneReason(state) {
    const parts = []
    const m = state.match
    if (m?.result === 'matched') parts.push(`matched ${m.asin} at ${m.confidence} %`)
    else if (m?.result === 'existing-asin') parts.push(`ASIN ${m.asin} kept`)
    else if (m?.result === 'skipped') parts.push(`match skipped: ${m.reason}`)
    const c = state.chapters
    if (c?.result === 'applied') parts.push(`${c.count} chapters applied`)
    else if (c?.result === 'would-apply') parts.push(`would apply ${c.count} chapters`)
    else if (c?.result === 'approved') parts.push(`${c.count} chapters approved`)
    else if (c?.result === 'kept') parts.push(`chapters kept: ${c.reason}`)
    else if (c?.result === 'rejected') parts.push('chapters proposal rejected')
    else if (c?.result === 'skipped') parts.push(`chapters skipped: ${c.reason}`)
    const e = state.epub
    if (e?.result === 'done') parts.push(`EPUB "${e.fileName}"`)
    else if (e?.result === 'skipped') parts.push(`EPUB skipped: ${e.reason}`)
    if (state.dryRun) return parts.length ? `dry run: ${parts.join(', ')}` : 'dry run'
    return parts.join(', ') || null
  }

  //
  // Queueing
  //

  /**
   * New items from a library scan or the folder watcher. Only records them as queued.
   *
   * @param {import('../models/Library')} library
   * @param {string[]} libraryItemIds
   */
  async onItemsAdded(library, libraryItemIds) {
    if (!this.enabled || !library || library.mediaType !== 'book') return
    const settings = normalizeAutoPipelineSettings(library.settings?.autoPipeline)
    if (settings.mode === 'off') return
    for (const id of libraryItemIds) {
      if (this.states.has(id)) continue
      await this.createState(id, library, settings, { trigger: 'scan' })
    }
    this.kick()
  }

  async createState(libraryItemId, library, settings, { trigger, steps = null, force = false, manual = false, title = null }) {
    let itemTitle = title
    if (!itemTitle) {
      const li = await Database.libraryItemModel.findByPk(libraryItemId, { attributes: ['id', 'title'] })
      itemTitle = li?.title || libraryItemId
    }
    const now = this.now()
    const state = {
      libraryItemId,
      libraryId: library.id,
      title: itemTitle,
      status: 'queued',
      step: 'waiting',
      reason: null,
      dryRun: settings.mode === 'dryRun',
      would: null,
      trigger,
      manual,
      steps,
      force,
      queuedAt: now,
      updatedAt: now,
      finishedAt: null,
      attempts: 0,
      notBefore: 0,
      fingerprint: null,
      waitCheck: null,
      match: null,
      chapters: null,
      epub: null
    }
    this.states.set(libraryItemId, state)
    this.log(state, 'queued', trigger)
    await this.save(state)
    return state
  }

  /**
   * Manual run of one item (works while the library mode is off, as long as the server gate is on).
   *
   * @param {import('../models/LibraryItem')} libraryItem
   * @param {import('../models/Library')} library
   * @param {{steps?: string[], force?: boolean}} [opts]
   * @returns {Promise<Object>} state
   * @throws {PipelineError}
   */
  async runItem(libraryItem, library, { steps = null, force = false } = {}) {
    this.assertEnabled()
    if (!libraryItem.isBook || library.mediaType !== 'book') throw new PipelineError(400, 'The auto pipeline only processes books')
    if (this.current === libraryItem.id) throw new PipelineError(409, 'The item is being processed right now')
    const existing = this.states.get(libraryItem.id)
    if (existing?.status === 'epub' && existing.epub?.result === 'running') throw new PipelineError(409, 'The item has an EPUB job running')
    const settings = normalizeAutoPipelineSettings(library.settings?.autoPipeline)
    if (existing) {
      this.states.delete(libraryItem.id)
      await this.store.removeProposal(libraryItem.id).catch(() => {})
      await this.store.removeAnalysis(libraryItem.id).catch(() => {})
    }
    const state = await this.createState(libraryItem.id, library, settings, { trigger: 'manual', steps, force: !!force, manual: true, title: libraryItem.media?.title || libraryItem.title })
    // a pipeline-applied chapter list stays recognisable across runs
    if (existing?.chapters?.appliedHash) state.chapters = { appliedHash: existing.chapters.appliedHash }
    this.kick()
    return this.toJSON(state)
  }

  /**
   * Manual run over a library.
   *
   * @param {import('../models/Library')} library
   * @param {'unprocessed'|'all'} scope
   * @returns {Promise<{queued: number}>}
   */
  async runLibrary(library, scope) {
    this.assertEnabled()
    if (library.mediaType !== 'book') throw new PipelineError(400, 'The auto pipeline only processes books')
    const items = (await Database.libraryItemModel.findAll({ where: { libraryId: library.id, mediaType: 'book' }, attributes: ['id', 'title', 'isMissing'] })).filter((li) => !li.isMissing)
    let queued = 0
    for (const li of items) {
      const existing = this.states.get(li.id)
      if (scope === 'unprocessed' && existing) continue
      if (this.current === li.id || (existing?.status === 'epub' && existing.epub?.result === 'running')) continue
      const settings = normalizeAutoPipelineSettings(library.settings?.autoPipeline)
      if (existing) {
        this.states.delete(li.id)
        await this.store.removeProposal(li.id).catch(() => {})
        await this.store.removeAnalysis(li.id).catch(() => {})
      }
      const state = await this.createState(li.id, library, settings, { trigger: 'manual', manual: true, title: li.title })
      if (existing?.chapters?.appliedHash) state.chapters = { appliedHash: existing.chapters.appliedHash }
      queued++
    }
    this.kick()
    return { queued }
  }

  /**
   * Remove an item from the queue, or dismiss its result. A running EPUB job is not cancelled. Not while the worker is
   * on the item: the running step would still change the book after the state is gone.
   *
   * @param {string} libraryItemId
   * @returns {Promise<boolean>} false when the item has no state
   * @throws {PipelineError} 409 while the item is being processed
   */
  async dismiss(libraryItemId) {
    this.assertEnabled()
    const state = this.states.get(libraryItemId)
    if (!state) return false
    if (this.current === libraryItemId) throw new PipelineError(409, 'The item is being processed right now')
    this.states.delete(libraryItemId)
    await this.store.removeItem(libraryItemId)
    this.log(state, 'dismissed', state.status)
    SocketAuthority.emitter('pipeline_item_updated', { libraryItemId, libraryId: state.libraryId, status: 'dismissed' }, (user) => !!user.canUpdate && typeof user.checkCanAccessLibrary === 'function' && user.checkCanAccessLibrary(state.libraryId))
    return true
  }

  /**
   * Library settings changed: switching from dry run to on clears the dry-run results of the library.
   *
   * @param {import('../models/Library')} library
   * @param {Object|null} previous - autoPipeline settings before the change
   */
  async onLibrarySettingsChanged(library, previous) {
    if (!this.enabled) return
    const next = normalizeAutoPipelineSettings(library.settings?.autoPipeline)
    const prev = normalizeAutoPipelineSettings(previous)
    if (prev.mode === 'dryRun' && next.mode === 'on') {
      for (const state of [...this.states.values()]) {
        if (state.libraryId !== library.id || !state.dryRun || this.current === state.libraryItemId) continue
        await this.dismiss(state.libraryItemId)
      }
    }
    this.kick()
  }

  assertEnabled() {
    if (!this.enabled) throw new PipelineError(404, 'The auto pipeline is not enabled on this server (ABS_AUTO_PIPELINE=1)')
  }

  //
  // Queries
  //

  getState(libraryItemId) {
    const state = this.states.get(libraryItemId)
    return state ? this.toJSON(state) : null
  }

  /**
   * @param {import('../models/Library')} library
   * @param {string|null} [status] - filter
   */
  getLibrarySummary(library, status = null) {
    const settings = normalizeAutoPipelineSettings(library.settings?.autoPipeline)
    const all = [...this.states.values()].filter((s) => s.libraryId === library.id)
    const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]))
    for (const s of all) counts[s.status] = (counts[s.status] || 0) + 1
    const items = all
      .filter((s) => !status || s.status === status)
      .sort((a, b) => a.queuedAt - b.queuedAt)
      .map((s) => this.toJSON(s))
    const current = this.current ? this.states.get(this.current) : null
    return {
      mode: settings.mode,
      gate: this.gate,
      worker: { busy: this.running && !!this.current, current: current && current.libraryId === library.id ? this.toJSON(current) : null },
      counts,
      items
    }
  }

  async getProposal(libraryItemId) {
    this.assertEnabled()
    const proposal = await this.store.readProposal(libraryItemId)
    return proposal || null
  }

  //
  // Worker
  //

  kick() {
    if (!this.enabled || !this.autoRun) return
    if (this.running) {
      this.rerun = true
      return
    }
    this.loopPromise = this.loop()
  }

  /**
   * Process every item that can run now (tests call it directly).
   *
   * @returns {Promise<void>}
   */
  async drain() {
    if (this.running) {
      this.rerun = true
      await this.loopPromise
      if (this.running) return this.drain()
      return
    }
    this.loopPromise = this.loop()
    await this.loopPromise
  }

  async loop() {
    this.running = true
    clearTimeout(this.wakeTimer)
    this.wakeTimer = null
    try {
      while (this.enabled) {
        this.rerun = false
        const state = this.pickNext()
        if (!state) {
          if (this.rerun) continue
          break
        }
        await this.process(state)
      }
    } catch (error) {
      Logger.error('[AutoPipeline] Worker failed', error)
    } finally {
      this.running = false
      this.current = null
      this.scheduleWake()
    }
  }

  get epubLaneBusy() {
    for (const s of this.states.values()) if (s.status === 'epub' && (s.epub?.result === 'running' || s.epub?.result === 'starting')) return true
    return false
  }

  /**
   * The next state to run: FIFO by queuedAt, respecting notBefore; EPUB steps only while the EPUB lane is free.
   */
  pickNext() {
    const now = this.now()
    const laneBusy = this.epubLaneBusy
    let best = null
    for (const s of this.states.values()) {
      if (s.notBefore && s.notBefore > now) continue
      const runnable = s.status === 'queued' || s.status === 'waiting' || (s.status === 'epub' && s.epub?.result === 'queued' && !laneBusy)
      if (!runnable) continue
      if (!best || s.queuedAt < best.queuedAt) best = s
    }
    return best
  }

  scheduleWake() {
    if (!this.enabled || !this.autoRun) return
    const now = this.now()
    let next = null
    for (const s of this.states.values()) {
      if (s.status !== 'queued' && s.status !== 'waiting' && !(s.status === 'epub' && s.epub?.result === 'queued')) continue
      const at = s.notBefore || now
      if (next === null || at < next) next = at
    }
    if (next === null) return
    clearTimeout(this.wakeTimer)
    this.wakeTimer = setTimeout(() => this.kick(), Math.max(1000, next - now))
    if (this.wakeTimer.unref) this.wakeTimer.unref()
  }

  /**
   * Run the state's current step once.
   *
   * @param {Object} state
   */
  async process(state) {
    const id = state.libraryItemId
    this.current = id
    const step = state.step || 'waiting'
    state.status = step === 'epub' ? 'epub' : step
    state.reason = null
    await this.save(state)

    let task = null
    if (step !== 'waiting') {
      task = TaskManager.createAndAddTask('auto-pipeline', { text: `Auto pipeline: ${step} - ${state.title}` }, null, false, { libraryItemId: id, libraryId: state.libraryId, step })
    }
    try {
      const libraryItem = await Database.libraryItemModel.getExpandedById(id)
      if (!libraryItem?.media) {
        this.states.delete(id)
        await this.store.removeItem(id, { all: true }).catch(() => {})
        Logger.info(`[AutoPipeline] "${state.title}" no longer exists, removed from the pipeline`)
        return
      }
      const library = await Database.libraryModel.findByPk(state.libraryId)
      if (!library) {
        this.states.delete(id)
        await this.store.removeItem(id, { all: true }).catch(() => {})
        return
      }
      const settings = normalizeAutoPipelineSettings(library.settings?.autoPipeline)
      state.title = libraryItem.media.title || state.title

      if (step === 'waiting') await this.stepWaiting(state, libraryItem, library, settings)
      else if (step === 'matching') await this.stepMatching(state, libraryItem, library, settings)
      else if (step === 'chapters') await this.stepChapters(state, libraryItem, library, settings)
      else if (step === 'epub') await this.stepEpub(state, libraryItem, library, settings)
      else await this.finish(state, 'failed', `unknown step ${step}`)
      // the step ran without an error: errors are counted per run of a step
      state.attempts = 0
    } catch (error) {
      if (this.states.get(id) !== state) return
      state.attempts = (state.attempts || 0) + 1
      Logger.error(`[AutoPipeline] Step ${step} of "${state.title}" failed (attempt ${state.attempts})`, error)
      if (state.attempts >= MAX_ATTEMPTS) await this.finish(state, 'failed', `${step}: ${String(error?.message || error).slice(0, 200)}`)
      else {
        this.queued(state, step, `retrying after an error: ${String(error?.message || error).slice(0, 200)}`, this.timing.errorRetryMs)
        await this.save(state)
      }
    } finally {
      if (task) {
        task.setFinished()
        TaskManager.taskFinished(task)
      }
      this.current = null
    }
  }

  //
  // Step 1: waiting
  //

  /**
   * Files of the item folder on disk: the newest mtime and a size/mtime signature.
   *
   * @param {import('../models/LibraryItem')} libraryItem
   * @returns {Promise<{maxMtimeMs: number, signature: string}>}
   */
  async diskSnapshot(libraryItem) {
    const files = []
    const walk = async (dir, depth) => {
      let entries = []
      try {
        entries = await this.readdir(dir)
      } catch {
        return
      }
      for (const entry of entries) {
        const full = Path.join(dir, entry.name)
        if (entry.isDirectory()) {
          if (depth < 3) await walk(full, depth + 1)
          continue
        }
        try {
          const st = await this.stat(full)
          files.push({ path: full, size: st.size, mtimeMs: st.mtimeMs })
        } catch {
          files.push({ path: full, size: -1, mtimeMs: this.now() })
        }
      }
    }
    if (libraryItem.isFile) {
      try {
        const st = await this.stat(libraryItem.path)
        files.push({ path: libraryItem.path, size: st.size, mtimeMs: st.mtimeMs })
      } catch {
        // gone: the item is missing, the scanner deals with it
      }
    } else {
      await walk(libraryItem.path, 0)
    }
    files.sort((a, b) => (a.path < b.path ? -1 : 1))
    return {
      maxMtimeMs: files.reduce((m, f) => Math.max(m, f.mtimeMs || 0), 0),
      signature: files.map((f) => `${f.path}:${f.size}:${Math.round(f.mtimeMs)}`).join('|')
    }
  }

  async stepWaiting(state, libraryItem, library, settings) {
    if (this.getLibraryScanner().libraryLocks.has(library.id)) {
      this.queued(state, 'waiting', 'waiting for the library scan to finish', this.timing.libraryBusyMs)
      return this.save(state)
    }
    if (libraryItem.isMissing || !libraryItem.isBook || !libraryItem.media.hasAudioTracks) {
      return this.finish(state, 'skipped', 'not a book with audio tracks')
    }
    const audioFp = chapterPlan.audioFingerprint(libraryItem.media.includedAudioFiles)
    if (!state.manual) {
      const disk = await this.diskSnapshot(libraryItem)
      const settleMs = settings.settleMinutes * MIN
      const age = this.now() - disk.maxMtimeMs
      if (age < settleMs) {
        state.waitCheck = null
        this.queued(state, 'waiting', 'waiting for the files to settle', settleMs - age)
        return this.save(state)
      }
      const combined = `${audioFp}|${disk.signature}`
      if (!state.waitCheck || state.waitCheck.fingerprint !== combined || this.now() - state.waitCheck.at < this.timing.settleCheckMs) {
        if (!state.waitCheck || state.waitCheck.fingerprint !== combined) state.waitCheck = { fingerprint: combined, at: this.now() }
        this.queued(state, 'waiting', 'checking that the files are complete', Math.max(0, state.waitCheck.at + this.timing.settleCheckMs - this.now()))
        return this.save(state)
      }
    }
    state.waitCheck = null
    state.fingerprint = audioFp
    this.log(state, 'waiting', 'files settled')
    return this.advance(state, settings, null)
  }

  //
  // Step 2: matching
  //

  async stepMatching(state, libraryItem, library, settings) {
    if (libraryItem.media.asin) {
      // never overwrite an ASIN (matched by hand, from tags or an earlier match)
      state.match = { result: 'existing-asin', asin: libraryItem.media.asin }
      this.log(state, 'matching', `existing ASIN ${libraryItem.media.asin}, not matched again`)
      return this.advance(state, settings, 'match')
    }
    const provider = effectiveProvider(library, settings)
    if (!isAudibleProvider(provider)) {
      state.match = { result: 'skipped', reason: 'provider', provider }
      this.log(state, 'matching', `skipped: provider "${provider}" is not Audible`)
      return this.advance(state, settings, 'match')
    }

    const media = libraryItem.media
    const results = await this.getBookFinder().search(libraryItem, provider, media.title, media.authorName, media.isbn, null, { maxFuzzySearches: 2 })
    const candidates = (Array.isArray(results) ? results : []).slice(0, MAX_CANDIDATES)
    const decision = pickMatch(itemForScoring(libraryItem), candidates, settings.autoMatchMinConfidence)
    state.match = {
      result: decision.result,
      reason: decision.reason,
      confidence: decision.confidence,
      asin: decision.asin,
      provider,
      minConfidence: settings.autoMatchMinConfidence,
      candidates: decision.candidates
    }
    const scores = decision.candidates.map(
      (c) =>
        `${c.asin} ${c.confidence}% [${Object.entries(c.components)
          .map(([k, v]) => `${k} ${v}`)
          .join(', ')}${c.caps.length ? `; capped by ${c.caps.join(', ')}` : ''}]`
    )
    this.log(state, 'matching', `${decision.result}${decision.reason ? ` (${decision.reason})` : ''}; ${scores.join(' | ') || 'no candidates'}`)

    if (decision.result !== 'matched') {
      if (state.dryRun) state.match.would = `would need review: match ${decision.reason}${decision.confidence !== null ? ` (best ${decision.confidence} %)` : ''}`
      // chapters and the EPUB depend on the right book
      return this.finish(state, 'needs-review', `match: ${decision.reason}`)
    }
    if (state.dryRun) {
      state.match.would = `would match ${decision.asin} at ${decision.confidence} %`
      return this.advance(state, settings, 'match')
    }

    const applied = await this.getLibraryScanner().runWithLibraryLock(library.id, async () => {
      const fresh = await Database.libraryItemModel.getExpandedById(libraryItem.id)
      if (!fresh?.media) return { gone: true }
      if (fresh.media.asin) return { asin: fresh.media.asin }
      const result = await this.getScanner().applyBookMatch(this.apiRouter, fresh, clone(decision.candidate), {})
      return { result }
    })
    if (applied.gone) return this.finish(state, 'failed', 'the library item no longer exists')
    if (applied.asin) {
      state.match = { ...state.match, result: 'existing-asin', asin: applied.asin }
      this.log(state, 'matching', `an ASIN (${applied.asin}) was set meanwhile, not matched`)
    } else {
      state.match.applied = true
      this.log(state, 'matching', `applied ${decision.asin} (${applied.result?.updated ? 'updated' : 'no changes'})`)
    }
    return this.advance(state, settings, 'match')
  }

  //
  // Step 3: chapters
  //

  /**
   * Snap with the retry contract of POST /chapters/snap: when a run is not complete, run again with the proposed
   * chapters and the not-analysed indexes, up to MAX_SNAP_ROUNDS rounds. No HTTP budget here (deadline 30 min).
   *
   * @returns {Promise<Object>} merged snap response
   */
  async runSnapRounds({ libraryItemId, timeline, T, chapters, itemChapters }) {
    let input = chapterSnap.validateChapters(
      chapters.map((c, i) => ({ id: i, title: c.title, start: c.start })),
      T
    )
    let indexes = null
    let merged = null
    for (let round = 1; round <= MAX_SNAP_ROUNDS; round++) {
      const response = await this.snapRunner.runSnap({
        libraryItemId,
        timeline,
        T,
        chapters: input,
        itemChapters,
        indexes,
        options: { ...chapterSnap.DEFAULT_OPTIONS },
        deadlineMs: this.timing.snapDeadlineMs,
        ...(this.detect ? { detect: this.detect } : {}),
        verifiers: []
      })
      if (!merged) merged = response
      else {
        merged = {
          ...response,
          chapters: response.chapters.map((c, i) => (indexes.has(i) ? c : { ...merged.chapters[i], index: i })),
          warnings: [...merged.warnings, ...response.warnings],
          stats: { ...response.stats, rounds: round }
        }
      }
      merged.stats = { ...merged.stats, rounds: round }
      const notAnalysed = merged.chapters.filter((c) => c.reason === chapterSnap.REASONS.NOT_ANALYSED).map((c) => c.index)
      merged.complete = response.complete && !notAnalysed.length && !merged.chapters.some((c) => c.reason === chapterSnap.REASONS.ANALYSIS_FAILED)
      if (merged.complete || !notAnalysed.length) break
      input = chapterSnap.validateChapters(merged.proposedChapters, T)
      indexes = new Set(notAnalysed)
    }
    return merged
  }

  /**
   * Speech check the snap proposals in chunks of SPEECH_CHUNK starts (the HTTP request size), each with its own
   * deadline. Verdicts already in `speech` are not checked again.
   *
   * @returns {Promise<{busy: boolean, unchecked: number[], warnings: string[]}>}
   */
  async runSpeechCheck({ snap, timeline, speech, onChunk }) {
    const wanted = snap.chapters.filter((c) => c.index > 0 && c.proposedStart >= 1 && !chapterSnap.SKIP_REASONS.has(c.reason) && !(String(c.index) in speech))
    const titles = snap.chapters.map((c) => c.title)
    const warnings = []
    let busy = false
    for (let k = 0; k < wanted.length; k += SPEECH_CHUNK) {
      const chunk = wanted.slice(k, k + SPEECH_CHUNK)
      const verifier = chapterbotSpeech.createVerifier({
        titles,
        skipReasons: chapterSnap.SKIP_REASONS,
        client: this.speechClient,
        now: this.now,
        deadlineMs: this.timing.speechChunkDeadlineMs,
        maxStarts: SPEECH_CHUNK
      })
      const proposals = chunk.map((c) => Object.freeze({ index: c.index, originalStart: c.originalStart, proposedStart: c.proposedStart, reason: c.reason, confidence: c.confidence, pause: c.pause }))
      const outcome = (await verifier.verify({ proposals, timeline, signal: null })) || {}
      const verdicts = Array.isArray(outcome) ? outcome : outcome.verdicts || []
      const chunkWarnings = Array.isArray(outcome.warnings) ? outcome.warnings : []
      warnings.push(...chunkWarnings)
      for (const v of verdicts) if (v && Number.isInteger(v.index)) speech[String(v.index)] = { speech: v.speech ?? null, confidence: v.confidence ?? null }
      if (onChunk) await onChunk()
      if (chunk.some((c) => !(String(c.index) in speech))) {
        // busy (429/503) or failed: the rest is retried later
        busy = chunkWarnings.some((w) => /busy/i.test(w))
        break
      }
    }
    const unchecked = wanted.filter((c) => !(String(c.index) in speech)).map((c) => c.index)
    return { busy, unchecked, warnings }
  }

  /**
   * The snap response with the speech verdicts filled in (speech never moves a start; it may only lower confidence).
   */
  mergeSpeech(snap, speech) {
    const merged = clone(snap)
    for (const c of merged.chapters) {
      const v = speech[String(c.index)]
      if (!v) continue
      c.speech = v.speech
      if (v.confidence) c.confidence = chapterSnap.lowerConfidence(c.confidence, v.confidence)
    }
    return merged
  }

  async stepChapters(state, libraryItem, library, settings) {
    const provider = effectiveProvider(library, settings)
    const prev = state.chapters || {}
    const keep = { appliedHash: prev.appliedHash || null }
    if (!isAudibleProvider(provider)) {
      state.chapters = { ...keep, result: 'skipped', reason: 'provider' }
      this.log(state, 'chapters', `skipped: provider "${provider}" is not Audible`)
      return this.advance(state, settings, 'chapters')
    }
    const media = libraryItem.media
    const timeline = chapterSnap.buildTimeline(media.includedAudioFiles)
    const T = chapterSnap.computeDuration(timeline, media.duration)
    const current = plainChapters(media.chapters)
    const scannerChapters = plainChapters(this.getScannerChapters(media.title, media.includedAudioFiles))
    const kind = chapterPlan.classifyChapters(current, scannerChapters, keep.appliedHash)
    const extra = []
    if (kind === 'user') {
      const bad = chapterPlan.clearlyBad(current, T)
      if (!bad && !state.force) {
        state.chapters = { ...keep, result: 'kept', reason: 'user-edited', current: kind }
        this.log(state, 'chapters', 'kept: chapters were edited by a person')
        return this.advance(state, settings, 'chapters')
      }
      // never changed without review
      extra.push('user-edited')
      if (bad) extra.push(`current-${bad}`)
    }

    // source
    const asin = media.asin || (state.dryRun && state.match?.result === 'matched' ? state.match.asin : null)
    const region = regionForProvider(provider)
    let source = null
    let proposedInput = null
    if (asin) {
      const data = await this.getBookFinder().findChapters(asin, region)
      const audible = chapterPlan.pickAudibleSource(data, T)
      source = { kind: audible.result, asin, region, variant: audible.variant, diffSec: audible.diffSec, runtimeSec: audible.runtimeSec, isAccurate: audible.isAccurate, chapters: audible.chapters.length }
      if (audible.result === 'aligned' || audible.result === 'near') proposedInput = audible.chapters
      this.log(state, 'chapters', `Audible chapters ${asin}/${region}: ${audible.result}${audible.diffSec !== null ? `, ${audible.variant} runtime off by ${audible.diffSec}s` : ''}`)
    }
    if (!proposedInput) {
      if (kind === 'scanner' && current.length >= 2) {
        source = { ...(source || {}), kind: 'scanner', fallbackFrom: source?.kind || null }
        proposedInput = current
      } else {
        state.chapters = { ...keep, result: 'needs-review', reason: 'no-chapter-source', current: kind, source }
        if (state.dryRun) state.chapters.would = 'would need review: no chapter source'
        return this.finish(state, 'needs-review', 'chapters: no chapter source')
      }
    }
    const sourceHash = chapterPlan.chaptersHash(proposedInput)
    const fingerprint = chapterPlan.audioFingerprint(media.includedAudioFiles)

    // analysis (resumable): snap, then the speech check
    let analysis = await this.store.readAnalysis(libraryItem.id)
    if (!analysis || analysis.fingerprint !== fingerprint || analysis.sourceHash !== sourceHash) {
      const slot = this.snapRunner.acquire(libraryItem.id, 'pipeline')
      if (!slot.ok) {
        this.queued(state, 'chapters', 'waiting for a chapter snap slot', this.timing.snapBusyMs)
        return this.save(state)
      }
      let snap
      try {
        snap = await this.runSnapRounds({ libraryItemId: libraryItem.id, timeline, T, chapters: proposedInput, itemChapters: media.chapters })
      } catch (error) {
        if (error.code === 'ALL_FAILED' || error instanceof chapterSnap.SnapInputError) {
          state.chapters = { ...keep, result: 'needs-review', reason: error.code === 'ALL_FAILED' ? 'silence-detection-failed' : 'invalid-chapters', current: kind, source }
          if (state.dryRun) state.chapters.would = `would need review: ${state.chapters.reason}`
          return this.finish(state, 'needs-review', `chapters: ${state.chapters.reason}`)
        }
        throw error
      } finally {
        slot.release()
      }
      analysis = { fingerprint, sourceHash, source, kind, extra, snap, speech: {}, speechTries: 0, createdAt: this.now() }
      await this.store.saveAnalysis(libraryItem.id, analysis)
    }

    const evaluateAndFinish = async (speechNote) => {
      const merged = this.mergeSpeech(analysis.snap, analysis.speech)
      const evaluation = chapterPlan.evaluatePolicy({ source: source.kind, snap: merged, extra: [...extra, ...(speechNote ? [speechNote] : [])] })
      const proposed = plainChapters(merged.proposedChapters)
      const summary = chapterPlan.summarizeFailing(evaluation)
      const base = { ...keep, current: kind, source, diffSec: source.diffSec ?? null, count: proposed.length, failing: evaluation.failing, blockers: evaluation.blockers }
      this.log(state, 'chapters', `${evaluation.apply ? 'passes' : 'fails'} the apply policy (${merged.chapters.length} chapters, moved ${merged.stats?.moved ?? '?'}${summary ? `; ${summary}` : ''})`)

      if (!evaluation.apply) {
        await this.store.saveProposal(libraryItem.id, { libraryItemId: libraryItem.id, createdAt: this.now(), dryRun: !!state.dryRun, fingerprint, source, diffSec: source.diffSec ?? null, snap: merged, failing: evaluation.failing, blockers: evaluation.blockers, proposedChapters: proposed, currentChapters: current })
        await this.store.removeAnalysis(libraryItem.id).catch(() => {})
        state.chapters = { ...base, result: 'needs-review', reason: summary }
        if (state.dryRun) state.chapters.would = `would need review: ${summary}`
        return this.finish(state, 'needs-review', `chapters: ${summary}`)
      }
      await this.store.removeAnalysis(libraryItem.id).catch(() => {})
      if (chapterPlan.chaptersEqual(proposed, current)) {
        state.chapters = { ...base, result: 'kept', reason: 'already-correct' }
        if (state.dryRun) state.chapters.would = 'would keep the chapters (already correct)'
        this.log(state, 'chapters', 'kept: the chapters are already correct')
        return this.advance(state, settings, 'chapters')
      }
      if (state.dryRun) {
        state.chapters = { ...base, result: 'would-apply', would: `would apply ${proposed.length} chapters` }
        return this.advance(state, settings, 'chapters')
      }
      const applied = await this.applyProposal(state, libraryItem.id, proposed, { fingerprint, source: source.kind === 'scanner' ? 'scanner-check' : `audible:${source.kind}`, reason: 'auto' })
      if (applied.changedAudio) {
        state.chapters = { ...keep, result: null }
        this.queued(state, 'chapters', 'the audio changed during the analysis, analysing again')
        return this.save(state)
      }
      state.chapters = { ...base, result: 'applied', appliedHash: applied.appliedHash, backup: applied.backup, applied: true }
      this.log(state, 'chapters', `applied ${proposed.length} chapters (backup ${applied.backup})`)
      return this.advance(state, settings, 'chapters')
    }

    if (!this.speechClient.isConfigured()) {
      // the pipeline never applies chapters without a speech check
      return evaluateAndFinish('speech-check-unavailable')
    }
    const { busy, unchecked } = await this.runSpeechCheck({
      snap: analysis.snap,
      timeline,
      speech: analysis.speech,
      onChunk: () => this.store.saveAnalysis(libraryItem.id, analysis)
    })
    if (unchecked.length) {
      analysis.speechTries = (analysis.speechTries || 0) + 1
      await this.store.saveAnalysis(libraryItem.id, analysis)
      const backoff = this.timing.speechBackoffMs
      if (analysis.speechTries > backoff.length) {
        this.log(state, 'chapters', `speech check unavailable after ${analysis.speechTries} tries, ${unchecked.length} chapters unchecked`)
        return evaluateAndFinish('speech-check-unavailable')
      }
      const wait = backoff[analysis.speechTries - 1]
      this.log(state, 'chapters', `chapterbot ${busy ? 'busy' : 'unavailable'}: ${unchecked.length} chapters not speech checked, retry ${analysis.speechTries} in ${Math.round(wait / 1000)}s`)
      this.queued(state, 'chapters', `chapterbot busy, speech check retry ${analysis.speechTries} of ${backoff.length}`, wait)
      return this.save(state)
    }
    return evaluateAndFinish(null)
  }

  /**
   * Back up the current chapters and apply new ones, inside the library lock. Re-checks the audio fingerprint first:
   * a book whose audio changed since the analysis is not touched.
   *
   * @param {Object} state
   * @param {string} libraryItemId
   * @param {{title: string, start: number, end: number}[]} chapters
   * @param {{fingerprint: string|null, source: string, reason: string}} opts
   * @returns {Promise<{changedAudio?: boolean, appliedHash?: string, backup?: string, updated?: boolean, gone?: boolean}>}
   */
  async applyProposal(state, libraryItemId, chapters, { fingerprint, source, reason }) {
    return this.getLibraryScanner().runWithLibraryLock(state.libraryId, async () => {
      const fresh = await Database.libraryItemModel.getExpandedById(libraryItemId)
      if (!fresh?.media) throw new PipelineError(404, 'The library item no longer exists')
      if (fingerprint && chapterPlan.audioFingerprint(fresh.media.includedAudioFiles) !== fingerprint) return { changedAudio: true }
      const backup = await this.store.writeBackup(libraryItemId, { chapters: plainChapters(fresh.media.chapters), source, reason }, new Date(this.now()))
      const { updated } = await applyChapters(fresh, chapters)
      return { appliedHash: chapterPlan.chaptersHash(plainChapters(fresh.media.chapters)), backup, updated }
    })
  }

  //
  // Step 4: EPUB
  //

  async stepEpub(state, libraryItem, library, settings) {
    const hasEbook = !!libraryItem.media.ebookFile || (libraryItem.libraryFiles || []).some((lf) => lf.fileType === 'ebook')
    if (hasEbook) {
      state.epub = { result: 'skipped', reason: 'has-ebook' }
      return this.finish(state, 'done', this.doneReason(state))
    }
    if (!this.epubManager.isConfigured) {
      state.epub = { result: 'skipped', reason: 'chapterbot-not-configured' }
      return this.finish(state, 'done', this.doneReason(state))
    }
    if (state.dryRun) {
      state.epub = { result: 'would', would: 'would build an EPUB' }
      return this.finish(state, 'done', this.doneReason(state))
    }
    state.epub = { ...(state.epub || {}), result: 'starting' }
    let job
    try {
      job = await this.epubManager.start(libraryItem, null, { origin: 'pipeline' })
    } catch (error) {
      if (error instanceof ChapterbotEpubManager.EpubJobError && error.status === 429) {
        const tries = (state.epub.tries || 0) + 1
        const backoff = this.timing.epubBackoffMs
        if (tries > backoff.length) {
          state.epub = { result: 'failed', reason: 'chapterbot busy' }
          return this.finish(state, 'failed', 'EPUB: chapterbot stayed busy')
        }
        state.epub = { result: 'queued', tries }
        this.queued(state, 'epub', `chapterbot busy, EPUB retry ${tries} of ${backoff.length}`, backoff[tries - 1])
        return this.save(state)
      }
      if (error instanceof ChapterbotEpubManager.EpubJobError && error.status === 409 && error.jobId) {
        // someone started one for this book: follow it
        state.epub = { result: 'running', jobId: error.jobId, external: true }
        state.status = 'epub'
        state.reason = 'EPUB job running'
        return this.save(state)
      }
      state.epub = { result: 'failed', reason: error.message }
      return this.finish(state, 'failed', `EPUB: ${error.message}`)
    }
    state.epub = { result: 'running', jobId: job.jobId }
    state.status = 'epub'
    state.reason = 'EPUB job running'
    this.log(state, 'epub', `started EPUB job ${job.jobId}`)
    return this.save(state)
  }

  /**
   * ChapterbotEpubManager 'ended': the job of a state finished.
   *
   * @param {Object} job - toJSON record
   */
  async onEpubEnded(job) {
    const state = this.states.get(job?.libraryItemId)
    if (!state || state.status !== 'epub' || state.epub?.result !== 'running' || state.epub.jobId !== job.jobId) return
    if (job.status === 'done') {
      state.epub = { ...state.epub, result: 'done', fileName: job.fileName }
      await this.finish(state, 'done', this.doneReason(state))
    } else {
      state.epub = { ...state.epub, result: job.status, reason: job.error || job.status }
      await this.finish(state, 'failed', `EPUB ${job.status}${job.error ? `: ${job.error}` : ''}`)
    }
    this.kick()
  }

  //
  // Review
  //

  /**
   * Approve the chapter proposal (optionally edited), apply it and continue with the EPUB step.
   *
   * @param {string} libraryItemId
   * @param {Object[]} [chapters] - edited chapters, the same shape as POST /api/items/:id/chapters
   * @returns {Promise<Object>} state
   * @throws {PipelineError}
   */
  async approve(libraryItemId, chapters) {
    this.assertEnabled()
    const state = this.states.get(libraryItemId)
    if (!state || state.status !== 'needs-review' || state.chapters?.result !== 'needs-review') throw new PipelineError(409, 'There is no chapter proposal waiting for review')
    if (state.dryRun) throw new PipelineError(409, 'A dry run result cannot be approved; run the item again')
    if (this.current === libraryItemId) throw new PipelineError(409, 'The item is being processed right now')
    const proposal = await this.store.readProposal(libraryItemId)
    if (!proposal) throw new PipelineError(409, 'There is no chapter proposal waiting for review')
    if (chapters !== undefined && chapters !== null && !isValidChapterPayload(chapters)) throw new PipelineError(400, 'Invalid chapters')
    const toApply = (chapters ?? proposal.proposedChapters).map((c) => ({ title: c.title, start: c.start, end: c.end }))
    if (!toApply.length) throw new PipelineError(400, 'No chapters')

    const applied = await this.applyProposal(state, libraryItemId, toApply, { fingerprint: proposal.fingerprint, source: `review:${proposal.source?.kind || 'unknown'}`, reason: chapters ? 'approved with edits' : 'approved' })
    if (applied.changedAudio) throw new PipelineError(409, 'The audio changed since the analysis; run the item again')
    await this.store.removeProposal(libraryItemId).catch(() => {})
    // chapters edited in the review are a person's: no appliedHash, so a later run treats them as edited by hand
    state.chapters = { ...state.chapters, result: 'approved', edited: !!chapters, count: toApply.length, appliedHash: chapters ? null : applied.appliedHash, backup: applied.backup }
    this.log(state, 'review', `approved ${toApply.length} chapters${chapters ? ' (edited)' : ''}`)
    const library = await Database.libraryModel.findByPk(state.libraryId)
    await this.advance(state, normalizeAutoPipelineSettings(library?.settings?.autoPipeline), 'chapters')
    this.kick()
    return this.toJSON(state)
  }

  /**
   * Reject the chapter proposal: the current chapters stay. With `continue`, the EPUB step still runs.
   *
   * @param {string} libraryItemId
   * @param {{continue?: boolean}} [opts]
   * @returns {Promise<Object>} state
   */
  async reject(libraryItemId, { continue: cont = false } = {}) {
    this.assertEnabled()
    const state = this.states.get(libraryItemId)
    if (!state || state.status !== 'needs-review' || state.chapters?.result !== 'needs-review') throw new PipelineError(409, 'There is no chapter proposal waiting for review')
    if (this.current === libraryItemId) throw new PipelineError(409, 'The item is being processed right now')
    await this.store.removeProposal(libraryItemId).catch(() => {})
    state.chapters = { ...state.chapters, result: 'rejected' }
    this.log(state, 'review', `rejected the chapter proposal${cont ? ', continuing' : ''}`)
    if (cont && !state.dryRun) {
      const library = await Database.libraryModel.findByPk(state.libraryId)
      const settings = normalizeAutoPipelineSettings(library?.settings?.autoPipeline)
      if (this.nextStep(state, settings, 'chapters') === 'epub') {
        state.epub = { result: 'queued' }
        this.queued(state, 'epub', 'waiting for the EPUB lane')
        await this.save(state)
        this.kick()
        return this.toJSON(state)
      }
    }
    await this.finish(state, 'done', this.doneReason(state))
    return this.toJSON(state)
  }

  async listBackups(libraryItemId) {
    this.assertEnabled()
    return this.store.listBackups(libraryItemId)
  }

  /**
   * Restore a chapter backup (undo). Backs up the current chapters first.
   *
   * @param {import('../models/LibraryItem')} libraryItem
   * @param {string} name
   * @returns {Promise<{restored: string, backup: string, chapters: number}>}
   */
  async restoreBackup(libraryItem, name) {
    this.assertEnabled()
    const backup = await this.store.readBackup(libraryItem.id, name)
    if (!backup) throw new PipelineError(404, 'No such backup')
    if (!isValidChapterPayload(backup.chapters)) throw new PipelineError(400, 'The backup holds no valid chapters')
    if (this.current === libraryItem.id) throw new PipelineError(409, 'The item is being processed right now')
    const result = await this.getLibraryScanner().runWithLibraryLock(libraryItem.libraryId, async () => {
      const fresh = await Database.libraryItemModel.getExpandedById(libraryItem.id)
      if (!fresh?.media) throw new PipelineError(404, 'The library item no longer exists')
      const before = await this.store.writeBackup(libraryItem.id, { chapters: plainChapters(fresh.media.chapters), source: 'restore', reason: `before restoring ${name}` }, new Date(this.now()))
      await applyChapters(
        fresh,
        backup.chapters.map((c) => ({ title: c.title, start: c.start, end: c.end }))
      )
      return { restored: name, backup: before, chapters: backup.chapters.length }
    })
    const state = this.states.get(libraryItem.id)
    if (state && state.chapters) {
      state.chapters = { ...state.chapters, result: 'restored', restoredFrom: name, appliedHash: null, applied: false }
      state.reason = `chapters restored from ${name}`
      await this.save(state)
    }
    Logger.info(`[AutoPipeline] Restored the chapters of "${libraryItem.media?.title}" from ${name} (backup ${result.backup})`)
    return result
  }
}

const manager = new AutoPipelineManager()
module.exports = manager
module.exports.AutoPipelineManager = AutoPipelineManager
module.exports.PipelineError = PipelineError
module.exports.STATUSES = STATUSES
module.exports.ACTIVE_STATUSES = ACTIVE_STATUSES
module.exports.DEFAULT_TIMING = DEFAULT_TIMING
