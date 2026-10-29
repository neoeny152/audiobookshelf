const { expect } = require('chai')
const { Sequelize } = require('sequelize')
const sinon = require('sinon')

const Database = require('../../../server/Database')
const Logger = require('../../../server/Logger')
const SocketAuthority = require('../../../server/SocketAuthority')
const TaskManager = require('../../../server/managers/TaskManager')
const libraryFilters = require('../../../server/utils/queries/libraryFilters')
const fileUtils = require('../../../server/utils/fileUtils')
const fs = require('../../../server/libs/fsExtra')
const LibraryFile = require('../../../server/objects/files/LibraryFile')
const LibraryScan = require('../../../server/scanner/LibraryScan')
const LibraryItemScanData = require('../../../server/scanner/LibraryItemScanData')
const LibraryItemScanner = require('../../../server/scanner/LibraryItemScanner')
const LibraryScanner = require('../../../server/scanner/LibraryScanner')

/**
 * Inode-only matching re-pointed existing items at other folders (#1447, #4943, #4981, #4963).
 * On Unraid user shares inode numbers of different disks collide, and XFS reuses inode numbers after a delete.
 * All file system access is faked: `disk` maps a path to its inode and size.
 */
describe('LibraryScanner inode match guard', () => {
  const ROOT = '/audiobooks'
  let library
  let folder
  /** @type {Record<string, {ino: number, size?: number, dir?: boolean}>} */
  let disk

  function useFakeDisk(entries) {
    disk = entries
  }

  function libraryFileObject(itemPath, relPath, size, ino) {
    const filename = relPath.split('/').pop()
    return {
      ino: String(ino),
      metadata: { filename, ext: '.' + filename.split('.').pop(), path: `${itemPath}/${relPath}`, relPath, size, mtimeMs: 1, ctimeMs: 1, birthtimeMs: 1 },
      isSupplementary: null,
      addedAt: 1,
      updatedAt: 1,
      fileType: 'audio'
    }
  }

  async function createItem({ id, relPath, ino, files, isFile = false }) {
    const path = `${ROOT}/${relPath}`
    const book = await Database.bookModel.create({ ...(id ? { id } : {}), title: relPath, audioFiles: [], tags: [], narrators: [], genres: [], chapters: [] })
    return Database.libraryItemModel.create({
      ...(id ? { id } : {}),
      path,
      relPath,
      ino: String(ino),
      isFile,
      mtime: 1,
      ctime: 1,
      birthtime: 1,
      libraryFiles: files.map(([fileRelPath, size, fileIno]) => libraryFileObject(isFile ? ROOT : path, fileRelPath, size, fileIno)),
      mediaId: book.id,
      mediaType: 'book',
      libraryId: library.id,
      libraryFolderId: folder.id
    })
  }

  function scanData({ relPath, ino, files }) {
    const path = `${ROOT}/${relPath}`
    return new LibraryItemScanData({
      libraryFolderId: folder.id,
      libraryId: library.id,
      mediaType: 'book',
      ino: String(ino),
      mtimeMs: 1,
      ctimeMs: 1,
      birthtimeMs: 1,
      path,
      relPath,
      isFile: false,
      mediaMetadata: {},
      libraryFiles: files.map(([fileRelPath, size, fileIno]) => new LibraryFile(libraryFileObject(path, fileRelPath, size, fileIno)))
    })
  }

  beforeEach(async () => {
    global.ServerSettings = {}
    Database.sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false })
    Database.sequelize.uppercaseFirst = (str) => (str ? `${str[0].toUpperCase()}${str.substr(1)}` : '')
    await Database.buildModels()

    const libraryRecord = await Database.libraryModel.create({ name: 'Books', mediaType: 'book', settings: Database.libraryModel.getDefaultLibrarySettingsForMediaType('book') })
    await Database.libraryFolderModel.create({ path: ROOT, libraryId: libraryRecord.id })
    library = await Database.libraryModel.findByIdWithFolders(libraryRecord.id)
    folder = library.libraryFolders[0]
    disk = {}

    sinon.stub(Logger, 'info')
    sinon.stub(Logger, 'debug')
    sinon.stub(Logger, 'warn')
    sinon.stub(SocketAuthority, 'emitter')
    sinon.stub(SocketAuthority, 'libraryItemEmitter')
    sinon.stub(SocketAuthority, 'libraryItemsEmitter')
    sinon.stub(TaskManager, 'taskFinished')
    sinon.stub(LibraryScan.prototype, 'saveLog').resolves()
    sinon.stub(libraryFilters, 'getFilterData').resolves()
    sinon.stub(LibraryItemScanner, 'finalizeAuthorsAndSeriesFromScan').resolves()

    sinon.stub(fs, 'pathExists').callsFake(async (path) => Object.prototype.hasOwnProperty.call(disk, path))
    sinon.stub(fs, 'stat').callsFake(async (path) => {
      const entry = disk[path]
      if (!entry) throw Object.assign(new Error(`ENOENT: stat '${path}'`), { code: 'ENOENT' })
      return { ino: BigInt(entry.ino), size: BigInt(entry.size || 0), isFile: () => !entry.dir }
    })
    sinon.stub(fileUtils, 'getIno').callsFake(async (path) => (disk[path] ? String(disk[path].ino) : null))
  })

  afterEach(() => {
    sinon.restore()
    LibraryScanner.librariesScanning = []
    LibraryScanner.scanningFilesChanged = false
    LibraryScanner.pendingFileUpdatesToScan = []
  })

  describe('watcher folder updates (scanFolderUpdates)', () => {
    let scanLibraryItem
    let scanPotentialNewLibraryItem

    beforeEach(() => {
      scanLibraryItem = sinon.stub(LibraryItemScanner, 'scanLibraryItem').resolves(1)
      scanPotentialNewLibraryItem = sinon.stub(LibraryItemScanner, 'scanPotentialNewLibraryItem').resolves(null)
    })

    it('does not move an item whose folder still exists when a new folder has a colliding inode (#4943)', async () => {
      const bookA = await createItem({ relPath: 'Author/Book A', ino: 100, files: [['a.mp3', 1000, 101]] })
      useFakeDisk({
        [`${ROOT}/Author/Book A`]: { ino: 100, dir: true },
        [`${ROOT}/Author/Book A/a.mp3`]: { ino: 101, size: 1000 },
        // Same inode number from another Unraid disk
        [`${ROOT}/Other/Book B`]: { ino: 100, dir: true },
        [`${ROOT}/Other/Book B/b.mp3`]: { ino: 201, size: 2000 }
      })

      await LibraryScanner.scanFolderUpdates(library, folder, { 'Other/Book B': ['b.mp3'] })

      expect(scanLibraryItem.called, 'existing item was re-pointed').to.be.false
      expect(scanPotentialNewLibraryItem.calledOnce).to.be.true
      expect(scanPotentialNewLibraryItem.firstCall.args[0]).to.equal(`${ROOT}/Other/Book B`)
      expect((await Database.libraryItemModel.findByPk(bookA.id)).path).to.equal(`${ROOT}/Author/Book A`)
    })

    it('does not move a deleted item onto a new folder that only reuses its inodes (#1447)', async () => {
      await createItem({ relPath: 'Author/Book A', ino: 100, files: [['a.mp3', 1000, 101]] })
      useFakeDisk({
        // Book A was deleted, Book B copied in and got the freed inode numbers
        [`${ROOT}/Other/Book B`]: { ino: 100, dir: true },
        [`${ROOT}/Other/Book B/b.mp3`]: { ino: 101, size: 2000 }
      })

      await LibraryScanner.scanFolderUpdates(library, folder, { 'Other/Book B': ['b.mp3'] })

      expect(scanLibraryItem.called).to.be.false
      expect(scanPotentialNewLibraryItem.calledOnce).to.be.true
    })

    it('still follows a renamed folder', async () => {
      const bookA = await createItem({ relPath: 'Author/Book A', ino: 100, files: [['a.mp3', 1000, 101]] })
      useFakeDisk({
        [`${ROOT}/Author/Book A (2001)`]: { ino: 100, dir: true },
        [`${ROOT}/Author/Book A (2001)/a.mp3`]: { ino: 101, size: 1000 }
      })

      await LibraryScanner.scanFolderUpdates(library, folder, { 'Author/Book A (2001)': ['a.mp3'] })

      expect(scanPotentialNewLibraryItem.called).to.be.false
      expect(scanLibraryItem.calledOnce).to.be.true
      const [id, details] = scanLibraryItem.firstCall.args
      expect(id).to.equal(bookA.id)
      expect(details).to.include({ path: `${ROOT}/Author/Book A (2001)`, relPath: 'Author/Book A (2001)', libraryFolderId: folder.id, isFile: false })
    })

    it('follows a moved folder whose files were renamed (same file inode and size)', async () => {
      const bookA = await createItem({ relPath: 'Author/Book A', ino: 100, files: [['a.mp3', 1000, 101]] })
      useFakeDisk({
        [`${ROOT}/Author2/Book A`]: { ino: 100, dir: true },
        [`${ROOT}/Author2/Book A/01 - Book A.mp3`]: { ino: 101, size: 1000 }
      })

      await LibraryScanner.scanFolderUpdates(library, folder, { 'Author2/Book A': ['01 - Book A.mp3'] })

      expect(scanLibraryItem.calledOnce).to.be.true
      expect(scanLibraryItem.firstCall.args[0]).to.equal(bookA.id)
    })

    it('picks the colliding candidate that passes the guard, not the first one', async () => {
      // Book C sits in the middle by insert order, item/book id and title, with a non-matching item on each side,
      // so a plain lookup by inode returns a wrong item first whichever index SQLite walks
      await createItem({ id: 'ffffffff-0000-4000-8000-000000000000', relPath: 'Author/Book A', ino: 100, files: [['a.mp3', 1000, 101]] })
      const bookC = await createItem({ id: '88888888-0000-4000-8000-000000000000', relPath: 'Author/Book C', ino: 100, files: [['c.mp3', 3000, 301]] })
      await createItem({ id: '00000000-0000-4000-8000-000000000000', relPath: 'Author/Book D', ino: 100, files: [['d.mp3', 4000, 401]] })
      useFakeDisk({
        [`${ROOT}/Author/Book A`]: { ino: 100, dir: true },
        [`${ROOT}/Author/Book A/a.mp3`]: { ino: 101, size: 1000 },
        [`${ROOT}/Author/Book D`]: { ino: 100, dir: true },
        [`${ROOT}/Author/Book D/d.mp3`]: { ino: 401, size: 4000 },
        [`${ROOT}/Author/Book C (Unabridged)`]: { ino: 100, dir: true },
        [`${ROOT}/Author/Book C (Unabridged)/c.mp3`]: { ino: 301, size: 3000 }
      })

      await LibraryScanner.scanFolderUpdates(library, folder, { 'Author/Book C (Unabridged)': ['c.mp3'] })

      expect(scanLibraryItem.calledOnce).to.be.true
      expect(scanLibraryItem.firstCall.args[0]).to.equal(bookC.id)
    })

    it('follows an audio file moved out of its item folder to the library root', async () => {
      const bookX = await createItem({ relPath: 'Author/Book X', ino: 400, files: [['x.m4b', 5000, 401]] })
      useFakeDisk({
        [`${ROOT}/x.m4b`]: { ino: 401, size: 5000 }
      })

      await LibraryScanner.scanFolderUpdates(library, folder, { 'x.m4b': 'x.m4b' })

      expect(scanLibraryItem.calledOnce).to.be.true
      expect(scanLibraryItem.firstCall.args[0]).to.equal(bookX.id)
      expect(scanLibraryItem.firstCall.args[1]).to.include({ path: `${ROOT}/x.m4b`, isFile: true })
    })

    it('does not attach a root file with a colliding inode to an unrelated folder item', async () => {
      await createItem({ relPath: 'Author/Book X', ino: 400, files: [['x.m4b', 5000, 401]] })
      useFakeDisk({
        [`${ROOT}/Author/Book X`]: { ino: 400, dir: true },
        [`${ROOT}/Author/Book X/x.m4b`]: { ino: 401, size: 5000 },
        [`${ROOT}/y.m4b`]: { ino: 401, size: 7000 }
      })

      await LibraryScanner.scanFolderUpdates(library, folder, { 'y.m4b': 'y.m4b' })

      expect(scanLibraryItem.called).to.be.false
      expect(scanPotentialNewLibraryItem.calledOnce).to.be.true
    })

    it('follows a single file item moved into a folder', async () => {
      const bookY = await createItem({ relPath: 'y.m4b', ino: 501, files: [['y.m4b', 6000, 501]], isFile: true })
      useFakeDisk({
        [`${ROOT}/Author/Book Y`]: { ino: 500, dir: true },
        [`${ROOT}/Author/Book Y/y.m4b`]: { ino: 501, size: 6000 }
      })

      await LibraryScanner.scanFolderUpdates(library, folder, { 'Author/Book Y': ['y.m4b'] })

      expect(scanLibraryItem.calledOnce).to.be.true
      expect(scanLibraryItem.firstCall.args[0]).to.equal(bookY.id)
    })
  })

  describe('full library scan fallback', () => {
    let rescanLibraryItemMedia
    let scanNewLibraryItem

    beforeEach(() => {
      rescanLibraryItemMedia = sinon.stub(LibraryItemScanner, 'rescanLibraryItemMedia').callsFake(async (libraryItem) => ({ libraryItem, wasUpdated: true }))
      scanNewLibraryItem = sinon.stub(LibraryItemScanner, 'scanNewLibraryItem').resolves(null)
    })

    function stubFoundItems(items) {
      sinon.stub(LibraryScanner, 'scanFolder').callsFake(async () => items.map(scanData))
    }

    it('adds a new item instead of re-pointing a deleted one that only shares inode numbers (#1447)', async () => {
      const bookA = await createItem({ relPath: 'Author/Book A', ino: 100, files: [['a.mp3', 1000, 101]] })
      useFakeDisk({ [`${ROOT}/Other/Book B`]: { ino: 100, dir: true } })
      stubFoundItems([{ relPath: 'Other/Book B', ino: 100, files: [['b.mp3', 2000, 101]] }])

      await LibraryScanner.scan(library)

      const itemA = await Database.libraryItemModel.findByPk(bookA.id)
      expect(itemA.path).to.equal(`${ROOT}/Author/Book A`)
      expect(itemA.isMissing).to.be.true
      expect(rescanLibraryItemMedia.called).to.be.false
      expect(scanNewLibraryItem.calledOnce).to.be.true
      expect(scanNewLibraryItem.firstCall.args[0].path).to.equal(`${ROOT}/Other/Book B`)
    })

    it('does not take over the folder of another existing item with a colliding inode (#4943)', async () => {
      // Book A's folder is gone; Book B on another disk has the same inode number and an identical cover file
      const bookA = await createItem({ relPath: 'Author/Book A', ino: 100, files: [['cover.jpg', 4242, 900]] })
      const bookB = await createItem({ relPath: 'Other/Book B', ino: 100, files: [['cover.jpg', 4242, 901]] })
      useFakeDisk({ [`${ROOT}/Other/Book B`]: { ino: 100, dir: true } })
      stubFoundItems([{ relPath: 'Other/Book B', ino: 100, files: [['cover.jpg', 4242, 901]] }])
      // The scan walks existing items in database order; make Book A come first so it gets the chance to take over
      const findAll = Database.libraryItemModel.findAll.bind(Database.libraryItemModel)
      const findAllStub = sinon.stub(Database.libraryItemModel, 'findAll').callsFake(async (...args) => {
        const result = await findAll(...args)
        return Array.isArray(result) ? result.sort((a, b) => (a.id === bookA.id ? -1 : b.id === bookA.id ? 1 : 0)) : result
      })

      await LibraryScanner.scan(library)
      findAllStub.restore()

      const itemA = await Database.libraryItemModel.findByPk(bookA.id)
      const itemB = await Database.libraryItemModel.findByPk(bookB.id)
      expect(itemA.path).to.equal(`${ROOT}/Author/Book A`)
      expect(itemA.isMissing).to.be.true
      expect(itemB.path).to.equal(`${ROOT}/Other/Book B`)
      expect(!!itemB.isMissing).to.be.false
      expect(scanNewLibraryItem.called).to.be.false
    })

    it('does not move an item whose old folder still exists', async () => {
      // Folder of Book A has no media left, so the scan finds nothing at its path
      const bookA = await createItem({ relPath: 'Author/Book A', ino: 100, files: [['a.mp3', 1000, 101]] })
      useFakeDisk({ [`${ROOT}/Author/Book A`]: { ino: 100, dir: true }, [`${ROOT}/Other/Book B`]: { ino: 100, dir: true } })
      stubFoundItems([{ relPath: 'Other/Book B', ino: 100, files: [['a.mp3', 1000, 101]] }])

      await LibraryScanner.scan(library)

      expect((await Database.libraryItemModel.findByPk(bookA.id)).path).to.equal(`${ROOT}/Author/Book A`)
      expect(scanNewLibraryItem.calledOnce).to.be.true
    })

    it('still follows a renamed folder', async () => {
      const bookA = await createItem({ relPath: 'Author/Book A', ino: 100, files: [['a.mp3', 1000, 101]] })
      useFakeDisk({ [`${ROOT}/Author/Book A (2001)`]: { ino: 100, dir: true } })
      stubFoundItems([{ relPath: 'Author/Book A (2001)', ino: 100, files: [['a.mp3', 1000, 101]] }])

      await LibraryScanner.scan(library)

      const itemA = await Database.libraryItemModel.findByPk(bookA.id)
      expect(itemA.path).to.equal(`${ROOT}/Author/Book A (2001)`)
      expect(!!itemA.isMissing).to.be.false
      expect(rescanLibraryItemMedia.calledOnce).to.be.true
      expect(scanNewLibraryItem.called).to.be.false
    })
  })
})
