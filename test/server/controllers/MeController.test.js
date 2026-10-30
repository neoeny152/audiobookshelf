const { expect } = require('chai')
const { Sequelize } = require('sequelize')
const sinon = require('sinon')

const Database = require('../../../server/Database')
const MeController = require('../../../server/controllers/MeController')
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

describe('MeController - items-in-progress on large podcasts (#5677)', () => {
  let user, podA, podB, bookItem

  async function createPodcastItem(lib, folder, title) {
    const podcast = await Database.podcastModel.create({ title, tags: [], genres: [], autoDownloadEpisodes: false })
    const episodes = []
    for (let i = 0; i < 3; i++) {
      const metadata = { filename: `ep${i}.mp3`, ext: '.mp3', path: `/pods/${title}/ep${i}.mp3`, relPath: `ep${i}.mp3`, size: 1000 + i }
      episodes.push({ podcastId: podcast.id, title: `${title} ep ${i}`, index: i, audioFile: { ino: `${title}-${i}`, metadata } })
    }
    const libraryItem = await Database.libraryItemModel.create({ libraryFiles: [], mediaId: podcast.id, mediaType: 'podcast', libraryId: lib.id, libraryFolderId: folder.id, path: `/pods/${title}`, relPath: title })
    return { libraryItem, episodes: await Database.podcastEpisodeModel.bulkCreate(episodes) }
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

    const podLib = await Database.libraryModel.create({ name: 'Pods', mediaType: 'podcast' })
    const podFolder = await Database.libraryFolderModel.create({ path: '/pods', libraryId: podLib.id })
    const bookLib = await Database.libraryModel.create({ name: 'Books', mediaType: 'book' })
    const bookFolder = await Database.libraryFolderModel.create({ path: '/books', libraryId: bookLib.id })

    podA = await createPodcastItem(podLib, podFolder, 'PodA')
    podB = await createPodcastItem(podLib, podFolder, 'PodB')
    const book = await Database.bookModel.create({ title: 'A Book', audioFiles: [], tags: [], narrators: [], genres: [], chapters: [] })
    bookItem = await Database.libraryItemModel.create({ libraryFiles: [], mediaId: book.id, mediaType: 'book', libraryId: bookLib.id, libraryFolderId: bookFolder.id })

    user = await Database.userModel.create({
      username: 'listener',
      type: 'user',
      isActive: true,
      permissions: { download: true, update: false, delete: false, upload: false, accessAllLibraries: true, accessAllTags: true, accessExplicitContent: true, librariesAccessible: [], itemTagsSelected: [] }
    })

    const progresses = [
      { item: podA.libraryItem, episode: podA.episodes[0], lastUpdate: 1000 },
      { item: podA.libraryItem, episode: podA.episodes[2], lastUpdate: 3000 },
      { item: podB.libraryItem, episode: podB.episodes[0], lastUpdate: 2000 },
      { item: podB.libraryItem, episode: podB.episodes[1], lastUpdate: 500, isFinished: true },
      { item: bookItem, lastUpdate: 2500 }
    ]
    for (const p of progresses) {
      const progress = await Database.mediaProgressModel.create({
        userId: user.id,
        mediaItemId: p.episode ? p.episode.id : p.item.mediaId,
        mediaItemType: p.episode ? 'podcastEpisode' : 'book',
        duration: 100,
        currentTime: 10,
        isFinished: !!p.isFinished,
        extraData: { libraryItemId: p.item.id, progress: 0.1 }
      })
      // Sequelize always stamps updatedAt on create, so set it directly for a stable order
      await Database.sequelize.query('UPDATE mediaProgresses SET updatedAt = :updatedAt WHERE id = :id', { replacements: { updatedAt: new Date(p.lastUpdate).toISOString().replace('T', ' ').replace('Z', ' +00:00'), id: progress.id } })
    }
    user.mediaProgresses = await Database.mediaProgressModel.findAll({ where: { userId: user.id } })
  })

  afterEach(async () => {
    sinon.restore()
    await Database.sequelize.sync({ force: true })
  })

  async function getItemsInProgress(query = {}) {
    const res = fakeRes()
    await MeController.getAllLibraryItemsInProgress({ user, query }, res)
    return res.json.firstCall.args[0].libraryItems
  }

  it('lists the in-progress episodes with the episode count and size of the whole podcast', async () => {
    const libraryItems = await getItemsInProgress()
    expect(libraryItems.map((li) => li.recentEpisode?.id || null)).to.deep.equal([podA.episodes[2].id, null, podB.episodes[0].id, podA.episodes[0].id])
    for (const li of libraryItems.filter((l) => l.mediaType === 'podcast')) {
      expect(li.media.numEpisodes).to.equal(3)
      expect(li.media.size).to.equal(1000 + 1001 + 1002)
      expect(li.recentEpisode.libraryItemId).to.equal(li.id)
    }
  })

  it('skips the progress of a deleted episode and counts an episode without audio file as size 0', async () => {
    await Database.podcastEpisodeModel.update({ audioFile: null }, { where: { id: podA.episodes[1].id } })
    await Database.podcastEpisodeModel.destroy({ where: { id: podB.episodes[0].id } })

    const libraryItems = await getItemsInProgress()
    expect(libraryItems.map((li) => li.recentEpisode?.id || null)).to.deep.equal([podA.episodes[2].id, null, podA.episodes[0].id])
    expect(libraryItems[0].media).to.include({ numEpisodes: 3, size: 1000 + 1002 })
  })

  it('respects the limit query', async () => {
    const libraryItems = await getItemsInProgress({ limit: '2' })
    expect(libraryItems.map((li) => li.progressLastUpdate)).to.deep.equal([3000, 2500])
  })

  it('loads the items without joining every podcast episode', async () => {
    const findAll = sinon.spy(Database.libraryItemModel, 'findAll')
    await getItemsInProgress()
    expect(findAll.calledOnce).to.be.true
    const podcastInclude = findAll.firstCall.args[0].include.find((include) => include.model === Database.podcastModel)
    expect(podcastInclude.include).to.be.undefined
  })
})
