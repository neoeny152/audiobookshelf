const { DataTypes, Model, UniqueConstraintError } = require('sequelize')

class BookSeries extends Model {
  constructor(values, options) {
    super(values, options)

    /** @type {UUIDV4} */
    this.id
    /** @type {string} */
    this.sequence
    /** @type {UUIDV4} */
    this.bookId
    /** @type {UUIDV4} */
    this.seriesId
    /** @type {Date} */
    this.createdAt
  }

  /**
   * Link a series to a book unless the link already exists. An existing link keeps its sequence.
   * Safe against duplicate names in the source and concurrent requests (#5215 #5319):
   * the UNIQUE(bookId, seriesId) constraint is never hit as an unhandled error.
   *
   * @param {string} bookId
   * @param {string} seriesId
   * @param {string|null} [sequence]
   * @returns {Promise<{ bookSeries: BookSeries, created: boolean }>}
   */
  static async findOrCreateLink(bookId, seriesId, sequence = null) {
    const existing = await this.findOne({ where: { bookId, seriesId } })
    if (existing) return { bookSeries: existing, created: false }
    try {
      const bookSeries = await this.create({ bookId, seriesId, sequence })
      return { bookSeries, created: true }
    } catch (error) {
      if (!(error instanceof UniqueConstraintError)) throw error
      // Created by a concurrent request between the lookup and the insert
      const bookSeries = await this.findOne({ where: { bookId, seriesId } })
      if (!bookSeries) throw error
      return { bookSeries, created: false }
    }
  }

  static removeByIds(seriesId = null, bookId = null) {
    const where = {}
    if (seriesId) where.seriesId = seriesId
    if (bookId) where.bookId = bookId
    return this.destroy({
      where
    })
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
        },
        sequence: DataTypes.STRING
      },
      {
        sequelize,
        modelName: 'bookSeries',
        timestamps: true,
        updatedAt: false,
        indexes: [
          {
            name: 'bookSeries_seriesId',
            fields: ['seriesId']
          },
          {
            name: 'book_series_series_book',
            fields: ['seriesId', 'bookId']
          }
        ]
      }
    )

    // Super Many-to-Many
    // ref: https://sequelize.org/docs/v6/advanced-association-concepts/advanced-many-to-many/#the-best-of-both-worlds-the-super-many-to-many-relationship
    const { book, series } = sequelize.models
    book.belongsToMany(series, { through: BookSeries })
    series.belongsToMany(book, { through: BookSeries })

    book.hasMany(BookSeries, {
      onDelete: 'CASCADE'
    })
    BookSeries.belongsTo(book)

    series.hasMany(BookSeries, {
      onDelete: 'CASCADE'
    })
    BookSeries.belongsTo(series)
  }
}

module.exports = BookSeries
