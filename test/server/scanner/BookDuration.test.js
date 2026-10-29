const { expect } = require('chai')
const { Sequelize } = require('sequelize')
const sinon = require('sinon')

const Database = require('../../../server/Database')
const Logger = require('../../../server/Logger')
const SocketAuthority = require('../../../server/SocketAuthority')
const fs = require('../../../server/libs/fsExtra')
const LibraryItemController = require('../../../server/controllers/LibraryItemController')
const BookScanner = require('../../../server/scanner/BookScanner')
const LibraryScan = require('../../../server/scanner/LibraryScan')
const LibraryItemScanData = require('../../../server/scanner/LibraryItemScanData')

// Regression tests for #5311: book duration counted excluded and deleted tracks.
describe('Book duration ignores excluded and deleted tracks (#5311)', () => {
  function audioFile(ino, index, duration, exclude = false) {
    return {
      ino,
      index: exclude ? -1 : index,
      exclude,
      duration,
      metadata: { filename: `${ino}.mp3`, ext: '.mp3', path: `/test/Book/${ino}.mp3`, relPath: `${ino}.mp3`, size: 1000, mtimeMs: 1, ctimeMs: 1, birthtimeMs: 1 },
      chapters: [],
      metaTags: {},
      mimeType: 'audio/mpeg'
    }
  }

  function libraryFile(ino) {
    return {
      ino,
      fileType: 'audio',
      isSupplementary: null,
      metadata: { filename: `${ino}.mp3`, ext: '.mp3', path: `/test/Book/${ino}.mp3`, relPath: `${ino}.mp3`, size: 1000, mtimeMs: 1, ctimeMs: 1, birthtimeMs: 1 },
      addedAt: 1,
      updatedAt: 1
    }
  }

  describe('Book.getDurationFromAudioFiles', () => {
    it('sums only included audio files and skips missing durations', () => {
      const Book = require('../../../server/models/Book')
      const files = [audioFile('a', 1, 100), audioFile('b', 2, 50, true), audioFile('c', 3, 25.5), { ino: 'd', duration: null }, { ino: 'e', duration: 'x' }]
      expect(Book.getDurationFromAudioFiles(files)).to.equal(125.5)
      expect(Book.getDurationFromAudioFiles([])).to.equal(0)
      expect(Book.getDurationFromAudioFiles(undefined)).to.equal(0)
    })
  })

  describe('with database', () => {
    let library
    let folder

    beforeEach(async () => {
      global.ServerSettings = {}
      Database.sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false })
      Database.sequelize.uppercaseFirst = (str) => (str ? `${str[0].toUpperCase()}${str.substr(1)}` : '')
      await Database.buildModels()
      library = await Database.libraryModel.create({ name: 'Test Library', mediaType: 'book' })
      folder = await Database.libraryFolderModel.create({ path: '/test', libraryId: library.id })
      sinon.stub(Logger, 'info')
      sinon.stub(SocketAuthority, 'libraryItemEmitter')
    })

    afterEach(async () => {
      sinon.restore()
      await Database.sequelize.sync({ force: true })
    })

    async function createItem(audioFiles, duration) {
      const book = await Database.bookModel.create({ title: 'Test Book', coverPath: '/test/Book/cover.jpg', audioFiles, duration, tags: [], narrators: [], genres: [], chapters: [] })
      const item = await Database.libraryItemModel.create({
        path: '/test/Book',
        relPath: 'Book',
        libraryFiles: audioFiles.map((af) => libraryFile(af.ino)),
        mediaId: book.id,
        mediaType: 'book',
        libraryId: library.id,
        libraryFolderId: folder.id
      })
      return Database.libraryItemModel.getExpandedById(item.id)
    }

    function fakeRes() {
      return { statusCode: 200, sendStatus: sinon.spy(), json: sinon.spy(), status: sinon.stub().returnsThis() }
    }

    it('updateTracks: excluding a track lowers the duration, including it again restores it', async () => {
      const libraryItem = await createItem([audioFile('a', 1, 100), audioFile('b', 2, 50), audioFile('c', 3, 25)], 175)

      let res = fakeRes()
      await LibraryItemController.updateTracks({ libraryItem, body: { orderedFileData: [{ ino: 'a' }, { ino: 'b', exclude: true }, { ino: 'c' }] } }, res)
      expect(res.json.calledOnce).to.be.true
      let book = await Database.bookModel.findByPk(libraryItem.mediaId)
      expect(book.duration).to.equal(125)

      const reloaded = await Database.libraryItemModel.getExpandedById(libraryItem.id)
      res = fakeRes()
      await LibraryItemController.updateTracks({ libraryItem: reloaded, body: { orderedFileData: [{ ino: 'a' }, { ino: 'b' }, { ino: 'c' }] } }, res)
      book = await Database.bookModel.findByPk(libraryItem.mediaId)
      expect(book.duration).to.equal(175)
    })

    it('deleteLibraryFile: deleting a track lowers the duration', async () => {
      sinon.stub(fs, 'remove').resolves()
      const libraryItem = await createItem([audioFile('a', 1, 100), audioFile('b', 2, 50)], 150)
      const libraryFile = libraryItem.libraryFiles.find((lf) => lf.ino === 'b')

      const res = fakeRes()
      await LibraryItemController.deleteLibraryFile({ libraryItem, libraryFile, params: { fileid: 'b' }, user: { username: 'admin' } }, res)
      expect(res.sendStatus.calledWith(200)).to.be.true
      const book = await Database.bookModel.findByPk(libraryItem.mediaId)
      expect(book.duration).to.equal(100)
    })

    it('rescan: a saved duration that counted an excluded track is corrected', async () => {
      const libraryItem = await createItem([audioFile('a', 1, 100), audioFile('b', 2, 50, true), audioFile('c', 3, 25)], 175)
      sinon.stub(BookScanner, 'getBookMetadataFromScanData').resolves({ title: 'Test Book' })
      sinon.stub(BookScanner, 'saveMetadataFile').resolves()

      const libraryItemData = new LibraryItemScanData({
        libraryFolderId: folder.id,
        libraryId: library.id,
        mediaType: 'book',
        ino: libraryItem.ino,
        path: '/test/Book',
        relPath: 'Book',
        isFile: false,
        mediaMetadata: {},
        libraryFiles: libraryItem.libraryFiles
      })
      const libraryScan = new LibraryScan()
      libraryScan.addLog = () => {}

      const { wasUpdated } = await BookScanner.rescanExistingBookLibraryItem(libraryItem, libraryItemData, {}, libraryScan)
      expect(wasUpdated).to.be.true
      const book = await Database.bookModel.findByPk(libraryItem.mediaId)
      expect(book.duration).to.equal(125)
    })

    it('rescan: a correct duration is left alone', async () => {
      const libraryItem = await createItem([audioFile('a', 1, 100), audioFile('c', 2, 25)], 125)
      sinon.stub(BookScanner, 'getBookMetadataFromScanData').resolves({ title: 'Test Book' })
      const saveMetadataFile = sinon.stub(BookScanner, 'saveMetadataFile').resolves()

      const libraryItemData = new LibraryItemScanData({
        libraryFolderId: folder.id,
        libraryId: library.id,
        mediaType: 'book',
        ino: libraryItem.ino,
        path: '/test/Book',
        relPath: 'Book',
        isFile: false,
        mediaMetadata: {},
        libraryFiles: libraryItem.libraryFiles
      })
      const libraryScan = new LibraryScan()
      libraryScan.addLog = () => {}

      const { wasUpdated } = await BookScanner.rescanExistingBookLibraryItem(libraryItem, libraryItemData, {}, libraryScan)
      expect(wasUpdated).to.be.false
      expect(saveMetadataFile.called).to.be.false
    })
  })
})
