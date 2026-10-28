/**
 * Chapter snap: pure logic (no I/O).
 *
 * Moves chapter starts onto real pauses in the audio. Ported from the chapterbot analyze.py rules:
 * - a start that is already inside a pause (within SLACK) stays where it is
 * - otherwise it moves to `leadSec` before the end of the pause that minimises
 *   |pause.end - t| - BONUS_WEIGHT * min(pause length, BONUS_CAP), among pauses that end within the window
 *   and keep the chapter between its neighbours' original starts
 *
 * The caller (chapterSnapRunner) does the silence detection and hands parsed pauses to these functions.
 */

const MAX_CHAPTERS = 1000
const MAX_TITLE_LENGTH = 1000
const SLACK = 0.3
const BONUS_WEIGHT = 4
const BONUS_CAP = 3
const FILE_START_MAX = 4
const MIN_GAP = 1.0
const JOIN_TOL = 0.1
const PAD_BEFORE = BONUS_CAP + 0.5
const PAD_AFTER = 1.0
const MERGE_GAP = 2.0
const MAX_SPAN = 600
const WHOLE_FILE_SEC = 900
const BUDGET_SEC = 14400
const LONG_PAUSE = 1.2
const SHORT_PAUSE = 0.9
const HIGH_DELTA = 5
const LOW_DELTA = 15
const CLIP_EPS = 0.02
const EPS = 1e-9

const DEFAULT_OPTIONS = Object.freeze({
  windowSec: 25,
  minSilenceSec: 0.7,
  noiseDb: -38,
  leadSec: 0.25,
  snapToFileStart: false
})

const NUMERIC_OPTION_BOUNDS = Object.freeze({
  windowSec: [2, 60],
  minSilenceSec: [0.2, 5],
  noiseDb: [-80, -20],
  leadSec: [0, 1]
})

const REASONS = Object.freeze({
  FIRST_CHAPTER: 'first-chapter',
  INSIDE_PAUSE: 'inside-pause',
  FILE_START: 'file-start',
  NEAREST_LONGEST_PAUSE: 'nearest-longest-pause',
  NO_PAUSE_IN_WINDOW: 'no-pause-in-window',
  ORDER_CONFLICT: 'order-conflict',
  NOT_REQUESTED: 'not-requested',
  NOT_ANALYSED: 'not-analysed',
  ANALYSIS_FAILED: 'analysis-failed'
})

const CONFIDENCE_RANK = Object.freeze({ none: 0, low: 1, medium: 2, high: 3 })

/**
 * Bad request input. The controller maps it to a 400 `{ error, index? }`.
 */
class SnapInputError extends Error {
  /**
   * @param {string} message
   * @param {number} [index]
   */
  constructor(message, index) {
    super(message)
    this.name = 'SnapInputError'
    if (index !== undefined) this.index = index
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function round3(value) {
  return Math.round(value * 1000) / 1000
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

/**
 * @typedef SnapOptions
 * @property {number} windowSec
 * @property {number} minSilenceSec
 * @property {number} noiseDb
 * @property {number} leadSec
 * @property {boolean} snapToFileStart
 */

/**
 * Validate and clamp the request options.
 * Finite numbers out of range are clamped silently; anything present that is not a finite number is an error.
 *
 * @param {*} raw
 * @returns {SnapOptions}
 */
function parseOptions(raw) {
  if (raw === undefined || raw === null) return { ...DEFAULT_OPTIONS }
  if (!isPlainObject(raw)) throw new SnapInputError('options must be an object')

  const options = { ...DEFAULT_OPTIONS }
  for (const [key, [min, max]] of Object.entries(NUMERIC_OPTION_BOUNDS)) {
    if (!(key in raw) || raw[key] === undefined) continue
    const value = raw[key]
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new SnapInputError(`options.${key} must be a finite number`)
    }
    options[key] = clamp(value, min, max)
  }

  if ('snapToFileStart' in raw && raw.snapToFileStart !== undefined) {
    if (typeof raw.snapToFileStart !== 'boolean') throw new SnapInputError('options.snapToFileStart must be a boolean')
    options.snapToFileStart = raw.snapToFileStart
  }

  if ('verify' in raw && raw.verify !== undefined) {
    if (typeof raw.verify !== 'boolean') throw new SnapInputError('options.verify must be a boolean')
    // Reserved for the Whisper speech check
    if (raw.verify) throw new SnapInputError('verify not implemented')
  }

  return options
}

/**
 * @typedef SnapChapterInput
 * @property {number|string} [id]
 * @property {string} [title]
 * @property {number} start
 */

/**
 * Validate the chapters to snap. Only `start` is used for the calculation; `id` and `title` are echoed back.
 * Starts must be finite, in [0, T) and strictly increasing in the order given (never reordered).
 *
 * @param {*} chapters
 * @param {number} T - total book duration in seconds
 * @returns {SnapChapterInput[]}
 */
function validateChapters(chapters, T) {
  if (!Array.isArray(chapters)) throw new SnapInputError('chapters must be an array')
  if (!chapters.length) throw new SnapInputError('No chapters to snap')
  if (chapters.length > MAX_CHAPTERS) throw new SnapInputError(`Too many chapters (max ${MAX_CHAPTERS})`)

  const result = []
  for (let i = 0; i < chapters.length; i++) {
    const chapter = chapters[i]
    if (!isPlainObject(chapter)) throw new SnapInputError('Chapter must be an object', i)

    const start = chapter.start
    if (typeof start !== 'number' || !Number.isFinite(start)) throw new SnapInputError('Chapter start must be a finite number', i)
    if (start < 0) throw new SnapInputError('Chapter start must not be negative', i)
    if (start >= T) throw new SnapInputError('Chapter start must be before the end of the book', i)
    if (i > 0 && start <= result[i - 1].start) throw new SnapInputError('Chapter starts must be strictly increasing', i)

    let title
    if (chapter.title !== undefined && chapter.title !== null) {
      if (typeof chapter.title !== 'string') throw new SnapInputError('Chapter title must be a string', i)
      if (chapter.title.length > MAX_TITLE_LENGTH) throw new SnapInputError(`Chapter title is too long (max ${MAX_TITLE_LENGTH})`, i)
      title = chapter.title
    }

    let id = i
    if (typeof chapter.id === 'number' && Number.isFinite(chapter.id)) id = chapter.id
    else if (typeof chapter.id === 'string' && chapter.id.length <= 100) id = chapter.id

    result.push({ id, title, start })
  }
  return result
}

/**
 * @param {*} indexes
 * @param {number} n - number of chapters
 * @returns {Set<number>|null} null means all chapters are requested
 */
function validateIndexes(indexes, n) {
  if (indexes === undefined || indexes === null) return null
  if (!Array.isArray(indexes)) throw new SnapInputError('indexes must be an array')
  if (indexes.length > n) throw new SnapInputError('indexes has more entries than there are chapters')
  const set = new Set()
  for (const index of indexes) {
    if (!Number.isInteger(index) || index < 0 || index >= n) throw new SnapInputError('indexes must be integers in [0, chapters.length)')
    if (set.has(index)) throw new SnapInputError('indexes must be unique')
    set.add(index)
  }
  return set
}

/**
 * @typedef TimelineTrack
 * @property {number} index - index into media.includedAudioFiles
 * @property {string} path - from the database, never from the request
 * @property {number} offset - book-timeline start of this file
 * @property {number} duration
 */

/**
 * Same offsets as Book.getTracklist: running sum of included audio file durations in array order.
 *
 * @param {Object[]} audioFiles - media.includedAudioFiles
 * @returns {TimelineTrack[]}
 */
function buildTimeline(audioFiles) {
  const timeline = []
  let offset = 0
  for (const af of (audioFiles || []).filter((af) => af && !af.exclude)) {
    const duration = Number.isFinite(af.duration) && af.duration > 0 ? af.duration : 0
    timeline.push({ index: timeline.length, path: af.metadata?.path, offset, duration })
    offset += duration
  }
  return timeline
}

/**
 * T = min(sum of track durations, media.duration)
 *
 * @param {TimelineTrack[]} timeline
 * @param {number} [mediaDuration]
 * @returns {number}
 */
function computeDuration(timeline, mediaDuration) {
  const sum = timeline.reduce((total, track) => total + track.duration, 0)
  if (Number.isFinite(mediaDuration) && mediaDuration > 0) return Math.min(sum, mediaDuration)
  return sum
}

/**
 * Index of the track that holds book time `t`
 *
 * @param {TimelineTrack[]} timeline
 * @param {number} t
 * @returns {number}
 */
function trackIndexAt(timeline, t) {
  if (!timeline.length) return 0
  for (let k = timeline.length - 1; k >= 0; k--) {
    if (timeline[k].offset <= t + EPS && timeline[k].duration > 0) return timeline[k].index
  }
  return timeline[0].index
}

/**
 * @typedef SnapSegment
 * @property {number} id
 * @property {number} trackIndex
 * @property {number} localStart - seconds into the file
 * @property {number} localDur
 * @property {boolean} wholeFile
 * @property {boolean} reachesFileEnd
 */

/**
 * Window of book time searched for chapter i
 */
function chapterWindow(t, T, options) {
  return [Math.max(0, t - options.windowSec - PAD_BEFORE), Math.min(T, t + options.windowSec + PAD_AFTER)]
}

/**
 * Plan which pieces of audio to decode.
 *
 * @param {number[]} starts
 * @param {Set<number>|null} indexes - null = all
 * @param {TimelineTrack[]} timeline
 * @param {number} T
 * @param {SnapOptions} options
 * @returns {{ segments: SnapSegment[], chapterSegments: number[][], windows: Array<number[]|null>, plannedSec: number }}
 */
function planSegments(starts, indexes, timeline, T, options) {
  const windows = starts.map((t, i) => {
    if (i === 0) return null
    if (indexes && !indexes.has(i)) return null
    return chapterWindow(t, T, options)
  })

  // Merge windows into spans
  const sorted = windows.filter(Boolean).sort((a, b) => a[0] - b[0])
  const spans = []
  for (const [a, b] of sorted) {
    const last = spans[spans.length - 1]
    if (last && a - last[1] < MERGE_GAP && Math.max(last[1], b) - last[0] <= MAX_SPAN) {
      last[1] = Math.max(last[1], b)
    } else {
      spans.push([a, b])
    }
  }

  // Split spans at track boundaries
  const piecesByTrack = new Map()
  for (const [a, b] of spans) {
    for (const track of timeline) {
      const trackEnd = track.offset + track.duration
      if (track.duration <= 0 || trackEnd <= a || track.offset >= b) continue
      const localStart = clamp(a - track.offset, 0, track.duration)
      const localEnd = clamp(b - track.offset, 0, track.duration)
      const localDur = localEnd - localStart
      if (localDur < options.minSilenceSec) continue
      if (!piecesByTrack.has(track.index)) piecesByTrack.set(track.index, [])
      piecesByTrack.get(track.index).push({ localStart, localDur })
    }
  }

  const segments = []
  const trackByIndex = new Map(timeline.map((track) => [track.index, track]))
  for (const trackIndex of [...piecesByTrack.keys()].sort((x, y) => x - y)) {
    const track = trackByIndex.get(trackIndex)
    let pieces = piecesByTrack.get(trackIndex)
    const wholeFile = track.duration <= WHOLE_FILE_SEC
    if (wholeFile) pieces = [{ localStart: 0, localDur: track.duration }]
    for (const piece of pieces.sort((x, y) => x.localStart - y.localStart)) {
      segments.push({
        id: segments.length,
        trackIndex,
        localStart: piece.localStart,
        localDur: piece.localDur,
        wholeFile,
        reachesFileEnd: piece.localStart + piece.localDur >= track.duration - CLIP_EPS
      })
    }
  }

  const plannedSec = segments.reduce((total, seg) => total + seg.localDur, 0)
  if (plannedSec > BUDGET_SEC) {
    throw new SnapInputError('Too much audio to analyse; lower windowSec or snap fewer chapters')
  }

  // Which segments cover each chapter's window
  const chapterSegments = windows.map((win) => {
    if (!win) return []
    return segments
      .filter((seg) => {
        const track = trackByIndex.get(seg.trackIndex)
        const segStart = track.offset + seg.localStart
        const segEnd = segStart + seg.localDur
        return segStart < win[1] && segEnd > win[0]
      })
      .map((seg) => seg.id)
  })

  return { segments, chapterSegments, windows, plannedSec }
}

/**
 * @typedef LocalPause
 * @property {number} start - seconds relative to the segment start (the seek point)
 * @property {number} end
 * @property {boolean} startClipped
 * @property {boolean} endClipped
 */

const SILENCE_START_RE = /silence_start:\s*(-?\d+(?:\.\d+)?(?:e[-+]?\d+)?)/i
const SILENCE_END_RE = /silence_end:\s*(-?\d+(?:\.\d+)?(?:e[-+]?\d+)?)/i

/**
 * Parse ffmpeg silencedetect stderr lines (follows analyze.detect_silences).
 *
 * @param {string[]} lines
 * @param {{localStart: number, localDur: number, reachesFileEnd: boolean}} seg
 * @returns {LocalPause[]}
 */
function parseSilencedetect(lines, seg) {
  const pauses = []
  let pending = null
  for (const line of lines || []) {
    if (typeof line !== 'string') continue
    const startMatch = line.match(SILENCE_START_RE)
    if (startMatch) {
      const x = Number(startMatch[1])
      if (!Number.isFinite(x)) continue
      pending = { start: Math.max(0, x), startClipped: x <= CLIP_EPS && seg.localStart > 0 }
      continue
    }
    const endMatch = line.match(SILENCE_END_RE)
    if (endMatch && pending) {
      const y = Number(endMatch[1])
      if (Number.isFinite(y) && y > pending.start) {
        // A pause that runs up to the end of a segment that stops before the file does was cut by the segment
        const endClipped = !seg.reachesFileEnd && y >= seg.localDur - CLIP_EPS
        pauses.push({ start: pending.start, end: y, startClipped: pending.startClipped, endClipped })
      }
      pending = null
    }
  }
  if (pending && seg.localDur > pending.start) {
    pauses.push({ start: pending.start, end: seg.localDur, startClipped: pending.startClipped, endClipped: !seg.reachesFileEnd })
  }
  return pauses
}

/**
 * @typedef BookPause
 * @property {number} start - book timeline seconds
 * @property {number} end
 * @property {boolean} startClipped
 * @property {boolean} endClipped
 * @property {boolean} crossesFileBoundary
 */

/**
 * Map local pauses to the book timeline, sort, and merge pauses that touch (padded overlaps, silence across a file joint).
 *
 * @param {{seg: SnapSegment, pauses: LocalPause[]}[]} results
 * @param {TimelineTrack[]} timeline
 * @returns {BookPause[]}
 */
function toBookPauses(results, timeline) {
  const trackByIndex = new Map(timeline.map((track) => [track.index, track]))
  const all = []
  for (const { seg, pauses } of results) {
    const track = trackByIndex.get(seg.trackIndex)
    if (!track) continue
    const base = track.offset + seg.localStart
    for (const p of pauses) {
      all.push({ start: base + p.start, end: base + p.end, startClipped: !!p.startClipped, endClipped: !!p.endClipped })
    }
  }
  all.sort((a, b) => a.start - b.start || a.end - b.end)

  const merged = []
  for (const p of all) {
    const last = merged[merged.length - 1]
    if (last && p.start - last.end <= JOIN_TOL) {
      if (p.start === last.start) last.startClipped = last.startClipped && p.startClipped
      if (p.end > last.end) {
        last.end = p.end
        last.endClipped = p.endClipped
      } else if (p.end === last.end) {
        last.endClipped = last.endClipped && p.endClipped
      }
    } else {
      merged.push({ ...p })
    }
  }

  const boundaries = timeline.filter((track) => track.offset > 0).map((track) => track.offset)
  const lastTrack = timeline[timeline.length - 1]
  const bookEnd = lastTrack ? lastTrack.offset + lastTrack.duration : 0
  for (const p of merged) {
    p.crossesFileBoundary = boundaries.some((b) => p.start < b && p.end > b)
    // An edge at a true file start or the end of the last file is a real edge, not a clip
    if (p.start <= CLIP_EPS || boundaries.some((b) => Math.abs(p.start - b) <= CLIP_EPS)) p.startClipped = false
    if (p.end >= bookEnd - CLIP_EPS) p.endClipped = false
  }
  return merged
}

/**
 * Bounds for chapter i from its neighbours' ORIGINAL starts.
 * Normally [t[i-1] + MIN_GAP, t[i+1] - MIN_GAP]; a side where the original gap is < 2*MIN_GAP uses the open bound instead.
 *
 * @param {number[]} starts
 * @param {number} i
 * @param {number} T
 * @returns {{lo: number, loOpen: boolean, hi: number, hiOpen: boolean}}
 */
function boundsFor(starts, i, T) {
  const t = starts[i]
  const prev = i > 0 ? starts[i - 1] : 0
  const next = i + 1 < starts.length ? starts[i + 1] : T
  const loOpen = i > 0 && t - prev < 2 * MIN_GAP
  const hiOpen = next - t < 2 * MIN_GAP
  return {
    lo: i === 0 ? 0 : loOpen ? prev : prev + MIN_GAP,
    loOpen,
    hi: hiOpen ? next : next - MIN_GAP,
    hiOpen
  }
}

function inBounds(x, bounds) {
  const aboveLo = bounds.loOpen ? x > bounds.lo : x >= bounds.lo - EPS
  const belowHi = bounds.hiOpen ? x < bounds.hi : x <= bounds.hi + EPS
  return aboveLo && belowHi
}

function pauseScore(p, t) {
  return Math.abs(p.end - t) - BONUS_WEIGHT * Math.min(p.end - p.start, BONUS_CAP)
}

function pauseTarget(p, leadSec) {
  return Math.max(0, Math.max(p.start, p.end - leadSec))
}

/**
 * @typedef SnapProposal
 * @property {number} index
 * @property {number} originalStart
 * @property {number} proposedStart
 * @property {string} reason
 * @property {BookPause|null} pause
 * @property {{pause: BookPause, target: number, score: number}[]} alternatives - internal, not returned
 * @property {{lo: number, loOpen: boolean, hi: number, hiOpen: boolean}} bounds
 */

/**
 * Snap one chapter start.
 *
 * @param {Object} params
 * @param {number} params.index
 * @param {number} params.t - original start
 * @param {BookPause[]} params.pauses - sorted
 * @param {TimelineTrack[]} params.timeline
 * @param {SnapOptions} params.options
 * @param {{lo: number, loOpen: boolean, hi: number, hiOpen: boolean}} params.bounds
 * @param {string} [params.skipReason] - not-requested | not-analysed | analysis-failed
 * @returns {SnapProposal}
 */
function snapOne({ index, t, pauses, timeline, options, bounds, skipReason = null }) {
  const proposal = { index, originalStart: t, proposedStart: t, reason: REASONS.NO_PAUSE_IN_WINDOW, pause: null, alternatives: [], bounds }

  // a. first chapter always starts at 0
  if (index === 0) {
    proposal.proposedStart = 0
    proposal.reason = REASONS.FIRST_CHAPTER
    return proposal
  }

  // b. not requested / not analysed
  if (skipReason) {
    proposal.reason = skipReason
    return proposal
  }

  // c. already inside a pause
  const inside = pauses.find((p) => p.start - SLACK <= t + EPS && t <= p.end + SLACK + EPS)
  if (inside) {
    proposal.reason = REASONS.INSIDE_PAUSE
    proposal.pause = inside
    return proposal
  }

  // d. multi-file books are often split at chapters: a file that begins up to 4 s before the start opens with the heading
  if (options.snapToFileStart) {
    const edges = timeline.filter((track) => track.index > 0 && track.offset > 0 && t - track.offset > 0 && t - track.offset <= FILE_START_MAX + EPS && inBounds(track.offset, bounds))
    if (edges.length) {
      proposal.proposedStart = edges[edges.length - 1].offset
      proposal.reason = REASONS.FILE_START
      return proposal
    }
  }

  // e. nearest, longest pause
  const candidates = []
  for (const p of pauses) {
    if (Math.abs(p.end - t) > options.windowSec + EPS) continue
    const target = pauseTarget(p, options.leadSec)
    if (!inBounds(target, bounds)) continue
    candidates.push({ pause: p, target, score: pauseScore(p, t) })
  }
  if (candidates.length) {
    // stable sort keeps the earlier pause first on an exact tie, like Python's min over a sorted list
    candidates.sort((a, b) => a.score - b.score)
    const [best, ...alternatives] = candidates
    proposal.proposedStart = best.target
    proposal.reason = REASONS.NEAREST_LONGEST_PAUSE
    proposal.pause = best.pause
    proposal.alternatives = alternatives
    return proposal
  }

  // f. nothing found
  return proposal
}

/**
 * Minimum gap rule between chapter i-1 and i, from the original gap
 */
function orderOk(x, prevFinal, starts, i) {
  const originalGap = starts[i] - starts[i - 1]
  if (originalGap < 2 * MIN_GAP) return x > prevFinal
  return x >= prevFinal + MIN_GAP - EPS
}

/**
 * Forward order pass. A conflicting chapter tries its alternatives, else reverts to its original start (always valid,
 * because every moved previous start is bounded by this chapter's original start).
 * Then rounds to 3 decimals and asserts strictly increasing starts.
 *
 * @param {number[]} starts
 * @param {SnapProposal[]} proposals - mutated
 * @returns {{ proposals: SnapProposal[], fallback: boolean }}
 */
function resolveOrder(starts, proposals) {
  for (let i = 1; i < proposals.length; i++) {
    const proposal = proposals[i]
    const prevFinal = proposals[i - 1].proposedStart
    if (orderOk(proposal.proposedStart, prevFinal, starts, i)) continue

    const alt = proposal.alternatives.find((a) => orderOk(a.target, prevFinal, starts, i))
    if (alt) {
      proposal.proposedStart = alt.target
      proposal.pause = alt.pause
      proposal.alternatives = proposal.alternatives.filter((a) => a !== alt)
    } else {
      proposal.proposedStart = starts[i]
      proposal.reason = REASONS.ORDER_CONFLICT
    }
  }

  // Rounding pass + assertion: any pair no longer strictly increasing reverts to the original
  const isMoved = (proposal) => proposal.reason === REASONS.NEAREST_LONGEST_PAUSE || proposal.reason === REASONS.FILE_START
  for (const proposal of proposals) proposal.proposedStart = round3(proposal.proposedStart)
  const revert = (j) => {
    if (proposals[j].proposedStart === round3(starts[j])) return
    proposals[j].proposedStart = round3(starts[j])
    if (isMoved(proposals[j])) proposals[j].reason = REASONS.ORDER_CONFLICT
  }
  for (let i = 1; i < proposals.length; i++) {
    // Walk back while a pair collides after rounding (only possible next to an open bound)
    for (let j = i; j > 0 && proposals[j].proposedStart <= proposals[j - 1].proposedStart; j--) {
      revert(j)
      if (proposals[j].proposedStart <= proposals[j - 1].proposedStart && j - 1 > 0) revert(j - 1)
    }
  }

  let fallback = false
  for (let i = 1; i < proposals.length; i++) {
    if (proposals[i].proposedStart <= proposals[i - 1].proposedStart) fallback = true
  }
  if (fallback) {
    // Should never happen (the caller logs it as a bug). Give back the unrounded originals.
    for (let i = 1; i < proposals.length; i++) {
      proposals[i].proposedStart = starts[i]
      if (isMoved(proposals[i])) proposals[i].reason = REASONS.ORDER_CONFLICT
    }
  }
  return { proposals, fallback }
}

/**
 * @param {SnapProposal} proposal - after the order pass
 * @returns {'high'|'medium'|'low'|'none'}
 */
function confidenceFor(proposal) {
  const { reason, pause } = proposal
  if (reason === REASONS.FIRST_CHAPTER || reason === REASONS.FILE_START) return 'high'
  if (!pause || (reason !== REASONS.INSIDE_PAUSE && reason !== REASONS.NEAREST_LONGEST_PAUSE)) return 'none'

  const duration = pause.end - pause.start
  const absDelta = Math.abs(proposal.proposedStart - proposal.originalStart)

  if (reason === REASONS.INSIDE_PAUSE) {
    if (duration >= LONG_PAUSE - EPS) return 'high'
    if (duration < SHORT_PAUSE) return 'low'
    return 'medium'
  }

  // nearest-longest-pause: the end edge places the start; a clipped start edge only matters while the length bonus is not capped
  const clippedForScoring = pause.endClipped || (pause.startClipped && duration < BONUS_CAP)
  if (duration < SHORT_PAUSE || absDelta > LOW_DELTA + EPS || clippedForScoring) return 'low'
  if (duration >= LONG_PAUSE - EPS && absDelta <= HIGH_DELTA + EPS) return 'high'
  return 'medium'
}

/**
 * Lower a confidence, never raise it
 */
function lowerConfidence(current, requested) {
  if (!(requested in CONFIDENCE_RANK)) return current
  return CONFIDENCE_RANK[requested] < CONFIDENCE_RANK[current] ? requested : current
}

function pauseForApi(pause) {
  if (!pause) return null
  return {
    start: round3(pause.start),
    end: round3(pause.end),
    duration: round3(pause.end - pause.start),
    startClipped: !!pause.startClipped,
    endClipped: !!pause.endClipped,
    crossesFileBoundary: !!pause.crossesFileBoundary
  }
}

function resolveTitle(inputTitle, itemChapters, i) {
  if (typeof inputTitle === 'string' && inputTitle) return inputTitle
  const itemTitle = itemChapters?.[i]?.title
  if (typeof itemTitle === 'string' && itemTitle) return itemTitle
  return `Chapter ${i + 1}`
}

const SKIP_REASONS = new Set([REASONS.NOT_REQUESTED, REASONS.NOT_ANALYSED, REASONS.ANALYSIS_FAILED])

/**
 * Build the API response.
 *
 * @param {Object} params
 * @param {string} params.libraryItemId
 * @param {number} params.T
 * @param {SnapOptions} params.options
 * @param {SnapChapterInput[]} params.chapters
 * @param {Object[]} [params.itemChapters] - media.chapters, for title fallback
 * @param {(SnapProposal & {confidence: string, speech: *})[]} params.proposals
 * @param {TimelineTrack[]} params.timeline
 * @param {boolean} params.complete
 * @param {Object} params.stats
 * @param {string[]} params.warnings
 */
function buildResponse({ libraryItemId, T, options, chapters, itemChapters, proposals, timeline, complete, stats, warnings }) {
  const duration = round3(T)
  const chapterEntries = proposals.map((proposal, i) => {
    const delta = round3(proposal.proposedStart - proposal.originalStart)
    return {
      index: i,
      id: chapters[i].id,
      title: resolveTitle(chapters[i].title, itemChapters, i),
      originalStart: round3(proposal.originalStart),
      proposedStart: round3(proposal.proposedStart),
      delta,
      changed: delta !== 0,
      pause: pauseForApi(proposal.pause),
      reason: proposal.reason,
      confidence: proposal.confidence || 'none',
      trackIndex: trackIndexAt(timeline, proposal.proposedStart),
      speech: proposal.speech === undefined ? null : proposal.speech
    }
  })

  const proposedChapters = chapterEntries.map((entry, i) => ({
    id: entry.id,
    title: entry.title,
    start: entry.proposedStart,
    end: i + 1 < chapterEntries.length ? chapterEntries[i + 1].proposedStart : duration
  }))

  const moved = chapterEntries.filter((c) => c.changed).length
  const skipped = chapterEntries.filter((c) => !c.changed && SKIP_REASONS.has(c.reason)).length

  return {
    libraryItemId,
    duration,
    complete,
    options: {
      windowSec: options.windowSec,
      minSilenceSec: options.minSilenceSec,
      noiseDb: options.noiseDb,
      leadSec: options.leadSec,
      snapToFileStart: options.snapToFileStart
    },
    stats: {
      ...stats,
      analysedSec: round3(stats.analysedSec || 0),
      moved,
      unchanged: chapterEntries.length - moved - skipped,
      skipped
    },
    chapters: chapterEntries,
    proposedChapters,
    warnings
  }
}

module.exports = {
  MAX_CHAPTERS,
  MAX_TITLE_LENGTH,
  SLACK,
  BONUS_WEIGHT,
  BONUS_CAP,
  FILE_START_MAX,
  MIN_GAP,
  JOIN_TOL,
  PAD_BEFORE,
  PAD_AFTER,
  MERGE_GAP,
  MAX_SPAN,
  WHOLE_FILE_SEC,
  BUDGET_SEC,
  LONG_PAUSE,
  DEFAULT_OPTIONS,
  NUMERIC_OPTION_BOUNDS,
  REASONS,
  CONFIDENCE_RANK,
  SnapInputError,
  round3,
  parseOptions,
  validateChapters,
  validateIndexes,
  buildTimeline,
  computeDuration,
  trackIndexAt,
  chapterWindow,
  planSegments,
  parseSilencedetect,
  toBookPauses,
  boundsFor,
  inBounds,
  pauseScore,
  pauseTarget,
  snapOne,
  orderOk,
  resolveOrder,
  confidenceFor,
  lowerConfidence,
  buildResponse
}
