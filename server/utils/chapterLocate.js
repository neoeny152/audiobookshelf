/**
 * Chapter heading search (snap option `locate`, on with the speech check): find each chapter's spoken heading in a
 * transcript around its proposed start and put the start just before it.
 *
 * The plain speech check listens 8 s before and 10 s after each proposed start, so a start that is more than a few
 * seconds off is only reported ("not heard"), never fixed. Here the sidecar transcribes a window around a predicted
 * start (with word timestamps) and the heading words are searched in it, widening the window step by step
 * (LADDER) when they are not found. Every heading found is an anchor: the next chapters are predicted with its offset,
 * so a reference list that drifts by minutes still lands in the first, small window. Anchors are kept per book for an
 * hour (ANCHOR_TTL_MS), so the next speech batch of the same book starts from them.
 *
 * Only titles whose words would be read out are searched: a heading title ("Chapter 12", "Part II", "Prologue") or a
 * named title of at least two words, and never front or back matter (isHeadingExpected). Anything else gets the plain
 * verdict from the same transcript. A found heading moves the start to `leadSec` before the heading word (or half
 * the gap to the previous word when that is shorter); chapterSnapRunner then puts it on the pause before the word.
 *
 * A chapter whose heading is not found (not read out, or Whisper missed its words) is predicted from the headings
 * found around it (their offsets interpolated by reference time): when that prediction is more than PREDICT_MIN_MOVE
 * from where it was proposed, the verdict carries `start` with `predicted: true`, and chapterSnapRunner moves it onto
 * the longest pause near the prediction (reason aligned-to-headings), or leaves it when there is none. A closer
 * prediction is sent with `predictedNear: true`: the start only moves to the end of that pause when it already lies in
 * it (the same silence, so it plays the same).
 */

const Logger = require('../Logger')
const chapterbotClient = require('./chapterbotClient')
const speech = require('./chapterbotSpeech')

/** First window: this much before and after the predicted start (covers the 8 s / 10 s verify clips) */
const FIRST_BEFORE = 20
const FIRST_AFTER = 15
/** Wider windows (seconds each side) tried in turn when the heading is not in the first one */
const LADDER = [60, 180]
/** Budget estimate per request: fixed cost plus per second of audio (base.en on the test box: ~30x real time) */
const EST_MS_PER_REQUEST = 1500
const EST_MS_PER_AUDIO_SEC = 45
/** A found heading this close to the proposed start does not move it (the snap already put it on the right pause) */
const SAME_START_SEC = 0.6
/** A chapter not heard is moved to the prediction from its neighbours only when the two disagree by more than this */
const PREDICT_MIN_MOVE = 3
const BEFORE_SEC = 8
const AFTER_SEC = 10
/** A word that ends this soon after a start is still before it */
const WORD_END_SLACK = 0.1
const ANCHOR_TTL_MS = 60 * 60 * 1000
const MAX_CACHED_BOOKS = 50

/** cacheKey -> {at, anchors: Map<ref rounded to 0.01, found>} */
const anchorCache = new Map()

function cachedAnchors(cacheKey, now) {
  if (!cacheKey) return new Map()
  const entry = anchorCache.get(cacheKey)
  if (entry && now - entry.at < ANCHOR_TTL_MS) return entry.anchors
  const anchors = new Map()
  anchorCache.set(cacheKey, { at: now, anchors })
  if (anchorCache.size > MAX_CACHED_BOOKS) anchorCache.delete(anchorCache.keys().next().value)
  return anchors
}

/**
 * Transcript words -> tokens with times. A word can give several tokens ("1-2" -> "1", "2") or none (punctuation);
 * "twenty" "one" become one "21", as in chapterbotSpeech.tokens.
 *
 * @param {[number, number, string][]} words
 * @returns {{tok: string, start: number, end: number, word: number}[]}
 */
function timedTokens(words) {
  const out = []
  words.forEach(([start, end, text], word) => {
    for (const tok of speech.tokens(text)) out.push({ tok, start, end, word, numberWord: /^[a-z]/i.test(String(text).trim().replace(/^[^a-z0-9]+/i, '')) })
  })
  // "twenty" "one" spoken as two words
  const merged = []
  for (let i = 0; i < out.length; i++) {
    const cur = out[i]
    const next = out[i + 1]
    if (next && cur.numberWord && next.numberWord && /^[2-9]0$/.test(cur.tok) && /^[1-9]$/.test(next.tok) && next.word === cur.word + 1) {
      merged.push({ ...cur, tok: String(Number(cur.tok) + Number(next.tok)), end: next.end })
      i++
    } else merged.push(cur)
  }
  return merged
}

/**
 * The words of a title that are searched for, and whether the first one is a heading word ("chapter", "part"...),
 * which has to match exactly. Null when the title is not worth searching.
 *
 * @param {string} title
 * @returns {{key: string[], exactFirst: boolean}|null}
 */
function searchKey(title) {
  if (!speech.isHeadingExpected(title)) return null
  const all = speech.tokens(String(title || '').replace(/^\s*\d+\.\s*/, '')).filter((t) => !['the', 'a', 'of'].includes(t))
  if (!all.length) return null
  const heading = /^(chapter|prologue|epilogue|interlude|part)$/.test(all[0])
  if (heading) {
    // "Chapter 12" needs its number; "Prologue" stands alone
    if ((all[0] === 'chapter' || all[0] === 'part') && all.length < 2) return null
    return { key: all.slice(0, 2), exactFirst: true }
  }
  if (all.length < 2) return null
  return { key: all.slice(0, 3), exactFirst: false }
}

/**
 * Times of the heading in the transcript: each place where the key words follow one another.
 *
 * @param {ReturnType<typeof timedTokens>} toks
 * @param {{key: string[], exactFirst: boolean}} search
 * @returns {{start: number, word: number}[]}
 */
function findHeadings(toks, { key, exactFirst }) {
  const hits = []
  for (let i = 0; i + key.length <= toks.length; i++) {
    // numbers match exactly (tokenMatch), so "chapter 1" is not found in "chapter 12"
    const ok = key.every((t, k) => (k === 0 && exactFirst ? toks[i].tok === t : speech.tokenMatch(toks[i + k].tok, t)))
    if (ok) hits.push({ start: toks[i].start, word: toks[i].word })
  }
  return hits
}

/**
 * Start just before the heading word: leadSec before it, or half the gap to the previous word when that is shorter.
 *
 * @param {[number, number, string][]} words
 * @param {{start: number, word: number}} hit
 * @param {number} leadSec
 */
function startBefore(words, hit, leadSec) {
  const prev = hit.word > 0 ? words[hit.word - 1] : null
  if (!prev) return Math.max(0, hit.start - leadSec)
  const gap = hit.start - prev[1]
  if (gap <= 0) return hit.start
  return Math.max(0, hit.start - Math.min(leadSec, gap / 2))
}

/**
 * The words before and after a start. Whisper often times the first word after a silence a little early (inside the
 * silence, before the start), so a word belongs after the start when it ends after it.
 */
function clipsAround(words, start) {
  const pick = (from, to) =>
    words
      .filter((w) => w[1] > from && w[1] <= to)
      .map((w) => w[2].trim())
      .join(' ')
  return { before: pick(start - BEFORE_SEC, start + WORD_END_SLACK), after: pick(start + WORD_END_SLACK, start + AFTER_SEC) }
}

const referenceOf = (p) => (Number.isFinite(p.referenceStart) ? p.referenceStart : p.originalStart)

function mergeWords(into, words) {
  const seen = new Set(into.map((w) => `${w[0]}|${w[2]}`))
  for (const w of words) if (!seen.has(`${w[0]}|${w[2]}`)) into.push(w)
  into.sort((a, b) => a[0] - b[0])
}

/**
 * Locating verifier. Same seam and budget rules as chapterbotSpeech.createVerifier; verdicts may carry `start` (the
 * located start) and `headingAt` (the heading word's time).
 *
 * @param {Object} params
 * @param {string[]} params.titles
 * @param {Set<string>} [params.skipReasons]
 * @param {number} [params.leadSec]
 * @param {string} [params.cacheKey] - per book (and audio); anchors found are reused by the next batch
 * @param {Object} [params.client]
 * @param {() => number} [params.now]
 * @param {number} [params.deadlineMs]
 * @param {number} [params.maxStarts]
 * @param {Function} [params.fallback] - plain verify({proposals, timeline, signal}) for a sidecar without /v1/transcribe
 */
function createLocator({ titles, skipReasons = new Set(), leadSec = 0.25, cacheKey = null, client = chapterbotClient, now = Date.now, deadlineMs = speech.VERIFY_DEADLINE_MS, maxStarts = speech.MAX_VERIFY_STARTS, fallback = null }) {
  const deadlineAt = now() + deadlineMs
  const cost = (sec) => EST_MS_PER_REQUEST + EST_MS_PER_AUDIO_SEC * sec

  return {
    async verify({ proposals, timeline, signal }) {
      const warnings = []
      const wanted = proposals.filter((p) => p.index > 0 && p.proposedStart >= 1 && !skipReasons.has(p.reason))
      if (!wanted.length) return { verdicts: [], warnings }

      let files
      try {
        files = client.mapFiles(timeline)
      } catch (error) {
        Logger.warn(`[ChapterLocate] Not sending audio to chapterbot: ${error.message}`)
        warnings.push('Speech check skipped: the audio files are outside the configured chapterbot path map')
        return { verdicts: [], warnings }
      }
      if (!files.length) {
        warnings.push('Speech check skipped: no audio files')
        return { verdicts: [], warnings }
      }
      const total = timeline.reduce((s, t) => Math.max(s, t.offset + t.duration), 0)

      const checked = wanted.slice(0, maxStarts)
      if (wanted.length > checked.length) {
        warnings.push(`Speech check limited to ${maxStarts} chapters per request: ${wanted.length - checked.length} not checked. Resend with "indexes" set to the rest to check them.`)
      }

      const anchors = cachedAnchors(cacheKey, now())
      const nearestAnchors = (ref) => {
        let before = null
        let after = null
        for (const [r, found] of anchors) {
          if (r <= ref && (!before || r > before.r)) before = { r, d: found - r }
          if (r > ref && (!after || r < after.r)) after = { r, d: found - r }
        }
        return { before, after }
      }
      /** offset (found - reference) of the nearest anchor before `ref` (else after it), or null: for searching ahead */
      const driftAt = (ref) => {
        const { before, after } = nearestAnchors(ref)
        return (before || after)?.d ?? null
      }
      /** offset interpolated between the anchors on both sides of `ref`, or the one side there is, or null */
      const driftBetween = (ref) => {
        const { before, after } = nearestAnchors(ref)
        if (before && after) return before.d + ((ref - before.r) * (after.d - before.d)) / (after.r - before.r)
        return (before || after)?.d ?? null
      }

      const transcribe = async (from, to) => {
        const start = Math.max(0, from)
        const length = Math.min(to, total) - start
        if (length <= 0.5) return []
        const remaining = deadlineAt - now()
        const { results } = await client.transcribe({ files, ranges: [{ start, length }], signal, timeoutMs: Math.max(1000, remaining) })
        return results[0]?.words || []
      }

      const verdicts = []
      /** chapters whose heading was not found, for the prediction from their neighbours */
      const unconfirmed = []
      let notChecked = 0
      let located = 0
      for (let k = 0; k < checked.length; k++) {
        const p = checked[k]
        if (signal?.aborted) break
        const title = titles[p.index]
        const search = searchKey(title)
        // anchors are kept on the caller's reference times: a reference list's offsets against the audio are steadier
        // there than on the re-anchored ones, whose rate past the last part file is only an estimate
        const ref = referenceOf(p)
        const drift = driftAt(ref)
        const center = drift === null ? p.proposedStart : ref + drift
        const firstFrom = Math.min(center, p.proposedStart) - FIRST_BEFORE
        const firstTo = Math.max(center, p.proposedStart) + FIRST_AFTER
        if (deadlineAt - now() < cost(firstTo - firstFrom)) {
          notChecked = checked.length - k
          break
        }

        const words = []
        let hit = null
        try {
          mergeWords(words, await transcribe(firstFrom, firstTo))
          if (search) {
            const pick = (ws, lo, hi) => {
              const hits = findHeadings(timedTokens(ws), search).filter((h) => h.start >= lo && h.start <= hi)
              hits.sort((a, b) => Math.abs(a.start - center) - Math.abs(b.start - center))
              return hits[0] || null
            }
            hit = pick(words, firstFrom, firstTo)
            for (const w of LADDER) {
              if (hit) break
              const from = center - w
              const to = center + w
              if (deadlineAt - now() < cost(to - from)) {
                // out of time for the wider search: leave this chapter for the next batch rather than call it not heard
                hit = undefined
                break
              }
              mergeWords(words, await transcribe(from, to))
              hit = pick(words, from, to)
            }
          }
        } catch (error) {
          if (signal?.aborted) break
          if (error.status === 404 && fallback && k === 0) {
            // a sidecar that predates /v1/transcribe: the plain speech check
            Logger.info('[ChapterLocate] Chapterbot has no /v1/transcribe, using the plain speech check')
            return fallback.verify({ proposals, timeline, signal })
          }
          Logger.warn(`[ChapterLocate] Speech check failed: ${error.message}`)
          const left = checked.length - k
          if (error.code === 'timeout') notChecked = left
          else warnings.push(error.status === 503 || error.status === 429 ? `Speech check skipped: chapterbot is busy, ${left} chapters not checked, try again later` : `Speech check failed: ${left} chapters not checked`)
          break
        }
        if (hit === undefined) {
          notChecked = checked.length - k
          break
        }

        let start = p.proposedStart
        const verdict = { index: p.index }
        if (hit) {
          const found = startBefore(words, hit, leadSec)
          anchors.set(Math.round(ref * 100) / 100, found)
          // chapterSnapRunner puts the start on the pause before the heading, and leaves it when it is already there
          verdict.start = found
          verdict.headingAt = hit.start
          if (Math.abs(found - p.proposedStart) > SAME_START_SEC) {
            start = found
            located++
          }
        }
        // the plain verdict, heard at the (possibly located) start; a found heading word always opens the after-clip
        const clips = clipsAround(words, hit ? Math.min(start, hit.start - 2 * WORD_END_SLACK) : start)
        const sp = speech.assessSpeech(title, clips.before, clips.after)
        if (start !== p.proposedStart) sp.located = true
        verdict.speech = sp
        if (sp.late || sp.early) verdict.confidence = 'low'
        verdicts.push(verdict)
        if (!hit) unconfirmed.push({ p, verdict })
      }

      // chapters not heard: where the headings found around them say they should be
      let predicted = 0
      for (const { p, verdict } of unconfirmed) {
        const ref = referenceOf(p)
        const drift = driftBetween(ref)
        if (drift === null) continue
        const at = ref + drift
        if (at <= 0 || at >= total) continue
        verdict.start = at
        verdict.headingAt = at
        verdict.predicted = true
        if (Math.abs(at - p.proposedStart) <= PREDICT_MIN_MOVE) {
          verdict.predictedNear = true
          continue
        }
        predicted++
        // what is heard there (placing it on a pause moves it by a few seconds at most)
        if (deadlineAt - now() >= cost(BEFORE_SEC + AFTER_SEC + 4)) {
          try {
            const near = await transcribe(at - BEFORE_SEC - 2, at + AFTER_SEC + 2)
            const clips = clipsAround(near, at)
            verdict.speech = { ...speech.assessSpeech(titles[p.index], clips.before, clips.after), predicted: true }
            if (verdict.speech.late || verdict.speech.early) verdict.confidence = 'low'
            else delete verdict.confidence
          } catch (error) {
            if (signal?.aborted) break
            Logger.debug(`[ChapterLocate] Transcript at the predicted start failed: ${error.message}`)
          }
        }
      }
      if (notChecked > 0) warnings.push(`Speech check time limit reached: ${notChecked} chapters not checked. Resend with "indexes" set to them to check them.`)
      if (located || predicted) Logger.info(`[ChapterLocate] Found ${located} chapter headings away from their proposed starts, predicted ${predicted} more from the headings around them`)
      return { verdicts, warnings }
    }
  }
}

module.exports = {
  LADDER,
  PREDICT_MIN_MOVE,
  timedTokens,
  searchKey,
  findHeadings,
  startBefore,
  createLocator,
  /** for tests */
  _anchorCache: anchorCache
}
