const { expect } = require('chai')
const { Sequelize } = require('sequelize')
const sinon = require('sinon')

const Database = require('../../../server/Database')
const Logger = require('../../../server/Logger')
const SocketAuthority = require('../../../server/SocketAuthority')
const BookFinder = require('../../../server/finders/BookFinder')
const Scanner = require('../../../server/scanner/Scanner')
const BookScanner = require('../../../server/scanner/BookScanner')
const LibraryScan = require('../../../server/scanner/LibraryScan')
const parseEbookMetadata = require('../../../server/utils/parsers/parseEbookMetadata')

describe('Rescan of an existing book: author/series spelling (#5319 #4934)', () => {
  let library
  let folder
  let libraryScan

  beforeEach(async () => {
    global.ServerSettings = { storeMetadataWithItem: false, metadataFileFormat: 'json' }
    Database.sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false })
    Database.sequelize.uppercaseFirst = (str) => (str ? `${str[0].toUpperCase()}${str.substr(1)}` : '')
    await Database.buildModels()
    Database.libraryFilterData = {}
    Database.serverSettings = { scannerFindCovers: false }

    library = await Database.libraryModel.create({ name: 'Books', mediaType: 'book' })
    folder = await Database.libraryFolderModel.create({ path: '/books', libraryId: library.id })

    libraryScan = new LibraryScan()
    libraryScan.setData(library)
    sinon.stub(libraryScan, 'addLog')

    sinon.stub(Logger, 'info')
    sinon.stub(Logger, 'debug')
    sinon.stub(Logger, 'warn')
    sinon.stub(SocketAuthority, 'emitter')
    sinon.stub(SocketAuthority, 'libraryItemEmitter')
    sinon.stub(Database.libraryItemModel.prototype, 'saveMetadataFile').resolves()
    sinon.stub(BookScanner, 'saveMetadataFile').resolves()
    sinon.stub(parseEbookMetadata, 'parse').resolves(null)
  })

  afterEach(async () => {
    sinon.restore()
    Database.libraryFilterData = {}
    await Database.sequelize.sync({ force: true })
  })

  async function createBookItem(title) {
    const book = await Database.bookModel.create({ title, audioFiles: [], tags: [], narrators: [], genres: [], chapters: [] })
    const item = await Database.libraryItemModel.create({ libraryFiles: [], mediaId: book.id, mediaType: 'book', libraryId: library.id, libraryFolderId: folder.id, path: `/books/${title}`, relPath: title })
    return { book, item }
  }

  function warmFilterData(authors, series) {
    Database.libraryFilterData[library.id] = { authors, series, genres: [], tags: [], narrators: [], publishers: [], publishedDecades: [], languages: [], numIssues: 0 }
  }

  /** Rescan the item with metadata from the source files (tags, .nfo, ...) */
  async function rescan(item, { authors = [], series = [] }) {
    sinon.stub(BookScanner, 'getBookMetadataFromScanData').resolves({ title: item.relPath, authors, series })
    const scanData = {
      libraryId: library.id,
      hasAudioFileChanges: false,
      audioLibraryFiles: [],
      imageLibraryFiles: [],
      imageLibraryFilesRemoved: [],
      imageLibraryFilesModified: [],
      ebookLibraryFiles: [],
      ebookLibraryFilesModified: [],
      checkEbookFileRemoved: () => false
    }
    const existing = await Database.libraryItemModel.findByPk(item.id)
    return BookScanner.rescanExistingBookLibraryItem(existing, scanData, { audiobooksOnly: true }, libraryScan)
  }

  async function authorNamesOnBook(bookId) {
    const links = await Database.bookAuthorModel.findAll({ where: { bookId }, include: Database.authorModel, order: [['createdAt', 'ASC']] })
    return links.map((l) => l.author.name)
  }

  async function seriesNamesOnBook(bookId) {
    const links = await Database.bookSeriesModel.findAll({ where: { bookId }, include: Database.seriesModel, order: [['createdAt', 'ASC']] })
    return links.map((l) => l.series.name)
  }

  describe('case-only change in the source metadata', () => {
    it('cold cache: "max" -> "Max" renames the author that only this book uses, no UNIQUE crash (#5319)', async () => {
      const { item, book } = await createBookItem('One')
      const author = await Database.authorModel.create({ name: 'max', lastFirst: 'max', libraryId: library.id })
      await Database.bookAuthorModel.create({ bookId: book.id, authorId: author.id })

      const { wasUpdated } = await rescan(item, { authors: ['Max'] })

      expect(wasUpdated).to.equal(true)
      expect(await authorNamesOnBook(book.id)).to.deep.equal(['Max'])
      const authors = await Database.authorModel.findAll()
      expect(authors.map((a) => [a.id, a.name, a.lastFirst])).to.deep.equal([[author.id, 'Max', 'Max']])
    })

    it('warm cache: the rename also updates the cached name', async () => {
      const { item, book } = await createBookItem('One')
      const author = await Database.authorModel.create({ name: 'max', lastFirst: 'max', libraryId: library.id })
      const series = await Database.seriesModel.create({ name: 'harry potter', libraryId: library.id })
      await Database.bookAuthorModel.create({ bookId: book.id, authorId: author.id })
      await Database.bookSeriesModel.create({ bookId: book.id, seriesId: series.id, sequence: '1' })
      warmFilterData([{ id: author.id, name: 'max' }], [{ id: series.id, name: 'harry potter' }])

      await rescan(item, { authors: ['Max'], series: [{ name: 'Harry Potter', sequence: '1' }] })

      expect(await authorNamesOnBook(book.id)).to.deep.equal(['Max'])
      expect(await seriesNamesOnBook(book.id)).to.deep.equal(['Harry Potter'])
      expect(await Database.authorModel.count()).to.equal(1)
      expect(await Database.seriesModel.count()).to.equal(1)
      expect(Database.libraryFilterData[library.id].authors[0].name).to.equal('Max')
      expect(Database.libraryFilterData[library.id].series[0].name).to.equal('Harry Potter')
    })

    it('keeps (and logs) an author that other books still use', async () => {
      const { item, book } = await createBookItem('One')
      const { book: book2 } = await createBookItem('Two')
      const author = await Database.authorModel.create({ name: 'max', lastFirst: 'max', libraryId: library.id })
      await Database.bookAuthorModel.create({ bookId: book.id, authorId: author.id })
      await Database.bookAuthorModel.create({ bookId: book2.id, authorId: author.id })

      await rescan(item, { authors: ['Max'] })

      expect(await authorNamesOnBook(book.id)).to.deep.equal(['max'])
      expect(await Database.authorModel.count()).to.equal(1)
      expect(libraryScan.addLog.getCalls().some((c) => /not renamed/.test(c.args[1]) && c.args[1].includes('"max"'))).to.equal(true)
    })
  })

  describe('near-duplicates linked by older bugs', () => {
    it('book linked to "max" and "Max", metadata "Max": the exact spelling stays, the other link goes', async () => {
      const { item, book } = await createBookItem('One')
      const lower = await Database.authorModel.create({ name: 'max', lastFirst: 'max', libraryId: library.id })
      const upper = await Database.authorModel.create({ name: 'Max', lastFirst: 'Max', libraryId: library.id })
      await Database.bookAuthorModel.create({ bookId: book.id, authorId: lower.id })
      await Database.bookAuthorModel.create({ bookId: book.id, authorId: upper.id })

      await rescan(item, { authors: ['Max'] })

      const links = await Database.bookAuthorModel.findAll({ where: { bookId: book.id } })
      expect(links.map((l) => l.authorId)).to.deep.equal([upper.id])
      // The emptied author record is left for the usual empty-author cleanup after the scan
      expect(libraryScan.authorsRemovedFromBooks).to.include(lower.id)
    })

    it('no exact spelling on the book: the oldest link stays (series)', async () => {
      const { item, book } = await createBookItem('One')
      const first = await Database.seriesModel.create({ name: 'saga', libraryId: library.id })
      const second = await Database.seriesModel.create({ name: 'Saga', libraryId: library.id })
      await Database.bookSeriesModel.create({ bookId: book.id, seriesId: first.id, sequence: '1', createdAt: new Date(Date.now() - 1000) })
      await Database.bookSeriesModel.create({ bookId: book.id, seriesId: second.id, sequence: '1' })

      await rescan(item, { series: [{ name: 'SAGA', sequence: '1' }] })

      const links = await Database.bookSeriesModel.findAll({ where: { bookId: book.id } })
      expect(links.map((l) => l.seriesId)).to.deep.equal([first.id])
      // Not renamed: "Saga" is another record with that name
      expect((await Database.seriesModel.findByPk(first.id)).name).to.equal('saga')
    })

    it('quick match drops the near-duplicate link the same way', async () => {
      const { item, book } = await createBookItem('One')
      const lower = await Database.authorModel.create({ name: 'max', lastFirst: 'max', libraryId: library.id })
      const upper = await Database.authorModel.create({ name: 'Max', lastFirst: 'Max', libraryId: library.id })
      await Database.bookAuthorModel.create({ bookId: book.id, authorId: lower.id })
      await Database.bookAuthorModel.create({ bookId: book.id, authorId: upper.id })
      sinon.stub(BookFinder, 'search').resolves([{ title: 'One', author: 'Max' }])

      const apiRouterCtx = { checkRemoveAuthorsWithNoBooks: sinon.stub().resolves(), checkRemoveEmptySeries: sinon.stub().resolves() }
      const libraryItem = await Database.libraryItemModel.getExpandedById(item.id)
      await Scanner.quickMatchLibraryItem(apiRouterCtx, libraryItem, { overrideDetails: true })

      const links = await Database.bookAuthorModel.findAll({ where: { bookId: book.id } })
      expect(links.map((l) => l.authorId)).to.deep.equal([upper.id])
    })
  })
})
