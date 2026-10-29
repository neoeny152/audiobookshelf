#!/usr/bin/env node
/**
 * Auto pipeline match calibration bench (not part of npm test).
 *
 * Runs the auto pipeline scorer (server/utils/autoPipeline/matchScore.js) over the books of a library that already have
 * an ASIN, with the ASIN hidden: the same Audible search as the pipeline (BookFinder.search, maxFuzzySearches 2, no
 * ASIN), the same top 5 candidates, then pickMatch at several thresholds. For each threshold it reports:
 *   matched  - auto-matched to the known ASIN
 *   false    - auto-matched to ANOTHER ASIN (a false match: the pipeline would have written the wrong book)
 *   review   - stopped for review (low confidence, ambiguous, no match)
 * Ship rule: the false-match rate at the default threshold (95) must be 0. Every false match is listed, so a "false"
 * that is really the same book under another ASIN (a regional or re-released edition) can be told apart.
 *
 * It never writes to the server database: the database file is copied to a temp folder and the copy is read.
 * Search results are cached (--cache) so a rerun does not hit Audible again.
 *
 * Usage:
 *   node scripts/match-bench.js --db <path to absdatabase.sqlite> [--library <name or id>] [--provider audible|audible.uk|...]
 *                               [--cache match-bench-cache.json] [--limit 50] [--thresholds 80,85,90,95,98] [--json out.json] [--verbose]
 */
const fs = require('fs')
const os = require('os')
const Path = require('path')
const { Sequelize } = require('sequelize')

const Logger = require('../server/Logger')
for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal']) Logger[level] = () => {}

const Database = require('../server/Database')
const BookFinder = require('../server/finders/BookFinder')
const { itemForScoring, pickMatch, MAX_CANDIDATES } = require('../server/utils/autoPipeline/matchScore')

function parseArgs(argv) {
  const args = { thresholds: [80, 85, 90, 95, 98], provider: null, limit: Infinity, verbose: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i]
    if (a === '--db') args.db = next()
    else if (a === '--library') args.library = next()
    else if (a === '--provider') args.provider = next()
    else if (a === '--cache') args.cache = next()
    else if (a === '--limit') args.limit = Number(next())
    else if (a === '--thresholds') args.thresholds = next().split(',').map(Number)
    else if (a === '--json') args.json = next()
    else if (a === '--verbose') args.verbose = true
    else throw new Error(`Unknown argument ${a}`)
  }
  if (!args.db) throw new Error('--db <path to absdatabase.sqlite> is required')
  return args
}

async function openCopy(dbPath) {
  const dir = fs.mkdtempSync(Path.join(os.tmpdir(), 'abs-match-bench-'))
  const copy = Path.join(dir, 'absdatabase.sqlite')
  try {
    fs.copyFileSync(dbPath, copy)
    for (const ext of ['-wal', '-shm']) if (fs.existsSync(dbPath + ext)) fs.copyFileSync(dbPath + ext, copy + ext)
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true })
    throw error
  }
  Database.sequelize = new Sequelize({ dialect: 'sqlite', storage: copy, logging: false })
  Database.sequelize.uppercaseFirst = (str) => (str ? `${str[0].toUpperCase()}${str.substr(1)}` : '')
  await Database.buildModels()
  return dir
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const tempDir = await openCopy(args.db)
  const cache = args.cache && fs.existsSync(args.cache) ? JSON.parse(fs.readFileSync(args.cache, 'utf8')) : {}
  try {
    const libraries = await Database.libraryModel.findAll()
    const library = libraries.find((l) => l.mediaType === 'book' && (!args.library || l.id === args.library || l.name === args.library))
    if (!library) throw new Error(`No book library ${args.library ? `"${args.library}"` : ''} found`)
    const provider = args.provider || (String(library.provider).startsWith('audible') ? library.provider : 'audible')

    const rows = await Database.libraryItemModel.findAll({ where: { libraryId: library.id, mediaType: 'book' }, attributes: ['id'] })
    const results = []
    for (const row of rows) {
      if (results.length >= args.limit) break
      const li = await Database.libraryItemModel.getExpandedById(row.id)
      const knownAsin = li?.media?.asin
      if (!knownAsin) continue
      const media = li.media
      const key = `${provider}|${media.title}|${media.authorName}|${Math.round(media.duration || 0)}`
      let candidates = cache[key]
      if (!candidates) {
        // the ASIN stays hidden: the search is the one the pipeline makes for a book without one
        candidates = (await BookFinder.search(li, provider, media.title, media.authorName, media.isbn, null, { maxFuzzySearches: 2 })).slice(0, MAX_CANDIDATES)
        cache[key] = candidates
      }
      const item = itemForScoring(li)
      results.push({ id: li.id, title: media.title, knownAsin, item, candidates })
      if (args.verbose) process.stderr.write(`${media.title}: ${candidates.length} candidates\n`)
    }
    if (args.cache) fs.writeFileSync(args.cache, JSON.stringify(cache, null, 1))

    console.log(`Library "${library.name}", provider ${provider}: ${results.length} books with a known ASIN\n`)
    console.log('threshold  matched  false  review  false-rate')
    const report = { library: library.name, provider, books: results.length, thresholds: {} }
    for (const threshold of args.thresholds) {
      let matched = 0
      let falseMatches = 0
      let review = 0
      const falses = []
      for (const r of results) {
        const decision = pickMatch(r.item, r.candidates, threshold)
        if (decision.result !== 'matched') review++
        else if (decision.asin === r.knownAsin) matched++
        else {
          falseMatches++
          falses.push({ title: r.title, knownAsin: r.knownAsin, matchedAsin: decision.asin, confidence: decision.confidence, matchedTitle: decision.candidates[0]?.title, components: decision.candidates[0]?.components })
        }
      }
      const rate = results.length ? (falseMatches / results.length) * 100 : 0
      console.log(`${String(threshold).padStart(9)}  ${String(matched).padStart(7)}  ${String(falseMatches).padStart(5)}  ${String(review).padStart(6)}  ${rate.toFixed(2).padStart(9)} %`)
      report.thresholds[threshold] = { matched, false: falseMatches, review, falseRate: rate, falses }
    }
    for (const [threshold, t] of Object.entries(report.thresholds)) {
      if (!t.falses.length) continue
      console.log(`\nFalse matches at ${threshold}:`)
      for (const f of t.falses) console.log(`  "${f.title}": known ${f.knownAsin}, matched ${f.matchedAsin} "${f.matchedTitle}" at ${f.confidence} % ${JSON.stringify(f.components)}`)
    }
    const at95 = report.thresholds[95]
    if (at95) console.log(`\nShip rule (false-match rate at 95 is 0): ${at95.false === 0 ? 'PASS' : 'FAIL'}`)
    if (args.json) fs.writeFileSync(args.json, JSON.stringify(report, null, 2))
  } finally {
    await Database.sequelize.close().catch(() => {})
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
