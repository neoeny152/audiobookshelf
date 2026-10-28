const { expect } = require('chai')
const { Sequelize } = require('sequelize')
const sinon = require('sinon')

const Database = require('../../../server/Database')
const PodcastController = require('../../../server/controllers/PodcastController')
const Logger = require('../../../server/Logger')
const SocketAuthority = require('../../../server/SocketAuthority')
const fs = require('../../../server/libs/fsExtra')

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

describe('PodcastController - batch episode endpoints', () => {
  let podcastLibrary, secretLibrary, bookLibrary
  let podA, podB, secretPod, bookItem
  let editor, restricted, noPerms, deleteOnly, updateOnly

  async function createPodcastItem(lib, folder, title, numEpisodes) {
    const podcast = await Database.podcastModel.create({ title, tags: [], genres: [], autoDownloadEpisodes: false, numEpisodes })
    const libraryFiles = []
    const episodeData = []
    for (let i = 1; i <= numEpisodes; i++) {
      const ino = `${title}-ino-${i}`
      const path = `/${title}/ep${i}.mp3`
      libraryFiles.push({ ino, metadata: { filename: `ep${i}.mp3`, ext: '.mp3', path, relPath: `ep${i}.mp3` }, fileType: 'audio' })
      episodeData.push({ podcastId: podcast.id, title: `${title} Episode ${i}`, index: i, audioFile: { ino, metadata: { filename: `ep${i}.mp3`, ext: '.mp3', path, relPath: `ep${i}.mp3` } } })
    }
    const libraryItem = await Database.libraryItemModel.create({ libraryFiles, mediaId: podcast.id, mediaType: 'podcast', libraryId: lib.id, libraryFolderId: folder.id, path: `/${title}` })
    const episodes = []
    for (const ed of episodeData) {
      episodes.push(await Database.podcastEpisodeModel.create(ed))
    }
    return { libraryItem, episodes }
  }

  function makeUser(username, permissions) {
    return Database.userModel.create({
      username,
      type: 'user',
      isActive: true,
      permissions: {
        download: true,
        update: false,
        delete: false,
        upload: false,
        accessAllLibraries: true,
        accessAllTags: true,
        accessExplicitContent: true,
        librariesAccessible: [],
        itemTagsSelected: [],
        ...permissions
      }
    })
  }

  beforeEach(async () => {
    global.ServerSettings = {}
    Database.sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false })
    Database.sequelize.uppercaseFirst = (str) => (str ? `${str[0].toUpperCase()}${str.substr(1)}` : '')
    await Database.buildModels()

    sinon.stub(Logger, 'info')
    sinon.stub(Logger, 'debug')
    sinon.stub(Logger, 'warn')
    sinon.stub(Logger, 'error')
    sinon.stub(SocketAuthority, 'libraryItemEmitter')
    sinon.stub(SocketAuthority, 'clientEmitter')

    podcastLibrary = await Database.libraryModel.create({ name: 'Pods', mediaType: 'podcast' })
    const folder = await Database.libraryFolderModel.create({ path: '/pods', libraryId: podcastLibrary.id })
    secretLibrary = await Database.libraryModel.create({ name: 'Secret', mediaType: 'podcast' })
    const secretFolder = await Database.libraryFolderModel.create({ path: '/secret', libraryId: secretLibrary.id })
    bookLibrary = await Database.libraryModel.create({ name: 'Books', mediaType: 'book' })
    const bookFolder = await Database.libraryFolderModel.create({ path: '/books', libraryId: bookLibrary.id })

    podA = await createPodcastItem(podcastLibrary, folder, 'PodA', 3)
    podB = await createPodcastItem(podcastLibrary, folder, 'PodB', 2)
    secretPod = await createPodcastItem(secretLibrary, secretFolder, 'SecretPod', 1)

    const book = await Database.bookModel.create({ title: 'Book', audioFiles: [], tags: [], narrators: [], genres: [], chapters: [] })
    bookItem = await Database.libraryItemModel.create({ libraryFiles: [], mediaId: book.id, mediaType: 'book', libraryId: bookLibrary.id, libraryFolderId: bookFolder.id })

    editor = await makeUser('editor', { update: true, delete: true })
    restricted = await makeUser('restricted', { update: true, delete: true, accessAllLibraries: false, librariesAccessible: [podcastLibrary.id] })
    noPerms = await makeUser('noperms', {})
    deleteOnly = await makeUser('deleteonly', { delete: true })
    updateOnly = await makeUser('updateonly', { update: true })
  })

  afterEach(async () => {
    sinon.restore()
    await Database.sequelize.sync({ force: true })
  })

  async function episodeTitles(ids) {
    const eps = await Database.podcastEpisodeModel.findAll({ where: { id: ids } })
    const byId = new Map(eps.map((e) => [e.id, e.title]))
    return ids.map((id) => byId.get(id))
  }

  describe('POST /api/podcasts/batch/episodes/update', () => {
    it('is routed in ApiRouter', () => {
      const ApiRouter = require('../../../server/routers/ApiRouter')
      const Auth = require('../../../server/Auth')
      const ApiCacheManager = require('../../../server/managers/ApiCacheManager')
      const apiRouter = new ApiRouter({ auth: new Auth(), apiCacheManager: new ApiCacheManager() })
      const routes = apiRouter.router._router.stack.filter((l) => l.route).map((l) => `${Object.keys(l.route.methods).join(',')} ${l.route.path}`)
      expect(routes).to.include('post /podcasts/batch/episodes/update')
      expect(routes).to.include('post /podcasts/batch/episodes/delete')
    })

    it('updates episodes across multiple podcasts, loading each once and emitting one item_updated per podcast', async () => {
      const findAllSpy = sinon.spy(Database.libraryItemModel, 'findAllExpandedWhere')
      const res = fakeRes()
      const body = {
        episodes: [
          { libraryItemId: podA.libraryItem.id, episodeId: podA.episodes[0].id, updates: { title: 'A1 new' } },
          { libraryItemId: podB.libraryItem.id, episodeId: podB.episodes[0].id, updates: { title: 'B1 new', season: '2' } },
          { libraryItemId: podA.libraryItem.id, episodeId: podA.episodes[1].id, updates: { title: 'A2 new', description: '<p>ok</p><script>bad()</script>' } }
        ]
      }
      await PodcastController.batchUpdateEpisodes({ user: editor, body, query: {} }, res)

      expect(statusOf(res)).to.equal(200)
      expect(findAllSpy.calledOnce).to.be.true
      const payload = res.json.firstCall.args[0]
      expect(payload.success).to.equal(true)
      expect(payload.numEpisodesUpdated).to.equal(3)
      expect(payload.libraryItems.map((li) => li.id)).to.deep.equal([podA.libraryItem.id, podB.libraryItem.id])
      // Same shape as PATCH /api/podcasts/:id/episode/:episodeId (old JSON expanded)
      const aJson = payload.libraryItems[0]
      expect(aJson.media.episodes.find((e) => e.id === podA.episodes[0].id).title).to.equal('A1 new')

      expect(await episodeTitles([podA.episodes[0].id, podA.episodes[1].id, podA.episodes[2].id, podB.episodes[0].id])).to.deep.equal(['A1 new', 'A2 new', 'PodA Episode 3', 'B1 new'])
      const a2 = await Database.podcastEpisodeModel.findByPk(podA.episodes[1].id)
      expect(a2.description).to.not.include('script')
      const b1 = await Database.podcastEpisodeModel.findByPk(podB.episodes[0].id)
      expect(b1.season).to.equal('2')

      const emitted = SocketAuthority.libraryItemEmitter.getCalls().map((c) => [c.args[0], c.args[1].id])
      expect(emitted).to.deep.equal([
        ['item_updated', podA.libraryItem.id],
        ['item_updated', podB.libraryItem.id]
      ])
    })

    it('does not emit for podcasts with no actual changes and ignores unsupported keys', async () => {
      const res = fakeRes()
      const body = {
        episodes: [
          { libraryItemId: podA.libraryItem.id, episodeId: podA.episodes[0].id, updates: { title: 'PodA Episode 1' } },
          { libraryItemId: podB.libraryItem.id, episodeId: podB.episodes[0].id, updates: { podcastId: 'hijack', id: 'x' } }
        ]
      }
      await PodcastController.batchUpdateEpisodes({ user: editor, body, query: {} }, res)
      expect(statusOf(res)).to.equal(200)
      expect(res.json.firstCall.args[0].numEpisodesUpdated).to.equal(0)
      expect(SocketAuthority.libraryItemEmitter.called).to.be.false
      const b1 = await Database.podcastEpisodeModel.findByPk(podB.episodes[0].id)
      expect(b1.podcastId).to.equal(podB.libraryItem.mediaId)
    })

    it('ignores chapters arrays containing null entries instead of throwing', async () => {
      const res = fakeRes()
      const validChapters = [{ id: 0, start: 1, end: 10, title: 'Ch 1' }]
      const body = {
        episodes: [
          { libraryItemId: podA.libraryItem.id, episodeId: podA.episodes[0].id, updates: { chapters: [null] } },
          { libraryItemId: podA.libraryItem.id, episodeId: podA.episodes[1].id, updates: { chapters: [...validChapters, null], title: 'Still Updated' } },
          { libraryItemId: podB.libraryItem.id, episodeId: podB.episodes[0].id, updates: { chapters: validChapters } }
        ]
      }
      await PodcastController.batchUpdateEpisodes({ user: editor, body, query: {} }, res)
      expect(statusOf(res)).to.equal(200)
      expect(res.json.firstCall.args[0].numEpisodesUpdated).to.equal(2)
      const a1 = await Database.podcastEpisodeModel.findByPk(podA.episodes[0].id)
      const a2 = await Database.podcastEpisodeModel.findByPk(podA.episodes[1].id)
      const b1 = await Database.podcastEpisodeModel.findByPk(podB.episodes[0].id)
      expect(a1.chapters || []).to.deep.equal([])
      expect(a2.title).to.equal('Still Updated')
      expect(a2.chapters || []).to.deep.equal([])
      expect(b1.chapters).to.deep.equal(validChapters)
    })

    it('rejects users without update permission (403), even with delete permission', async () => {
      for (const user of [noPerms, deleteOnly]) {
        const res = fakeRes()
        await PodcastController.batchUpdateEpisodes({ user, body: { episodes: [{ libraryItemId: podA.libraryItem.id, episodeId: podA.episodes[0].id, updates: { title: 'x' } }] }, query: {} }, res)
        expect(statusOf(res)).to.equal(403)
      }
      expect(await episodeTitles([podA.episodes[0].id])).to.deep.equal(['PodA Episode 1'])
    })

    it('rejects the whole batch with 403 if any podcast is in a library the user cannot access', async () => {
      const res = fakeRes()
      const body = {
        episodes: [
          { libraryItemId: podA.libraryItem.id, episodeId: podA.episodes[0].id, updates: { title: 'changed' } },
          { libraryItemId: secretPod.libraryItem.id, episodeId: secretPod.episodes[0].id, updates: { title: 'changed' } }
        ]
      }
      await PodcastController.batchUpdateEpisodes({ user: restricted, body, query: {} }, res)
      expect(statusOf(res)).to.equal(403)
      expect(res.json.called).to.be.false
      expect(await episodeTitles([podA.episodes[0].id, secretPod.episodes[0].id])).to.deep.equal(['PodA Episode 1', 'SecretPod Episode 1'])
      expect(SocketAuthority.libraryItemEmitter.called).to.be.false
    })

    it('returns 404 and changes nothing when a podcast or episode is not found', async () => {
      let res = fakeRes()
      await PodcastController.batchUpdateEpisodes(
        {
          user: editor,
          body: {
            episodes: [
              { libraryItemId: podA.libraryItem.id, episodeId: podA.episodes[0].id, updates: { title: 'changed' } },
              { libraryItemId: 'missing-item', episodeId: 'x', updates: { title: 'changed' } }
            ]
          },
          query: {}
        },
        res
      )
      expect(statusOf(res)).to.equal(404)

      // Episode exists but belongs to a different podcast
      res = fakeRes()
      await PodcastController.batchUpdateEpisodes(
        {
          user: editor,
          body: {
            episodes: [
              { libraryItemId: podA.libraryItem.id, episodeId: podA.episodes[0].id, updates: { title: 'changed' } },
              { libraryItemId: podA.libraryItem.id, episodeId: podB.episodes[0].id, updates: { title: 'changed' } }
            ]
          },
          query: {}
        },
        res
      )
      expect(statusOf(res)).to.equal(404)
      expect(await episodeTitles([podA.episodes[0].id, podB.episodes[0].id])).to.deep.equal(['PodA Episode 1', 'PodB Episode 1'])
      expect(SocketAuthority.libraryItemEmitter.called).to.be.false
    })

    it('rejects non-podcast items and invalid bodies with 400', async () => {
      let res = fakeRes()
      await PodcastController.batchUpdateEpisodes({ user: editor, body: { episodes: [{ libraryItemId: bookItem.id, episodeId: 'x', updates: { title: 'x' } }] }, query: {} }, res)
      expect(statusOf(res)).to.equal(400)

      const invalidBodies = [
        {},
        { episodes: [] },
        { episodes: 'nope' },
        { episodes: [{ libraryItemId: podA.libraryItem.id, episodeId: podA.episodes[0].id }] },
        { episodes: [{ libraryItemId: podA.libraryItem.id, updates: {} }] },
        { episodes: [{ libraryItemId: 5, episodeId: podA.episodes[0].id, updates: {} }] },
        {
          episodes: [
            { libraryItemId: podA.libraryItem.id, episodeId: podA.episodes[0].id, updates: { title: 'a' } },
            { libraryItemId: podA.libraryItem.id, episodeId: podA.episodes[0].id, updates: { title: 'b' } }
          ]
        }
      ]
      for (const body of invalidBodies) {
        res = fakeRes()
        await PodcastController.batchUpdateEpisodes({ user: editor, body, query: {} }, res)
        expect(statusOf(res), JSON.stringify(body)).to.equal(400)
      }
      expect(await episodeTitles([podA.episodes[0].id])).to.deep.equal(['PodA Episode 1'])
    })
  })

  describe('POST /api/podcasts/batch/episodes/delete', () => {
    it('deletes episodes across multiple podcasts, saving each podcast once with one item_updated each', async () => {
      // Episode progress + playlist entries should be cleaned up like the per-episode route
      await Database.mediaProgressModel.create({ userId: editor.id, mediaItemId: podA.episodes[0].id, mediaItemType: 'podcastEpisode', duration: 10, currentTime: 5 })
      const playlist = await Database.playlistModel.create({ libraryId: podcastLibrary.id, userId: editor.id, name: 'List' })
      await Database.playlistMediaItemModel.create({ playlistId: playlist.id, mediaItemId: podA.episodes[0].id, mediaItemType: 'podcastEpisode', order: 1 })
      await Database.playlistMediaItemModel.create({ playlistId: playlist.id, mediaItemId: podA.episodes[2].id, mediaItemType: 'podcastEpisode', order: 2 })
      const fsRemove = sinon.stub(fs, 'remove').resolves()

      const res = fakeRes()
      const body = {
        episodes: [
          { libraryItemId: podA.libraryItem.id, episodeId: podA.episodes[0].id },
          { libraryItemId: podB.libraryItem.id, episodeId: podB.episodes[1].id },
          { libraryItemId: podA.libraryItem.id, episodeId: podA.episodes[1].id }
        ]
      }
      await PodcastController.batchDeleteEpisodes({ user: deleteOnly, body, query: {} }, res)

      expect(statusOf(res)).to.equal(200)
      expect(fsRemove.called).to.be.false
      const payload = res.json.firstCall.args[0]
      expect(payload.success).to.equal(true)
      expect(payload.numEpisodesDeleted).to.equal(3)
      expect(payload.libraryItems.map((li) => li.id)).to.deep.equal([podA.libraryItem.id, podB.libraryItem.id])
      // Same shape as DELETE /api/podcasts/:id/episode/:episodeId (old JSON)
      expect(payload.libraryItems[0].media.episodes.map((e) => e.id)).to.deep.equal([podA.episodes[2].id])
      expect(payload.libraryItems[0].libraryFiles.map((f) => f.ino)).to.deep.equal(['PodA-ino-3'])

      const remaining = await Database.podcastEpisodeModel.findAll({ attributes: ['id'] })
      expect(remaining.map((e) => e.id).sort()).to.deep.equal([podA.episodes[2].id, podB.episodes[0].id, secretPod.episodes[0].id].sort())

      const aItem = await Database.libraryItemModel.getExpandedById(podA.libraryItem.id)
      expect(aItem.libraryFiles.map((f) => f.ino)).to.deep.equal(['PodA-ino-3'])
      expect(aItem.media.numEpisodes).to.equal(1)
      const bItem = await Database.libraryItemModel.getExpandedById(podB.libraryItem.id)
      expect(bItem.libraryFiles.map((f) => f.ino)).to.deep.equal(['PodB-ino-1'])
      expect(bItem.media.numEpisodes).to.equal(1)

      expect(await Database.mediaProgressModel.count()).to.equal(0)
      const playlistItems = await Database.playlistMediaItemModel.findAll({ where: { playlistId: playlist.id } })
      expect(playlistItems.map((p) => p.mediaItemId)).to.deep.equal([podA.episodes[2].id])

      const emitted = SocketAuthority.libraryItemEmitter.getCalls().map((c) => [c.args[0], c.args[1].id])
      expect(emitted).to.deep.equal([
        ['item_updated', podA.libraryItem.id],
        ['item_updated', podB.libraryItem.id]
      ])
    })

    it('hard deletes files when requested by query or body', async () => {
      const fsRemove = sinon.stub(fs, 'remove').resolves()
      let res = fakeRes()
      await PodcastController.batchDeleteEpisodes({ user: editor, body: { episodes: [{ libraryItemId: podA.libraryItem.id, episodeId: podA.episodes[0].id }] }, query: { hard: '1' } }, res)
      expect(statusOf(res)).to.equal(200)
      res = fakeRes()
      await PodcastController.batchDeleteEpisodes({ user: editor, body: { hard: true, episodes: [{ libraryItemId: podB.libraryItem.id, episodeId: podB.episodes[0].id }] }, query: {} }, res)
      expect(statusOf(res)).to.equal(200)
      expect(fsRemove.getCalls().map((c) => c.args[0])).to.deep.equal(['/PodA/ep1.mp3', '/PodB/ep1.mp3'])
    })

    it('rejects users without delete permission (403), even with update permission', async () => {
      for (const user of [noPerms, updateOnly]) {
        const res = fakeRes()
        await PodcastController.batchDeleteEpisodes({ user, body: { episodes: [{ libraryItemId: podA.libraryItem.id, episodeId: podA.episodes[0].id }] }, query: {} }, res)
        expect(statusOf(res)).to.equal(403)
      }
      expect(await Database.podcastEpisodeModel.count()).to.equal(6)
    })

    it('rejects the whole batch with 403 if any podcast is in a library the user cannot access', async () => {
      const res = fakeRes()
      const body = {
        episodes: [
          { libraryItemId: podA.libraryItem.id, episodeId: podA.episodes[0].id },
          { libraryItemId: secretPod.libraryItem.id, episodeId: secretPod.episodes[0].id }
        ]
      }
      await PodcastController.batchDeleteEpisodes({ user: restricted, body, query: {} }, res)
      expect(statusOf(res)).to.equal(403)
      expect(await Database.podcastEpisodeModel.count()).to.equal(6)
      expect(SocketAuthority.libraryItemEmitter.called).to.be.false
    })

    it('rejects tag-restricted podcasts with 403', async () => {
      const podcast = await Database.podcastModel.findByPk(podA.libraryItem.mediaId)
      podcast.tags = ['secret']
      podcast.changed('tags', true)
      await podcast.save()
      const tagRestricted = await makeUser('tagrestricted', { delete: true, accessAllTags: false, selectedTagsNotAccessible: true, itemTagsSelected: ['secret'] })

      const res = fakeRes()
      await PodcastController.batchDeleteEpisodes({ user: tagRestricted, body: { episodes: [{ libraryItemId: podA.libraryItem.id, episodeId: podA.episodes[0].id }] }, query: {} }, res)
      expect(statusOf(res)).to.equal(403)
      expect(await Database.podcastEpisodeModel.count()).to.equal(6)
    })

    it('returns 404 and deletes nothing when a podcast or episode is not found', async () => {
      let res = fakeRes()
      await PodcastController.batchDeleteEpisodes(
        {
          user: editor,
          body: {
            episodes: [
              { libraryItemId: podA.libraryItem.id, episodeId: podA.episodes[0].id },
              { libraryItemId: podB.libraryItem.id, episodeId: 'missing-episode' }
            ]
          },
          query: {}
        },
        res
      )
      expect(statusOf(res)).to.equal(404)

      res = fakeRes()
      await PodcastController.batchDeleteEpisodes({ user: editor, body: { episodes: [{ libraryItemId: 'missing-item', episodeId: podA.episodes[0].id }] }, query: {} }, res)
      expect(statusOf(res)).to.equal(404)

      expect(await Database.podcastEpisodeModel.count()).to.equal(6)
      expect(SocketAuthority.libraryItemEmitter.called).to.be.false
    })

    it('rejects non-podcast items and invalid bodies with 400', async () => {
      let res = fakeRes()
      await PodcastController.batchDeleteEpisodes({ user: editor, body: { episodes: [{ libraryItemId: bookItem.id, episodeId: 'x' }] }, query: {} }, res)
      expect(statusOf(res)).to.equal(400)

      for (const body of [{}, { episodes: [] }, { episodes: [{ libraryItemId: podA.libraryItem.id }] }, { episodes: [null] }]) {
        res = fakeRes()
        await PodcastController.batchDeleteEpisodes({ user: editor, body, query: {} }, res)
        expect(statusOf(res), JSON.stringify(body)).to.equal(400)
      }
      expect(await Database.podcastEpisodeModel.count()).to.equal(6)
    })
  })

  describe('PATCH /api/podcasts/:id/episode/:episodeId (unchanged behavior after payload refactor)', () => {
    it('still updates and sanitizes, returning old JSON expanded and emitting item_updated', async () => {
      const libraryItem = await Database.libraryItemModel.getExpandedById(podA.libraryItem.id)
      const res = fakeRes()
      await PodcastController.updateEpisode({ user: editor, libraryItem, params: { episodeId: podA.episodes[0].id }, body: { title: 'Patched', subtitle: '<b>s</b><script>x</script>', publishedAt: 123, bogus: 'x' } }, res)
      expect(statusOf(res)).to.equal(200)
      const json = res.json.firstCall.args[0]
      expect(json.id).to.equal(podA.libraryItem.id)
      const ep = json.media.episodes.find((e) => e.id === podA.episodes[0].id)
      expect(ep.title).to.equal('Patched')
      expect(ep.subtitle).to.not.include('script')
      expect(ep.publishedAt).to.equal(123)
      expect(SocketAuthority.libraryItemEmitter.calledOnceWith('item_updated')).to.be.true
    })

    it('ignores a chapters array containing null instead of throwing', async () => {
      const libraryItem = await Database.libraryItemModel.getExpandedById(podA.libraryItem.id)
      const res = fakeRes()
      await PodcastController.updateEpisode({ user: editor, libraryItem, params: { episodeId: podA.episodes[0].id }, body: { chapters: [null] } }, res)
      expect(statusOf(res)).to.equal(200)
      expect(SocketAuthority.libraryItemEmitter.called).to.be.false
      const ep = await Database.podcastEpisodeModel.findByPk(podA.episodes[0].id)
      expect(ep.chapters || []).to.deep.equal([])
    })
  })
})
