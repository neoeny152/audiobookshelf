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
const AutoPipelineController = require('../../../server/controllers/AutoPipelineController')
const LibraryController = require('../../../server/controllers/LibraryController')
const LibraryItemController = require('../../../server/controllers/LibraryItemController')
const AutoPipelineManager = require('../../../server/managers/AutoPipelineManager')
const { defaultAutoPipelineSettings } = require('../../../server/utils/autoPipeline/settings')

function fakeResponse() {
  const res = new EventEmitter()
  res.statusCode = 200
  res.body = undefined
  res.status = sinon.spy((code) => {
    res.statusCode = code
    return res
  })
  res.json = sinon.spy((body) => {
    res.body = body
    return res
  })
  res.send = sinon.spy((body) => {
    res.body = body
    return res
  })
  res.sendStatus = sinon.spy((code) => {
    res.statusCode = code
    return res
  })
  return res
}

const user = (overrides = {}) => ({ id: 'user-1', username: 'neo', canUpdate: true, canDelete: false, isAdminOrUp: true, checkCanAccessLibrary: () => true, checkCanAccessLibraryItem: () => true, ...overrides })

describe('AutoPipelineController', () => {
  let apiRouter
  let metadataDir
  let library
  let libraryItem

  async function call(handler, { reqUser = user(), body = {}, query = {}, params = {}, item = libraryItem } = {}) {
    const res = fakeResponse()
    const lib = await Database.libraryModel.findByIdWithFolders(library.id)
    await AutoPipelineController[handler].bind(apiRouter)({ user: reqUser, library: lib, libraryItem: item, body, query, params: { id: item?.id, ...params } }, res)
    return res
  }

  beforeEach(async () => {
    metadataDir = fs.mkdtempSync(Path.join(os.tmpdir(), 'abs-pipeline-ctl-'))
    global.MetadataPath = metadataDir
    global.ServerSettings = { storeMetadataWithItem: false, metadataFileFormat: 'json' }
    Database.sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false })
    Database.sequelize.uppercaseFirst = (str) => (str ? `${str[0].toUpperCase()}${str.substr(1)}` : '')
    await Database.buildModels()
    apiRouter = new ApiRouter({ auth: new Auth(), apiCacheManager: new ApiCacheManager() })
    sinon.stub(Logger, 'info')
    sinon.stub(Logger, 'warn')
    sinon.stub(Logger, 'error')
    sinon.stub(Logger, 'debug')
    sinon.stub(SocketAuthority, 'emitter')

    library = await Database.libraryModel.create({ name: 'Books', mediaType: 'book', provider: 'audible', settings: Database.libraryModel.getDefaultLibrarySettingsForMediaType('book') })
    const folder = await Database.libraryFolderModel.create({ path: '/books', libraryId: library.id })
    const book = await Database.bookModel.create({ title: 'Black Ice', audioFiles: [], tags: [], narrators: [], genres: [], chapters: [] })
    const li = await Database.libraryItemModel.create({ title: 'Black Ice', libraryFiles: [], mediaId: book.id, mediaType: 'book', libraryId: library.id, libraryFolderId: folder.id, path: '/books/Black Ice', relPath: 'Black Ice' })
    libraryItem = await Database.libraryItemModel.getExpandedById(li.id)

    await AutoPipelineManager.reset()
    AutoPipelineManager.autoRun = false
    await AutoPipelineManager.init(apiRouter, { root: Path.join(metadataDir, 'pipeline'), gate: true })
  })

  afterEach(async () => {
    await AutoPipelineManager.reset()
    AutoPipelineManager.autoRun = true
    AutoPipelineManager.gate = false
    sinon.restore()
    await Database.sequelize.close()
    fs.rmSync(metadataDir, { recursive: true, force: true })
  })

  it('registers the routes', () => {
    const routes = apiRouter.router._router.stack.filter((l) => l.route).map((l) => `${Object.keys(l.route.methods).join(',')} ${l.route.path} ${l.route.stack[l.route.stack.length - 1].handle.name}`)
    for (const r of [
      'get /libraries/:id/pipeline bound getLibraryPipeline',
      'post /libraries/:id/pipeline/run bound runLibraryPipeline',
      'get /items/:id/pipeline bound getItemPipeline',
      'post /items/:id/pipeline/run bound runItemPipeline',
      'delete /items/:id/pipeline bound dismissItemPipeline',
      'get /items/:id/pipeline/proposal bound getProposal',
      'post /items/:id/pipeline/proposal/approve bound approveProposal',
      'post /items/:id/pipeline/proposal/reject bound rejectProposal',
      'get /items/:id/pipeline/backups bound listBackups',
      'post /items/:id/pipeline/backups/:name/restore bound restoreBackup'
    ]) {
      expect(routes).to.include(r)
    }
  })

  it('every route needs canUpdate', async () => {
    for (const handler of ['getLibraryPipeline', 'runLibraryPipeline', 'getItemPipeline', 'runItemPipeline', 'dismissItemPipeline', 'getProposal', 'approveProposal', 'rejectProposal', 'listBackups', 'restoreBackup']) {
      const res = await call(handler, { reqUser: user({ canUpdate: false }) })
      expect(res.sendStatus.calledWith(403), handler).to.equal(true)
    }
  })

  it('answers 404 on a server without ABS_AUTO_PIPELINE=1', async () => {
    AutoPipelineManager.gate = false
    for (const handler of ['getLibraryPipeline', 'runItemPipeline', 'getItemPipeline']) {
      const res = await call(handler)
      expect(res.statusCode, handler).to.equal(404)
    }
    expect(AutoPipelineManager.states.size).to.equal(0)
  })

  it('running a whole library needs an admin and a valid scope', async () => {
    expect((await call('runLibraryPipeline', { reqUser: user({ isAdminOrUp: false }) })).sendStatus.calledWith(403)).to.equal(true)
    expect((await call('runLibraryPipeline', { body: { scope: 'everything' } })).statusCode).to.equal(400)
    const res = await call('runLibraryPipeline', { body: { scope: 'unprocessed' } })
    expect(res.body).to.deep.equal({ queued: 1 })
  })

  it('runs, reads and dismisses one item', async () => {
    expect((await call('getItemPipeline')).statusCode).to.equal(404)
    expect((await call('runItemPipeline', { body: { steps: ['bogus'] } })).statusCode).to.equal(400)
    expect((await call('runItemPipeline', { body: { steps: [] } })).statusCode).to.equal(400)
    expect((await call('runItemPipeline', { body: { force: 'yes' } })).statusCode).to.equal(400)

    const run = await call('runItemPipeline', { body: { steps: ['chapters', 'chapters'], force: true } })
    expect(run.statusCode).to.equal(202)
    expect(run.body).to.include({ libraryItemId: libraryItem.id, status: 'queued', force: true, trigger: 'manual' })
    expect(run.body.steps).to.deep.equal(['chapters'])

    const get = await call('getItemPipeline')
    expect(get.body).to.include({ libraryItemId: libraryItem.id })

    const summary = await call('getLibraryPipeline', { query: { status: 'queued' } })
    expect(summary.body).to.include({ mode: 'off', gate: true })
    expect(summary.body.items).to.have.length(1)
    expect((await call('getLibraryPipeline', { query: { status: 'nope' } })).statusCode).to.equal(400)

    expect((await call('getProposal')).statusCode).to.equal(404)
    expect((await call('approveProposal')).statusCode).to.equal(409)
    expect((await call('rejectProposal', { body: { continue: 'x' } })).statusCode).to.equal(400)
    expect((await call('listBackups')).body).to.deep.equal({ backups: [] })
    expect((await call('restoreBackup', { params: { name: 'chapters-2026-01-01T00-00-00.000Z.json' } })).statusCode).to.equal(404)

    expect((await call('dismissItemPipeline')).sendStatus.calledWith(200)).to.equal(true)
    expect((await call('dismissItemPipeline')).statusCode).to.equal(404)
  })

  it('a fix run: booleans only, and only an admin may allow rewriting the MP3s', async () => {
    expect((await call('runItemPipeline', { body: { fix: 1 } })).statusCode).to.equal(400)
    expect((await call('runItemPipeline', { body: { repairSeekIndex: 'yes' } })).statusCode).to.equal(400)
    expect((await call('runItemPipeline', { body: { fix: true, repairSeekIndex: true }, reqUser: user({ isAdminOrUp: false }) })).sendStatus.calledWith(403)).to.equal(true)

    const run = await call('runItemPipeline', { body: { fix: true, repairSeekIndex: true } })
    expect(run.statusCode).to.equal(202)
    expect(run.body).to.include({ trigger: 'fix', force: true, repairConsent: true, userId: 'user-1' })
    expect(run.body.steps).to.deep.equal(['match', 'chapters'])
  })

  it('the item middleware lets canUpdate users dismiss without canDelete', async () => {
    const run = async (method, path, reqUser) => {
      const res = fakeResponse()
      const next = sinon.spy()
      await LibraryItemController.middleware.bind(apiRouter)({ method, path, user: reqUser, params: { id: libraryItem.id } }, res, next)
      return { res, next }
    }
    expect((await run('DELETE', `/items/${libraryItem.id}/pipeline`, user({ canDelete: false }))).next.calledOnce).to.equal(true)
    expect((await run('DELETE', `/items/${libraryItem.id}`, user({ canDelete: false }))).res.sendStatus.calledWith(403)).to.equal(true)
    expect((await run('POST', `/items/${libraryItem.id}/pipeline/run`, user({ canUpdate: false }))).res.sendStatus.calledWith(403)).to.equal(true)
  })

  describe('library settings', () => {
    async function update(settings, reqUser = user()) {
      const res = fakeResponse()
      sinon.stub(Database, 'resetLibraryIssuesFilterData').resolves()
      try {
        const lib = await Database.libraryModel.findByIdWithFolders(library.id)
        await LibraryController.update.bind(apiRouter)({ user: reqUser, library: lib, body: { settings } }, res)
      } finally {
        Database.resetLibraryIssuesFilterData.restore()
      }
      return res
    }
    const stored = async () => (await Database.libraryModel.findByPk(library.id)).settings.autoPipeline

    it('new book libraries get the defaults (off)', async () => {
      expect(await stored()).to.deep.equal(defaultAutoPipelineSettings())
    })

    it('merges a partial object and validates every field', async () => {
      let res = await update({ autoPipeline: { mode: 'dryRun', autoEpub: true } })
      expect(res.statusCode).to.equal(200)
      expect(await stored()).to.deep.equal({ ...defaultAutoPipelineSettings(), mode: 'dryRun', autoEpub: true })
      expect(res.body.settings.autoPipeline.mode).to.equal('dryRun')

      res = await update({ autoPipeline: { autoMatchMinConfidence: 120 } })
      expect(res.statusCode).to.equal(400)
      expect(res.body).to.include('autoMatchMinConfidence')
      res = await update({ autoPipeline: 'on' })
      expect(res.statusCode).to.equal(400)
      res = await update({ autoPipeline: { mode: 'always' } })
      expect(res.statusCode).to.equal(400)
      expect(await stored()).to.deep.equal({ ...defaultAutoPipelineSettings(), mode: 'dryRun', autoEpub: true })
    })

    it('saves from clients that do not know the setting keep it', async () => {
      await update({ autoPipeline: { mode: 'on', settleMinutes: 10 } })
      // what the stock web client and the apps send
      const res = await update({ hideSingleBookSeries: true, coverAspectRatio: 0 })
      expect(res.statusCode).to.equal(200)
      const lib = await Database.libraryModel.findByPk(library.id)
      expect(lib.settings.hideSingleBookSeries).to.equal(true)
      expect(lib.settings.autoPipeline).to.include({ mode: 'on', settleMinutes: 10 })
      // a client that echoes the whole settings object back
      expect((await update({ ...lib.settings })).statusCode).to.equal(200)
      expect(await stored()).to.include({ mode: 'on', settleMinutes: 10 })
    })

    it('switching from dry run to on clears the dry-run results', async () => {
      await update({ autoPipeline: { mode: 'dryRun' } })
      const spy = sinon.spy(AutoPipelineManager, 'onLibrarySettingsChanged')
      await update({ autoPipeline: { mode: 'on' } })
      expect(spy.calledOnce).to.equal(true)
      expect(spy.firstCall.args[1]).to.include({ mode: 'dryRun' })
    })

    it('create rejects an invalid autoPipeline', async () => {
      const res = fakeResponse()
      await LibraryController.create.bind(apiRouter)({ user: user(), body: { name: 'New', folders: [{ fullPath: '/x' }], settings: { autoPipeline: { settleMinutes: 0 } } } }, res)
      expect(res.statusCode).to.equal(400)
      expect(res.body).to.include('settleMinutes')
    })
  })
})
