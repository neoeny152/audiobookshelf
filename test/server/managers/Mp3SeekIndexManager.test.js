const { expect } = require('chai')
const sinon = require('sinon')
const os = require('os')
const Path = require('path')
const fs = require('fs')

const Logger = require('../../../server/Logger')
const SocketAuthority = require('../../../server/SocketAuthority')
const TaskManager = require('../../../server/managers/TaskManager')
const Database = require('../../../server/Database')
const Mp3SeekIndexManager = require('../../../server/managers/Mp3SeekIndexManager')

describe('Mp3SeekIndexManager', () => {
  let dir
  let paths

  beforeEach(() => {
    dir = fs.mkdtempSync(Path.join(os.tmpdir(), 'abs seekmgr '))
    paths = ['Part 1.mp3', 'Part 2.mp3', 'Part 3.m4b'].map((f) => {
      const p = Path.join(dir, f)
      fs.writeFileSync(p, 'x')
      return p
    })
    sinon.stub(Logger, 'info')
    sinon.stub(Logger, 'warn')
    sinon.stub(Logger, 'error')
    sinon.stub(SocketAuthority, 'adminEmitter')
    sinon.stub(SocketAuthority, 'emitter')
    Database.resetLibraryIssuesFilterData = sinon.stub().resolves()
  })

  afterEach(() => {
    sinon.restore()
    delete Database.resetLibraryIssuesFilterData
    TaskManager.tasks = []
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function audioFile(i, { codec = 'mp3', mp3SeekIndex = 'none', duration = 100 } = {}) {
    return { index: i + 1, ino: `ino${i}`, codec, mp3SeekIndex, duration, exclude: false, metadata: { path: paths[i], filename: Path.basename(paths[i]), ext: Path.extname(paths[i]), size: 1, mtimeMs: 1 } }
  }

  function item({ audioFiles, chapters = [] }) {
    const media = {
      title: 'Red Rising',
      audioFiles,
      get includedAudioFiles() {
        return this.audioFiles.filter((af) => !af.exclude)
      },
      chapters,
      changed: sinon.stub(),
      save: sinon.stub().resolves()
    }
    return { id: 'li1', libraryId: 'lib1', path: dir, isFile: false, media }
  }

  function makeManager(overrides = {}) {
    const watcher = { addIgnoreDir: sinon.stub(), removeIgnoreDir: sinon.stub() }
    const deps = {
      repairFile: sinon.stub().resolves({}),
      detectSeekIndex: sinon.stub().resolves({ status: 'none' }),
      measureDuration: sinon.stub().resolves({ duration: 117.4 }),
      scanItem: sinon.stub().resolves(),
      getItem: sinon.stub(),
      applyChapters: sinon.stub().resolves({ updated: true }),
      watcher,
      ...overrides
    }
    return { manager: new Mp3SeekIndexManager(deps), deps }
  }

  async function waitForFinish() {
    for (let i = 0; i < 100; i++) {
      const finished = TaskManager.tasks.length === 0
      if (finished) return
      await new Promise((r) => setTimeout(r, 5))
    }
  }

  describe('getStatus', () => {
    it('checks included MP3s only, stores the result and measures on request', async () => {
      const li = item({ audioFiles: [audioFile(0, { mp3SeekIndex: null }), audioFile(1, { mp3SeekIndex: 'none' }), audioFile(2, { codec: 'aac', mp3SeekIndex: null })] })
      const { manager, deps } = makeManager()
      deps.detectSeekIndex.withArgs(paths[0]).resolves({ status: 'xing' })

      const status = await manager.getStatus(li, { measure: true })
      expect(deps.detectSeekIndex.callCount).to.equal(2)
      expect(status.needsRepairCount).to.equal(1)
      expect(status.files.map((f) => [f.filename, f.mp3SeekIndex, f.needsRepair])).to.deep.equal([
        ['Part 1.mp3', 'xing', false],
        ['Part 2.mp3', 'none', true]
      ])
      expect(status.files[1]).to.include({ measuredDuration: 117.4, durationError: 17.4 })
      expect(deps.measureDuration.calledOnceWith(paths[1])).to.be.true
      // Part 1 changed null -> xing, so the audio files were saved
      expect(li.media.save.calledOnce).to.be.true
      expect(li.media.audioFiles[0].mp3SeekIndex).to.equal('xing')
    })

    it('does not save when nothing changed and caches measurements', async () => {
      const li = item({ audioFiles: [audioFile(0)] })
      const { manager, deps } = makeManager()
      await manager.getStatus(li, { measure: true })
      await manager.getStatus(li, { measure: true })
      expect(li.media.save.called).to.be.false
      expect(deps.measureDuration.calledOnce).to.be.true
    })
  })

  describe('repair', () => {
    it('returns null when no file needs repair', () => {
      const { manager } = makeManager()
      expect(manager.startRepair('u1', item({ audioFiles: [audioFile(0, { mp3SeekIndex: 'xing' })] }))).to.be.null
    })

    it('repairs only flagged MP3s, rescans and reports old vs new durations; chapters kept by default', async () => {
      const chapters = [
        { id: 0, start: 0, end: 150, title: 'A' },
        { id: 1, start: 150, end: 300, title: 'B' }
      ]
      const li = item({ audioFiles: [audioFile(0, { duration: 100 }), audioFile(1, { mp3SeekIndex: 'info', duration: 100 }), audioFile(2, { codec: 'aac', mp3SeekIndex: null, duration: 100 })], chapters })
      const fresh = item({ audioFiles: [audioFile(0, { mp3SeekIndex: 'xing', duration: 110 }), audioFile(1, { mp3SeekIndex: 'info', duration: 100 }), audioFile(2, { codec: 'aac', duration: 100 })], chapters })
      const { manager, deps } = makeManager()
      deps.getItem.resolves(fresh)
      const finished = sinon.spy(TaskManager, 'taskFinished')

      const task = manager.startRepair('u1', li)
      expect(task.data.audioFiles.map((af) => af.filename)).to.deep.equal(['Part 1.mp3'])
      await waitForFinish()

      expect(deps.repairFile.calledOnce).to.be.true
      expect(deps.repairFile.firstCall.args[0]).to.equal(paths[0])
      expect(deps.watcher.addIgnoreDir.calledWith(dir)).to.be.true
      expect(deps.watcher.removeIgnoreDir.calledWith(dir)).to.be.true
      expect(deps.scanItem.calledOnceWith('li1')).to.be.true
      expect(deps.applyChapters.called).to.be.false

      const done = finished.firstCall.args[0]
      expect(done.isFailed).to.be.false
      expect(done.data.result.files).to.deep.equal([{ filename: 'Part 1.mp3', ino: 'ino0', status: 'repaired', oldDuration: 100, newDuration: 110 }])
      expect(done.data.result).to.include({ oldTotalDuration: 300, newTotalDuration: 310 })
      expect(done.data.result.chapters).to.deep.equal({ count: 2, mode: 'keep', shifted: false, maxShift: 10 })
      expect(manager.getIsLibraryItemQueuedOrProcessing('li1')).to.be.false
      expect(manager.lastResults.get('li1')).to.equal(done.data.result)
    })

    it('shifts saved chapters when asked', async () => {
      const chapters = [
        { id: 0, start: 0, end: 150, title: 'A' },
        { id: 1, start: 150, end: 300, title: 'B' }
      ]
      const li = item({ audioFiles: [audioFile(0, { duration: 100 }), audioFile(1, { duration: 200 })], chapters })
      const fresh = item({ audioFiles: [audioFile(0, { duration: 110 }), audioFile(1, { duration: 205 })], chapters })
      const { manager, deps } = makeManager()
      deps.getItem.resolves(fresh)

      manager.startRepair('u1', li, { chapters: 'shift' })
      await waitForFinish()

      expect(deps.repairFile.callCount).to.equal(2)
      expect(deps.applyChapters.calledOnce).to.be.true
      const [target, shifted] = deps.applyChapters.firstCall.args
      expect(target).to.equal(fresh)
      expect(shifted).to.deep.equal([
        { id: 0, start: 0, end: 160, title: 'A' },
        { id: 1, start: 160, end: 315, title: 'B' }
      ])
    })

    it('keeps going after a failed file, fails the task and still rescans for the repaired ones', async () => {
      const li = item({ audioFiles: [audioFile(0), audioFile(1)] })
      const { manager, deps } = makeManager()
      deps.repairFile.onFirstCall().rejects(new Error('Verification failed: Audio frame count changed (10 -> 9)'))
      deps.getItem.resolves(li)
      const finished = sinon.spy(TaskManager, 'taskFinished')

      manager.startRepair('u1', li)
      await waitForFinish()

      expect(deps.repairFile.callCount).to.equal(2)
      expect(deps.scanItem.calledOnce).to.be.true
      const done = finished.firstCall.args[0]
      expect(done.isFailed).to.be.true
      expect(done.errorKey).to.equal('MessageTaskRepairSeekIndexFailed')
      expect(done.data.result.files.map((f) => f.status)).to.deep.equal(['failed', 'repaired'])
    })

    it('queues a second item until the first finishes', async () => {
      const { manager, deps } = makeManager()
      let release
      deps.repairFile.onFirstCall().returns(new Promise((r) => (release = r)))
      const a = item({ audioFiles: [audioFile(0)] })
      const b = { ...item({ audioFiles: [audioFile(1)] }), id: 'li2' }
      deps.getItem.resolves(a)
      manager.startRepair('u1', a)
      manager.startRepair('u1', b)
      expect(manager.tasksQueued.length).to.equal(1)
      expect(manager.getIsLibraryItemQueuedOrProcessing('li2')).to.be.true
      release({})
      await waitForFinish()
      await waitForFinish()
      expect(deps.repairFile.callCount).to.equal(2)
    })
  })
})
