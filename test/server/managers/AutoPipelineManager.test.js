const { expect } = require('chai')
const { Sequelize } = require('sequelize')
const sinon = require('sinon')
const os = require('os')
const Path = require('path')
const fs = require('fs')
const EventEmitter = require('events')

const Database = require('../../../server/Database')
const ApiRouter = require('../../../server/routers/ApiRouter')
const ApiCacheManager = require('../../../server/managers/ApiCacheManager')
const Auth = require('../../../server/Auth')
const Logger = require('../../../server/Logger')
const SocketAuthority = require('../../../server/SocketAuthority')
const TaskManager = require('../../../server/managers/TaskManager')
const LibraryScanner = require('../../../server/scanner/LibraryScanner')
const ChapterbotEpubManager = require('../../../server/managers/ChapterbotEpubManager')
const chapterSnap = require('../../../server/utils/chapterSnap')
const chapterSnapRunner = require('../../../server/utils/chapterSnapRunner')
const AutoPipelineManager = require('../../../server/managers/AutoPipelineManager')
const { defaultAutoPipelineSettings } = require('../../../server/utils/autoPipeline/settings')
const chapterPlan = require('../../../server/utils/autoPipeline/chapterPlan')

const { AutoPipelineManager: ManagerClass } = AutoPipelineManager

const ASIN = 'B08BX5HZ5M'
const FILE_SEC = 1000
const T = FILE_SEC * 4
/** the real chapter starts of the book (Audible), none at a file joint */
const BOOK_STARTS = [0, 600, 1500, 2300, 3200]
const BOOK_TITLES = ['Opening Credits', 'Chapter 1', 'Chapter 2', 'Chapter 3', 'Chapter 4']
const OLD_MTIME = new Date('2020-01-01T00:00:00Z')

function audibleChapters({ starts = BOOK_STARTS, runtimeMs = T * 1000, titles = BOOK_TITLES, intro = 0, outro = 0, isAccurate = true } = {}) {
  return {
    asin: ASIN,
    chapters: starts.map((s, i) => ({ title: titles[i], startOffsetMs: s * 1000, startOffsetSec: s, lengthMs: ((i + 1 < starts.length ? starts[i + 1] : runtimeMs / 1000) - s) * 1000 })),
    runtimeLengthMs: runtimeMs,
    runtimeLengthSec: runtimeMs / 1000,
    brandIntroDurationMs: intro,
    brandOutroDurationMs: outro,
    isAccurate
  }
}

function candidate(overrides = {}) {
  return {
    title: 'Dungeon Crawler Carl',
    subtitle: null,
    author: 'Matt Dinniman',
    narrator: 'Jeff Hays',
    publisher: 'Soundbooth Theater',
    description: 'A man, his ex-girlfriend’s cat, and a dungeon.',
    cover: null,
    asin: ASIN,
    duration: T / 60,
    series: [{ series: 'Dungeon Crawler Carl', sequence: '1' }],
    ...overrides
  }
}

describe('AutoPipelineManager', () => {
  let manager
  let clock
  let root
  let metadataDir
  let itemDir
  let libraryId
  let folderId
  let apiRouter
  let bookFinder
  let speech
  let speechClient
  let epub
  let emitted
  let detectCalls
  let pauses

  /** Fake ffmpeg silencedetect: a 2.5 s pause around every pause start in `pauses` (book time) */
  function detect({ path, startSec, durationSec }) {
    detectCalls++
    // every book is part0..part3.mp3 of FILE_SEC each
    const track = { offset: Number(/part(\d)\.mp3$/.exec(path)[1]) * FILE_SEC }
    const lines = []
    for (const [s, e] of pauses) {
      const ls = s - track.offset - startSec
      const le = e - track.offset - startSec
      if (le <= 0 || ls >= durationSec) continue
      lines.push(`[silencedetect @ 0x1] silence_start: ${ls.toFixed(4)}`)
      lines.push(`[silencedetect @ 0x1] silence_end: ${le.toFixed(4)} | silence_duration: ${(le - ls).toFixed(4)}`)
    }
    return Promise.resolve({ lines })
  }

  function audioFilesFor(dir, size = 1000) {
    return [0, 1, 2, 3].map((i) => ({
      index: i + 1,
      ino: `ino-${Path.basename(dir)}-${i}`,
      duration: FILE_SEC,
      exclude: false,
      mimeType: 'audio/mpeg',
      metaTags: {},
      metadata: { filename: `part${i}.mp3`, ext: '.mp3', path: `${dir.replace(/\\/g, '/')}/part${i}.mp3`, relPath: `part${i}.mp3`, size }
    }))
  }

  const scannerChapters = () => [0, 1, 2, 3].map((i) => ({ id: i, title: `part${i}`, start: i * FILE_SEC, end: (i + 1) * FILE_SEC }))

  function makeDir(name) {
    const dir = Path.join(metadataDir, 'books', name)
    fs.mkdirSync(dir, { recursive: true })
    for (let i = 0; i < 4; i++) {
      const f = Path.join(dir, `part${i}.mp3`)
      fs.writeFileSync(f, 'x'.repeat(1000))
      fs.utimesSync(f, OLD_MTIME, OLD_MTIME)
    }
    return dir
  }

  async function createItem({ title = 'Dungeon Crawler Carl', asin = null, chapters, dir = itemDir, ebook = false, narrators = ['Jeff Hays'] } = {}) {
    const audioFiles = audioFilesFor(dir)
    const book = await Database.bookModel.create({ title, asin, audioFiles, tags: [], narrators, genres: [], chapters: chapters || scannerChapters(), duration: T, ebookFile: ebook ? { ino: 'ebook', metadata: { filename: 'b.epub', path: `${dir}/b.epub` }, ebookFormat: 'epub' } : null })
    const libraryFiles = audioFiles.map((af) => ({ ino: af.ino, fileType: 'audio', isSupplementary: null, metadata: af.metadata }))
    const li = await Database.libraryItemModel.create({ title, libraryFiles, mediaId: book.id, mediaType: 'book', libraryId, libraryFolderId: folderId, path: dir.replace(/\\/g, '/'), relPath: Path.basename(dir), isFile: false, isMissing: false })
    const author = await Database.authorModel.create({ name: 'Matt Dinniman', libraryId })
    await Database.bookAuthorModel.create({ bookId: book.id, authorId: author.id })
    return li.id
  }

  const getItem = (id) => Database.libraryItemModel.getExpandedById(id)

  async function setLibrarySettings(autoPipeline) {
    const library = await Database.libraryModel.findByPk(libraryId)
    library.settings = { ...library.settings, autoPipeline: { ...library.settings.autoPipeline, ...autoPipeline } }
    library.changed('settings', true)
    await library.save()
    return library
  }

  /** run the worker, jumping the clock over waits, until nothing is left to run */
  async function runAll(maxRounds = 40) {
    for (let round = 0; round < maxRounds; round++) {
      await manager.drain()
      const waiting = [...manager.states.values()].filter((s) => (s.status === 'queued' || s.status === 'waiting' || s.status === 'repairing' || (s.status === 'epub' && s.epub?.result === 'queued')) && s.notBefore > clock)
      if (!waiting.length) return
      clock = Math.min(...waiting.map((s) => s.notBefore))
    }
    throw new Error('runAll: still busy')
  }

  /**
   * Queue items as a scan would. Unless `fresh`, the queue time is moved back past the settle wait (the books were
   * found a while ago), so the tests start at the fingerprint check.
   */
  async function addItems(ids, { fresh = false } = {}) {
    const library = await Database.libraryModel.findByPk(libraryId)
    await manager.onItemsAdded(library, ids)
    if (!fresh) for (const id of ids) if (stateOf(id)) stateOf(id).queuedAt -= 10 * 60 * 1000
  }

  const stateOf = (id) => manager.states.get(id)
  const events = (name) => emitted.filter((e) => e[0] === name).map((e) => e[1])

  class FakeEpubManager extends EventEmitter {
    constructor() {
      super()
      this.isConfigured = true
      this.records = new Map()
      this.busy = 0
      this.n = 0
      this.start = sinon.spy(async (libraryItem, user, opts) => {
        if (this.busy > 0) {
          this.busy--
          throw new ChapterbotEpubManager.EpubJobError(429, 'Chapterbot already has too many EPUB jobs queued, try again later')
        }
        const job = { jobId: `job-${++this.n}`, libraryItemId: libraryItem.id, status: 'queued', origin: opts?.origin, error: null, fileName: null }
        this.records.set(libraryItem.id, job)
        return { ...job }
      })
    }

    getRecord(id) {
      return this.records.get(id) || null
    }

    toJSON(record) {
      return { ...record }
    }

    async end(libraryItemId, status, extra = {}) {
      const job = this.records.get(libraryItemId)
      Object.assign(job, { status, ...extra })
      await Promise.all(this.listeners('ended').map((l) => l({ ...job })))
    }
  }

  async function newManager() {
    const m = new ManagerClass()
    m.now = () => clock
    m.autoRun = false
    m.bookFinder = bookFinder
    m.epubManager = epub
    m.speechClient = speechClient
    m.detect = detect
    await m.init(apiRouter, { root, gate: true })
    return m
  }

  beforeEach(async () => {
    clock = Date.parse('2026-10-28T12:00:00Z')
    detectCalls = 0
    pauses = BOOK_STARTS.slice(1).map((t) => [t - 2, t + 0.5])
    metadataDir = fs.mkdtempSync(Path.join(os.tmpdir(), 'abs-pipeline-'))
    root = Path.join(metadataDir, 'pipeline')
    global.MetadataPath = metadataDir
    global.ServerSettings = { storeMetadataWithItem: false, metadataFileFormat: 'json' }

    Database.sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false })
    Database.sequelize.uppercaseFirst = (str) => (str ? `${str[0].toUpperCase()}${str.substr(1)}` : '')
    await Database.buildModels()
    sinon.stub(Database, 'serverSettings').value({ scannerPreferMatchedMetadata: false })
    apiRouter = new ApiRouter({ auth: new Auth(), apiCacheManager: new ApiCacheManager() })

    sinon.stub(Logger, 'info')
    sinon.stub(Logger, 'warn')
    sinon.stub(Logger, 'error')
    sinon.stub(Logger, 'debug')
    emitted = []
    sinon.stub(SocketAuthority, 'emitter').callsFake((evt, data) => emitted.push([evt, data]))
    sinon.stub(SocketAuthority, 'libraryItemEmitter').callsFake((evt, li) => emitted.push([evt, { id: li.id }]))

    const settings = { ...Database.libraryModel.getDefaultLibrarySettingsForMediaType('book'), autoPipeline: { ...defaultAutoPipelineSettings(), mode: 'on', autoEpub: true } }
    // scanned before: the first scan of a library queues nothing
    const library = await Database.libraryModel.create({ name: 'Books', mediaType: 'book', provider: 'audible', settings, lastScan: clock - 24 * 3600 * 1000 })
    const folder = await Database.libraryFolderModel.create({ path: metadataDir, libraryId: library.id })
    libraryId = library.id
    folderId = folder.id
    itemDir = makeDir('dcc')

    bookFinder = {
      results: [candidate()],
      chapters: audibleChapters(),
      search: sinon.spy(async () => bookFinder.results.map((r) => ({ ...r }))),
      findChapters: sinon.spy(async () => bookFinder.chapters)
    }
    // what the fake Whisper hears: the chapter title right after each start
    speech = { busyCalls: 0, failCalls: 0, late: new Set(), headingFor: (start) => BOOK_TITLES[BOOK_STARTS.findIndex((s) => Math.abs(s - start) < 0.01)] || 'Something else' }
    speechClient = {
      configured: true,
      isConfigured: () => speechClient.configured,
      mapFiles: (timeline) => timeline.filter((t) => t.duration > 0).map((t) => ({ path: t.path, offset: t.offset, duration: t.duration })),
      verify: sinon.spy(async ({ starts }) => {
        if (speech.busyCalls > 0) {
          speech.busyCalls--
          throw Object.assign(new Error('busy'), { status: 503 })
        }
        return {
          model: 'fake',
          results: starts.map((start) => {
            const title = speech.headingFor(start)
            if (speech.late.has(title)) return { start, before: `and so it ended. ${title}.`, after: 'The rain fell on the dungeon floor for a long time.' }
            return { start, before: 'and so it ended.', after: `${title}. The rain fell on the dungeon floor.` }
          })
        }
      })
    }
    epub = new FakeEpubManager()
    manager = await newManager()
  })

  afterEach(async () => {
    await manager.reset()
    await AutoPipelineManager.reset()
    sinon.restore()
    LibraryScanner.libraryLocks.clear()
    chapterSnapRunner._runningJobs.clear()
    TaskManager.tasks = []
    await Database.sequelize.close()
    fs.rmSync(metadataDir, { recursive: true, force: true })
  })

  describe('new item -> done', () => {
    it('waits for the files, matches, applies snapped and speech-checked Audible chapters and starts the EPUB', async () => {
      const id = await createItem()
      await addItems([id])
      expect(stateOf(id)).to.include({ status: 'queued', step: 'waiting', dryRun: false, trigger: 'scan' })

      // first fingerprint check, then a second one a minute later
      await manager.drain()
      expect(stateOf(id)).to.include({ status: 'waiting', reason: 'checking that the files are complete' })
      expect(bookFinder.search.called).to.equal(false)
      clock += 60 * 1000
      await manager.drain()

      const state = stateOf(id)
      expect(state.match).to.include({ result: 'matched', asin: ASIN, confidence: 100, applied: true })
      expect(state.chapters).to.include({ result: 'applied', count: 5 })
      expect(state).to.include({ status: 'epub' })
      expect(state.epub).to.deep.equal({ result: 'running', jobId: 'job-1' })

      const li = await getItem(id)
      expect(li.media.asin).to.equal(ASIN)
      expect(li.media.chapters.map((c) => [c.title, c.start])).to.deep.equal(BOOK_TITLES.map((t, i) => [t, BOOK_STARTS[i]]))
      expect(state.chapters.appliedHash).to.equal(chapterPlan.chaptersHash(li.media.chapters))
      expect(bookFinder.findChapters.calledOnceWith(ASIN, 'us')).to.equal(true)
      // every chapter after the first was speech checked, in one chunk
      expect(speechClient.verify.callCount).to.equal(1)
      expect(speechClient.verify.firstCall.args[0].starts).to.deep.equal(BOOK_STARTS.slice(1))

      // backup of the scanner chapters
      const backups = await manager.listBackups(id)
      expect(backups).to.have.length(1)
      expect(backups[0]).to.include({ chapters: 4, source: 'audible:aligned', reason: 'auto' })
      // the metadata file has the chapters (they survive rescans)
      const metadata = JSON.parse(fs.readFileSync(Path.join(metadataDir, 'items', id, 'metadata.json'), 'utf8'))
      expect(metadata.asin).to.equal(ASIN)
      expect(metadata.chapters).to.have.length(5)

      // EPUB started by the pipeline (no user)
      expect(epub.start.calledOnce).to.equal(true)
      expect(epub.start.firstCall.args[1]).to.equal(null)
      expect(epub.start.firstCall.args[2]).to.deep.equal({ origin: 'pipeline' })

      await epub.end(id, 'done', { fileName: 'Dungeon Crawler Carl (from audio).epub' })
      expect(stateOf(id)).to.include({ status: 'done' })
      expect(stateOf(id).reason).to.equal(`matched ${ASIN} at 100 %, 5 chapters applied, EPUB "Dungeon Crawler Carl (from audio).epub"`)

      // persisted, tasks shown in the stock task list, sockets for the processing page
      const onDisk = JSON.parse(fs.readFileSync(Path.join(root, id, 'state.json'), 'utf8'))
      expect(onDisk.status).to.equal('done')
      const tasks = events('task_started').map((t) => t.title)
      expect(tasks).to.include('Auto pipeline: matching - Dungeon Crawler Carl')
      expect(tasks).to.include('Auto pipeline: chapters - Dungeon Crawler Carl')
      expect(tasks).to.include('Auto pipeline: epub - Dungeon Crawler Carl')
      expect(events('pipeline_item_updated').map((s) => s.status)).to.include.members(['queued', 'waiting', 'matching', 'chapters', 'epub', 'done'])
      expect(events('item_updated').length).to.be.at.least(2)
      expect(TaskManager.tasks).to.have.length(0)
    })

    it('a debranded Audible chapter list is used when it fits the audio', async () => {
      // Audible runtime includes 2 s intro and 3 s outro the file does not have
      bookFinder.chapters = audibleChapters({ starts: [0, 602, 1502, 2302, 3202], runtimeMs: (T + 5) * 1000, intro: 2000, outro: 3000 })
      const id = await createItem()
      await addItems([id])
      await runAll()
      expect(stateOf(id).chapters.source).to.include({ kind: 'aligned', variant: 'debranded' })
      const li = await getItem(id)
      expect(li.media.chapters.map((c) => c.start)).to.deep.equal(BOOK_STARTS)
    })

    it('a second run over chapters the pipeline applied keeps them without writing anything', async () => {
      const id = await createItem({ asin: ASIN })
      await setLibrarySettings({ autoEpub: false })
      await addItems([id])
      await runAll()
      expect(stateOf(id).chapters.result).to.equal('applied')
      const updates = events('item_updated').length

      await manager.runItem(await getItem(id), await Database.libraryModel.findByPk(libraryId))
      await runAll()
      // recognised as the pipeline's own chapters (not a person's edit), checked again and found right
      expect(stateOf(id).chapters).to.include({ result: 'kept', reason: 'already-correct', current: 'pipeline' })
      expect(stateOf(id).status).to.equal('done')
      expect(await manager.listBackups(id)).to.have.length(1)
      expect(events('item_updated')).to.have.length(updates)
    })

    it('chapters equal to Audible that the pipeline did not make count as edited by a person and are kept', async () => {
      const chapters = BOOK_STARTS.map((s, i) => ({ id: i, title: BOOK_TITLES[i], start: s, end: i + 1 < BOOK_STARTS.length ? BOOK_STARTS[i + 1] : T }))
      const id = await createItem({ asin: ASIN, chapters })
      await setLibrarySettings({ autoEpub: false })
      await addItems([id])
      await runAll()
      expect(stateOf(id).chapters).to.include({ result: 'kept', reason: 'user-edited' })
      expect(events('item_updated')).to.have.length(0)
    })
  })

  describe('waiting', () => {
    it('does nothing while files are still being copied, and restarts the check when they change', async () => {
      const id = await createItem()
      const now = new Date(clock)
      fs.utimesSync(Path.join(itemDir, 'part3.mp3'), now, now)
      await addItems([id])
      await manager.drain()
      expect(stateOf(id)).to.include({ status: 'waiting', reason: 'waiting for the files to settle' })
      expect(stateOf(id).notBefore).to.equal(clock + 5 * 60 * 1000)

      // settled; first check
      clock += 5 * 60 * 1000
      await manager.drain()
      expect(stateOf(id).reason).to.equal('checking that the files are complete')
      // a file grows before the second check: the check starts over (and the new mtime has to settle again)
      fs.appendFileSync(Path.join(itemDir, 'part3.mp3'), 'more')
      const later = new Date(clock - 6 * 60 * 1000)
      fs.utimesSync(Path.join(itemDir, 'part3.mp3'), later, later)
      clock += 60 * 1000
      await manager.drain()
      expect(stateOf(id).reason).to.equal('checking that the files are complete')
      expect(bookFinder.search.called).to.equal(false)
      clock += 60 * 1000
      await manager.drain()
      expect(bookFinder.search.calledOnce).to.equal(true)
    })

    it('waits while the library is being scanned', async () => {
      const id = await createItem()
      LibraryScanner.libraryLocks.set(libraryId, Promise.resolve())
      await addItems([id])
      await manager.drain()
      expect(stateOf(id).reason).to.equal('waiting for the library scan to finish')
      LibraryScanner.libraryLocks.delete(libraryId)
      await runAll()
      expect(stateOf(id).status).to.equal('epub')
    })
  })

  describe('gates', () => {
    it('ignores new items when the library mode is off, the server gate is off or the library holds podcasts', async () => {
      const id = await createItem()
      await setLibrarySettings({ mode: 'off' })
      await addItems([id])
      expect(manager.states.size).to.equal(0)

      await setLibrarySettings({ mode: 'on' })
      manager.gate = false
      await addItems([id])
      expect(manager.states.size).to.equal(0)
      manager.gate = true

      await manager.onItemsAdded({ id: libraryId, mediaType: 'podcast', settings: { autoPipeline: { mode: 'on' } } }, [id])
      expect(manager.states.size).to.equal(0)
    })

    it('a manual run works while the mode is off', async () => {
      const id = await createItem()
      const library = await setLibrarySettings({ mode: 'off', autoEpub: false })
      const state = await manager.runItem(await getItem(id), library)
      expect(state).to.include({ trigger: 'manual', manual: true, dryRun: false })
      await runAll()
      // manual runs do not wait for the files to settle
      expect(stateOf(id)).to.include({ status: 'done' })
      expect(stateOf(id).chapters.result).to.equal('applied')
    })
  })

  describe('matching', () => {
    it('low confidence stops for review and changes nothing', async () => {
      bookFinder.results = [candidate({ author: 'Somebody Else', asin: 'B0WRONG001' }), candidate({ title: 'Another Book', asin: 'B0WRONG002' })]
      const id = await createItem()
      await addItems([id])
      await runAll()
      const state = stateOf(id)
      expect(state).to.include({ status: 'needs-review', reason: 'match: low-confidence' })
      expect(state.match.candidates).to.have.length(2)
      expect(state.match.confidence).to.be.below(95)
      expect(bookFinder.findChapters.called).to.equal(false)
      expect(epub.start.called).to.equal(false)
      const li = await getItem(id)
      expect(li.media.asin).to.equal(null)
      expect(li.media.chapters).to.have.length(4)
    })

    it('two editions close together stop as ambiguous', async () => {
      bookFinder.results = [candidate({ asin: 'B0EDITION1' }), candidate({ asin: 'B0EDITION2', narrator: 'Jeff Hays' })]
      const id = await createItem({ narrators: [] })
      await addItems([id])
      await runAll()
      expect(stateOf(id)).to.include({ status: 'needs-review', reason: 'match: ambiguous' })
    })

    it('never matches an item that already has an ASIN, and uses that ASIN for the chapters', async () => {
      const id = await createItem({ asin: 'B0MANUAL01' })
      await addItems([id])
      await runAll()
      expect(bookFinder.search.called).to.equal(false)
      expect(stateOf(id).match).to.deep.equal({ result: 'existing-asin', asin: 'B0MANUAL01' })
      expect(bookFinder.findChapters.calledOnceWith('B0MANUAL01', 'us')).to.equal(true)
      expect((await getItem(id)).media.asin).to.equal('B0MANUAL01')
    })

    it('does not overwrite an ASIN set while the search ran', async () => {
      const id = await createItem()
      bookFinder.search = sinon.spy(async () => {
        const li = await getItem(id)
        li.media.asin = 'B0SETMEANW'
        await li.media.save()
        return [candidate()]
      })
      await addItems([id])
      await runAll()
      expect(stateOf(id).match).to.include({ result: 'existing-asin', asin: 'B0SETMEANW' })
      expect((await getItem(id)).media.asin).to.equal('B0SETMEANW')
    })

    it('a provider that is not Audible skips matching and chapters', async () => {
      const library = await Database.libraryModel.findByPk(libraryId)
      library.provider = 'google'
      await library.save()
      const id = await createItem()
      await addItems([id])
      await runAll()
      expect(stateOf(id).match).to.include({ result: 'skipped', reason: 'provider' })
      expect(stateOf(id).chapters).to.include({ result: 'skipped', reason: 'provider' })
      expect(stateOf(id).status).to.equal('done')
      expect(epub.start.called).to.equal(false)
      // autoMatchProvider overrides the library provider
      await setLibrarySettings({ autoMatchProvider: 'audible.uk' })
      await manager.runItem(await getItem(id), await Database.libraryModel.findByPk(libraryId))
      await runAll()
      expect(bookFinder.search.firstCall.args[1]).to.equal('audible.uk')
      expect(bookFinder.findChapters.firstCall.args).to.deep.equal([ASIN, 'uk'])
    })
  })

  describe('chapters', () => {
    it('never touches chapters a person edited', async () => {
      const edited = scannerChapters().map((c, i) => ({ ...c, title: `My title ${i}` }))
      const id = await createItem({ asin: ASIN, chapters: edited })
      await addItems([id])
      await runAll()
      expect(stateOf(id).chapters).to.include({ result: 'kept', reason: 'user-edited' })
      expect(detectCalls).to.equal(0)
      // the EPUB still runs (the chapters are kept)
      expect(epub.start.calledOnce).to.equal(true)
      expect((await getItem(id)).media.chapters.map((c) => c.title)).to.deep.equal(edited.map((c) => c.title))
    })

    it('force analyses edited chapters but only through review', async () => {
      const edited = scannerChapters().map((c, i) => ({ ...c, title: `My title ${i}` }))
      const id = await createItem({ asin: ASIN, chapters: edited })
      const library = await Database.libraryModel.findByPk(libraryId)
      await manager.runItem(await getItem(id), library, { force: true })
      await runAll()
      expect(stateOf(id)).to.include({ status: 'needs-review' })
      expect(stateOf(id).chapters.blockers).to.include('user-edited')
      expect((await getItem(id)).media.chapters.map((c) => c.title)).to.deep.equal(edited.map((c) => c.title))
    })

    it('clearly bad edited chapters are proposed for review, never applied', async () => {
      const id = await createItem({ asin: ASIN, chapters: [{ id: 0, title: 'Whole book', start: 0, end: T }] })
      await addItems([id])
      await runAll()
      expect(stateOf(id).status).to.equal('needs-review')
      expect(stateOf(id).chapters.blockers).to.include.members(['user-edited', 'current-one-chapter'])
      expect((await getItem(id)).media.chapters).to.have.length(1)
    })

    it('LATE starts go to review with the full proposal; approve applies it, backs up and continues to the EPUB', async () => {
      speech.late.add('Chapter 2')
      const id = await createItem()
      await addItems([id])
      await runAll()
      const state = stateOf(id)
      expect(state).to.include({ status: 'needs-review' })
      expect(state.reason).to.match(/^chapters: 4 applied, 1 need review \(.*1 LATE/)
      expect(epub.start.called).to.equal(false)
      // the matched ASIN stays; the chapters that passed are applied, the LATE one keeps its Audible start
      const li = await getItem(id)
      expect(li.media.asin).to.equal(ASIN)
      expect(li.media.chapters.map((c) => [c.title, c.start])).to.deep.equal(BOOK_TITLES.map((t, i) => [t, BOOK_STARTS[i]]))

      const proposal = await manager.getProposal(id)
      expect(proposal.source).to.include({ kind: 'aligned', asin: ASIN })
      expect(proposal.failing).to.deep.equal([{ index: 2, why: ['confidence-low', 'late', 'heading-not-heard'] }])
      expect(proposal.snap.chapters[2].speech).to.include({ late: true })
      expect(proposal.snap.chapters[1].speech).to.include({ heading: true })
      expect(proposal.proposedChapters).to.have.length(5)

      // edited chapters from the review UI
      const edited = proposal.proposedChapters.map((c) => ({ ...c }))
      edited[2].start = 1490
      edited[1].end = 1490
      const approved = await manager.approve(id, edited)
      expect(approved.chapters).to.include({ result: 'approved', edited: true, count: 5 })
      expect(approved).to.include({ status: 'epub' })
      expect((await getItem(id)).media.chapters[2].start).to.equal(1490)
      expect(await manager.getProposal(id)).to.equal(null)
      expect(await manager.listBackups(id)).to.have.length(2)
      await runAll()
      expect(epub.start.calledOnce).to.equal(true)

      // chapters edited in the review count as a person's: a later run keeps them
      expect(stateOf(id).chapters.appliedHash).to.equal(null)
      await epub.end(id, 'done', { fileName: 'x.epub' })
      speech.late.clear()
      await manager.runItem(await getItem(id), await Database.libraryModel.findByPk(libraryId), { steps: ['chapters'] })
      await runAll()
      expect(stateOf(id).chapters).to.include({ result: 'kept', reason: 'user-edited' })
      expect((await getItem(id)).media.chapters[2].start).to.equal(1490)
    })

    it('reject keeps the chapters; with continue the EPUB step still runs', async () => {
      speech.late.add('Chapter 2')
      const id = await createItem()
      await addItems([id])
      await runAll()
      const rejected = await manager.reject(id, { continue: true })
      expect(rejected.chapters.result).to.equal('rejected')
      await runAll()
      expect(epub.start.calledOnce).to.equal(true)
      // the chapters applied before the review stay
      expect((await getItem(id)).media.chapters).to.have.length(5)

      const id2 = await createItem({ dir: makeDir('other'), title: 'Dungeon Crawler Carl' })
      await addItems([id2])
      await runAll()
      expect((await manager.reject(id2)).status).to.equal('done')
      expect(epub.start.calledOnce).to.equal(true)
    })

    it('approve and reject refuse when there is nothing to review', async () => {
      const id = await createItem()
      let error
      try {
        await manager.approve(id)
      } catch (e) {
        error = e
      }
      expect(error).to.be.instanceOf(AutoPipelineManager.PipelineError)
      expect(error.status).to.equal(409)
    })

    it('without a usable Audible source and without scanner chapters it needs review', async () => {
      bookFinder.chapters = audibleChapters({ runtimeMs: (T + 120) * 1000 })
      const id = await createItem({ asin: ASIN, chapters: [{ id: 0, title: 'part0', start: 0, end: T }] })
      // one embedded chapter in one file is what the scanner makes; here there are 4 files, so it is a user chapter that is clearly bad
      await addItems([id])
      await runAll()
      expect(stateOf(id).status).to.equal('needs-review')
    })

    it('falls back to checking scanner chapters when Audible does not fit', async () => {
      bookFinder.chapters = audibleChapters({ runtimeMs: (T + 120) * 1000 })
      pauses = [1000, 2000, 3000].map((t) => [t - 2, t + 0.5])
      speech.headingFor = (start) => `part${Math.round(start / FILE_SEC)}`
      const id = await createItem({ asin: ASIN })
      await setLibrarySettings({ autoEpub: false })
      await addItems([id])
      await runAll()
      expect(stateOf(id).chapters.source).to.include({ kind: 'scanner', fallbackFrom: 'mismatch' })
      expect(stateOf(id).chapters).to.include({ result: 'kept', reason: 'already-correct' })
    })

    it('a near Audible source (within 30 s) is never applied without review', async () => {
      bookFinder.chapters = audibleChapters({ runtimeMs: (T + 20) * 1000 })
      const id = await createItem({ asin: ASIN })
      await addItems([id])
      await runAll()
      expect(stateOf(id).status).to.equal('needs-review')
      expect(stateOf(id).chapters.blockers).to.include('source-near')
    })

    it('does not snap while MP3 files need a seek index repair, and never repairs them itself', async () => {
      const getStatus = sinon.stub().resolves({ needsRepairCount: 2, maxDrift: 43.38 })
      const startRepair = sinon.stub()
      apiRouter.mp3SeekIndexManager = { getStatus, startRepair }
      const id = await createItem({ asin: ASIN })
      await addItems([id])
      await runAll()
      expect(stateOf(id).status).to.equal('needs-review')
      expect(stateOf(id).chapters).to.include({ result: 'needs-review', reason: 'needs-seek-index-repair' })
      expect(stateOf(id).chapters.seekIndex).to.deep.equal({ files: 2, maxDrift: 43.4 })
      expect(detectCalls).to.equal(0)
      expect(startRepair.called).to.be.false
      expect((await getItem(id)).media.chapters).to.have.length(4)
    })

    it('without chapterbot the chapters always go to review', async () => {
      speechClient.configured = false
      const id = await createItem()
      await addItems([id])
      await runAll()
      expect(stateOf(id)).to.include({ status: 'needs-review' })
      expect(stateOf(id).chapters.blockers).to.include('speech-check-unavailable')
      expect((await getItem(id)).media.chapters).to.have.length(4)
    })

    it('a busy sidecar backs off and retries only the speech check', async () => {
      speech.busyCalls = 2
      const id = await createItem()
      await addItems([id])
      await manager.drain()
      clock += 60 * 1000
      await manager.drain()
      expect(stateOf(id)).to.include({ status: 'queued', step: 'chapters', reason: 'chapterbot busy, speech check retry 1 of 5' })
      expect(stateOf(id).notBefore).to.equal(clock + 2 * 60 * 1000)
      const snapCalls = detectCalls
      expect(snapCalls).to.be.above(0)

      clock += 2 * 60 * 1000
      await manager.drain()
      expect(stateOf(id).reason).to.equal('chapterbot busy, speech check retry 2 of 5')
      expect(stateOf(id).notBefore).to.equal(clock + 5 * 60 * 1000)

      clock += 5 * 60 * 1000
      await manager.drain()
      expect(stateOf(id).chapters.result).to.equal('applied')
      // the silence detection ran once
      expect(detectCalls).to.equal(snapCalls)
      expect(fs.existsSync(Path.join(root, id, 'analysis.json'))).to.equal(false)
    })

    it('gives up after 6 tries: needs review, speech check unavailable', async () => {
      speech.busyCalls = 100
      const id = await createItem()
      await addItems([id])
      await runAll()
      expect(stateOf(id)).to.include({ status: 'needs-review' })
      expect(stateOf(id).chapters.blockers).to.include('speech-check-unavailable')
      expect(speechClient.verify.callCount).to.equal(6)
    })

    it('waits for a free chapter snap slot', async () => {
      const a = chapterSnapRunner.acquire('other-1', 'u1')
      const b = chapterSnapRunner.acquire('other-2', 'u2')
      const id = await createItem({ asin: ASIN })
      await addItems([id])
      await manager.drain()
      clock += 60 * 1000
      await manager.drain()
      expect(stateOf(id)).to.include({ status: 'queued', step: 'chapters', reason: 'waiting for a chapter snap slot' })
      a.release()
      b.release()
      await runAll()
      expect(stateOf(id).chapters.result).to.equal('applied')
    })

    it('runs the snap again for not-analysed chapters (retry contract)', async () => {
      const real = chapterSnapRunner.runSnap
      const calls = []
      manager.snapRunner = {
        acquire: chapterSnapRunner.acquire,
        runSnap: async (params) => {
          calls.push(params.indexes ? [...params.indexes] : null)
          // the first round runs out of time after the first segments
          return real({ ...params, deadlineMs: calls.length === 1 ? 0 : params.deadlineMs })
        }
      }
      const id = await createItem({ asin: ASIN })
      await setLibrarySettings({ autoEpub: false })
      await addItems([id])
      await runAll()
      expect(calls[0]).to.equal(null)
      expect(calls[1]).to.deep.equal([1, 2, 3, 4])
      expect(stateOf(id).chapters.result).to.equal('applied')
    })

    it('throws the analysis away when the audio changed before the chapters are applied', async () => {
      const id = await createItem({ asin: ASIN })
      let changed = false
      let firstPass = 0
      const original = speechClient.verify
      speechClient.verify = sinon.spy(async (args) => {
        if (!changed) {
          changed = true
          firstPass = detectCalls
          const li = await getItem(id)
          li.media.audioFiles = li.media.audioFiles.map((af, i) => (i === 3 ? { ...af, metadata: { ...af.metadata, size: 2000 } } : af))
          li.media.changed('audioFiles', true)
          await li.media.save()
        }
        return original(args)
      })
      await addItems([id])
      await manager.drain()
      clock += 60 * 1000
      await manager.drain()
      // first pass: analysed, the apply saw another fingerprint and queued the step again; second pass applied
      expect(stateOf(id).chapters.result).to.equal('applied')
      expect(firstPass).to.be.above(0)
      expect(detectCalls).to.equal(firstPass * 2)
      expect(await manager.listBackups(id)).to.have.length(1)
    })
  })

  describe('EPUB', () => {
    it('one pipeline EPUB job at a time; the next one starts when it ends', async () => {
      const id1 = await createItem()
      const id2 = await createItem({ dir: makeDir('two') })
      await addItems([id1, id2])
      await runAll()
      expect(epub.start.callCount).to.equal(1)
      expect(stateOf(id1)).to.include({ status: 'epub' })
      expect(stateOf(id1).epub.result).to.equal('running')
      expect(stateOf(id2)).to.include({ status: 'epub', reason: 'waiting for the EPUB lane' })
      expect(stateOf(id2).epub).to.deep.equal({ result: 'queued' })
      expect(stateOf(id2).chapters.result).to.equal('applied')

      await epub.end(id1, 'failed', { error: 'Chapterbot: audio_failed' })
      expect(stateOf(id1)).to.include({ status: 'failed', reason: 'EPUB failed: Chapterbot: audio_failed' })
      await runAll()
      expect(epub.start.callCount).to.equal(2)
      expect(stateOf(id2).epub.result).to.equal('running')
    })

    it('backs off while chapterbot has too many jobs', async () => {
      epub.busy = 1
      const id = await createItem({ asin: ASIN })
      await addItems([id])
      await manager.drain()
      clock += 60 * 1000
      await manager.drain()
      expect(stateOf(id)).to.include({ status: 'epub', reason: 'chapterbot busy, EPUB retry 1 of 6' })
      expect(stateOf(id).epub).to.deep.equal({ result: 'queued', tries: 1 })
      await runAll()
      expect(stateOf(id).epub.result).to.equal('running')
    })

    it('skips a book that already has an ebook', async () => {
      const id = await createItem({ asin: ASIN, ebook: true })
      await addItems([id])
      await runAll()
      expect(stateOf(id)).to.include({ status: 'done' })
      expect(stateOf(id).epub).to.deep.equal({ result: 'skipped', reason: 'has-ebook' })
      expect(epub.start.called).to.equal(false)
    })
  })

  describe('dry run', () => {
    it('runs every read step and writes nothing to the item', async () => {
      await setLibrarySettings({ mode: 'dryRun' })
      const id = await createItem()
      const before = await getItem(id)
      await addItems([id])
      await runAll()
      const state = stateOf(id)
      expect(state).to.include({ status: 'done', dryRun: true })
      expect(state.would).to.equal(`would match ${ASIN} at 100 %; would apply 5 chapters; would build an EPUB`)
      expect(bookFinder.findChapters.calledOnceWith(ASIN, 'us')).to.equal(true)
      expect(speechClient.verify.called).to.equal(true)
      expect(detectCalls).to.be.above(0)

      const after = await getItem(id)
      expect(after.media.asin).to.equal(null)
      expect(after.media.chapters).to.deep.equal(before.media.chapters)
      expect(after.media.title).to.equal(before.media.title)
      expect(epub.start.called).to.equal(false)
      expect(await manager.listBackups(id)).to.have.length(0)
      expect(events('item_updated')).to.have.length(0)
      expect(fs.existsSync(Path.join(metadataDir, 'items', id))).to.equal(false)
      expect(fs.readdirSync(itemDir).sort()).to.deep.equal(['part0.mp3', 'part1.mp3', 'part2.mp3', 'part3.mp3'])
    })

    it('reports a review it would need, and cannot be approved', async () => {
      await setLibrarySettings({ mode: 'dryRun' })
      speech.late.add('Chapter 3')
      const id = await createItem()
      await addItems([id])
      await runAll()
      expect(stateOf(id)).to.include({ status: 'needs-review', dryRun: true })
      expect(stateOf(id).would).to.equal('would match B08BX5HZ5M at 100 %; would apply 4 chapters, 1 wait for review')
      expect((await getItem(id)).media.chapters).to.have.length(4)
      let error
      try {
        await manager.approve(id)
      } catch (e) {
        error = e
      }
      expect(error.status).to.equal(409)
    })

    it('switching from dry run to on clears the dry-run results', async () => {
      await setLibrarySettings({ mode: 'dryRun' })
      const id = await createItem()
      await addItems([id])
      await runAll()
      expect(manager.states.has(id)).to.equal(true)
      const library = await setLibrarySettings({ mode: 'on' })
      await manager.onLibrarySettingsChanged(library, { ...defaultAutoPipelineSettings(), mode: 'dryRun' })
      expect(manager.states.has(id)).to.equal(false)
      expect(fs.existsSync(Path.join(root, id, 'state.json'))).to.equal(false)
      // a manual run queues it again, for real now
      await manager.runLibrary(library, 'unprocessed')
      expect(stateOf(id)).to.include({ dryRun: false, status: 'queued' })
    })
  })

  describe('restart', () => {
    it('a step that was running starts again after a restart', async () => {
      const id = await createItem({ asin: ASIN })
      await setLibrarySettings({ autoEpub: false })
      // the snap never returns: the server "stops" in the middle of the chapters step
      let hung = null
      manager.snapRunner = { acquire: () => ({ ok: true, release: () => {} }), runSnap: () => new Promise((resolve, reject) => (hung = reject)) }
      await addItems([id])
      await manager.drain()
      clock += 60 * 1000
      const stuck = manager.drain()
      // wait for the snap to start (a fixed sleep was flaky under load)
      for (let i = 0; i < 100 && !hung; i++) await new Promise((r) => setTimeout(r, 10))
      expect(hung).to.be.a('function')
      const onDisk = JSON.parse(fs.readFileSync(Path.join(root, id, 'state.json'), 'utf8'))
      expect(onDisk).to.include({ status: 'chapters', step: 'chapters' })

      // new process
      const restarted = await newManager()
      expect(restarted.states.get(id)).to.include({ status: 'queued', step: 'chapters', reason: 'resumed after a restart' })
      await restarted.drain()
      expect(restarted.states.get(id).chapters.result).to.equal('applied')
      await restarted.reset()

      hung(new Error('server stopped')) // let the old worker end
      await stuck.catch(() => {})
    })

    it('a restart in the middle of the speech check keeps the snap and the checked chapters', async () => {
      speech.busyCalls = 1
      const id = await createItem({ asin: ASIN })
      await setLibrarySettings({ autoEpub: false })
      await addItems([id])
      await manager.drain()
      clock += 60 * 1000
      await manager.drain()
      expect(stateOf(id).reason).to.equal('chapterbot busy, speech check retry 1 of 5')
      const snapCalls = detectCalls
      await manager.reset()

      const restarted = await newManager()
      expect(restarted.states.get(id)).to.include({ status: 'queued', step: 'chapters' })
      clock += 2 * 60 * 1000
      await restarted.drain()
      expect(restarted.states.get(id).chapters.result).to.equal('applied')
      expect(detectCalls).to.equal(snapCalls)
      manager = restarted
    })

    it('an EPUB job that ended while the server was down is picked up; a lost one fails', async () => {
      const id = await createItem({ asin: ASIN })
      await addItems([id])
      await runAll()
      expect(stateOf(id).epub.result).to.equal('running')
      await manager.reset()
      epub.records.get(id).status = 'done'
      epub.records.get(id).fileName = 'x (from audio).epub'
      const restarted = await newManager()
      expect(restarted.states.get(id)).to.include({ status: 'done' })
      expect(restarted.states.get(id).epub).to.include({ result: 'done', fileName: 'x (from audio).epub' })
      await restarted.reset()

      // lost: the EPUB manager does not know the job any more
      const id2 = await createItem({ asin: ASIN, dir: makeDir('ebook') })
      manager = await newManager()
      await addItems([id2])
      await runAll()
      await manager.reset()
      epub.records.clear()
      manager = await newManager()
      expect(manager.states.get(id2)).to.include({ status: 'failed', reason: 'EPUB job was lost in a server restart' })
    })

    it('forgets items that no longer exist', async () => {
      const id = await createItem({ asin: ASIN })
      await addItems([id])
      await manager.reset()
      await Database.libraryItemModel.destroy({ where: { id } })
      manager = await newManager()
      expect(manager.states.size).to.equal(0)
      expect(fs.existsSync(Path.join(root, id))).to.equal(false)
    })
  })

  describe('queue management and undo', () => {
    it('dismiss removes the state but keeps the backups; restore puts the old chapters back with its own backup', async () => {
      const id = await createItem()
      await setLibrarySettings({ autoEpub: false })
      await addItems([id])
      await runAll()
      expect((await getItem(id)).media.chapters).to.have.length(5)
      const [backup] = await manager.listBackups(id)

      const result = await manager.restoreBackup(await getItem(id), backup.name)
      expect(result).to.include({ restored: backup.name, chapters: 4 })
      expect((await getItem(id)).media.chapters.map((c) => c.title)).to.deep.equal(['part0', 'part1', 'part2', 'part3'])
      const backups = await manager.listBackups(id)
      expect(backups).to.have.length(2)
      expect(backups.find((b) => b.name === result.backup)).to.include({ chapters: 5, source: 'restore' })
      expect(stateOf(id).chapters).to.include({ result: 'restored', appliedHash: null, applied: false })

      expect(await manager.dismiss(id)).to.equal(true)
      expect(manager.states.has(id)).to.equal(false)
      expect(await manager.listBackups(id)).to.have.length(2)
      expect(await manager.dismiss(id)).to.equal(false)
    })

    it('dismiss refuses while the worker is on the item', async () => {
      const id = await createItem()
      await addItems([id])
      manager.current = id
      try {
        await manager.dismiss(id)
        expect.fail('dismiss should throw')
      } catch (error) {
        expect(error).to.be.instanceOf(AutoPipelineManager.PipelineError)
        expect(error.status).to.equal(409)
      } finally {
        manager.current = null
      }
      expect(manager.states.has(id)).to.equal(true)
      expect(await manager.dismiss(id)).to.equal(true)
    })

    it('runLibrary queues unprocessed items, or all of them', async () => {
      const id1 = await createItem()
      const id2 = await createItem({ dir: makeDir('two') })
      const library = await Database.libraryModel.findByPk(libraryId)
      await addItems([id1])
      expect(await manager.runLibrary(library, 'unprocessed')).to.deep.equal({ queued: 1 })
      expect(stateOf(id2)).to.include({ trigger: 'manual' })
      expect(await manager.runLibrary(library, 'all')).to.deep.equal({ queued: 2 })
      const summary = manager.getLibrarySummary(library)
      expect(summary).to.include({ mode: 'on', gate: true })
      expect(summary.counts.queued).to.equal(2)
      expect(summary.items.map((s) => s.libraryItemId).sort()).to.deep.equal([id1, id2].sort())
      expect(manager.getLibrarySummary(library, 'done').items).to.have.length(0)
      expect(summary.items[0]).to.not.have.property('waitCheck')
    })

    it('the library scanner hands new items to the pipeline', async () => {
      const id = await createItem()
      const library = await Database.libraryModel.findByPk(libraryId)
      const spy = sinon.stub(AutoPipelineManager, 'onItemsAdded').resolves()
      LibraryScanner.queueForAutoPipeline(library, [{ id }])
      expect(spy.calledOnceWith(library, [id])).to.equal(true)
    })

    it('the first scan of a library queues nothing', async () => {
      const id = await createItem()
      const library = await Database.libraryModel.findByPk(libraryId)
      library.lastScan = null
      await manager.onItemsAdded(library, [id])
      expect(manager.states.has(id)).to.equal(false)
    })
  })

  describe('library mode changes', () => {
    const MODES_BEFORE = () => ({ ...defaultAutoPipelineSettings(), mode: 'on', autoEpub: true })

    it('turning the library off stops the queued books; a manual run goes on; "unprocessed" picks them up again', async () => {
      const id1 = await createItem()
      const id2 = await createItem({ dir: makeDir('two') })
      await addItems([id1])
      await manager.runItem(await getItem(id2), await Database.libraryModel.findByPk(libraryId))
      const library = await setLibrarySettings({ mode: 'off' })
      await manager.onLibrarySettingsChanged(library, MODES_BEFORE())
      expect(stateOf(id1)).to.include({ status: 'skipped', stopped: 'mode-off' })
      await runAll()
      expect(bookFinder.search.callCount).to.equal(1)
      expect((await getItem(id1)).media.asin).to.equal(null)
      expect((await getItem(id2)).media.asin).to.equal(ASIN)
      expect(await manager.runLibrary(library, 'unprocessed')).to.deep.equal({ queued: 1 })
    })

    it('a queued book that is processed after the library was turned off is stopped even without the settings hook', async () => {
      const id = await createItem()
      await addItems([id])
      await setLibrarySettings({ mode: 'off' })
      await runAll()
      expect(stateOf(id)).to.include({ status: 'skipped' })
      expect(bookFinder.search.called).to.equal(false)
    })

    it('switching to dry run makes the rest of a queued book a dry run', async () => {
      const id = await createItem()
      await addItems([id])
      const library = await setLibrarySettings({ mode: 'dryRun' })
      await manager.onLibrarySettingsChanged(library, MODES_BEFORE())
      expect(stateOf(id).dryRun).to.equal(true)
      await runAll()
      expect(stateOf(id)).to.include({ status: 'done', dryRun: true })
      const li = await getItem(id)
      expect(li.media.asin).to.equal(null)
      expect(li.media.chapters).to.have.length(4)
      expect(epub.start.called).to.equal(false)
    })

    it('a change while a step runs: nothing is written, the step runs again under the new mode', async () => {
      const id = await createItem()
      await addItems([id])
      const search = bookFinder.search
      bookFinder.search = sinon.spy(async (...args) => {
        // the user switches to dry run while the Audible search is in flight
        await setLibrarySettings({ mode: 'dryRun' })
        return search(...args)
      })
      await runAll()
      expect((await getItem(id)).media.asin).to.equal(null)
      expect(stateOf(id)).to.include({ status: 'done', dryRun: true })
      expect(stateOf(id).would).to.match(/^would match/)
      expect(stateOf(id).attempts).to.equal(0)
    })

    it('chapters: a switch to off during the analysis writes nothing and keeps the analysis', async () => {
      const id = await createItem({ asin: ASIN })
      await addItems([id])
      const verify = speechClient.verify
      speechClient.verify = sinon.spy(async (...args) => {
        await setLibrarySettings({ mode: 'off' })
        return verify(...args)
      })
      await runAll()
      expect(stateOf(id)).to.include({ status: 'skipped', stopped: 'mode-off' })
      expect((await getItem(id)).media.chapters).to.have.length(4)
      expect(await manager.listBackups(id)).to.have.length(0)
    })
  })

  describe('review fixes', () => {
    it('waits settleMinutes after a book was queued, even when its files carry old modified times', async () => {
      const id = await createItem()
      await addItems([id], { fresh: true })
      await manager.drain()
      expect(stateOf(id)).to.include({ status: 'waiting', reason: 'waiting for the files to settle' })
      expect(stateOf(id).notBefore).to.equal(clock + 5 * 60 * 1000)
      await runAll()
      expect(stateOf(id).match).to.include({ result: 'matched' })
    })

    it('does not match a book with an ISBN when the library skips those', async () => {
      const library = await Database.libraryModel.findByPk(libraryId)
      library.settings = { ...library.settings, skipMatchingMediaWithIsbn: true }
      library.changed('settings', true)
      await library.save()
      const id = await createItem()
      const li = await getItem(id)
      li.media.isbn = '9781234567897'
      await li.media.save()
      await addItems([id])
      await runAll()
      expect(stateOf(id).match).to.include({ result: 'skipped', reason: 'isbn' })
      expect(bookFinder.search.called).to.equal(false)
      expect((await getItem(id)).media.asin).to.equal(null)
    })

    it('an EPUB step waiting for a busy lane does not arm a wake-up timer', async () => {
      manager.autoRun = true
      try {
        manager.states.set('a', { libraryItemId: 'a', status: 'epub', epub: { result: 'running', jobId: 'j' }, notBefore: 0, queuedAt: 1 })
        manager.states.set('b', { libraryItemId: 'b', status: 'epub', epub: { result: 'queued' }, notBefore: 0, queuedAt: 2 })
        manager.scheduleWake()
        expect(manager.wakeTimer).to.equal(null)
        manager.states.get('a').epub.result = 'done'
        manager.states.get('a').status = 'done'
        manager.scheduleWake()
        expect(manager.wakeTimer).to.not.equal(null)
      } finally {
        clearTimeout(manager.wakeTimer)
        manager.wakeTimer = null
        manager.autoRun = false
        manager.states.clear()
      }
    })

    it('approving without chapters refuses when the chapters were changed by hand after the proposal', async () => {
      speech.late.add('Chapter 2')
      const id = await createItem()
      await addItems([id])
      await runAll()
      expect(stateOf(id)).to.include({ status: 'needs-review' })
      const li = await getItem(id)
      li.media.chapters = li.media.chapters.map((c, i) => (i === 1 ? { ...c, title: 'Edited by hand' } : c))
      li.media.changed('chapters', true)
      await li.media.save()
      let error
      try {
        await manager.approve(id)
      } catch (e) {
        error = e
      }
      expect(error?.status).to.equal(409)
      expect((await getItem(id)).media.chapters[1].title).to.equal('Edited by hand')
      expect(stateOf(id)).to.include({ status: 'needs-review' })
    })

    it('approving the proposal unchanged (as the review editor sends it) counts as the pipeline\'s chapters', async () => {
      speech.late.add('Chapter 2')
      const id = await createItem()
      await addItems([id])
      await runAll()
      const proposal = await manager.getProposal(id)
      const approved = await manager.approve(id, proposal.proposedChapters.map((c) => ({ ...c })))
      expect(approved.chapters).to.include({ result: 'approved', edited: false })
      expect(approved.chapters.appliedHash).to.equal(chapterPlan.chaptersHash((await getItem(id)).media.chapters))
      expect(approved.chapters).to.not.have.property('pendingHash')
    })

    it('chapters being applied when the server stopped still count as the pipeline\'s (pendingHash)', async () => {
      const id = await createItem({ asin: ASIN })
      await setLibrarySettings({ autoEpub: false })
      await addItems([id])
      await runAll()
      const state = stateOf(id)
      expect(state.chapters.result).to.equal('applied')
      expect(state.chapters).to.not.have.property('pendingHash')
      // what a crash between the write and the state save leaves behind
      const hash = state.chapters.appliedHash
      state.chapters = { pendingHash: hash }
      state.status = 'queued'
      state.step = 'chapters'
      await manager.drain()
      expect(stateOf(id).chapters).to.include({ result: 'kept', reason: 'already-correct', current: 'pipeline' })
    })
  })

  describe('guided fix', () => {
    /** Mp3SeekIndexManager stand-in: `needs` files need a repair until end() */
    function fakeSeekIndex({ needs = 2 } = {}) {
      const fake = {
        needs,
        busy: false,
        lastResults: new Map(),
        getStatus: sinon.spy(async () => ({ needsRepairCount: fake.needs, maxDrift: fake.needs ? 43.38 : 0, processing: fake.busy })),
        getIsLibraryItemQueuedOrProcessing: () => fake.busy,
        startRepair: sinon.spy((userId, li) => {
          fake.busy = true
          fake.itemId = li.id
          return { id: 'task-1' }
        }),
        end({ failed = 0 } = {}) {
          fake.busy = false
          if (!failed) fake.needs = 0
          const files = [...Array(needs)].map((_, i) => ({ filename: `part${i}.mp3`, status: i < failed ? 'failed' : 'repaired' }))
          fake.lastResults.set(fake.itemId, { finishedAt: clock, files, oldTotalDuration: T, newTotalDuration: T + 90, backupId: 'bk-1' })
        }
      }
      apiRouter.mp3SeekIndexManager = fake
      apiRouter.audioMetadataManager = { getIsLibraryItemQueuedOrProcessing: () => false }
      apiRouter.abMergeManager = { getPendingTaskByLibraryItemId: () => null }
      return fake
    }

    it('repairs with the run\'s consent: starts the task, polls it, then matches and applies the chapters', async () => {
      const seek = fakeSeekIndex()
      const id = await createItem()
      await manager.runItem(await getItem(id), await Database.libraryModel.findByPk(libraryId), { fix: true, repairConsent: true, userId: 'user-1' })
      expect(stateOf(id)).to.include({ trigger: 'fix', force: true, repairConsent: true, userId: 'user-1' })
      await manager.drain()
      expect(seek.startRepair.calledOnce).to.be.true
      expect(seek.startRepair.firstCall.args[0]).to.equal('user-1')
      expect(seek.startRepair.firstCall.args[2]).to.deep.equal({ chapters: 'keep' })
      expect(stateOf(id)).to.include({ status: 'repairing', step: 'repairing', reason: 'repairing the MP3 files' })
      expect(stateOf(id).repair).to.include({ result: 'running', taskId: 'task-1', files: 2, maxDrift: 43.4 })

      clock += manager.timing.repairPollMs
      await manager.drain()
      expect(stateOf(id).status).to.equal('repairing')
      seek.end()
      await runAll()
      const state = stateOf(id)
      expect(state.repair).to.include({ result: 'repaired', oldTotalDuration: T, newTotalDuration: T + 90, backupId: 'bk-1' })
      expect(state.match).to.include({ result: 'matched', minConfidence: 90 })
      expect(state).to.include({ status: 'done', reason: `MP3 seek index repaired (2 files), matched ${ASIN} at 100 %, 5 chapters applied` })
      expect(seek.startRepair.calledOnce).to.be.true
    })

    it('without consent the files are left alone and the chapters stop for an OK; the library setting is consent', async () => {
      const seek = fakeSeekIndex()
      const id = await createItem({ asin: ASIN })
      await addItems([id])
      await runAll()
      expect(stateOf(id).repair).to.deep.equal({ result: 'needs-ok', files: 2, maxDrift: 43.4 })
      expect(stateOf(id).chapters).to.include({ result: 'needs-review', reason: 'needs-seek-index-repair' })
      expect(seek.startRepair.called).to.be.false

      await setLibrarySettings({ autoRepairSeekIndex: true })
      await manager.runItem(await getItem(id), await Database.libraryModel.findByPk(libraryId), {})
      await manager.drain()
      expect(seek.startRepair.calledOnce).to.be.true
    })

    it('a dry run says what it would repair; a failed repair fails the run', async () => {
      const seek = fakeSeekIndex()
      await setLibrarySettings({ mode: 'dryRun', autoRepairSeekIndex: true })
      const id = await createItem({ asin: ASIN })
      await addItems([id])
      await runAll()
      expect(seek.startRepair.called).to.be.false
      expect(stateOf(id).repair).to.include({ result: 'would-repair', would: 'would repair 2 MP3 file(s)' })
      expect(stateOf(id).would).to.match(/^would repair 2 MP3 file\(s\); /)

      await setLibrarySettings({ mode: 'on' })
      await manager.runItem(await getItem(id), await Database.libraryModel.findByPk(libraryId), { repairConsent: true })
      await manager.drain()
      seek.end({ failed: 1 })
      await runAll()
      expect(stateOf(id)).to.include({ status: 'failed', reason: 'repair: 1 file(s) failed' })
      expect(stateOf(id).repair.result).to.equal('failed')
    })

    it('a fix run matches at 90 % instead of the library threshold', async () => {
      const library = await Database.libraryModel.findByPk(libraryId)
      const run = async (name, result) => {
        bookFinder.results = [result]
        const id = await createItem({ dir: makeDir(name) })
        await manager.runItem(await getItem(id), library, { fix: true, steps: ['match'] })
        await runAll()
        return stateOf(id)
      }
      // another narrator: 91 %, under the library's 95 %
      expect((await run('n', candidate({ narrator: 'Someone Else' }))).match).to.include({ result: 'matched', confidence: 91, minConfidence: 90 })
      // 4 minutes longer: 89 %
      expect(await run('d', candidate({ duration: T / 60 + 4 }))).to.include({ status: 'needs-review', reason: 'match: low-confidence' })
    })

    it('applies the chapters that passed and keeps the proposal; approving it unchanged applies the rest', async () => {
      speech.late.add('Chapter 2')
      const id = await createItem({ asin: ASIN })
      await addItems([id])
      await runAll()
      const state = stateOf(id)
      expect(state.chapters.partial).to.deep.equal({ applied: 4, flagged: 1 })
      const partial = (await getItem(id)).media.chapters.map((c) => ({ title: c.title, start: c.start, end: c.end }))
      expect(state.chapters.appliedHash).to.equal(chapterPlan.chaptersHash(partial))
      const proposal = await manager.getProposal(id)
      expect(proposal.currentChapters).to.deep.equal(partial)
      expect(partial[2].start).to.equal(proposal.snap.chapters[2].originalStart)
      expect((await manager.listBackups(id))[0]).to.include({ chapters: 4, reason: 'auto-partial' })

      const approved = await manager.approve(id)
      expect(approved.chapters).to.include({ result: 'approved', edited: false })
      expect((await getItem(id)).media.chapters.map((c) => c.start)).to.deep.equal(proposal.proposedChapters.map((c) => c.start))
    })

    it('a sweep queues the unprocessed books once a night and runs their steps only in the quiet hours', async () => {
      const id = await createItem()
      await setLibrarySettings({ nightlySweep: true, sweepStart: '01:00', sweepEnd: '06:00' })
      const at = (h, m = 0) => new Date(2026, 9, 29, h, m).getTime()
      clock = at(12)
      await manager.sweepTick()
      expect(stateOf(id)).to.equal(undefined)
      clock = at(1, 15)
      await manager.sweepTick()
      expect(stateOf(id)).to.include({ trigger: 'sweep', manual: false })
      stateOf(id).queuedAt -= 10 * 60 * 1000
      // once a night
      const later = await createItem({ dir: makeDir('later') })
      await manager.sweepTick()
      expect(stateOf(later)).to.equal(undefined)

      clock = at(6, 30)
      await manager.drain()
      expect(stateOf(id)).to.include({ status: 'waiting', step: 'waiting', reason: 'waiting for the quiet hours', notBefore: new Date(2026, 9, 30, 1, 0).getTime() })
      expect(bookFinder.search.called).to.be.false

      clock = new Date(2026, 9, 30, 1, 0).getTime()
      await runAll()
      expect(stateOf(id).status).to.equal('epub')
    })
  })
})
