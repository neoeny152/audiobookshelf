const { expect } = require('chai')
const { Sequelize } = require('sequelize')
const sinon = require('sinon')
const os = require('os')
const Path = require('path')

const Database = require('../../../server/Database')
const Logger = require('../../../server/Logger')
const SocketAuthority = require('../../../server/SocketAuthority')
const fs = require('../../../server/libs/fsExtra')
const BookScanner = require('../../../server/scanner/BookScanner')
const AudioFileScanner = require('../../../server/scanner/AudioFileScanner')
const AudioFile = require('../../../server/objects/files/AudioFile')
const LibraryScan = require('../../../server/scanner/LibraryScan')
const LibraryItemScanData = require('../../../server/scanner/LibraryItemScanData')
const parseEbookMetadata = require('../../../server/utils/parsers/parseEbookMetadata')

// Fork: a seek index repair rewrites the MP3s (new size and mtime, only an encoder tag) and rescans the item. The
// rescan must keep what a match set: the files and the folder name know nothing of it.
describe('Rescan after an MP3 seek index repair keeps matched metadata', () => {
  const itemPath = '/books/Pirece Brown/Red Rising'
  let library
  let folder
  let metadataDir

  function fileMetadata(mtimeMs, size) {
    return { filename: 'Part I.mp3', ext: '.mp3', path: `${itemPath}/Part I.mp3`, relPath: 'Part I.mp3', size, mtimeMs, ctimeMs: mtimeMs, birthtimeMs: 1 }
  }

  beforeEach(async () => {
    metadataDir = await fs.mkdtemp(Path.join(os.tmpdir(), 'abs-metadata-'))
    global.MetadataPath = metadataDir
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
    sinon.stub(SocketAuthority, 'emitter')
    sinon.stub(SocketAuthority, 'libraryItemEmitter')
    sinon.stub(parseEbookMetadata, 'parse').resolves(null)
  })

  afterEach(async () => {
    sinon.restore()
    await fs.remove(metadataDir)
    await Database.sequelize.sync({ force: true })
  })

  it('keeps the asin and the author from the match, and takes the new duration', async () => {
    const audioFile = { ino: 'p1', index: 1, duration: 7571.36, codec: 'mp3', mp3SeekIndex: 'none', metadata: fileMetadata(1, 1000), chapters: [], metaTags: {}, mimeType: 'audio/mpeg' }
    const book = await Database.bookModel.create({ title: 'Red Rising', asin: 'B00I2VWW5U', audioFiles: [audioFile], duration: 7571.36, tags: [], narrators: [], genres: [], chapters: [] })
    const author = await Database.authorModel.create({ name: 'Pierce Brown', lastFirst: 'Brown, Pierce', libraryId: library.id })
    await Database.bookAuthorModel.create({ bookId: book.id, authorId: author.id })
    const item = await Database.libraryItemModel.create({
      path: itemPath,
      relPath: 'Pirece Brown/Red Rising',
      isFile: false,
      libraryFiles: [{ ino: 'p1', fileType: 'audio', metadata: fileMetadata(1, 1000), addedAt: 1, updatedAt: 1 }],
      mediaId: book.id,
      mediaType: 'book',
      libraryId: library.id,
      libraryFolderId: folder.id
    })
    // The match wrote the metadata file, as updateMedia does
    await (await Database.libraryItemModel.getExpandedById(item.id)).saveMetadataFile()

    sinon.stub(AudioFileScanner, 'executeMediaFileScans').callsFake(async (mediaType, scanData, libraryFiles) => libraryFiles.map((lf) => new AudioFile({ ...audioFile, metadata: lf.metadata, duration: 7588.78, metaTags: { tagEncoder: 'Lavf62.12.103' } })))
    const scanData = new LibraryItemScanData({
      libraryFolderId: folder.id,
      libraryId: library.id,
      mediaType: 'book',
      ino: item.ino,
      path: itemPath,
      relPath: item.relPath,
      isFile: false,
      mediaMetadata: { title: 'Red Rising', authors: ['Pirece Brown'] },
      libraryFiles: [{ ino: 'p1', fileType: 'audio', metadata: fileMetadata(2, 1100), addedAt: 1, updatedAt: 2 }]
    })
    const libraryScan = new LibraryScan()
    libraryScan.setData(library)
    libraryScan.addLog = () => {}
    const existing = await Database.libraryItemModel.findByPk(item.id)
    await scanData.checkLibraryItemData(existing, libraryScan)

    await BookScanner.rescanExistingBookLibraryItem(existing, scanData, { audiobooksOnly: true }, libraryScan)

    const after = await Database.libraryItemModel.getExpandedById(item.id)
    expect(after.media.asin).to.equal('B00I2VWW5U')
    expect(after.media.authors.map((a) => a.name)).to.deep.equal(['Pierce Brown'])
    expect(after.media.duration).to.equal(7588.78)
  })
})
