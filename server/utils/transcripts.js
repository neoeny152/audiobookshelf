const Path = require('path')
const fs = require('../libs/fsExtra')
const htmlSanitizer = require('./htmlSanitizer')

/**
 * Transcripts of audiobooks and podcast episodes (fork feature "transcripts", upstream #5683 and #2919).
 *
 * Three sources, in the order clients should prefer them (creator first):
 * - feed: <podcast:transcript url type language rel> tags of an episode's RSS item, stored on the episode as
 *   extraData.transcripts when it is downloaded (or refreshed from the feed). The file is fetched on demand (or with
 *   the episode when the library setting downloadPodcastTranscripts is on) and cached in the item's metadata folder.
 * - local: a sidecar next to the audio, same base name with .vtt or .srt ("Episode 12.mp3" + "Episode 12.vtt").
 *   For a book with several audio files each file may have its own; their cues are moved onto the book timeline.
 * - generated: made by the server from the audio through the chapterbot sidecar (POST /v1/transcribe, word timings),
 *   or, for a book that has an EPUB made from its audio, from that EPUB's read-along data (no new transcription).
 *
 * Everything the server writes lives in MetadataPath/items/<libraryItemId>/transcripts, never in the library folder
 * (the scanner and watcher never see it; it goes away with the item's metadata folder):
 *   <key>.generated.vtt   + <key>.generated.json (model, source, createdAt)
 *   <key>.feed-<n>.<ext>  cached copy of the episode's n-th feed transcript
 * where <key> is "book" or the episode id.
 *
 * Every timed transcript is served as WebVTT (or as JSON cues); untimed ones (HTML, plain text) as plain text.
 * HTML is never served as HTML.
 */

const FORMATS = Object.freeze(['vtt', 'srt', 'json', 'html', 'txt'])
const TIMED_FORMATS = new Set(['vtt', 'srt', 'json'])
const MIME_TYPES = Object.freeze({
  vtt: 'text/vtt',
  srt: 'application/x-subrip',
  json: 'application/json',
  html: 'text/html',
  txt: 'text/plain'
})
const SOURCES = Object.freeze(['feed', 'local', 'generated'])
/** at most this many feed transcript tags are kept per episode */
const MAX_FEED_TRANSCRIPTS = 10
const MAX_URL_LENGTH = 2048
const MAX_ATTR_LENGTH = 64
/** largest transcript file read or downloaded */
const MAX_TRANSCRIPT_BYTES = 20 * 1024 * 1024
const MAX_CUES = 200000
const KEY_RE = /^[\w-]{1,128}$/
const BOOK_KEY = 'book'

// cue building from word timings
const CUE_MAX_SEC = 7
const CUE_MAX_CHARS = 90
const CUE_MIN_CHARS_AT_SENTENCE_END = 25
const CUE_GAP_SEC = 1.2

class TranscriptError extends Error {
  /**
   * @param {string} message
   * @param {number} [status]
   */
  constructor(message, status = 400) {
    super(message)
    this.name = 'TranscriptError'
    this.status = status
  }
}

/**
 * Format of a transcript from its MIME type (the RSS "type" attribute) or, failing that, its URL/file extension.
 *
 * @param {string} [type]
 * @param {string} [urlOrPath]
 * @returns {string|null} one of FORMATS
 */
function formatFromType(type, urlOrPath) {
  const t = String(type || '')
    .toLowerCase()
    .split(';')[0]
    .trim()
  if (t === 'text/vtt' || t === 'text/webvtt') return 'vtt'
  if (t === 'application/x-subrip' || t === 'application/srt' || t === 'text/srt' || t === 'text/x-srt' || t === 'application/x-srt') return 'srt'
  if (t === 'application/json' || t === 'text/json') return 'json'
  if (t === 'text/html' || t === 'application/xhtml+xml') return 'html'
  if (t === 'text/plain') return 'txt'
  if (urlOrPath) {
    let pathname = String(urlOrPath)
    try {
      pathname = new URL(pathname).pathname
    } catch {
      // a file path
    }
    const ext = Path.extname(pathname).toLowerCase().slice(1)
    if (ext === 'htm' || ext === 'xhtml') return 'html'
    if (ext === 'text') return 'txt'
    if (FORMATS.includes(ext)) return ext
  }
  return null
}

function cleanAttr(value) {
  if (typeof value !== 'string') return null
  const v = value.trim()
  if (!v) return null
  return v.length > MAX_ATTR_LENGTH ? v.slice(0, MAX_ATTR_LENGTH) : v
}

/**
 * <podcast:transcript> tags of an RSS item (xml2js layout) as plain objects.
 * Tags without an http(s) url, or of a format we cannot read, are left out.
 *
 * @param {Object} item - xml2js item
 * @returns {{url: string, type: string|null, language: string|null, rel: string|null}[]}
 */
function extractFeedTranscripts(item) {
  const tags = item?.['podcast:transcript']
  if (!Array.isArray(tags)) return []
  return normalizeFeedTranscripts(tags.map((tag) => tag?.['$'] || null))
}

/**
 * Validate stored or parsed feed transcript entries.
 *
 * @param {*} list
 * @returns {{url: string, type: string|null, language: string|null, rel: string|null}[]}
 */
function normalizeFeedTranscripts(list) {
  if (!Array.isArray(list)) return []
  const out = []
  const seen = new Set()
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue
    const url = typeof entry.url === 'string' ? entry.url.trim() : ''
    if (!url || url.length > MAX_URL_LENGTH || !/^https?:\/\//i.test(url) || seen.has(url)) continue
    try {
      new URL(url)
    } catch {
      continue
    }
    const type = cleanAttr(entry.type)
    if (!formatFromType(type, url)) continue
    seen.add(url)
    out.push({ url, type, language: cleanAttr(entry.language), rel: cleanAttr(entry.rel) })
    if (out.length >= MAX_FEED_TRANSCRIPTS) break
  }
  return out
}

// ---------------------------------------------------------------------------------------------------------------
// Parsing and writing

/**
 * "01:02:03.456", "02:03.456", "01:02:03,456" (SRT) -> seconds
 *
 * @param {string} value
 * @returns {number|null}
 */
function parseTimestamp(value) {
  const m = /^\s*(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?\s*$/.exec(String(value))
  if (!m) return null
  const hours = m[1] ? Number(m[1]) : 0
  const ms = m[4] ? Number(m[4].padEnd(3, '0')) : 0
  return hours * 3600 + Number(m[2]) * 60 + Number(m[3]) + ms / 1000
}

/**
 * @param {number} seconds
 * @returns {string} HH:MM:SS.mmm
 */
function formatTimestamp(seconds) {
  const totalMs = Math.max(0, Math.round((Number(seconds) || 0) * 1000))
  const h = Math.floor(totalMs / 3600000)
  const m = Math.floor((totalMs % 3600000) / 60000)
  const s = Math.floor((totalMs % 60000) / 1000)
  const ms = totalMs % 1000
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', lrm: '', rlm: '' }

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10)
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ''
    }
    const named = ENTITIES[code.toLowerCase()]
    return named === undefined ? whole : named
  })
}

/**
 * Cue text from VTT/SRT markup: the speaker of a <v> tag, other tags dropped, entities decoded.
 *
 * @param {string} raw
 * @returns {{text: string, speaker: string|null}}
 */
function cleanCueText(raw) {
  let speaker = null
  const voice = /<v(?:\.[^\s>]*)?\s+([^>]+)>/i.exec(raw)
  if (voice) speaker = decodeEntities(voice[1]).trim() || null
  const text = decodeEntities(raw.replace(/<[^>]*>/g, ''))
    .replace(/[ \t]+/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n')
  return { text, speaker }
}

/**
 * @typedef TranscriptCue
 * @property {number} start - seconds
 * @property {number} end - seconds
 * @property {string} text
 * @property {string} [speaker]
 */

function pushCue(cues, start, end, text, speaker) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || !text) return
  if (cues.length >= MAX_CUES) throw new TranscriptError('The transcript has too many cues')
  const cue = { start: Math.max(0, start), end: Math.max(start, end), text }
  if (speaker) cue.speaker = speaker
  cues.push(cue)
}

/**
 * WebVTT or SRT text -> cues (tolerant: header, NOTE/STYLE/REGION blocks and cue ids are skipped).
 *
 * @param {string} text
 * @returns {TranscriptCue[]}
 */
function parseSubtitles(text) {
  const cues = []
  const blocks = String(text)
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    // a "blank" line with spaces still ends a cue (common in hand-made SRT files)
    .split(/\n(?:[ \t]*\n)+/)
  for (const block of blocks) {
    const lines = block.split('\n')
    const timeIdx = lines.findIndex((l) => l.includes('-->'))
    if (timeIdx === -1 || timeIdx > 1) continue
    const [from, rest] = lines[timeIdx].split('-->')
    const start = parseTimestamp(from)
    // settings may follow the end time ("00:01.000 --> 00:02.000 align:start")
    const end = parseTimestamp(String(rest).trim().split(/\s+/)[0])
    if (start === null || end === null) continue
    const { text: cueText, speaker } = cleanCueText(lines.slice(timeIdx + 1).join('\n'))
    pushCue(cues, start, end, cueText, speaker)
  }
  cues.sort((a, b) => a.start - b.start)
  return cues
}

/**
 * Podcast Index JSON transcript ({version, segments: [{speaker, startTime, endTime, body}]}) -> cues.
 * Word-level files (one word per segment) are grouped into readable cues.
 *
 * @param {string|Object} input
 * @returns {TranscriptCue[]}
 */
function parseJsonTranscript(input) {
  let obj = input
  if (typeof input === 'string') {
    try {
      obj = JSON.parse(input.replace(/^﻿/, ''))
    } catch {
      throw new TranscriptError('The JSON transcript is not valid JSON')
    }
  }
  const segments = Array.isArray(obj?.segments) ? obj.segments : Array.isArray(obj) ? obj : null
  if (!segments) throw new TranscriptError('The JSON transcript has no segments')
  const valid = segments
    .filter((s) => s && Number.isFinite(Number(s.startTime)) && typeof s.body === 'string' && s.body.trim())
    .map((s) => {
      const start = Number(s.startTime)
      const end = Number.isFinite(Number(s.endTime)) ? Number(s.endTime) : start
      return { start, end: Math.max(start, end), body: s.body.trim(), speaker: typeof s.speaker === 'string' ? s.speaker.trim() : '' }
    })
    .sort((a, b) => a.start - b.start)
  if (!valid.length) return []

  const words = valid.filter((s) => !/\s/.test(s.body)).length
  if (words / valid.length > 0.8) {
    // word level: group per speaker run
    const cues = []
    let run = []
    const flush = () => {
      if (!run.length) return
      for (const cue of cuesFromWords(run.map((s) => [s.start, s.end, s.body]))) {
        if (run[0].speaker) cue.speaker = run[0].speaker
        if (cues.length >= MAX_CUES) throw new TranscriptError('The transcript has too many cues')
        cues.push(cue)
      }
      run = []
    }
    for (const s of valid) {
      if (run.length && s.speaker !== run[0].speaker) flush()
      run.push(s)
    }
    flush()
    return cues
  }
  const cues = []
  for (const s of valid) pushCue(cues, s.start, s.end, s.body, s.speaker || null)
  return cues
}

/**
 * Untimed HTML transcript -> plain text with line breaks kept.
 *
 * @param {string} html
 * @returns {string}
 */
function htmlToText(html) {
  const withBreaks = String(html)
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*\/\s*(p|div|li|h[1-6]|tr)\s*>/gi, '\n')
  return htmlSanitizer
    .stripAllTags(withBreaks)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .filter((l, i, all) => l || (i > 0 && all[i - 1]))
    .join('\n')
    .trim()
}

/**
 * Parse a transcript file's content.
 *
 * @param {string} content
 * @param {string} format - one of FORMATS
 * @returns {{timed: true, cues: TranscriptCue[]}|{timed: false, text: string}}
 */
function parseTranscript(content, format) {
  switch (format) {
    case 'vtt':
    case 'srt':
      return { timed: true, cues: parseSubtitles(content) }
    case 'json':
      return { timed: true, cues: parseJsonTranscript(content) }
    case 'html':
      return { timed: false, text: htmlToText(content) }
    case 'txt':
      return { timed: false, text: String(content).replace(/^﻿/, '').replace(/\r\n?/g, '\n').trim() }
    default:
      throw new TranscriptError(`Unsupported transcript format "${format}"`)
  }
}

function escapeCueText(text) {
  // "-->" is not allowed in cue text; blank lines would end the cue
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n{2,}/g, '\n')
}

/**
 * @param {TranscriptCue[]} cues
 * @param {string[]} [notes] - NOTE lines after the header
 * @returns {string} WebVTT
 */
function buildVtt(cues, notes = []) {
  const parts = ['WEBVTT']
  for (const note of notes) {
    if (note) parts.push(`NOTE ${String(note).replace(/-->/g, '->').replace(/\n+/g, ' ')}`)
  }
  for (const cue of cues) {
    const voice = cue.speaker ? `<v ${escapeCueText(cue.speaker).replace(/\n/g, ' ')}>` : ''
    parts.push(`${formatTimestamp(cue.start)} --> ${formatTimestamp(Math.max(cue.start, cue.end))}\n${voice}${escapeCueText(cue.text)}`)
  }
  return parts.join('\n\n') + '\n'
}

/**
 * Word timings [start, end, word] -> readable cues: a cue ends after a finished sentence (once it has some text),
 * before a long pause, or when it gets too long.
 *
 * @param {[number, number, string][]} words - on one timeline, any order
 * @returns {TranscriptCue[]}
 */
function cuesFromWords(words) {
  const sorted = (words || []).filter((w) => Array.isArray(w) && Number.isFinite(w[0]) && Number.isFinite(w[1]) && typeof w[2] === 'string' && w[2].trim()).sort((a, b) => a[0] - b[0])
  const cues = []
  let current = null
  const flush = () => {
    if (current && current.text) cues.push({ start: current.start, end: current.end, text: current.text })
    current = null
  }
  for (const [start, end, raw] of sorted) {
    const word = raw.trim()
    if (current) {
      const gap = start - current.end
      const tooLong = end - current.start > CUE_MAX_SEC || current.text.length + 1 + word.length > CUE_MAX_CHARS
      const sentenceEnded = /[.!?…]["')\]]*$/.test(current.text) && current.text.length >= CUE_MIN_CHARS_AT_SENTENCE_END
      if (gap > CUE_GAP_SEC || tooLong || sentenceEnded) flush()
    }
    if (!current) current = { start, end: Math.max(start, end), text: word }
    else {
      current.text += ` ${word}`
      current.end = Math.max(current.end, end)
    }
  }
  flush()
  return cues
}

/**
 * Join the word lists of overlapping transcription ranges: each range owns the words that start before the middle of
 * its overlap with the next one, so a word cut at a range edge comes from the range that heard it whole.
 *
 * @param {{start: number, length: number, words: [number, number, string][]}[]} results - in timeline order
 * @returns {[number, number, string][]}
 */
function joinRangeWords(results) {
  const out = []
  const sorted = [...results].sort((a, b) => a.start - b.start)
  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i]
    const prev = sorted[i - 1]
    const next = sorted[i + 1]
    const from = prev ? (r.start + Math.min(prev.start + prev.length, r.start + r.length)) / 2 : -Infinity
    const to = next ? (next.start + Math.min(r.start + r.length, next.start + next.length)) / 2 : Infinity
    for (const w of r.words || []) if (w[0] >= from && w[0] < to) out.push(w)
  }
  return out
}

/**
 * Split [0, total) into ranges of `chunk` seconds that overlap by `overlap` seconds.
 *
 * @param {number} total
 * @param {number} chunk
 * @param {number} overlap
 * @returns {{start: number, length: number}[]}
 */
function planRanges(total, chunk, overlap) {
  const ranges = []
  if (!(total > 0) || !(chunk > overlap)) return ranges
  for (let start = 0; start < total; start += chunk - overlap) {
    const length = Math.min(chunk, total - start)
    ranges.push({ start: Math.round(start * 1000) / 1000, length: Math.round(length * 1000) / 1000 })
    if (start + length >= total) break
  }
  return ranges
}

/**
 * Cues from read-along data (an EPUB made from the audio) and the sentence texts of that EPUB. A long sentence with
 * word timings whose count matches its words is split into shorter cues.
 *
 * @param {{sentences: {id: string, start: number, end: number, w?: number[][]}[]}} readAlongData
 * @param {Map<string, string>} texts - sentence id -> text
 * @returns {TranscriptCue[]}
 */
function cuesFromReadAlong(readAlongData, texts) {
  const cues = []
  for (const sentence of readAlongData?.sentences || []) {
    const text = (texts.get(sentence.id) || '').replace(/\s+/g, ' ').trim()
    if (!text) continue
    const tokens = text.split(' ')
    if (text.length > CUE_MAX_CHARS && Array.isArray(sentence.w) && sentence.w.length === tokens.length) {
      for (const cue of cuesFromWords(tokens.map((t, i) => [sentence.w[i][0], sentence.w[i][1], t]))) cues.push(cue)
    } else {
      pushCue(cues, sentence.start, sentence.end, text, null)
    }
  }
  cues.sort((a, b) => a.start - b.start)
  return cues
}

/**
 * Sentence texts of an EPUB made by chapterbot: every timed sentence is a flat <span id="sN">text</span>.
 *
 * @param {string} epubPath
 * @returns {Promise<Map<string, string>>}
 */
async function readEpubSentenceTexts(epubPath) {
  const StreamZip = require('../libs/nodeStreamZip')
  const zip = new StreamZip.async({ file: epubPath })
  const texts = new Map()
  try {
    const entries = Object.values(await zip.entries())
    for (const entry of entries) {
      if (entry.isDirectory || !/\.x?html?$/i.test(entry.name) || entry.size > MAX_TRANSCRIPT_BYTES) continue
      const html = (await zip.entryData(entry.name)).toString('utf8')
      const re = /<span\s+id="(s\d{1,7})"\s*>([\s\S]*?)<\/span>/g
      let m
      while ((m = re.exec(html))) {
        texts.set(m[1], decodeEntities(m[2].replace(/<[^>]*>/g, '')))
      }
    }
  } finally {
    await zip.close().catch(() => {})
  }
  return texts
}

/**
 * Cues of a book's per-file sidecars moved onto the book timeline.
 *
 * @param {{offset: number, duration: number, cues: TranscriptCue[]}[]} parts
 * @returns {TranscriptCue[]}
 */
function mergeTrackCues(parts) {
  const cues = []
  for (const part of parts) {
    for (const cue of part.cues) {
      if (part.duration > 0 && cue.start >= part.duration + 1) continue
      const shifted = { ...cue, start: cue.start + part.offset, end: cue.end + part.offset }
      cues.push(shifted)
    }
  }
  cues.sort((a, b) => a.start - b.start)
  return cues
}

// ---------------------------------------------------------------------------------------------------------------
// Storage

/**
 * @param {string} libraryItemId
 * @returns {string} MetadataPath/items/<libraryItemId>/transcripts
 */
function dir(libraryItemId) {
  if (typeof libraryItemId !== 'string' || !KEY_RE.test(libraryItemId)) throw new TranscriptError('Invalid library item id')
  return Path.join(global.MetadataPath, 'items', libraryItemId, 'transcripts')
}

/**
 * @param {string|null} episodeId
 * @returns {string}
 */
function keyFor(episodeId) {
  if (!episodeId) return BOOK_KEY
  if (typeof episodeId !== 'string' || !KEY_RE.test(episodeId) || episodeId === BOOK_KEY) throw new TranscriptError('Invalid episode id')
  return episodeId
}

function generatedPaths(libraryItemId, episodeId) {
  const base = Path.join(dir(libraryItemId), `${keyFor(episodeId)}.generated`)
  return { vtt: `${base}.vtt`, meta: `${base}.json` }
}

function feedCachePath(libraryItemId, episodeId, index, format) {
  if (!Number.isInteger(index) || index < 0 || index >= MAX_FEED_TRANSCRIPTS || !FORMATS.includes(format)) throw new TranscriptError('Invalid feed transcript')
  return Path.join(dir(libraryItemId), `${keyFor(episodeId)}.feed-${index}.${format}`)
}

async function writeAtomic(target, body) {
  await fs.ensureDir(Path.dirname(target))
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`
  try {
    await fs.writeFile(temp, body)
    await fs.rename(temp, target)
  } catch (error) {
    await fs.remove(temp).catch(() => {})
    throw error
  }
}

/**
 * @param {string} libraryItemId
 * @param {string|null} episodeId
 * @param {TranscriptCue[]} cues
 * @param {{source: 'transcribe'|'readalong', model?: string|null, language?: string|null}} meta
 * @returns {Promise<Object>} the stored meta
 */
async function saveGenerated(libraryItemId, episodeId, cues, meta) {
  const paths = generatedPaths(libraryItemId, episodeId)
  const stored = {
    source: meta.source === 'readalong' ? 'readalong' : 'transcribe',
    model: typeof meta.model === 'string' ? meta.model.slice(0, 128) : null,
    language: typeof meta.language === 'string' ? meta.language.slice(0, 16) : null,
    cues: cues.length,
    createdAt: Date.now()
  }
  const notes = [`Generated by audiobookshelf from the audio${stored.source === 'readalong' ? ' (read-along data of the EPUB made from it)' : ''}${stored.model ? `, model ${stored.model}` : ''}`]
  await writeAtomic(paths.vtt, buildVtt(cues, notes))
  await writeAtomic(paths.meta, JSON.stringify(stored))
  return stored
}

async function readGeneratedMeta(libraryItemId, episodeId) {
  const paths = generatedPaths(libraryItemId, episodeId)
  let stat
  try {
    stat = await fs.stat(paths.vtt)
  } catch {
    return null
  }
  if (!stat.isFile()) return null
  let meta = {}
  try {
    meta = JSON.parse(await fs.readFile(paths.meta, 'utf8')) || {}
  } catch {
    // the VTT alone is enough
  }
  return {
    path: paths.vtt,
    model: typeof meta.model === 'string' ? meta.model : null,
    language: typeof meta.language === 'string' ? meta.language : null,
    from: meta.source === 'readalong' ? 'readalong' : 'transcribe',
    updatedAt: Number.isFinite(meta.createdAt) ? meta.createdAt : stat.mtimeMs
  }
}

/**
 * @returns {Promise<boolean>} whether a generated transcript was removed
 */
async function removeGenerated(libraryItemId, episodeId) {
  const paths = generatedPaths(libraryItemId, episodeId)
  const existed = await fs.pathExists(paths.vtt)
  await fs.remove(paths.vtt)
  await fs.remove(paths.meta)
  return existed
}

/**
 * Remove every stored file of an episode (episode deleted).
 *
 * @param {string} libraryItemId
 * @param {string} episodeId
 */
async function removeEpisodeFiles(libraryItemId, episodeId) {
  let folder
  let key
  try {
    folder = dir(libraryItemId)
    key = keyFor(episodeId)
  } catch {
    return
  }
  let names
  try {
    names = await fs.readdir(folder)
  } catch {
    return
  }
  for (const name of names) {
    if (name.startsWith(`${key}.`)) await fs.remove(Path.join(folder, name)).catch(() => {})
  }
}

async function statFile(path) {
  try {
    const stat = await fs.stat(path)
    return stat.isFile() ? stat : null
  } catch {
    return null
  }
}

/**
 * Sidecar transcripts next to audio files: "<base>.vtt" or "<base>.srt".
 *
 * @param {{path: string, offset: number, duration: number}[]} tracks
 * @returns {Promise<{format: string, updatedAt: number, files: {path: string, offset: number, duration: number, format: string}[]}|null>}
 */
async function findLocalSidecars(tracks) {
  const files = []
  let updatedAt = 0
  for (const track of tracks) {
    if (!track?.path) continue
    const ext = Path.extname(track.path)
    const base = ext ? track.path.slice(0, -ext.length) : track.path
    for (const format of ['vtt', 'srt']) {
      const candidate = `${base}.${format}`
      if (candidate === track.path) continue
      const stat = await statFile(candidate)
      if (!stat || stat.size > MAX_TRANSCRIPT_BYTES) continue
      files.push({ path: candidate, offset: track.offset || 0, duration: track.duration || 0, format })
      updatedAt = Math.max(updatedAt, stat.mtimeMs)
      break
    }
  }
  if (!files.length) return null
  return { format: files[0].format, updatedAt, files }
}

/**
 * @param {string} path
 * @returns {Promise<string>}
 */
async function readTextFile(path) {
  const stat = await statFile(path)
  if (!stat) throw new TranscriptError('Transcript file not found', 404)
  if (stat.size > MAX_TRANSCRIPT_BYTES) throw new TranscriptError('Transcript file is too large', 413)
  return fs.readFile(path, 'utf8')
}

/**
 * Pick the transcript a player should show: a timed creator transcript first (VTT, then JSON, then SRT), then a
 * local sidecar, then a generated one; an untimed creator transcript only when nothing timed exists.
 *
 * @param {{id: string, source: string, format: string, timed: boolean}[]} list
 * @returns {string|null}
 */
function preferredTranscriptId(list) {
  const formatRank = { vtt: 0, json: 1, srt: 2, html: 3, txt: 4 }
  const sourceRank = { feed: 0, local: 1, generated: 2 }
  const sorted = [...list].sort((a, b) => {
    if (a.timed !== b.timed) return a.timed ? -1 : 1
    if (sourceRank[a.source] !== sourceRank[b.source]) return sourceRank[a.source] - sourceRank[b.source]
    return (formatRank[a.format] ?? 9) - (formatRank[b.format] ?? 9)
  })
  return sorted[0]?.id || null
}

module.exports = {
  FORMATS,
  TIMED_FORMATS,
  MIME_TYPES,
  SOURCES,
  MAX_FEED_TRANSCRIPTS,
  MAX_TRANSCRIPT_BYTES,
  BOOK_KEY,
  TranscriptError,
  formatFromType,
  extractFeedTranscripts,
  normalizeFeedTranscripts,
  parseTimestamp,
  formatTimestamp,
  decodeEntities,
  parseSubtitles,
  parseJsonTranscript,
  htmlToText,
  parseTranscript,
  buildVtt,
  cuesFromWords,
  joinRangeWords,
  planRanges,
  cuesFromReadAlong,
  readEpubSentenceTexts,
  mergeTrackCues,
  dir,
  keyFor,
  generatedPaths,
  feedCachePath,
  writeAtomic,
  saveGenerated,
  readGeneratedMeta,
  removeGenerated,
  removeEpisodeFiles,
  findLocalSidecars,
  readTextFile,
  preferredTranscriptId
}
