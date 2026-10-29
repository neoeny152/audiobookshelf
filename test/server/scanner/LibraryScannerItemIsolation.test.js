const { expect } = require('chai')
const { Sequelize, UniqueConstraintError } = require('sequelize')
const sinon = require('sinon')

const Database = require('../../../server/Database')
const Logger = require('../../../server/Logger')
const SocketAuthority = require('../../../server/SocketAuthority')
const libraryFilters = require('../../../server/utils/queries/libraryFilters')
const LibraryScan = require('../../../server/scanner/LibraryScan')
const LibraryItemScanner = require('../../../server/scanner/LibraryItemScanner')
const LibraryScanner = require('../../../server/scanner/LibraryScanner')
const Scanner = require('../../../server/scanner/Scanner')
const LibraryItemController = require('../../../server/controllers/LibraryItemController')

describe('LibraryScanner one failing item does not abort the scan (#5319)', () => {
  let library
  let folder
  let libraryScan

  beforeEach(async () => {
    global.ServerSettings = {}
    Database.sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false })
    Database.sequelize.uppercaseFirst = (str) => (str ? `${str[0].toUpperCase()}${str.substr(1)}` : '')
    await Database.buildModels()

    const libraryRecord = await Database.libraryModel.create({ name: 'Books', mediaType: 'book', settings: Database.libraryModel.getDefaultLibrarySettingsForMediaType('book') })
    await Database.libraryFolderModel.create({ path: '/books', libraryId: libraryRecord.id })
    library = await Database.libraryModel.findByIdWithFolders(libraryRecord.id)
    folder = library.libraryFolders[0]

    libraryScan = new LibraryScan()
    libraryScan.setData(library)

    sinon.stub(Logger, 'info')
    sinon.stub(Logger, 'debug')
    sinon.stub(Logger, 'error')
    sinon.stub(SocketAuthority, 'emitter')
    sinon.stub(SocketAuthority, 'libraryItemEmitter')
    sinon.stub(SocketAuthority, 'libraryItemsEmitter')
    sinon.stub(libraryFilters, 'getFilterData').resolves()
    sinon.stub(LibraryItemScanner, 'finalizeAuthorsAndSeriesFromScan').resolves()
  })

  afterEach(async () => {
    sinon.restore()
    await Database.sequelize.sync({ force: true })
  })

  function uniqueError() {
    return new UniqueConstraintError({ message: 'Validation error', errors: [], fields: ['bookId', 'authorId'] })
  }

  it('adds the other new books when one of them fails', async () => {
    const itemData = [
      { path: '/books/Bad', relPath: 'Bad' },
      { path: '/books/Good', relPath: 'Good' }
    ]
    sinon.stub(LibraryScanner, 'scanFolder').resolves(itemData)
    const scanNew = sinon.stub(LibraryItemScanner, 'scanNewLibraryItem')
    scanNew.onFirstCall().rejects(uniqueError())
    scanNew.onSecondCall().resolves({ id: 'good-item' })

    const canceled = await LibraryScanner.scanLibrary(libraryScan, false)

    expect(canceled).to.equal(false)
    expect(scanNew.callCount).to.equal(2)
    expect(libraryScan.resultsAdded).to.equal(1)
    expect(LibraryItemScanner.finalizeAuthorsAndSeriesFromScan.calledOnce).to.be.true
  })

  it('rescans the other existing books when one of them fails', async () => {
    const items = []
    for (const title of ['Bad', 'Good']) {
      const book = await Database.bookModel.create({ title, audioFiles: [], tags: [], narrators: [], genres: [], chapters: [] })
      items.push(await Database.libraryItemModel.create({ path: `/books/${title}`, relPath: title, ino: title, libraryFiles: [], mediaId: book.id, mediaType: 'book', libraryId: library.id, libraryFolderId: folder.id }))
    }
    const itemData = items.map((li) => ({ path: li.path, relPath: li.relPath, ino: li.ino, checkLibraryItemData: async () => true, hasLibraryFileChanges: true, hasPathChange: false }))
    sinon.stub(LibraryScanner, 'scanFolder').resolves(itemData)
    const rescan = sinon.stub(LibraryItemScanner, 'rescanLibraryItemMedia')
    rescan.onFirstCall().rejects(uniqueError())
    rescan.onSecondCall().callsFake(async (existing) => ({ libraryItem: existing, wasUpdated: true }))

    const canceled = await LibraryScanner.scanLibrary(libraryScan, false)

    expect(canceled).to.equal(false)
    expect(rescan.callCount).to.equal(2)
    expect(libraryScan.resultsUpdated).to.equal(1)
  })

  it('batch quick match keeps going after one item fails and reports the result (#5215)', async () => {
    sinon.stub(SocketAuthority, 'clientEmitter')
    const items = [{ id: 'a', media: { title: 'A' } }, { id: 'b', media: { title: 'B' } }]
    sinon.stub(Database.libraryItemModel, 'findAllExpandedWhere').resolves(items)
    const match = sinon.stub(Scanner, 'quickMatchLibraryItem')
    match.onFirstCall().rejects(uniqueError())
    match.onSecondCall().resolves({ updated: true })
    const req = { user: { id: 'u1', username: 'admin', isAdminOrUp: true }, body: { libraryItemIds: ['a', 'b'] } }
    const res = { sendStatus: sinon.stub() }

    await LibraryItemController.batchQuickMatch.call({}, req, res)

    expect(res.sendStatus.calledWith(200)).to.be.true
    expect(match.callCount).to.equal(2)
    expect(SocketAuthority.clientEmitter.calledWith('u1', 'batch_quickmatch_complete', { success: true, updates: 1, unmatched: 1 })).to.be.true
  })
})
