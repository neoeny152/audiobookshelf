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
 * Two deliberate differences from the script, which compares substrings of the joined tokens:
 * - title words are matched against the transcript as whole words ("Chapter 1" is not heard in "chapter 12")
 * - title words are tolerant to spelling (Whisper writes "Clare" for "Claire", "Ava" for "Eva"): see tokenMatch.
 *   Numbers always match exactly, and so does the heading word of a heading title ("chapter", "part"): only the
 *   words after it (the name in "Interlude Quasar") are tolerant. LATE, EARLY and heading use the same matcher.
 * - expected (not in the script, additive): false for front and back matter titles (Dedication, Epigraph, Opening
 *   Credits, About the Author, ...) that narrators often do not read out, so a heading not heard there is no reason
 *   to look at the start. Clients that predate it treat every chapter as expected.
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

/** Levenshtein distance (small strings only: title words against transcript words) */
function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[b.length]
}

/** Spelling tolerance for title words of FUZZY_MIN_LENGTH letters or more: 1 - distance / longer length */
const FUZZY_MIN_SIMILARITY = 0.8
const FUZZY_MIN_LENGTH = 5
const VOWEL_RE = /^[aeiouy]$/
/**
 * Common short words that start with a vowel; never taken as a vowel-swapped spelling of a short title word
 * ("Over" is not heard in "Ever since", "End Game" not in "And game on").
 */
const FUZZY_NEVER_SHORT = new Set(
  [
    'add aid ail all and any are arm art ask ate awe aye eat ebb egg eke elf elk elm end era ere eve ewe eye ill imp inn',
    'ion ire its oak oar oat odd off oil old one opt orb ore our out owe own urn use able ache acre aged ages aims airs',
    'also ally ants away awry each earl ears ease east easy eats echo edge else ends even ever evil exit eyes idea idle',
    'inch info into iron isle item oath obey odds oily okay once ones only onto open oral ours outs oven over owed owes',
    'owns undo unit upon urge used user uses'
  ]
    .join(' ')
    .split(' ')
)

/**
 * The consonants of a word, as a fingerprint that spelling variants of a name share and near-miss common words do
 * not: vowels (and y) dropped, k read as c, doubled letters single ("Claire" / "Clare" -> "clr", "Katherine" /
 * "Catherine" -> "cthrn"; "Night" -> "nght" but "Right" -> "rght").
 *
 * @param {string} w
 * @returns {string}
 */
function consonantSkeleton(w) {
  return w
    .replace(/k/g, 'c')
    .replace(/[aeiouy]/g, '')
    .replace(/(.)\1+/g, '$1')
}

/**
 * Whether a transcript word is the title word, allowing for how Whisper spells names but not for a different common
 * word that sounds alike:
 * - exact for numbers (any digit) and words of one or two letters
 * - a plural or possessive of the title word ("Claire's" -> "claires", "chapters")
 * - three or four letters: only the first letter may differ, and only as one vowel for another ("Eva" / "Ava"), and
 *   not into a common word (FUZZY_NEVER_SHORT); "Run" / "ran", "Tom" / "Tim", "Part" / "port" stay apart
 * - five letters or more: the same consonants (consonantSkeleton) and a normalised edit distance similarity of at
 *   least FUZZY_MIN_SIMILARITY ("Claire" / "Clare", "Katherine" / "Catherine"); "Night" / "right", "Father" /
 *   "rather", "Letter" / "better" stay apart
 *
 * @param {string} heard - token from the transcript
 * @param {string} want - token from the title
 * @returns {boolean}
 */
function tokenMatch(heard, want) {
  if (heard === want) return true
  if (!heard || !want || /\d/.test(heard) || /\d/.test(want)) return false
  if (want.length >= 3 && heard === `${want}s`) return true
  const longer = Math.max(heard.length, want.length)
  if (longer < 3) return false
  if (longer < FUZZY_MIN_LENGTH) {
    if (heard.length !== want.length || FUZZY_NEVER_SHORT.has(heard)) return false
    return heard.slice(1) === want.slice(1) && VOWEL_RE.test(heard[0]) && VOWEL_RE.test(want[0])
  }
  // the plural or possessive of a spelling variant ("Clare's" for "Claire")
  const h = heard.endsWith('s') && !want.endsWith('s') ? heard.slice(0, -1) : heard
  if (consonantSkeleton(h) !== consonantSkeleton(want)) return false
  return 1 - editDistance(h, want) / Math.max(h.length, want.length) >= FUZZY_MIN_SIMILARITY
}

/**
 * Index of the first place in `hay` where the `needle` tokens follow one another (tokenMatch each), or -1. With
 * exactFirst the first needle token has to match exactly (a heading word such as "chapter" or "part").
 *
 * @param {string[]} hay
 * @param {string[]} needle
 * @param {boolean} [exactFirst]
 * @returns {number}
 */
function findTokens(hay, needle, exactFirst = false) {
  if (!needle.length) return -1
  for (let i = 0; i + needle.length <= hay.length; i++) {
    if (needle.every((t, k) => (k === 0 && exactFirst ? hay[i] === t : tokenMatch(hay[i + k], t)))) return i
  }
  return -1
}

/**
 * Front and back matter that narrators often skip, as the start of a title's tokens (after a list index such as
 * "3. "). A chapter title that starts with one of these gets speech.expected = false.
 */
const UNSPOKEN_TITLE_STARTS = Object.freeze(
  [
    'dedication',
    'epigraph',
    'foreword',
    'preface',
    'acknowledgments',
    'acknowledgements',
    'acknowledgment',
    'acknowledgement',
    'opening credits',
    'end credits',
    'ending credits',
    'closing credits',
    'credits',
    'introduction',
    'copyright',
    'about the author',
    'about the authors',
    'about the narrator',
    'about the narrators',
    'also by',
    'praise for',
    'title page',
    'table of contents',
    'front matter',
    'back matter',
    'publishers note',
    'a note from the publisher',
    'bonus material'
  ].map((t) => t.split(' '))
)

/** Front matter names that are also ordinary words ("Forward March", "Contents Under Pressure"): the whole title only */
const UNSPOKEN_WHOLE_TITLES = new Set(['forward', 'contents'])

/** A track or list index in front of a title: "3. ", "01 - ", "1 ", "Track 02 - " */
const TITLE_INDEX_RE = /^\s*(?:track\s*)?\d+(?:\s*[.:)\-–—]+\s*|\s+)(?=\S)/i

/**
 * Whether a chapter with this title is expected to have its heading read out: false for front and back matter
 * (see UNSPOKEN_TITLE_STARTS and UNSPOKEN_WHOLE_TITLES), also behind a track index ("01 - Dedication").
 *
 * @param {string} title
 * @returns {boolean}
 */
function isHeadingExpected(title) {
  const tt = tokens(String(title || '').replace(TITLE_INDEX_RE, ''))
  if (!tt.length) return true
  if (tt.length === 1 && UNSPOKEN_WHOLE_TITLES.has(tt[0])) return false
  return !UNSPOKEN_TITLE_STARTS.some((start) => start.length <= tt.length && start.every((w, k) => tt[k] === w))
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
 * @returns {{before: string, after: string, heading: boolean, late: boolean, early: boolean, heard: string|null, expected: boolean}}
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
  const tailTok = tokens(tail)
  const headTok = tokens(head3)
  const afterTok = tokens(aw.slice(0, 25).join(' '))

  // the transcript words before the heading (a short lead-in like "Heat 2 of 7." is part of the heading)
  // the heading word itself ("chapter", "part") is matched exactly; only the words after it are spelling tolerant
  const isHeadingTitle = tt.length > 0 && HEADING_WORD_RE.test(tt[0])
  const at = findTokens(afterTok, tt, isHeadingTitle)
  const startsWithHeading = tt.length > 0 && headTok.length > 0 && headTok[0].startsWith(tt[0])

  const late = isHeadingTitle && findTokens(tailTok, tt, true) >= 0 && !startsWithHeading
  const early = isHeadingTitle && !startsWithHeading && at >= 0 && at > 5

  // heading (not in the script): the title's words, with the same stop words dropped from the transcript as from
  // the title, so "The Ashes of Rome" (key "ashes rome") matches a spoken "The Ashes of Rome"
  const keyAt = findTokens(
    afterTok.filter((t) => !TITLE_STOP.has(t)),
    tt,
    isHeadingTitle
  )
  const heading = keyAt >= 0 && keyAt <= 5 && !early

  // a start flagged LATE or EARLY is not where the speech check listened for, so what it heard there may be the
  // neighbouring chapter ("End of chapter three. ... Chapter four.")
  const heard = late || early ? null : heardHeading(after)

  const expected = isHeadingExpected(title)

  return { before: before.slice(0, MAX_TEXT), after: after.slice(0, MAX_TEXT), heading, late, early, heard, expected }
}

/**
 * Snap verifier backed by the chapterbot sidecar (see chapterSnapRunner's verifier seam).
 *
 * @param {Object} params
 * @param {string[]} params.titles - resolved chapter titles, by index
 * @param {Set<string>} [params.skipReasons] - proposals with these reasons are not checked
 * @param {Object} [params.client] - chapterbotClient (tests)
 * @param {() => number} [params.now]
 * @param {number} [params.deadlineMs] - budget from now; defaults to the HTTP request budget (VERIFY_DEADLINE_MS)
 * @param {number} [params.maxStarts] - starts checked per verify(); defaults to the HTTP limit (MAX_VERIFY_STARTS).
 *   The auto pipeline checks a book in chunks of this size with a longer deadline, so the sidecar sees the same request
 *   sizes as from the HTTP route.
 * @returns {{verify: Function}}
 */
function createVerifier({ titles, skipReasons = new Set(), client = chapterbotClient, now = Date.now, deadlineMs = VERIFY_DEADLINE_MS, maxStarts = MAX_VERIFY_STARTS }) {
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

      const checked = wanted.slice(0, maxStarts)
      if (wanted.length > checked.length) {
        warnings.push(`Speech check limited to ${maxStarts} chapters per request: ${wanted.length - checked.length} not checked. Resend with "indexes" set to the rest to check them.`)
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
  tokenMatch,
  isHeadingExpected,
  heardHeading,
  assessSpeech,
  createVerifier
}
