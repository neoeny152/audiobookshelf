/**
 * @typedef MigrationContext
 * @property {import('sequelize').QueryInterface} queryInterface
 * @property {import('../Logger')} logger
 *
 * @typedef MigrationOptions
 * @property {MigrationContext} context
 */

/**
 * Enforce one mediaProgress row per (userId, mediaItemId) (upstream #3845).
 *
 * Concurrent progress writes (e.g. Plappa calling /api/session/local and
 * /api/me/progress/batch/update at the same time) could both miss the existing row and
 * insert a second one. This migration:
 *   1. Removes exact duplicates of (userId, mediaItemId). Keep rule: the row with the newest
 *      updatedAt is kept; on an updatedAt tie the row with the smallest id is kept. This is the
 *      same rule Database.cleanDatabase already applies on every startup, so no row is removed
 *      here that the server would not already have removed.
 *   2. Adds the UNIQUE index media_progresses_user_item_unique on (userId, mediaItemId).
 *
 * Idempotent: running it again finds no duplicates and skips the existing index.
 * The index is intentionally not declared on the MediaProgress model: sequelize.sync() adds
 * missing model indexes, and that would fail on a database that still has duplicates.
 * Database.init also calls up() after sync so that a fork that does not bump the server
 * version still gets the index.
 */

const migrationVersion = '2.37.3'
const migrationName = `${migrationVersion}-media-progress-unique-user-item`
const loggerPrefix = `[${migrationVersion} migration]`

const tableName = 'mediaProgresses'
const indexName = 'media_progresses_user_item_unique'

const duplicateRowsSelect = `SELECT mp1.id FROM mediaProgresses mp1
WHERE EXISTS (
  SELECT 1 FROM mediaProgresses mp2
  WHERE mp2.userId = mp1.userId
  AND mp2.mediaItemId = mp1.mediaItemId
  AND (
    mp2.updatedAt > mp1.updatedAt
    OR (mp2.updatedAt = mp1.updatedAt AND mp2.id < mp1.id)
  )
)`

/**
 * @param {import('sequelize').QueryInterface} queryInterface
 * @returns {Promise<boolean>}
 */
async function hasUniqueIndex(queryInterface) {
  const indexes = await queryInterface.showIndex(tableName)
  return indexes.some((i) => i.name === indexName)
}

/**
 * @param {MigrationOptions} options
 */
async function up({ context: { queryInterface, logger } }) {
  logger.info(`${loggerPrefix} UPGRADE BEGIN: ${migrationName}`)

  const tables = await queryInterface.showAllTables()
  if (!tables.includes(tableName)) {
    logger.info(`${loggerPrefix} table ${tableName} does not exist, nothing to do`)
    logger.info(`${loggerPrefix} UPGRADE END: ${migrationName}`)
    return
  }

  if (await hasUniqueIndex(queryInterface)) {
    logger.info(`${loggerPrefix} index ${indexName} already exists on ${tableName}`)
    logger.info(`${loggerPrefix} UPGRADE END: ${migrationName}`)
    return
  }

  const transaction = await queryInterface.sequelize.transaction()
  try {
    const [duplicates] = await queryInterface.sequelize.query(duplicateRowsSelect, { transaction })
    if (duplicates.length) {
      logger.info(`${loggerPrefix} removing ${duplicates.length} duplicate ${tableName} rows (keeping the newest updatedAt per userId + mediaItemId)`)
      await queryInterface.sequelize.query(`DELETE FROM mediaProgresses WHERE id IN (${duplicateRowsSelect})`, { transaction })
    } else {
      logger.info(`${loggerPrefix} no duplicate ${tableName} rows found`)
    }

    logger.info(`${loggerPrefix} adding unique index ${indexName} on ${tableName}(userId, mediaItemId)`)
    await queryInterface.sequelize.query(`CREATE UNIQUE INDEX IF NOT EXISTS ${indexName} ON ${tableName} (userId, mediaItemId)`, { transaction })
    await transaction.commit()
  } catch (error) {
    await transaction.rollback()
    throw error
  }

  logger.info(`${loggerPrefix} UPGRADE END: ${migrationName}`)
}

/**
 * Removes the unique index. Removed duplicate rows are not restored.
 *
 * @param {MigrationOptions} options
 */
async function down({ context: { queryInterface, logger } }) {
  logger.info(`${loggerPrefix} DOWNGRADE BEGIN: ${migrationName}`)

  const tables = await queryInterface.showAllTables()
  if (tables.includes(tableName) && (await hasUniqueIndex(queryInterface))) {
    logger.info(`${loggerPrefix} removing index ${indexName}`)
    await queryInterface.removeIndex(tableName, indexName)
  } else {
    logger.info(`${loggerPrefix} index ${indexName} does not exist`)
  }

  logger.info(`${loggerPrefix} DOWNGRADE END: ${migrationName}`)
}

module.exports = { up, down, indexName, hasUniqueIndex }
