const { expect } = require('chai')
const { Sequelize } = require('sequelize')
const sinon = require('sinon')

const Database = require('../../../server/Database')
const Logger = require('../../../server/Logger')
const SocketAuthority = require('../../../server/SocketAuthority')
const LibraryController = require('../../../server/controllers/LibraryController')
const { DuplicateItemManager } = require('../../../server/managers/DuplicateItemManager')
const duplicateItemManager = require('../../../server/managers/DuplicateItemManager')

describe('DuplicateItemManager', () => {
  let library
  let folder
  let manager

  async function addBook(relPath, { title, author, duration = 36000, asin = null, isbn = null, ebookFile = null, isMissing = false }) {
    const book = await Database.bookModel.create({
      title,
      asin,
      isbn,
      duration,
      ebookFile,
      audioFiles: duration ? [{ index: 1 }] : [],
      tags: [],
      narrators: [],
      genres: [],
      chapters: []
    })
    if (author) {
      const authorRecord = await Database.authorModel.create({ name: author, libraryId: library.id })
      await Database.bookAuthorModel.create({ bookId: book.id, authorId: authorRecord.id })
    }
    return Database.libraryItemModel.create({
      path: `/lib/${relPath}`,
      relPath,
      isFile: false,
      isMissing,
      size: 1000,
      libraryFiles: [],
      mediaId: book.id,
      mediaType: 'book',
      libraryId: library.id,
      libraryFolderId: folder.id
    })
  }

  beforeEach(async () => {
    global.ServerSettings = {}
    Database.sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false })
    Database.sequelize.uppercaseFirst = (str) => (str ? `${str[0].toUpperCase()}${str.substr(1)}` : '')
    await Database.buildModels()

    library = await Database.libraryModel.create({ name: 'Books', mediaType: 'book' })
    folder = await Database.libraryFolderModel.create({ path: '/lib', libraryId: library.id })
    manager = new DuplicateItemManager()

    sinon.stub(Logger, 'info')
    sinon.stub(Logger, 'debug')
    sinon.stub(SocketAuthority, 'adminEmitter')
  })

  afterEach(() => {
    sinon.restore()
  })

  it('stores groups for the same book in two folders and leaves other items alone', async () => {
    const a = await addBook('Tolkien/The Hobbit', { title: 'The Hobbit', author: 'J.R.R. Tolkien' })
    const b = await addBook('Incoming/Hobbit (Unabridged)', { title: 'Hobbit (Unabridged)', author: 'Tolkien, J. R. R.', duration: 36150 })
    await addBook('Sanderson/Elantris', { title: 'Elantris', author: 'Brandon Sanderson' })
    await addBook('Missing/The Hobbit', { title: 'The Hobbit', author: 'J.R.R. Tolkien', isMissing: true })

    expect(await manager.checkLibrary(library.id)).to.equal(1)

    const groups = await manager.getGroups(library.id)
    expect(groups).to.have.length(1)
    expect(groups[0].matchTypes).to.deep.equal(['title'])
    expect(groups[0].dismissed).to.equal(false)
    expect(groups[0].items.map((i) => i.id)).to.have.members([a.id, b.id])
    const itemA = groups[0].items.find((i) => i.id === a.id)
    expect(itemA).to.include({ title: 'The Hobbit', author: 'J.R.R. Tolkien', relPath: 'Tolkien/The Hobbit', size: 1000, duration: 36000, numAudioFiles: 1, hasEbook: false, isMissing: false })
    expect(itemA.addedAt).to.be.a('number').and.be.greaterThan(0)
    expect(await manager.countGroups(library.id)).to.equal(1)

    // Nothing is deleted or modified
    expect(await Database.libraryItemModel.count()).to.equal(4)
    expect(SocketAuthority.adminEmitter.calledWith('duplicate_items_updated', { libraryId: library.id, numGroups: 1 })).to.equal(true)
  })

  it('keeps a dismissed group dismissed across checks, and after a third copy comes and goes', async () => {
    const a = await addBook('A/Dune', { title: 'Dune', author: 'Frank Herbert', asin: 'B002V1OF70' })
    await addBook('B/Dune', { title: 'Dune', author: 'Frank Herbert', asin: 'B002V1OF70', duration: 80000 })
    await manager.checkLibrary(library.id)
    const [group] = await manager.getGroups(library.id)
    expect(group.matchTypes).to.deep.equal(['asin'])

    expect(await manager.setGroupDismissed(library.id, group.id, true)).to.equal(true)
    expect(await manager.countGroups(library.id)).to.equal(0)
    expect(await manager.getGroups(library.id)).to.deep.equal([])

    await manager.checkLibrary(library.id)
    expect(await manager.countGroups(library.id)).to.equal(0)
    const withDismissed = await manager.getGroups(library.id, { includeDismissed: true })
    expect(withDismissed).to.have.length(1)
    expect(withDismissed[0].dismissed).to.equal(true)

    // A third copy arrives: new group, flagged again; the dismissed pair is not listed meanwhile
    const c = await addBook('C/Dune', { title: 'Dune', author: 'Frank Herbert', asin: 'B002V1OF70' })
    await manager.checkLibrary(library.id)
    const groups = await manager.getGroups(library.id, { includeDismissed: true })
    expect(groups).to.have.length(1)
    expect(groups[0].items).to.have.length(3)
    expect(groups[0].id).to.not.equal(group.id)
    expect(groups[0].dismissed).to.equal(false)
    expect(await manager.countGroups(library.id)).to.equal(1)
    // A dismissal only applies to a group as it is now
    expect(await manager.setGroupDismissed(library.id, group.id, false)).to.equal(false)

    // The third copy is removed again: the pair is still "not a duplicate"
    await c.destroy()
    await manager.checkLibrary(library.id)
    expect(await manager.countGroups(library.id)).to.equal(0)
    const again = await manager.getGroups(library.id, { includeDismissed: true })
    expect(again.map((g) => [g.id, g.dismissed])).to.deep.equal([[group.id, true]])

    // One of the pair is removed: the dismissal is dropped with it
    await a.destroy()
    await manager.checkLibrary(library.id)
    expect(await Database.libraryItemDuplicateModel.count()).to.equal(0)

    expect(await manager.setGroupDismissed(library.id, 'nope', true)).to.equal(false)
  })

  it('drops a group once a member is removed', async () => {
    await addBook('A/Dune', { title: 'Dune', author: 'Frank Herbert' })
    const b = await addBook('B/Dune', { title: 'Dune', author: 'Frank Herbert' })
    await manager.checkLibrary(library.id)
    expect(await manager.countGroups(library.id)).to.equal(1)

    // Removed between checks: not listed with a single member
    await b.destroy()
    expect(await manager.getGroups(library.id)).to.deep.equal([])

    await manager.checkLibrary(library.id)
    expect(await manager.countGroups(library.id)).to.equal(0)
  })

  it('finds podcasts with the same feed', async () => {
    const podcastLibrary = await Database.libraryModel.create({ name: 'Podcasts', mediaType: 'podcast' })
    const podcastFolder = await Database.libraryFolderModel.create({ path: '/pod', libraryId: podcastLibrary.id })
    for (const [i, feedURL] of ['https://example.com/feed', 'http://www.example.com/feed/', 'https://other.com/rss'].entries()) {
      const podcast = await Database.podcastModel.create({ title: `Show ${i}`, feedURL, tags: [], genres: [] })
      await Database.libraryItemModel.create({ path: `/pod/${i}`, relPath: `${i}`, isFile: false, libraryFiles: [], mediaId: podcast.id, mediaType: 'podcast', libraryId: podcastLibrary.id, libraryFolderId: podcastFolder.id })
    }
    expect(await manager.checkLibrary(podcastLibrary.id)).to.equal(1)
    const [group] = await manager.getGroups(podcastLibrary.id)
    expect(group.matchTypes).to.deep.equal(['feed'])
    expect(group.items.map((i) => i.title)).to.have.members(['Show 0', 'Show 1'])
    expect(group.items[0].numEpisodes).to.equal(0)
  })

  it('shares a running check and runs once more when asked again meanwhile', async () => {
    await addBook('A/Dune', { title: 'Dune', author: 'Frank Herbert' })
    const runCheck = sinon.spy(manager, 'runCheck')
    await Promise.all([manager.checkLibrary(library.id), manager.checkLibrary(library.id), manager.checkLibrary(library.id)])
    expect(runCheck.callCount).to.equal(2)
  })

  it('does not schedule background checks unless the server enabled it', () => {
    const clock = sinon.useFakeTimers()
    const checkLibrary = sinon.stub(manager, 'checkLibrary').resolves(0)
    manager.scheduleCheck(library.id)
    clock.tick(10000)
    expect(checkLibrary.called).to.equal(false)

    manager.init()
    manager.scheduleCheck(library.id)
    manager.scheduleCheck(library.id)
    clock.tick(10000)
    expect(checkLibrary.callCount).to.equal(1)
  })

  describe('LibraryController duplicate endpoints', () => {
    const admin = { isAdminOrUp: true, username: 'admin' }
    const user = { isAdminOrUp: false, username: 'user' }

    function mockRes() {
      const res = { statusCode: 200, body: undefined }
      res.status = sinon.stub().callsFake((code) => {
        res.statusCode = code
        return res
      })
      res.sendStatus = sinon.stub().callsFake((code) => {
        res.statusCode = code
        return res
      })
      res.send = sinon.stub().callsFake((body) => {
        res.body = body
        return res
      })
      res.json = sinon.stub().callsFake((body) => {
        res.body = body
        return res
      })
      return res
    }

    beforeEach(() => {
      duplicateItemManager.lastCheckedAt.clear()
      sinon.stub(Logger, 'error')
    })

    it('rejects non-admin users', async () => {
      for (const [method, extra] of [
        ['getDuplicates', {}],
        ['checkDuplicates', {}],
        ['updateDuplicateGroup', { params: { groupId: 'abc' }, body: { dismissed: true } }]
      ]) {
        const res = mockRes()
        await LibraryController[method]({ user, library, query: {}, ...extra }, res)
        expect(res.statusCode, method).to.equal(403)
      }
    })

    it('lists, dismisses and re-lists groups', async () => {
      await addBook('A/Dune', { title: 'Dune', author: 'Frank Herbert' })
      await addBook('B/Dune', { title: 'Dune', author: 'Frank Herbert' })

      // First GET after start runs a check
      let res = mockRes()
      await LibraryController.getDuplicates({ user: admin, library, query: {} }, res)
      expect(res.body.numGroups).to.equal(1)
      expect(res.body.groups).to.have.length(1)
      expect(res.body.lastCheckedAt).to.be.a('number')
      const groupId = res.body.groups[0].id

      res = mockRes()
      await LibraryController.updateDuplicateGroup({ user: admin, library, params: { groupId }, body: { dismissed: 'yes' } }, res)
      expect(res.statusCode).to.equal(400)

      res = mockRes()
      await LibraryController.updateDuplicateGroup({ user: admin, library, params: { groupId: 'ffff' }, body: { dismissed: true } }, res)
      expect(res.statusCode).to.equal(404)

      res = mockRes()
      await LibraryController.updateDuplicateGroup({ user: admin, library, params: { groupId }, body: { dismissed: true } }, res)
      expect(res.body.group.dismissed).to.equal(true)
      expect(res.body.numGroups).to.equal(0)

      res = mockRes()
      await LibraryController.checkDuplicates({ user: admin, library, query: { include: 'dismissed' } }, res)
      expect(res.body.numGroups).to.equal(0)
      expect(res.body.groups).to.have.length(1)
      expect(res.body.groups[0].dismissed).to.equal(true)

      res = mockRes()
      await LibraryController.getDuplicates({ user: admin, library, query: {} }, res)
      expect(res.body.groups).to.deep.equal([])
    })

    it('adds numDuplicateGroups to filter data for admins only', async () => {
      await addBook('A/Dune', { title: 'Dune', author: 'Frank Herbert' })
      await addBook('B/Dune', { title: 'Dune', author: 'Frank Herbert' })
      await duplicateItemManager.checkLibrary(library.id)

      const cached = { numIssues: 2 }
      const forAdmin = await LibraryController.constructor.withDuplicateCount({ user: admin, library }, cached)
      expect(forAdmin).to.deep.equal({ numIssues: 2, numDuplicateGroups: 1 })
      expect(cached).to.deep.equal({ numIssues: 2 })
      expect(await LibraryController.constructor.withDuplicateCount({ user, library }, cached)).to.equal(cached)
    })
  })
})
