const { expect } = require('chai')
const { Sequelize } = require('sequelize')
const sinon = require('sinon')

const Database = require('../../../server/Database')
const Logger = require('../../../server/Logger')
const SocketAuthority = require('../../../server/SocketAuthority')
const BookFinder = require('../../../server/finders/BookFinder')
const Scanner = require('../../../server/scanner/Scanner')
const BookScanner = require('../../../server/scanner/BookScanner')
const AudioFileScanner = require('../../../server/scanner/AudioFileScanner')
const CoverManager = require('../../../server/managers/CoverManager')
const LibraryScan = require('../../../server/scanner/LibraryScan')
const LibraryItemScanData = require('../../../server/scanner/LibraryItemScanData')
const { dedupeNames, dedupeSeries } = require('../../../server/utils/nameMatching')

describe('Duplicate bookAuthor/bookSeries rows (#5215 #5319 #2650)', () => {
  let library
  let folder

  beforeEach(async () => {
    global.ServerSettings = { storeMetadataWithItem: false, metadataFileFormat: 'json' }
    Database.sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false })
    Database.sequelize.uppercaseFirst = (str) => (str ? `${str[0].toUpperCase()}${str.substr(1)}` : '')
    await Database.buildModels()
    Database.libraryFilterData = {}
    Database.serverSettings = { scannerPreferMatchedMetadata: false, scannerFindCovers: false }

    library = await Database.libraryModel.create({ name: 'Books', mediaType: 'book' })
    folder = await Database.libraryFolderModel.create({ path: '/books', libraryId: library.id })

    sinon.stub(Logger, 'info')
    sinon.stub(Logger, 'debug')
    sinon.stub(SocketAuthority, 'emitter')
    sinon.stub(SocketAuthority, 'libraryItemEmitter')
  })

  afterEach(async () => {
    sinon.restore()
    await Database.sequelize.sync({ force: true })
  })

  async function createBookItem(title = 'Book') {
    const book = await Database.bookModel.create({ title, audioFiles: [], tags: [], narrators: [], genres: [], chapters: [] })
    const item = await Database.libraryItemModel.create({ libraryFiles: [], mediaId: book.id, mediaType: 'book', libraryId: library.id, libraryFolderId: folder.id, path: `/books/${title}`, relPath: title })
    return { book, item }
  }

  describe('join model findOrCreateLink', () => {
    it('links an author to a book only once', async () => {
      const { book } = await createBookItem()
      const author = await Database.authorModel.create({ name: 'Max', lastFirst: 'Max', libraryId: library.id })

      const results = await Promise.all([Database.bookAuthorModel.findOrCreateLink(book.id, author.id), Database.bookAuthorModel.findOrCreateLink(book.id, author.id)])
      expect(results.filter((r) => r.created)).to.have.length(1)
      expect(await Database.bookAuthorModel.count({ where: { bookId: book.id } })).to.equal(1)
    })

    it('links a series to a book only once and keeps the existing sequence', async () => {
      const { book } = await createBookItem()
      const series = await Database.seriesModel.create({ name: 'Foo', libraryId: library.id })

      await Database.bookSeriesModel.findOrCreateLink(book.id, series.id, '1')
      const { bookSeries, created } = await Database.bookSeriesModel.findOrCreateLink(book.id, series.id, '2')
      expect(created).to.equal(false)
      expect(bookSeries.sequence).to.equal('1')
      expect(await Database.bookSeriesModel.count({ where: { bookId: book.id } })).to.equal(1)
    })
  })

  describe('name dedupe helpers', () => {
    it('keeps the first spelling of each name', () => {
      expect(dedupeNames(['Foo', 'foo', ' Bar ', '', 'FOO'])).to.deep.equal(['Foo', 'Bar'])
    })

    it('keeps one series per name and fills a missing sequence', () => {
      expect(dedupeSeries([{ name: 'Foo' }, { name: 'foo', sequence: '2' }, { name: 'Bar', sequence: '1' }])).to.deep.equal([
        { name: 'Foo', sequence: '2' },
        { name: 'Bar', sequence: '1' }
      ])
    })
  })

  describe('quick match', () => {
    const apiRouterCtx = { checkRemoveAuthorsWithNoBooks: async () => {}, checkRemoveEmptySeries: async () => {} }

    beforeEach(() => {
      sinon.stub(Database.libraryItemModel.prototype, 'saveMetadataFile').resolves()
    })

    it('two parallel matches of a book with no series do not throw and create one row each (#5215)', async () => {
      const { item, book } = await createBookItem()
      sinon.stub(BookFinder, 'search').resolves([{ title: 'Book', author: 'New Author', series: [{ series: 'New Series', sequence: '1' }] }])

      // Two requests load the book separately, like two API calls
      const itemA = await Database.libraryItemModel.getExpandedById(item.id)
      const itemB = await Database.libraryItemModel.getExpandedById(item.id)
      await Promise.all([Scanner.quickMatchLibraryItem(apiRouterCtx, itemA, { overrideDetails: true }), Scanner.quickMatchLibraryItem(apiRouterCtx, itemB, { overrideDetails: true })])

      expect(await Database.seriesModel.count()).to.equal(1)
      expect(await Database.authorModel.count()).to.equal(1)
      expect(await Database.bookSeriesModel.count({ where: { bookId: book.id } })).to.equal(1)
      expect(await Database.bookAuthorModel.count({ where: { bookId: book.id } })).to.equal(1)
    })

    it('duplicate author and series names in the match result link once (#5215 #2650)', async () => {
      const { item, book } = await createBookItem()
      sinon.stub(BookFinder, 'search').resolves([
        {
          title: 'Book',
          author: 'Foo, foo, Bar',
          series: [
            { series: 'Saga', sequence: '1' },
            { series: 'saga', sequence: '1' }
          ]
        }
      ])

      const libraryItem = await Database.libraryItemModel.getExpandedById(item.id)
      await Scanner.quickMatchLibraryItem(apiRouterCtx, libraryItem, { overrideDetails: true })

      const authors = await Database.authorModel.findAll()
      expect(authors.map((a) => a.name).sort()).to.deep.equal(['Bar', 'Foo'])
      expect(await Database.bookAuthorModel.count({ where: { bookId: book.id } })).to.equal(2)
      expect(await Database.bookSeriesModel.count({ where: { bookId: book.id } })).to.equal(1)
    })

    it('a series name that only differs in case from the one on the book is kept, not duplicated', async () => {
      const { item, book } = await createBookItem()
      const series = await Database.seriesModel.create({ name: 'Harry Potter', libraryId: library.id })
      await Database.bookSeriesModel.create({ bookId: book.id, seriesId: series.id, sequence: '1' })
      sinon.stub(BookFinder, 'search').resolves([{ title: 'Book', series: [{ series: 'harry potter', sequence: '1' }] }])

      const libraryItem = await Database.libraryItemModel.getExpandedById(item.id)
      await Scanner.quickMatchLibraryItem(apiRouterCtx, libraryItem, { overrideDetails: true })

      expect(await Database.seriesModel.count()).to.equal(1)
      expect(await Database.bookSeriesModel.count({ where: { bookId: book.id } })).to.equal(1)
    })
  })

  describe('Book.updateAuthorsFromRequest / updateSeriesFromRequest', () => {
    it('does not crash on the same name twice in one request', async () => {
      const { item, book } = await createBookItem()
      const libraryItem = await Database.libraryItemModel.getExpandedById(item.id)

      await libraryItem.media.updateAuthorsFromRequest(['Foo', 'foo'], library.id)
      await libraryItem.media.updateSeriesFromRequest(
        [
          { name: 'Saga', sequence: '1' },
          { name: 'SAGA', sequence: '1' }
        ],
        library.id
      )

      expect(await Database.bookAuthorModel.count({ where: { bookId: book.id } })).to.equal(1)
      expect(await Database.bookSeriesModel.count({ where: { bookId: book.id } })).to.equal(1)
    })
  })

  describe('library scan of a new book', () => {
    let libraryScan

    beforeEach(() => {
      libraryScan = new LibraryScan()
      libraryScan.setData(library)
      sinon.stub(libraryScan, 'addLog')
      sinon.stub(AudioFileScanner, 'executeMediaFileScans').resolves([{ index: 1, ino: '11', duration: 60, metadata: { filename: 'a.mp3', ext: '.mp3', path: '/books/New/a.mp3', relPath: 'a.mp3' }, chapters: [], metaTags: {} }])
      sinon.stub(AudioFileScanner, 'runSmartTrackOrder').callsFake((relPath, files) => files)
      sinon.stub(CoverManager, 'saveEmbeddedCoverArt').resolves(null)
      sinon.stub(BookScanner, 'saveMetadataFile').resolves()
    })

    function newItemScanData() {
      return new LibraryItemScanData({
        libraryFolderId: folder.id,
        libraryId: library.id,
        mediaType: 'book',
        ino: '10',
        path: '/books/New',
        relPath: 'New',
        isFile: false,
        mediaMetadata: { title: 'New' },
        libraryFiles: [{ ino: '11', metadata: { filename: 'a.mp3', ext: '.mp3', path: '/books/New/a.mp3', relPath: 'a.mp3', size: 100 }, toJSON() { return this } }]
      })
    }

    function stubTags(authors, series) {
      sinon.stub(BookScanner.constructor.BookMetadataSourceHandler.prototype, 'audioMetatags').callsFake(function () {
        this.bookMetadata.authors = authors
        this.bookMetadata.series = series
      })
    }

    it('tags "max; MAX" while author "Max" exists: the book is added with one author link (#5319)', async () => {
      const max = await Database.authorModel.create({ name: 'Max', lastFirst: 'Max', libraryId: library.id })
      stubTags(['max', 'MAX'], [])

      const libraryItem = await BookScanner.scanNewBookLibraryItem(newItemScanData(), { metadataPrecedence: ['audioMetatags'], audiobooksOnly: true }, libraryScan)

      expect(libraryItem).to.exist
      const links = await Database.bookAuthorModel.findAll({ where: { bookId: libraryItem.mediaId } })
      expect(links.map((l) => l.authorId)).to.deep.equal([max.id])
      expect(await Database.authorModel.count()).to.equal(1)
    })

    it('"Author: Foo, Foo" creates one author, not two (#2650)', async () => {
      stubTags(['Foo', 'Foo'], [{ name: 'Saga', sequence: '1' }, { name: 'saga', sequence: '1' }])

      const libraryItem = await BookScanner.scanNewBookLibraryItem(newItemScanData(), { metadataPrecedence: ['audioMetatags'], audiobooksOnly: true }, libraryScan)

      expect(libraryItem).to.exist
      expect(await Database.authorModel.count()).to.equal(1)
      expect(await Database.seriesModel.count()).to.equal(1)
      expect(await Database.bookAuthorModel.count({ where: { bookId: libraryItem.mediaId } })).to.equal(1)
    })
  })
})
