const { expect } = require('chai')
const { Sequelize } = require('sequelize')
const sinon = require('sinon')
const http = require('http')
const os = require('os')
const Path = require('path')
const fs = require('fs')
const EventEmitter = require('events')

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

const TOKEN = 'epub-test-token-0123456789'
const JOB_ID = '0123456789abcdef0123456789abcdef'
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
    deleteAnswer: { status: 'cancelled' }
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
        res.writeHead(200, { 'Content-Type': 'application/epub+zip' })
        return res.end(EPUB_BYTES)
      }
      if (req.method === 'DELETE' && req.url === `/v1/jobs/${JOB_ID}`) return json(200, { id: JOB_ID, ...sidecar.deleteAnswer })
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
    return res
  }

  async function call(handler, { item, reqUser = user(), params = {} } = {}) {
    const libraryItem = item || (await Database.libraryItemModel.getExpandedById(bookItemId))
    const res = fakeResponse()
    await LibraryItemController[handler].bind(apiRouter)({ user: reqUser, libraryItem, params: { id: libraryItem.id, ...params }, body: {} }, res)
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
      const lf = { ino: `epub-${name}`, isSupplementary: false, fileType: 'ebook', metadata: { filename: name, ext: '.epub', path: filePathToPOSIX(Path.join(itemDir, name)), relPath: name } }
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
  })

  afterEach(async () => {
    ChapterbotEpubManager.reset()
    chapterbotClient.configure({})
    sinon.restore()
    await sidecar.close()
    fs.rmSync(itemDir, { recursive: true, force: true })
    fs.rmSync(stagingDir, { recursive: true, force: true })
    await Database.sequelize.sync({ force: true })
  })

  it('registers the routes', () => {
    const routes = apiRouter.router._router.stack.filter((l) => l.route).map((l) => `${Object.keys(l.route.methods).join(',')} ${l.route.path} ${l.route.stack[l.route.stack.length - 1].handle.name}`)
    expect(routes).to.include('post /items/:id/epub bound startEpubJob')
    expect(routes).to.include('get /items/:id/epub/:jobId bound getEpubJob')
    expect(routes).to.include('delete /items/:id/epub/:jobId bound cancelEpubJob')
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

  it('starts a job, follows it, writes the EPUB as a supplementary ebook and tells the user', async () => {
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

    const reloaded = await Database.libraryItemModel.getExpandedById(bookItemId)
    expect(reloaded.media.ebookFile).to.equal(null)
    expect(reloaded.libraryFiles.find((lf) => lf.metadata.filename === 'Black Ice (from audio).epub').isSupplementary).to.equal(true)

    expect(clientEmitter.calledOnce).to.equal(true)
    const [userId, event, payload] = clientEmitter.firstCall.args
    expect(userId).to.equal('user-1')
    expect(event).to.equal('chapterbot_epub_done')
    expect(payload).to.include({ jobId: JOB_ID, libraryItemId: bookItemId, status: 'done', fileName: 'Black Ice (from audio).epub' })

    const done = await call('getEpubJob', { params: { jobId: JOB_ID } })
    expect(done.json.firstCall.args[0]).to.include({ status: 'done', fileName: 'Black Ice (from audio).epub' })

    // the finished job is cleaned up on the sidecar, and a new job may start
    await until(() => sidecar.requests.some((r) => r.method === 'DELETE'))
    expect(sidecar.requests.every((r) => r.auth === `Bearer ${TOKEN}`)).to.equal(true)
    expect((await call('startEpubJob')).statusCode).to.equal(202)
  })

  it('never overwrites an existing file and leaves an existing primary ebook alone', async () => {
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
})
