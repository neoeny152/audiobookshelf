const { Response } = require('express')
const Logger = require('../Logger')
const Database = require('../Database')
const AutoPipelineManager = require('../managers/AutoPipelineManager')

/**
 * Auto pipeline routes (fork only, see managers/AutoPipelineManager.js). Every route needs canUpdate and access to the
 * library (the library and library item middlewares check access); running a whole library needs an admin. When the
 * server runs without ABS_AUTO_PIPELINE=1 every route answers 404.
 *
 * @typedef {import('./LibraryItemController').LibraryItemControllerRequest} LibraryItemControllerRequest
 */

const STEPS = ['match', 'chapters', 'epub']
/** needs-work: the books whose health has an issue (AutoPipelineManager.findNeedsWork), processed again if need be */
const SCOPES = ['unprocessed', 'all', 'needs-work']

/**
 * @param {Response} res
 * @param {Error} error
 * @param {string} what
 */
function sendError(res, error, what) {
  if (error instanceof AutoPipelineManager.PipelineError) return res.status(error.status).json({ error: error.message })
  Logger.error(`[AutoPipelineController] ${what} failed`, error)
  return res.status(500).json({ error: `${what} failed` })
}

/**
 * Common checks: canUpdate, gate.
 *
 * @returns {boolean} false when a response was sent
 */
function guard(req, res) {
  if (!req.user.canUpdate) {
    Logger.warn(`[AutoPipelineController] User "${req.user.username}" attempted to use the auto pipeline without update permission`)
    res.sendStatus(403)
    return false
  }
  if (!AutoPipelineManager.enabled) {
    res.status(404).json({ error: 'The auto pipeline is not enabled on this server' })
    return false
  }
  return true
}

/**
 * Handlers are bound to the ApiRouter (as every controller), so they do not use `this`.
 */
class AutoPipelineController {
  constructor() {}

  /**
   * GET: /api/libraries/:id/pipeline?status=
   * { mode, gate, worker: { busy, current }, counts, items: [state] }
   */
  async getLibraryPipeline(req, res) {
    if (!guard(req, res)) return
    const status = typeof req.query?.status === 'string' && AutoPipelineManager.STATUSES.includes(req.query.status) ? req.query.status : null
    if (req.query?.status !== undefined && !status) return res.status(400).json({ error: `status must be one of ${AutoPipelineManager.STATUSES.join(', ')}` })
    res.json(AutoPipelineManager.getLibrarySummary(req.library, status))
  }

  /**
   * POST: /api/libraries/:id/pipeline/run { scope: 'unprocessed' | 'all' | 'needs-work', except?: [libraryItemId] } -> { queued }
   * except: books the needs-work scope leaves out (the book a guide just fixed).
   * Admin only.
   */
  async runLibraryPipeline(req, res) {
    if (!guard(req, res)) return
    if (!req.user.isAdminOrUp) {
      Logger.warn(`[AutoPipelineController] Non-admin user "${req.user.username}" attempted to run the auto pipeline on a library`)
      return res.sendStatus(403)
    }
    const scope = req.body?.scope ?? 'unprocessed'
    if (!SCOPES.includes(scope)) return res.status(400).json({ error: `scope must be one of ${SCOPES.join(', ')}` })
    const except = req.body?.except ?? []
    if (!Array.isArray(except) || except.some((id) => typeof id !== 'string')) return res.status(400).json({ error: 'except must be an array of item ids' })
    try {
      if (scope === 'needs-work') {
        // Books on the pipeline or waiting for a review are left as they are
        const ids = (await AutoPipelineManager.findNeedsWork(req.library, req.user))
          .map((item) => item.libraryItemId)
          .filter((id) => {
            const status = AutoPipelineManager.getState(id)?.status
            return !except.includes(id) && !AutoPipelineManager.ACTIVE_STATUSES.has(status) && status !== 'needs-review'
          })
        return res.json(await AutoPipelineManager.runLibrary(req.library, 'all', { libraryItemIds: ids }))
      }
      res.json(await AutoPipelineManager.runLibrary(req.library, scope))
    } catch (error) {
      sendError(res, error, 'Queueing the library')
    }
  }

  /**
   * GET: /api/items/:id/pipeline
   */
  async getItemPipeline(req, res) {
    if (!guard(req, res)) return
    const state = AutoPipelineManager.getState(req.libraryItem.id)
    if (!state) return res.status(404).json({ error: 'The item is not in the auto pipeline' })
    res.json(state)
  }

  /**
   * POST: /api/items/:id/pipeline/run { steps?: ['match','chapters','epub'], force?: boolean, fix?: boolean, repairSeekIndex?: boolean } -> 202 state
   * force analyses chapters a person edited too; applying them still goes through review. fix: "Fix automatically"
   * (match and chapters, force, match threshold FIX_MIN_CONFIDENCE). repairSeekIndex (admin): MP3s that need it may
   * be rewritten in this run.
   */
  async runItemPipeline(req, res) {
    if (!guard(req, res)) return
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
    let steps = null
    if (body.steps !== undefined && body.steps !== null) {
      if (!Array.isArray(body.steps) || !body.steps.length || body.steps.some((s) => !STEPS.includes(s))) return res.status(400).json({ error: `steps must be a non-empty array of ${STEPS.join(', ')}` })
      steps = [...new Set(body.steps)]
    }
    for (const key of ['force', 'fix', 'repairSeekIndex']) {
      if (body[key] !== undefined && typeof body[key] !== 'boolean') return res.status(400).json({ error: `${key} must be a boolean` })
    }
    if (body.repairSeekIndex && !req.user.isAdminOrUp) {
      Logger.warn(`[AutoPipelineController] Non-admin user "${req.user.username}" attempted to allow a seek index repair`)
      return res.sendStatus(403)
    }
    try {
      const library = await Database.libraryModel.findByPk(req.libraryItem.libraryId)
      if (!library) return res.sendStatus(404)
      res.status(202).json(await AutoPipelineManager.runItem(req.libraryItem, library, { steps, force: !!body.force, fix: !!body.fix, repairConsent: !!body.repairSeekIndex, userId: req.user.id }))
    } catch (error) {
      sendError(res, error, 'Queueing the item')
    }
  }

  /**
   * DELETE: /api/items/:id/pipeline
   * Remove the item from the queue or dismiss its result. A running EPUB job is not cancelled. 409 while the worker is on
   * the item.
   */
  async dismissItemPipeline(req, res) {
    if (!guard(req, res)) return
    try {
      if (!(await AutoPipelineManager.dismiss(req.libraryItem.id))) return res.status(404).json({ error: 'The item is not in the auto pipeline' })
      res.sendStatus(200)
    } catch (error) {
      sendError(res, error, 'Dismissing the item')
    }
  }

  /**
   * GET: /api/items/:id/pipeline/proposal
   * { source, diffSec, snap (full chapter snap response, with speech), failing: [{index, why}], blockers, proposedChapters, ... }
   */
  async getProposal(req, res) {
    if (!guard(req, res)) return
    try {
      const proposal = await AutoPipelineManager.getProposal(req.libraryItem.id)
      if (!proposal) return res.status(404).json({ error: 'No chapter proposal for this item' })
      res.json(proposal)
    } catch (error) {
      sendError(res, error, 'Reading the proposal')
    }
  }

  /**
   * POST: /api/items/:id/pipeline/proposal/approve { chapters? }
   * Backs up the current chapters, applies the proposal (or the edited chapters) and continues with the EPUB step.
   */
  async approveProposal(req, res) {
    if (!guard(req, res)) return
    try {
      res.json(await AutoPipelineManager.approve(req.libraryItem.id, req.body?.chapters))
    } catch (error) {
      sendError(res, error, 'Approving the proposal')
    }
  }

  /**
   * POST: /api/items/:id/pipeline/proposal/reject { continue?: boolean }
   */
  async rejectProposal(req, res) {
    if (!guard(req, res)) return
    if (req.body?.continue !== undefined && typeof req.body.continue !== 'boolean') return res.status(400).json({ error: 'continue must be a boolean' })
    try {
      res.json(await AutoPipelineManager.reject(req.libraryItem.id, { continue: !!req.body?.continue }))
    } catch (error) {
      sendError(res, error, 'Rejecting the proposal')
    }
  }

  /**
   * GET: /api/items/:id/pipeline/backups -> { backups: [{name, createdAt, source, reason, chapters}] } newest first
   */
  async listBackups(req, res) {
    if (!guard(req, res)) return
    try {
      res.json({ backups: await AutoPipelineManager.listBackups(req.libraryItem.id) })
    } catch (error) {
      sendError(res, error, 'Listing the backups')
    }
  }

  /**
   * POST: /api/items/:id/pipeline/backups/:name/restore
   * Puts the chapters of a backup back (undo). The current chapters are backed up first.
   */
  async restoreBackup(req, res) {
    if (!guard(req, res)) return
    try {
      res.json(await AutoPipelineManager.restoreBackup(req.libraryItem, req.params.name))
    } catch (error) {
      sendError(res, error, 'Restoring the backup')
    }
  }
}
module.exports = new AutoPipelineController()
