const { Request, Response } = require('express')
const Path = require('path')
const Logger = require('../Logger')
const TranscriptManager = require('../managers/TranscriptManager')
const transcripts = require('../utils/transcripts')
const { sanitizeFilename } = require('../utils/fileUtils')

/**
 * @typedef RequestUserObject
 * @property {import('../models/User')} user
 *
 * @typedef {Request & RequestUserObject & {libraryItem: import('../models/LibraryItem')}} RequestWithLibraryItem
 */

/**
 * Transcripts of audiobooks and podcast episodes (fork feature "transcripts", see managers/TranscriptManager.js).
 * Every route runs after LibraryItemController.middleware (item access; POST needs canUpdate, DELETE canDelete).
 * Reading needs only access to the item; generating, cancelling, deleting and refreshing from the feed are admin
 * actions.
 */
class TranscriptController {
  constructor() {}

  /**
   * @param {*} value
   * @returns {string|null}
   */
  static episodeIdFrom(value) {
    return typeof value === 'string' && value ? value : null
  }

  /**
   * @param {Error} error
   * @param {Response} res
   * @param {string} action
   */
  static handleError(error, res, action) {
    if (error instanceof transcripts.TranscriptError) {
      return res.status(error.status || 400).send(error.message)
    }
    Logger.error(`[TranscriptController] ${action} failed`, error)
    return res.sendStatus(500)
  }

  /**
   * GET: /api/items/:id/transcripts?episodeId=
   * The transcripts of a book, or of one podcast episode: { libraryItemId, episodeId, transcripts, preferredId,
   * canGenerate, job }. transcripts is an empty list when there are none.
   *
   * @param {RequestWithLibraryItem} req
   * @param {Response} res
   */
  async list(req, res) {
    try {
      const payload = await TranscriptManager.list(req.libraryItem, TranscriptController.episodeIdFrom(req.query.episodeId))
      if (!req.user.isAdminOrUp) {
        payload.canGenerate = false
        payload.job = null
      }
      res.json(payload)
    } catch (error) {
      TranscriptController.handleError(error, res, 'Listing transcripts')
    }
  }

  /**
   * GET: /api/items/:id/transcripts/:transcriptId?episodeId=&format=vtt|json|original
   * - vtt (default): WebVTT for timed transcripts, plain text for untimed ones (HTML is never served as HTML)
   * - json: { id, source, format, timed, cues: [{start, end, text, speaker?}] } or { ..., timed: false, text }
   * - original: the file as the creator published it (or as stored), as a download
   *
   * @param {RequestWithLibraryItem} req
   * @param {Response} res
   */
  async get(req, res) {
    const format = typeof req.query.format === 'string' ? req.query.format : 'vtt'
    if (!['vtt', 'json', 'original'].includes(format)) return res.status(400).send('format must be vtt, json or original')
    let loaded
    try {
      loaded = await TranscriptManager.load(req.libraryItem, TranscriptController.episodeIdFrom(req.query.episodeId), req.params.transcriptId)
    } catch (error) {
      return TranscriptController.handleError(error, res, 'Loading a transcript')
    }

    res.set('Cache-Control', 'private, no-cache')
    res.set('X-Content-Type-Options', 'nosniff')
    if (format === 'json') {
      const { originalPath, originalPaths, ...body } = loaded
      return res.json(body)
    }
    if (format === 'original') {
      const path = loaded.originalPath || (loaded.originalPaths?.length === 1 ? loaded.originalPaths[0] : null)
      if (path) {
        const ext = Path.extname(path).slice(1).toLowerCase()
        const name = sanitizeFilename(`${req.libraryItem.media.title || 'transcript'}${loaded.source === 'generated' ? ' (generated)' : ''}.${ext}`) || `transcript.${ext}`
        res.set('Content-Security-Policy', "sandbox; default-src 'none'")
        res.set('Content-Type', `${transcripts.MIME_TYPES[ext] || 'application/octet-stream'}; charset=utf-8`)
        return res.download(path, name, { dotfiles: 'allow' }, (error) => {
          if (error && !res.headersSent) TranscriptController.handleError(error, res, 'Sending a transcript')
        })
      }
      // a book's sidecars from several files have no single original: fall through to the merged VTT
    }
    if (loaded.timed) {
      res.type('text/vtt; charset=utf-8')
      return res.send(transcripts.buildVtt(loaded.cues))
    }
    res.type('text/plain; charset=utf-8')
    return res.send(loaded.text)
  }

  /**
   * POST: /api/items/:id/transcripts/generate { episodeId?, method?: 'auto'|'transcribe'|'readalong' }
   * Admin. Queues a generated transcript (202 with the job). 'auto' reuses the read-along data of an EPUB made from a
   * book's audio when there is one, otherwise transcribes through chapterbot.
   *
   * @param {RequestWithLibraryItem} req
   * @param {Response} res
   */
  async generate(req, res) {
    if (!req.user.isAdminOrUp) return res.sendStatus(403)
    const body = req.body && typeof req.body === 'object' ? req.body : {}
    const method = body.method === undefined ? 'auto' : body.method
    try {
      const job = TranscriptManager.start(req.libraryItem, TranscriptController.episodeIdFrom(body.episodeId), req.user, { origin: 'user', method })
      res.status(202).json({ job })
    } catch (error) {
      TranscriptController.handleError(error, res, 'Starting a transcript')
    }
  }

  /**
   * DELETE: /api/items/:id/transcripts/job?episodeId=
   * Admin. Cancels a queued or running generation.
   *
   * @param {RequestWithLibraryItem} req
   * @param {Response} res
   */
  async cancel(req, res) {
    if (!req.user.isAdminOrUp) return res.sendStatus(403)
    const job = TranscriptManager.cancel(req.libraryItem.id, TranscriptController.episodeIdFrom(req.query.episodeId))
    if (!job) return res.sendStatus(404)
    res.json({ job })
  }

  /**
   * DELETE: /api/items/:id/transcripts/generated?episodeId=
   * Admin. Removes the generated transcript.
   *
   * @param {RequestWithLibraryItem} req
   * @param {Response} res
   */
  async removeGenerated(req, res) {
    if (!req.user.isAdminOrUp) return res.sendStatus(403)
    try {
      const episodeId = TranscriptController.episodeIdFrom(req.query.episodeId)
      TranscriptManager.getEpisode(req.libraryItem, episodeId)
      const removed = await transcripts.removeGenerated(req.libraryItem.id, episodeId)
      if (!removed) return res.sendStatus(404)
      Logger.info(`[TranscriptController] "${req.user.username}" removed the generated transcript of "${req.libraryItem.media.title}"${episodeId ? ` episode "${episodeId}"` : ''}`)
      TranscriptManager.notifyUpdated(req.libraryItem, episodeId)
      res.sendStatus(200)
    } catch (error) {
      TranscriptController.handleError(error, res, 'Removing a transcript')
    }
  }

  /**
   * POST: /api/items/:id/transcripts/refresh-feed { episodeId? }
   * Admin. Reads the podcast's RSS feed again and stores the episodes' <podcast:transcript> tags.
   *
   * @param {RequestWithLibraryItem} req
   * @param {Response} res
   */
  async refreshFeed(req, res) {
    if (!req.user.isAdminOrUp) return res.sendStatus(403)
    const body = req.body && typeof req.body === 'object' ? req.body : {}
    try {
      const episodeId = TranscriptController.episodeIdFrom(body.episodeId)
      if (episodeId) TranscriptManager.getEpisode(req.libraryItem, episodeId)
      res.json(await TranscriptManager.refreshFromFeed(req.libraryItem, episodeId))
    } catch (error) {
      TranscriptController.handleError(error, res, 'Refreshing transcripts from the feed')
    }
  }
}
module.exports = new TranscriptController()
module.exports.TranscriptController = TranscriptController
