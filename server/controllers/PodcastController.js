const Path = require('path')
const { Request, Response, NextFunction } = require('express')
const Logger = require('../Logger')
const SocketAuthority = require('../SocketAuthority')
const Database = require('../Database')

const fs = require('../libs/fsExtra')
const cron = require('../libs/nodeCron')

const { getPodcastFeed, findMatchingEpisodes } = require('../utils/podcastUtils')
const { getFileTimestampsWithIno, filePathToPOSIX, isSameOrSubPath } = require('../utils/fileUtils')
const transcripts = require('../utils/transcripts')
const { validateUrl } = require('../utils/index')
const htmlSanitizer = require('../utils/htmlSanitizer')

const Scanner = require('../scanner/Scanner')
const CoverManager = require('../managers/CoverManager')

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

/**
 * Build the sanitized episode update payload from a request body.
 * Shared by PATCH /api/podcasts/:id/episode/:episodeId and POST /api/podcasts/batch/episodes/update
 * so that both accept exactly the same keys with the same validation.
 *
 * @param {Object} body
 * @returns {Object} payload to pass to PodcastEpisode.set()
 */
function buildEpisodeUpdatePayload(body) {
  const updatePayload = {}
  if (!body || typeof body !== 'object') return updatePayload

  const supportedStringKeys = ['title', 'subtitle', 'description', 'pubDate', 'episode', 'season', 'episodeType']
  for (const key in body) {
    if (supportedStringKeys.includes(key) && typeof body[key] === 'string') {
      let value = body[key]
      // Sanitize description HTML
      if (key === 'description' && value) {
        const sanitizedDescription = htmlSanitizer.sanitize(value)
        if (sanitizedDescription !== value) {
          Logger.debug(`[PodcastController] Sanitized description from "${value}" to "${sanitizedDescription}"`)
          value = sanitizedDescription
        }
      } else if (key === 'subtitle' && value) {
        const sanitizedSubtitle = htmlSanitizer.sanitize(value)
        if (sanitizedSubtitle !== value) {
          Logger.debug(`[PodcastController] Sanitized subtitle from "${value}" to "${sanitizedSubtitle}"`)
          value = sanitizedSubtitle
        }
      }

      updatePayload[key] = value
    } else if (key === 'enclosure') {
      const enclosure = body.enclosure
      if (enclosure === null) {
        updatePayload.enclosureURL = null
        updatePayload.enclosureSize = null
        updatePayload.enclosureType = null
      } else if (typeof enclosure === 'object' && typeof enclosure.url === 'string') {
        updatePayload.enclosureURL = enclosure.url
        updatePayload.enclosureType = typeof enclosure.type === 'string' ? enclosure.type : null
        updatePayload.enclosureSize = enclosure.length !== undefined && enclosure.length !== null ? enclosure.length : null
      }
    } else if (key === 'chapters' && Array.isArray(body[key]) && body[key].every((ch) => ch && typeof ch === 'object' && ch.title && ch.start)) {
      updatePayload[key] = body[key]
    } else if (key === 'publishedAt' && typeof body[key] === 'number') {
      updatePayload[key] = body[key]
    }
  }
  return updatePayload
}

/**
 * Validate and load the podcasts referenced by a batch episode request.
 *
 * Applies the same checks as PodcastController.middleware does for the per-episode routes,
 * for every podcast in the batch, before anything is changed:
 *  - library item must exist and have media (404)
 *  - library item must be a podcast (400)
 *  - user must be able to access the library item, incl. library access, explicit content and tags (403)
 *  - every episode must belong to its listed podcast (404)
 *
 * The whole batch is rejected if any entry fails, so nothing is changed unless every entry is valid.
 *
 * @param {RequestWithUser} req
 * @param {Response} res
 * @param {{ libraryItemId: string, episodeId: string }[]} entries
 * @returns {Promise<{ libraryItem: import('../models/LibraryItem').LibraryItemExpanded, entries: { episode: import('../models/PodcastEpisode'), entry: Object }[] }[] | null>} groups in first-seen order, or null if a response was sent
 */
async function loadPodcastEpisodeBatch(req, res, entries) {
  // Group entries by podcast, keeping first-seen order
  /** @type {Map<string, Object[]>} */
  const entriesByLibraryItemId = new Map()
  const seenPairs = new Set()
  for (const entry of entries) {
    const pairKey = `${entry.libraryItemId}/${entry.episodeId}`
    if (seenPairs.has(pairKey)) {
      res.status(400).send('Duplicate episode in batch')
      return null
    }
    seenPairs.add(pairKey)

    if (!entriesByLibraryItemId.has(entry.libraryItemId)) entriesByLibraryItemId.set(entry.libraryItemId, [])
    entriesByLibraryItemId.get(entry.libraryItemId).push(entry)
  }

  const libraryItemIds = [...entriesByLibraryItemId.keys()]
  const libraryItems = await Database.libraryItemModel.findAllExpandedWhere({ id: libraryItemIds })
  const libraryItemMap = new Map(libraryItems.map((li) => [li.id, li]))

  const groups = []
  for (const libraryItemId of libraryItemIds) {
    const libraryItem = libraryItemMap.get(libraryItemId)
    if (!libraryItem?.media) {
      Logger.warn(`[PodcastController] Batch episodes: library item "${libraryItemId}" not found`)
      res.status(404).send('Library item not found')
      return null
    }
    if (!libraryItem.isPodcast) {
      Logger.warn(`[PodcastController] Batch episodes: library item "${libraryItemId}" is not a podcast`)
      res.status(400).send('Library item is not a podcast')
      return null
    }
    if (!req.user.checkCanAccessLibraryItem(libraryItem)) {
      Logger.warn(`[PodcastController] Batch episodes: user "${req.user.username}" cannot access library item "${libraryItemId}"`)
      res.sendStatus(403)
      return null
    }

    const episodeMap = new Map((libraryItem.media.podcastEpisodes || []).map((ep) => [ep.id, ep]))
    const groupEntries = []
    for (const entry of entriesByLibraryItemId.get(libraryItemId)) {
      const episode = episodeMap.get(entry.episodeId)
      if (!episode) {
        Logger.warn(`[PodcastController] Batch episodes: episode "${entry.episodeId}" not found in library item "${libraryItemId}"`)
        res.status(404).send('Episode not found')
        return null
      }
      groupEntries.push({ episode, entry })
    }
    groups.push({ libraryItem, entries: groupEntries })
  }
  return groups
}

/**
 * @param {*} entries
 * @param {boolean} requireUpdates
 * @returns {boolean}
 */
function isValidEpisodeBatchEntries(entries, requireUpdates) {
  if (!Array.isArray(entries) || !entries.length) return false
  return entries.every((e) => {
    if (!e || typeof e !== 'object') return false
    if (typeof e.libraryItemId !== 'string' || !e.libraryItemId) return false
    if (typeof e.episodeId !== 'string' || !e.episodeId) return false
    if (requireUpdates && (!e.updates || typeof e.updates !== 'object' || Array.isArray(e.updates))) return false
    return true
  })
}

class PodcastController {
  /**
   * POST /api/podcasts
   * Create podcast
   *
   * @this import('../routers/ApiRouter')
   *
   * @param {RequestWithUser} req
   * @param {Response} res
   */
  async create(req, res) {
    if (!req.user.isAdminOrUp) {
      Logger.error(`[PodcastController] Non-admin user "${req.user.username}" attempted to create podcast`)
      return res.sendStatus(403)
    }
    const payload = req.body
    if (!payload.media || !payload.media.metadata) {
      return res.status(400).send('Invalid request body. "media" and "media.metadata" are required')
    }

    if (payload.media.autoDownloadSchedule && !cron.validate(payload.media.autoDownloadSchedule)) {
      Logger.error(`[PodcastController] Invalid auto download schedule cron expression "${payload.media.autoDownloadSchedule}"`)
      return res.status(400).send('Invalid auto download schedule cron expression')
    }

    const library = await Database.libraryModel.findByIdWithFolders(payload.libraryId)
    if (!library) {
      Logger.error(`[PodcastController] Create: Library not found "${payload.libraryId}"`)
      return res.status(404).send('Library not found')
    }

    const folder = library.libraryFolders.find((fold) => fold.id === payload.folderId)
    if (!folder) {
      Logger.error(`[PodcastController] Create: Folder not found "${payload.folderId}"`)
      return res.status(404).send('Folder not found')
    }

    if (typeof payload.path !== 'string' || !payload.path.trim()) {
      return res.status(400).send('Invalid request body. "path" must be a non-empty string')
    }

    const libraryFolderPath = filePathToPOSIX(folder.path)
    const podcastPath = filePathToPOSIX(payload.path)

    if (!isSameOrSubPath(libraryFolderPath, podcastPath)) {
      Logger.error(`[PodcastController] Create: Podcast path is outside library folder "${libraryFolderPath}": "${podcastPath}"`)
      return res.status(400).send('Podcast path must be inside the selected library folder')
    }

    // Check if a library item with this podcast folder exists already
    const existingLibraryItem =
      (await Database.libraryItemModel.count({
        where: {
          path: podcastPath
        }
      })) > 0
    if (existingLibraryItem) {
      Logger.error(`[PodcastController] Podcast already exists at path "${podcastPath}"`)
      return res.status(400).send('Podcast already exists')
    }

    const success = await fs
      .ensureDir(podcastPath)
      .then(() => true)
      .catch((error) => {
        Logger.error(`[PodcastController] Failed to ensure podcast dir "${podcastPath}"`, error)
        return false
      })
    if (!success) return res.status(400).send('Invalid podcast path')

    const libraryItemFolderStats = await getFileTimestampsWithIno(podcastPath)

    let relPath = podcastPath.replace(libraryFolderPath, '')
    if (relPath.startsWith('/')) relPath = relPath.slice(1)

    let newLibraryItem = null
    const transaction = await Database.sequelize.transaction()
    try {
      const podcast = await Database.podcastModel.createFromRequest(payload.media, transaction)

      newLibraryItem = await Database.libraryItemModel.create(
        {
          ino: libraryItemFolderStats.ino,
          path: podcastPath,
          relPath,
          mediaId: podcast.id,
          mediaType: 'podcast',
          isFile: false,
          isMissing: false,
          isInvalid: false,
          mtime: libraryItemFolderStats.mtimeMs || 0,
          ctime: libraryItemFolderStats.ctimeMs || 0,
          birthtime: libraryItemFolderStats.birthtimeMs || 0,
          size: 0,
          libraryFiles: [],
          extraData: {},
          libraryId: library.id,
          libraryFolderId: folder.id,
          title: podcast.title,
          titleIgnorePrefix: podcast.titleIgnorePrefix
        },
        { transaction }
      )

      await transaction.commit()
    } catch (error) {
      Logger.error(`[PodcastController] Failed to create podcast: ${error}`)
      await transaction.rollback()
      return res.status(500).send('Failed to create podcast')
    }

    newLibraryItem.media = await newLibraryItem.getMediaExpanded()

    // Download and save cover image
    if (typeof payload.media.metadata.imageUrl === 'string' && payload.media.metadata.imageUrl.startsWith('http')) {
      // Podcast cover will always go into library item folder
      const coverResponse = await CoverManager.downloadCoverFromUrlNew(payload.media.metadata.imageUrl, newLibraryItem.id, newLibraryItem.path, true)
      if (coverResponse.error) {
        Logger.error(`[PodcastController] Download cover error from "${payload.media.metadata.imageUrl}": ${coverResponse.error}`)
      } else if (coverResponse.cover) {
        const coverImageFileStats = await getFileTimestampsWithIno(coverResponse.cover)
        if (!coverImageFileStats) {
          Logger.error(`[PodcastController] Failed to get cover image stats for "${coverResponse.cover}"`)
        } else {
          // Add libraryFile to libraryItem and coverPath to podcast
          const newLibraryFile = {
            ino: coverImageFileStats.ino,
            fileType: 'image',
            addedAt: Date.now(),
            updatedAt: Date.now(),
            metadata: {
              filename: Path.basename(coverResponse.cover),
              ext: Path.extname(coverResponse.cover).slice(1),
              path: coverResponse.cover,
              relPath: Path.basename(coverResponse.cover),
              size: coverImageFileStats.size,
              mtimeMs: coverImageFileStats.mtimeMs || 0,
              ctimeMs: coverImageFileStats.ctimeMs || 0,
              birthtimeMs: coverImageFileStats.birthtimeMs || 0
            }
          }
          newLibraryItem.libraryFiles.push(newLibraryFile)
          newLibraryItem.changed('libraryFiles', true)
          await newLibraryItem.save()

          newLibraryItem.media.coverPath = coverResponse.cover
          await newLibraryItem.media.save()
        }
      }
    }

    SocketAuthority.libraryItemEmitter('item_added', newLibraryItem)
    // The same feed may already be in the library (#5676)
    require('../managers/DuplicateItemManager').scheduleCheck(newLibraryItem.libraryId)

    res.json(newLibraryItem.toOldJSONExpanded())

    // Turn on podcast auto download cron if not already on
    if (newLibraryItem.media.autoDownloadEpisodes) {
      this.cronManager.checkUpdatePodcastCron(newLibraryItem)
    }
  }

  /**
   * POST: /api/podcasts/feed
   *
   * @typedef getPodcastFeedReqBody
   * @property {string} rssFeed
   *
   * @param {Request<{}, {}, getPodcastFeedReqBody, {}> & RequestUserObject} req
   * @param {Response} res
   */
  async getPodcastFeed(req, res) {
    if (!req.user.isAdminOrUp) {
      Logger.error(`[PodcastController] Non-admin user "${req.user.username}" attempted to get podcast feed`)
      return res.sendStatus(403)
    }

    const url = validateUrl(req.body.rssFeed)
    if (!url) {
      return res.status(400).send('Invalid request body. "rssFeed" must be a valid URL')
    }

    const podcast = await getPodcastFeed(url)
    if (!podcast) {
      return res.status(404).send('Podcast RSS feed request failed or invalid response data')
    }
    res.json({ podcast })
  }

  /**
   * POST: /api/podcasts/opml
   *
   * @this import('../routers/ApiRouter')
   *
   * @param {RequestWithUser} req
   * @param {Response} res
   */
  async getFeedsFromOPMLText(req, res) {
    if (!req.user.isAdminOrUp) {
      Logger.error(`[PodcastController] Non-admin user "${req.user.username}" attempted to get feeds from opml`)
      return res.sendStatus(403)
    }

    if (!req.body.opmlText) {
      return res.sendStatus(400)
    }

    res.json({
      feeds: this.podcastManager.getParsedOPMLFileFeeds(req.body.opmlText)
    })
  }

  /**
   * POST: /api/podcasts/opml/create
   *
   * @this import('../routers/ApiRouter')
   *
   * @param {RequestWithUser} req
   * @param {Response} res
   */
  async bulkCreatePodcastsFromOpmlFeedUrls(req, res) {
    if (!req.user.isAdminOrUp) {
      Logger.error(`[PodcastController] Non-admin user "${req.user.username}" attempted to bulk create podcasts`)
      return res.sendStatus(403)
    }

    const rssFeeds = req.body.feeds
    if (!Array.isArray(rssFeeds) || !rssFeeds.length || rssFeeds.some((feed) => !validateUrl(feed))) {
      return res.status(400).send('Invalid request body. "feeds" must be an array of RSS feed URLs')
    }

    const libraryId = req.body.libraryId
    const folderId = req.body.folderId
    if (!libraryId || !folderId) {
      return res.status(400).send('Invalid request body. "libraryId" and "folderId" are required')
    }

    const folder = await Database.libraryFolderModel.findByPk(folderId)
    if (!folder || folder.libraryId !== libraryId) {
      return res.status(404).send('Folder not found')
    }
    const autoDownloadEpisodes = !!req.body.autoDownloadEpisodes
    this.podcastManager.createPodcastsFromFeedUrls(rssFeeds, folder, autoDownloadEpisodes, this.cronManager)

    res.sendStatus(200)
  }

  /**
   * GET: /api/podcasts/:id/checknew
   *
   * @this import('../routers/ApiRouter')
   *
   * @param {RequestWithLibraryItem} req
   * @param {Response} res
   */
  async checkNewEpisodes(req, res) {
    if (!req.user.isAdminOrUp) {
      Logger.error(`[PodcastController] Non-admin user "${req.user.username}" attempted to check/download episodes`)
      return res.sendStatus(403)
    }

    if (!req.libraryItem.media.feedURL) {
      Logger.error(`[PodcastController] checkNewEpisodes no feed url for item ${req.libraryItem.id}`)
      return res.status(400).send('Podcast has no rss feed url')
    }

    const maxEpisodesToDownload = !isNaN(req.query.limit) ? Number(req.query.limit) : 3

    const newEpisodes = await this.podcastManager.checkAndDownloadNewEpisodes(req.libraryItem, maxEpisodesToDownload)
    res.json({
      episodes: newEpisodes || []
    })
  }

  /**
   * GET: /api/podcasts/:id/clear-queue
   *
   * @this {import('../routers/ApiRouter')}
   *
   * @param {RequestWithUser} req
   * @param {Response} res
   */
  clearEpisodeDownloadQueue(req, res) {
    if (!req.user.isAdminOrUp) {
      Logger.error(`[PodcastController] Non-admin user "${req.user.username}" attempting to clear download queue`)
      return res.sendStatus(403)
    }
    this.podcastManager.clearDownloadQueue(req.params.id)
    res.sendStatus(200)
  }

  /**
   * GET: /api/podcasts/:id/downloads
   *
   * @this {import('../routers/ApiRouter')}
   *
   * @param {RequestWithLibraryItem} req
   * @param {Response} res
   */
  getEpisodeDownloads(req, res) {
    const downloadsInQueue = this.podcastManager.getEpisodeDownloadsInQueue(req.libraryItem.id)
    res.json({
      downloads: downloadsInQueue.map((d) => d.toJSONForClient())
    })
  }

  /**
   * GET: /api/podcasts/:id/search-episode
   * Search for an episode in a podcast
   *
   * @param {RequestWithLibraryItem} req
   * @param {Response} res
   */
  async findEpisode(req, res) {
    const rssFeedUrl = req.libraryItem.media.feedURL
    if (!rssFeedUrl) {
      Logger.error(`[PodcastController] findEpisode: Podcast has no feed url`)
      return res.status(400).send('Podcast does not have an RSS feed URL')
    }

    const searchTitle = req.query.title
    if (!searchTitle || typeof searchTitle !== 'string') {
      return res.sendStatus(500)
    }
    const episodes = await findMatchingEpisodes(rssFeedUrl, searchTitle)
    res.json({
      episodes: episodes || []
    })
  }

  /**
   * POST: /api/podcasts/:id/download-episodes
   *
   * @this {import('../routers/ApiRouter')}
   *
   * @param {RequestWithLibraryItem} req
   * @param {Response} res
   */
  async downloadEpisodes(req, res) {
    if (!req.user.isAdminOrUp) {
      Logger.error(`[PodcastController] Non-admin user "${req.user.username}" attempted to download episodes`)
      return res.sendStatus(403)
    }

    const episodes = req.body
    if (!Array.isArray(episodes) || !episodes.length) {
      return res.sendStatus(400)
    }

    this.podcastManager.downloadPodcastEpisodes(req.libraryItem, episodes)
    res.sendStatus(200)
  }

  /**
   * POST: /api/podcasts/:id/match-episodes
   *
   * @this {import('../routers/ApiRouter')}
   *
   * @param {RequestWithLibraryItem} req
   * @param {Response} res
   */
  async quickMatchEpisodes(req, res) {
    if (!req.user.isAdminOrUp) {
      Logger.error(`[PodcastController] Non-admin user "${req.user.username}" attempted to download episodes`)
      return res.sendStatus(403)
    }

    const overrideDetails = req.query.override === '1'
    const episodesUpdated = await Scanner.quickMatchPodcastEpisodes(req.libraryItem, { overrideDetails })
    if (episodesUpdated) {
      SocketAuthority.libraryItemEmitter('item_updated', req.libraryItem)
    }

    res.json({
      numEpisodesUpdated: episodesUpdated
    })
  }

  /**
   * PATCH: /api/podcasts/:id/episode/:episodeId
   *
   * @param {RequestWithLibraryItem} req
   * @param {Response} res
   */
  async updateEpisode(req, res) {
    /** @type {import('../models/PodcastEpisode')} */
    const episode = req.libraryItem.media.podcastEpisodes.find((ep) => ep.id === req.params.episodeId)
    if (!episode) {
      return res.status(404).send('Episode not found')
    }

    const updatePayload = buildEpisodeUpdatePayload(req.body)

    if (Object.keys(updatePayload).length) {
      episode.set(updatePayload)
      if (episode.changed()) {
        Logger.info(`[PodcastController] Updated episode "${episode.title}" keys`, episode.changed())
        await episode.save()

        SocketAuthority.libraryItemEmitter('item_updated', req.libraryItem)
      } else {
        Logger.info(`[PodcastController] No changes to episode "${episode.title}"`)
      }
    }

    res.json(req.libraryItem.toOldJSONExpanded())
  }

  /**
   * GET: /api/podcasts/:id/episode/:episodeId
   *
   * @param {RequestWithLibraryItem} req
   * @param {Response} res
   */
  async getEpisode(req, res) {
    const episodeId = req.params.episodeId

    /** @type {import('../models/PodcastEpisode')} */
    const episode = req.libraryItem.media.podcastEpisodes.find((ep) => ep.id === episodeId)
    if (!episode) {
      Logger.error(`[PodcastController] getEpisode episode ${episodeId} not found for item ${req.libraryItem.id}`)
      return res.sendStatus(404)
    }

    res.json(episode.toOldJSON(req.libraryItem.id))
  }

  /**
   * DELETE: /api/podcasts/:id/episode/:episodeId
   *
   * @param {RequestWithLibraryItem} req
   * @param {Response} res
   */
  async removeEpisode(req, res) {
    const episodeId = req.params.episodeId
    const hardDelete = req.query.hard === '1'

    /** @type {import('../models/PodcastEpisode')} */
    const episode = req.libraryItem.media.podcastEpisodes.find((ep) => ep.id === episodeId)
    if (!episode) {
      Logger.error(`[PodcastController] removeEpisode episode ${episodeId} not found for item ${req.libraryItem.id}`)
      return res.sendStatus(404)
    }

    // Remove it from the podcastEpisodes array
    req.libraryItem.media.podcastEpisodes = req.libraryItem.media.podcastEpisodes.filter((ep) => ep.id !== episodeId)

    if (hardDelete) {
      const audioFile = episode.audioFile
      // TODO: this will trigger the watcher. should maybe handle this gracefully
      await fs
        .remove(audioFile.metadata.path)
        .then(() => {
          Logger.info(`[PodcastController] Hard deleted episode file at "${audioFile.metadata.path}"`)
        })
        .catch((error) => {
          Logger.error(`[PodcastController] Failed to hard delete episode file at "${audioFile.metadata.path}"`, error)
        })
    }

    // Remove episode from playlists
    await Database.playlistModel.removeMediaItemsFromPlaylists([episodeId])

    // Remove media progress for this episode
    const mediaProgressRemoved = await Database.mediaProgressModel.destroy({
      where: {
        mediaItemId: episode.id
      }
    })
    if (mediaProgressRemoved) {
      Logger.info(`[PodcastController] Removed ${mediaProgressRemoved} media progress for episode ${episode.id}`)
    }

    // Remove episode
    await episode.destroy()
    // Stored transcripts of the episode (fork feature transcripts)
    transcripts.removeEpisodeFiles(req.libraryItem.id, episode.id).catch(() => {})

    // Remove library file
    req.libraryItem.libraryFiles = req.libraryItem.libraryFiles.filter((file) => file.ino !== episode.audioFile.ino)
    req.libraryItem.changed('libraryFiles', true)
    await req.libraryItem.save()

    // update number of episodes
    req.libraryItem.media.numEpisodes = req.libraryItem.media.podcastEpisodes.length
    await req.libraryItem.media.save()

    SocketAuthority.libraryItemEmitter('item_updated', req.libraryItem)
    res.json(req.libraryItem.toOldJSON())
  }

  /**
   * POST: /api/podcasts/batch/episodes/update
   * Update many episodes, possibly across several podcasts, in one request.
   * Each podcast is loaded once and emits at most one item_updated event.
   *
   * Body: { episodes: [{ libraryItemId: string, episodeId: string, updates: Object }] }
   * "updates" accepts exactly the same keys as PATCH /api/podcasts/:id/episode/:episodeId
   *
   * Response: { success: true, numEpisodesUpdated: number, libraryItems: LibraryItemExpanded[] }
   * libraryItems contains every podcast referenced by the request (old JSON expanded)
   *
   * @param {RequestWithUser} req
   * @param {Response} res
   */
  async batchUpdateEpisodes(req, res) {
    // Same permission as PATCH /api/podcasts/:id/episode/:episodeId (PodcastController.middleware)
    if (!req.user.canUpdate) {
      Logger.warn(`[PodcastController] User "${req.user.username}" attempted to update without permission`)
      return res.sendStatus(403)
    }

    const entries = req.body?.episodes
    if (!isValidEpisodeBatchEntries(entries, true)) {
      return res.status(400).send('Invalid request body')
    }

    const groups = await loadPodcastEpisodeBatch(req, res, entries)
    if (!groups) return

    let numEpisodesUpdated = 0
    for (const { libraryItem, entries: groupEntries } of groups) {
      let podcastUpdated = false
      for (const { episode, entry } of groupEntries) {
        const updatePayload = buildEpisodeUpdatePayload(entry.updates)
        if (!Object.keys(updatePayload).length) continue

        episode.set(updatePayload)
        if (episode.changed()) {
          Logger.info(`[PodcastController] Updated episode "${episode.title}" keys`, episode.changed())
          await episode.save()
          numEpisodesUpdated++
          podcastUpdated = true
        }
      }

      if (podcastUpdated) {
        SocketAuthority.libraryItemEmitter('item_updated', libraryItem)
      }
    }

    res.json({
      success: true,
      numEpisodesUpdated,
      libraryItems: groups.map((g) => g.libraryItem.toOldJSONExpanded())
    })
  }

  /**
   * POST: /api/podcasts/batch/episodes/delete
   * Remove many episodes, possibly across several podcasts, in one request.
   * Each podcast is loaded and saved once and emits a single item_updated event.
   *
   * Body: { episodes: [{ libraryItemId: string, episodeId: string }], hard?: boolean }
   * Optional query param ?hard=1 (same as DELETE /api/podcasts/:id/episode/:episodeId)
   *
   * Response: { success: true, numEpisodesDeleted: number, libraryItems: LibraryItem[] }
   * libraryItems contains every podcast referenced by the request (old JSON, not expanded)
   *
   * @param {RequestWithUser} req
   * @param {Response} res
   */
  async batchDeleteEpisodes(req, res) {
    // Same permission as DELETE /api/podcasts/:id/episode/:episodeId (PodcastController.middleware)
    if (!req.user.canDelete) {
      Logger.warn(`[PodcastController] User "${req.user.username}" attempted to delete without permission`)
      return res.sendStatus(403)
    }

    const entries = req.body?.episodes
    if (!isValidEpisodeBatchEntries(entries, false)) {
      return res.status(400).send('Invalid request body')
    }
    const hardDelete = req.query?.hard === '1' || req.body.hard === true

    const groups = await loadPodcastEpisodeBatch(req, res, entries)
    if (!groups) return

    const allEpisodeIds = groups.flatMap((g) => g.entries.map(({ episode }) => episode.id))

    // Remove episodes from playlists
    await Database.playlistModel.removeMediaItemsFromPlaylists(allEpisodeIds)

    // Remove media progress for these episodes
    const mediaProgressRemoved = await Database.mediaProgressModel.destroy({
      where: {
        mediaItemId: allEpisodeIds
      }
    })
    if (mediaProgressRemoved) {
      Logger.info(`[PodcastController] Removed ${mediaProgressRemoved} media progress for ${allEpisodeIds.length} episodes`)
    }

    let numEpisodesDeleted = 0
    for (const { libraryItem, entries: groupEntries } of groups) {
      const episodeIdsToRemove = new Set(groupEntries.map(({ episode }) => episode.id))
      const inosToRemove = new Set()

      for (const { episode } of groupEntries) {
        const audioFile = episode.audioFile
        if (audioFile?.ino) inosToRemove.add(audioFile.ino)

        if (hardDelete && audioFile?.metadata?.path) {
          // TODO: this will trigger the watcher. should maybe handle this gracefully
          await fs
            .remove(audioFile.metadata.path)
            .then(() => {
              Logger.info(`[PodcastController] Hard deleted episode file at "${audioFile.metadata.path}"`)
            })
            .catch((error) => {
              Logger.error(`[PodcastController] Failed to hard delete episode file at "${audioFile.metadata.path}"`, error)
            })
        }

        await episode.destroy()
        transcripts.removeEpisodeFiles(libraryItem.id, episode.id).catch(() => {})
        numEpisodesDeleted++
      }

      // Remove from the podcastEpisodes array
      libraryItem.media.podcastEpisodes = libraryItem.media.podcastEpisodes.filter((ep) => !episodeIdsToRemove.has(ep.id))

      // Remove library files
      libraryItem.libraryFiles = libraryItem.libraryFiles.filter((file) => !inosToRemove.has(file.ino))
      libraryItem.changed('libraryFiles', true)
      await libraryItem.save()

      // update number of episodes
      libraryItem.media.numEpisodes = libraryItem.media.podcastEpisodes.length
      await libraryItem.media.save()

      SocketAuthority.libraryItemEmitter('item_updated', libraryItem)
    }

    res.json({
      success: true,
      numEpisodesDeleted,
      libraryItems: groups.map((g) => g.libraryItem.toOldJSON())
    })
  }

  /**
   *
   * @param {RequestWithUser} req
   * @param {Response} res
   * @param {NextFunction} next
   */
  async middleware(req, res, next) {
    const libraryItem = await Database.libraryItemModel.getExpandedById(req.params.id)
    if (!libraryItem?.media) return res.sendStatus(404)

    if (!libraryItem.isPodcast) {
      return res.sendStatus(500)
    }

    // Check user can access this library item
    if (!req.user.checkCanAccessLibraryItem(libraryItem)) {
      return res.sendStatus(403)
    }

    if (req.method == 'DELETE' && !req.user.canDelete) {
      Logger.warn(`[PodcastController] User "${req.user.username}" attempted to delete without permission`)
      return res.sendStatus(403)
    } else if ((req.method == 'PATCH' || req.method == 'POST') && !req.user.canUpdate) {
      Logger.warn(`[PodcastController] User "${req.user.username}" attempted to update without permission`)
      return res.sendStatus(403)
    }

    req.libraryItem = libraryItem
    next()
  }
}
module.exports = new PodcastController()
