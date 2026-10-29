const { expect } = require('chai')
const { Sequelize } = require('sequelize')
const sinon = require('sinon')
const os = require('os')
const Path = require('path')
const fsp = require('fs/promises')

const Database = require('../../../server/Database')
const Logger = require('../../../server/Logger')
const SocketAuthority = require('../../../server/SocketAuthority')
const TaskManager = require('../../../server/managers/TaskManager')
const libraryFilters = require('../../../server/utils/queries/libraryFilters')
const fileUtils = require('../../../server/utils/fileUtils')
const LibraryScan = require('../../../server/scanner/LibraryScan')
const BookScanner = require('../../../server/scanner/BookScanner')
const LibraryItemScanner = require('../../../server/scanner/LibraryItemScanner')
const LibraryScanner = require('../../../server/scanner/LibraryScanner')

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const toPosix = (p) => p.replace(/\\/g, '/')

/** Minimal POSIX-path version of fileUtils.recurseFiles for the fixture folder */
async function posixRecurseFiles(dir, relPathToReplace = null) {
  const root = toPosix(dir).replace(/\/$/, '')
  const base = relPathToReplace ? toPosix(relPathToReplace).replace(/\/$/, '') : root
  const entries = await fsp.readdir(root, { recursive: true, withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const fullpath = Path.posix.join(toPosix(entry.parentPath || entry.path), entry.name)
      const relpath = fullpath.slice(base.length + 1)
      const reldirpath = Path.posix.dirname(relpath)
      return {
        name: entry.name,
        path: relpath,
        reldirpath: reldirpath === '.' ? '' : reldirpath,
        fullpath,
        extension: Path.extname(entry.name),
        deep: relpath.split('/').length - 1
      }
    })
    .sort((a, b) => a.deep - b.deep)
}

describe('LibraryScanner duplicate library items', () => {
  let tmpDir
  let itemPath
  let library
  let folder

  /** Simulates the slow part of adding a book (ffprobe etc.) before the record is created */
  async function fakeScanNewBook(libraryItemData) {
    await delay(40)
    const book = await Database.bookModel.create({ title: 'Book 2', audioFiles: [], tags: [], narrators: [], genres: [], chapters: [] })
    return Database.libraryItemModel.create({
      path: libraryItemData.path,
      relPath: libraryItemData.relPath,
      ino: libraryItemData.ino,
      isFile: false,
      libraryFiles: [],
      mediaId: book.id,
      mediaType: 'book',
      libraryId: libraryItemData.libraryId,
      libraryFolderId: libraryItemData.libraryFolderId
    })
  }

  function countItemsAtPath() {
    return Database.libraryItemModel.count({ where: { libraryId: library.id, path: itemPath } })
  }

  beforeEach(async () => {
    global.ServerSettings = {}
    Database.sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false })
    Database.sequelize.uppercaseFirst = (str) => (str ? `${str[0].toUpperCase()}${str.substr(1)}` : '')
    await Database.buildModels()

    tmpDir = toPosix(await fsp.mkdtemp(Path.join(os.tmpdir(), 'abs-scan-dup-')))
    itemPath = Path.posix.join(tmpDir, 'Matt Dinniman/Dungeon Crawler Carl/Book 2')
    await fsp.mkdir(itemPath, { recursive: true })
    await fsp.writeFile(Path.posix.join(itemPath, 'track.mp3'), 'not really audio')

    const libraryRecord = await Database.libraryModel.create({ name: 'Books', mediaType: 'book', settings: Database.libraryModel.getDefaultLibrarySettingsForMediaType('book') })
    await Database.libraryFolderModel.create({ path: tmpDir, libraryId: libraryRecord.id })
    library = await Database.libraryModel.findByIdWithFolders(libraryRecord.id)
    folder = library.libraryFolders[0]

    sinon.stub(Logger, 'info')
    sinon.stub(Logger, 'debug')
    sinon.stub(Logger, 'warn')
    sinon.stub(SocketAuthority, 'emitter')
    sinon.stub(SocketAuthority, 'libraryItemEmitter')
    sinon.stub(SocketAuthority, 'libraryItemsEmitter')
    sinon.stub(TaskManager, 'taskFinished')
    sinon.stub(LibraryScan.prototype, 'saveLog').resolves()
    sinon.stub(libraryFilters, 'getFilterData').resolves()
    sinon.stub(BookScanner, 'emitAuthorsNumBooksUpdated').resolves()
    sinon.stub(LibraryItemScanner, 'finalizeAuthorsAndSeriesFromScan').resolves()
    sinon.stub(BookScanner, 'rescanExistingBookLibraryItem').callsFake(async (existing) => ({ libraryItem: existing, wasUpdated: false }))
    sinon.stub(BookScanner, 'scanNewBookLibraryItem').callsFake(fakeScanNewBook)
    if (process.platform === 'win32') {
      // recurseFiles leaves Windows separators in fullname, so relative paths come out wrong when running tests on Windows
      sinon.stub(fileUtils, 'recurseFiles').callsFake(posixRecurseFiles)
    }
  })

  afterEach(async () => {
    sinon.restore()
    LibraryScanner.librariesScanning = []
    LibraryScanner.scanningFilesChanged = false
    LibraryScanner.pendingFileUpdatesToScan = []
    await fsp.rm(tmpDir, { recursive: true, force: true })
  })

  it('creates one item when the folder watcher and a full library scan add the same new folder concurrently', async () => {
    const pendingTask = { startedAt: Date.now(), data: {}, setFinished: sinon.stub() }
    const fileUpdates = [
      {
        path: Path.posix.join(itemPath, 'track.mp3'),
        relPath: '/Matt Dinniman/Dungeon Crawler Carl/Book 2/track.mp3',
        folderId: folder.id,
        libraryId: library.id,
        type: 'added'
      }
    ]

    await Promise.all([LibraryScanner.scan(library), LibraryScanner.scanFilesChanged(fileUpdates, pendingTask)])

    expect(await countItemsAtPath()).to.equal(1)
    expect(pendingTask.setFinished.calledOnce).to.be.true
  })

  it('creates one item when two scans call scanNewLibraryItem for the same path at once', async () => {
    const scanData = await LibraryItemScanner.getLibraryItemScanData(itemPath, library, folder, false)
    const libraryScan = new LibraryScan()
    libraryScan.setData(library)

    const results = await Promise.all([LibraryItemScanner.scanPotentialNewLibraryItem(itemPath, library, folder, false), LibraryItemScanner.scanNewLibraryItem(scanData, library.settings, libraryScan)])

    expect(results.filter(Boolean)).to.have.length(1)
    expect(await countItemsAtPath()).to.equal(1)

    // A later attempt sees the record in the database and does not add another
    const again = await LibraryItemScanner.scanNewLibraryItem(scanData, library.settings, libraryScan)
    expect(again).to.equal(null)
    expect(await countItemsAtPath()).to.equal(1)
  })
})
