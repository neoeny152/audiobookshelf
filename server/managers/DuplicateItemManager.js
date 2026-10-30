const Logger = require('../Logger')
const Database = require('../Database')
const SocketAuthority = require('../SocketAuthority')
const { Op } = require('sequelize')
const { findDuplicateGroups } = require('../utils/duplicateItems')

/**
 * Possible duplicate items (#5676)
 *
 * After a scan (or anything else that resets the issues count) the library is re-checked:
 * one query loads the matching fields for every item, utils/duplicateItems groups them in memory,
 * and the groups are stored in libraryItemDuplicates. A group an admin dismissed ("not a duplicate") is kept, marked
 * inactive while its items are not grouped exactly like that, until one of its items is removed from the library.
 * A group with another member is a new group and is flagged again. Nothing is ever deleted or merged.
 * Admin sockets get duplicate_items_updated { libraryId, numGroups } (groups not dismissed) after each check.
 *
 * @typedef DuplicateGroupItem
 * @property {string} id
 * @property {string} title
 * @property {string|null} author
 * @property {string} path
 * @property {string} relPath
 * @property {number} size
 * @property {number} duration
 * @property {number} numAudioFiles
 * @property {boolean} hasEbook
 * @property {string|null} asin
 * @property {string|null} isbn
 * @property {number} addedAt
 * @property {boolean} isMissing
 * @property {boolean} isInvalid
 *
 * @typedef DuplicateGroupJSON
 * @property {string} id group key
 * @property {string[]} matchTypes
 * @property {boolean} dismissed
 * @property {DuplicateGroupItem[]} items
 */

const CHECK_DELAY_MS = 5000

/**
 * Raw sqlite dates look like "2024-05-01 10:00:00.123 +00:00"
 * @param {string|Date|number} value
 * @returns {number}
 */
function toMs(value) {
  if (!value) return 0
  if (value instanceof Date) return value.valueOf()
  const ms = new Date(value).valueOf()
  return isNaN(ms) ? 0 : ms
}

class DuplicateItemManager {
  constructor() {
    /** @type {Map<string, NodeJS.Timeout>} */
    this.pendingChecks = new Map()
    /** @type {Map<string, Promise<number>>} */
    this.runningChecks = new Map()
    /** @type {Set<string>} libraries that need another check after the running one */
    this.rerunRequested = new Set()
    /** @type {Map<string, number>} libraryId -> time of last completed check (this process) */
    this.lastCheckedAt = new Map()
    this.checkDelayMs = CHECK_DELAY_MS
    /** Background checks only run in the server process, not when modules are loaded by tests */
    this.enabled = false
  }

  init() {
    this.enabled = true
  }

  /**
   * Debounced: a scan resets the issues count many times, one check runs after it settles
   * @param {string} libraryId
   */
  scheduleCheck(libraryId) {
    if (!this.enabled || !libraryId) return
    clearTimeout(this.pendingChecks.get(libraryId))
    const timeout = setTimeout(() => {
      this.pendingChecks.delete(libraryId)
      this.checkLibrary(libraryId).catch((error) => Logger.error(`[DuplicateItemManager] Duplicate check failed for library "${libraryId}"`, error))
    }, this.checkDelayMs)
    timeout.unref?.()
    this.pendingChecks.set(libraryId, timeout)
  }

  /**
   * Check a library now. Concurrent calls share the running check and queue one more run.
   * @param {string} libraryId
   * @returns {Promise<number>} number of groups found (dismissed included)
   */
  async checkLibrary(libraryId) {
    if (this.runningChecks.has(libraryId)) {
      this.rerunRequested.add(libraryId)
      return this.runningChecks.get(libraryId)
    }
    const run = (async () => {
      let numGroups = 0
      do {
        this.rerunRequested.delete(libraryId)
        numGroups = await this.runCheck(libraryId)
      } while (this.rerunRequested.has(libraryId))
      return numGroups
    })()
    this.runningChecks.set(libraryId, run)
    try {
      return await run
    } finally {
      this.runningChecks.delete(libraryId)
    }
  }

  /**
   * @param {string} libraryId
   * @returns {Promise<number>}
   */
  async runCheck(libraryId) {
    const library = await Database.libraryModel.findByPk(libraryId, { attributes: ['id', 'mediaType'] })
    if (!library) {
      await Database.libraryItemDuplicateModel.destroy({ where: { libraryId } })
      return 0
    }

    const candidates = await this.loadCandidates(libraryId, library.mediaType)
    const groups = findDuplicateGroups(candidates, library.mediaType === 'podcast' ? 'podcast' : 'book')

    await Database.sequelize.transaction(async (transaction) => {
      const model = Database.libraryItemDuplicateModel
      // Dismissals outlive the group: a pair marked "not a duplicate" stays dismissed after a third copy
      // comes and goes. They are only dropped once one of their items is removed from the library.
      const dismissedRows = await model.findAll({ where: { libraryId, dismissed: true }, attributes: ['groupKey', 'libraryItemId'], transaction })
      const [itemRows] = await Database.sequelize.query('SELECT id FROM libraryItems WHERE libraryId = :libraryId', { replacements: { libraryId }, transaction })
      const existingItemIds = new Set(itemRows.map((row) => row.id))
      const staleKeys = new Set(dismissedRows.filter((row) => !existingItemIds.has(row.libraryItemId)).map((row) => row.groupKey))
      const dismissedKeys = new Set(dismissedRows.map((row) => row.groupKey).filter((key) => !staleKeys.has(key)))

      await model.destroy({ where: { libraryId, [Op.or]: [{ dismissed: false }, { groupKey: [...staleKeys] }] }, transaction })

      const currentKeys = new Set(groups.map((group) => group.key))
      const rows = []
      for (const group of groups) {
        if (dismissedKeys.has(group.key)) {
          await model.update({ active: true, matchTypes: group.matchTypes.join(',') }, { where: { libraryId, groupKey: group.key }, transaction })
          continue
        }
        for (const libraryItemId of group.itemIds) {
          rows.push({ libraryId, libraryItemId, groupKey: group.key, matchTypes: group.matchTypes.join(','), dismissed: false, active: true })
        }
      }
      const inactiveKeys = [...dismissedKeys].filter((key) => !currentKeys.has(key))
      if (inactiveKeys.length) await model.update({ active: false }, { where: { libraryId, groupKey: inactiveKeys }, transaction })
      if (rows.length) await model.bulkCreate(rows, { transaction })
    })

    this.lastCheckedAt.set(libraryId, Date.now())
    // Lets an open Issues page and the side rail badge catch up after a background check
    SocketAuthority.adminEmitter('duplicate_items_updated', { libraryId, numGroups: await this.countGroups(libraryId) })
    if (groups.length) {
      Logger.info(`[DuplicateItemManager] Library "${libraryId}": ${groups.length} possible duplicate group(s) among ${candidates.length} items`)
    } else {
      Logger.debug(`[DuplicateItemManager] Library "${libraryId}": no possible duplicates among ${candidates.length} items`)
    }
    return groups.length
  }

  /**
   * One query for the fields duplicate matching needs. Missing and invalid items are left out:
   * they already show under Issues.
   *
   * @param {string} libraryId
   * @param {string} mediaType
   * @returns {Promise<import('../utils/duplicateItems').DuplicateCandidate[]>}
   */
  async loadCandidates(libraryId, mediaType) {
    if (mediaType === 'podcast') {
      const [rows] = await Database.sequelize.query(
        `SELECT li.id, p.title, p.author, p.feedURL AS feedUrl, p.itunesId
        FROM libraryItems li INNER JOIN podcasts p ON p.id = li.mediaId
        WHERE li.libraryId = :libraryId AND li.mediaType = 'podcast' AND IFNULL(li.isMissing, 0) = 0 AND IFNULL(li.isInvalid, 0) = 0`,
        { replacements: { libraryId } }
      )
      return rows
    }

    const [rows] = await Database.sequelize.query(
      `SELECT li.id, b.title, b.asin, b.isbn, b.duration, (b.ebookFile IS NOT NULL) AS hasEbook,
        (SELECT a.name FROM bookAuthors ba INNER JOIN authors a ON a.id = ba.authorId WHERE ba.bookId = b.id ORDER BY ba.createdAt ASC LIMIT 1) AS author
      FROM libraryItems li INNER JOIN books b ON b.id = li.mediaId
      WHERE li.libraryId = :libraryId AND li.mediaType = 'book' AND IFNULL(li.isMissing, 0) = 0 AND IFNULL(li.isInvalid, 0) = 0`,
      { replacements: { libraryId } }
    )
    return rows.map((row) => ({ ...row, hasEbook: !!row.hasEbook }))
  }

  /**
   * Run a check if this process has not checked the library yet (rows from before a restart may be stale)
   * @param {string} libraryId
   */
  async ensureChecked(libraryId) {
    if (!this.lastCheckedAt.has(libraryId)) {
      await this.checkLibrary(libraryId)
    }
  }

  /**
   * @param {string} libraryId
   * @returns {Promise<number>} groups not dismissed
   */
  async countGroups(libraryId) {
    const count = await Database.libraryItemDuplicateModel.count({
      where: { libraryId, dismissed: false, active: true },
      distinct: true,
      col: 'groupKey'
    })
    return count || 0
  }

  /**
   * @param {string} libraryId
   * @param {{ includeDismissed?: boolean }} [options]
   * @returns {Promise<DuplicateGroupJSON[]>}
   */
  async getGroups(libraryId, { includeDismissed = false } = {}) {
    const where = { libraryId, active: true }
    if (!includeDismissed) where.dismissed = false
    const rows = await Database.libraryItemDuplicateModel.findAll({ where, order: [['groupKey', 'ASC']] })
    if (!rows.length) return []

    const itemsById = await this.loadItemDetails(rows.map((row) => row.libraryItemId))

    /** @type {Map<string, DuplicateGroupJSON>} */
    const groups = new Map()
    for (const row of rows) {
      const item = itemsById.get(row.libraryItemId)
      if (!item) continue // Removed since the last check
      if (!groups.has(row.groupKey)) {
        groups.set(row.groupKey, {
          id: row.groupKey,
          matchTypes: (row.matchTypes || '').split(',').filter(Boolean),
          dismissed: !!row.dismissed,
          items: []
        })
      }
      groups.get(row.groupKey).items.push(item)
    }

    return [...groups.values()]
      .filter((group) => group.items.length > 1)
      .map((group) => {
        group.items.sort((a, b) => a.addedAt - b.addedAt)
        return group
      })
      .sort((a, b) => (a.items[0].title || '').localeCompare(b.items[0].title || '') || a.id.localeCompare(b.id))
  }

  /**
   * @param {string[]} libraryItemIds
   * @returns {Promise<Map<string, DuplicateGroupItem>>}
   */
  async loadItemDetails(libraryItemIds) {
    /** @type {Map<string, DuplicateGroupItem>} */
    const itemsById = new Map()
    const ids = [...new Set(libraryItemIds)]
    // Stay well under sqlite's bound parameter limit
    for (let i = 0; i < ids.length; i += 500) {
      const [rows] = await Database.sequelize.query(
        `SELECT li.id, li.path, li.relPath, li.size, li.createdAt, li.isMissing, li.isInvalid, li.mediaType,
          COALESCE(b.title, p.title) AS title, b.duration, b.asin, b.isbn, (b.ebookFile IS NOT NULL) AS hasEbook,
          CASE WHEN b.id IS NULL THEN NULL ELSE json_array_length(b.audioFiles) END AS numAudioFiles,
          CASE WHEN b.id IS NULL THEN p.author ELSE
            (SELECT GROUP_CONCAT(name, ', ') FROM (SELECT a.name FROM bookAuthors ba INNER JOIN authors a ON a.id = ba.authorId WHERE ba.bookId = b.id ORDER BY ba.createdAt ASC))
          END AS author,
          (SELECT COUNT(*) FROM podcastEpisodes pe WHERE pe.podcastId = p.id) AS numEpisodes
        FROM libraryItems li
        LEFT JOIN books b ON li.mediaType = 'book' AND b.id = li.mediaId
        LEFT JOIN podcasts p ON li.mediaType = 'podcast' AND p.id = li.mediaId
        WHERE li.id IN (:ids)`,
        { replacements: { ids: ids.slice(i, i + 500) } }
      )
      for (const row of rows) {
        itemsById.set(row.id, {
          id: row.id,
          title: row.title || '',
          author: row.author || null,
          path: row.path,
          relPath: row.relPath,
          size: Number(row.size) || 0,
          duration: Number(row.duration) || 0,
          numAudioFiles: Number(row.numAudioFiles) || 0,
          numEpisodes: row.mediaType === 'podcast' ? Number(row.numEpisodes) || 0 : undefined,
          hasEbook: !!row.hasEbook,
          asin: row.asin || null,
          isbn: row.isbn || null,
          addedAt: toMs(row.createdAt),
          isMissing: !!row.isMissing,
          isInvalid: !!row.isInvalid
        })
      }
    }
    return itemsById
  }

  /**
   * Mark a group as "not a duplicate" (or undo that). It stays dismissed until its members change.
   * @param {string} libraryId
   * @param {string} groupKey
   * @param {boolean} dismissed
   * @returns {Promise<boolean>} false if the group does not exist
   */
  async setGroupDismissed(libraryId, groupKey, dismissed) {
    const [numUpdated] = await Database.libraryItemDuplicateModel.update({ dismissed: !!dismissed }, { where: { libraryId, groupKey, active: true } })
    return numUpdated > 0
  }

  /**
   * Remove a library's rows (library deleted)
   * @param {string} libraryId
   */
  async removeLibrary(libraryId) {
    clearTimeout(this.pendingChecks.get(libraryId))
    this.pendingChecks.delete(libraryId)
    this.lastCheckedAt.delete(libraryId)
    await Database.libraryItemDuplicateModel.destroy({ where: { libraryId } })
  }
}

module.exports = new DuplicateItemManager()
module.exports.DuplicateItemManager = DuplicateItemManager
