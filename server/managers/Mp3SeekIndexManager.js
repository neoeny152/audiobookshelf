const Path = require('path')
const SocketAuthority = require('../SocketAuthority')
const Logger = require('../Logger')
const Database = require('../Database')
const fs = require('../libs/fsExtra')
const TaskManager = require('./TaskManager')
const Task = require('../objects/Task')
const fileUtils = require('../utils/fileUtils')
const mp3SeekIndex = require('../utils/mp3SeekIndex')
const { applyChapters } = require('../utils/applyChapters')

/**
 * @typedef SeekIndexFileStatus
 * @property {number} index
 * @property {string} ino
 * @property {string} filename
 * @property {number} duration - stored (probed) duration
 * @property {import('../utils/mp3SeekIndex').Mp3SeekIndexStatus|null} mp3SeekIndex
 * @property {boolean} needsRepair - no seek header and the measured duration is off by more than DRIFT_THRESHOLD_SEC
 * @property {number} [measuredDuration] - frame count duration (files without a seek header)
 * @property {number} [durationError] - measuredDuration - duration
 *
 * @typedef FileResult
 * @property {string} filename
 * @property {string} ino
 * @property {'repaired'|'restored'|'failed'} status
 * @property {number} oldDuration
 * @property {number|null} newDuration - after the rescan
 * @property {string} [error]
 *
 * @typedef RepairResult
 * @property {'repair'|'restore'} type
 * @property {string} libraryItemId
 * @property {number} finishedAt
 * @property {FileResult[]} files
 * @property {number} oldTotalDuration
 * @property {number} newTotalDuration
 * @property {{count: number, mode: 'keep'|'shift', shifted: boolean, endExtended: boolean, restored: boolean, maxShift: number}} chapters
 *  repair: shifted = times moved with the files (mode shift); endExtended = mode keep, only the last end moved to the new total.
 *  restore: restored = saved chapters put back as they were before the repair (only when unchanged since).
 * @property {string|null} [backupId] - repair: the backup holding the originals
 *
 * @typedef BackupFile
 * @property {string} relPath - path inside the item folder (and inside the backup's files/ folder)
 * @property {string} filename
 * @property {number} size
 * @property {number} oldDuration
 * @property {number|null} newDuration
 *
 * @typedef BackupManifest
 * @property {string} id
 * @property {string} libraryItemId
 * @property {string} title
 * @property {number} createdAt
 * @property {BackupFile[]} files
 * @property {number} size - bytes
 * @property {Object[]} chaptersBefore - saved chapters before the repair
 * @property {Object[]} chaptersAfter - saved chapters after the repair
 *
 * @typedef RepairOptions
 * @property {'keep'|'shift'} [chapters='keep'] - shift: move saved chapter times by the duration change of earlier files
 */

const BACKUP_ID_RE = /^[0-9]{8}T[0-9]{6}Z(-[0-9]+)?$/
const MANIFEST = 'backup.json'

class Mp3SeekIndexManager {
  /**
   * @param {Object} [deps] - injectable for tests
   */
  constructor(deps = {}) {
    /** Originals are kept here, outside every library folder, so the scanner never sees them */
    this.backupsDir = deps.backupsDir || Path.join(global.MetadataPath || '', 'seek-repair-backups')
    this.MAX_CONCURRENT_TASKS = 1
    /** @type {Task[]} */
    this.tasksRunning = []
    /** @type {Task[]} */
    this.tasksQueued = []
    /** @type {Map<string, AbortController>} */
    this.abortControllers = new Map()
    /** @type {Map<string, RepairResult>} last result per library item (until restart) */
    this.lastResults = new Map()
    /** @type {Map<string, Promise>} status checks in flight per library item */
    this.statusInFlight = new Map()
    /** @type {Map<string, {oldIncluded: {path:string, duration:number}[], oldChapters: Object[]}>} per task id; kept out of task.data, which is broadcast */
    this.snapshots = new Map()

    this.repairFile = deps.repairFile || mp3SeekIndex.repairFile
    this.restoreFile = deps.restoreFile || mp3SeekIndex.restoreFile
    this.detectSeekIndex = deps.detectSeekIndex || mp3SeekIndex.detectSeekIndex
    this.measureDuration = deps.measureDuration || mp3SeekIndex.measureDuration
    this.scanItem = deps.scanItem || ((libraryItemId) => require('../scanner/LibraryItemScanner').scanLibraryItem(libraryItemId))
    this.getItem = deps.getItem || ((libraryItemId) => Database.libraryItemModel.getExpandedById(libraryItemId))
    this.applyChapters = deps.applyChapters || applyChapters
    this.watcher = deps.watcher || null
    this.now = deps.now || Date.now
  }

  getWatcher() {
    return this.watcher || require('../Watcher')
  }

  getIsLibraryItemQueuedOrProcessing(libraryItemId) {
    return this.tasksQueued.some((t) => t.data.libraryItemId === libraryItemId) || this.tasksRunning.some((t) => t.data.libraryItemId === libraryItemId)
  }

  /**
   * Seek index status of a book's included MP3s, with its backups. Files without a stored header check get one
   * (~64 KB read); files without a header and no measurement for their current size/mtime are measured (frame walk,
   * reads the file). Both are stored on the audio file, so later calls only read the database.
   * Concurrent calls for one item share the same run.
   *
   * @param {import('../models/LibraryItem')} libraryItem - expanded book item
   * @returns {Promise<{files: SeekIndexFileStatus[], needsRepairCount: number, maxDrift: number, processing: boolean, lastResult: RepairResult|null, backups: BackupManifest[], backupsTotalSize: number}>}
   */
  async getStatus(libraryItem) {
    const inFlight = this.statusInFlight.get(libraryItem.id)
    if (inFlight) return inFlight
    const promise = this.computeStatus(libraryItem).finally(() => this.statusInFlight.delete(libraryItem.id))
    this.statusInFlight.set(libraryItem.id, promise)
    return promise
  }

  async computeStatus(libraryItem) {
    const media = libraryItem.media
    const files = []
    let changed = false
    const audioFiles = (media.audioFiles || []).map((af) => ({ ...af }))

    for (const af of audioFiles) {
      if (af.exclude || !mp3SeekIndex.isMp3AudioFile(af)) continue
      try {
        if (!af.mp3SeekIndex) {
          af.mp3SeekIndex = (await this.detectSeekIndex(af.metadata.path)).status
          changed = true
        }
        if (af.mp3SeekIndex === 'none' && mp3SeekIndex.getDrift(af) === null) {
          const { duration } = await this.measureDuration(af.metadata.path)
          af.mp3Measured = { duration: Number(duration.toFixed(3)), size: af.metadata.size, mtimeMs: af.metadata.mtimeMs }
          changed = true
        }
      } catch (error) {
        Logger.warn(`[Mp3SeekIndexManager] Seek index check failed for "${af.metadata.path}": ${error.message}`)
      }

      /** @type {SeekIndexFileStatus} */
      const file = {
        index: af.index,
        ino: af.ino,
        filename: af.metadata.filename,
        duration: af.duration,
        mp3SeekIndex: af.mp3SeekIndex || null,
        needsRepair: mp3SeekIndex.needsRepair(af)
      }
      const drift = mp3SeekIndex.getDrift(af)
      if (af.mp3SeekIndex === 'none' && drift !== null) {
        file.measuredDuration = af.mp3Measured.duration
        file.durationError = Number(drift.toFixed(3))
      }
      files.push(file)
    }

    if (changed) {
      media.audioFiles = audioFiles
      media.changed('audioFiles', true)
      await media.save()
    }

    const flagged = files.filter((f) => f.needsRepair)
    const backups = await this.listBackups(libraryItem.id)
    return {
      files,
      needsRepairCount: flagged.length,
      maxDrift: flagged.reduce((max, f) => Math.max(max, Math.abs(f.durationError || 0)), 0),
      processing: this.getIsLibraryItemQueuedOrProcessing(libraryItem.id),
      lastResult: this.lastResults.get(libraryItem.id) || null,
      backups,
      backupsTotalSize: await this.getBackupsTotalSize()
    }
  }

  //
  // Backups
  //

  itemBackupsDir(libraryItemId) {
    return Path.join(this.backupsDir, libraryItemId)
  }

  isValidBackupId(backupId) {
    return typeof backupId === 'string' && BACKUP_ID_RE.test(backupId)
  }

  /**
   * @param {string} libraryItemId
   * @returns {Promise<BackupManifest[]>} newest first
   */
  async listBackups(libraryItemId) {
    const dir = this.itemBackupsDir(libraryItemId)
    let names = []
    try {
      names = await fs.readdir(dir)
    } catch {
      return []
    }
    const manifests = []
    for (const name of names.filter((n) => this.isValidBackupId(n))) {
      const manifest = await this.readManifest(libraryItemId, name)
      if (manifest) manifests.push(manifest)
    }
    return manifests.sort((a, b) => b.createdAt - a.createdAt)
  }

  async readManifest(libraryItemId, backupId) {
    try {
      return JSON.parse(await fs.readFile(Path.join(this.itemBackupsDir(libraryItemId), backupId, MANIFEST), 'utf8'))
    } catch {
      return null
    }
  }

  /** Bytes used by every seek repair backup (all items), from the manifests. */
  async getBackupsTotalSize() {
    let total = 0
    let items = []
    try {
      items = await fs.readdir(this.backupsDir)
    } catch {
      return 0
    }
    for (const itemId of items) {
      for (const manifest of await this.listBackups(itemId)) total += manifest.size || 0
    }
    return total
  }

  newBackupId() {
    // 20261030T154012Z, unique per item
    return new Date(this.now()).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  }

  /**
   * @param {string} libraryItemId
   * @param {string} backupId
   * @returns {Promise<boolean>} false when there is no such backup
   */
  async deleteBackup(libraryItemId, backupId) {
    if (!this.isValidBackupId(backupId)) return false
    const dir = Path.join(this.itemBackupsDir(libraryItemId), backupId)
    if (!(await fs.pathExists(dir))) return false
    await fs.remove(dir)
    const left = await fs.readdir(this.itemBackupsDir(libraryItemId)).catch(() => [])
    if (!left.length) await fs.remove(this.itemBackupsDir(libraryItemId))
    Logger.info(`[Mp3SeekIndexManager] Deleted seek repair backup ${backupId} of item ${libraryItemId}`)
    return true
  }

  //
  // Tasks
  //

  /**
   * Queue a repair of every included MP3 that needs one. getStatus() must have run for the item (it stores the
   * measurements this relies on).
   *
   * @param {string} userId
   * @param {import('../models/LibraryItem')} libraryItem - expanded book item
   * @param {RepairOptions} [options]
   * @returns {Task|null} null when no file needs repair
   */
  startRepair(userId, libraryItem, options = {}) {
    const audioFiles = libraryItem.media.includedAudioFiles
    const targets = audioFiles.filter((af) => mp3SeekIndex.isMp3AudioFile(af) && mp3SeekIndex.needsRepair(af))
    if (!targets.length) return null

    const title = libraryItem.media.title
    const task = new Task()
    task.setData(
      'repair-seek-index',
      { text: 'Repairing MP3 seek index', key: 'MessageTaskRepairingSeekIndex' },
      { text: `Adding a seek index to ${targets.length} MP3 file(s) of "${title}".`, key: 'MessageTaskRepairingSeekIndexDescription', subs: [String(targets.length), title] },
      false,
      {
        libraryItemId: libraryItem.id,
        libraryId: libraryItem.libraryId,
        libraryItemDir: libraryItem.path,
        title,
        userId,
        audioFiles: targets.map((af) => ({ index: af.index, ino: af.ino, filename: af.metadata.filename, path: af.metadata.path, duration: af.duration, size: af.metadata.size })),
        duration: targets.reduce((sum, af) => sum + (af.duration || 0), 0),
        options: { chapters: options.chapters === 'shift' ? 'shift' : 'keep' }
      }
    )
    // The timeline the saved chapters were made on
    this.snapshots.set(task.id, {
      oldIncluded: audioFiles.map((af) => ({ path: af.metadata.path, duration: af.duration })),
      oldChapters: (libraryItem.media.chapters || []).map((c) => ({ ...c }))
    })
    this.enqueue(task)
    return task
  }

  /**
   * Queue putting a backup's originals back, then rescan. Saved chapters go back to how they were before the repair
   * when nobody changed them since; the backup is deleted once every file is back.
   *
   * @param {string} userId
   * @param {import('../models/LibraryItem')} libraryItem
   * @param {BackupManifest} manifest
   * @returns {Task}
   */
  startRestore(userId, libraryItem, manifest) {
    const title = libraryItem.media.title
    const task = new Task()
    task.setData(
      'restore-seek-index',
      { text: 'Restoring original MP3 files', key: 'MessageTaskRestoringSeekIndex' },
      { text: `Putting back ${manifest.files.length} original MP3 file(s) of "${title}".`, key: 'MessageTaskRestoringSeekIndexDescription', subs: [String(manifest.files.length), title] },
      false,
      {
        libraryItemId: libraryItem.id,
        libraryId: libraryItem.libraryId,
        libraryItemDir: libraryItem.path,
        title,
        userId,
        backupId: manifest.id,
        audioFiles: manifest.files.map((f) => ({ filename: f.filename, relPath: f.relPath, path: Path.join(libraryItem.path, f.relPath), duration: f.newDuration ?? f.oldDuration, size: f.size })),
        duration: manifest.files.reduce((sum, f) => sum + (f.oldDuration || 0), 0)
      }
    )
    this.snapshots.set(task.id, {
      oldIncluded: libraryItem.media.includedAudioFiles.map((af) => ({ path: af.metadata.path, duration: af.duration })),
      oldChapters: (libraryItem.media.chapters || []).map((c) => ({ ...c }))
    })
    this.enqueue(task)
    return task
  }

  enqueue(task) {
    if (this.tasksRunning.length >= this.MAX_CONCURRENT_TASKS) {
      Logger.info(`[Mp3SeekIndexManager] Queueing ${task.action} for "${task.data.title}"`)
      this.tasksQueued.push(task)
    } else {
      this.runTask(task)
    }
  }

  /**
   * Cancel a queued or running task. Files already replaced stay replaced; the file in progress is left as it was.
   *
   * @param {string} libraryItemId
   * @returns {boolean}
   */
  cancelRepair(libraryItemId) {
    const queued = this.tasksQueued.find((t) => t.data.libraryItemId === libraryItemId)
    if (queued) {
      this.tasksQueued = this.tasksQueued.filter((t) => t !== queued)
      this.snapshots.delete(queued.id)
      return true
    }
    const controller = this.abortControllers.get(libraryItemId)
    if (!controller) return false
    controller.abort()
    return true
  }

  /**
   * @param {Task} task
   */
  async runTask(task) {
    this.tasksRunning.push(task)
    TaskManager.addTask(task)
    const { libraryItemId, libraryItemDir } = task.data
    const isRestore = task.action === 'restore-seek-index'
    const controller = new AbortController()
    this.abortControllers.set(libraryItemId, controller)
    const watcher = this.getWatcher()
    let ignoring = false

    const fail = (text, key, subs) => {
      task.setFailed({ text, key, subs })
      this.handleTaskFinished(task)
    }

    try {
      Logger.info(`[Mp3SeekIndexManager] Starting ${task.action}`, task.description)

      if (!(await fileUtils.isWritable(libraryItemDir))) {
        return fail('Target directory is not writable', 'MessageTaskTargetDirectoryNotWritable')
      }
      if (!isRestore) {
        for (const af of task.data.audioFiles) {
          try {
            await fs.access(af.path, fs.constants.W_OK)
          } catch {
            return fail(`Audio file "${af.filename}" is not writable`, 'MessageTaskAudioFileNotWritable', [af.filename])
          }
        }
      }

      const backupId = isRestore ? task.data.backupId : this.uniqueBackupId(libraryItemId)
      const backupDir = Path.join(this.itemBackupsDir(libraryItemId), backupId)

      // Keep the watcher off the folder until our own rescan is done (released 5 s later, as for podcast downloads)
      watcher.addIgnoreDir(libraryItemDir)
      ignoring = true

      /** @type {FileResult[]} */
      const fileResults = []
      let progressBefore = 0
      for (const af of task.data.audioFiles) {
        const weight = task.data.duration > 0 ? (af.duration || 0) / task.data.duration : 1 / task.data.audioFiles.length
        const relPath = af.relPath || Path.relative(libraryItemDir, af.path)
        SocketAuthority.adminEmitter('track_started', { libraryItemId, ino: af.ino })
        const onProgress = (fraction) => {
          SocketAuthority.adminEmitter('task_progress', { libraryItemId, progress: Math.round((progressBefore + fraction * weight) * 1000) / 10 })
          SocketAuthority.adminEmitter('track_progress', { libraryItemId, ino: af.ino, progress: Math.round(fraction * 100) })
        }
        try {
          if (relPath.startsWith('..') || Path.isAbsolute(relPath)) throw new Error('File is outside the item folder')
          const backupPath = Path.join(backupDir, 'files', relPath)
          if (isRestore) {
            if (controller.signal.aborted) throw new Error('Canceled')
            await this.restoreFile(backupPath, af.path)
            onProgress(1)
          } else {
            await this.repairFile(af.path, { expectedDuration: af.duration, signal: controller.signal, backupPath, onProgress })
          }
          Logger.info(`[Mp3SeekIndexManager] ${isRestore ? 'Restored' : 'Added seek index to'} "${af.path}"`)
          fileResults.push({ filename: af.filename, ino: af.ino || null, relPath, size: af.size, status: isRestore ? 'restored' : 'repaired', oldDuration: af.duration, newDuration: null })
        } catch (error) {
          const message = controller.signal.aborted ? 'Canceled' : error.message
          if (!controller.signal.aborted) Logger.error(`[Mp3SeekIndexManager] ${task.action} of "${af.path}" failed: ${message}`)
          fileResults.push({ filename: af.filename, ino: af.ino || null, relPath, size: af.size, status: 'failed', oldDuration: af.duration, newDuration: null, error: message })
          if (controller.signal.aborted) break
        }
        SocketAuthority.adminEmitter('track_finished', { libraryItemId, ino: af.ino })
        progressBefore += weight
      }

      const doneCount = fileResults.filter((r) => r.status !== 'failed').length
      const fresh = doneCount ? await this.rescan(task) : null
      const result = await this.buildResult(task, fileResults, fresh)

      if (!isRestore) {
        if (doneCount) {
          await this.writeManifest(task, backupDir, backupId, fileResults, fresh)
          result.backupId = backupId
        } else {
          await fs.remove(backupDir).catch(() => {})
        }
      } else if (doneCount === fileResults.length) {
        await this.deleteBackup(libraryItemId, backupId)
      }
      // The client only needs filenames and durations
      result.files = fileResults.map(({ relPath, size, ...r }) => r)
      this.lastResults.set(libraryItemId, result)
      task.data.result = result

      const failed = fileResults.filter((r) => r.status === 'failed')
      if (controller.signal.aborted) {
        task.setFailed({ text: 'Task canceled by user', key: 'MessageTaskCanceledByUser' })
      } else if (failed.length) {
        task.setFailed({
          text: `Failed to ${isRestore ? 'restore' : 'repair'} "${failed[0].filename}": ${failed[0].error}`,
          key: isRestore ? 'MessageTaskRestoreSeekIndexFailed' : 'MessageTaskRepairSeekIndexFailed',
          subs: [failed[0].filename, failed[0].error]
        })
      } else {
        const delta = result.newTotalDuration - result.oldTotalDuration
        const deltaText = `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}`
        task.setFinished(
          isRestore
            ? { text: `Restored ${doneCount} file(s). Duration changed by ${deltaText}s.`, key: 'MessageTaskRestoreSeekIndexFinished', subs: [String(doneCount), deltaText] }
            : { text: `Repaired ${doneCount} file(s). Duration changed by ${deltaText}s.`, key: 'MessageTaskRepairSeekIndexFinished', subs: [String(doneCount), deltaText] }
        )
      }
      this.handleTaskFinished(task)
    } catch (error) {
      Logger.error(`[Mp3SeekIndexManager] ${task.action} failed`, error)
      fail(`Seek index ${isRestore ? 'restore' : 'repair'} failed: ${error.message}`, isRestore ? 'MessageTaskRestoreSeekIndexFailed' : 'MessageTaskRepairSeekIndexFailed', ['', error.message])
    } finally {
      this.abortControllers.delete(libraryItemId)
      if (ignoring) watcher.removeIgnoreDir(libraryItemDir)
    }
  }

  uniqueBackupId(libraryItemId) {
    const base = this.newBackupId()
    const dir = this.itemBackupsDir(libraryItemId)
    let id = base
    for (let n = 2; fs.existsSync(Path.join(dir, id)); n++) id = `${base}-${n}`
    return id
  }

  /**
   * Rescan the item so the new durations are stored.
   *
   * @param {Task} task
   * @returns {Promise<import('../models/LibraryItem')|null>}
   */
  async rescan(task) {
    const { libraryItemId, libraryId } = task.data
    await this.scanItem(libraryItemId)
    await Database.resetLibraryIssuesFilterData?.(libraryId)
    return this.getItem(libraryItemId)
  }

  /**
   * Durations before/after, and the saved chapters: repair keeps them (moving only a last end that ran to the old
   * total) or shifts them as asked; restore puts back the chapters from before the repair if they were not changed
   * since it.
   *
   * @param {Task} task
   * @param {FileResult[]} fileResults
   * @param {import('../models/LibraryItem')|null} fresh - item after the rescan
   * @returns {Promise<RepairResult>}
   */
  async buildResult(task, fileResults, fresh) {
    const isRestore = task.action === 'restore-seek-index'
    const { libraryItemId } = task.data
    const mode = task.data.options?.chapters || 'keep'
    const { oldIncluded, oldChapters } = this.snapshots.get(task.id)
    const newByPath = new Map((fresh?.media?.includedAudioFiles || []).map((af) => [af.metadata.path, af.duration]))
    for (const r of fileResults) {
      const file = task.data.audioFiles.find((af) => af.filename === r.filename && (af.relPath || Path.relative(task.data.libraryItemDir, af.path)) === r.relPath)
      r.newDuration = file ? (newByPath.get(file.path) ?? null) : null
    }
    const oldDurations = oldIncluded.map((f) => f.duration || 0)
    const newDurations = oldIncluded.map((f) => newByPath.get(f.path) ?? f.duration ?? 0)
    const oldTotalDuration = oldDurations.reduce((a, b) => a + b, 0)
    const newTotalDuration = newDurations.reduce((a, b) => a + b, 0)

    const { chapters: shiftedChapters, maxShift } = mp3SeekIndex.shiftChapters(oldChapters, oldDurations, newDurations)
    /** @type {RepairResult} */
    const result = {
      type: isRestore ? 'restore' : 'repair',
      libraryItemId,
      finishedAt: this.now(),
      files: fileResults,
      oldTotalDuration,
      newTotalDuration,
      chapters: { count: oldChapters.length, mode, shifted: false, endExtended: false, restored: false, maxShift: Number(maxShift.toFixed(3)) }
    }
    const sameFiles = fresh && fresh.media.includedAudioFiles.length === oldIncluded.length && oldIncluded.every((f) => newByPath.has(f.path))
    if (!oldChapters.length || !sameFiles) return result

    const current = (fresh.media.chapters || []).map(plainChapter)
    if (isRestore) {
      const manifest = await this.readManifest(libraryItemId, task.data.backupId)
      if (manifest?.chaptersBefore?.length && chaptersEqual(current, manifest.chaptersAfter) && !chaptersEqual(current, manifest.chaptersBefore)) {
        await this.applyChapters(fresh, manifest.chaptersBefore.map(plainChapter))
        result.chapters.restored = true
      }
      return result
    }

    if (maxShift < 0.001) return result
    // Only an explicit request moves chapter times
    if (mode === 'shift') {
      await this.applyChapters(fresh, shiftedChapters)
      result.chapters.shifted = true
      return result
    }
    // Keep: the times stay, but a last chapter that ran to the old end would stop short of the new one
    const last = current[current.length - 1]
    if (last && Math.abs(last.end - oldTotalDuration) < 0.5 && Math.abs(newTotalDuration - oldTotalDuration) >= 0.001) {
      await this.applyChapters(
        fresh,
        current.map((c, i) => ({ ...c, end: i === current.length - 1 ? Number(newTotalDuration.toFixed(6)) : c.end }))
      )
      result.chapters.endExtended = true
    }
    return result
  }

  /**
   * Record what this repair backed up, with the chapters before and after it (restore uses them).
   */
  async writeManifest(task, backupDir, backupId, fileResults, fresh) {
    const { oldChapters } = this.snapshots.get(task.id)
    const refreshed = fresh ? await this.getItem(task.data.libraryItemId) : null
    const files = fileResults
      .filter((r) => r.status === 'repaired')
      .map((r) => ({ relPath: r.relPath, filename: r.filename, size: r.size, oldDuration: r.oldDuration, newDuration: r.newDuration }))
    /** @type {BackupManifest} */
    const manifest = {
      id: backupId,
      libraryItemId: task.data.libraryItemId,
      title: task.data.title,
      createdAt: this.now(),
      files,
      size: files.reduce((sum, f) => sum + (f.size || 0), 0),
      chaptersBefore: oldChapters.map(plainChapter),
      chaptersAfter: (refreshed?.media?.chapters || []).map(plainChapter)
    }
    await fs.ensureDir(backupDir)
    await fs.writeFile(Path.join(backupDir, MANIFEST), JSON.stringify(manifest, null, 2))
  }

  handleTaskFinished(task) {
    this.snapshots.delete(task.id)
    TaskManager.taskFinished(task)
    this.tasksRunning = this.tasksRunning.filter((t) => t.id !== task.id)

    if (this.tasksRunning.length < this.MAX_CONCURRENT_TASKS && this.tasksQueued.length) {
      this.runTask(this.tasksQueued.shift())
    }
  }
}

function plainChapter(c, index) {
  return { id: c.id ?? index, start: c.start, end: c.end, title: c.title }
}

function chaptersEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
  return a.every((c, i) => c.title === b[i].title && Math.abs(c.start - b[i].start) < 0.001 && Math.abs(c.end - b[i].end) < 0.001)
}

module.exports = Mp3SeekIndexManager
