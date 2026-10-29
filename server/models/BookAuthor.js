const { DataTypes, Model, fn, col, UniqueConstraintError } = require('sequelize')

class BookAuthor extends Model {
  constructor(values, options) {
    super(values, options)

    /** @type {UUIDV4} */
    this.id
    /** @type {UUIDV4} */
    this.bookId
    /** @type {UUIDV4} */
    this.authorId
    /** @type {Date} */
    this.createdAt
  }

  /**
   * Link an author to a book unless the link already exists.
   * Safe against duplicate names in the source and concurrent requests (#5319 #5215):
   * the UNIQUE(bookId, authorId) constraint is never hit as an unhandled error.
   *
   * @param {string} bookId
   * @param {string} authorId
   * @param {Object} [extraValues] e.g. createdAt to keep the author order
   * @returns {Promise<{ bookAuthor: BookAuthor, created: boolean }>}
   */
  static async findOrCreateLink(bookId, authorId, extraValues = {}) {
    const existing = await this.findOne({ where: { bookId, authorId } })
    if (existing) return { bookAuthor: existing, created: false }
    try {
      const bookAuthor = await this.create({ ...extraValues, bookId, authorId })
      return { bookAuthor, created: true }
    } catch (error) {
      if (!(error instanceof UniqueConstraintError)) throw error
      // Created by a concurrent request between the lookup and the insert
      const bookAuthor = await this.findOne({ where: { bookId, authorId } })
      if (!bookAuthor) throw error
      return { bookAuthor, created: false }
    }
  }

  static removeByIds(authorId = null, bookId = null) {
    const where = {}
    if (authorId) where.authorId = authorId
    if (bookId) where.bookId = bookId
    return this.destroy({
      where
    })
  }

  /**
   * Get number of books for author
   *
   * @param {string} authorId
   * @returns {Promise<number>}
   */
  static getCountForAuthor(authorId) {
    return this.count({
      where: {
        authorId
      }
    })
  }

  /**
   * Get number of books for each author
   *
   * @param {string[]} authorIds
   * @returns {Promise<Record<string, number>>}
   */
  static async getCountsForAuthors(authorIds) {
    if (!authorIds.length) return {}

    const rows = await this.findAll({
      attributes: ['authorId', [fn('COUNT', col('id')), 'count']],
      where: {
        authorId: authorIds
      },
      group: ['authorId'],
      raw: true
    })

    /** @type {Record<string, number>} */
    const counts = {}
    for (const row of rows) {
      counts[row.authorId] = Number(row.count)
    }
    return counts
  }

  /**
   * Initialize model
   * @param {import('../Database').sequelize} sequelize
   */
  static init(sequelize) {
    super.init(
      {
        id: {
          type: DataTypes.UUID,
          defaultValue: DataTypes.UUIDV4,
          primaryKey: true
        }
      },
      {
        sequelize,
        modelName: 'bookAuthor',
        timestamps: true,
        updatedAt: false,
        indexes: [
          {
            name: 'bookAuthor_authorId',
            fields: ['authorId']
          }
        ]
      }
    )

    // Super Many-to-Many
    // ref: https://sequelize.org/docs/v6/advanced-association-concepts/advanced-many-to-many/#the-best-of-both-worlds-the-super-many-to-many-relationship
    const { book, author } = sequelize.models
    book.belongsToMany(author, { through: BookAuthor })
    author.belongsToMany(book, { through: BookAuthor })

    book.hasMany(BookAuthor, {
      onDelete: 'CASCADE'
    })
    BookAuthor.belongsTo(book)

    author.hasMany(BookAuthor, {
      onDelete: 'CASCADE'
    })
    BookAuthor.belongsTo(author)
  }
}
module.exports = BookAuthor
