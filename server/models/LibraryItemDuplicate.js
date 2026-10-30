const { DataTypes, Model } = require('sequelize')

/**
 * One row per library item that is a member of a possible-duplicate group (#5676).
 * Rows are rebuilt by DuplicateItemManager after scans; nothing here deletes or merges library items.
 *
 * @typedef LibraryItemDuplicateObject
 * @property {UUIDV4} id
 * @property {UUIDV4} libraryId
 * @property {UUIDV4} libraryItemId
 * @property {string} groupKey hash of the sorted member ids, so a group changes key when a member is added or removed
 * @property {string} matchTypes comma separated, see utils/duplicateItems MATCH_TYPES
 * @property {boolean} dismissed admin marked the group as "not a duplicate"
 * @property {boolean} active the items are grouped like this right now; false for a dismissed group kept for later
 * @property {Date} createdAt
 * @property {Date} updatedAt
 *
 * @typedef {LibraryItemDuplicateObject & LibraryItemDuplicate} LibraryItemDuplicateModel
 */

class LibraryItemDuplicate extends Model {
  constructor(values, options) {
    super(values, options)

    /** @type {UUIDV4} */
    this.id
    /** @type {UUIDV4} */
    this.libraryId
    /** @type {UUIDV4} */
    this.libraryItemId
    /** @type {string} */
    this.groupKey
    /** @type {string} */
    this.matchTypes
    /** @type {boolean} */
    this.dismissed
    /** @type {boolean} */
    this.active
    /** @type {Date} */
    this.createdAt
    /** @type {Date} */
    this.updatedAt
  }

  /**
   * Initialize model
   *
   * @param {import('../Database').sequelize} sequelize
   */
  static init(sequelize) {
    super.init(
      {
        id: {
          type: DataTypes.UUID,
          defaultValue: DataTypes.UUIDV4,
          primaryKey: true
        },
        libraryId: DataTypes.UUID,
        libraryItemId: DataTypes.UUID,
        groupKey: DataTypes.STRING,
        matchTypes: DataTypes.STRING,
        dismissed: {
          type: DataTypes.BOOLEAN,
          defaultValue: false
        },
        active: {
          type: DataTypes.BOOLEAN,
          defaultValue: true
        }
      },
      {
        sequelize,
        modelName: 'libraryItemDuplicate',
        indexes: [
          {
            fields: ['libraryId', 'groupKey']
          }
        ]
      }
    )
  }
}

module.exports = LibraryItemDuplicate
