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
  const NUM_EPISODES = 120
  let user, podcastItems, bookItem

  async function createPodcastItem(lib, folder, title) {
    const podcast = await Database.podcastModel.create({ title, tags: [], genres: [], autoDownloadEpisodes: false })
    const libraryFiles = []
    const episodes = []
    for (let i = 0; i < NUM_EPISODES; i++) {
      const metadata = { filename: `ep${i}.mp3`, ext: '.mp3', path: `/pods/${title}/ep${i}.mp3`, relPath: `ep${i}.mp3`, size: 1000 + i }
      libraryFiles.push({ ino: `${title}-${i}`, isSupplementary: false, addedAt: 1, updatedAt: 1, metadata })
      episodes.push({ podcastId: podcast.id, title: `${title} ep ${i}`, index: i, audioFile: { ino: `${title}-${i}`, metadata } })
    }
    const libraryItem = await Database.libraryItemModel.create({ libraryFiles, mediaId: podcast.id, mediaType: 'podcast', libraryId: lib.id, libraryFolderId: folder.id, path: `/pods/${title}`, relPath: title })
    const createdEpisodes = await Database.podcastEpisodeModel.bulkCreate(episodes)
    return { libraryItem, episodes: createdEpisodes }
  }

  // The pre-#5677 implementation, kept here to prove the response did not change
  async function legacyItemsInProgress(reqUser, limit = 25) {
    const progresses = reqUser.mediaProgresses.filter((mp) => !mp.isFinished && (mp.currentTime > 0 || mp.ebookProgress > 0))
    const ids = [...new Set(progresses.map((mp) => mp.extraData?.libraryItemId).filter((id) => id))]
    const libraryItems = await Database.libraryItemModel.findAllExpandedWhere({ id: ids })
    const out = []
    for (const mediaProgress of progresses) {
      const old = mediaProgress.getOldMediaProgress()
      const li = libraryItems.find((l) => l.id === old.libraryItemId)
      if (!li) continue
      if (old.episodeId && li.isPodcast) {
        const ep = li.media.podcastEpisodes.find((e) => e.id === old.episodeId)
        if (ep) out.push({ ...li.toOldJSONMinified(), recentEpisode: ep.toOldJSON(li.id), progressLastUpdate: old.lastUpdate })
      } else if (!old.episodeId) {
        out.push({ ...li.toOldJSONMinified(), progressLastUpdate: old.lastUpdate })
      }
    }
    return out.sort((a, b) => b.progressLastUpdate - a.progressLastUpdate).slice(0, limit)
  }

  function captureSql() {
    const statements = []
    Database.sequelize.options.logging = (sql) => statements.push(sql.replace(/^Executing \([^)]*\):\s*/, ''))
    return statements
  }

  async function maxRowsReturned(statements) {
    let maxRows = 0
    for (const sql of statements.filter((s) => /^SELECT/i.test(s))) {
      const rows = await Database.sequelize.query(sql, { type: Sequelize.QueryTypes.SELECT })
      maxRows = Math.max(maxRows, rows.length)
    }
    return maxRows
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

    podcastItems = [await createPodcastItem(podLib, podFolder, 'PodA'), await createPodcastItem(podLib, podFolder, 'PodB')]
    const book = await Database.bookModel.create({ title: 'A Book', audioFiles: [], tags: [], narrators: [], genres: [], chapters: [] })
    bookItem = await Database.libraryItemModel.create({ libraryFiles: [], mediaId: book.id, mediaType: 'book', libraryId: bookLib.id, libraryFolderId: bookFolder.id })

    user = await Database.userModel.create({
      username: 'listener',
      type: 'user',
      isActive: true,
      permissions: { download: true, update: false, delete: false, upload: false, accessAllLibraries: true, accessAllTags: true, accessExplicitContent: true, librariesAccessible: [], itemTagsSelected: [] }
    })

    const [podA, podB] = podcastItems
    const progresses = [
      { item: podA.libraryItem, episode: podA.episodes[5], lastUpdate: 1000 },
      { item: podA.libraryItem, episode: podA.episodes[90], lastUpdate: 3000 },
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
    Database.sequelize.options.logging = false
    sinon.restore()
    await Database.sequelize.sync({ force: true })
  })

  it('returns the same response as the joined query did', async () => {
    const expected = await legacyItemsInProgress(user)

    const res = fakeRes()
    await MeController.getAllLibraryItemsInProgress({ user, query: {} }, res)
    expect(res.json.calledOnce).to.be.true
    const body = res.json.firstCall.args[0]

    expect(Object.keys(body)).to.deep.equal(['libraryItems'])
    expect(body.libraryItems).to.have.length(4)
    expect(JSON.parse(JSON.stringify(body.libraryItems))).to.deep.equal(JSON.parse(JSON.stringify(expected)))

    const [podA, podB] = podcastItems
    expect(body.libraryItems.map((li) => li.recentEpisode?.id || null)).to.deep.equal([podA.episodes[90].id, null, podB.episodes[0].id, podA.episodes[5].id])
    for (const li of body.libraryItems.filter((l) => l.mediaType === 'podcast')) {
      expect(li.media.numEpisodes).to.equal(NUM_EPISODES)
      expect(li.numFiles).to.equal(NUM_EPISODES)
      // Sum of every episode's file size (1000 + i for i in 0..NUM_EPISODES-1), not just the in-progress ones
      expect(li.media.size).to.equal(1000 * NUM_EPISODES + (NUM_EPISODES * (NUM_EPISODES - 1)) / 2)
      expect(li.recentEpisode.libraryItemId).to.equal(li.id)
    }
  })

  it('respects the limit query', async () => {
    const res = fakeRes()
    await MeController.getAllLibraryItemsInProgress({ user, query: { limit: '2' } }, res)
    expect(res.json.firstCall.args[0].libraryItems.map((li) => li.progressLastUpdate)).to.deep.equal([3000, 2500])
  })

  it('does not return a row per podcast episode from any query', async () => {
    const statements = captureSql()
    const res = fakeRes()
    await MeController.getAllLibraryItemsInProgress({ user, query: {} }, res)
    Database.sequelize.options.logging = false
    expect(res.json.firstCall.args[0].libraryItems).to.have.length(4)
    expect(statements.some((s) => /^SELECT/i.test(s))).to.be.true
    // 3 library items and 3 in-progress episodes; the old JOIN returned one row per episode
    expect(await maxRowsReturned(statements)).to.be.at.most(3)

    // Sanity check: the same measurement catches the joined query
    const joinedStatements = captureSql()
    await Database.libraryItemModel.findAllExpandedWhere({ id: [bookItem.id, ...podcastItems.map((p) => p.libraryItem.id)] })
    Database.sequelize.options.logging = false
    expect(await maxRowsReturned(joinedStatements)).to.be.at.least(2 * NUM_EPISODES)
  })
})
