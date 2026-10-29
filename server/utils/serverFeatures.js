const { version } = require('../../package.json')

/**
 * Optional server capabilities that clients can feature-detect.
 *
 * Exposed as `serverFeatures` in GET /status. The field is purely additive: stock clients
 * (web, iOS, Android) ignore unknown keys, and clients that look for it must treat a missing
 * field (stock server) as an empty list and fall back to the per-item endpoints.
 *
 * Feature names are stable identifiers; never rename or reuse one.
 *
 * - batchEpisodes: POST /api/podcasts/batch/episodes/update and /api/podcasts/batch/episodes/delete
 * - libraryDownloadPost: POST /api/libraries/:id/download with ids in the request body
 * - readAlong: GET /api/items/:id/ebook/:fileid/readalong, sentence timings of an EPUB made from the item's audio
 *   (404 when that EPUB has none; see utils/readAlong.js). Always listed: serving stored data needs no sidecar.
 *
 * Optional features, only listed while they work (see utils/chapterbotClient.js advertisedFeatures):
 * - chapterbotVerify: POST /api/items/:id/chapters/snap accepts options.verify = true (Whisper speech check)
 * - chapterbotEpub: POST /api/items/:id/epub, GET and DELETE /api/items/:id/epub/:jobId (EPUB from audio)
 * - chapterbotEpubCurrent: GET /api/items/:id/epub returns the item's current EPUB job without a job id (any user who
 *   can access the item), and chapterbot_epub_updated socket events carry its progress to everyone who can see the
 *   item. Listed together with chapterbotEpub.
 * - autoPipeline: hands-off processing of new books (match, chapters, EPUB), GET/POST /api/libraries/:id/pipeline[/run],
 *   /api/items/:id/pipeline[/run|/proposal|/proposal/approve|/proposal/reject|/backups|/backups/:name/restore],
 *   library.settings.autoPipeline and pipeline_item_updated socket events. Listed only when the server runs with
 *   ABS_AUTO_PIPELINE=1 (see managers/AutoPipelineManager.js).
 */
const SERVER_FEATURES = Object.freeze(['batchEpisodes', 'libraryDownloadPost', 'readAlong'])
const OPTIONAL_FEATURES = Object.freeze(['chapterbotVerify', 'chapterbotEpub', 'chapterbotEpubCurrent', 'autoPipeline'])

/**
 * The optional features that are available right now.
 *
 * @param {string[]} chapterbotFeatures - chapterbotClient.advertisedFeatures()
 * @param {{autoPipeline?: boolean}} [flags]
 * @returns {string[]}
 */
function availableOptionalFeatures(chapterbotFeatures = [], { autoPipeline = false } = {}) {
  const features = [...chapterbotFeatures]
  if (chapterbotFeatures.includes('chapterbotEpub')) features.push('chapterbotEpubCurrent')
  if (autoPipeline) features.push('autoPipeline')
  return features
}

/**
 * Payload for GET /status (unauthenticated).
 * Keys are the same as before serverFeatures was added; serverFeatures is the only addition.
 *
 * @param {{ hasRootUser: boolean, serverSettings: { language: string, authActiveAuthMethods: string[], authFormData: Object } }} Database
 * @param {string[]} [optionalFeatures] - currently available optional features; anything not in OPTIONAL_FEATURES is ignored
 * @returns {Object}
 */
function buildStatusPayload(Database, optionalFeatures = []) {
  // status check for client to see if server has been initialized
  // server has been initialized if a root user exists
  const payload = {
    app: 'audiobookshelf',
    serverVersion: version,
    isInit: Database.hasRootUser,
    language: Database.serverSettings.language,
    authMethods: Database.serverSettings.authActiveAuthMethods,
    authFormData: Database.serverSettings.authFormData,
    serverFeatures: [...SERVER_FEATURES, ...OPTIONAL_FEATURES.filter((f) => optionalFeatures.includes(f))]
  }
  if (!payload.isInit) {
    payload.ConfigPath = global.ConfigPath
    payload.MetadataPath = global.MetadataPath
  }
  return payload
}

module.exports = { SERVER_FEATURES, OPTIONAL_FEATURES, availableOptionalFeatures, buildStatusPayload }
