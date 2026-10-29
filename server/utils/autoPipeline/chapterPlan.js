/**
 * Auto pipeline chapter planning (pure, no I/O): where the chapters come from, whether they may be replaced, and
 * whether a snapped and speech-checked proposal is good enough to apply without a person looking at it.
 */

const crypto = require('crypto')

/** Starts closer than this compare equal (Audible ms rounding, float noise) */
const EQUAL_TOL_SEC = 0.001
/** Audible runtime vs the audio: aligned within max(ALIGNED_SEC, ALIGNED_FRACTION * T) */
const ALIGNED_SEC = 3
const ALIGNED_FRACTION = 0.0005
/** ...near within NEAR_SEC (usable for a proposal, never applied without review); mismatch beyond */
const NEAR_SEC = 30
/** clearly bad user chapters */
const ONE_CHAPTER_MAX_SEC = 30 * 60
const MAX_AVG_CHAPTER_SEC = 2 * 3600

/**
 * @typedef PlainChapter
 * @property {string} title
 * @property {number} start
 * @property {number} end
 */

function round3(v) {
  return Math.round(v * 1000) / 1000
}

/**
 * Hash of a chapter list (title and millisecond start/end), to recognise chapters the pipeline applied.
 *
 * @param {PlainChapter[]} chapters
 * @returns {string}
 */
function chaptersHash(chapters) {
  const rows = (chapters || []).map((c) => [String(c.title ?? ''), Math.round(Number(c.start) * 1000), Math.round(Number(c.end) * 1000)])
  return crypto.createHash('sha1').update(JSON.stringify(rows)).digest('hex')
}

/**
 * Same titles and starts/ends within tolSec.
 *
 * @param {PlainChapter[]} a
 * @param {PlainChapter[]} b
 * @param {number} [tolSec]
 * @param {{ignoreTitles?: boolean, ignoreEnds?: boolean}} [opts]
 */
function chaptersEqual(a, b, tolSec = EQUAL_TOL_SEC, opts = {}) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
  return a.every((c, i) => {
    const d = b[i]
    if (!opts.ignoreTitles && String(c.title ?? '') !== String(d.title ?? '')) return false
    if (Math.abs(Number(c.start) - Number(d.start)) > tolSec + 1e-9) return false
    if (!opts.ignoreEnds && Math.abs(Number(c.end) - Number(d.end)) > tolSec + 1e-9) return false
    return true
  })
}

/**
 * Who made the current chapters.
 * - none: no chapters
 * - scanner: what the scanner builds from the audio files (embedded chapters, or one per file)
 * - pipeline: what the pipeline applied (appliedHash)
 * - user: anything else (edited by hand or by a client)
 *
 * @param {PlainChapter[]} current
 * @param {PlainChapter[]} scannerChapters - AudioFileScanner.getBookChaptersFromAudioFiles for the included files
 * @param {string|null} [appliedHash]
 * @returns {'none'|'scanner'|'pipeline'|'user'}
 */
function classifyChapters(current, scannerChapters, appliedHash = null) {
  if (!Array.isArray(current) || !current.length) return 'none'
  if (appliedHash && chaptersHash(current) === appliedHash) return 'pipeline'
  if (Array.isArray(scannerChapters) && scannerChapters.length && chaptersEqual(current, scannerChapters)) return 'scanner'
  return 'user'
}

/**
 * Whether chapters are clearly broken, so even chapters a person made may be replaced (through review).
 *
 * @param {PlainChapter[]} chapters
 * @param {number} duration - book duration in seconds
 * @returns {string|null} why, or null when they look sane
 */
function clearlyBad(chapters, duration) {
  if (!Array.isArray(chapters) || !chapters.length) return 'no-chapters'
  if (chapters.length === 1 && duration > ONE_CHAPTER_MAX_SEC) return 'one-chapter'
  for (let i = 0; i < chapters.length; i++) {
    const c = chapters[i]
    if (!Number.isFinite(c.start) || !Number.isFinite(c.end)) return 'not-a-number'
    if (c.start < 0 || c.end > duration + 1 || c.start > duration) return 'outside-book'
    if (c.end < c.start) return 'negative-length'
    if (i > 0) {
      if (c.start <= chapters[i - 1].start) return 'not-increasing'
      if (c.start < chapters[i - 1].end - 1) return 'overlapping'
    }
  }
  if (duration / chapters.length > MAX_AVG_CHAPTER_SEC) return 'chapters-too-long'
  return null
}

/**
 * Server port of the client's removeBrandingFromAudibleData (src/lib/chapters/chapterEditorUtils.ts): drop Audible's
 * brand intro ("This is Audible") and outro from the chapter times and the runtime.
 *
 * @param {Object} data - audnexus chapters response
 * @returns {Object} a copy
 */
function removeBranding(data) {
  if (!data || !Array.isArray(data.chapters)) return data
  const introDuration = Number(data.brandIntroDurationMs) || 0
  const outroDuration = Number(data.brandOutroDurationMs) || 0
  const chapters = data.chapters.map((chapter, i) => {
    const next = { ...chapter }
    if (next.startOffsetMs < introDuration) {
      // intro overlap on the first chapter(s): whole-second placeholders, as the clients do
      next.startOffsetMs = i * 1000
      next.startOffsetSec = i
    } else {
      next.startOffsetMs -= introDuration
      next.startOffsetSec = Math.floor(next.startOffsetMs / 1000)
      next.startOffsetMs = next.startOffsetSec * 1000
    }
    return next
  })
  const last = chapters[chapters.length - 1]
  const trimmed = last && last.lengthMs <= outroDuration ? chapters.slice(0, -1) : chapters
  return {
    ...data,
    chapters: trimmed,
    runtimeLengthMs: data.runtimeLengthMs - introDuration - outroDuration,
    runtimeLengthSec: Math.floor((data.runtimeLengthMs - introDuration - outroDuration) / 1000)
  }
}

/**
 * Audible chapters as a book chapter list over [0, T): starts in seconds, strictly increasing, ends at the next start.
 *
 * @param {Object} data - audnexus chapters response (raw or debranded)
 * @param {number} T
 * @returns {PlainChapter[]}
 */
function audibleToChapters(data, T) {
  const out = []
  for (const c of data?.chapters || []) {
    const start = round3(Number(c.startOffsetMs) / 1000)
    if (!Number.isFinite(start) || start < 0 || start >= T) continue
    if (out.length && start <= out[out.length - 1].start) continue
    out.push({ title: typeof c.title === 'string' && c.title.trim() ? c.title.trim() : `Chapter ${out.length + 1}`, start, end: 0 })
  }
  // a first start in the first second is the start of the book
  if (out.length && out[0].start < 1) out[0].start = 0
  out.forEach((c, i) => (c.end = i + 1 < out.length ? out[i + 1].start : round3(T)))
  return out
}

/**
 * Choose the Audible variant (raw or debranded) whose runtime is closest to the audio, and classify it.
 *
 * @param {Object|null} data - audnexus chapters response
 * @param {number} T - audio duration in seconds
 * @returns {{result: 'aligned'|'near'|'mismatch'|'none', variant: string|null, diffSec: number|null, runtimeSec: number|null, isAccurate: boolean|null, chapters: PlainChapter[]}}
 */
function pickAudibleSource(data, T) {
  const none = { result: 'none', variant: null, diffSec: null, runtimeSec: null, isAccurate: null, chapters: [] }
  if (!data || !Array.isArray(data.chapters) || !data.chapters.length || !Number.isFinite(Number(data.runtimeLengthMs))) return none
  const variants = [{ variant: 'raw', data }]
  if ((Number(data.brandIntroDurationMs) || 0) > 0 || (Number(data.brandOutroDurationMs) || 0) > 0) variants.push({ variant: 'debranded', data: removeBranding(data) })
  let best = null
  for (const v of variants) {
    const runtimeSec = Number(v.data.runtimeLengthMs) / 1000
    const diffSec = Math.abs(T - runtimeSec)
    if (!best || diffSec < best.diffSec) best = { ...v, runtimeSec, diffSec }
  }
  const isAccurate = typeof data.isAccurate === 'boolean' ? data.isAccurate : null
  const chapters = audibleToChapters(best.data, T)
  const tol = Math.max(ALIGNED_SEC, ALIGNED_FRACTION * T)
  let result
  if (best.diffSec <= tol && isAccurate !== false) result = 'aligned'
  else if (best.diffSec <= NEAR_SEC) result = 'near'
  else result = 'mismatch'
  if (chapters.length < 1) result = 'mismatch'
  return { result, variant: best.variant, diffSec: round3(best.diffSec), runtimeSec: round3(best.runtimeSec), isAccurate, chapters }
}

/**
 * Audio fingerprint: the sorted ino, size and duration of the included audio files. Changes when a file is added,
 * removed or still being copied.
 *
 * @param {Object[]} audioFiles - media.includedAudioFiles
 * @returns {string}
 */
function audioFingerprint(audioFiles) {
  const rows = (audioFiles || [])
    .filter((af) => af && !af.exclude)
    .map((af) => `${af.ino}:${af.metadata?.size ?? ''}:${Number.isFinite(af.duration) ? af.duration.toFixed(3) : ''}`)
    .sort()
  return crypto.createHash('sha1').update(rows.join('|')).digest('hex')
}

/**
 * Strict v1 auto-apply policy over a (complete, speech-checked) snap response.
 *
 * Apply only if the source is aligned Audible chapters or a check of scanner chapters, the snap is complete without
 * not-analysed or failed segments, and every chapter after the first is high confidence with a speech check that is
 * neither LATE nor EARLY and heard its heading (or does not expect one). A spoken heading heard where the title's was
 * not ("Chapter 5" at the start of "Chapter 4") is evidence of a wrong start.
 *
 * @param {Object} params
 * @param {string} params.source - 'aligned' | 'near' | 'scanner'
 * @param {Object} params.snap - merged snap response (chapters with confidence, reason, speech)
 * @param {string[]} [params.extra] - more global blockers (e.g. 'user-edited')
 * @returns {{apply: boolean, blockers: string[], failing: {index: number, why: string[]}[]}}
 */
function evaluatePolicy({ source, snap, extra = [] }) {
  const blockers = [...extra]
  if (source !== 'aligned' && source !== 'scanner') blockers.push(`source-${source}`)
  if (!snap || !Array.isArray(snap.chapters)) return { apply: false, blockers: [...blockers, 'no-snap'], failing: [] }
  if (!snap.complete) blockers.push('snap-incomplete')
  if ((snap.stats?.failedSegments || 0) > 0) blockers.push('analysis-failed')

  const failing = []
  for (const c of snap.chapters) {
    const why = []
    if (c.reason === 'not-analysed') why.push('not-analysed')
    if (c.reason === 'analysis-failed') why.push('analysis-failed')
    if (c.index > 0) {
      if (c.confidence !== 'high') why.push(`confidence-${c.confidence || 'none'}`)
      const s = c.speech
      if (!s) why.push('no-speech-check')
      else {
        if (s.late) why.push('late')
        if (s.early) why.push('early')
        if (!(s.heading === true || s.expected === false)) why.push('heading-not-heard')
      }
    }
    if (c.speech && c.speech.heard && c.speech.heading === false) why.push('heard-other-heading')
    if (why.length) failing.push({ index: c.index, why })
  }
  return { apply: !blockers.length && !failing.length, blockers, failing }
}

/**
 * Short text for a needs-review result, e.g. "3 LATE, 1 EARLY, 2 low confidence".
 *
 * @param {{blockers: string[], failing: {why: string[]}[]}} evaluation
 * @returns {string}
 */
function summarizeFailing({ blockers = [], failing = [] }) {
  const counts = new Map()
  const label = {
    late: 'LATE',
    early: 'EARLY',
    'heading-not-heard': 'heading not heard',
    'heard-other-heading': 'other heading heard',
    'no-speech-check': 'not speech checked',
    'not-analysed': 'not analysed',
    'analysis-failed': 'analysis failed'
  }
  for (const f of failing) {
    for (const why of f.why) {
      const key = why.startsWith('confidence-') ? `${why.slice(11)} confidence` : label[why] || why
      counts.set(key, (counts.get(key) || 0) + 1)
    }
  }
  const parts = [...blockers, ...[...counts.entries()].map(([k, n]) => `${n} ${k}`)]
  return parts.join(', ')
}

module.exports = {
  EQUAL_TOL_SEC,
  ALIGNED_SEC,
  ALIGNED_FRACTION,
  NEAR_SEC,
  chaptersHash,
  chaptersEqual,
  classifyChapters,
  clearlyBad,
  removeBranding,
  audibleToChapters,
  pickAudibleSource,
  audioFingerprint,
  evaluatePolicy,
  summarizeFailing
}
