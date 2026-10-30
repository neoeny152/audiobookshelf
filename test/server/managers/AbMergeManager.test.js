const { expect } = require('chai')
const sinon = require('sinon')
const os = require('os')
const Path = require('path')
const fs = require('fs')
const { Sequelize } = require('sequelize')

const Logger = require('../../../server/Logger')
const SocketAuthority = require('../../../server/SocketAuthority')
const Database = require('../../../server/Database')
const TaskManager = require('../../../server/managers/TaskManager')
const AbMergeManager = require('../../../server/managers/AbMergeManager')
const ffmpegHelpers = require('../../../server/utils/ffmpegHelpers')
const AudioFileScanner = require('../../../server/scanner/AudioFileScanner')
const BookScanner = require('../../../server/scanner/BookScanner')
const LibraryItemScanner = require('../../../server/scanner/LibraryItemScanner')
const AudioFile = require('../../../server/objects/files/AudioFile')
const { filePathToPOSIX } = require('../../../server/utils/fileUtils')

// #5675: after "Encode M4B" the stored audio file kept the old bitrate, codec and size, because the m4b
// overwrites the first track in place (same path and inode), which the folder watcher does not report.
describe('AbMergeManager', () => {
  let tmpDir
  let libraryDir
  let originalMetadataPath

  // The test files hold "codec bitRate duration" as text, read back by the fake prober below
  function writeAudio(path, codec, bitRate, duration) {
    fs.writeFileSync(path, `${codec} ${bitRate} ${duration} `.padEnd(64 + Math.round(bitRate / 1000), 'x'))
  }

  function fakeScan(mediaType, libraryFile) {
    const [codec, bitRate, duration] = fs.readFileSync(libraryFile.metadata.path, 'utf8').split(' ')
    return new AudioFile({
      index: 1,
      ino: libraryFile.ino,
      metadata: typeof libraryFile.metadata.toJSON === 'function' ? libraryFile.metadata.toJSON() : libraryFile.metadata,
      format: codec === 'aac' ? 'MPEG-4 Audio' : 'MP2/3 (MPEG audio layer 2/3)',
      codec,
      bitRate: Number(bitRate),
      duration: Number(duration),
      channels: 2,
      chapters: [],
      metaTags: {},
      mimeType: codec === 'aac' ? 'audio/mp4' : 'audio/mpeg'
    })
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(Path.join(os.tmpdir(), 'abs abmerge '))
    libraryDir = Path.join(tmpDir, 'library')
    fs.mkdirSync(libraryDir)
    originalMetadataPath = global.MetadataPath
    global.MetadataPath = Path.join(tmpDir, 'metadata')
    fs.mkdirSync(Path.join(global.MetadataPath, 'cache', 'items'), { recursive: true })

    sinon.stub(Logger, 'info')
    sinon.stub(Logger, 'warn')
    sinon.stub(Logger, 'error')
    sinon.stub(Logger, 'debug')
    sinon.stub(SocketAuthority, 'adminEmitter')
    sinon.stub(SocketAuthority, 'emitter')
    sinon.stub(SocketAuthority, 'libraryItemEmitter')
    sinon.stub(ffmpegHelpers, 'writeFFMetadataFile').resolves(true)
    sinon.stub(ffmpegHelpers, 'addCoverAndMetadataToFile').resolves()
    // The encode writes the new m4b to the item cache: AAC at 96 kbit/s
    sinon.stub(ffmpegHelpers, 'mergeAudioFiles').callsFake(async (tracks, duration, itemCachePath, outputFilePath) => {
      writeAudio(outputFilePath, 'aac', 96000, duration)
    })
  })

  afterEach(() => {
    sinon.restore()
    TaskManager.tasks = []
    global.MetadataPath = originalMetadataPath
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  async function runEncode(manager, libraryItem) {
    const run = sinon.spy(manager, 'runAudiobookMerge')
    await manager.startAudiobookMerge('user1', libraryItem, { codec: 'aac', bitrate: '96k', channels: '2' })
    await run.firstCall.returnValue
  }

  function stubItem({ isFile = false, trackNames = ['Book.m4b'] } = {}) {
    const itemPath = isFile ? Path.join(libraryDir, trackNames[0]) : Path.join(libraryDir, 'Book')
    if (!isFile) fs.mkdirSync(itemPath)
    const audioFiles = trackNames.map((name, i) => {
      const path = isFile ? itemPath : Path.join(itemPath, name)
      writeAudio(path, 'mp3', 128000, 100)
      return { index: i + 1, ino: `ino${i}`, duration: 100, exclude: false, metadata: { path, filename: name, ext: Path.extname(name) } }
    })
    const media = {
      title: 'Book',
      audioFiles,
      get includedAudioFiles() {
        return this.audioFiles.filter((af) => !af.exclude)
      },
      chapters: [],
      duration: audioFiles.length * 100,
      coverPath: null
    }
    return { id: 'li1', libraryId: 'lib1', path: itemPath, isFile, media }
  }

  function makeManager(overrides = {}) {
    const watcher = { addIgnoreDir: sinon.stub(), removeIgnoreDir: sinon.stub() }
    const deps = { scanItem: sinon.stub().resolves(), watcher, ...overrides }
    return { manager: new AbMergeManager(deps), deps }
  }

  describe('rescan after encode', () => {
    it('rescans the item while the watcher ignores its folder, before the task is finished', async () => {
      const { manager, deps } = makeManager()
      const libraryItem = stubItem()
      let taskFinishedAtScan = null
      deps.scanItem.callsFake(async () => {
        taskFinishedAtScan = TaskManager.tasks.length === 0
      })

      await runEncode(manager, libraryItem)

      expect(deps.scanItem.calledOnceWith('li1')).to.be.true
      expect(taskFinishedAtScan).to.equal(false)
      expect(deps.watcher.addIgnoreDir.calledOnceWith(libraryItem.path)).to.be.true
      expect(deps.watcher.removeIgnoreDir.calledOnceWith(libraryItem.path)).to.be.true
      expect(deps.watcher.addIgnoreDir.calledBefore(deps.scanItem)).to.be.true
      expect(deps.watcher.removeIgnoreDir.calledAfter(deps.scanItem)).to.be.true
      expect(TaskManager.tasks).to.have.length(0)
    })

    it('finishes the task when the rescan fails', async () => {
      const { manager, deps } = makeManager({ scanItem: sinon.stub().rejects(new Error('boom')) })
      const finished = sinon.spy(TaskManager, 'taskFinished')

      await runEncode(manager, stubItem())

      expect(finished.calledOnce).to.be.true
      expect(finished.firstCall.args[0].isFailed).to.be.false
      expect(deps.watcher.removeIgnoreDir.calledOnce).to.be.true
    })

    it('still rescans and releases the folder when moving the m4b fails', async () => {
      const { manager, deps } = makeManager()
      const fsExtra = require('../../../server/libs/fsExtra')
      sinon.stub(fsExtra, 'rename').rejects(new Error('disk full'))
      const finished = sinon.spy(TaskManager, 'taskFinished')

      await runEncode(manager, stubItem({ trackNames: ['Part 1.mp3', 'Part 2.mp3'] }))

      expect(finished.calledOnce).to.be.true
      expect(finished.firstCall.args[0].isFailed).to.be.true
      expect(deps.scanItem.calledOnce).to.be.true
      expect(deps.watcher.removeIgnoreDir.calledOnce).to.be.true
    })

    it('single-file item kept at the same path: rescans without ignoring the library folder', async () => {
      const { manager, deps } = makeManager()

      await runEncode(manager, stubItem({ isFile: true, trackNames: ['Book.m4b'] }))

      expect(deps.scanItem.calledOnceWith('li1')).to.be.true
      expect(deps.watcher.addIgnoreDir.called).to.be.false
      expect(deps.watcher.removeIgnoreDir.called).to.be.false
    })

    it('single-file item renamed to .m4b: leaves the rescan to the watcher', async () => {
      const { manager, deps } = makeManager()

      await runEncode(manager, stubItem({ isFile: true, trackNames: ['Book.mp3'] }))

      expect(deps.scanItem.called).to.be.false
      expect(deps.watcher.addIgnoreDir.called).to.be.false
      expect(fs.existsSync(Path.join(libraryDir, 'Book.m4b'))).to.be.true
    })
  })

  describe('with database and the real item scanner', () => {
    let library
    let folder
    let originalServerSettings

    beforeEach(async () => {
      global.ServerSettings = {}
      originalServerSettings = Database.serverSettings
      Database.serverSettings = { scannerFindCovers: false }
      Database.sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false })
      Database.sequelize.uppercaseFirst = (str) => (str ? `${str[0].toUpperCase()}${str.substr(1)}` : '')
      await Database.buildModels()
      library = await Database.libraryModel.create({ name: 'Test Library', mediaType: 'book', settings: {} })
      folder = await Database.libraryFolderModel.create({ path: filePathToPOSIX(libraryDir), libraryId: library.id })
      sinon.stub(AudioFileScanner, 'scan').callsFake(async (mediaType, libraryFile) => fakeScan(mediaType, libraryFile))
      sinon.stub(BookScanner, 'getBookMetadataFromScanData').resolves({ title: 'Book' })
      sinon.stub(BookScanner, 'saveMetadataFile').resolves()
    })

    afterEach(async () => {
      Database.serverSettings = originalServerSettings
      await Database.sequelize.sync({ force: true })
    })

    /**
     * Create the book in the database the way a library scan would have stored it
     *
     * @param {string[]} trackNames
     */
    async function createScannedItem(trackNames) {
      const itemPath = Path.join(libraryDir, 'Book')
      fs.mkdirSync(itemPath)
      for (const name of trackNames) writeAudio(Path.join(itemPath, name), 'mp3', 128000, 100)

      const scanData = await LibraryItemScanner.getLibraryItemScanData(filePathToPOSIX(itemPath), library, folder, false)
      const audioFiles = []
      for (const lf of scanData.audioLibraryFiles) {
        const af = (await fakeScan('book', lf)).toJSON()
        af.index = audioFiles.length + 1
        audioFiles.push(af)
      }
      const book = await Database.bookModel.create({ title: 'Book', audioFiles, duration: 100 * audioFiles.length, tags: [], narrators: [], genres: [], chapters: [] })
      const item = await Database.libraryItemModel.create({
        ino: scanData.ino,
        path: scanData.path,
        relPath: scanData.relPath,
        mtime: scanData.mtimeMs,
        ctime: scanData.ctimeMs,
        birthtime: scanData.birthtimeMs,
        isFile: false,
        libraryFiles: scanData.libraryFiles.map((lf) => lf.toJSON()),
        mediaId: book.id,
        mediaType: 'book',
        libraryId: library.id,
        libraryFolderId: folder.id
      })
      return Database.libraryItemModel.getExpandedById(item.id)
    }

    async function encodeWithRealScanner(libraryItem) {
      const watcher = { addIgnoreDir: sinon.stub(), removeIgnoreDir: sinon.stub() }
      const manager = new AbMergeManager({ watcher })
      await runEncode(manager, libraryItem)
      return Database.libraryItemModel.getExpandedById(libraryItem.id)
    }

    function emittedItem(id) {
      const call = SocketAuthority.libraryItemEmitter.getCalls().find((c) => c.args[0] === 'item_updated' && c.args[1].id === id)
      return call?.args[1]
    }

    it('m4b re-encoded at a lower bitrate: stores the new bitrate and emits the item update', async () => {
      const libraryItem = await createScannedItem(['Book.m4b'])
      expect(libraryItem.media.audioFiles[0].bitRate).to.equal(128000)
      const ino = libraryItem.media.audioFiles[0].ino

      const updated = await encodeWithRealScanner(libraryItem)

      const [audioFile] = updated.media.audioFiles
      expect(updated.media.audioFiles).to.have.length(1)
      expect(audioFile.ino).to.equal(ino)
      expect(audioFile.bitRate).to.equal(96000)
      expect(audioFile.codec).to.equal('aac')
      expect(audioFile.metadata.size).to.equal(fs.statSync(audioFile.metadata.path).size)
      expect(updated.libraryFiles.find((lf) => lf.ino === ino).metadata.size).to.equal(audioFile.metadata.size)

      const emitted = emittedItem(libraryItem.id)
      expect(emitted, 'item_updated emitted').to.exist
      expect(emitted.media.audioFiles[0].bitRate).to.equal(96000)
    })

    it('several mp3 tracks merged: the item holds one m4b with the new values', async () => {
      const libraryItem = await createScannedItem(['Part 1.mp3', 'Part 2.mp3'])

      const updated = await encodeWithRealScanner(libraryItem)

      expect(updated.media.audioFiles).to.have.length(1)
      const [audioFile] = updated.media.audioFiles
      expect(audioFile.metadata.filename).to.equal('Book.m4b')
      expect(audioFile.bitRate).to.equal(96000)
      expect(audioFile.codec).to.equal('aac')
      expect(updated.libraryFiles.map((lf) => lf.metadata.filename)).to.deep.equal(['Book.m4b'])
      expect(emittedItem(libraryItem.id)).to.exist
    })
  })
})
