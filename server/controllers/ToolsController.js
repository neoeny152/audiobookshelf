const { Request, Response, NextFunction } = require('express')
const Logger = require('../Logger')
const Database = require('../Database')

/**
 * @typedef RequestUserObject
 * @property {import('../models/User')} user
 *
 * @typedef {Request & RequestUserObject} RequestWithUser
 *
 * @typedef RequestEntityObject
 * @property {import('../models/LibraryItem')} libraryItem
 *
 * @typedef {RequestWithUser & RequestEntityObject} RequestWithLibraryItem
 */

class ToolsController {
  constructor() {}

  /**
   * POST: /api/tools/item/:id/encode-m4b
   * Start an audiobook merge to m4b task
   *
   * @this import('../routers/ApiRouter')
   *
   * @param {RequestWithLibraryItem} req
   * @param {Response} res
   */
  async encodeM4b(req, res) {
    if (req.libraryItem.isMissing || req.libraryItem.isInvalid) {
      Logger.error(`[MiscController] encodeM4b: library item not found or invalid ${req.params.id}`)
      return res.status(404).send('Audiobook not found')
    }

    if (!req.libraryItem.isBook) {
      Logger.error(`[MiscController] encodeM4b: Invalid library item ${req.params.id}: not a book`)
      return res.status(400).send('Invalid library item: not a book')
    }

    if (!req.libraryItem.hasAudioTracks) {
      Logger.error(`[MiscController] encodeM4b: Invalid audiobook ${req.params.id}: no audio tracks`)
      return res.status(400).send('Invalid audiobook: no audio tracks')
    }

    if (this.abMergeManager.getPendingTaskByLibraryItemId(req.libraryItem.id) || this.mp3SeekIndexManager.getIsLibraryItemQueuedOrProcessing(req.libraryItem.id)) {
      Logger.error(`[MiscController] encodeM4b: Audiobook ${req.params.id} is already processing`)
      return res.status(400).send('Audiobook is already processing')
    }

    const options = req.query || {}
    Logger.info(`[ToolsController] encodeM4b: Starting audiobook merge for "${req.libraryItem.media.title}" with options: ${JSON.stringify(options)}`)
    this.abMergeManager.startAudiobookMerge(req.user.id, req.libraryItem, options)

    res.sendStatus(200)
  }

  /**
   * DELETE: /api/tools/item/:id/encode-m4b
   * Cancel a running m4b merge task
   *
   * @this import('../routers/ApiRouter')
   *
   * @param {RequestWithUser} req
   * @param {Response} res
   */
  async cancelM4bEncode(req, res) {
    const workerTask = this.abMergeManager.getPendingTaskByLibraryItemId(req.params.id)
    if (!workerTask) return res.sendStatus(404)

    this.abMergeManager.cancelEncode(workerTask.task)

    res.sendStatus(200)
  }

  /**
   * POST: /api/tools/item/:id/embed-metadata
   * Start audiobook embed task
   *
   * @this import('../routers/ApiRouter')
   *
   * @param {RequestWithLibraryItem} req
   * @param {Response} res
   */
  async embedAudioFileMetadata(req, res) {
    if (req.libraryItem.isMissing || !req.libraryItem.hasAudioTracks || !req.libraryItem.isBook) {
      Logger.error(`[ToolsController] Invalid library item`)
      return res.sendStatus(400)
    }

    if (this.audioMetadataManager.getIsLibraryItemQueuedOrProcessing(req.libraryItem.id) || this.mp3SeekIndexManager.getIsLibraryItemQueuedOrProcessing(req.libraryItem.id)) {
      Logger.error(`[ToolsController] Library item (${req.libraryItem.id}) is already in queue or processing`)
      return res.status(400).send('Library item is already in queue or processing')
    }

    const options = {
      forceEmbedChapters: req.query.forceEmbedChapters === '1',
      backup: req.query.backup === '1'
    }
    this.audioMetadataManager.updateMetadataForItem(req.user.id, req.libraryItem, options)
    res.sendStatus(200)
  }

  /**
   * POST: /api/tools/batch/embed-metadata
   * Start batch audiobook embed task
   *
   * @this import('../routers/ApiRouter')
   *
   * @param {RequestWithUser} req
   * @param {Response} res
   */
  async batchEmbedMetadata(req, res) {
    const libraryItemIds = req.body.libraryItemIds || []
    if (!Array.isArray(libraryItemIds) || !libraryItemIds.length) {
      return res.status(400).send('Invalid request payload')
    }

    // Load all items in one query, then validate in request order so the first failing id decides the response as before
    const validIds = [...new Set(libraryItemIds.filter((id) => typeof id === 'string' && id))]
    const foundItems = validIds.length ? await Database.libraryItemModel.findAllExpandedWhere({ id: validIds }) : []
    const libraryItemMap = new Map(foundItems.filter((li) => li.media).map((li) => [li.id, li]))

    const libraryItems = []
    for (const libraryItemId of libraryItemIds) {
      const libraryItem = typeof libraryItemId === 'string' ? libraryItemMap.get(libraryItemId) : null
      if (!libraryItem) {
        Logger.error(`[ToolsController] Batch embed metadata library item (${libraryItemId}) not found`)
        return res.sendStatus(404)
      }

      // Check user can access this library item
      if (!req.user.checkCanAccessLibraryItem(libraryItem)) {
        Logger.error(`[ToolsController] Batch embed metadata library item (${libraryItemId}) not accessible to user "${req.user.username}"`)
        return res.sendStatus(403)
      }

      if (libraryItem.isMissing || !libraryItem.hasAudioTracks || !libraryItem.isBook) {
        Logger.error(`[ToolsController] Batch embed invalid library item (${libraryItemId})`)
        return res.sendStatus(400)
      }

      if (this.audioMetadataManager.getIsLibraryItemQueuedOrProcessing(libraryItemId)) {
        Logger.error(`[ToolsController] Batch embed library item (${libraryItemId}) is already in queue or processing`)
        return res.status(400).send('Library item is already in queue or processing')
      }

      libraryItems.push(libraryItem)
    }

    const options = {
      forceEmbedChapters: req.query.forceEmbedChapters === '1',
      backup: req.query.backup === '1'
    }
    this.audioMetadataManager.handleBatchEmbed(req.user.id, libraryItems, options)
    res.sendStatus(200)
  }

  /**
   * GET: /api/tools/item/:id/seek-index
   * Which included MP3 files have no Xing/Info/VBRI header (ffprobe estimated their duration).
   * The check result is stored on the audio files. ?measure=1 also walks those files frame by frame to report
   * how far the stored duration is off (reads each whole file).
   *
   * @this import('../routers/ApiRouter')
   *
   * @param {RequestWithLibraryItem} req
   * @param {Response} res
   */
  async getSeekIndexStatus(req, res) {
    if (req.libraryItem.isMissing || !req.libraryItem.isBook) {
      return res.status(400).send('Invalid library item: not a book')
    }
    const status = await this.mp3SeekIndexManager.getStatus(req.libraryItem, { measure: req.query.measure === '1' })
    res.json(status)
  }

  /**
   * POST: /api/tools/item/:id/repair-seek-index
   * Start a task that remuxes every included MP3 without a seek index (stream copy, Xing header written, verified,
   * then replaced) and rescans the item. Body: { chapters?: 'keep'|'shift', backup?: boolean }
   *
   * @this import('../routers/ApiRouter')
   *
   * @param {RequestWithLibraryItem} req
   * @param {Response} res
   */
  async repairSeekIndex(req, res) {
    if (req.libraryItem.isMissing || !req.libraryItem.isBook || !req.libraryItem.hasAudioTracks) {
      return res.status(400).send('Invalid library item')
    }
    if (req.libraryItem.isFile) {
      return res.status(400).send('Single-file library items are not supported')
    }
    const libraryItemId = req.libraryItem.id
    if (this.mp3SeekIndexManager.getIsLibraryItemQueuedOrProcessing(libraryItemId) || this.audioMetadataManager.getIsLibraryItemQueuedOrProcessing(libraryItemId) || this.abMergeManager.getPendingTaskByLibraryItemId(libraryItemId)) {
      return res.status(400).send('Library item is already in queue or processing')
    }
    const chapters = req.body?.chapters
    if (chapters !== undefined && chapters !== 'keep' && chapters !== 'shift') {
      return res.status(400).send('Invalid chapters option')
    }

    // Use the stored check, refreshed first so an item scanned before the check existed is covered
    await this.mp3SeekIndexManager.getStatus(req.libraryItem)
    const task = this.mp3SeekIndexManager.startRepair(req.user.id, req.libraryItem, { chapters, backup: req.body?.backup === true })
    if (!task) {
      return res.status(400).send('No MP3 files without a seek index')
    }
    Logger.info(`[ToolsController] Started seek index repair for "${req.libraryItem.media.title}"`)
    res.json({ taskId: task.id, files: task.data.audioFiles.map((af) => ({ ino: af.ino, filename: af.filename, duration: af.duration })) })
  }

  /**
   * DELETE: /api/tools/item/:id/repair-seek-index
   * Cancel a queued or running repair. Files already replaced stay replaced.
   *
   * @this import('../routers/ApiRouter')
   *
   * @param {RequestWithUser} req
   * @param {Response} res
   */
  async cancelRepairSeekIndex(req, res) {
    if (!this.mp3SeekIndexManager.cancelRepair(req.params.id)) return res.sendStatus(404)
    res.sendStatus(200)
  }

  /**
   *
   * @param {RequestWithUser} req
   * @param {Response} res
   * @param {NextFunction} next
   */
  async middleware(req, res, next) {
    if (!req.user.isAdminOrUp) {
      Logger.error(`[LibraryItemController] Non-root user "${req.user.username}" attempted to access tools route`)
      return res.sendStatus(403)
    }

    if (req.params.id) {
      const item = await Database.libraryItemModel.getExpandedById(req.params.id)
      if (!item?.media) return res.sendStatus(404)

      // Check user can access this library item
      if (!req.user.checkCanAccessLibraryItem(item)) {
        return res.sendStatus(403)
      }

      req.libraryItem = item
    }

    next()
  }
}
module.exports = new ToolsController()
