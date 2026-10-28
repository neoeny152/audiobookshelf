/**
 * Guards the request/response shapes and socket events of the existing batch handlers
 * that were optimized on feat/batch-endpoints (Map/Set lookups, single series/author cleanup,
 * single findAllExpandedWhere query). Behavior must be identical to before.
 */
const { expect } = require('chai')
const { Sequelize } = require('sequelize')
const sinon = require('sinon')

const Database = require('../../../server/Database')
const ApiRouter = require('../../../server/routers/ApiRouter')
const Auth = require('../../../server/Auth')
const ApiCacheManager = require('../../../server/managers/ApiCacheManager')
const LibraryItemController = require('../../../server/controllers/LibraryItemController')
const ToolsController = require('../../../server/controllers/ToolsController')
const PlaylistController = require('../../../server/controllers/PlaylistController')
const Logger = require('../../../server/Logger')
const SocketAuthority = require('../../../server/SocketAuthority')

function fakeRes() {
  const res = {}
  res.sendStatus = sinon.spy(() => res)
  res.status = sinon.spy(() => res)
  res.send = sinon.spy(() => res)
  res.json = sinon.spy(() => res)
  return res
}

function statusOf(res) {
  if (res.sendStatus.called) return res.sendStatus.firstCall.args[0]
  if (res.status.called) return res.status.firstCall.args[0]
  return 200
}

const audioFile = (ino) => ({ index: 1, ino, metadata: { filename: `${ino}.mp3`, ext: '.mp3', path: `/books/${ino}.mp3`, relPath: `${ino}.mp3` }, duration: 10, mimeType: 'audio/mpeg' })

describe('Existing batch handlers keep their shapes', () => {
  let apiRouter, library, folder, user

  async function createBook(title, { withAudio = false } = {}) {
    const book = await Database.bookModel.create({ title, audioFiles: withAudio ? [audioFile(title)] : [], tags: [], narrators: [], genres: [], chapters: [] })
    return Database.libraryItemModel.create({ libraryFiles: [], mediaId: book.id, mediaType: 'book', libraryId: library.id, libraryFolderId: folder.id, path: `/books/${title}` })
  }

  beforeEach(async () => {
    global.ServerSettings = {}
    Database.sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false })
    Database.sequelize.uppercaseFirst = (str) => (str ? `${str[0].toUpperCase()}${str.substr(1)}` : '')
    await Database.buildModels()

    apiRouter = new ApiRouter({ auth: new Auth(), apiCacheManager: new ApiCacheManager() })

    sinon.stub(Logger, 'info')
    sinon.stub(Logger, 'debug')
    sinon.stub(Logger, 'warn')
    sinon.stub(Logger, 'error')
    sinon.stub(SocketAuthority, 'libraryItemEmitter')
    sinon.stub(SocketAuthority, 'emitter')
    sinon.stub(SocketAuthority, 'clientEmitter')
    sinon.stub(Database.libraryItemModel.prototype, 'saveMetadataFile').resolves()

    library = await Database.libraryModel.create({ name: 'Books', mediaType: 'book' })
    folder = await Database.libraryFolderModel.create({ path: '/books', libraryId: library.id })
    user = await Database.userModel.create({
      username: 'admin',
      type: 'admin',
      isActive: true,
      permissions: { download: true, update: true, delete: true, upload: true, accessAllLibraries: true, accessAllTags: true, accessExplicitContent: true, librariesAccessible: [], itemTagsSelected: [] }
    })
  })

  afterEach(async () => {
    sinon.restore()
    await Database.sequelize.sync({ force: true })
  })

  describe('POST /api/items/batch/update', () => {
    it('returns { success, updates } and emits item_updated per changed item in payload order', async () => {
      const a = await createBook('A')
      const b = await createBook('B')
      const c = await createBook('C')
      const res = fakeRes()
      const body = [
        { id: c.id, mediaPayload: { metadata: { title: 'C2' } } },
        { id: a.id, mediaPayload: { metadata: { title: 'A2' } } },
        { id: b.id, mediaPayload: { metadata: { title: 'B' } } } // no change
      ]
      await LibraryItemController.batchUpdate.bind(apiRouter)({ user, body }, res)

      expect(statusOf(res)).to.equal(200)
      expect(res.json.firstCall.args[0]).to.deep.equal({ success: true, updates: 2 })
      expect(SocketAuthority.libraryItemEmitter.getCalls().map((call) => [call.args[0], call.args[1].id])).to.deep.equal([
        ['item_updated', c.id],
        ['item_updated', a.id]
      ])
      const titles = (await Database.bookModel.findAll()).map((bk) => bk.title).sort()
      expect(titles).to.deep.equal(['A2', 'B', 'C2'])
    })

    it('still returns 400 for duplicate ids and 404 when an item is missing', async () => {
      const a = await createBook('A')
      let res = fakeRes()
      await LibraryItemController.batchUpdate.bind(apiRouter)(
        {
          user,
          body: [
            { id: a.id, mediaPayload: {} },
            { id: a.id, mediaPayload: {} }
          ]
        },
        res
      )
      expect(statusOf(res)).to.equal(400)
      res = fakeRes()
      await LibraryItemController.batchUpdate.bind(apiRouter)(
        {
          user,
          body: [
            { id: a.id, mediaPayload: {} },
            { id: 'missing', mediaPayload: {} }
          ]
        },
        res
      )
      expect(statusOf(res)).to.equal(404)
    })
  })

  describe('POST /api/items/batch/delete', () => {
    it('responds 200, emits item_removed per item and series_removed / author_removed once each', async () => {
      const a = await createBook('A')
      const b = await createBook('B')
      const keep = await createBook('Keep')
      const books = await Database.bookModel.findAll()
      const bookByTitle = new Map(books.map((bk) => [bk.title, bk]))

      const sharedSeries = await Database.seriesModel.create({ name: 'Shared', libraryId: library.id })
      const keptSeries = await Database.seriesModel.create({ name: 'Kept', libraryId: library.id })
      const sharedAuthor = await Database.authorModel.create({ name: 'Shared Author', libraryId: library.id })
      for (const title of ['A', 'B']) {
        await Database.bookSeriesModel.create({ bookId: bookByTitle.get(title).id, seriesId: sharedSeries.id })
        await Database.bookAuthorModel.create({ bookId: bookByTitle.get(title).id, authorId: sharedAuthor.id })
      }
      await Database.bookSeriesModel.create({ bookId: bookByTitle.get('A').id, seriesId: keptSeries.id })
      await Database.bookSeriesModel.create({ bookId: bookByTitle.get('Keep').id, seriesId: keptSeries.id })

      const checkSeriesSpy = sinon.spy(apiRouter, 'checkRemoveEmptySeries')
      const checkAuthorsSpy = sinon.spy(apiRouter, 'checkRemoveAuthorsWithNoBooks')

      const res = fakeRes()
      await LibraryItemController.batchDelete.bind(apiRouter)({ user, query: {}, body: { libraryItemIds: [a.id, b.id] } }, res)

      expect(res.sendStatus.calledOnceWith(200)).to.be.true
      expect(res.json.called).to.be.false

      // Cleanup runs once for the whole batch
      expect(checkSeriesSpy.calledOnce).to.be.true
      expect(checkAuthorsSpy.calledOnce).to.be.true

      const events = SocketAuthority.emitter.getCalls().map((call) => [call.args[0], call.args[1].id])
      expect(
        events
          .filter((e) => e[0] === 'item_removed')
          .map((e) => e[1])
          .sort()
      ).to.deep.equal([a.id, b.id].sort())
      expect(events.filter((e) => e[0] === 'series_removed')).to.deep.equal([['series_removed', sharedSeries.id]])
      expect(events.filter((e) => e[0] === 'author_removed')).to.deep.equal([['author_removed', sharedAuthor.id]])

      expect(await Database.seriesModel.checkExistsById(sharedSeries.id)).to.be.false
      expect(await Database.seriesModel.checkExistsById(keptSeries.id)).to.be.true
      expect(await Database.authorModel.checkExistsById(sharedAuthor.id)).to.be.false
      expect(await Database.libraryItemModel.count()).to.equal(1)
      expect((await Database.libraryItemModel.findOne()).id).to.equal(keep.id)
    })
  })

  describe('POST /api/tools/batch/embed-metadata', () => {
    let audioMetadataManager, ctx

    beforeEach(() => {
      audioMetadataManager = {
        getIsLibraryItemQueuedOrProcessing: sinon.stub().returns(false),
        handleBatchEmbed: sinon.stub()
      }
      ctx = { audioMetadataManager }
    })

    it('passes the items to handleBatchEmbed in request order and responds 200', async () => {
      const a = await createBook('A', { withAudio: true })
      const b = await createBook('B', { withAudio: true })
      const res = fakeRes()
      await ToolsController.batchEmbedMetadata.bind(ctx)({ user, body: { libraryItemIds: [b.id, a.id] }, query: { forceEmbedChapters: '1' } }, res)

      expect(res.sendStatus.calledOnceWith(200)).to.be.true
      expect(audioMetadataManager.handleBatchEmbed.calledOnce).to.be.true
      const [userId, items, options] = audioMetadataManager.handleBatchEmbed.firstCall.args
      expect(userId).to.equal(user.id)
      expect(items.map((li) => li.id)).to.deep.equal([b.id, a.id])
      // Items are expanded (media loaded) like getExpandedById returned
      expect(items[0].media.title).to.equal('B')
      expect(items[0].hasAudioTracks).to.be.true
      expect(options).to.deep.equal({ forceEmbedChapters: true, backup: false })
    })

    it('keeps the per-id status codes, with the first failing id deciding the response', async () => {
      const a = await createBook('A', { withAudio: true })
      const noAudio = await createBook('NoAudio')
      const restrictedUser = { id: 'u', username: 'u', checkCanAccessLibraryItem: (li) => li.id !== a.id }

      const cases = [
        { body: {}, user, expected: 400 },
        { body: { libraryItemIds: [] }, user, expected: 400 },
        { body: { libraryItemIds: [a.id, 'missing'] }, user, expected: 404 },
        { body: { libraryItemIds: ['missing', noAudio.id] }, user, expected: 404 },
        { body: { libraryItemIds: [noAudio.id, 'missing'] }, user, expected: 400 },
        { body: { libraryItemIds: [a.id] }, user: restrictedUser, expected: 403 }
      ]
      for (const c of cases) {
        const res = fakeRes()
        await ToolsController.batchEmbedMetadata.bind(ctx)({ user: c.user, body: c.body, query: {} }, res)
        expect(statusOf(res), JSON.stringify(c.body)).to.equal(c.expected)
      }

      audioMetadataManager.getIsLibraryItemQueuedOrProcessing.returns(true)
      const res = fakeRes()
      await ToolsController.batchEmbedMetadata.bind(ctx)({ user, body: { libraryItemIds: [a.id] }, query: {} }, res)
      expect(statusOf(res)).to.equal(400)
      expect(audioMetadataManager.handleBatchEmbed.called).to.be.false
    })
  })

  describe('POST /api/playlists/:id/batch/add', () => {
    it('skips items already in the playlist, appends the rest in order and emits playlist_updated with the response payload', async () => {
      const a = await createBook('A')
      const b = await createBook('B')
      const c = await createBook('C')
      const aItem = await Database.libraryItemModel.getExpandedById(a.id)
      const playlist = await Database.playlistModel.create({ libraryId: library.id, userId: user.id, name: 'List' })
      await Database.playlistMediaItemModel.create({ playlistId: playlist.id, mediaItemId: aItem.media.id, mediaItemType: 'book', order: 1 })

      const res = fakeRes()
      await PlaylistController.addBatch({ user, playlist, body: { items: [{ libraryItemId: c.id }, { libraryItemId: a.id }, { libraryItemId: b.id }] } }, res)

      expect(statusOf(res)).to.equal(200)
      const json = res.json.firstCall.args[0]
      expect(json.id).to.equal(playlist.id)
      expect(json.items.map((i) => i.libraryItemId)).to.deep.equal([a.id, c.id, b.id])
      expect(json.items[1]).to.have.all.keys('libraryItemId', 'libraryItem')
      expect(json.items[1].libraryItem.id).to.equal(c.id)

      expect(SocketAuthority.clientEmitter.calledOnce).to.be.true
      expect(SocketAuthority.clientEmitter.firstCall.args).to.deep.equal([user.id, 'playlist_updated', json])

      const rows = await Database.playlistMediaItemModel.findAll({ where: { playlistId: playlist.id }, order: [['order', 'ASC']] })
      expect(rows.map((r) => r.order)).to.deep.equal([1, 2, 3])
    })

    it('adds podcast episodes with the episode payload shape and does not emit when nothing is added', async () => {
      const podLibrary = await Database.libraryModel.create({ name: 'Pods', mediaType: 'podcast' })
      const podFolder = await Database.libraryFolderModel.create({ path: '/pods', libraryId: podLibrary.id })
      const podcast = await Database.podcastModel.create({ title: 'Pod', tags: [], genres: [], autoDownloadEpisodes: false })
      const podItem = await Database.libraryItemModel.create({ libraryFiles: [], mediaId: podcast.id, mediaType: 'podcast', libraryId: podLibrary.id, libraryFolderId: podFolder.id })
      const episodes = []
      for (let i = 1; i <= 3; i++) {
        episodes.push(await Database.podcastEpisodeModel.create({ podcastId: podcast.id, title: `E${i}`, index: i, audioFile: { ino: `e${i}`, metadata: { filename: 'e.mp3', ext: '.mp3', path: `/pods/e${i}.mp3`, relPath: 'e.mp3' } } }))
      }
      const playlist = await Database.playlistModel.create({ libraryId: podLibrary.id, userId: user.id, name: 'Pods' })

      let res = fakeRes()
      const items = [
        { libraryItemId: podItem.id, episodeId: episodes[2].id },
        { libraryItemId: podItem.id, episodeId: episodes[0].id }
      ]
      await PlaylistController.addBatch({ user, playlist, body: { items } }, res)
      const json = res.json.firstCall.args[0]
      expect(json.items.map((i) => i.episodeId)).to.deep.equal([episodes[2].id, episodes[0].id])
      expect(json.items[0]).to.have.all.keys('episodeId', 'episode', 'libraryItemId', 'libraryItem')
      expect(json.items[0].episode.title).to.equal('E3')
      expect(SocketAuthority.clientEmitter.calledOnce).to.be.true

      // Re-adding the same items adds nothing and emits nothing
      SocketAuthority.clientEmitter.resetHistory()
      res = fakeRes()
      await PlaylistController.addBatch({ user, playlist, body: { items } }, res)
      expect(res.json.firstCall.args[0].items).to.have.length(2)
      expect(SocketAuthority.clientEmitter.called).to.be.false
      expect(await Database.playlistMediaItemModel.count({ where: { playlistId: playlist.id } })).to.equal(2)
    })
  })
})
