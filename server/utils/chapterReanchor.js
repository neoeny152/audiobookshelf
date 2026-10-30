/**
 * Re-anchor a reference chapter list (e.g. Audible's) to the audio before snapping: pure logic, no I/O.
 *
 * Reference times often drift against the files: Audible's own encode runs a little longer or shorter, and its brand
 * intro and outro may be missing. Over a long book that adds up to minutes, far outside snap's search window. Books
 * that are split into part files give exact anchors: a file named like a reference chapter ("Part II Reborn.mp3" for
 * the chapter "Part II") starts exactly where that chapter starts. The reference times are mapped piecewise linearly
 * between those anchors (and the book start), and past the last anchor with the average rate of the anchored spans.
 *
 * An anchor needs the chapter title's words in the file name, in order, and the reference start within
 * ANCHOR_TOLERANCE of the file start, so a book split at arbitrary points (no titles in the file names) is left alone.
 */

const { tokens } = require('./chapterbotSpeech')

/** Reference start to file start: at most this many seconds apart... */
const ANCHOR_MIN_TOLERANCE = 60
/** ...or this fraction of the position (drift grows with time) */
const ANCHOR_TOLERANCE = 0.03
/** Rate past the last anchor comes from anchored spans at least this long */
const RATE_MIN_SPAN = 600
/** A rate outside this range is not drift: fall back to 1 */
const RATE_RANGE = [0.95, 1.05]
const STOP = new Set(['the', 'a', 'an', 'of', 'and'])

function basename(path) {
  const name = String(path || '')
    .split(/[\\/]/)
    .pop()
  return name.replace(/\.[^.]+$/, '')
}

function keyTokens(s) {
  return tokens(s).filter((t) => !STOP.has(t))
}

/** Whether `needle` occurs in `hay` as consecutive tokens */
function containsSeq(hay, needle) {
  if (!needle.length || needle.length > hay.length) return false
  for (let i = 0; i + needle.length <= hay.length; i++) {
    if (needle.every((t, k) => hay[i + k] === t)) return true
  }
  return false
}

/**
 * A title that can name a file on its own: two or more key words ("Part II", "Book One"), or one word of at least 4
 * letters that is not a number ("Prologue"). A lone "1" or "I" could be anything.
 */
function namesAFile(titleTokens) {
  if (titleTokens.length >= 2) return true
  return titleTokens.length === 1 && titleTokens[0].length >= 4 && !/^\d+$/.test(titleTokens[0])
}

/**
 * @param {{start: number, title?: string}[]} chapters - validated, strictly increasing
 * @param {{index: number, path: string, offset: number, duration: number}[]} timeline
 * @param {number} T
 * @returns {{starts: number[], anchors: {index: number, trackIndex: number, from: number, to: number}[], rate: number}|null}
 *   null when there is nothing to anchor on, or the mapped list would not fit the book
 */
function reanchorStarts(chapters, timeline, T) {
  const tracks = timeline.filter((t) => t.duration > 0 && t.offset > 0)
  if (!tracks.length || chapters.length < 2) return null

  const titleTokens = chapters.map((c) => keyTokens(c.title || ''))
  const anchors = []
  let minChapter = 1
  for (const track of tracks) {
    const fileTokens = keyTokens(basename(track.path))
    const tolerance = Math.max(ANCHOR_MIN_TOLERANCE, ANCHOR_TOLERANCE * track.offset)
    let best = null
    for (let i = minChapter; i < chapters.length; i++) {
      const d = Math.abs(chapters[i].start - track.offset)
      if (d > tolerance) continue
      if (!namesAFile(titleTokens[i]) || !containsSeq(fileTokens, titleTokens[i])) continue
      if (!best || d < best.d) best = { i, d }
    }
    if (!best) continue
    anchors.push({ index: best.i, trackIndex: track.index, from: chapters[best.i].start, to: track.offset })
    minChapter = best.i + 1
  }
  if (!anchors.length) return null

  // knots: book start, then each anchor
  const knots = [{ from: 0, to: 0 }, ...anchors.map((a) => ({ from: a.from, to: a.to }))]
  const rates = []
  for (let k = 1; k < knots.length; k++) {
    const spanFrom = knots[k].from - knots[k - 1].from
    if (spanFrom >= RATE_MIN_SPAN) rates.push((knots[k].to - knots[k - 1].to) / spanFrom)
  }
  let rate = rates.length ? rates.reduce((s, r) => s + r, 0) / rates.length : 1
  if (!(rate >= RATE_RANGE[0] && rate <= RATE_RANGE[1])) rate = 1

  const map = (s) => {
    for (let k = 1; k < knots.length; k++) {
      if (s <= knots[k].from) {
        const a = knots[k - 1]
        const b = knots[k]
        return a.to + ((s - a.from) * (b.to - a.to)) / (b.from - a.from)
      }
    }
    const last = knots[knots.length - 1]
    return last.to + (s - last.from) * rate
  }

  const starts = chapters.map((c, i) => (i === 0 ? c.start : Math.round(map(c.start) * 1000) / 1000))
  for (let i = 1; i < starts.length; i++) {
    if (!(starts[i] > starts[i - 1]) || starts[i] >= T) return null
  }
  return { starts, anchors, rate }
}

module.exports = { ANCHOR_MIN_TOLERANCE, ANCHOR_TOLERANCE, reanchorStarts }
