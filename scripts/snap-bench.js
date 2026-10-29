#!/usr/bin/env node
/**
 * Offline chapter-snap accuracy bench (not part of npm test).
 *
 * For every book with reference chapters it damages the reference starts with a few patterns, runs the REAL snap code
 * (chapterSnapRunner.runSnap: planning, windowed detection, parsing, snapping, order pass) with a fake detector that
 * serves pauses recorded from a full linear ffmpeg silencedetect pass, and scores the proposals at pause level.
 *
 * Why pause level: the references partly come from Audible times and are not sample exact (some run tens of ppm long,
 * most sit ~0.4 s before snap's anchor). So a proposal is scored against the pause that precedes the reference
 * chapter's speech, not against the reference time itself:
 *   target pause P = the pause (>= minSilenceSec) that contains the reference (+/- SLACK), else the latest pause that
 *                    ends at most SPEECH_TOL s before it (reference sits in speech just after the pause)
 *   correct        = proposal inside P (+/- SLACK)
 *   exact-ish      = |proposal - (P.end - leadSec)| <= 0.5
 *   bad            = not correct (wrong pause or left in speech)
 *   regression     = the damaged input was already inside P but the proposal is not
 * References without a target pause are reported as "noTgt" and scored by distance to the reference (<= 1.5 s = ok).
 *
 * Data (defaults can be overridden by env):
 *   SNAP_BENCH_DIR   folder with items/*.json and pauses/<relPath with / -> __>/<audio filename>.txt
 *   SNAP_BENCH_TRUTH folder with final-<prodId>.json
 *
 * Usage:
 *   node scripts/snap-bench.js [--split train|holdout|all] [--patterns late3,late5] [--book <substr>]
 *                              [--opts '{"leadSec":0.25}'] [--fails] [--json out.json]
 */
const fs = require('fs')
const Path = require('path')

const Logger = require('../server/Logger')
const chapterSnap = require('../server/utils/chapterSnap')
const chapterSnapRunner = require('../server/utils/chapterSnapRunner')

for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal']) Logger[level] = () => {}

const BENCH_DIR = process.env.SNAP_BENCH_DIR || 'K:/Dev/_notes/bench'
const TRUTH_DIR = process.env.SNAP_BENCH_TRUTH || 'C:/Users/neoen/OneDrive - Millennial Investing LLC/vscode/unraid/data/chapters-final'

const SLACK = chapterSnap.SLACK
const SPEECH_TOL = 1.5
const EXACT_TOL = 0.5
const NO_TARGET_TOL = 1.5

const TRUTH_MAP = {
  'Matt Dinnimman/Dungeon Crawler Carl/Book 6 - The Eye of the Bedlam Bride': '1544230a-c572-4f95-860f-c45e98242f62',
  'Matt Dinnimman/Dungeon Crawler Carl/Book 7 - This Inevitable Ruin': '2aa14500-f4ef-40fa-8298-9973469703ce',
  'Julie Clark/The Last Flight': '42fa44fa-599e-4987-98fc-724a750565aa',
  'Matt Dinnimman/Dungeon Crawler Carl/Book 8 - A Parade of Horribles': '46d35b06-ed7e-448f-8585-02270df2596f',
  'Matt Dinnimman/Dungeon Crawler Carl/Book 4 - The Gate of the Feral Gods': '47f61737-2339-409b-b283-89179cd0b70c',
  'Lisa Regan/The Bones She Buried': '6982767a-605b-42e8-a240-dcbaed06e28e',
  'Matt Dinnimman/Dungeon Crawler Carl/Book 1 - Dungeon Crawler Carl': '7f7b6077-39e6-4b9f-b0a2-8777f5e1ea78',
  'David Ellis/Keep Them Close': '83e44d87-2b39-47e7-ba69-cab3a92401ea',
  'Clémence Michallon/The Quiet Tenant': '98d58d91-c81e-454a-beac-4730884cc567',
  'Caleb Stephens/The Girls in the Cabin': 'c6726af1-4bb3-455b-b413-e20d6029c961',
  'Anne Frasier/Play Dead': 'c9578352-d940-4286-b7a5-fff088d6db34',
  "Matt Dinnimman/Dungeon Crawler Carl/Book 2 - Carl's Doomsday Scenario": 'db66dda6-1b5c-4a17-94ce-cbe359cdc353',
  'Becca Fitzpatrick/Black Ice': 'ea268af3-c203-4262-aba4-7c8124ae982b',
  "Matt Dinnimman/Dungeon Crawler Carl/Book 5 - The Butcher's Masquerade": 'ec441e12-e3a9-459d-86a9-4b9b4a018aec'
}

const TRAIN = ['The Last Flight', 'Black Ice', 'Book 1 - Dungeon Crawler Carl', 'Book 4 - The Gate', 'Book 6 - The Eye', 'The Bones She Buried', 'The Quiet Tenant']

const PATTERNS = ['late3', 'late5', 'late8', 'early2', 'mixed', 'jitter']

/** Seeded PRNG so every run damages the same way */
function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function damage(pattern, start, rng) {
  switch (pattern) {
    case 'late3':
      return start + 3
    case 'late5':
      return start + 5
    case 'late8':
      return start + 8
    case 'early2':
      return start - 2
    case 'mixed': {
      // what real lists look like: mostly a few seconds late, some early, some already right
      const r = rng()
      if (r < 0.6) return start + 1.5 + 4.5 * rng()
      if (r < 0.85) return start - 0.5 - 2.5 * rng()
      return start
    }
    case 'jitter': {
      // harder: up to 12 s late, up to 4 s early, a few near-exact
      const r = rng()
      if (r < 0.55) return start + 2 + 10 * rng()
      if (r < 0.85) return start - 0.5 - 3.5 * rng()
      return start + (rng() - 0.5) * 0.4
    }
    default:
      throw new Error(`unknown pattern ${pattern}`)
  }
}

function parseArgs(argv) {
  const args = { split: 'all', patterns: PATTERNS, book: null, opts: {}, fails: false, json: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--split') args.split = argv[++i]
    else if (a === '--patterns') args.patterns = argv[++i].split(',')
    else if (a === '--book') args.book = argv[++i]
    else if (a === '--opts') args.opts = JSON.parse(argv[++i])
    else if (a === '--fails') args.fails = true
    else if (a === '--json') args.json = argv[++i]
    else throw new Error(`unknown argument ${a}`)
  }
  return args
}

/** Raw ffmpeg lines -> [{start, end}] in file seconds */
function parsePauseFile(text, fileDuration) {
  const pauses = []
  let pending = null
  for (const line of text.split(/\r?\n/)) {
    let m = line.match(/silence_start:\s*(-?[\d.]+(?:e[-+]?\d+)?)/i)
    if (m) {
      pending = Math.max(0, Number(m[1]))
      continue
    }
    m = line.match(/silence_end:\s*(-?[\d.]+(?:e[-+]?\d+)?)/i)
    if (m && pending !== null) {
      const end = Number(m[1])
      if (end > pending) pauses.push({ start: pending, end })
      pending = null
    }
  }
  if (pending !== null && fileDuration > pending) pauses.push({ start: pending, end: fileDuration })
  return pauses
}

const asciiKey = (s) => s.normalize('NFC').replace(/[^\x20-\x7e]/g, '')

function findPauseFolder(relPath) {
  const want = relPath.replace(/\//g, '__')
  const root = Path.join(BENCH_DIR, 'pauses')
  const dirs = fs.readdirSync(root)
  if (dirs.includes(want)) return Path.join(root, want)
  // mojibake folder names: compare the ASCII parts only
  const hit = dirs.find((d) => asciiKey(d) === asciiKey(want))
  if (!hit) throw new Error(`no pause folder for ${relPath}`)
  return Path.join(root, hit)
}

function findPauseFile(folder, filename, single) {
  const files = fs.readdirSync(folder)
  const want = `${filename}.txt`
  if (files.includes(want)) return Path.join(folder, want)
  const hit = files.find((f) => asciiKey(f) === asciiKey(want))
  if (hit) return Path.join(folder, hit)
  if (single && files.length === 1) return Path.join(folder, files[0])
  throw new Error(`no pause file for ${filename} in ${folder}`)
}

function loadBooks(args) {
  const books = []
  for (const file of fs.readdirSync(Path.join(BENCH_DIR, 'items')).filter((f) => f.endsWith('.json'))) {
    const item = JSON.parse(fs.readFileSync(Path.join(BENCH_DIR, 'items', file), 'utf8'))
    const relPath = item.relPath.replace(/\\/g, '/')
    const prodId = TRUTH_MAP[relPath] || Object.entries(TRUTH_MAP).find(([k]) => asciiKey(k) === asciiKey(relPath))?.[1]
    if (!prodId) continue
    const name = relPath.split('/').pop()
    const split = TRAIN.some((t) => name.includes(t)) ? 'train' : 'holdout'
    if (args.split !== 'all' && args.split !== split) continue
    if (args.book && !relPath.toLowerCase().includes(args.book.toLowerCase())) continue

    let truth = JSON.parse(fs.readFileSync(Path.join(TRUTH_DIR, `final-${prodId}.json`), 'utf8'))
    if (truth.chapters) truth = truth.chapters

    const folder = findPauseFolder(relPath)
    const audioFiles = item.media.audioFiles.filter((af) => !af.exclude)
    const filePauses = {}
    const media = audioFiles.map((af) => {
      const path = findPauseFile(folder, af.metadata.filename, audioFiles.length === 1)
      filePauses[path] = parsePauseFile(fs.readFileSync(path, 'utf8'), af.duration)
      return { ...af, metadata: { ...af.metadata, path } }
    })
    const timeline = chapterSnap.buildTimeline(media)
    const T = chapterSnap.computeDuration(timeline, item.media.duration)
    books.push({ name, relPath, split, truth, timeline, T, filePauses, bookPauses: bookLevelPauses(timeline, filePauses) })
  }
  return books.sort((a, b) => (a.split === b.split ? a.name.localeCompare(b.name) : a.split === 'train' ? -1 : 1))
}

/** Full-book pauses >= 0.7 s, merged across file joints (the scoring reference, independent of the windowing) */
function bookLevelPauses(timeline, filePauses, minSilenceSec = 0.7) {
  const all = []
  for (const track of timeline) {
    for (const p of filePauses[track.path]) all.push({ start: track.offset + p.start, end: track.offset + p.end })
  }
  all.sort((a, b) => a.start - b.start)
  const merged = []
  for (const p of all) {
    const last = merged[merged.length - 1]
    if (last && p.start - last.end <= chapterSnap.JOIN_TOL) last.end = Math.max(last.end, p.end)
    else merged.push({ ...p })
  }
  return merged.filter((p) => p.end - p.start >= minSilenceSec)
}

/**
 * Fake silencedetect for a window of one file: the recorded pauses clipped to the window, reported only when the
 * clipped part is at least d long (what ffmpeg sees when it decodes just that window). Times are window relative.
 */
function makeDetect(filePauses) {
  return async ({ path, startSec, durationSec, minSilenceSec }) => {
    const lines = []
    for (const p of filePauses[path]) {
      const s = Math.max(0, p.start - startSec)
      const e = Math.min(durationSec, p.end - startSec)
      if (e <= 0 || s >= durationSec || e - s < minSilenceSec) continue
      lines.push(`[silencedetect @ 0x1] silence_start: ${s.toFixed(6)}`)
      lines.push(`[silencedetect @ 0x1] silence_end: ${e.toFixed(6)} | silence_duration: ${(e - s).toFixed(6)}`)
    }
    return { lines }
  }
}

function targetPause(bookPauses, r) {
  const inside = bookPauses.find((p) => p.start - SLACK <= r && r <= p.end + SLACK)
  if (inside) return inside
  let best = null
  for (const p of bookPauses) {
    if (p.end < r && r - p.end <= SPEECH_TOL) best = p
    if (p.start > r) break
  }
  return best
}

const inPause = (x, p) => !!p && p.start - SLACK <= x && x <= p.end + SLACK

function median(xs) {
  if (!xs.length) return NaN
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

async function benchOne(book, pattern, options) {
  const rng = mulberry32(12345)
  const starts = []
  for (let i = 0; i < book.truth.length; i++) {
    const r = book.truth[i].start
    let x = i === 0 ? 0 : Math.round(damage(pattern, r, rng) * 1000) / 1000
    x = Math.min(Math.max(x, 0), book.T - 0.01)
    if (i > 0 && x <= starts[i - 1] + 0.01) x = r // keep the list valid; rare for very short chapters
    starts.push(x)
  }
  const chapters = chapterSnap.validateChapters(
    starts.map((start, i) => ({ id: i, title: book.truth[i].title, start })),
    book.T
  )
  const response = await chapterSnapRunner.runSnap({
    libraryItemId: book.name,
    timeline: book.timeline,
    T: book.T,
    chapters,
    options,
    detect: makeDetect(book.filePauses),
    deadlineMs: 1e9,
    pool: 4
  })

  const row = { n: 0, correct: 0, exact: 0, bad: 0, noTgt: 0, alreadyOk: 0, regress: 0, dists: [], fails: [] }
  for (let i = 1; i < book.truth.length; i++) {
    const r = book.truth[i].start
    const got = response.chapters[i].proposedStart
    const sent = starts[i]
    const P = targetPause(book.bookPauses, r)
    row.n++
    if (!P) {
      row.noTgt++
      const ok = Math.abs(got - r) <= NO_TARGET_TOL
      if (ok) row.correct++
      else row.bad++
      row.dists.push(Math.abs(got - r))
      if (Math.abs(sent - r) <= NO_TARGET_TOL) {
        row.alreadyOk++
        if (!ok) row.regress++
      }
      if (!ok) row.fails.push({ i, r, sent, got, why: 'noTgt', reason: response.chapters[i].reason })
      continue
    }
    const target = Math.max(P.start, P.end - options.leadSec)
    const ok = inPause(got, P)
    row.dists.push(Math.abs(got - target))
    if (ok) row.correct++
    else row.bad++
    if (Math.abs(got - target) <= EXACT_TOL) row.exact++
    if (inPause(sent, P)) {
      row.alreadyOk++
      if (!ok) row.regress++
    }
    if (!ok) row.fails.push({ i, r, sent, got, P: [P.start, P.end], reason: response.chapters[i].reason, regress: inPause(sent, P) })
  }
  return row
}

const pct = (a, b) => (b ? ((100 * a) / b).toFixed(1) : '-')

function fmtRow(label, pattern, row) {
  return [label.padEnd(30).slice(0, 30), pattern.padEnd(7), String(row.n).padStart(5), pct(row.correct, row.n).padStart(6), pct(row.exact, row.n).padStart(6), String(row.bad).padStart(4), median(row.dists).toFixed(2).padStart(6), `${row.regress}/${row.alreadyOk}`.padStart(8), String(row.noTgt).padStart(5)].join(' ')
}

function addRow(acc, row) {
  for (const k of ['n', 'correct', 'exact', 'bad', 'noTgt', 'alreadyOk', 'regress']) acc[k] = (acc[k] || 0) + row[k]
  acc.dists = (acc.dists || []).concat(row.dists)
  return acc
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const options = chapterSnap.parseOptions(args.opts)
  const books = loadBooks(args)
  const header = ['book'.padEnd(30), 'pattern'.padEnd(7), 'n'.padStart(5), 'corr%'.padStart(6), 'exct%'.padStart(6), 'bad'.padStart(4), 'medD'.padStart(6), 'regr/ok'.padStart(8), 'noTgt'.padStart(5)].join(' ')
  console.log(`options ${JSON.stringify(options)}`)
  console.log(header)
  const totals = {}
  const out = []
  for (const book of books) {
    const bookTotal = {}
    for (const pattern of args.patterns) {
      const row = await benchOne(book, pattern, options)
      out.push({ book: book.name, split: book.split, pattern, ...row, medDist: median(row.dists), dists: undefined })
      console.log(fmtRow(`${book.split === 'train' ? 'T' : 'H'} ${book.name}`, pattern, row))
      if (args.fails) for (const f of row.fails) console.log(`    ${JSON.stringify(f)}`)
      addRow(bookTotal, row)
      const key = `${book.split}|${pattern}`
      totals[key] = addRow(totals[key] || {}, row)
      totals[`${book.split}|ALL`] = addRow(totals[`${book.split}|ALL`] || {}, row)
    }
    console.log(fmtRow(`  = ${book.name}`, 'all', bookTotal))
  }
  console.log('\nTotals')
  console.log(header)
  for (const split of ['train', 'holdout']) {
    for (const pattern of [...args.patterns, 'ALL']) {
      const row = totals[`${split}|${pattern}`]
      if (row) console.log(fmtRow(split.toUpperCase(), pattern, row))
    }
  }
  if (args.json) fs.writeFileSync(args.json, JSON.stringify({ options, rows: out }, null, 1))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
