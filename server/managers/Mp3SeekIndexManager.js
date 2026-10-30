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
 * @property {boolean} needsRepair
 * @property {number} [measuredDuration] - frame count duration, only when measured
 * @property {number} [durationError] - measuredDuration - duration
 *
 * @typedef RepairFileResult
 * @property {string} filename
 * @property {string} ino
 * @property {'repaired'|'failed'} status
 * @property {number} oldDuration
 * @property {number|null} newDuration - after the rescan
 * @property {string} [error]
 *
 * @typedef RepairResult
 * @property {string} libraryItemId
 * @property {number} finishedAt
 * @property {RepairFileResult[]} files
 * @property {number} oldTotalDuration
 * @property {number} newTotalDuration
 * @property {{count: number, mode: 'keep'|'shift', shifted: boolean, maxShift: number}} chapters
 *
 * @typedef RepairOptions
 * @property {'keep'|'shift'} [chapters='keep'] - shift: move saved chapter times by the duration change of earlier files
 * @property {boolean} [backup=false] - copy each original to the item's metadata cache first
 */

class Mp3SeekIndexManager {
  /**
   * @param {Object} [deps] - injectable for tests
   */
  constructor(deps = {}) {
    this.itemsCacheDir = Path.join(global.MetadataPath || '', 'cache/items')
    this.MAX_CONCURRENT_TASKS = 1
    /** @type {Task[]} */
    this.tasksRunning = []
    /** @type {Task[]} */
    this.tasksQueued = []
    /** @type {Map<string, AbortController>} */
    this.abortControllers = new Map()
    /** @type {Map<string, RepairResult>} last result per library item (until restart) */
    this.lastResults = new Map()
    /** @type {Map<string, number>} measured duration by path|size|mtime */
    this.measureCache = new Map()

    this.repairFile = deps.repairFile || mp3SeekIndex.repairFile
    this.detectSeekIndex = deps.detectSeekIndex || mp3SeekIndex.detectSeekIndex
    this.measureDuration = deps.measureDuration || mp3SeekIndex.measureDuration
    this.scanItem = deps.scanItem || ((libraryItemId) => require('../scanner/LibraryItemScanner').scanLibraryItem(libraryItemId))
    this.getItem = deps.getItem || ((libraryItemId) => Database.libraryItemModel.getExpandedById(libraryItemId))
    this.applyChapters = deps.applyChapters || applyChapters
    this.watcher = deps.watcher || null
  }

  getWatcher() {
    return this.watcher || require('../Watcher')
  }

  getIsLibraryItemQueuedOrProcessing(libraryItemId) {
    return this.tasksQueued.some((t) => t.data.libraryItemId === libraryItemId) || this.tasksRunning.some((t) => t.data.libraryItemId === libraryItemId)
  }

  /**
   * Check every included MP3 of a book for a seek index (a ~64 KB read each) and store the result on the audio file,
   * so items scanned before this check existed get flagged too. With `measure`, files without one are also walked
   * frame by frame (reads the whole file) to report how far the stored duration is off.
   *
   * @param {import('../models/LibraryItem')} libraryItem - expanded book item
   * @param {{measure?: boolean}} [options]
   * @returns {Promise<{files: SeekIndexFileStatus[], needsRepairCount: number, processing: boolean, lastResult: RepairResult|null}>}
   */
  async getStatus(libraryItem, { measure = false } = {}) {
    const media = libraryItem.media
    const files = []
    let changed = false
    const audioFiles = (media.audioFiles || []).map((af) => ({ ...af }))

    for (const af of audioFiles) {
      if (af.exclude || !mp3SeekIndex.isMp3AudioFile(af)) continue
      try {
        const { status } = await this.detectSeekIndex(af.metadata.path)
        if (af.mp3SeekIndex !== status) {
          af.mp3SeekIndex = status
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
        needsRepair: mp3SeekIndex.needsRepair(af.mp3SeekIndex)
      }
      if (measure && file.needsRepair) {
        const measured = await this.getMeasuredDuration(af)
        if (measured != null) {
          file.measuredDuration = measured
          file.durationError = Number((measured - af.duration).toFixed(3))
        }
      }
      files.push(file)
    }

    if (changed) {
      media.audioFiles = audioFiles
      media.changed('audioFiles', true)
      await media.save()
    }

    return {
      files,
      needsRepairCount: files.filter((f) => f.needsRepair).length,
      processing: this.getIsLibraryItemQueuedOrProcessing(libraryItem.id),
      lastResult: this.lastResults.get(libraryItem.id) || null
    }
  }

  /**
   * @param {import('../models/Book').AudioFileObject} audioFile
   * @returns {Promise<number|null>}
   */
  async getMeasuredDuration(audioFile) {
    const { path, size, mtimeMs } = audioFile.metadata
    const key = `${path}|${size}|${mtimeMs}`
    if (this.measureCache.has(key)) return this.measureCache.get(key)
    try {
      const { duration } = await this.measureDuration(path)
      const rounded = Number(duration.toFixed(3))
      this.measureCache.set(key, rounded)
      return rounded
    } catch (error) {
      Logger.warn(`[Mp3SeekIndexManager] Measuring "${path}" failed: ${error.message}`)
      return null
    }
  }

  /**
   * Queue a repair of every included MP3 without a seek index.
   *
   * @param {string} userId
   * @param {import('../models/LibraryItem')} libraryItem - expanded book item
   * @param {RepairOptions} [options]
   * @returns {Task|null} null when no file needs repair
   */
  startRepair(userId, libraryItem, options = {}) {
    const audioFiles = libraryItem.media.includedAudioFiles
    const targets = audioFiles.filter((af) => mp3SeekIndex.isMp3AudioFile(af) && mp3SeekIndex.needsRepair(af.mp3SeekIndex))
    if (!targets.length) return null

    const task = new Task()
    const taskData = {
      libraryItemId: libraryItem.id,
      libraryId: libraryItem.libraryId,
      libraryItemDir: libraryItem.path,
      userId,
      audioFiles: targets.map((af) => ({
        index: af.index,
        ino: af.ino,
        filename: af.metadata.filename,
        path: af.metadata.path,
        duration: af.duration
      })),
      // Snapshot of the timeline the saved chapters were made on
      oldIncluded: audioFiles.map((af) => ({ path: af.metadata.path, filename: af.metadata.filename, ino: af.ino, duration: af.duration })),
      oldChapters: (libraryItem.media.chapters || []).map((c) => ({ ...c })),
      duration: targets.reduce((sum, af) => sum + (af.duration || 0), 0),
      options: {
        chapters: options.chapters === 'shift' ? 'shift' : 'keep',
        backup: !!options.backup
      }
    }
    const title = libraryItem.media.title
    task.setData(
      'repair-seek-index',
      { text: 'Repairing MP3 seek index', key: 'MessageTaskRepairingSeekIndex' },
      { text: `Adding a seek index to ${targets.length} MP3 file(s) of "${title}".`, key: 'MessageTaskRepairingSeekIndexDescription', subs: [String(targets.length), title] },
      false,
      taskData
    )

    if (this.tasksRunning.length >= this.MAX_CONCURRENT_TASKS) {
      Logger.info(`[Mp3SeekIndexManager] Queueing seek index repair for "${title}"`)
      this.tasksQueued.push(task)
    } else {
      this.runRepair(task)
    }
    return task
  }

  /**
   * Cancel a queued or running repair. Files already replaced stay replaced; the file in progress is left as it was.
   *
   * @param {string} libraryItemId
   * @returns {boolean}
   */
  cancelRepair(libraryItemId) {
    const queued = this.tasksQueued.find((t) => t.data.libraryItemId === libraryItemId)
    if (queued) {
      this.tasksQueued = this.tasksQueued.filter((t) => t !== queued)
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
  async runRepair(task) {
    this.tasksRunning.push(task)
    TaskManager.addTask(task)
    const { libraryItemId, libraryItemDir, options } = task.data
    const controller = new AbortController()
    this.abortControllers.set(libraryItemId, controller)
    const watcher = this.getWatcher()
    let ignoring = false

    const fail = (text, key, subs) => {
      task.setFailed({ text, key, subs })
      this.handleTaskFinished(task)
    }

    try {
      Logger.info(`[Mp3SeekIndexManager] Starting seek index repair`, task.description)

      if (!(await fileUtils.isWritable(libraryItemDir))) {
        return fail('Target directory is not writable', 'MessageTaskTargetDirectoryNotWritable')
      }
      for (const af of task.data.audioFiles) {
        try {
          await fs.access(af.path, fs.constants.W_OK)
        } catch {
          return fail(`Audio file "${af.filename}" is not writable`, 'MessageTaskAudioFileNotWritable', [af.filename])
        }
      }

      let backupDir = null
      if (options.backup) {
        backupDir = Path.join(this.itemsCacheDir, libraryItemId, 'seek-index-backup')
        await fs.ensureDir(backupDir)
      }

      // Keep the watcher off the folder until our own rescan is done (released 5 s later, as for podcast downloads)
      watcher.addIgnoreDir(libraryItemDir)
      ignoring = true

      /** @type {RepairFileResult[]} */
      const fileResults = []
      let progressBefore = 0
      for (const af of task.data.audioFiles) {
        const weight = task.data.duration > 0 ? (af.duration || 0) / task.data.duration : 1 / task.data.audioFiles.length
        SocketAuthority.adminEmitter('track_started', { libraryItemId, ino: af.ino })
        try {
          await this.repairFile(af.path, {
            expectedDuration: af.duration,
            signal: controller.signal,
            backupPath: backupDir ? Path.join(backupDir, af.filename) : null,
            onProgress: (fraction) => {
              SocketAuthority.adminEmitter('task_progress', { libraryItemId, progress: Math.round((progressBefore + fraction * weight) * 1000) / 10 })
              SocketAuthority.adminEmitter('track_progress', { libraryItemId, ino: af.ino, progress: Math.round(fraction * 100) })
            }
          })
          Logger.info(`[Mp3SeekIndexManager] Added seek index to "${af.path}"`)
          fileResults.push({ filename: af.filename, ino: af.ino, status: 'repaired', oldDuration: af.duration, newDuration: null })
        } catch (error) {
          if (controller.signal.aborted) {
            fileResults.push({ filename: af.filename, ino: af.ino, status: 'failed', oldDuration: af.duration, newDuration: null, error: 'Canceled' })
            break
          }
          Logger.error(`[Mp3SeekIndexManager] Repair of "${af.path}" failed: ${error.message}`)
          fileResults.push({ filename: af.filename, ino: af.ino, status: 'failed', oldDuration: af.duration, newDuration: null, error: error.message })
        }
        SocketAuthority.adminEmitter('track_finished', { libraryItemId, ino: af.ino })
        progressBefore += weight
      }

      const repairedCount = fileResults.filter((r) => r.status === 'repaired').length
      const result = repairedCount ? await this.rescanAndReport(task, fileResults) : await this.buildResult(task, fileResults, null)
      this.lastResults.set(libraryItemId, result)
      task.data.result = result

      const failed = fileResults.filter((r) => r.status === 'failed')
      if (controller.signal.aborted) {
        task.setFailed({ text: 'Task canceled by user', key: 'MessageTaskCanceledByUser' })
      } else if (failed.length) {
        task.setFailed({ text: `Failed to repair "${failed[0].filename}": ${failed[0].error}`, key: 'MessageTaskRepairSeekIndexFailed', subs: [failed[0].filename, failed[0].error] })
      } else {
        const delta = result.newTotalDuration - result.oldTotalDuration
        task.setFinished({
          text: `Repaired ${repairedCount} file(s). Duration changed by ${delta >= 0 ? '+' : ''}${delta.toFixed(1)}s.`,
          key: 'MessageTaskRepairSeekIndexFinished',
          subs: [String(repairedCount), `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}`]
        })
      }
      this.handleTaskFinished(task)
    } catch (error) {
      Logger.error(`[Mp3SeekIndexManager] Seek index repair failed`, error)
      fail(`Seek index repair failed: ${error.message}`, 'MessageTaskRepairSeekIndexFailed', ['', error.message])
    } finally {
      this.abortControllers.delete(libraryItemId)
      if (ignoring) watcher.removeIgnoreDir(libraryItemDir)
    }
  }

  /**
   * Rescan the item so the new durations are stored, then deal with the saved chapters as asked.
   *
   * @param {Task} task
   * @param {RepairFileResult[]} fileResults
   * @returns {Promise<RepairResult>}
   */
  async rescanAndReport(task, fileResults) {
    const { libraryItemId, libraryId } = task.data
    await this.scanItem(libraryItemId)
    await Database.resetLibraryIssuesFilterData?.(libraryId)

    const fresh = await this.getItem(libraryItemId)
    const newByPath = new Map((fresh?.media?.includedAudioFiles || []).map((af) => [af.metadata.path, af.duration]))
    for (const r of fileResults) {
      const old = task.data.audioFiles.find((af) => af.ino === r.ino)
      r.newDuration = newByPath.get(old.path) ?? null
    }
    return this.buildResult(task, fileResults, fresh)
  }

  /**
   * @param {Task} task
   * @param {RepairFileResult[]} fileResults
   * @param {import('../models/LibraryItem')|null} fresh - item after the rescan
   * @returns {Promise<RepairResult>}
   */
  async buildResult(task, fileResults, fresh) {
    const { oldIncluded, oldChapters, options, libraryItemId } = task.data
    const newByPath = new Map((fresh?.media?.includedAudioFiles || []).map((af) => [af.metadata.path, af.duration]))
    const oldDurations = oldIncluded.map((f) => f.duration || 0)
    const newDurations = oldIncluded.map((f) => newByPath.get(f.path) ?? f.duration ?? 0)
    const oldTotalDuration = oldDurations.reduce((a, b) => a + b, 0)
    const newTotalDuration = newDurations.reduce((a, b) => a + b, 0)

    const { chapters: shiftedChapters, maxShift } = mp3SeekIndex.shiftChapters(oldChapters, oldDurations, newDurations)
    /** @type {RepairResult} */
    const result = {
      libraryItemId,
      finishedAt: Date.now(),
      files: fileResults,
      oldTotalDuration,
      newTotalDuration,
      chapters: { count: oldChapters.length, mode: options.chapters, shifted: false, maxShift: Number(maxShift.toFixed(3)) }
    }
    // Only an explicit request rewrites chapters, and only when the item's file set is unchanged
    const sameFiles = fresh && fresh.media.includedAudioFiles.length === oldIncluded.length && oldIncluded.every((f) => newByPath.has(f.path))
    if (options.chapters !== 'shift' || !oldChapters.length || !sameFiles || maxShift < 0.001) return result
    await this.applyChapters(fresh, shiftedChapters)
    result.chapters.shifted = true
    return result
  }

  handleTaskFinished(task) {
    TaskManager.taskFinished(task)
    this.tasksRunning = this.tasksRunning.filter((t) => t.id !== task.id)

    if (this.tasksRunning.length < this.MAX_CONCURRENT_TASKS && this.tasksQueued.length) {
      this.runRepair(this.tasksQueued.shift())
    }
  }
}
module.exports = Mp3SeekIndexManager
