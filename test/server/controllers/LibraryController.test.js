const { expect } = require('chai')
const { Sequelize } = require('sequelize')
const sinon = require('sinon')

const Database = require('../../../server/Database')
const LibraryController = require('../../../server/controllers/LibraryController')
const zipHelpers = require('../../../server/utils/zipHelpers')
const Logger = require('../../../server/Logger')

describe('LibraryController.downloadMultiple', () => {
  let library
  let libraryFolder
  let allowedItemId
  let explicitItemId
  let taggedItemId
  let restrictedUser
  let libraryRecord

  beforeEach(async () => {
    global.ServerSettings = {}
    Database.sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false })
    Database.sequelize.uppercaseFirst = (str) => (str ? `${str[0].toUpperCase()}${str.substr(1)}` : '')
    await Database.buildModels()

    library = await Database.libraryModel.create({ name: 'Test Library', mediaType: 'book' })
    libraryFolder = await Database.libraryFolderModel.create({ path: '/test-lib', libraryId: library.id })
    libraryRecord = await Database.libraryModel.findByIdWithFolders(library.id)

    const allowedBook = await Database.bookModel.create({
      title: 'Allowed Book',
      explicit: false,
      audioFiles: [],
      tags: ['allowed-tag'],
      narrators: [],
      genres: [],
      chapters: []
    })
    const allowedItem = await Database.libraryItemModel.create({
      path: '/test-lib/allowed',
      isFile: false,
      libraryFiles: [],
      mediaId: allowedBook.id,
      mediaType: 'book',
      libraryId: library.id,
      libraryFolderId: libraryFolder.id
    })
    allowedItemId = allowedItem.id

    const explicitBook = await Database.bookModel.create({
      title: 'Explicit Book',
      explicit: true,
      audioFiles: [],
      tags: [],
      narrators: [],
      genres: [],
      chapters: []
    })
    const explicitItem = await Database.libraryItemModel.create({
      path: '/test-lib/explicit',
      isFile: false,
      libraryFiles: [],
      mediaId: explicitBook.id,
      mediaType: 'book',
      libraryId: library.id,
      libraryFolderId: libraryFolder.id
    })
    explicitItemId = explicitItem.id

    const taggedBook = await Database.bookModel.create({
      title: 'Tagged Book',
      explicit: false,
      audioFiles: [],
      tags: ['restricted-tag'],
      narrators: [],
      genres: [],
      chapters: []
    })
    const taggedItem = await Database.libraryItemModel.create({
      path: '/test-lib/tagged',
      isFile: false,
      libraryFiles: [],
      mediaId: taggedBook.id,
      mediaType: 'book',
      libraryId: library.id,
      libraryFolderId: libraryFolder.id
    })
    taggedItemId = taggedItem.id

    const permissions = Database.userModel.getDefaultPermissionsForUserType('user')
    permissions.download = true
    permissions.accessExplicitContent = false
    permissions.accessAllLibraries = false
    permissions.accessAllTags = false
    permissions.librariesAccessible = [library.id]
    permissions.itemTagsSelected = ['allowed-tag']
    permissions.selectedTagsNotAccessible = false

    restrictedUser = await Database.userModel.create({
      username: 'restricted',
      pash: 'hash',
      token: 'token',
      type: 'user',
      isActive: true,
      permissions,
      bookmarks: [],
      extraData: {}
    })

    sinon.stub(Logger, 'info')
    sinon.stub(Logger, 'warn')
    sinon.stub(Logger, 'error')
    sinon.stub(zipHelpers, 'zipDirectoriesPipe').resolves()
  })

  afterEach(async () => {
    sinon.restore()
    await Database.sequelize.sync({ force: true })
  })

  function makeReq(ids) {
    return {
      query: { ids: ids.join(',') },
      user: restrictedUser,
      library: libraryRecord
    }
  }

  function makeRes() {
    return {
      sendStatus: sinon.spy(),
      status: sinon.stub().returnsThis(),
      send: sinon.spy()
    }
  }

  it('returns 403 for bulk download of an explicit item', async () => {
    const req = makeReq([explicitItemId])
    const res = makeRes()

    await LibraryController.downloadMultiple(req, res)

    expect(res.sendStatus.calledWith(403)).to.be.true
    expect(zipHelpers.zipDirectoriesPipe.called).to.be.false
  })

  it('returns 403 for bulk download of a tag-restricted item', async () => {
    const req = makeReq([taggedItemId])
    const res = makeRes()

    await LibraryController.downloadMultiple(req, res)

    expect(res.sendStatus.calledWith(403)).to.be.true
    expect(zipHelpers.zipDirectoriesPipe.called).to.be.false
  })

  it('returns 403 when bulk download includes both allowed and forbidden items', async () => {
    const req = makeReq([allowedItemId, explicitItemId])
    const res = makeRes()

    await LibraryController.downloadMultiple(req, res)

    expect(res.sendStatus.calledWith(403)).to.be.true
    expect(zipHelpers.zipDirectoriesPipe.called).to.be.false
  })

  it('starts zip download for allowed items only', async () => {
    const req = makeReq([allowedItemId])
    const res = makeRes()

    await LibraryController.downloadMultiple(req, res)

    expect(res.sendStatus.called).to.be.false
    expect(zipHelpers.zipDirectoriesPipe.calledOnce).to.be.true
    const pathObjects = zipHelpers.zipDirectoriesPipe.firstCall.args[0]
    expect(pathObjects).to.have.length(1)
    expect(pathObjects[0].path).to.equal('/test-lib/allowed')
  })
  describe('POST /api/libraries/:id/download', () => {
    function makePostReq(body, user = restrictedUser) {
      return { method: 'POST', query: {}, body, user, library: libraryRecord }
    }

    it('accepts an array of ids in the body', async () => {
      const res = makeRes()
      await LibraryController.downloadMultiplePost(makePostReq({ ids: [allowedItemId] }), res)
      expect(res.sendStatus.called).to.be.false
      expect(zipHelpers.zipDirectoriesPipe.calledOnce).to.be.true
      expect(zipHelpers.zipDirectoriesPipe.firstCall.args[0].map((po) => po.path)).to.deep.equal(['/test-lib/allowed'])
    })

    it('accepts a comma separated string of ids in the body (form submit)', async () => {
      const res = makeRes()
      await LibraryController.downloadMultiplePost(makePostReq({ ids: `${allowedItemId}` }), res)
      expect(zipHelpers.zipDirectoriesPipe.calledOnce).to.be.true
    })

    it('applies the same access checks as GET (403 on explicit / tag-restricted items)', async () => {
      for (const ids of [[explicitItemId], [taggedItemId], [allowedItemId, explicitItemId]]) {
        const res = makeRes()
        await LibraryController.downloadMultiplePost(makePostReq({ ids }), res)
        expect(res.sendStatus.calledWith(403)).to.be.true
      }
      expect(zipHelpers.zipDirectoriesPipe.called).to.be.false
    })

    it('returns 403 without download permission', async () => {
      restrictedUser.permissions = { ...restrictedUser.permissions, download: false }
      const res = makeRes()
      await LibraryController.downloadMultiplePost(makePostReq({ ids: [allowedItemId] }), res)
      expect(res.sendStatus.calledWith(403)).to.be.true
      expect(zipHelpers.zipDirectoriesPipe.called).to.be.false
    })

    it('returns 404 when no ids are in this library and 400 for invalid bodies', async () => {
      let res = makeRes()
      await LibraryController.downloadMultiplePost(makePostReq({ ids: ['does-not-exist'] }), res)
      expect(res.status.calledWith(404)).to.be.true

      for (const body of [undefined, {}, { ids: '' }, { ids: [] }, { ids: [5] }, { ids: { a: 1 } }]) {
        res = makeRes()
        await LibraryController.downloadMultiplePost(makePostReq(body), res)
        expect(res.status.calledWith(400), JSON.stringify(body)).to.be.true
      }
      expect(zipHelpers.zipDirectoriesPipe.called).to.be.false
    })

    it('is routed next to the existing GET route and parses JSON and urlencoded bodies like Server.js', async () => {
      const express = require('express')
      const axios = require('axios')
      const ApiRouter = require('../../../server/routers/ApiRouter')
      const Auth = require('../../../server/Auth')
      const ApiCacheManager = require('../../../server/managers/ApiCacheManager')
      const apiRouter = new ApiRouter({ auth: new Auth(), apiCacheManager: new ApiCacheManager() })
      const routes = apiRouter.router._router.stack.filter((l) => l.route).map((l) => `${Object.keys(l.route.methods).join(',')} ${l.route.path}`)
      expect(routes).to.include('get /libraries/:id/download')
      expect(routes).to.include('post /libraries/:id/download')

      // Same body parsers as Server.js, then the real ApiRouter
      zipHelpers.zipDirectoriesPipe.callsFake(async (pathObjects, filename, res) => {
        res.json({ paths: pathObjects.map((po) => po.path) })
      })
      const app = express()
      app.use(express.urlencoded({ extended: true, limit: '5mb' }))
      app.use(express.json({ limit: '10mb' }))
      app.use((req, res, next) => {
        req.user = restrictedUser
        next()
      })
      app.use('/api', apiRouter.router)
      const server = await new Promise((resolve) => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s))
      })
      try {
        const base = `http://127.0.0.1:${server.address().port}/api/libraries/${library.id}/download`
        const formRes = await axios.post(base, new URLSearchParams({ ids: allowedItemId }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })
        expect(formRes.data.paths).to.deep.equal(['/test-lib/allowed'])

        const jsonRes = await axios.post(base, { ids: [allowedItemId] })
        expect(jsonRes.data.paths).to.deep.equal(['/test-lib/allowed'])

        const getRes = await axios.get(`${base}?ids=${allowedItemId}`)
        expect(getRes.data.paths).to.deep.equal(['/test-lib/allowed'])
      } finally {
        await new Promise((resolve) => server.close(resolve))
      }
    })
  })
})
