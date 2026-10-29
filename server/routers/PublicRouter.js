const express = require('express')
const { wrapAsyncRoutes, apiErrorHandler } = require('../utils/asyncRouteHandler')
const ShareController = require('../controllers/ShareController')
const SessionController = require('../controllers/SessionController')

class PublicRouter {
  constructor(playbackSessionManager) {
    /** @type {import('../managers/PlaybackSessionManager')} */
    this.playbackSessionManager = playbackSessionManager

    // Rejected async handlers go to the error handler instead of crashing the server
    this.router = wrapAsyncRoutes(express())
    this.router.disable('x-powered-by')
    this.init()
    this.router.use(apiErrorHandler('PublicRouter'))
  }

  init() {
    this.router.get('/share/:slug', ShareController.getMediaItemShareBySlug.bind(this))
    this.router.get('/share/:slug/track/:index', ShareController.getMediaItemShareAudioTrack.bind(this))
    this.router.get('/share/:slug/cover', ShareController.getMediaItemShareCoverImage.bind(this))
    this.router.get('/share/:slug/download', ShareController.downloadMediaItemShare.bind(this))
    this.router.patch('/share/:slug/progress', ShareController.updateMediaItemShareProgress.bind(this))
    this.router.get('/session/:id/track/:index', SessionController.getTrack.bind(this))
  }
}
module.exports = PublicRouter
