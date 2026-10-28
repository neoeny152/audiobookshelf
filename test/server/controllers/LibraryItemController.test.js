const { expect } = require('chai')
const { Sequelize } = require('sequelize')
const sinon = require('sinon')

const Database = require('../../../server/Database')
const ApiRouter = require('../../../server/routers/ApiRouter')
const LibraryItemController = require('../../../server/controllers/LibraryItemController')
const ApiCacheManager = require('../../../server/managers/ApiCacheManager')
const Auth = require('../../../server/Auth')
const Logger = require('../../../server/Logger')
const EventEmitter = require('events')
const SocketAuthority = require('../../../server/SocketAuthority')
const ffmpegHelpers = require('../../../server/utils/ffmpegHelpers')
const chapterSnapRunner = require('../../../server/utils/chapterSnapRunner')

describe('LibraryItemController', () => {
  /** @type {ApiRouter} */
  let apiRouter

  beforeEach(async () => {
    global.ServerSettings = {}
    Database.sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false })
    Database.sequelize.uppercaseFirst = (str) => (str ? `${str[0].toUpperCase()}${str.substr(1)}` : '')
    await Database.buildModels()

    apiRouter = new ApiRouter({
      auth: new Auth(),
      apiCacheManager: new ApiCacheManager()
    })

    sinon.stub(Logger, 'info')
  })

  afterEach(async () => {
    sinon.restore()

    // Clear all tables
    await Database.sequelize.sync({ force: true })
  })

  describe('checkRemoveAuthorsAndSeries', () => {
    let libraryItem1Id
    let libraryItem2Id
    let author1Id
    let author2Id
    let author3Id
    let series1Id
    let series2Id

    beforeEach(async () => {
      const newLibrary = await Database.libraryModel.create({ name: 'Test Library', mediaType: 'book' })
      const newLibraryFolder = await Database.libraryFolderModel.create({ path: '/test', libraryId: newLibrary.id })

      const newBook = await Database.bookModel.create({ title: 'Test Book', audioFiles: [], tags: [], narrators: [], genres: [], chapters: [] })
      const newLibraryItem = await Database.libraryItemModel.create({ libraryFiles: [], mediaId: newBook.id, mediaType: 'book', libraryId: newLibrary.id, libraryFolderId: newLibraryFolder.id })
      libraryItem1Id = newLibraryItem.id

      const newBook2 = await Database.bookModel.create({ title: 'Test Book 2', audioFiles: [], tags: [], narrators: [], genres: [], chapters: [] })
      const newLibraryItem2 = await Database.libraryItemModel.create({ libraryFiles: [], mediaId: newBook2.id, mediaType: 'book', libraryId: newLibrary.id, libraryFolderId: newLibraryFolder.id })
      libraryItem2Id = newLibraryItem2.id

      const newAuthor = await Database.authorModel.create({ name: 'Test Author', libraryId: newLibrary.id })
      author1Id = newAuthor.id
      const newAuthor2 = await Database.authorModel.create({ name: 'Test Author 2', libraryId: newLibrary.id })
      author2Id = newAuthor2.id
      const newAuthor3 = await Database.authorModel.create({ name: 'Test Author 3', imagePath: '/fake/path/author.png', libraryId: newLibrary.id })
      author3Id = newAuthor3.id

      // Book 1 has Author 1, Author 2 and Author 3
      await Database.bookAuthorModel.create({ bookId: newBook.id, authorId: newAuthor.id })
      await Database.bookAuthorModel.create({ bookId: newBook.id, authorId: newAuthor2.id })
      await Database.bookAuthorModel.create({ bookId: newBook.id, authorId: newAuthor3.id })

      // Book 2 has Author 2
      await Database.bookAuthorModel.create({ bookId: newBook2.id, authorId: newAuthor2.id })

      const newSeries = await Database.seriesModel.create({ name: 'Test Series', libraryId: newLibrary.id })
      series1Id = newSeries.id
      const newSeries2 = await Database.seriesModel.create({ name: 'Test Series 2', libraryId: newLibrary.id })
      series2Id = newSeries2.id

      // Book 1 is in Series 1 and Series 2
      await Database.bookSeriesModel.create({ bookId: newBook.id, seriesId: newSeries.id })
      await Database.bookSeriesModel.create({ bookId: newBook.id, seriesId: newSeries2.id })

      // Book 2 is in Series 2
      await Database.bookSeriesModel.create({ bookId: newBook2.id, seriesId: newSeries2.id })
    })

    it('should remove authors and series with no books on library item delete', async () => {
      const libraryItem = await Database.libraryItemModel.getExpandedById(libraryItem1Id)

      const fakeReq = {
        query: {},
        libraryItem
      }
      const fakeRes = {
        sendStatus: sinon.spy()
      }
      await LibraryItemController.delete.bind(apiRouter)(fakeReq, fakeRes)

      expect(fakeRes.sendStatus.calledWith(200)).to.be.true

      // Author 1 should be removed because it has no books
      const author1Exists = await Database.authorModel.checkExistsById(author1Id)
      expect(author1Exists).to.be.false

      // Author 2 should not be removed because it still has Book 2
      const author2Exists = await Database.authorModel.checkExistsById(author2Id)
      expect(author2Exists).to.be.true

      // Author 3 should not be removed because it has an image
      const author3Exists = await Database.authorModel.checkExistsById(author3Id)
      expect(author3Exists).to.be.true

      // Series 1 should be removed because it has no books
      const series1Exists = await Database.seriesModel.checkExistsById(series1Id)
      expect(series1Exists).to.be.false

      // Series 2 should not be removed because it still has Book 2
      const series2Exists = await Database.seriesModel.checkExistsById(series2Id)
      expect(series2Exists).to.be.true
    })

    it('should remove authors and series with no books on library item batch delete', async () => {
      // Batch delete library item 1
      const fakeReq = {
        query: {},
        user: {
          username: 'test',
          canDelete: true,
          checkCanAccessLibraryItem: () => true
        },
        body: {
          libraryItemIds: [libraryItem1Id]
        }
      }
      const fakeRes = {
        sendStatus: sinon.spy()
      }
      await LibraryItemController.batchDelete.bind(apiRouter)(fakeReq, fakeRes)

      expect(fakeRes.sendStatus.calledWith(200)).to.be.true

      // Author 1 should be removed because it has no books
      const author1Exists = await Database.authorModel.checkExistsById(author1Id)
      expect(author1Exists).to.be.false

      // Author 2 should not be removed because it still has Book 2
      const author2Exists = await Database.authorModel.checkExistsById(author2Id)
      expect(author2Exists).to.be.true

      // Author 3 should not be removed because it has an image
      const author3Exists = await Database.authorModel.checkExistsById(author3Id)
      expect(author3Exists).to.be.true

      // Series 1 should be removed because it has no books
      const series1Exists = await Database.seriesModel.checkExistsById(series1Id)
      expect(series1Exists).to.be.false

      // Series 2 should not be removed because it still has Book 2
      const series2Exists = await Database.seriesModel.checkExistsById(series2Id)
      expect(series2Exists).to.be.true
    })

    it('should remove authors and series with no books on library item update media', async () => {
      const libraryItem = await Database.libraryItemModel.getExpandedById(libraryItem1Id)
      libraryItem.saveMetadataFile = sinon.stub()
      // Update library item 1 remove all authors and series
      const fakeReq = {
        query: {},
        body: {
          metadata: {
            authors: [],
            series: []
          }
        },
        libraryItem
      }
      const fakeRes = {
        json: sinon.spy()
      }
      await LibraryItemController.updateMedia.bind(apiRouter)(fakeReq, fakeRes)

      expect(fakeRes.json.calledOnce).to.be.true

      // Author 1 should be removed because it has no books
      const author1Exists = await Database.authorModel.checkExistsById(author1Id)
      expect(author1Exists).to.be.false

      // Author 2 should not be removed because it still has Book 2
      const author2Exists = await Database.authorModel.checkExistsById(author2Id)
      expect(author2Exists).to.be.true

      // Author 3 should not be removed because it has an image
      const author3Exists = await Database.authorModel.checkExistsById(author3Id)
      expect(author3Exists).to.be.true

      // Series 1 should be removed because it has no books
      const series1Exists = await Database.seriesModel.checkExistsById(series1Id)
      expect(series1Exists).to.be.false

      // Series 2 should not be removed because it still has Book 2
      const series2Exists = await Database.seriesModel.checkExistsById(series2Id)
      expect(series2Exists).to.be.true
    })
  })

  describe('batch item access control', () => {
    let lib1Id
    let itemLib1Id
    let itemLib2Id

    beforeEach(async () => {
      const lib1 = await Database.libraryModel.create({ name: 'Lib 1', mediaType: 'book' })
      const folder1 = await Database.libraryFolderModel.create({ path: '/l1', libraryId: lib1.id })
      const book1 = await Database.bookModel.create({ title: 'B1', audioFiles: [], tags: [], narrators: [], genres: [], chapters: [] })
      const li1 = await Database.libraryItemModel.create({
        libraryFiles: [],
        mediaId: book1.id,
        mediaType: 'book',
        libraryId: lib1.id,
        libraryFolderId: folder1.id
      })
      lib1Id = lib1.id
      itemLib1Id = li1.id

      const lib2 = await Database.libraryModel.create({ name: 'Lib 2', mediaType: 'book' })
      const folder2 = await Database.libraryFolderModel.create({ path: '/l2', libraryId: lib2.id })
      const book2 = await Database.bookModel.create({ title: 'B2', audioFiles: [], tags: [], narrators: [], genres: [], chapters: [] })
      const li2 = await Database.libraryItemModel.create({
        libraryFiles: [],
        mediaId: book2.id,
        mediaType: 'book',
        libraryId: lib2.id,
        libraryFolderId: folder2.id
      })
      itemLib2Id = li2.id
    })

    const userLimitedToLib1 = () => ({
      username: 'limited',
      canDelete: true,
      canUpdate: true,
      checkCanAccessLibraryItem(li) {
        return li.libraryId === lib1Id
      }
    })

    it('batchGet returns 403 for a library item the user cannot access', async () => {
      const fakeRes = { sendStatus: sinon.spy(), json: sinon.spy() }
      const fakeReq = {
        body: { libraryItemIds: [itemLib2Id] },
        user: userLimitedToLib1()
      }
      await LibraryItemController.batchGet.bind(apiRouter)(fakeReq, fakeRes)
      expect(fakeRes.sendStatus.calledWith(403)).to.be.true
    })

    it('batchGet returns items when the user can access them', async () => {
      const fakeRes = { sendStatus: sinon.spy(), json: sinon.spy() }
      const fakeReq = {
        body: { libraryItemIds: [itemLib1Id] },
        user: userLimitedToLib1()
      }
      await LibraryItemController.batchGet.bind(apiRouter)(fakeReq, fakeRes)
      expect(fakeRes.json.calledOnce).to.be.true
      const payload = fakeRes.json.firstCall.args[0]
      expect(payload.libraryItems).to.have.length(1)
      expect(payload.libraryItems[0].id).to.equal(itemLib1Id)
    })

    it('batchUpdate returns 403 for a library item the user cannot access', async () => {
      const fakeRes = { sendStatus: sinon.spy(), json: sinon.spy() }
      const fakeReq = {
        user: userLimitedToLib1(),
        body: [{ id: itemLib2Id, mediaPayload: {} }]
      }
      await LibraryItemController.batchUpdate.bind(apiRouter)(fakeReq, fakeRes)
      expect(fakeRes.sendStatus.calledWith(403)).to.be.true
    })

    it('batchUpdate returns 403 when the user lacks canUpdate', async () => {
      const u = userLimitedToLib1()
      u.canUpdate = false
      const fakeRes = { sendStatus: sinon.spy(), json: sinon.spy() }
      const fakeReq = {
        user: u,
        body: [{ id: itemLib1Id, mediaPayload: {} }]
      }
      await LibraryItemController.batchUpdate.bind(apiRouter)(fakeReq, fakeRes)
      expect(fakeRes.sendStatus.calledWith(403)).to.be.true
    })

    it('batchDelete returns 403 for a library item the user cannot access', async () => {
      const fakeRes = { sendStatus: sinon.spy() }
      const fakeReq = {
        query: {},
        user: userLimitedToLib1(),
        body: { libraryItemIds: [itemLib2Id] }
      }
      await LibraryItemController.batchDelete.bind(apiRouter)(fakeReq, fakeRes)
      expect(fakeRes.sendStatus.calledWith(403)).to.be.true
    })
  })

  describe('snapMediaChapters', () => {
    let libraryId
    let folderId
    let bookItemId

    // Four 1000 s files; every chapter (after the first) has a 2 s pause ending 3 s after it
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

    function silenceLines({ path, startSec, durationSec }) {
      const trackIndex = Number(path.match(/part(\d)\.mp3$/)[1])
      const offset = trackIndex * 1000
      const lines = []
      for (const chapter of chapters.slice(1)) {
        const ls = chapter.start + 1 - offset - startSec
        const le = chapter.start + 3 - offset - startSec
        if (le <= 0 || ls >= durationSec) continue
        lines.push(`[silencedetect @ 0x1] silence_start: ${ls.toFixed(4)}`)
        lines.push(`[silencedetect @ 0x1] silence_end: ${le.toFixed(4)} | silence_duration: 2.0000`)
      }
      return lines
    }

    async function createItem(mediaType, mediaValues, itemValues = {}) {
      let media
      if (mediaType === 'book') {
        media = await Database.bookModel.create({ title: 'Black Ice', audioFiles: [], tags: [], narrators: [], genres: [], chapters: [], ...mediaValues })
      } else {
        media = await Database.podcastModel.create({ title: 'Podcast', tags: [], genres: [], ...mediaValues })
      }
      const li = await Database.libraryItemModel.create({ libraryFiles: [], mediaId: media.id, mediaType, libraryId, libraryFolderId: folderId, ...itemValues })
      return Database.libraryItemModel.getExpandedById(li.id)
    }

    const user = (canUpdate = true) => ({ username: 'neo', canUpdate, checkCanAccessLibraryItem: () => true })

    function fakeResponse() {
      const res = new EventEmitter()
      res.writableEnded = false
      res.statusCode = 200
      res.status = sinon.spy((code) => {
        res.statusCode = code
        return res
      })
      res.json = sinon.spy(() => {
        res.writableEnded = true
        return res
      })
      res.sendStatus = sinon.spy((code) => {
        res.statusCode = code
        res.writableEnded = true
        return res
      })
      return res
    }

    async function callSnap(libraryItem, body = {}, reqUser = user()) {
      const res = fakeResponse()
      await LibraryItemController.snapMediaChapters.bind(apiRouter)({ user: reqUser, libraryItem, body, params: { id: libraryItem.id } }, res)
      return res
    }

    beforeEach(async () => {
      const library = await Database.libraryModel.create({ name: 'Books', mediaType: 'book' })
      const folder = await Database.libraryFolderModel.create({ path: '/books', libraryId: library.id })
      libraryId = library.id
      folderId = folder.id
      const item = await createItem('book', { audioFiles, chapters, duration: 4000 })
      bookItemId = item.id
      sinon.stub(Logger, 'error')
      chapterSnapRunner._runningJobs.clear()
    })

    it('returns 403 without canUpdate', async () => {
      const libraryItem = await Database.libraryItemModel.getExpandedById(bookItemId)
      const res = await callSnap(libraryItem, {}, user(false))
      expect(res.sendStatus.calledWith(403)).to.be.true
    })

    it('returns 400 for a podcast, a missing item and a book without tracks', async () => {
      const podcast = await createItem('podcast', {})
      expect((await callSnap(podcast)).statusCode).to.equal(400)

      const missing = await Database.libraryItemModel.getExpandedById(bookItemId)
      missing.isMissing = true
      expect((await callSnap(missing)).statusCode).to.equal(400)

      const noTracks = await createItem('book', { chapters })
      const res = await callSnap(noTracks)
      expect(res.statusCode).to.equal(400)
      expect(res.json.firstCall.args[0]).to.deep.equal({ error: 'Item is not a book with audio tracks' })
    })

    it('returns 400 for a bad body and for verify:true', async () => {
      const libraryItem = await Database.libraryItemModel.getExpandedById(bookItemId)
      const detect = sinon.stub(ffmpegHelpers, 'detectSilences').resolves({ lines: [] })

      const bad = [
        { chapters: 'x' },
        { chapters: [] },
        { chapters: [{ start: 0 }, { start: -1 }] },
        { chapters: [{ start: 0 }, { start: 5000 }] },
        { chapters: [{ start: 0 }, { start: 10 }, { start: 5 }] },
        { indexes: [9] },
        { options: { windowSec: '25' } },
        { options: { noiseDb: null } },
        { options: { verify: true } }
      ]
      for (const body of bad) {
        const res = await callSnap(libraryItem, body)
        expect(res.statusCode, JSON.stringify(body)).to.equal(400)
        expect(res.json.firstCall.args[0].error).to.be.a('string')
      }
      const ordered = await callSnap(libraryItem, { chapters: [{ start: 0 }, { start: 10 }, { start: 5 }] })
      expect(ordered.json.firstCall.args[0].index).to.equal(2)
      const verify = await callSnap(libraryItem, { options: { verify: true } })
      expect(verify.json.firstCall.args[0]).to.deep.equal({ error: 'verify not implemented' })
      expect(detect.called).to.be.false
    })

    it('returns a proposal for the item chapters and saves nothing', async () => {
      const libraryItem = await Database.libraryItemModel.getExpandedById(bookItemId)
      const detect = sinon.stub(ffmpegHelpers, 'detectSilences').callsFake(async (params) => ({ lines: silenceLines(params) }))
      const mediaSave = sinon.spy(libraryItem.media, 'save')
      libraryItem.saveMetadataFile = sinon.spy()
      const emitterSpies = ['emitter', 'clientEmitter', 'adminEmitter', 'libraryItemEmitter', 'libraryItemsEmitter'].map((name) => sinon.spy(SocketAuthority, name))

      const res = await callSnap(libraryItem, null)

      expect(res.statusCode).to.equal(200)
      expect(res.json.calledOnce).to.be.true
      const result = res.json.firstCall.args[0]
      expect(result).to.have.keys(['libraryItemId', 'duration', 'complete', 'options', 'stats', 'chapters', 'proposedChapters', 'warnings'])
      expect(result).to.include({ libraryItemId: bookItemId, duration: 4000, complete: true })
      expect(result.stats).to.have.keys(['segments', 'ffmpegCalls', 'failedSegments', 'analysedSec', 'pausesFound', 'elapsedMs', 'moved', 'unchanged', 'skipped'])
      expect(result.chapters).to.have.length(4)
      expect(result.chapters[1]).to.have.keys(['index', 'id', 'title', 'originalStart', 'proposedStart', 'delta', 'changed', 'pause', 'reason', 'confidence', 'trackIndex', 'speech'])
      expect(result.chapters[1]).to.include({ originalStart: 500, proposedStart: 502.75, delta: 2.75, reason: 'nearest-longest-pause', trackIndex: 0 })
      expect(result.proposedChapters).to.deep.equal([
        { id: 0, title: 'Opening Credits', start: 0, end: 502.75 },
        { id: 1, title: 'Chapter 1', start: 502.75, end: 1502.75 },
        { id: 2, title: 'Chapter 2', start: 1502.75, end: 2502.75 },
        { id: 3, title: 'Chapter 3', start: 2502.75, end: 4000 }
      ])

      // every ffmpeg call gets a DB path, never anything from the request
      for (const call of detect.getCalls()) expect(call.args[0].path).to.match(/^\/books\/Black Ice\/part\d\.mp3$/)

      expect(mediaSave.called).to.be.false
      expect(libraryItem.saveMetadataFile.called).to.be.false
      for (const spy of emitterSpies) expect(spy.called).to.be.false

      const reloaded = await Database.libraryItemModel.getExpandedById(bookItemId)
      expect(reloaded.media.chapters).to.deep.equal(chapters)
      expect(chapterSnapRunner._runningJobs.size).to.equal(0)
    })

    it('returns 409 while a snap runs for the same item and 500 when every segment fails', async () => {
      const libraryItem = await Database.libraryItemModel.getExpandedById(bookItemId)
      const slot = chapterSnapRunner.acquire(bookItemId)
      const busy = await callSnap(libraryItem)
      expect(busy.statusCode).to.equal(409)
      slot.release()

      sinon.stub(ffmpegHelpers, 'detectSilences').rejects(new Error('spawn ffmpeg ENOENT'))
      const failed = await callSnap(libraryItem)
      expect(failed.statusCode).to.equal(500)
      expect(failed.json.firstCall.args[0]).to.deep.equal({ error: 'Silence detection failed' })
      expect(chapterSnapRunner._runningJobs.size).to.equal(0)
    })

    it('aborts and kills ffmpeg when the client disconnects, without responding', async () => {
      const libraryItem = await Database.libraryItemModel.getExpandedById(bookItemId)
      const kill = sinon.spy()
      let signalSeen
      sinon.stub(ffmpegHelpers, 'detectSilences').callsFake(
        ({ signal }) =>
          new Promise((resolve, reject) => {
            signalSeen = signal
            signal.addEventListener('abort', () => {
              kill('SIGKILL')
              reject(new Error('FFMPEG_CANCELED'))
            })
          })
      )
      const res = fakeResponse()
      const pending = LibraryItemController.snapMediaChapters.bind(apiRouter)({ user: user(), libraryItem, body: {}, params: { id: bookItemId } }, res)
      await new Promise((resolve) => setImmediate(resolve))
      res.emit('close')
      await pending

      expect(signalSeen.aborted).to.be.true
      expect(kill.calledWith('SIGKILL')).to.be.true
      expect(res.json.called).to.be.false
      expect(res.sendStatus.called).to.be.false
      expect(res.status.called).to.be.false
      expect(chapterSnapRunner._runningJobs.size).to.equal(0)
    })

    it('routes /chapters and /chapters/snap to their own handlers', () => {
      const routes = apiRouter.router._router.stack.filter((layer) => layer.route?.methods.post).map((layer) => [layer.route.path, layer.route.stack[layer.route.stack.length - 1].handle.name])
      expect(routes).to.deep.include(['/items/:id/chapters', 'bound updateMediaChapters'])
      expect(routes).to.deep.include(['/items/:id/chapters/snap', 'bound snapMediaChapters'])
    })

    it('leaves updateMediaChapters behaviour unchanged', async () => {
      const libraryItem = await Database.libraryItemModel.getExpandedById(bookItemId)
      libraryItem.saveMetadataFile = sinon.stub()
      sinon.stub(SocketAuthority, 'libraryItemEmitter')
      const proposed = chapters.map((c) => ({ ...c, start: c.start === 0 ? 0 : c.start + 2.75 }))
      const res = fakeResponse()
      await LibraryItemController.updateMediaChapters.bind(apiRouter)({ user: user(), libraryItem, body: { chapters: proposed } }, res)
      expect(res.json.firstCall.args[0]).to.deep.equal({ success: true, updated: true })

      const noTracks = await createItem('book', {})
      const res500 = fakeResponse()
      await LibraryItemController.updateMediaChapters.bind(apiRouter)({ user: user(), libraryItem: noTracks, body: { chapters: proposed } }, res500)
      expect(res500.sendStatus.calledWith(500)).to.be.true
    })
  })
})
