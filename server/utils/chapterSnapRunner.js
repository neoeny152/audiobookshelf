const os = require('os')
const Logger = require('../Logger')
const ffmpegHelpers = require('./ffmpegHelpers')
const chapterSnap = require('./chapterSnap')
const chapterReanchor = require('./chapterReanchor')

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
 * (Re-anchor) -> plan -> detect pool -> snap -> order -> verifier seam -> (located starts onto their pauses) -> response.
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
 * @param {{verify: Function}[]} [params.verifiers] - Whisper seam; sets speech and may lower confidence. A verdict with
 *   `start` (and `headingAt`) is a located heading (chapterLocate): the start moves there when it keeps the order.
 *   verify() returns verdicts ([{index, speech?, confidence?, start?, headingAt?}]) or {verdicts, warnings}
 * @param {number} [params.pool]
 * @param {() => number} [params.now]
 */
async function runSnap({ libraryItemId, timeline, T, chapters, itemChapters = [], indexes = null, options, signal = null, deadlineMs = DEADLINE_MS, detect = defaultDetect, verifiers = [], pool = POOL, now = Date.now }) {
  const startedAt = now()
  const inputStarts = chapters.map((c) => c.start)
  // Reference lists that drift against part files are mapped onto them first (options.reanchor)
  const reanchored = options.reanchor ? chapterReanchor.reanchorStarts(chapters, timeline, T) : null
  const starts = reanchored ? reanchored.starts : inputStarts
  if (reanchored) {
    Logger.info(`[ChapterSnap] Re-anchored "${libraryItemId}" on ${reanchored.anchors.length} part files: ${reanchored.anchors.map((a) => `#${a.index} ${a.from.toFixed(1)}->${a.to.toFixed(1)}`).join(', ')}`)
  }
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

  // Verifier seam (chapterbot speech check): fills speech and may lower confidence; a located heading moves a start
  const located = []
  for (const verifier of verifiers) {
    // referenceStart: the caller's start (originalStart is the re-anchored one when reanchor applied)
    const snapshot = proposals.map((p) => Object.freeze({ index: p.index, originalStart: p.originalStart, referenceStart: inputStarts[p.index], proposedStart: p.proposedStart, reason: p.reason, confidence: p.confidence, pause: p.pause ? Object.freeze({ ...p.pause }) : null }))
    const outcome = (await verifier.verify({ proposals: Object.freeze(snapshot), timeline, signal })) || []
    if (signal?.aborted) throw snapError('SNAP_ABORTED', 'Chapter snap aborted')
    const verdicts = Array.isArray(outcome) ? outcome : Array.isArray(outcome.verdicts) ? outcome.verdicts : []
    if (!Array.isArray(outcome) && Array.isArray(outcome.warnings)) warnings.push(...outcome.warnings.filter((w) => typeof w === 'string'))
    for (const verdict of verdicts) {
      const proposal = proposals[verdict?.index]
      if (!proposal) continue
      if (verdict.speech !== undefined) proposal.speech = verdict.speech
      if (verdict.confidence !== undefined) proposal.confidence = chapterSnap.lowerConfidence(proposal.confidence, verdict.confidence)
      if (Number.isFinite(verdict.start) && proposal.index > 0) located.push({ proposal, start: verdict.start, headingAt: Number.isFinite(verdict.headingAt) ? verdict.headingAt : verdict.start, predicted: verdict.predicted === true, near: verdict.predictedNear === true })
    }
  }
  if (located.length) await placeLocated({ located, proposals, starts, timeline, T, options, detect, signal, deadlineMs: Math.max(5000, deadlineMs - (now() - startedAt)), pool, now })

  // the response reports moves against the caller's starts, not the re-anchored ones
  if (reanchored) for (const proposal of proposals) proposal.originalStart = inputStarts[proposal.index]

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
    warnings,
    reanchor: reanchored ? { anchors: reanchored.anchors.map((a) => ({ index: a.index, trackIndex: a.trackIndex, from: a.from, to: a.to })) } : null
  })

  const { stats } = response
  Logger.info(`[ChapterSnap] Done "${libraryItemId}" in ${stats.elapsedMs}ms: analysed ${stats.analysedSec}s, moved ${stats.moved}, unchanged ${stats.unchanged}, skipped ${stats.skipped}, complete ${complete}`)
  return response
}

/**
 * Located headings (chapterLocate) onto the pause before the heading word: silence detection on a few seconds before
 * each heading, then the pause that ends within LOCATE_PAUSE_BEFORE..LOCATE_PAUSE_AFTER of the word, as snap places
 * a start (leadSec before the pause ends). Whisper often times a word that follows a silence up to ~0.8 s early (it
 * starts inside the silence), hence the allowance after the word.
 * A predicted start (no heading heard, placed from the headings around it) goes to the longest pause that ends within
 * LOCATE_PREDICT_RANGE of the prediction, and is not moved when there is none. A near prediction (`near`) only moves
 * a start that already lies in that pause, to the pause's end (minus leadSec). Without such a pause the transcript's start stays. A start that would
 * not stay between its neighbours is not moved.
 */
const LOCATE_PAUSE_BEFORE = 2.0
const LOCATE_PAUSE_AFTER = 1.0
const LOCATE_PREDICT_RANGE = 3
const LOCATE_WINDOW = 4

async function placeLocated({ located, proposals, starts, timeline, T, options, detect, signal, deadlineMs, pool, now }) {
  const targets = located.map((l) => l.headingAt)
  const indexes = new Set(targets.map((_, k) => k))
  let pauses = []
  try {
    const windowOptions = { ...options, windowSec: LOCATE_WINDOW, headingLookbackSec: 0 }
    const plan = chapterSnap.planSegments([0, ...targets].map((t, k) => (k === 0 ? 0 : t)), new Set([...indexes].map((k) => k + 1)), timeline, T, windowOptions)
    const { results } = await runPool({ segments: plan.segments, timeline, options: windowOptions, detect, signal, deadlineMs, pool, now })
    const ok = plan.segments.map((seg, k) => ({ seg, result: results[k] })).filter((x) => x.result.status === 'ok')
    pauses = chapterSnap.toBookPauses(
      ok.map(({ seg, result }) => ({ seg, pauses: chapterSnap.parseSilencedetect(result.lines, seg) })),
      timeline,
      options.minSilenceSec
    )
  } catch (error) {
    Logger.warn(`[ChapterSnap] Pause detection for located headings failed: ${error.message}`)
  }

  for (const { proposal, start, headingAt, predicted, near } of located.sort((a, b) => a.proposal.index - b.proposal.index)) {
    let target = start
    let pause = null
    if (predicted) {
      const around = pauses.filter((p) => Math.abs(p.end - headingAt) <= LOCATE_PREDICT_RANGE && !p.endClipped)
      if (!around.length) continue
      pause = around.reduce((best, p) => (p.end - p.start > best.end - best.start ? p : best))
      if (near && !(pause.start - chapterSnap.SLACK <= proposal.proposedStart && proposal.proposedStart <= pause.end + chapterSnap.SLACK)) continue
      target = Math.max(pause.start, pause.end - options.leadSec)
      if (Math.abs(target - proposal.proposedStart) < 0.05) continue
    } else {
      const candidates = pauses.filter((p) => p.end >= headingAt - LOCATE_PAUSE_BEFORE && p.end <= headingAt + LOCATE_PAUSE_AFTER && !p.endClipped)
      if (candidates.length) {
        pause = candidates[candidates.length - 1]
        target = Math.max(pause.start, pause.end - options.leadSec)
      }
    }
    const i = proposal.index
    const prev = proposals[i - 1].proposedStart
    const next = i + 1 < proposals.length ? proposals[i + 1].proposedStart : T
    if (!(target > prev + chapterSnap.MIN_GAP - 1e-9 && target < next - chapterSnap.MIN_GAP + 1e-9)) {
      Logger.debug(`[ChapterSnap] Located heading of chapter ${i} at ${headingAt} would break the order, not moved`)
      if (proposal.speech) proposal.speech = { ...proposal.speech, located: false }
      continue
    }
    proposal.proposedStart = Math.round(target * 1000) / 1000
    proposal.reason = predicted ? chapterSnap.REASONS.ALIGNED_TO_HEADINGS : chapterSnap.REASONS.HEADING_LOCATED
    proposal.pause = pause
    proposal.confidence = chapterSnap.confidenceFor(proposal)
    if (proposal.speech?.late || proposal.speech?.early) proposal.confidence = chapterSnap.lowerConfidence(proposal.confidence, 'low')
  }
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
