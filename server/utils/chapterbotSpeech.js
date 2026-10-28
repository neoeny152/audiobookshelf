/**
 * Chapter snap speech check (options.verify = true): what Whisper hears around each proposed start.
 *
 * Fills each snap chapter's `speech` with {before, after, heading, late, early, heard}, using the rules of the
 * unraid/scripts verify-report.ps1 (with the Tokens normaliser from build-chapters.ps1):
 * - LATE: the chapter's heading words are heard at the end of the before-clip (last 8 words) and the after-clip
 *   does not start with them (first 3 words)
 * - EARLY: the heading is in the after-clip (first 25 words) but more than 5 words in
 * - heading: the heading words are in the after-clip at most 5 words in, as whole words with the title's stop words
 *   ignored (the start looks right); not EARLY
 * - heard (not in the script, additive): a spoken heading such as "Chapter 3", "Part 2" or "Prologue" starting within
 *   the first 5 words of the after-clip, normalised (number words and roman numerals become digits), whatever the
 *   title is; null when none is heard, and null when the start is LATE or EARLY (the clip may hold the neighbouring
 *   chapter). Clients may offer it as the chapter title.
 * LATE and EARLY only apply to titles that start with chapter/prologue/epilogue/interlude/part, as in the script.
 *
 * Speech never moves a start (that is the snap rule's job). It may only lower confidence: LATE or EARLY -> low.
 */

const chapterbotClient = require('./chapterbotClient')
const Logger = require('../Logger')

/** Starts per /v1/verify request (the sidecar allows 100; smaller batches keep each request short) */
const BATCH_SIZE = 5
/** Starts checked per snap request; the rest get speech: null and a warning */
const MAX_VERIFY_STARTS = 15
/**
 * Budget for the whole snap request (silence snap + speech check), counted from createVerifier(), which the
 * controller calls just before the snap runs. The request is synchronous, so it has to fit under a reverse proxy's
 * default 60 s read timeout (nginx), like chapterSnapRunner's DEADLINE_MS.
 */
const VERIFY_DEADLINE_MS = 55000
/** Rough sidecar cost, used to size each batch to the time left (3 starts took 8 s on real audio) */
const EST_MS_PER_START = 3000
const EST_MS_PER_REQUEST = 2000
const BEFORE_SEC = 8
const AFTER_SEC = 10
const MAX_TEXT = 1000

const NUMBER_WORDS = Object.freeze({
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90
})
const HEADING_WORD_RE = /^(chapter|prologue|epilogue|interlude|part)$/
const TITLE_STOP = new Set(['the', 'a', 'of'])
/** heard: the heading word has to start within this many words of the after-clip */
const HEARD_MAX_LEAD_WORDS = 5
/** heard: spoken headings that need a number after them, and ones that stand alone */
const HEARD_NUMBERED = Object.freeze({ chapter: 'Chapter', part: 'Part' })
const HEARD_NAMED = Object.freeze({ prologue: 'Prologue', epilogue: 'Epilogue', interlude: 'Interlude' })
/** A well-formed roman numeral from 1 to 399, so words like "civil" or "mix" are not read as numbers */
const ROMAN_RE = /^(?=[ivxlc])c{0,3}(xc|xl|l?x{0,3})(ix|iv|v?i{0,3})$/

function romanToInt(r) {
  const v = { i: 1, v: 5, x: 10, l: 50, c: 100 }
  let n = 0
  let prev = 0
  for (let k = r.length - 1; k >= 0; k--) {
    const c = v[r[k]]
    if (c < prev) n -= c
    else {
      n += c
      prev = c
    }
  }
  return n
}

/**
 * Port of build-chapters.ps1 Tokens: lower case, apostrophes dropped, anything else non-alphanumeric is a space,
 * number words ("twenty one" -> "21"), roman numerals ("xii" -> "12", a lone "i" only after "chapter") and
 * leading zeros normalised.
 *
 * @param {string} s
 * @returns {string[]}
 */
function tokens(s) {
  const arr = String(s || '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  const out = []
  for (let i = 0; i < arr.length; i++) {
    const w = arr[i]
    if (w in NUMBER_WORDS) {
      let n = NUMBER_WORDS[w]
      if (n >= 20 && i + 1 < arr.length && arr[i + 1] in NUMBER_WORDS && NUMBER_WORDS[arr[i + 1]] < 10) {
        n += NUMBER_WORDS[arr[i + 1]]
        i++
      }
      out.push(String(n))
    } else if ((/^[ivxlc]+$/.test(w) && w.length <= 7 && w !== 'i') || (w === 'i' && i > 0 && arr[i - 1] === 'chapter')) {
      out.push(String(romanToInt(w)))
    } else {
      const m = w.match(/^0*(\d+)$/)
      out.push(m ? m[1] : w)
    }
  }
  return out
}

/**
 * The words of a transcript for heardHeading: lower case (apostrophes dropped, anything else non-alphanumeric splits
 * words), each with whether clause punctuation (or the end of the text) follows it and whether it was capitalised.
 *
 * @param {string} text
 * @returns {{w: string, stop: boolean, cap: boolean}[]}
 */
function headingWords(text) {
  const s = String(text || '').replace(/[’']/g, '')
  const found = []
  const re = /[A-Za-z0-9]+/g
  let m
  while ((m = re.exec(s))) found.push({ raw: m[0], start: m.index, end: m.index + m[0].length })
  return found.map((f, k) => {
    const sep = s.slice(f.end, k + 1 < found.length ? found[k + 1].start : s.length)
    return { w: f.raw.toLowerCase(), stop: k + 1 === found.length || /[.,;:!?…—–]/.test(sep), cap: /^[A-Z]/.test(f.raw) }
  })
}

/** Number words that can continue a number; one left over after the part spokenNumberAt reads means it misread it */
function isNumberWord(w) {
  return w in NUMBER_WORDS || w === 'hundred' || w === 'thousand' || w === 'million'
}

/**
 * The chapter number spoken at arr[i]: digits ("3", "03"), roman numerals ("xii", "i"), or number words up to the
 * hundreds ("twenty one", "one hundred and two"). Null when number words follow that it does not read ("one
 * thousand", "twenty twenty"), and for a one-letter numeral ("I", "V", "X") that runs on into prose ("Part I was"),
 * since a wrong number is worse than none.
 *
 * @param {{w: string, stop: boolean, cap: boolean}[]} arr - from headingWords
 * @param {number} i
 * @returns {number|null}
 */
function spokenNumberAt(arr, i) {
  if (!arr[i]) return null
  const w = arr[i].w
  if (/^\d{1,4}$/.test(w)) return Number(w) || null
  if (ROMAN_RE.test(w)) {
    if (w.length > 1) return romanToInt(w)
    // a lone "i" is usually the pronoun: a numeral only at a clause boundary or before a new capitalised word
    const next = arr[i + 1]
    const boundary = arr[i].stop || (next.cap && next.w !== 'i')
    return boundary ? romanToInt(w) : null
  }
  if (!(w in NUMBER_WORDS)) return null

  const at = (k) => (arr[k] ? arr[k].w : undefined)
  let n = NUMBER_WORDS[w]
  let k = i + 1
  if (n < 10 && !arr[i].stop && at(k) === 'hundred') {
    n *= 100
    k++
    if (!arr[k - 1].stop && at(k) === 'and' && at(k + 1) in NUMBER_WORDS) k++
    if (!arr[k - 1].stop && at(k) in NUMBER_WORDS && NUMBER_WORDS[at(k)] < 100) {
      const rest = NUMBER_WORDS[at(k)]
      n += rest
      k++
      if (rest >= 20 && !arr[k - 1].stop && at(k) in NUMBER_WORDS && NUMBER_WORDS[at(k)] < 10) {
        n += NUMBER_WORDS[at(k)]
        k++
      }
    }
  } else if (n >= 20 && !arr[i].stop && at(k) in NUMBER_WORDS && NUMBER_WORDS[at(k)] < 10) {
    n += NUMBER_WORDS[at(k)]
    k++
  }
  // the last word read ends the number unless more number words run on from it
  if (!arr[k - 1].stop && isNumberWord(at(k))) return null
  return n
}

/** "End of chapter two", "the end of part one": a heading word right after these closes the previous chapter */
const HEARD_CLOSING = new Set(['of', 'end'])

/**
 * A spoken heading at the start of the after-clip, normalised: "Chapter Twenty-One. The rain" -> "Chapter 21",
 * "Part Two" -> "Part 2", "Prologue" -> "Prologue". Only counts when the heading word is one of the first
 * HEARD_MAX_LEAD_WORDS words, so a short lead-in ("Heat two of seven. Chapter three.") is allowed but prose that
 * mentions a chapter later is not. "Chapter" or "Part" without a number after it is not a heading, and neither is
 * the previous chapter's closing line ("End of chapter two. Chapter three." -> "Chapter 3").
 *
 * @param {string} after - transcript of the clip after the start
 * @returns {string|null}
 */
function heardHeading(after) {
  const arr = headingWords(after)
  const limit = Math.min(arr.length, HEARD_MAX_LEAD_WORDS)
  for (let i = 0; i < limit; i++) {
    const w = arr[i].w
    if (i > 0 && HEARD_CLOSING.has(arr[i - 1].w)) continue
    if (w in HEARD_NAMED) return HEARD_NAMED[w]
    if (w in HEARD_NUMBERED) {
      const n = spokenNumberAt(arr, i + 1)
      if (n) return `${HEARD_NUMBERED[w]} ${n}`
    }
  }
  return null
}

function words(s) {
  return String(s || '')
    .split(/\s+/)
    .filter(Boolean)
}

/**
 * The verify-report rules for one chapter start.
 *
 * @param {string} title
 * @param {string} before - transcript of the clip before the start
 * @param {string} after - transcript of the clip after the start
 * @returns {{before: string, after: string, heading: boolean, late: boolean, early: boolean, heard: string|null}}
 */
function assessSpeech(title, before, after) {
  before = String(before || '')
  after = String(after || '')
  const bw = words(before)
  const aw = words(after)
  const tail = bw.slice(-8).join(' ')
  const head3 = aw.slice(0, 3).join(' ')

  // heading words of this chapter, e.g. "chapter 12", "interlude quasar", "prologue" (a list index like "3. " is not read out)
  const tt = tokens(String(title || '').replace(/^\s*\d+\.\s*/, ''))
    .filter((t) => !TITLE_STOP.has(t))
    .slice(0, 2)
  const key = tt.join(' ')
  const tailTok = tokens(tail).join(' ')
  const headTok = tokens(head3).join(' ')
  const afterTok = tokens(aw.slice(0, 25).join(' ')).join(' ')

  const at = key ? afterTok.indexOf(key) : -1
  const leadWords = at >= 0 ? words(afterTok.slice(0, at)).length : Infinity
  const isHeadingTitle = !!key && HEADING_WORD_RE.test(tt[0])
  const startsWithHeading = !!key && headTok.startsWith(tt[0])

  const late = isHeadingTitle && tailTok.includes(key) && !startsWithHeading
  // a short lead-in like "Heat 2 of 7." is part of the heading
  const early = isHeadingTitle && !startsWithHeading && at >= 0 && leadWords > 5

  // heading (not in the script): the title's words, with the same stop words dropped from the transcript as from
  // the title, so "The Ashes of Rome" (key "ashes rome") matches a spoken "The Ashes of Rome"
  const afterKeyTok = ` ${tokens(aw.slice(0, 25).join(' '))
    .filter((t) => !TITLE_STOP.has(t))
    .join(' ')} `
  const keyAt = key ? afterKeyTok.indexOf(` ${key} `) : -1
  const heading = keyAt >= 0 && words(afterKeyTok.slice(0, keyAt)).length <= 5 && !early

  // a start flagged LATE or EARLY is not where the speech check listened for, so what it heard there may be the
  // neighbouring chapter ("End of chapter three. ... Chapter four.")
  const heard = late || early ? null : heardHeading(after)

  return { before: before.slice(0, MAX_TEXT), after: after.slice(0, MAX_TEXT), heading, late, early, heard }
}

/**
 * Snap verifier backed by the chapterbot sidecar (see chapterSnapRunner's verifier seam).
 *
 * @param {Object} params
 * @param {string[]} params.titles - resolved chapter titles, by index
 * @param {Set<string>} [params.skipReasons] - proposals with these reasons are not checked
 * @param {Object} [params.client] - chapterbotClient (tests)
 * @param {() => number} [params.now]
 * @param {number} [params.deadlineMs]
 * @returns {{verify: Function}}
 */
function createVerifier({ titles, skipReasons = new Set(), client = chapterbotClient, now = Date.now, deadlineMs = VERIFY_DEADLINE_MS }) {
  // the budget covers the snap that runs before verify(), so it starts now
  const deadlineAt = now() + deadlineMs
  return {
    async verify({ proposals, timeline, signal }) {
      const warnings = []
      // the first chapter has no "before"; verify-report skips starts under 1 s
      const wanted = proposals.filter((p) => p.index > 0 && p.proposedStart >= 1 && !skipReasons.has(p.reason))
      if (!wanted.length) return { verdicts: [], warnings }

      let files
      try {
        files = client.mapFiles(timeline)
      } catch (error) {
        Logger.warn(`[ChapterbotSpeech] Not sending audio to chapterbot: ${error.message}`)
        warnings.push('Speech check skipped: the audio files are outside the configured chapterbot path map')
        return { verdicts: [], warnings }
      }
      if (!files.length) {
        warnings.push('Speech check skipped: no audio files')
        return { verdicts: [], warnings }
      }

      const checked = wanted.slice(0, MAX_VERIFY_STARTS)
      if (wanted.length > checked.length) {
        warnings.push(`Speech check limited to ${MAX_VERIFY_STARTS} chapters per request: ${wanted.length - checked.length} not checked. Resend with "indexes" set to the rest to check them.`)
      }

      const verdicts = []
      let notChecked = 0
      let b = 0
      while (b < checked.length) {
        if (signal?.aborted) break
        // size each batch to the time left, so the request ends inside the budget
        const remaining = deadlineAt - now()
        const fit = Math.floor((remaining - EST_MS_PER_REQUEST) / EST_MS_PER_START)
        const size = Math.min(BATCH_SIZE, checked.length - b, fit)
        if (size < 1) {
          notChecked = checked.length - b
          break
        }
        const batch = checked.slice(b, b + size)
        let results
        try {
          ;({ results } = await client.verify({ files, starts: batch.map((p) => p.proposedStart), beforeSec: BEFORE_SEC, afterSec: AFTER_SEC, signal, timeoutMs: remaining }))
        } catch (error) {
          if (signal?.aborted) break
          Logger.warn(`[ChapterbotSpeech] Speech check failed: ${error.message}`)
          const left = checked.length - b
          if (error.code === 'timeout') notChecked = left
          else warnings.push(error.status === 503 || error.status === 429 ? `Speech check skipped: chapterbot is busy, ${left} chapters not checked, try again later` : `Speech check failed: ${left} chapters not checked`)
          break
        }
        for (const p of batch) {
          // the sidecar echoes each start; match within a millisecond
          const r = results.find((x) => Math.abs(x.start - p.proposedStart) < 0.001)
          if (!r) continue
          const speech = assessSpeech(titles[p.index], r.before, r.after)
          verdicts.push({ index: p.index, speech, ...(speech.late || speech.early ? { confidence: 'low' } : {}) })
        }
        b += size
      }
      if (notChecked > 0) warnings.push(`Speech check time limit reached: ${notChecked} chapters not checked. Resend with "indexes" set to them to check them.`)
      return { verdicts, warnings }
    }
  }
}

module.exports = {
  BATCH_SIZE,
  MAX_VERIFY_STARTS,
  VERIFY_DEADLINE_MS,
  tokens,
  heardHeading,
  assessSpeech,
  createVerifier
}
