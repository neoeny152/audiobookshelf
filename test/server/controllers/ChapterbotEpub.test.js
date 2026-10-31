const { expect } = require('chai')
const { Sequelize } = require('sequelize')
const sinon = require('sinon')
const http = require('http')
const os = require('os')
const Path = require('path')
const fs = require('fs')
const EventEmitter = require('events')
const express = require('express')

const Database = require('../../../server/Database')
const ApiRouter = require('../../../server/routers/ApiRouter')
const LibraryItemController = require('../../../server/controllers/LibraryItemController')
const ApiCacheManager = require('../../../server/managers/ApiCacheManager')
const Auth = require('../../../server/Auth')
const Logger = require('../../../server/Logger')
const SocketAuthority = require('../../../server/SocketAuthority')
const chapterbotClient = require('../../../server/utils/chapterbotClient')
const ChapterbotEpubManager = require('../../../server/managers/ChapterbotEpubManager')
const { filePathToPOSIX } = require('../../../server/utils/fileUtils')
const fsExtra = require('../../../server/libs/fsExtra')

const TOKEN = 'epub-test-token-0123456789'
const JOB_ID = '0123456789abcdef0123456789abcdef'
const READ_ALONG = Object.freeze({
  kind: 'abs-readalong',
  version: 1,
  identifier: 'urn:uuid:5b1c0000-0000-5000-8000-000000000000',
  modified: '2026-10-28T12:34:56Z',
  epubFile: 'book.epub',
  timeline: 'book',
  audioDuration: 4000,
  model: 'small.en',
  sections: [{ href: 'OEBPS/ch001.xhtml', title: 'Chapter 1' }],
  sentences: [
    {
      id: 's1',
      sec: 0,
      start: 501.2,
      end: 503.9,
      w: [
        [501.2, 501.5],
        [501.5, 503.9]
      ]
    },
    { id: 's2', sec: 0, start: 504.1, end: 507 }
  ]
})
const EPUB_BYTES = Buffer.from('PK\u0003\u0004 fake epub body')

function until(cond, timeoutMs = 3000) {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (cond()) return resolve()
      if (Date.now() - started > timeoutMs) return reject(new Error('timed out waiting'))
      setTimeout(tick, 5)
    }
    tick()
  })
}

/**
 * Fake chapterbot: one EPUB job whose status the test sets through `sidecar.state`.
 */
async function startSidecar() {
  const sidecar = {
    requests: [],
    state: { status: 'queued', stage: null, progress: 0, chaptersDone: 0, chaptersTotal: 4, error: null, cancelRequested: false },
    createStatus: 202,
    deleteAnswer: { status: 'cancelled' },
    deleteDelayMs: 0,
    /** GET readalong: an object is sent as JSON, a string as is, null answers 404 (a sidecar without the feature) */
    readAlong: READ_ALONG,
    /** when set, GET result waits until sidecar.releaseResult() */
    holdResult: false,
    releaseResult: null
  }
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      sidecar.requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: text ? JSON.parse(text) : null })
      const json = (status, body) => {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(body))
      }
      if (req.method === 'POST' && req.url === '/v1/epub/jobs') {
        if (sidecar.createStatus !== 202) return json(sidecar.createStatus, { detail: { code: 'busy', message: 'too many jobs' } })
        return json(202, { jobId: JOB_ID, status: 'queued' })
      }
      if (req.method === 'GET' && req.url === `/v1/jobs/${JOB_ID}`) return json(200, { id: JOB_ID, kind: 'epub', ...sidecar.state })
      if (req.method === 'GET' && req.url === `/v1/jobs/${JOB_ID}/result`) {
        const send = () => {
          res.writeHead(200, { 'Content-Type': 'application/epub+zip' })
          res.end(EPUB_BYTES)
        }
        if (!sidecar.holdResult) return send()
        sidecar.releaseResult = send
        return
      }
      if (req.method === 'GET' && req.url === `/v1/jobs/${JOB_ID}/readalong`) {
        if (sidecar.readAlong === null) return json(404, { detail: { code: 'not_found', message: 'no read-along data' } })
        if (typeof sidecar.readAlong === 'string') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          return res.end(sidecar.readAlong)
        }
        return json(200, sidecar.readAlong)
      }
      if (req.method === 'POST' && req.url === `/v1/jobs/${JOB_ID}/resume`) {
        sidecar.state = { ...sidecar.state, status: 'queued', error: null, resumable: false }
        return json(202, { id: JOB_ID, kind: 'epub', ...sidecar.state })
      }
      if (req.method === 'DELETE' && req.url === `/v1/jobs/${JOB_ID}`) {
        const answer = { id: JOB_ID, ...sidecar.deleteAnswer }
        if (!sidecar.deleteDelayMs) return json(200, answer)
        return setTimeout(() => json(200, answer), sidecar.deleteDelayMs)
      }
      json(404, { detail: { code: 'not_found', message: 'no such job' } })
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  sidecar.url = `http://127.0.0.1:${server.address().port}`
  sidecar.close = () => new Promise((resolve) => server.close(resolve))
  return sidecar
}

describe('Chapterbot EPUB endpoints', () => {
  let apiRouter
  let sidecar
  let itemDir
  let stagingDir
  let bookItemId
  let libraryId
  let folderId
  let clientEmitter
  let scanItem
  let watcher
  let metadataDir

  const chapters = [
    { id: 0, title: 'Opening Credits', start: 0, end: 500 },
    { id: 1, title: 'Chapter 1', start: 500, end: 1500 },
    { id: 2, title: 'Chapter 2', start: 1500, end: 2500 },
    { id: 3, title: 'Chapter 3', start: 2500, end: 4000 }
  ]
  const audioFiles = [0, 1, 2, 3].map((i) => ({
    index: i + 1,
    ino: `ino${i}`,
    duration: 1000,
    exclude: false,
    mimeType: 'audio/mpeg',
    metadata: { filename: `part${i}.mp3`, ext: '.mp3', path: `/books/Black Ice/part${i}.mp3`, relPath: `part${i}.mp3` }
  }))

  const user = (overrides = {}) => ({ id: 'user-1', username: 'neo', canUpdate: true, canDelete: false, checkCanAccessLibraryItem: () => true, ...overrides })

  function fakeResponse() {
    const res = new EventEmitter()
    res.statusCode = 200
    res.status = sinon.spy((code) => {
      res.statusCode = code
      return res
    })
    res.json = sinon.spy(() => res)
    res.sendStatus = sinon.spy((code) => {
      res.statusCode = code
      return res
    })
    res.send = sinon.spy(() => res)
    res.sendFile = sinon.spy((path, opts, cb) => cb())
    return res
  }

  async function call(handler, { item, reqUser = user(), params = {}, libraryFile } = {}) {
    const libraryItem = item || (await Database.libraryItemModel.getExpandedById(bookItemId))
    const res = fakeResponse()
    await LibraryItemController[handler].bind(apiRouter)({ user: reqUser, libraryItem, libraryFile, params: { id: libraryItem.id, ...params }, body: {} }, res)
    return res
  }

  async function createBook(mediaValues = {}, itemValues = {}) {
    const book = await Database.bookModel.create({ title: 'Black Ice', audioFiles, tags: [], narrators: ['Jo Reader'], genres: [], chapters, duration: 4000, ...mediaValues })
    const li = await Database.libraryItemModel.create({ libraryFiles: [], mediaId: book.id, mediaType: 'book', libraryId, libraryFolderId: folderId, path: itemDir, relPath: 'Black Ice', ...itemValues })
    const author = await Database.authorModel.create({ name: 'A. Writer', libraryId })
    await Database.bookAuthorModel.create({ bookId: book.id, authorId: author.id })
    return li.id
  }

  beforeEach(async () => {
    global.ServerSettings = {}
    Database.sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false })
    Database.sequelize.uppercaseFirst = (str) => (str ? `${str[0].toUpperCase()}${str.substr(1)}` : '')
    await Database.buildModels()
    apiRouter = new ApiRouter({ auth: new Auth(), apiCacheManager: new ApiCacheManager() })

    sinon.stub(Logger, 'info')
    sinon.stub(Logger, 'warn')
    sinon.stub(Logger, 'error')
    sinon.stub(Logger, 'debug')
    clientEmitter = sinon.stub(SocketAuthority, 'clientEmitter')
    sinon.stub(SocketAuthority, 'libraryItemEmitter')

    itemDir = fs.mkdtempSync(Path.join(os.tmpdir(), 'abs-epub-item-'))
    stagingDir = fs.mkdtempSync(Path.join(os.tmpdir(), 'abs-epub-staging-'))
    metadataDir = fs.mkdtempSync(Path.join(os.tmpdir(), 'abs-epub-metadata-'))
    global.MetadataPath = metadataDir

    const library = await Database.libraryModel.create({ name: 'Books', mediaType: 'book' })
    const folder = await Database.libraryFolderModel.create({ path: '/books', libraryId: library.id })
    libraryId = library.id
    folderId = folder.id
    bookItemId = await createBook()

    sidecar = await startSidecar()
    chapterbotClient.configure({ CHAPTERBOT_URL: sidecar.url, CHAPTERBOT_TOKEN: TOKEN, CHAPTERBOT_PATH_MAP: '/books=' })

    // fake scanner: like BookScanner, a book without an ebook takes the new epub as its primary ebook
    scanItem = sinon.spy(async (libraryItemId) => {
      const li = await Database.libraryItemModel.getExpandedById(libraryItemId)
      const name = fs.readdirSync(itemDir).find((f) => f.endsWith('.epub') && !li.libraryFiles.some((lf) => lf.metadata.filename === f))
      if (!name) return
      // the real scanner keys library files by their inode (utils/fileUtils getIno)
      const ino = String(fs.statSync(Path.join(itemDir, name), { bigint: true }).ino)
      const lf = { ino, isSupplementary: false, fileType: 'ebook', metadata: { filename: name, ext: '.epub', path: filePathToPOSIX(Path.join(itemDir, name)), relPath: name } }
      li.libraryFiles = [...li.libraryFiles, lf]
      li.changed('libraryFiles', true)
      await li.save()
      if (!li.media.ebookFile) {
        li.media.ebookFile = { ino: lf.ino, metadata: lf.metadata, ebookFormat: 'epub' }
        li.media.changed('ebookFile', true)
        await li.media.save()
      }
    })
    ChapterbotEpubManager.reset()
    ChapterbotEpubManager.pollMs = 10
    ChapterbotEpubManager.tempDir = stagingDir
    ChapterbotEpubManager.scanItem = scanItem
    watcher = {
      ignoring: new Set(),
      addIgnoreDir: sinon.spy((dir) => {
        // the file must not be in the folder yet when the watcher is told to look away
        watcher.filesAtIgnore = fs.readdirSync(dir)
        watcher.ignoring.add(dir)
      }),
      removeIgnoreDir: sinon.spy((dir) => watcher.ignoring.delete(dir))
    }
    ChapterbotEpubManager.watcher = watcher
  })

  afterEach(async () => {
    ChapterbotEpubManager.reset()
    chapterbotClient.configure({})
    sinon.restore()
    await sidecar.close()
    fs.rmSync(itemDir, { recursive: true, force: true })
    fs.rmSync(stagingDir, { recursive: true, force: true })
    fs.rmSync(metadataDir, { recursive: true, force: true })
    await Database.sequelize.sync({ force: true })
  })

  it('registers the routes', () => {
    const routes = apiRouter.router._router.stack.filter((l) => l.route).map((l) => `${Object.keys(l.route.methods).join(',')} ${l.route.path} ${l.route.stack[l.route.stack.length - 1].handle.name}`)
    expect(routes).to.include('post /items/:id/epub bound startEpubJob')
    expect(routes).to.include('get /items/:id/epub/:jobId bound getEpubJob')
    expect(routes).to.include('delete /items/:id/epub/:jobId bound cancelEpubJob')
    expect(routes).to.include('get /items/:id/ebook/:fileid/readalong bound getEbookReadAlong')
  })

  describe('authorization', () => {
    it('needs canUpdate for start, status and cancel', async () => {
      for (const handler of ['startEpubJob', 'getEpubJob', 'cancelEpubJob']) {
        const res = await call(handler, { reqUser: user({ canUpdate: false }), params: { jobId: JOB_ID } })
        expect(res.sendStatus.calledWith(403), handler).to.equal(true)
      }
      expect(sidecar.requests).to.have.length(0)
    })

    it('middleware refuses users without library access and lets canUpdate users cancel without canDelete', async () => {
      const run = async (method, path, reqUser) => {
        const res = fakeResponse()
        const next = sinon.spy()
        await LibraryItemController.middleware.bind(apiRouter)({ method, path, user: reqUser, params: { id: bookItemId } }, res, next)
        return { res, next }
      }
      const denied = await run('POST', `/items/${bookItemId}/epub`, user({ checkCanAccessLibraryItem: () => false }))
      expect(denied.res.sendStatus.calledWith(403)).to.equal(true)
      expect(denied.next.called).to.equal(false)

      const readOnly = await run('POST', `/items/${bookItemId}/epub`, user({ canUpdate: false }))
      expect(readOnly.res.sendStatus.calledWith(403)).to.equal(true)

      const cancel = await run('DELETE', `/items/${bookItemId}/epub/${JOB_ID}`, user({ canDelete: false }))
      expect(cancel.next.calledOnce).to.equal(true)

      // the exception is only for the EPUB job route
      const deleteItem = await run('DELETE', `/items/${bookItemId}`, user({ canDelete: false }))
      expect(deleteItem.res.sendStatus.calledWith(403)).to.equal(true)
    })
  })

  it('returns 400 when chapterbot is not configured, for a non-audio item and for unmapped files', async () => {
    chapterbotClient.configure({})
    let res = await call('startEpubJob')
    expect(res.statusCode).to.equal(400)
    expect(res.json.firstCall.args[0].error).to.include('CHAPTERBOT_URL')

    chapterbotClient.configure({ CHAPTERBOT_URL: sidecar.url, CHAPTERBOT_TOKEN: TOKEN, CHAPTERBOT_PATH_MAP: '/books=' })
    const noAudio = await createBook({ audioFiles: [] })
    res = await call('startEpubJob', { item: await Database.libraryItemModel.getExpandedById(noAudio) })
    expect(res.statusCode).to.equal(400)

    chapterbotClient.configure({ CHAPTERBOT_URL: sidecar.url, CHAPTERBOT_TOKEN: TOKEN, CHAPTERBOT_PATH_MAP: '/elsewhere=' })
    res = await call('startEpubJob')
    expect(res.statusCode).to.equal(400)
    expect(res.json.firstCall.args[0].error).to.include('path map')
    expect(sidecar.requests).to.have.length(0)
  })

  it('starts a job, follows it, writes the EPUB as the primary ebook of a book without one and tells the user', async () => {
    const res = await call('startEpubJob')
    expect(res.statusCode).to.equal(202)
    const { jobId, status } = res.json.firstCall.args[0]
    expect(jobId).to.equal(JOB_ID)
    expect(status).to.equal('queued')

    const create = sidecar.requests[0]
    expect(create).to.include({ method: 'POST', url: '/v1/epub/jobs', auth: `Bearer ${TOKEN}` })
    expect(create.body).to.deep.equal({
      files: [0, 1, 2, 3].map((i) => ({ path: `Black Ice/part${i}.mp3`, offset: i * 1000, duration: 1000 })),
      chapters: chapters.map((c) => ({ title: c.title, start: c.start })),
      title: 'Black Ice',
      author: 'A. Writer',
      narrator: 'Jo Reader',
      bookId: bookItemId
    })
    expect(JSON.stringify(create.body)).to.not.include(TOKEN)

    // one job per item
    const again = await call('startEpubJob')
    expect(again.statusCode).to.equal(409)
    expect(again.json.firstCall.args[0]).to.include({ jobId: JOB_ID })

    sidecar.state = { ...sidecar.state, status: 'running', stage: 'transcribing', progress: 0.5, chaptersDone: 2 }
    await until(() => ChapterbotEpubManager.jobs.get(bookItemId).status === 'running')
    const running = await call('getEpubJob', { params: { jobId: JOB_ID } })
    expect(running.json.firstCall.args[0]).to.include({ jobId: JOB_ID, status: 'running', stage: 'transcribing', progress: 0.5, chaptersDone: 2, chaptersTotal: 4 })

    const wrong = await call('getEpubJob', { params: { jobId: 'f'.repeat(32) } })
    expect(wrong.statusCode).to.equal(404)

    sidecar.state = { ...sidecar.state, status: 'done', stage: 'done', progress: 1, chaptersDone: 4 }
    await until(() => ChapterbotEpubManager.jobs.get(bookItemId).status === 'done')

    const written = Path.join(itemDir, 'Black Ice (from audio).epub')
    expect(fs.readFileSync(written).equals(EPUB_BYTES)).to.equal(true)
    expect(fs.readdirSync(stagingDir)).to.deep.equal([])
    expect(scanItem.calledOnceWith(bookItemId)).to.equal(true)

    // the folder watcher looked away from the copy until after the rescan, so its own rescan cannot race ours
    expect(watcher.addIgnoreDir.calledOnceWith(itemDir)).to.equal(true)
    expect(watcher.filesAtIgnore).to.deep.equal([])
    expect(watcher.addIgnoreDir.calledBefore(scanItem)).to.equal(true)
    expect(watcher.removeIgnoreDir.calledOnceWith(itemDir)).to.equal(true)
    expect(watcher.removeIgnoreDir.calledAfter(scanItem)).to.equal(true)

    const reloaded = await Database.libraryItemModel.getExpandedById(bookItemId)
    const placed = reloaded.libraryFiles.find((lf) => lf.metadata.filename === 'Black Ice (from audio).epub')
    expect(reloaded.media.ebookFile.ino).to.equal(placed.ino)
    expect(reloaded.media.ebookFile.ebookFormat).to.equal('epub')
    expect(placed.isSupplementary).to.equal(false)

    expect(clientEmitter.calledOnce).to.equal(true)
    const [userId, event, payload] = clientEmitter.firstCall.args
    expect(userId).to.equal('user-1')
    expect(event).to.equal('chapterbot_epub_done')
    expect(payload).to.include({ jobId: JOB_ID, libraryItemId: bookItemId, status: 'done', fileName: 'Black Ice (from audio).epub', ebookRole: 'primary' })

    const done = await call('getEpubJob', { params: { jobId: JOB_ID } })
    expect(done.json.firstCall.args[0]).to.include({ status: 'done', fileName: 'Black Ice (from audio).epub' })

    // the finished job is cleaned up on the sidecar, and a new job may start
    await until(() => sidecar.requests.some((r) => r.method === 'DELETE'))
    expect(sidecar.requests.every((r) => r.auth === `Bearer ${TOKEN}`)).to.equal(true)
    expect((await call('startEpubJob')).statusCode).to.equal(202)
  })

  it('never overwrites an existing file and, without read-along data, leaves an existing primary ebook alone', async () => {
    sidecar.readAlong = null
    const existing = Path.join(itemDir, 'Black Ice (from audio).epub')
    fs.writeFileSync(existing, 'original')
    const li = await Database.libraryItemModel.getExpandedById(bookItemId)
    li.media.ebookFile = { ino: 'primary', metadata: { filename: 'Black Ice.epub', ext: '.epub', path: '/x/Black Ice.epub' }, ebookFormat: 'epub' }
    li.media.changed('ebookFile', true)
    await li.media.save()

    expect((await call('startEpubJob')).statusCode).to.equal(202)
    sidecar.state = { ...sidecar.state, status: 'done' }
    await until(() => ChapterbotEpubManager.jobs.get(bookItemId).status === 'done')

    expect(fs.readFileSync(existing, 'utf8')).to.equal('original')
    const second = Path.join(itemDir, 'Black Ice (from audio) (2).epub')
    expect(fs.readFileSync(second).equals(EPUB_BYTES)).to.equal(true)
    expect(ChapterbotEpubManager.jobs.get(bookItemId).fileName).to.equal('Black Ice (from audio) (2).epub')

    const reloaded = await Database.libraryItemModel.getExpandedById(bookItemId)
    expect(reloaded.media.ebookFile.ino).to.equal('primary')
    expect(reloaded.libraryFiles.find((lf) => lf.metadata.filename === 'Black Ice (from audio) (2).epub').isSupplementary).to.equal(true)
    expect(ChapterbotEpubManager.jobs.get(bookItemId).ebookRole).to.equal('supplementary')
  })

  describe('primary or supplementary ebook', () => {
    const placedName = 'Black Ice (from audio).epub'

    async function addLibraryFile(name, isSupplementary) {
      fs.writeFileSync(Path.join(itemDir, name), 'other ebook')
      const li = await Database.libraryItemModel.getExpandedById(bookItemId)
      const lf = { ino: `ino-${name}`, isSupplementary, fileType: 'ebook', metadata: { filename: name, ext: Path.extname(name), path: filePathToPOSIX(Path.join(itemDir, name)), relPath: name } }
      li.libraryFiles = [...li.libraryFiles, lf]
      li.changed('libraryFiles', true)
      await li.save()
      return lf
    }

    async function runJob() {
      expect((await call('startEpubJob')).statusCode).to.equal(202)
      sidecar.state = { ...sidecar.state, status: 'done' }
      await until(() => ChapterbotEpubManager.jobs.get(bookItemId).status === 'done')
      const reloaded = await Database.libraryItemModel.getExpandedById(bookItemId)
      return { reloaded, placed: reloaded.libraryFiles.find((lf) => lf.metadata.filename === placedName), job: ChapterbotEpubManager.jobs.get(bookItemId) }
    }

    /** a rescan that, like the stock scanner may, ends with `file` as the primary ebook */
    function scanPromoting(file) {
      const fakeScan = scanItem
      ChapterbotEpubManager.scanItem = async (libraryItemId) => {
        await fakeScan(libraryItemId)
        const li = await Database.libraryItemModel.getExpandedById(libraryItemId)
        li.media.ebookFile = file ? { ino: file.ino, metadata: file.metadata, ebookFormat: file.metadata.ext.slice(1) } : null
        li.media.changed('ebookFile', true)
        await li.media.save()
      }
    }

    it('a book with no ebook: ours becomes the primary ebook', async () => {
      const { reloaded, placed, job } = await runJob()
      expect(reloaded.media.ebookFile.ino).to.equal(placed.ino)
      expect(reloaded.media.ebookFile.metadata.filename).to.equal(placedName)
      expect(placed.isSupplementary).to.equal(false)
      expect(job.ebookRole).to.equal('primary')
    })

    it('a book with an existing primary ebook and no read-along data: it stays primary, ours is supplementary', async () => {
      sidecar.readAlong = null
      const real = await addLibraryFile('Black Ice.epub', false)
      const li = await Database.libraryItemModel.getExpandedById(bookItemId)
      li.media.ebookFile = { ino: real.ino, metadata: real.metadata, ebookFormat: 'epub' }
      li.media.changed('ebookFile', true)
      await li.media.save()

      const { reloaded, placed, job } = await runJob()
      expect(reloaded.media.ebookFile.ino).to.equal(real.ino)
      expect(reloaded.libraryFiles.find((lf) => lf.ino === real.ino).isSupplementary).to.equal(false)
      expect(placed.isSupplementary).to.equal(true)
      expect(job.ebookRole).to.equal('supplementary')
      expect(clientEmitter.calledWith('user-1', 'chapterbot_epub_done', sinon.match({ ebookRole: 'supplementary' }))).to.equal(true)
    })

    it('a book with only supplementary ebooks (a .mobi marked supplementary): ours becomes primary', async () => {
      const mobi = await addLibraryFile('Black Ice.mobi', true)
      const { reloaded, placed, job } = await runJob()
      expect(reloaded.media.ebookFile.ino).to.equal(placed.ino)
      expect(placed.isSupplementary).to.equal(false)
      expect(reloaded.libraryFiles.find((lf) => lf.ino === mobi.ino).isSupplementary).to.equal(true)
      expect(job.ebookRole).to.equal('primary')
    })

    it('takes over when the rescan promoted another file the user had marked supplementary', async () => {
      const other = await addLibraryFile('Black Ice.epub', true)
      scanPromoting(other)
      const { reloaded, placed, job } = await runJob()
      expect(reloaded.media.ebookFile.ino).to.equal(placed.ino)
      expect(reloaded.libraryFiles.find((lf) => lf.ino === other.ino).isSupplementary).to.equal(true)
      expect(job.ebookRole).to.equal('primary')
    })

    it('without read-along data, never takes over from a real ebook the rescan made primary', async () => {
      sidecar.readAlong = null
      const other = await addLibraryFile('Black Ice.epub', null)
      scanPromoting(other)
      const { reloaded, placed, job } = await runJob()
      expect(reloaded.media.ebookFile.ino).to.equal(other.ino)
      expect(placed.isSupplementary).to.equal(true)
      expect(job.ebookRole).to.equal('supplementary')
    })

    it('with read-along data, ours becomes primary over an existing primary ebook', async () => {
      const real = await addLibraryFile('Black Ice.epub', false)
      const li = await Database.libraryItemModel.getExpandedById(bookItemId)
      li.media.ebookFile = { ino: real.ino, metadata: real.metadata, ebookFormat: 'epub' }
      li.media.changed('ebookFile', true)
      await li.media.save()

      const { reloaded, placed, job } = await runJob()
      expect(reloaded.media.ebookFile.ino).to.equal(placed.ino)
      expect(placed.isSupplementary).to.equal(false)
      expect(reloaded.libraryFiles.find((lf) => lf.ino === real.ino).isSupplementary).to.equal(true)
      expect(job.ebookRole).to.equal('primary')
    })

    it('with read-along data, takes over from a real ebook the rescan made primary', async () => {
      const other = await addLibraryFile('Black Ice.epub', null)
      scanPromoting(other)
      const { reloaded, placed, job } = await runJob()
      expect(reloaded.media.ebookFile.ino).to.equal(placed.ino)
      expect(reloaded.libraryFiles.find((lf) => lf.ino === other.ino).isSupplementary).to.equal(true)
      expect(job.ebookRole).to.equal('primary')
    })

    it('stays supplementary in an audiobooks-only library', async () => {
      const library = await Database.libraryModel.findByPk(libraryId)
      library.settings = { ...library.settings, audiobooksOnly: true }
      library.changed('settings', true)
      await library.save()
      // the stock scanner promotes no ebook there
      scanPromoting(null)
      const { reloaded, placed, job } = await runJob()
      expect(reloaded.media.ebookFile).to.equal(null)
      expect(placed.isSupplementary).to.equal(true)
      expect(job.ebookRole).to.equal('supplementary')
    })

    it('a job started by the auto pipeline follows the same rule', async () => {
      const ended = []
      ChapterbotEpubManager.on('ended', (job) => ended.push(job))
      const libraryItem = await Database.libraryItemModel.getExpandedById(bookItemId)
      await ChapterbotEpubManager.start(libraryItem, null, { origin: 'pipeline' })
      sidecar.state = { ...sidecar.state, status: 'done' }
      await until(() => ended.length === 1)
      expect(ended[0]).to.include({ status: 'done', origin: 'pipeline', ebookRole: 'primary' })
      const reloaded = await Database.libraryItemModel.getExpandedById(bookItemId)
      expect(reloaded.media.ebookFile.metadata.filename).to.equal(placedName)
    })
  })

  it('cancels a job', async () => {
    expect((await call('startEpubJob')).statusCode).to.equal(202)
    const res = await call('cancelEpubJob', { params: { jobId: JOB_ID } })
    expect(res.json.firstCall.args[0]).to.include({ status: 'cancelled', cancelRequested: true })
    expect(sidecar.requests.some((r) => r.method === 'DELETE' && r.url === `/v1/jobs/${JOB_ID}`)).to.equal(true)
    expect(clientEmitter.calledWith('user-1', 'chapterbot_epub_failed')).to.equal(true)

    const again = await call('cancelEpubJob', { params: { jobId: JOB_ID } })
    expect(again.statusCode).to.equal(409)
    const unknown = await call('cancelEpubJob', { params: { jobId: 'f'.repeat(32) } })
    expect(unknown.statusCode).to.equal(404)
    expect(fs.readdirSync(itemDir)).to.deep.equal([])
  })

  it('follows a running job until the sidecar reports it cancelled', async () => {
    expect((await call('startEpubJob')).statusCode).to.equal(202)
    sidecar.deleteAnswer = { status: 'running', cancelRequested: true }
    const res = await call('cancelEpubJob', { params: { jobId: JOB_ID } })
    expect(res.json.firstCall.args[0]).to.include({ status: 'queued', cancelRequested: true })
    sidecar.state = { ...sidecar.state, status: 'cancelled', cancelRequested: true }
    await until(() => ChapterbotEpubManager.jobs.get(bookItemId).status === 'cancelled')
    expect(clientEmitter.calledWith('user-1', 'chapterbot_epub_failed')).to.equal(true)
  })

  it('reports a failed job to the user and writes nothing', async () => {
    expect((await call('startEpubJob')).statusCode).to.equal(202)
    sidecar.state = { ...sidecar.state, status: 'failed', error: 'audio_failed' }
    await until(() => ChapterbotEpubManager.jobs.get(bookItemId).status === 'failed')
    const [userId, event, payload] = clientEmitter.firstCall.args
    expect([userId, event]).to.deep.equal(['user-1', 'chapterbot_epub_failed'])
    expect(payload).to.include({ status: 'failed', error: 'Chapterbot: audio_failed' })
    expect(fs.readdirSync(itemDir)).to.deep.equal([])
    expect(scanItem.called).to.equal(false)
  })

  it('answers a status GET at once while the finished EPUB is still downloading', async () => {
    expect((await call('startEpubJob')).statusCode).to.equal(202)
    const record = ChapterbotEpubManager.jobs.get(bookItemId)
    // only the GET polls from here on
    ChapterbotEpubManager.pollMs = 60000
    await until(() => !record.refreshing)
    ChapterbotEpubManager.schedule(record)
    sidecar.holdResult = true
    sidecar.state = { ...sidecar.state, status: 'done', progress: 1 }
    record.lastPolledAt = 0

    const res = await call('getEpubJob', { params: { jobId: JOB_ID } })
    expect(res.json.firstCall.args[0]).to.include({ status: 'downloading' })
    await until(() => sidecar.releaseResult)
    expect(record.status).to.equal('downloading')
    // a second poll does not wait for the download either
    expect((await call('getEpubJob', { params: { jobId: JOB_ID } })).json.firstCall.args[0]).to.include({ status: 'downloading' })

    sidecar.releaseResult()
    await until(() => record.status === 'done')
    expect(fs.existsSync(Path.join(itemDir, 'Black Ice (from audio).epub'))).to.equal(true)
    expect(clientEmitter.calledOnceWith('user-1', 'chapterbot_epub_done')).to.equal(true)
  })

  it('fails the job, without crashing, when the staging file cannot be opened', async () => {
    const realCreate = fsExtra.createWriteStream
    sinon.stub(fsExtra, 'createWriteStream').callsFake((path, opts) => realCreate(Path.join(stagingDir, 'missing-dir', 'x.epub'), opts))
    expect((await call('startEpubJob')).statusCode).to.equal(202)
    sidecar.state = { ...sidecar.state, status: 'done' }
    await until(() => ChapterbotEpubManager.jobs.get(bookItemId).status === 'failed')
    expect(ChapterbotEpubManager.jobs.get(bookItemId).error).to.equal('Saving the EPUB into the library failed')
    expect(fs.readdirSync(itemDir)).to.deep.equal([])
    // the open failed before the sidecar was asked for the result
    expect(sidecar.requests.some((r) => r.url === `/v1/jobs/${JOB_ID}/result`)).to.equal(false)
    expect(clientEmitter.calledOnceWith('user-1', 'chapterbot_epub_failed')).to.equal(true)
    expect(watcher.addIgnoreDir.called).to.equal(false)
    expect(watcher.removeIgnoreDir.called).to.equal(false)
  })

  it('lets the watcher back in when the copy into the library fails', async () => {
    sinon.stub(fsExtra, 'copyFile').rejects(Object.assign(new Error('read-only'), { code: 'EROFS' }))
    expect((await call('startEpubJob')).statusCode).to.equal(202)
    sidecar.state = { ...sidecar.state, status: 'done' }
    await until(() => ChapterbotEpubManager.jobs.get(bookItemId).status === 'failed')
    // the record is marked failed inside the copy, before finish() lets the watcher back in
    await ChapterbotEpubManager.jobs.get(bookItemId).finishing
    expect(watcher.addIgnoreDir.calledOnceWith(itemDir)).to.equal(true)
    expect(watcher.removeIgnoreDir.calledOnceWith(itemDir)).to.equal(true)
    expect(scanItem.called).to.equal(false)
  })

  it('leaves a job that finished while being cancelled to the finish path', async () => {
    expect((await call('startEpubJob')).statusCode).to.equal(202)
    sidecar.deleteDelayMs = 100
    sidecar.deleteAnswer = { status: 'deleted' }
    const cancelling = call('cancelEpubJob', { params: { jobId: JOB_ID } })
    // the job ends on the sidecar while the DELETE is in flight; the next poll sees it
    sidecar.state = { ...sidecar.state, status: 'done', progress: 1 }
    const res = await cancelling
    expect(res.statusCode).to.equal(200)
    expect(res.json.firstCall.args[0].status).to.be.oneOf(['downloading', 'done'])
    expect(res.json.firstCall.args[0].cancelRequested).to.equal(false)

    await until(() => ChapterbotEpubManager.jobs.get(bookItemId).status === 'done')
    expect(clientEmitter.callCount).to.equal(1)
    expect(clientEmitter.firstCall.args[1]).to.equal('chapterbot_epub_done')
  })

  it('maps sidecar refusals to 429 / 502 and frees the item', async () => {
    sidecar.createStatus = 429
    let res = await call('startEpubJob')
    expect(res.statusCode).to.equal(429)
    sidecar.createStatus = 400
    res = await call('startEpubJob')
    expect(res.statusCode).to.equal(502)
    expect(JSON.stringify(res.json.firstCall.args[0])).to.not.include(TOKEN)
    expect(ChapterbotEpubManager.jobs.size).to.equal(0)
  })

  describe('read-along', () => {
    const EPUB_NAME = 'Black Ice (from audio).epub'

    async function runJob() {
      expect((await call('startEpubJob')).statusCode).to.equal(202)
      sidecar.state = { ...sidecar.state, status: 'done', progress: 1 }
      await until(() => ChapterbotEpubManager.jobs.get(bookItemId).status === 'done')
    }

    async function placedEpub() {
      const li = await Database.libraryItemModel.getExpandedById(bookItemId)
      const ino = li.libraryFiles.find((f) => f.metadata.filename === EPUB_NAME).ino
      return { li, lf: li.getLibraryFileWithIno(ino) }
    }

    const storedPath = (ino) => Path.join(metadataDir, 'items', bookItemId, 'readalong', `${ino}.json`)

    it('stores the read-along data next to the item metadata, keyed by the EPUB ino, before the sidecar job is deleted', async () => {
      await runJob()
      const { li, lf } = await placedEpub()
      expect(JSON.parse(fs.readFileSync(storedPath(lf.ino), 'utf8'))).to.deep.equal({ epubPath: EPUB_NAME, ...READ_ALONG })
      // nothing extra in the library folder (the watcher and scanner never see the data)
      expect(fs.readdirSync(itemDir)).to.deep.equal([EPUB_NAME])

      await until(() => sidecar.requests.some((r) => r.method === 'DELETE'))
      const calls = sidecar.requests.map((r) => `${r.method} ${r.url}`)
      expect(calls.indexOf(`GET /v1/jobs/${JOB_ID}/readalong`)).to.be.greaterThan(calls.indexOf(`GET /v1/jobs/${JOB_ID}/result`))
      expect(calls.indexOf(`GET /v1/jobs/${JOB_ID}/readalong`)).to.be.lessThan(calls.indexOf(`DELETE /v1/jobs/${JOB_ID}`))
      expect(sidecar.requests.every((r) => r.auth === `Bearer ${TOKEN}`)).to.equal(true)

      const res = await call('getEbookReadAlong', { item: li, libraryFile: lf, params: { fileid: lf.ino } })
      expect(res.sendFile.calledOnce).to.equal(true)
      const [path, opts] = res.sendFile.firstCall.args
      expect(path).to.equal(storedPath(lf.ino))
      expect(opts.headers).to.deep.equal({ 'Content-Type': 'application/json', 'Cache-Control': 'private, no-cache' })
      // the job record and its events are unchanged
      expect(clientEmitter.calledOnceWith('user-1', 'chapterbot_epub_done')).to.equal(true)
    })

    it('a job started by the auto pipeline stores the read-along data too, before its ended event', async () => {
      let storedAtEnd = null
      ChapterbotEpubManager.on('ended', () => {
        const dir = Path.join(metadataDir, 'items', bookItemId, 'readalong')
        storedAtEnd = fs.existsSync(dir) ? fs.readdirSync(dir) : []
      })
      const libraryItem = await Database.libraryItemModel.getExpandedById(bookItemId)
      await ChapterbotEpubManager.start(libraryItem, null, { origin: 'pipeline' })
      sidecar.state = { ...sidecar.state, status: 'done', progress: 1 }
      await until(() => ChapterbotEpubManager.jobs.get(bookItemId).status === 'done')
      const { lf } = await placedEpub()
      expect(JSON.parse(fs.readFileSync(storedPath(lf.ino), 'utf8'))).to.deep.equal({ epubPath: EPUB_NAME, ...READ_ALONG })
      expect(storedAtEnd).to.deep.equal([`${lf.ino}.json`])
    })

    it('saves the EPUB without read-along data when the sidecar has none (older sidecar)', async () => {
      sidecar.readAlong = null
      await runJob()
      expect(fs.existsSync(Path.join(itemDir, EPUB_NAME))).to.equal(true)
      expect(fs.existsSync(Path.join(metadataDir, 'items', bookItemId, 'readalong'))).to.equal(false)
      expect(Logger.warn.calledWithMatch(/no read-along data/)).to.equal(true)
      expect(clientEmitter.calledOnceWith('user-1', 'chapterbot_epub_done')).to.equal(true)

      const { li, lf } = await placedEpub()
      const res = await call('getEbookReadAlong', { item: li, libraryFile: lf, params: { fileid: lf.ino } })
      expect(res.sendStatus.calledOnceWith(404)).to.equal(true)
      expect(res.sendFile.called).to.equal(false)
    })

    for (const [label, body] of [
      ['invalid read-along data', JSON.stringify({ ...READ_ALONG, version: 2 })],
      ['a body that is not JSON', 'not json']
    ]) {
      it(`finishes the job but stores nothing for ${label}`, async () => {
        sidecar.readAlong = body
        await runJob()
        expect(ChapterbotEpubManager.jobs.get(bookItemId).error).to.equal(null)
        expect(fs.existsSync(Path.join(itemDir, EPUB_NAME))).to.equal(true)
        expect(fs.existsSync(Path.join(metadataDir, 'items', bookItemId, 'readalong'))).to.equal(false)
        expect(Logger.warn.calledWithMatch(/Saving the read-along data of EPUB job/)).to.equal(true)
        expect(clientEmitter.calledOnceWith('user-1', 'chapterbot_epub_done')).to.equal(true)
      })
    }

    it('finds the data again after the EPUB ino changed (copy or restore)', async () => {
      await runJob()
      const { li, lf } = await placedEpub()
      li.libraryFiles = li.libraryFiles.map((f) => (f.ino === lf.ino ? { ...f, ino: '987654321' } : f))
      li.changed('libraryFiles', true)
      await li.save()
      const moved = await Database.libraryItemModel.getExpandedById(bookItemId)
      const res = await call('getEbookReadAlong', { item: moved, libraryFile: moved.getLibraryFileWithIno('987654321'), params: { fileid: '987654321' } })
      expect(res.sendFile.firstCall.args[0]).to.equal(storedPath('987654321'))
      expect(fs.existsSync(storedPath(lf.ino))).to.equal(false)
    })

    it('removes the data when the EPUB file is deleted through the server', async () => {
      await runJob()
      const { li, lf } = await placedEpub()
      expect(fs.existsSync(storedPath(lf.ino))).to.equal(true)
      const res = await call('deleteLibraryFile', { item: li, libraryFile: lf, params: { fileid: lf.ino } })
      expect(res.sendStatus.calledOnceWith(200)).to.equal(true)
      expect(fs.existsSync(Path.join(itemDir, EPUB_NAME))).to.equal(false)
      expect(fs.existsSync(storedPath(lf.ino))).to.equal(false)
    })

    it('answers 400 for a library file that is not an EPUB', async () => {
      const li = await Database.libraryItemModel.getExpandedById(bookItemId)
      const cases = [
        { ino: 'ino0', fileType: 'audio', isEBookFile: false, metadata: { ext: '.mp3' } },
        { ino: 'pdf', fileType: 'ebook', isEBookFile: true, metadata: { ext: '.pdf' } }
      ]
      for (const libraryFile of cases) {
        const res = await call('getEbookReadAlong', { item: li, libraryFile, params: { fileid: libraryFile.ino } })
        expect(res.statusCode, libraryFile.metadata.ext).to.equal(400)
        expect(res.sendFile.called).to.equal(false)
      }
    })

    it('is served over HTTP to any user with access to the item, next to the ebook download', async () => {
      await runJob()
      const { lf } = await placedEpub()
      let reqUser = user({ canUpdate: false })
      const app = express()
      app.use((req, res, next) => {
        req.user = reqUser
        next()
      })
      app.use('/api', apiRouter.router)
      const server = await new Promise((resolve) => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s))
      })
      const base = `http://127.0.0.1:${server.address().port}/api/items/${bookItemId}/ebook`
      try {
        let res = await fetch(`${base}/${lf.ino}/readalong`)
        expect(res.status).to.equal(200)
        expect(res.headers.get('content-type')).to.match(/^application\/json/)
        expect(res.headers.get('cache-control')).to.equal('private, no-cache')
        expect(await res.json()).to.deep.equal({ epubPath: EPUB_NAME, ...READ_ALONG })

        // the ebook route still serves the EPUB itself
        res = await fetch(`${base}/${lf.ino}`)
        expect(res.status).to.equal(200)
        expect(Buffer.from(await res.arrayBuffer()).equals(EPUB_BYTES)).to.equal(true)

        expect((await fetch(`${base}/no-such-file/readalong`)).status).to.equal(404)

        reqUser = user({ checkCanAccessLibraryItem: () => false })
        expect((await fetch(`${base}/${lf.ino}/readalong`)).status).to.equal(403)
      } finally {
        await new Promise((resolve) => server.close(resolve))
      }
    })
  })

  describe('current job for any viewer (chapterbotEpubCurrent)', () => {
    let broadcasts

    beforeEach(() => {
      broadcasts = []
      sinon.stub(SocketAuthority, 'emitter').callsFake((evt, data, filter) => broadcasts.push({ evt, data, filter }))
    })

    it('registers GET /items/:id/epub', () => {
      const routes = apiRouter.router._router.stack.filter((l) => l.route).map((l) => `${Object.keys(l.route.methods).join(',')} ${l.route.path} ${l.route.stack[l.route.stack.length - 1].handle.name}`)
      expect(routes).to.include('get /items/:id/epub bound getCurrentEpubJob')
    })

    it('returns the item job without a job id, to users without update permission too', async () => {
      const none = await call('getCurrentEpubJob', { reqUser: user({ canUpdate: false }) })
      expect(none.statusCode).to.equal(404)

      expect((await call('startEpubJob')).statusCode).to.equal(202)
      sidecar.state = { ...sidecar.state, status: 'running', stage: 'transcribing', progress: 0.25, chaptersDone: 1 }
      await until(() => ChapterbotEpubManager.jobs.get(bookItemId).status === 'running')
      const viewer = user({ id: 'user-2', canUpdate: false })
      const res = await call('getCurrentEpubJob', { reqUser: viewer })
      expect(res.statusCode).to.equal(200)
      expect(res.json.firstCall.args[0]).to.include({ jobId: JOB_ID, libraryItemId: bookItemId, status: 'running', progress: 0.25, origin: 'user' })

      // the read-only route passes the item middleware for a user without canUpdate
      const mwRes = fakeResponse()
      const next = sinon.spy()
      await LibraryItemController.middleware.bind(apiRouter)({ method: 'GET', path: `/items/${bookItemId}/epub`, user: viewer, params: { id: bookItemId } }, mwRes, next)
      expect(next.calledOnce).to.equal(true)

      sidecar.state = { ...sidecar.state, status: 'done', progress: 1 }
      await until(() => ChapterbotEpubManager.jobs.get(bookItemId).status === 'done')
      // the finished job stays visible
      const done = await call('getCurrentEpubJob', { reqUser: viewer })
      expect(done.json.firstCall.args[0]).to.include({ status: 'done', fileName: 'Black Ice (from audio).epub' })
    })

    it('broadcasts progress to everyone who can access the item', async () => {
      expect((await call('startEpubJob')).statusCode).to.equal(202)
      sidecar.state = { ...sidecar.state, status: 'running', stage: 'transcribing', progress: 0.5, chaptersDone: 2 }
      await until(() => broadcasts.some((b) => b.data.progress === 0.5))
      sidecar.state = { ...sidecar.state, status: 'done', progress: 1 }
      await until(() => ChapterbotEpubManager.jobs.get(bookItemId).status === 'done')

      const updates = broadcasts.filter((b) => b.evt === 'chapterbot_epub_updated')
      const statuses = updates.map((b) => b.data.status)
      expect(statuses[0]).to.equal('queued')
      expect(statuses).to.include.members(['running', 'downloading', 'done'])
      // an unchanged poll is not sent again
      expect(updates.filter((b) => b.data.status === 'running' && b.data.progress === 0.5)).to.have.length(1)
      // only to users who can access the item
      const filter = updates[0].filter
      const seen = []
      expect(filter({ checkCanAccessLibraryItem: (li) => seen.push(li) > 0 })).to.equal(true)
      expect(filter({ checkCanAccessLibraryItem: () => false })).to.equal(false)
      expect(seen[0]).to.deep.include({ libraryId })
      expect(seen[0].media).to.deep.equal({ explicit: false, tags: [] })
      // the starting user still gets the done event
      expect(clientEmitter.calledWith('user-1', 'chapterbot_epub_done')).to.equal(true)
    })

    it('a job started by the auto pipeline has no user and reports its end through the ended event', async () => {
      const ended = []
      ChapterbotEpubManager.on('ended', (job) => ended.push(job))
      const libraryItem = await Database.libraryItemModel.getExpandedById(bookItemId)
      const job = await ChapterbotEpubManager.start(libraryItem, null, { origin: 'pipeline' })
      expect(job).to.include({ origin: 'pipeline', status: 'queued' })
      sidecar.state = { ...sidecar.state, status: 'failed', error: 'audio_failed' }
      await until(() => ended.length === 1)
      expect(ended[0]).to.include({ jobId: JOB_ID, status: 'failed', origin: 'pipeline', userId: null })
      expect(clientEmitter.called).to.equal(false)
      expect(broadcasts.some((b) => b.evt === 'chapterbot_epub_updated' && b.data.status === 'failed')).to.equal(true)
    })
  })

  describe('restart (persisted jobs)', () => {
    let persistPath

    beforeEach(() => {
      persistPath = Path.join(stagingDir, 'pipeline', 'epub-jobs.json')
      sinon.stub(SocketAuthority, 'emitter')
    })

    function freshManager() {
      const m = new ChapterbotEpubManager.ChapterbotEpubManager()
      m.pollMs = 10
      m.tempDir = stagingDir
      m.scanItem = scanItem
      m.watcher = watcher
      return m
    }

    it('persists running jobs; an ended job is kept as finished (not followed again)', async () => {
      await ChapterbotEpubManager.init({ persistPath })
      expect(JSON.parse(fs.readFileSync(persistPath, 'utf8'))).to.deep.equal([])
      expect((await call('startEpubJob')).statusCode).to.equal(202)
      await ChapterbotEpubManager.persistChain
      const entries = JSON.parse(fs.readFileSync(persistPath, 'utf8'))
      expect(entries).to.have.length(1)
      expect(entries[0]).to.include({ libraryItemId: bookItemId, jobId: JOB_ID, origin: 'user', userId: 'user-1' })
      expect(entries[0]).to.not.have.property('status')

      sidecar.state = { ...sidecar.state, status: 'cancelled' }
      await until(() => ChapterbotEpubManager.jobs.get(bookItemId).status === 'cancelled')
      await ChapterbotEpubManager.persistChain
      const after = JSON.parse(fs.readFileSync(persistPath, 'utf8'))
      expect(after).to.have.length(1)
      expect(after[0]).to.include({ libraryItemId: bookItemId, jobId: JOB_ID, status: 'cancelled' })
    })

    it('the latest finished job still answers GET after a restart, until the TTL', async () => {
      await ChapterbotEpubManager.init({ persistPath })
      expect((await call('startEpubJob')).statusCode).to.equal(202)
      sidecar.state = { ...sidecar.state, status: 'done', progress: 1 }
      await until(() => ChapterbotEpubManager.jobs.get(bookItemId).status === 'done')
      await ChapterbotEpubManager.persistChain
      ChapterbotEpubManager.reset()

      const restarted = freshManager()
      try {
        await restarted.init({ persistPath })
        const requestsBefore = sidecar.requests.length
        const current = await restarted.getCurrent(bookItemId)
        expect(current).to.include({ jobId: JOB_ID, status: 'done', fileName: 'Black Ice (from audio).epub', progress: 1 })
        // finished: never polled again
        expect(sidecar.requests.length).to.equal(requestsBefore)
        expect(restarted.jobs.get(bookItemId).access.libraryId).to.be.a('string')

        // past the TTL it is gone (and dropped from the file)
        const later = freshManager()
        later.now = () => Date.now() + 25 * 3600 * 1000
        await later.init({ persistPath })
        expect(await later.getCurrent(bookItemId)).to.equal(null)
        await later.persistChain
        expect(JSON.parse(fs.readFileSync(persistPath, 'utf8'))).to.deep.equal([])
        later.reset()
      } finally {
        restarted.reset()
      }
    })

    it('keeps a running entry for the next start when chapterbot is not configured at boot', async () => {
      fs.mkdirSync(Path.dirname(persistPath), { recursive: true })
      const entry = { libraryItemId: bookItemId, jobId: 'f'.repeat(32), origin: 'pipeline', userId: null, createdAt: 1 }
      fs.writeFileSync(persistPath, JSON.stringify([entry]))
      const restarted = freshManager()
      restarted.client = { ...restarted.client, isConfigured: () => false }
      try {
        await restarted.init({ persistPath })
        expect(restarted.jobs.size).to.equal(0)
        await restarted.persistChain
        expect(JSON.parse(fs.readFileSync(persistPath, 'utf8'))).to.deep.equal([entry])
      } finally {
        restarted.reset()
      }
    })

    it('follows a job again after a restart and writes its EPUB into the library', async () => {
      await ChapterbotEpubManager.init({ persistPath })
      expect((await call('startEpubJob')).statusCode).to.equal(202)
      await ChapterbotEpubManager.persistChain
      // the server stops; the job finishes on the sidecar meanwhile
      ChapterbotEpubManager.reset()
      sidecar.state = { ...sidecar.state, status: 'done', progress: 1 }

      const restarted = freshManager()
      const ended = []
      restarted.on('ended', (job) => ended.push(job))
      try {
        await restarted.init({ persistPath })
        await until(() => ended.length === 1)
        expect(ended[0]).to.include({ status: 'done', fileName: 'Black Ice (from audio).epub', origin: 'user', userId: 'user-1', ebookRole: 'primary' })
        expect((await Database.libraryItemModel.getExpandedById(bookItemId)).media.ebookFile.metadata.filename).to.equal('Black Ice (from audio).epub')
        expect(fs.existsSync(Path.join(itemDir, 'Black Ice (from audio).epub'))).to.equal(true)
        // the read-along data is saved for a job followed again after the restart too
        const li = await Database.libraryItemModel.getExpandedById(bookItemId)
        const ino = li.libraryFiles.find((f) => f.metadata.filename === 'Black Ice (from audio).epub').ino
        expect(JSON.parse(fs.readFileSync(Path.join(metadataDir, 'items', bookItemId, 'readalong', `${ino}.json`), 'utf8'))).to.deep.equal({ epubPath: 'Black Ice (from audio).epub', ...READ_ALONG })
        expect(clientEmitter.calledWith('user-1', 'chapterbot_epub_done')).to.equal(true)
        expect((await restarted.getCurrent(bookItemId)).status).to.equal('done')
        await restarted.persistChain
        // kept as finished only
        const left = JSON.parse(fs.readFileSync(persistPath, 'utf8'))
        expect(left.map((e) => e.status)).to.deep.equal(['done'])
      } finally {
        restarted.reset()
      }
    })

    it('resumes a job a chapterbot restart interrupted, at most 3 times (the count is persisted)', async () => {
      await ChapterbotEpubManager.init({ persistPath })
      expect((await call('startEpubJob')).statusCode).to.equal(202)
      const record = () => ChapterbotEpubManager.getRecord(bookItemId)
      const resumes = () => sidecar.requests.filter((r) => r.method === 'POST' && r.url === `/v1/jobs/${JOB_ID}/resume`).length
      const interrupt = () => (sidecar.state = { ...sidecar.state, status: 'failed', error: 'interrupted by a service restart', resumable: true })
      for (let i = 1; i <= 3; i++) {
        interrupt()
        await ChapterbotEpubManager.refresh(record())
        expect(resumes()).to.equal(i)
        expect(record().status).to.equal('queued')
      }
      await ChapterbotEpubManager.persistChain
      expect(JSON.parse(fs.readFileSync(persistPath, 'utf8'))[0]).to.include({ restartResumes: 3 })
      interrupt()
      await ChapterbotEpubManager.refresh(record())
      expect(resumes()).to.equal(3)
      expect(record().status).to.equal('failed')
    })

    it('does not resume an interrupted job the user had asked to cancel, or one that failed on its own', async () => {
      await ChapterbotEpubManager.init({ persistPath })
      expect((await call('startEpubJob')).statusCode).to.equal(202)
      ChapterbotEpubManager.getRecord(bookItemId).cancelRequested = true
      sidecar.state = { ...sidecar.state, status: 'failed', error: 'interrupted by a service restart', resumable: true }
      await ChapterbotEpubManager.refresh(ChapterbotEpubManager.getRecord(bookItemId))
      expect(ChapterbotEpubManager.getRecord(bookItemId).status).to.equal('failed')

      ChapterbotEpubManager.reset()
      await ChapterbotEpubManager.init({ persistPath })
      sidecar.state = { ...sidecar.state, status: 'queued', error: null }
      expect((await call('startEpubJob')).statusCode).to.equal(202)
      sidecar.state = { ...sidecar.state, status: 'failed', error: 'AudioError: decode failed', resumable: true }
      await ChapterbotEpubManager.refresh(ChapterbotEpubManager.getRecord(bookItemId))
      expect(ChapterbotEpubManager.getRecord(bookItemId).status).to.equal('failed')
      expect(sidecar.requests.some((r) => r.url.endsWith('/resume'))).to.equal(false)
    })

    it('a job the sidecar no longer knows is marked failed; entries for deleted items are dropped', async () => {
      fs.mkdirSync(Path.dirname(persistPath), { recursive: true })
      fs.writeFileSync(
        persistPath,
        JSON.stringify([
          { libraryItemId: bookItemId, jobId: 'e'.repeat(32), origin: 'pipeline', userId: null, createdAt: 1 },
          { libraryItemId: 'gone-item', jobId: 'd'.repeat(32), origin: 'user', userId: 'user-1', createdAt: 1 },
          { libraryItemId: 'x', jobId: '../../etc' }
        ])
      )
      const restarted = freshManager()
      const ended = []
      restarted.on('ended', (job) => ended.push(job))
      try {
        await restarted.init({ persistPath })
        expect(restarted.jobs.size).to.equal(1)
        await until(() => ended.length === 1)
        expect(ended[0]).to.include({ status: 'failed', error: 'The job no longer exists on chapterbot', origin: 'pipeline' })
        // the sidecar was told to delete the job of the missing item
        await until(() => sidecar.requests.some((r) => r.method === 'DELETE' && r.url === `/v1/jobs/${'d'.repeat(32)}`))
      } finally {
        restarted.reset()
      }
    })
  })
})
