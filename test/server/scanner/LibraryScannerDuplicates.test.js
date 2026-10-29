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

  async function createItemRecord(ino, createdAt) {
    const book = await Database.bookModel.create({ title: 'Book 2', audioFiles: [], tags: [], narrators: [], genres: [], chapters: [] })
    const item = await Database.libraryItemModel.create({
      path: itemPath,
      relPath: 'Matt Dinniman/Dungeon Crawler Carl/Book 2',
      ino,
      isFile: false,
      libraryFiles: [],
      mediaId: book.id,
      mediaType: 'book',
      libraryId: library.id,
      libraryFolderId: folder.id
    })
    // Force distinct creation times like the observed records added 40-80 ms apart
    await Database.sequelize.query('UPDATE libraryItems SET createdAt = :createdAt WHERE id = :id', { replacements: { createdAt, id: item.id } })
    return item
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

  it('full scan removes newer exact duplicate records, keeps the oldest and leaves files alone', async () => {
    const ino = await fileUtils.getIno(itemPath)
    const oldest = await createItemRecord(ino, '2026-10-01 10:00:00.000 +00:00')
    const newer = await createItemRecord(ino, '2026-10-01 10:00:00.080 +00:00')

    await LibraryScanner.scan(library)

    const remaining = await Database.libraryItemModel.findAll({ where: { libraryId: library.id, path: itemPath } })
    expect(remaining.map((li) => li.id)).to.deep.equal([oldest.id])
    expect(!!remaining[0].isMissing).to.equal(false)
    await delay(20) // media is destroyed in a non-awaited afterDestroy hook
    expect(await Database.bookModel.findByPk(newer.mediaId)).to.equal(null)
    expect(BookScanner.scanNewBookLibraryItem.called).to.be.false
    expect(SocketAuthority.emitter.calledWith('item_removed', { id: newer.id, libraryId: library.id })).to.be.true
    expect(await fsp.readFile(Path.posix.join(itemPath, 'track.mp3'), 'utf8')).to.equal('not really audio')
  })

  it('full scan keeps a newer duplicate that has listening progress and does not mark it missing', async () => {
    const ino = await fileUtils.getIno(itemPath)
    const oldest = await createItemRecord(ino, '2026-10-01 10:00:00.000 +00:00')
    const newer = await createItemRecord(ino, '2026-10-01 10:00:00.040 +00:00')
    const user = await Database.userModel.create({ username: 'reader', type: 'user', isActive: true })
    await Database.mediaProgressModel.create({ userId: user.id, mediaItemId: newer.mediaId, mediaItemType: 'book', currentTime: 100, duration: 1000 })

    await LibraryScanner.scan(library)

    const remaining = await Database.libraryItemModel.findAll({ where: { libraryId: library.id, path: itemPath }, order: [['createdAt', 'ASC']] })
    expect(remaining.map((li) => li.id)).to.deep.equal([oldest.id, newer.id])
    expect(remaining.every((li) => !li.isMissing)).to.be.true
  })

  async function expectBothKeptAfterScan(oldest, newer) {
    await LibraryScanner.scan(library)
    const remaining = await Database.libraryItemModel.findAll({ where: { libraryId: library.id, path: itemPath }, order: [['createdAt', 'ASC']] })
    expect(remaining.map((li) => li.id)).to.deep.equal([oldest.id, newer.id])
    expect(await Database.bookModel.findByPk(newer.mediaId)).to.not.equal(null)
  }

  it('full scan keeps a newer duplicate that has a share link', async () => {
    const ino = await fileUtils.getIno(itemPath)
    const oldest = await createItemRecord(ino, '2026-10-01 10:00:00.000 +00:00')
    const newer = await createItemRecord(ino, '2026-10-01 10:00:00.040 +00:00')
    await Database.mediaItemShareModel.create({ mediaItemId: newer.mediaId, mediaItemType: 'book', slug: 'dup-share', pash: 'x' })

    await expectBothKeptAfterScan(oldest, newer)
  })

  it('full scan keeps a newer duplicate that has listening sessions', async () => {
    const ino = await fileUtils.getIno(itemPath)
    const oldest = await createItemRecord(ino, '2026-10-01 10:00:00.000 +00:00')
    const newer = await createItemRecord(ino, '2026-10-01 10:00:00.040 +00:00')
    await Database.playbackSessionModel.create({ mediaItemId: newer.mediaId, mediaItemType: 'book', timeListening: 60 })

    await expectBothKeptAfterScan(oldest, newer)
  })

  it('full scan keeps a newer duplicate with an open playback session', async () => {
    const ino = await fileUtils.getIno(itemPath)
    const oldest = await createItemRecord(ino, '2026-10-01 10:00:00.000 +00:00')
    const newer = await createItemRecord(ino, '2026-10-01 10:00:00.040 +00:00')
    sinon.stub(SocketAuthority, 'Server').value({ playbackSessionManager: { sessions: [{ id: 'open', libraryItemId: newer.id }] } })

    await expectBothKeptAfterScan(oldest, newer)
  })

  it('full scan never removes a duplicate that shares media with the kept item', async () => {
    const ino = await fileUtils.getIno(itemPath)
    const oldest = await createItemRecord(ino, '2026-10-01 10:00:00.000 +00:00')
    const newer = await createItemRecord(ino, '2026-10-01 10:00:00.040 +00:00')
    const orphanBookId = newer.mediaId
    await Database.sequelize.query('UPDATE libraryItems SET mediaId = :mediaId WHERE id = :id', { replacements: { mediaId: oldest.mediaId, id: newer.id } })
    await Database.bookModel.destroy({ where: { id: orphanBookId } })

    await LibraryScanner.scan(library)
    await delay(20)

    const remaining = await Database.libraryItemModel.findAll({ where: { libraryId: library.id, path: itemPath }, order: [['createdAt', 'ASC']] })
    expect(remaining.map((li) => li.id)).to.deep.equal([oldest.id, newer.id])
    expect(await Database.bookModel.findByPk(oldest.mediaId)).to.not.equal(null)
  })

  it('a kept duplicate follows the missing state of the item it duplicates', async () => {
    const ino = await fileUtils.getIno(itemPath)
    const oldest = await createItemRecord(ino, '2026-10-01 10:00:00.000 +00:00')
    const newer = await createItemRecord(ino, '2026-10-01 10:00:00.040 +00:00')
    const user = await Database.userModel.create({ username: 'reader', type: 'user', isActive: true })
    await Database.mediaProgressModel.create({ userId: user.id, mediaItemId: newer.mediaId, mediaItemType: 'book', currentTime: 100, duration: 1000 })

    await fsp.rm(itemPath, { recursive: true, force: true })
    await LibraryScanner.scan(library)

    let items = await Database.libraryItemModel.findAll({ where: { id: [oldest.id, newer.id] } })
    expect(items.map((li) => !!li.isMissing)).to.deep.equal([true, true])

    // Folder comes back: both are present again (records still match by path)
    await fsp.mkdir(itemPath, { recursive: true })
    await fsp.writeFile(Path.posix.join(itemPath, 'track.mp3'), 'not really audio')
    await Database.libraryItemModel.update({ ino: await fileUtils.getIno(itemPath) }, { where: { id: [oldest.id, newer.id] } })
    await LibraryScanner.scan(library)

    items = await Database.libraryItemModel.findAll({ where: { id: [oldest.id, newer.id] } })
    expect(items.map((li) => !!li.isMissing)).to.deep.equal([false, false])
    expect(await Database.mediaProgressModel.count({ where: { mediaItemId: newer.mediaId } })).to.equal(1)
  })

  it('watcher updates for other libraries are not held up while one library is being scanned', async () => {
    const otherLibraryRecord = await Database.libraryModel.create({ name: 'Other', mediaType: 'book', settings: Database.libraryModel.getDefaultLibrarySettingsForMediaType('book') })
    const otherFolder = await Database.libraryFolderModel.create({ path: Path.posix.join(tmpDir, 'other'), libraryId: otherLibraryRecord.id })

    const scannedLibraryIds = []
    sinon.stub(LibraryScanner, 'scanFolderUpdates').callsFake(async (lib) => {
      scannedLibraryIds.push(lib.id)
      return {}
    })

    const makeUpdate = (libraryId, folderId, folderPath, name) => ({
      path: Path.posix.join(folderPath, `Author/${name}/track.mp3`),
      relPath: `/Author/${name}/track.mp3`,
      folderId,
      libraryId,
      type: 'added'
    })
    const makeTask = () => ({ startedAt: Date.now(), data: {}, setFinished: sinon.stub() })

    // Simulate a long full scan holding this library
    let finishFullScan
    const fullScan = LibraryScanner.runWithLibraryLock(library.id, () => new Promise((resolve) => (finishFullScan = resolve)))

    const busyTask = makeTask()
    const busyUpdate = LibraryScanner.scanFilesChanged([makeUpdate(library.id, folder.id, tmpDir, 'A')], busyTask)
    const otherTask = makeTask()
    const otherUpdate = LibraryScanner.scanFilesChanged([makeUpdate(otherLibraryRecord.id, otherFolder.id, otherFolder.path, 'B')], otherTask)
    const laterBusyTask = makeTask()
    const laterBusyUpdate = LibraryScanner.scanFilesChanged([makeUpdate(library.id, folder.id, tmpDir, 'C')], laterBusyTask)

    await otherUpdate
    await delay(20)
    expect(scannedLibraryIds).to.deep.equal([otherLibraryRecord.id])
    expect(otherTask.setFinished.calledOnce).to.be.true
    expect(busyTask.setFinished.called).to.be.false
    expect(laterBusyTask.setFinished.called).to.be.false

    finishFullScan()
    await Promise.all([fullScan, busyUpdate, laterBusyUpdate])
    // Queued watcher calls are started without being awaited by the caller
    for (let i = 0; i < 50 && !laterBusyTask.setFinished.called; i++) await delay(10)
    expect(scannedLibraryIds).to.deep.equal([otherLibraryRecord.id, library.id, library.id])
    expect(busyTask.setFinished.calledOnce).to.be.true
    expect(laterBusyTask.setFinished.calledOnce).to.be.true
    expect(LibraryScanner.scanningFilesChanged).to.be.false
    expect(LibraryScanner.libraryLocks.size).to.equal(0)
  })
})
