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
  let backupsDir
  let paths

  beforeEach(() => {
    dir = fs.mkdtempSync(Path.join(os.tmpdir(), 'abs seekmgr '))
    backupsDir = fs.mkdtempSync(Path.join(os.tmpdir(), 'abs seekbak '))
    paths = ['Part 1.mp3', 'Part 2.mp3', 'Part 3.m4b'].map((f) => {
      const p = Path.join(dir, f)
      fs.writeFileSync(p, `audio of ${f}`)
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
    fs.rmSync(backupsDir, { recursive: true, force: true })
  })

  /** An MP3 without a header whose measured duration is `real` (stored `duration`); real null = not measured yet */
  function audioFile(i, { codec = 'mp3', mp3SeekIndex = 'none', duration = 100, real = duration + 10 } = {}) {
    const metadata = { path: paths[i], filename: Path.basename(paths[i]), ext: Path.extname(paths[i]), size: 1000 + i, mtimeMs: 1 }
    const mp3Measured = mp3SeekIndex === 'none' && real !== null ? { duration: real, size: metadata.size, mtimeMs: 1 } : null
    return { index: i + 1, ino: `ino${i}`, codec, mp3SeekIndex, mp3Measured, duration, exclude: false, metadata }
  }

  function item({ audioFiles, chapters = [], id = 'li1' }) {
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
    return { id, libraryId: 'lib1', path: dir, isFile: false, media }
  }

  function makeManager(overrides = {}) {
    const watcher = { addIgnoreDir: sinon.stub(), removeIgnoreDir: sinon.stub() }
    const deps = {
      backupsDir,
      // Like the real one: the original is copied to backupPath before the file is replaced
      repairFile: sinon.stub().callsFake(async (path, { backupPath }) => {
        fs.mkdirSync(Path.dirname(backupPath), { recursive: true })
        fs.copyFileSync(path, backupPath)
        fs.writeFileSync(path, `repaired ${Path.basename(path)}`)
      }),
      restoreFile: sinon.stub().callsFake(async (backupPath, path) => fs.copyFileSync(backupPath, path)),
      detectSeekIndex: sinon.stub().resolves({ status: 'none' }),
      measureDuration: sinon.stub().resolves({ duration: 117.4 }),
      scanItem: sinon.stub().resolves(),
      getItem: sinon.stub(),
      applyChapters: sinon.stub().resolves({ updated: true }),
      now: () => Date.parse('2026-10-30T15:40:12Z'),
      watcher,
      ...overrides
    }
    return { manager: new Mp3SeekIndexManager(deps), deps }
  }

  async function waitForFinish() {
    for (let i = 0; i < 200; i++) {
      if (TaskManager.tasks.length === 0) return
      await new Promise((r) => setTimeout(r, 5))
    }
  }

  describe('getStatus', () => {
    it('checks and measures included MP3s once, flags only those that drift more than 1 s', async () => {
      const li = item({
        audioFiles: [audioFile(0, { mp3SeekIndex: null, real: null }), audioFile(1, { real: null }), audioFile(2, { codec: 'aac', mp3SeekIndex: null })]
      })
      const { manager, deps } = makeManager()
      deps.detectSeekIndex.withArgs(paths[0]).resolves({ status: 'none' })
      deps.measureDuration.withArgs(paths[0]).resolves({ duration: 117.4 }) // +17.4 s
      deps.measureDuration.withArgs(paths[1]).resolves({ duration: 100.2 }) // CBR: estimate right

      const status = await manager.getStatus(li)
      expect(deps.detectSeekIndex.calledOnceWith(paths[0])).to.be.true
      expect(deps.measureDuration.callCount).to.equal(2)
      expect(status.needsRepairCount).to.equal(1)
      expect(status.maxDrift).to.be.closeTo(17.4, 0.001)
      expect(status.files.map((f) => [f.filename, f.needsRepair, f.durationError])).to.deep.equal([
        ['Part 1.mp3', true, 17.4],
        ['Part 2.mp3', false, 0.2]
      ])
      expect(li.media.save.calledOnce).to.be.true
      expect(li.media.audioFiles[0].mp3Measured).to.deep.equal({ duration: 117.4, size: 1000, mtimeMs: 1 })

      // Stored: a second call reads nothing
      await manager.getStatus(li)
      expect(deps.measureDuration.callCount).to.equal(2)
      expect(li.media.save.calledOnce).to.be.true
    })

    it('measures again after the file changed', async () => {
      const af = audioFile(0)
      af.metadata.mtimeMs = 2
      const li = item({ audioFiles: [af] })
      const { manager, deps } = makeManager()
      await manager.getStatus(li)
      expect(deps.measureDuration.calledOnce).to.be.true
    })

    it('checks the header again when a measured file changed (a repair cut short before its rescan)', async () => {
      const af = audioFile(0)
      af.metadata.mtimeMs = 2
      const li = item({ audioFiles: [af] })
      const { manager, deps } = makeManager()
      deps.detectSeekIndex.resolves({ status: 'xing' })
      const status = await manager.getStatus(li)
      expect(deps.detectSeekIndex.calledOnce).to.be.true
      expect(deps.measureDuration.called).to.be.false
      expect(status.needsRepairCount).to.equal(0)
      expect(li.media.audioFiles[0].mp3SeekIndex).to.equal('xing')
    })

    it('shares one run between concurrent calls', async () => {
      const li = item({ audioFiles: [audioFile(0, { real: null })] })
      const { manager, deps } = makeManager()
      await Promise.all([manager.getStatus(li), manager.getStatus(li)])
      expect(deps.measureDuration.calledOnce).to.be.true
    })
  })

  describe('repair', () => {
    it('returns null when no file needs repair', () => {
      const { manager } = makeManager()
      expect(manager.startRepair('u1', item({ audioFiles: [audioFile(0, { mp3SeekIndex: 'xing' }), audioFile(1, { real: 100.3 })] }))).to.be.null
    })

    it('repairs only drifting MP3s, keeps the originals outside the library, reports old vs new; chapter times kept', async () => {
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
      const backupPath = deps.repairFile.firstCall.args[1].backupPath
      expect(backupPath).to.equal(Path.join(backupsDir, 'li1', '20261030T154012Z', 'files', 'Part 1.mp3'))
      expect(fs.readFileSync(backupPath, 'utf8')).to.equal('audio of Part 1.mp3')
      expect(deps.watcher.addIgnoreDir.calledWith(dir)).to.be.true
      expect(deps.watcher.removeIgnoreDir.calledWith(dir)).to.be.true
      expect(deps.scanItem.calledOnceWith('li1')).to.be.true
      // Times kept; only the last chapter, which ran to the old end, now runs to the new end
      expect(deps.applyChapters.firstCall.args[1]).to.deep.equal([
        { id: 0, start: 0, end: 150, title: 'A' },
        { id: 1, start: 150, end: 310, title: 'B' }
      ])

      const done = finished.firstCall.args[0]
      expect(done.isFailed).to.be.false
      const result = done.data.result
      expect(result.files).to.deep.equal([{ filename: 'Part 1.mp3', ino: 'ino0', status: 'repaired', oldDuration: 100, newDuration: 110 }])
      expect(result).to.include({ type: 'repair', oldTotalDuration: 300, newTotalDuration: 310, backupId: '20261030T154012Z' })
      expect(result.chapters).to.deep.equal({ count: 2, mode: 'keep', shifted: false, endExtended: true, restored: false, maxShift: 10 })
      expect(done.toJSON().data).to.not.have.any.keys('oldChapters', 'oldIncluded')
      expect(manager.snapshots.size).to.equal(0)

      const backups = await manager.listBackups('li1')
      expect(backups).to.have.length(1)
      expect(backups[0]).to.include({ id: '20261030T154012Z', libraryItemId: 'li1', size: 1000 })
      expect(backups[0].files).to.deep.equal([{ relPath: 'Part 1.mp3', filename: 'Part 1.mp3', size: 1000, oldDuration: 100, newDuration: 110 }])
      expect(backups[0].chaptersBefore).to.deep.equal(chapters)
      expect(await manager.getBackupsTotalSize()).to.equal(1000)
    })

    it('leaves chapters alone in keep mode when the last one does not run to the end', async () => {
      const chapters = [
        { id: 0, start: 0, end: 150, title: 'A' },
        { id: 1, start: 150, end: 250, title: 'B' }
      ]
      const li = item({ audioFiles: [audioFile(0, { duration: 100 }), audioFile(1, { mp3SeekIndex: 'xing', duration: 200 })], chapters })
      const fresh = item({ audioFiles: [audioFile(0, { duration: 110 }), audioFile(1, { mp3SeekIndex: 'xing', duration: 200 })], chapters })
      const { manager, deps } = makeManager()
      deps.getItem.resolves(fresh)
      const finished = sinon.spy(TaskManager, 'taskFinished')

      manager.startRepair('u1', li)
      await waitForFinish()
      expect(deps.applyChapters.called).to.be.false
      expect(finished.firstCall.args[0].data.result.chapters).to.include({ shifted: false, endExtended: false })
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
      expect((await manager.listBackups('li1'))[0].files.map((f) => f.filename)).to.deep.equal(['Part 2.mp3'])
    })

    it('writes the backup manifest before the first file and after each one', async () => {
      const li = item({ audioFiles: [audioFile(0), audioFile(1)] })
      const { manager, deps } = makeManager()
      const seen = []
      const real = deps.repairFile
      deps.repairFile = sinon.stub().callsFake(async (path, opts) => {
        seen.push((await manager.listBackups('li1', { includeIncomplete: true }))[0])
        return real(path, opts)
      })
      manager.repairFile = deps.repairFile
      deps.getItem.resolves(li)
      manager.startRepair('u1', li)
      await waitForFinish()
      expect(seen.map((m) => [m.complete, m.files.length])).to.deep.equal([
        [false, 0],
        [false, 1]
      ])
      expect(seen[0].oldIncluded).to.have.length(2)
      const done = (await manager.listBackups('li1'))[0]
      expect(done.complete).to.be.true
      expect(done.files).to.have.length(2)
    })

    it('keeps no backup when nothing was repaired', async () => {
      const li = item({ audioFiles: [audioFile(0)] })
      const { manager, deps } = makeManager()
      deps.repairFile.rejects(new Error('Remux failed'))
      manager.startRepair('u1', li)
      await waitForFinish()
      expect(await manager.listBackups('li1')).to.deep.equal([])
      expect(deps.scanItem.called).to.be.false
    })

    it('queues a second item until the first finishes', async () => {
      const { manager, deps } = makeManager()
      let release
      deps.repairFile.onFirstCall().returns(new Promise((r) => (release = r)))
      const a = item({ audioFiles: [audioFile(0)] })
      const b = item({ audioFiles: [audioFile(1)], id: 'li2' })
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

  describe('recoverInterrupted', () => {
    it('finishes a repair cut short: removes temp files, rescans, applies the chapter step, completes the backup', async () => {
      const { manager, deps } = makeManager()
      const chapters = [
        { id: 0, start: 0, end: 150, title: 'A' },
        { id: 1, start: 150, end: 300, title: 'B' }
      ]
      // Cut short after Part 1: its original is backed up, Part 2's temp file is left in the item folder
      const backupDir = Path.join(backupsDir, 'li1', '20261030T152419Z')
      fs.mkdirSync(Path.join(backupDir, 'files'), { recursive: true })
      fs.writeFileSync(Path.join(backupDir, 'files', 'Part 1.mp3'), 'x'.repeat(1000))
      fs.writeFileSync(
        Path.join(backupDir, 'backup.json'),
        JSON.stringify({
          id: '20261030T152419Z',
          libraryItemId: 'li1',
          title: 'Red Rising',
          createdAt: 1,
          complete: false,
          mode: 'shift',
          oldIncluded: [
            { path: paths[0], duration: 100 },
            { path: paths[1], duration: 200 }
          ],
          files: [{ relPath: 'Part 1.mp3', filename: 'Part 1.mp3', size: 1000, oldDuration: 100, newDuration: null }],
          size: 1000,
          chaptersBefore: chapters,
          chaptersAfter: null
        })
      )
      const temp = Path.join(dir, '.Part 2.mp3.seekfix.tmp')
      fs.writeFileSync(temp, 'partial')
      const fresh = item({ audioFiles: [audioFile(0, { mp3SeekIndex: 'xing', duration: 110 }), audioFile(1, { duration: 200 })], chapters })
      deps.getItem.resolves(fresh)

      await manager.recoverInterrupted()

      expect(fs.existsSync(temp)).to.be.false
      expect(fs.existsSync(paths[1])).to.be.true
      expect(deps.scanItem.calledOnceWith('li1')).to.be.true
      expect(deps.applyChapters.firstCall.args[1]).to.deep.equal([
        { id: 0, start: 0, end: 160, title: 'A' },
        { id: 1, start: 160, end: 310, title: 'B' }
      ])
      const [backup] = await manager.listBackups('li1')
      expect(backup).to.include({ complete: true, interrupted: true })
      expect(backup.files).to.deep.equal([{ relPath: 'Part 1.mp3', filename: 'Part 1.mp3', size: 1000, oldDuration: 100, newDuration: 110 }])
    })

    it('rebuilds a missing manifest from the files on disk, and drops an empty backup', async () => {
      const { manager, deps } = makeManager()
      const withFiles = Path.join(backupsDir, 'li1', '20261030T152419Z', 'files')
      fs.mkdirSync(withFiles, { recursive: true })
      fs.writeFileSync(Path.join(withFiles, 'Part 1.mp3'), 'x'.repeat(10))
      fs.mkdirSync(Path.join(backupsDir, 'li1', '20261030T160000Z', 'files'), { recursive: true })
      deps.getItem.resolves(item({ audioFiles: [audioFile(0, { mp3SeekIndex: 'xing', duration: 110 })] }))

      await manager.recoverInterrupted()

      const backups = await manager.listBackups('li1')
      expect(backups.map((b) => b.id)).to.deep.equal(['20261030T152419Z'])
      expect(backups[0].files).to.deep.equal([{ relPath: 'Part 1.mp3', filename: 'Part 1.mp3', size: 10, oldDuration: null, newDuration: 110 }])
      expect(deps.applyChapters.called).to.be.false
    })

    it('leaves finished backups alone', async () => {
      const { manager, deps } = makeManager()
      const dirDone = Path.join(backupsDir, 'li1', '20261030T152419Z')
      fs.mkdirSync(Path.join(dirDone, 'files'), { recursive: true })
      fs.writeFileSync(Path.join(dirDone, 'backup.json'), JSON.stringify({ id: '20261030T152419Z', libraryItemId: 'li1', complete: true, files: [], createdAt: 1 }))
      await manager.recoverInterrupted()
      expect(deps.scanItem.called).to.be.false
    })
  })

  describe('restore and delete', () => {
    const before = [
      { id: 0, start: 0, end: 50, title: 'A' },
      { id: 1, start: 50, end: 100, title: 'B' }
    ]
    const after = [
      { id: 0, start: 0, end: 60, title: 'A' },
      { id: 1, start: 60, end: 110, title: 'B' }
    ]

    async function repairOnce(manager, deps) {
      const li = item({ audioFiles: [audioFile(0, { duration: 100 })], chapters: before })
      deps.getItem.resolves(item({ audioFiles: [audioFile(0, { mp3SeekIndex: 'xing', duration: 110 })], chapters: after }))
      manager.startRepair('u1', li, { chapters: 'shift' })
      await waitForFinish()
      return (await manager.listBackups('li1'))[0]
    }

    it('puts the originals back, puts the chapters from before back and deletes the backup', async () => {
      const { manager, deps } = makeManager()
      const manifest = await repairOnce(manager, deps)
      expect(manifest.chaptersAfter).to.deep.equal(after)
      expect(fs.readFileSync(paths[0], 'utf8')).to.equal('repaired Part 1.mp3')

      const repaired = item({ audioFiles: [audioFile(0, { mp3SeekIndex: 'xing', duration: 110 })], chapters: after })
      const restored = item({ audioFiles: [audioFile(0, { duration: 100 })], chapters: after })
      deps.getItem.resolves(restored)
      deps.applyChapters.resetHistory()
      const finished = sinon.spy(TaskManager, 'taskFinished')

      manager.startRestore('u1', repaired, manifest)
      await waitForFinish()

      expect(fs.readFileSync(paths[0], 'utf8')).to.equal('audio of Part 1.mp3')
      expect(deps.restoreFile.calledOnceWith(Path.join(backupsDir, 'li1', manifest.id, 'files', 'Part 1.mp3'), paths[0])).to.be.true
      expect(deps.applyChapters.calledOnceWith(restored, before)).to.be.true
      const done = finished.firstCall.args[0]
      expect(done.isFailed).to.be.false
      expect(done.data.result).to.include({ type: 'restore', oldTotalDuration: 110, newTotalDuration: 100 })
      expect(done.data.result.chapters.restored).to.be.true
      expect(await manager.listBackups('li1')).to.deep.equal([])
      expect(fs.existsSync(Path.join(backupsDir, 'li1'))).to.be.false
    })

    it('leaves chapters edited after the repair as they are', async () => {
      const { manager, deps } = makeManager()
      const manifest = await repairOnce(manager, deps)
      const edited = [{ id: 0, start: 0, end: 110, title: 'Edited' }]
      const repaired = item({ audioFiles: [audioFile(0, { mp3SeekIndex: 'xing', duration: 110 })], chapters: edited })
      deps.getItem.resolves(item({ audioFiles: [audioFile(0, { duration: 100 })], chapters: edited }))
      deps.applyChapters.resetHistory()
      manager.startRestore('u1', repaired, manifest)
      await waitForFinish()
      expect(deps.applyChapters.called).to.be.false
    })

    it('keeps the backup when a file could not be put back', async () => {
      const { manager, deps } = makeManager()
      const manifest = await repairOnce(manager, deps)
      deps.restoreFile.rejects(new Error('disk full'))
      const finished = sinon.spy(TaskManager, 'taskFinished')
      manager.startRestore('u1', item({ audioFiles: [audioFile(0, { mp3SeekIndex: 'xing', duration: 110 })], chapters: after }), manifest)
      await waitForFinish()
      expect(finished.firstCall.args[0].errorKey).to.equal('MessageTaskRestoreSeekIndexFailed')
      expect(await manager.listBackups('li1')).to.have.length(1)
    })

    it('deletes a backup, and refuses ids that are not backup ids', async () => {
      const { manager, deps } = makeManager()
      const manifest = await repairOnce(manager, deps)
      expect(await manager.deleteBackup('li1', '../../etc')).to.be.false
      expect(await manager.deleteBackup('li1', '20200101T000000Z')).to.be.false
      expect(await manager.deleteBackup('li1', manifest.id)).to.be.true
      expect(await manager.listBackups('li1')).to.deep.equal([])
      expect(await manager.getBackupsTotalSize()).to.equal(0)
    })
  })
})
