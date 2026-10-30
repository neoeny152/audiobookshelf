#!/usr/bin/env node
/**
 * Offline bench for the whole-book flow (not part of npm test): a reference chapter list (Audible's) is snapped with
 * the speech check exactly as the web client does it (one snap request with verify, then speech batches of 15 with
 * "indexes", merged like the client's mergeSnapSpeechBatch), with the real snap code, the real heading search
 * (chapterLocate) and re-anchoring, against:
 *   - recorded pauses (pauses/<book>/<file>.txt, as snap-bench.js) for silence detection
 *   - a full-book transcript (transcripts/<book>.json: {words: [[start, end, word]]}) standing in for chapterbot
 * and scores every chapter against the truth list (snap-bench.js TRUTH_MAP / SNAP_BENCH_TRUTH).
 *
 * Usage: node scripts/snap-transcript-bench.js --book "Red Rising" [--ref audible|audible-nobrand] [--opts '{...}'] [--rows]
 */
const fs = require('fs')
const Path = require('path')

const Logger = require('../server/Logger')
const chapterSnap = require('../server/utils/chapterSnap')
const chapterSnapRunner = require('../server/utils/chapterSnapRunner')
const chapterLocate = require('../server/utils/chapterLocate')
const { loadBooks, targetPause } = require('./snap-bench')

const BENCH_DIR = process.env.SNAP_BENCH_DIR || 'K:/Dev/_notes/bench'
const BATCH = 15
const MAX_ATTEMPTS = 2
const OK_SEC = 0.5

const quiet = !process.env.SNAP_BENCH_VERBOSE
if (quiet) for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal']) Logger[level] = () => {}

function parseArgs(argv) {
  const args = { book: null, ref: 'audible', opts: {}, rows: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--book') args.book = argv[++i]
    else if (a === '--ref') args.ref = argv[++i]
    else if (a === '--opts') args.opts = JSON.parse(argv[++i])
    else if (a === '--rows') args.rows = true
    else throw new Error(`unknown argument ${a}`)
  }
  if (!args.book) throw new Error('--book is required')
  return args
}

function referenceList(key, kind) {
  const audible = JSON.parse(fs.readFileSync(Path.join(BENCH_DIR, 'refs', `${key}.audible.json`), 'utf8'))
  const intro = (audible.brandIntroDurationMs || 0) / 1000
  return audible.chapters.map((c, i) => {
    let start = c.startOffsetMs / 1000
    if (kind === 'audible-nobrand' && i > 0) start -= intro
    return { id: i, title: c.title, start: Math.round(start * 1000) / 1000 }
  })
}

function fakeChapterbot(words) {
  return {
    mapFiles: (timeline) => timeline.filter((t) => t.duration > 0).map((t) => ({ path: t.path, offset: t.offset, duration: t.duration })),
    transcribe: async ({ ranges }) => ({
      model: 'bench',
      results: ranges.map(({ start, length }) => ({ start, length, text: '', words: words.filter((w) => w[0] >= start && w[0] < start + length) }))
    })
  }
}

/** The client's batch merge: take a batched chapter when it has a verdict and keeps the order */
function mergeBatch(previous, batch, indexes) {
  const chapters = previous.chapters.slice()
  for (const i of indexes) {
    const next = batch.chapters[i]
    if (!next || chapterSnap.SKIP_REASONS.has(next.reason) || !next.speech) continue
    const before = chapters[i - 1]
    const after = chapters[i + 1]
    if (before && !(next.proposedStart >= before.proposedStart + chapterSnap.MIN_GAP - 1e-6)) continue
    if (after && !(after.proposedStart >= next.proposedStart + chapterSnap.MIN_GAP - 1e-6)) continue
    chapters[i] = { ...next, originalStart: previous.chapters[i].originalStart }
  }
  return { ...previous, chapters }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const [book] = loadBooks({ split: 'all', book: args.book })
  if (!book) throw new Error(`no bench book matching ${args.book}`)
  const key = book.relPath.replace(/\//g, '__')
  const { words } = JSON.parse(fs.readFileSync(Path.join(BENCH_DIR, 'transcripts', `${key}.json`), 'utf8'))
  const chapters = referenceList(key, args.ref)
  const options = { ...chapterSnap.DEFAULT_OPTIONS, ...args.opts, verify: true }
  const detect = require('./snap-bench').makeDetect(book.filePauses)
  const client = fakeChapterbot(words)
  const titles = chapters.map((c) => c.title)
  const cacheKey = `bench:${key}:${Date.now()}`
  const snap = (indexes) =>
    chapterSnapRunner.runSnap({
      libraryItemId: 'bench',
      timeline: book.timeline,
      T: book.T,
      chapters: chapterSnap.validateChapters(chapters, book.T),
      indexes,
      options,
      detect,
      verifiers: [options.locate ? chapterLocate.createLocator({ titles, skipReasons: chapterSnap.SKIP_REASONS, leadSec: options.leadSec, cacheKey, client }) : require('../server/utils/chapterbotSpeech').createVerifier({ titles, skipReasons: chapterSnap.SKIP_REASONS, client })]
    })

  const t0 = Date.now()
  let session = await snap(null)
  let requests = 1
  const attempts = new Map()
  for (;;) {
    const pending = session.chapters.filter((c) => c.index > 0 && c.proposedStart >= 1 && !chapterSnap.SKIP_REASONS.has(c.reason) && !c.speech && (attempts.get(c.index) || 0) < MAX_ATTEMPTS).map((c) => c.index)
    if (!pending.length) break
    const batch = pending.slice(0, BATCH)
    for (const i of batch) attempts.set(i, (attempts.get(i) || 0) + 1)
    const response = await snap(new Set(batch))
    requests++
    session = mergeBatch(session, response, batch)
  }

  // score
  const truth = book.truth
  if (truth.length !== chapters.length) console.log(`WARNING: truth has ${truth.length} chapters, reference ${chapters.length}`)
  let ok = 0
  let pauseOk = 0
  const errs = []
  const rows = []
  for (let i = 0; i < Math.min(truth.length, session.chapters.length); i++) {
    const c = session.chapters[i]
    const r = truth[i].start
    // a partial truth (transcript still running) leaves later chapters out
    if (r === null || r === undefined) continue
    const err = c.proposedStart - r
    const P = targetPause(book.bookPauses, r)
    const inP = !!P && P.start - chapterSnap.SLACK <= c.proposedStart && c.proposedStart <= P.end + chapterSnap.SLACK
    const good = Math.abs(err) <= OK_SEC || inP
    if (Math.abs(err) <= OK_SEC) ok++
    if (good) pauseOk++
    errs.push(Math.abs(err))
    rows.push({ i, title: truth[i].title, ref: chapters[i].start, truth: r, proposed: c.proposedStart, err, good, reason: c.reason, heard: c.speech ? (c.speech.heading ? 'heading' : c.speech.late ? 'late' : c.speech.early ? 'early' : c.speech.expected === false ? 'n/a' : 'NOT HEARD') : '-' })
  }
  if (args.rows) {
    for (const r of rows) {
      console.log(`${String(r.i).padStart(3)} ${r.good ? ' ' : 'X'} ${r.title.slice(0, 18).padEnd(18)} ref ${r.ref.toFixed(2).padStart(9)} truth ${r.truth.toFixed(2).padStart(9)} got ${r.proposed.toFixed(2).padStart(9)} err ${r.err.toFixed(2).padStart(8)}  ${r.reason.padEnd(22)} ${r.heard}`)
    }
  }
  errs.sort((a, b) => a - b)
  const refErr = chapters.map((c, i) => Math.abs(c.start - (truth[i]?.start ?? c.start)))
  console.log(`${book.name} ref=${args.ref}: ${pauseOk}/${rows.length} right (in the truth pause or within ${OK_SEC}s), ${ok}/${rows.length} within ${OK_SEC}s, median |err| ${errs[errs.length >> 1].toFixed(2)}s, max ${errs[errs.length - 1].toFixed(2)}s (reference max ${Math.max(...refErr).toFixed(1)}s); ${requests} requests, ${((Date.now() - t0) / 1000).toFixed(1)}s`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
