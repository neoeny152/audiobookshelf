const { expect } = require('chai')
const { Sequelize } = require('sequelize')
const sinon = require('sinon')

const Database = require('../../../server/Database')
const Logger = require('../../../server/Logger')
const SocketAuthority = require('../../../server/SocketAuthority')
const BookScanner = require('../../../server/scanner/BookScanner')
const AudioFileScanner = require('../../../server/scanner/AudioFileScanner')
const CoverManager = require('../../../server/managers/CoverManager')
const LibraryScan = require('../../../server/scanner/LibraryScan')
const LibraryItemScanData = require('../../../server/scanner/LibraryItemScanData')
const AuthorController = require('../../../server/controllers/AuthorController')
const SeriesController = require('../../../server/controllers/SeriesController')

describe('Case-insensitive series and author names (#4255 #4033 #5278 #4934)', () => {
  let library
  let folder

  beforeEach(async () => {
    global.ServerSettings = { storeMetadataWithItem: false, metadataFileFormat: 'json' }
    Database.sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false })
    Database.sequelize.uppercaseFirst = (str) => (str ? `${str[0].toUpperCase()}${str.substr(1)}` : '')
    await Database.buildModels()
    Database.libraryFilterData = {}
    Database.serverSettings = { scannerFindCovers: false }

    library = await Database.libraryModel.create({ name: 'Books', mediaType: 'book' })
    folder = await Database.libraryFolderModel.create({ path: '/books', libraryId: library.id })

    sinon.stub(Logger, 'info')
    sinon.stub(Logger, 'debug')
    sinon.stub(Logger, 'warn')
    sinon.stub(SocketAuthority, 'emitter')
    sinon.stub(SocketAuthority, 'libraryItemEmitter')
    sinon.stub(SocketAuthority, 'libraryItemsEmitter')
    sinon.stub(Database.libraryItemModel.prototype, 'saveMetadataFile').resolves()
  })

  afterEach(async () => {
    sinon.restore()
    Database.libraryFilterData = {}
    await Database.sequelize.sync({ force: true })
  })

  /** Simulates browsing the library, which loads the in-memory filter data cache */
  function warmFilterData(authors, series) {
    Database.libraryFilterData[library.id] = { authors, series, genres: [], tags: [], narrators: [], publishers: [], publishedDecades: [], languages: [], numIssues: 0 }
  }

  async function createBookItem(title) {
    const book = await Database.bookModel.create({ title, audioFiles: [], tags: [], narrators: [], genres: [], chapters: [] })
    const item = await Database.libraryItemModel.create({ libraryFiles: [], mediaId: book.id, mediaType: 'book', libraryId: library.id, libraryFolderId: folder.id, path: `/books/${title}`, relPath: title })
    return { book, item }
  }

  describe('Database name lookups with a warm cache', () => {
    it('getAuthorIdByName and getSeriesIdByName ignore case like the DB fallback', async () => {
      warmFilterData([{ id: 'author-1', name: 'Max' }], [{ id: 'series-1', name: 'Harry Potter' }])

      expect(await Database.getAuthorIdByName(library.id, 'max')).to.equal('author-1')
      expect(await Database.getSeriesIdByName(library.id, 'harry potter')).to.equal('series-1')
      expect(await Database.getSeriesIdByName(library.id, 'Harry')).to.equal(null)
    })
  })

  describe('non-ASCII names (SQLite lower() only folds A-Z)', () => {
    it('the DB lookup finds the exact spelling of a non-ASCII name', async () => {
      const author = await Database.authorModel.create({ name: 'Émile Zola', lastFirst: 'Zola, Émile', libraryId: library.id })
      const series = await Database.seriesModel.create({ name: 'Les Rougon-Macquart Été', libraryId: library.id })

      expect((await Database.authorModel.getByNameAndLibrary('Émile Zola', library.id))?.id).to.equal(author.id)
      expect((await Database.authorModel.getByNameAndLibrary('ÉMILE ZOLA', library.id))?.id).to.equal(author.id)
      // Known limitation: É/é are not folded, same as the cold lookup always did
      expect((await Database.authorModel.getByNameAndLibrary('émile zola', library.id))?.id).to.equal(undefined)
      expect((await Database.seriesModel.getByNameAndLibrary('les rougon-macquart Été', library.id))?.id).to.equal(series.id)
    })

    it('a warm cache resolves names exactly like the cold DB lookup', async () => {
      const author = await Database.authorModel.create({ name: 'Émile', lastFirst: 'Émile', libraryId: library.id })
      const series = await Database.seriesModel.create({ name: 'Été', libraryId: library.id })
      const lookups = ['Émile', 'émile', 'ÉMILE']
      const seriesLookups = ['Été', 'été', 'ÉTÉ']

      const cold = []
      for (const name of lookups) cold.push(await Database.getAuthorIdByName(library.id, name))
      for (const name of seriesLookups) cold.push(await Database.getSeriesIdByName(library.id, name))

      warmFilterData([{ id: author.id, name: author.name }], [{ id: series.id, name: series.name }])
      const warm = []
      for (const name of lookups) warm.push(await Database.getAuthorIdByName(library.id, name))
      for (const name of seriesLookups) warm.push(await Database.getSeriesIdByName(library.id, name))

      // "ÉMILE" folds to "Émile" (only A-Z change); "ÉTÉ" folds to "ÉtÉ", not "Été"
      expect(cold).to.deep.equal([author.id, null, author.id, series.id, null, null])
      expect(warm).to.deep.equal(cold)
    })

    it('renaming an author to the exact name of another non-ASCII author still merges them', async () => {
      const { book } = await createBookItem('One')
      const emile = await Database.authorModel.create({ name: 'Émile', lastFirst: 'Émile', libraryId: library.id })
      const other = await Database.authorModel.create({ name: 'Other', lastFirst: 'Other', libraryId: library.id })
      await Database.bookAuthorModel.create({ bookId: book.id, authorId: other.id })

      const res = { json: sinon.stub(), status: sinon.stub().returnsThis(), send: sinon.stub() }
      await AuthorController.update.call({}, { author: other, body: { name: 'Émile' } }, res)

      expect(res.json.firstCall.args[0].merged).to.equal(true)
      expect(res.json.firstCall.args[0].author.id).to.equal(emile.id)
      expect(await Database.authorModel.count()).to.equal(1)
    })
  })

  describe('library scan', () => {
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

    it('a new book tagged "harry potter" joins the existing "Harry Potter" series after the library was browsed (#4255)', async () => {
      const series = await Database.seriesModel.create({ name: 'Harry Potter', libraryId: library.id })
      const author = await Database.authorModel.create({ name: 'J.K. Rowling', lastFirst: 'Rowling, J.K.', libraryId: library.id })
      warmFilterData([{ id: author.id, name: author.name }], [{ id: series.id, name: series.name }])
      sinon.stub(BookScanner.constructor.BookMetadataSourceHandler.prototype, 'audioMetatags').callsFake(function () {
        this.bookMetadata.authors = ['j.k. rowling']
        this.bookMetadata.series = [{ name: 'harry potter', sequence: '2' }]
      })

      const scanData = new LibraryItemScanData({
        libraryFolderId: folder.id,
        libraryId: library.id,
        mediaType: 'book',
        ino: '10',
        path: '/books/New',
        relPath: 'New',
        isFile: false,
        mediaMetadata: { title: 'New' },
        libraryFiles: [{ ino: '11', metadata: { filename: 'a.mp3', ext: '.mp3', path: '/books/New/a.mp3', relPath: 'a.mp3', size: 100 } }]
      })
      const libraryItem = await BookScanner.scanNewBookLibraryItem(scanData, { metadataPrecedence: ['audioMetatags'], audiobooksOnly: true }, libraryScan)

      expect(await Database.seriesModel.count()).to.equal(1)
      expect(await Database.authorModel.count()).to.equal(1)
      const bookSeries = await Database.bookSeriesModel.findOne({ where: { bookId: libraryItem.mediaId } })
      expect(bookSeries.seriesId).to.equal(series.id)
    })
  })

  describe('AuthorController.update', () => {
    it('renaming "max" to "MAX" merges into the existing "Max" (#4033 #5278)', async () => {
      const { book: book1 } = await createBookItem('One')
      const { book: book2 } = await createBookItem('Two')
      const max = await Database.authorModel.create({ name: 'Max', lastFirst: 'Max', libraryId: library.id })
      const lowerMax = await Database.authorModel.create({ name: 'max', lastFirst: 'max', libraryId: library.id })
      await Database.bookAuthorModel.create({ bookId: book1.id, authorId: max.id })
      await Database.bookAuthorModel.create({ bookId: book2.id, authorId: lowerMax.id })

      const res = { json: sinon.stub(), status: sinon.stub().returnsThis(), send: sinon.stub() }
      await AuthorController.update.call({}, { author: lowerMax, body: { name: 'MAX' } }, res)

      expect(res.json.calledOnce).to.be.true
      expect(res.json.firstCall.args[0].merged).to.equal(true)
      expect(res.json.firstCall.args[0].author.id).to.equal(max.id)
      const authors = await Database.authorModel.findAll()
      expect(authors.map((a) => a.name)).to.deep.equal(['Max'])
      expect(await Database.bookAuthorModel.count({ where: { authorId: max.id } })).to.equal(2)
    })
  })

  describe('SeriesController.update', () => {
    it('renaming a series to a name already used in the library answers 400 instead of crashing', async () => {
      await Database.seriesModel.create({ name: 'Saga', libraryId: library.id })
      const other = await Database.seriesModel.create({ name: 'Other', libraryId: library.id })

      const res = { json: sinon.stub(), status: sinon.stub().returnsThis(), send: sinon.stub() }
      await SeriesController.update.call({}, { series: other, body: { name: 'Saga' } }, res)

      expect(res.status.calledWith(400)).to.be.true
      expect((await Database.seriesModel.findByPk(other.id)).name).to.equal('Other')
    })

    it('a rename updates the cached name used by scans', async () => {
      const series = await Database.seriesModel.create({ name: 'harry potter', libraryId: library.id })
      warmFilterData([], [{ id: series.id, name: series.name }])

      const res = { json: sinon.stub(), status: sinon.stub().returnsThis(), send: sinon.stub() }
      await SeriesController.update.call({}, { series, body: { name: 'Harry Potter' } }, res)

      expect(Database.libraryFilterData[library.id].series[0].name).to.equal('Harry Potter')
    })
  })

  describe('book editor case-only change (#4934)', () => {
    it('renames a series and author that only this book uses', async () => {
      const { item, book } = await createBookItem('One')
      const series = await Database.seriesModel.create({ name: 'harry potter', libraryId: library.id })
      const author = await Database.authorModel.create({ name: 'max', lastFirst: 'max', libraryId: library.id })
      await Database.bookSeriesModel.create({ bookId: book.id, seriesId: series.id, sequence: '1' })
      await Database.bookAuthorModel.create({ bookId: book.id, authorId: author.id })

      const libraryItem = await Database.libraryItemModel.getExpandedById(item.id)
      const seriesResult = await libraryItem.media.updateSeriesFromRequest([{ name: 'Harry Potter', sequence: '1' }], library.id)
      const authorResult = await libraryItem.media.updateAuthorsFromRequest(['Max'], library.id)

      expect(seriesResult.hasUpdates).to.equal(true)
      expect(seriesResult.seriesRenamed.map((se) => se.id)).to.deep.equal([series.id])
      expect(authorResult.authorsRenamed.map((au) => au.id)).to.deep.equal([author.id])
      expect((await Database.seriesModel.findByPk(series.id)).name).to.equal('Harry Potter')
      expect((await Database.authorModel.findByPk(author.id)).name).to.equal('Max')
      expect(await Database.seriesModel.count()).to.equal(1)
      expect(await Database.authorModel.count()).to.equal(1)
    })

    it('leaves a series that other books use unchanged', async () => {
      const { item, book } = await createBookItem('One')
      const { book: book2 } = await createBookItem('Two')
      const series = await Database.seriesModel.create({ name: 'harry potter', libraryId: library.id })
      await Database.bookSeriesModel.create({ bookId: book.id, seriesId: series.id, sequence: '1' })
      await Database.bookSeriesModel.create({ bookId: book2.id, seriesId: series.id, sequence: '2' })

      const libraryItem = await Database.libraryItemModel.getExpandedById(item.id)
      const result = await libraryItem.media.updateSeriesFromRequest([{ name: 'Harry Potter', sequence: '1' }], library.id)

      expect(result.seriesRenamed).to.have.length(0)
      expect((await Database.seriesModel.findByPk(series.id)).name).to.equal('harry potter')
      expect(await Database.bookSeriesModel.count({ where: { bookId: book.id } })).to.equal(1)
    })
  })
})
