const os = require('os')
const Logger = require('../Logger')
const ffmpegHelpers = require('./ffmpegHelpers')
const chapterSnap = require('./chapterSnap')

/** ffmpeg processes per job */
const POOL = Math.min(3, Math.max(1, Math.floor(os.cpus().length / 2)))
/** snap jobs server-wide (and 1 per library item) */
const MAX_JOBS = 2
const PER_RUN_TIMEOUT_SEC = 30
/** No new segment starts after this. Under nginx's 60 s default proxy timeout. */
const DEADLINE_MS = 45000

/** @type {Map<string, string|null>} libraryItemId -> userId of each running snap */
const runningJobs = new Map()

/**
 * Take a job slot. One snap per library item and one per user, so a single user cannot hold every global slot.
 *
 * @param {string} libraryItemId
 * @param {string} [userId]
 * @returns {{ok: true, release: () => void} | {ok: false, status: number, error: string}}
 */
function acquire(libraryItemId, userId = null) {
  if (runningJobs.has(libraryItemId)) return { ok: false, status: 409, error: 'Snap already running for this item' }
  if (userId && [...runningJobs.values()].includes(userId)) return { ok: false, status: 429, error: 'You already have a chapter snap running, try again when it finishes' }
  if (runningJobs.size >= MAX_JOBS) return { ok: false, status: 429, error: 'Chapter snap busy, try again' }
  runningJobs.set(libraryItemId, userId)
  let released = false
  return {
    ok: true,
    release: () => {
      if (released) return
      released = true
      runningJobs.delete(libraryItemId)
    }
  }
}

function snapError(code, message) {
  const error = new Error(message || code)
  error.code = code
  return error
}

/**
 * Default detector: real ffmpeg silencedetect. Called through the module object so tests can stub it.
 */
function defaultDetect(params) {
  return ffmpegHelpers.detectSilences(params)
}

/**
 * Run detect over the segments with a bounded pool and a deadline.
 *
 * @returns {Promise<{results: Array<{status: string, lines?: string[], error?: string}>, ffmpegCalls: number}>}
 */
async function runPool({ segments, timeline, options, detect, signal, deadlineMs, pool, now }) {
  const startedAt = now()
  const results = new Array(segments.length).fill(null).map(() => ({ status: 'skipped' }))
  const trackByIndex = new Map(timeline.map((track) => [track.index, track]))
  let next = 0
  let ffmpegCalls = 0

  async function worker() {
    while (true) {
      if (signal?.aborted) return
      if (next >= segments.length) return
      const elapsed = now() - startedAt
      if (elapsed >= deadlineMs) return
      const k = next++
      const seg = segments[k]
      const track = trackByIndex.get(seg.trackIndex)
      // A run that starts just before the deadline still finishes well before a 60 s proxy timeout
      const remainingSec = Math.max(0, (deadlineMs - elapsed) / 1000)
      const timeoutSec = Math.min(PER_RUN_TIMEOUT_SEC, Math.max(5, Math.ceil(remainingSec) + 10))
      ffmpegCalls++
      try {
        const { lines } = await detect({
          path: track.path,
          startSec: seg.localStart,
          durationSec: seg.localDur,
          noiseDb: options.noiseDb,
          minSilenceSec: seg.detectMinSilenceSec ?? options.minSilenceSec,
          timeoutSec,
          signal
        })
        results[k] = { status: 'ok', lines: Array.isArray(lines) ? lines : [] }
      } catch (error) {
        if (signal?.aborted) return
        results[k] = { status: 'failed', error: error?.message || String(error) }
      }
    }
  }

  const workers = []
  for (let w = 0; w < Math.min(pool, segments.length); w++) workers.push(worker())
  await Promise.all(workers)
  if (signal?.aborted) throw snapError('SNAP_ABORTED', 'Chapter snap aborted')
  return { results, ffmpegCalls }
}

/**
 * Plan -> detect pool -> snap -> order -> verifier seam -> response.
 * Never saves anything.
 *
 * @param {Object} params
 * @param {string} params.libraryItemId
 * @param {import('./chapterSnap').TimelineTrack[]} params.timeline
 * @param {number} params.T
 * @param {import('./chapterSnap').SnapChapterInput[]} params.chapters - validated
 * @param {Object[]} [params.itemChapters] - media.chapters, for title fallback
 * @param {Set<number>|null} params.indexes
 * @param {import('./chapterSnap').SnapOptions} params.options
 * @param {AbortSignal} [params.signal]
 * @param {number} [params.deadlineMs]
 * @param {Function} [params.detect] - injected for tests, defaults to ffmpegHelpers.detectSilences
 * @param {{verify: Function}[]} [params.verifiers] - Whisper seam; may only set speech and lower confidence.
 *   verify() returns verdicts ([{index, speech?, confidence?}]) or {verdicts, warnings}
 * @param {number} [params.pool]
 * @param {() => number} [params.now]
 */
async function runSnap({ libraryItemId, timeline, T, chapters, itemChapters = [], indexes = null, options, signal = null, deadlineMs = DEADLINE_MS, detect = defaultDetect, verifiers = [], pool = POOL, now = Date.now }) {
  const startedAt = now()
  const starts = chapters.map((c) => c.start)
  const plan = chapterSnap.planSegments(starts, indexes, timeline, T, options)

  Logger.info(`[ChapterSnap] Start "${libraryItemId}": ${chapters.length} chapters, ${plan.segments.length} segments, ${plan.plannedSec.toFixed(1)}s planned, options ${JSON.stringify(options)}`)

  const { results, ffmpegCalls } = await runPool({ segments: plan.segments, timeline, options, detect, signal, deadlineMs, pool, now })

  const warnings = []
  const okResults = []
  let failedSegments = 0
  let skippedSegments = 0
  let analysedSec = 0
  plan.segments.forEach((seg, k) => {
    const result = results[k]
    if (result.status === 'ok') {
      okResults.push({ seg, pauses: chapterSnap.parseSilencedetect(result.lines, seg) })
      analysedSec += seg.localDur
    } else if (result.status === 'failed') {
      failedSegments++
      // ffmpeg's message can contain file paths and diagnostics: log it, never return it to the client
      Logger.warn(`[ChapterSnap] Silence detection failed for "${libraryItemId}" track ${seg.trackIndex} at ${seg.localStart.toFixed(1)}s: ${String(result.error).slice(0, 500)}`)
      warnings.push(`Silence detection failed for track ${seg.trackIndex} at ${seg.localStart.toFixed(1)}s`)
    } else {
      skippedSegments++
    }
  })

  if (plan.segments.length && failedSegments === plan.segments.length) {
    throw snapError('ALL_FAILED', 'Silence detection failed')
  }
  if (skippedSegments) {
    // The retry must send this response's proposedChapters: bounds come from the neighbours' starts in the request,
    // so a retry with the original starts could cross a neighbour that this call already moved
    warnings.push(`Time limit reached: ${skippedSegments} of ${plan.segments.length} segments not analysed. Resend with "chapters" set to this response's proposedChapters and "indexes" set to the chapters marked not-analysed; that response's proposedChapters is then the full list.`)
  }

  const pauses = chapterSnap.toBookPauses(okResults, timeline, options.minSilenceSec)

  const proposals = starts.map((t, i) => {
    let skipReason = null
    if (i > 0) {
      if (indexes && !indexes.has(i)) {
        skipReason = chapterSnap.REASONS.NOT_REQUESTED
      } else {
        const covering = plan.chapterSegments[i].map((id) => results[id].status)
        if (covering.includes('failed')) skipReason = chapterSnap.REASONS.ANALYSIS_FAILED
        else if (covering.includes('skipped')) skipReason = chapterSnap.REASONS.NOT_ANALYSED
      }
    }
    return chapterSnap.snapOne({ index: i, t, pauses, timeline, options, bounds: chapterSnap.boundsFor(starts, i, T), skipReason })
  })

  const { fallback } = chapterSnap.resolveOrder(starts, proposals)
  if (fallback) {
    Logger.error(`[ChapterSnap] Order assertion failed for "${libraryItemId}", returning original starts`)
  }

  for (const proposal of proposals) {
    proposal.confidence = chapterSnap.confidenceFor(proposal)
    proposal.speech = null
  }

  // Verifier seam (chapterbot speech check): may only fill speech and lower confidence, never move a start
  for (const verifier of verifiers) {
    const snapshot = proposals.map((p) => Object.freeze({ index: p.index, originalStart: p.originalStart, proposedStart: p.proposedStart, reason: p.reason, confidence: p.confidence, pause: p.pause ? Object.freeze({ ...p.pause }) : null }))
    const outcome = (await verifier.verify({ proposals: Object.freeze(snapshot), timeline, signal })) || []
    if (signal?.aborted) throw snapError('SNAP_ABORTED', 'Chapter snap aborted')
    const verdicts = Array.isArray(outcome) ? outcome : Array.isArray(outcome.verdicts) ? outcome.verdicts : []
    if (!Array.isArray(outcome) && Array.isArray(outcome.warnings)) warnings.push(...outcome.warnings.filter((w) => typeof w === 'string'))
    for (const verdict of verdicts) {
      const proposal = proposals[verdict?.index]
      if (!proposal) continue
      if (verdict.speech !== undefined) proposal.speech = verdict.speech
      if (verdict.confidence !== undefined) proposal.confidence = chapterSnap.lowerConfidence(proposal.confidence, verdict.confidence)
    }
  }

  const complete = failedSegments === 0 && skippedSegments === 0
  const response = chapterSnap.buildResponse({
    libraryItemId,
    T,
    options,
    chapters,
    itemChapters,
    proposals,
    timeline,
    complete,
    stats: {
      segments: plan.segments.length,
      ffmpegCalls,
      failedSegments,
      analysedSec,
      pausesFound: pauses.length,
      elapsedMs: now() - startedAt
    },
    warnings
  })

  const { stats } = response
  Logger.info(`[ChapterSnap] Done "${libraryItemId}" in ${stats.elapsedMs}ms: analysed ${stats.analysedSec}s, moved ${stats.moved}, unchanged ${stats.unchanged}, skipped ${stats.skipped}, complete ${complete}`)
  return response
}

module.exports = {
  POOL,
  MAX_JOBS,
  PER_RUN_TIMEOUT_SEC,
  DEADLINE_MS,
  acquire,
  runSnap,
  /** for tests */
  _runningJobs: runningJobs
}
