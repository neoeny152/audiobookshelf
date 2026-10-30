/**
 * Auto pipeline match confidence (pure, no I/O).
 *
 * Scores Audible search results against a library item so a match is applied automatically only when it is clearly the
 * same book (and the same edition). Stock BookFinder.calculateMatchConfidence leans on duration (0.7) and has no
 * narrator or series; this scorer weighs title, author, duration, narrator and series and caps the result when an
 * important component disagrees, so a high weighted sum cannot hide a wrong title, author, edition or book number
 * (the books of a series often have nearly the same title and length).
 */

const { levenshteinSimilarity } = require('../index')
const { cleanTitleForCompares, cleanAuthorForCompares } = require('../../finders/BookFinder')
const { getTotalDrift } = require('../mp3SeekIndex')

const WEIGHTS = Object.freeze({ title: 0.35, author: 0.25, duration: 0.25, narrator: 0.1, series: 0.05 })
/** Candidates scored per search (the search returns them sorted by duration difference) */
const MAX_CANDIDATES = 5
/** Candidates kept for the review UI */
const KEEP_CANDIDATES = 3
/** A second different ASIN within this many points of the best one makes the match ambiguous */
const AMBIGUOUS_POINTS = 3
const SERIES_NAME_MIN_SIMILARITY = 0.8

const CAPS = Object.freeze({
  TITLE: { below: 0.75, cap: 60, why: 'title' },
  AUTHOR: { below: 0.6, cap: 60, why: 'author' },
  EDITION: { overPct: 15, cap: 70, why: 'duration' },
  EVIDENCE: { cap: 80, why: 'evidence' },
  /** the same series with another book number: another book of the series */
  SERIES: { cap: 60, why: 'series' },
  /** a book number in the item title that the candidate does not have ("Series 02" vs book 1 of the series) */
  NUMBER: { cap: 70, why: 'number' }
})

/**
 * @typedef ScoringItem
 * @property {string} title
 * @property {string} [subtitle]
 * @property {string[]} authors
 * @property {string[]} narrators
 * @property {number|null} durationSec
 * @property {{name: string, sequence: string|null}[]} series
 */

/**
 * The fields of a library item the scorer looks at.
 *
 * @param {import('../../models/LibraryItem')} libraryItem - expanded
 * @returns {ScoringItem}
 */
function itemForScoring(libraryItem) {
  const media = libraryItem.media
  return {
    title: media.title || '',
    subtitle: media.subtitle || '',
    authors: (media.authors || []).map((a) => a.name).filter(Boolean),
    narrators: (media.narrators || []).filter(Boolean),
    durationSec: Number.isFinite(media.duration) && media.duration > 0 ? media.duration + getTotalDrift(media.includedAudioFiles).drift : null,
    series: (media.series || []).map((s) => ({ name: s.name, sequence: s.bookSeries?.sequence ?? null }))
  }
}

function splitNames(value) {
  if (Array.isArray(value)) return value.filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim())
  if (typeof value !== 'string') return []
  return value
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const SEP = String.raw`[\s,.:;_\-–—()\[\]#]*`
const NUMBER = String.raw`(?:book|bk|vol|volume|no|number)?\.?\s*#?\s*\d+(?:\.\d+)?`

/**
 * Item title variants without series and book number decorations, e.g. "Dungeon Crawler Carl 01 - Carl's Doomsday
 * Scenario" -> "Carl's Doomsday Scenario", "Black Ice (Book 3)" -> "Black Ice".
 *
 * @param {string} title
 * @param {string[]} seriesNames - the item's and the candidate's series
 * @returns {string[]} unique non-empty variants, the original first
 */
function titleVariants(title, seriesNames) {
  const variants = [title]
  const add = (v) => {
    const t = v.replace(/\s+/g, ' ').trim()
    if (t && !variants.includes(t)) variants.push(t)
  }
  const stripNumbers = (t) =>
    t
      // "Book 3", "Vol. 2", "#4", "Book Three" stay out of the comparison
      .replace(new RegExp(String.raw`[\s,(\[]*\b(?:book|bk|vol|volume)\b\.?\s*#?\s*\d+(?:\.\d+)?[)\]]?`, 'gi'), ' ')
      .replace(/[\s,(\[]*#\s*\d+(?:\.\d+)?[)\]]?/g, ' ')
      // a leading track or list index: "01 - ", "1. "
      .replace(/^\s*\d+(?:\.\d+)?\s*[-–—.:)]+\s*/, '')
      .replace(/[\s\-–—:,]+$/, '')
  add(stripNumbers(title))
  for (const name of seriesNames) {
    if (!name || name.length < 3) continue
    const n = escapeRe(name.trim())
    // series prefix: "Series 01 - Title", "Series, Book 1: Title", "Series #1 - Title"
    const prefix = new RegExp(String.raw`^\s*${n}${SEP}(?:${NUMBER})?${SEP}`, 'i')
    // series suffix: "Title (Series, Book 1)", "Title - Series 1", "Title: Series #1"
    const suffix = new RegExp(String.raw`${SEP}${n}${SEP}(?:${NUMBER})?${SEP}$`, 'i')
    for (const t of [title, stripNumbers(title)]) {
      const p = t.replace(prefix, '')
      if (p !== t) add(stripNumbers(p))
      const s = t.replace(suffix, '')
      if (s !== t) add(stripNumbers(s))
    }
  }
  return variants
}

/**
 * Title component: the best of plain clean titles and "title: subtitle" on both sides, over the item title variants.
 */
function titleScore(item, candidate) {
  if (!item.title || !candidate.title) return null
  const seriesNames = [...item.series.map((s) => s.name), ...(Array.isArray(candidate.series) ? candidate.series.map((s) => s?.series) : [])].filter((s) => typeof s === 'string')
  const candPlain = cleanTitleForCompares(candidate.title)
  const candFull = cleanTitleForCompares(candidate.subtitle ? `${candidate.title}: ${candidate.subtitle}` : candidate.title, true)
  let best = 0
  for (const variant of titleVariants(item.title, seriesNames)) {
    const plain = cleanTitleForCompares(variant)
    const full = cleanTitleForCompares(item.subtitle ? `${variant}: ${item.subtitle}` : variant, true)
    if (plain && candPlain) best = Math.max(best, levenshteinSimilarity(plain, candPlain))
    if (full && candFull) best = Math.max(best, levenshteinSimilarity(full, candFull))
    if (best === 1) break
  }
  return best
}

/**
 * For each item name, the best similarity against the candidate names; the mean.
 */
function namesScore(itemNames, candidateValue) {
  const mine = itemNames.map(cleanAuthorForCompares).filter(Boolean)
  const theirs = splitNames(candidateValue).map(cleanAuthorForCompares).filter(Boolean)
  if (!mine.length || !theirs.length) return null
  const scores = mine.map((a) => Math.max(...theirs.map((b) => levenshteinSimilarity(a, b))))
  return scores.reduce((s, v) => s + v, 0) / scores.length
}

/**
 * @returns {{score: number|null, diffPct: number|null}}
 */
function durationScore(item, candidate) {
  const candMin = typeof candidate.duration === 'number' && candidate.duration > 0 ? candidate.duration : null
  if (!item.durationSec || !candMin) return { score: null, diffPct: null }
  const itemMin = item.durationSec / 60
  const diff = Math.abs(itemMin - candMin)
  const diffPct = (diff / itemMin) * 100
  const full = Math.max(2, itemMin * 0.01)
  const zero = itemMin * 0.1
  let score
  if (diff <= full) score = 1
  else if (diff >= zero || zero <= full) score = 0
  else score = 1 - (diff - full) / (zero - full)
  return { score, diffPct }
}

function sameSequence(a, b) {
  if (a === null || a === undefined || b === null || b === undefined || a === '' || b === '') return false
  const na = Number(String(a).trim())
  const nb = Number(String(b).trim())
  if (Number.isFinite(na) && Number.isFinite(nb)) return na === nb
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase()
}

function seriesScore(item, candidate) {
  const mine = item.series.filter((s) => s.name && s.sequence !== null && s.sequence !== undefined && s.sequence !== '')
  const theirs = Array.isArray(candidate.series) ? candidate.series.filter((s) => s && typeof s.series === 'string') : []
  if (!mine.length || !theirs.length) return null
  let known = false
  for (const s of mine) {
    for (const c of theirs) {
      if (levenshteinSimilarity(s.name.toLowerCase().trim(), c.series.toLowerCase().trim()) < SERIES_NAME_MIN_SIMILARITY) continue
      if (sameSequence(s.sequence, c.sequence)) return 1
      known = true
    }
  }
  return known ? 0 : null
}

/**
 * Book numbers in a title: integers of up to 3 digits, leading zeros dropped ("02" -> 2). Longer numbers (years such
 * as 1984) are not book numbers.
 *
 * @param {string} text
 * @returns {number[]}
 */
function titleNumbers(text) {
  return (String(text || '').match(/(?<![\d.])\d{1,3}(?![\d.])/g) || []).map(Number)
}

/**
 * A number in the item title that is neither in the candidate's title or subtitle nor one of its series positions.
 * "Dungeon Crawler Carl 02" against book 1 of the series is another book, however close the titles are.
 */
function numberConflict(item, candidate) {
  const mine = titleNumbers(item.title)
  if (!mine.length) return false
  const theirs = new Set([...titleNumbers(candidate.title), ...titleNumbers(candidate.subtitle)])
  for (const s of Array.isArray(candidate.series) ? candidate.series : []) {
    const n = Number(String(s?.sequence ?? '').trim())
    if (s?.sequence !== null && s?.sequence !== undefined && String(s.sequence).trim() !== '' && Number.isFinite(n)) theirs.add(n)
  }
  return mine.some((n) => !theirs.has(n))
}

const round2 = (v) => (v === null ? null : Math.round(v * 100) / 100)

/**
 * Score one search result against the item.
 *
 * @param {ScoringItem} item
 * @param {Object} candidate - BookFinder/Audible result ({title, subtitle, author, narrator, duration (minutes), series, asin})
 * @returns {{asin: string|null, title: string, author: string|null, narrator: string|null, durationMin: number|null, confidence: number, components: Object, caps: string[], durationDiffPct: number|null}}
 */
function scoreCandidate(item, candidate) {
  const title = titleScore(item, candidate)
  const author = namesScore(item.authors, candidate.author)
  const { score: duration, diffPct } = durationScore(item, candidate)
  const narrator = namesScore(item.narrators, candidate.narrator)
  const series = seriesScore(item, candidate)
  const components = { title, author, duration, narrator, series }

  let sum = 0
  let weights = 0
  for (const [key, weight] of Object.entries(WEIGHTS)) {
    if (components[key] === null) continue
    sum += weight * components[key]
    weights += weight
  }
  let confidence = weights ? Math.round((sum / weights) * 100) : 0

  const caps = []
  const cap = (rule) => {
    caps.push(rule.why)
    confidence = Math.min(confidence, rule.cap)
  }
  if (title === null || title < CAPS.TITLE.below) cap(CAPS.TITLE)
  if (item.authors.length && author !== null && author < CAPS.AUTHOR.below) cap(CAPS.AUTHOR)
  if (diffPct !== null && diffPct > CAPS.EDITION.overPct) cap(CAPS.EDITION)
  if ((author !== null) + (duration !== null) < 2) cap(CAPS.EVIDENCE)
  if (series === 0) cap(CAPS.SERIES)
  if (numberConflict(item, candidate)) cap(CAPS.NUMBER)

  return {
    asin: typeof candidate.asin === 'string' && candidate.asin ? candidate.asin : null,
    title: candidate.title || '',
    author: typeof candidate.author === 'string' ? candidate.author : null,
    narrator: typeof candidate.narrator === 'string' ? candidate.narrator : null,
    durationMin: typeof candidate.duration === 'number' && candidate.duration > 0 ? candidate.duration : null,
    confidence,
    components: Object.fromEntries(Object.entries(components).map(([k, v]) => [k, round2(v)])),
    caps,
    durationDiffPct: diffPct === null ? null : Math.round(diffPct * 10) / 10
  }
}

/**
 * Decide on a match.
 *
 * @param {ScoringItem} item
 * @param {Object[]} candidates - search results in search order
 * @param {number} minConfidence - integer percent
 * @returns {{result: 'matched'|'needs-review', reason: string|null, confidence: number|null, asin: string|null, candidate: Object|null, candidates: Object[]}}
 *   `candidate` is the search result to apply; `candidates` the top scores for the UI
 */
function pickMatch(item, candidates, minConfidence) {
  const pool = (Array.isArray(candidates) ? candidates : []).filter((c) => c && typeof c === 'object').slice(0, MAX_CANDIDATES)
  const scored = pool.map((c, i) => ({ score: scoreCandidate(item, c), source: c, order: i })).filter((s) => s.score.asin)
  // best first; ties keep the search order (closest duration)
  scored.sort((a, b) => b.score.confidence - a.score.confidence || a.order - b.order)
  const top = scored.slice(0, KEEP_CANDIDATES).map((s) => s.score)

  if (!scored.length) return { result: 'needs-review', reason: 'no-match', confidence: null, asin: null, candidate: null, candidates: [] }
  const best = scored[0]
  if (best.score.confidence < minConfidence) {
    return { result: 'needs-review', reason: 'low-confidence', confidence: best.score.confidence, asin: best.score.asin, candidate: null, candidates: top }
  }
  const rival = scored.find((s) => s.score.asin !== best.score.asin && s.score.confidence >= minConfidence && best.score.confidence - s.score.confidence <= AMBIGUOUS_POINTS)
  if (rival) {
    return { result: 'needs-review', reason: 'ambiguous', confidence: best.score.confidence, asin: best.score.asin, candidate: null, candidates: top }
  }
  return { result: 'matched', reason: null, confidence: best.score.confidence, asin: best.score.asin, candidate: best.source, candidates: top }
}

module.exports = {
  WEIGHTS,
  CAPS,
  MAX_CANDIDATES,
  KEEP_CANDIDATES,
  AMBIGUOUS_POINTS,
  itemForScoring,
  titleVariants,
  titleNumbers,
  scoreCandidate,
  pickMatch
}
