const chai = require('chai')
const sinon = require('sinon')
const { expect } = chai

const { DataTypes, Sequelize } = require('sequelize')
const Logger = require('../../../server/Logger')

const { up, down, indexName } = require('../../../server/migrations/v2.37.3-media-progress-unique-user-item')

describe('Migration v2.37.3-media-progress-unique-user-item', () => {
  let sequelize
  let queryInterface

  const ids = async () => (await sequelize.query('SELECT id FROM mediaProgresses ORDER BY id', { type: Sequelize.QueryTypes.SELECT })).map((r) => r.id)

  beforeEach(async () => {
    sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false })
    queryInterface = sequelize.getQueryInterface()
    sinon.stub(Logger, 'info')

    await queryInterface.createTable('mediaProgresses', {
      id: { type: DataTypes.STRING, allowNull: false, primaryKey: true },
      userId: { type: DataTypes.STRING, allowNull: false },
      mediaItemId: { type: DataTypes.STRING, allowNull: false },
      currentTime: { type: DataTypes.FLOAT },
      updatedAt: { type: DataTypes.DATE, allowNull: false }
    })
    await queryInterface.addIndex('mediaProgresses', { name: 'media_progresses_user_item_finished_time', fields: ['userId', 'mediaItemId', 'currentTime'] })

    await queryInterface.bulkInsert('mediaProgresses', [
      // user1/book1: three rows, the newest (c) must survive
      { id: 'a', userId: 'user1', mediaItemId: 'book1', currentTime: 100, updatedAt: new Date('2025-01-01T00:00:00Z') },
      { id: 'b', userId: 'user1', mediaItemId: 'book1', currentTime: 200, updatedAt: new Date('2025-01-02T00:00:00Z') },
      { id: 'c', userId: 'user1', mediaItemId: 'book1', currentTime: 600, updatedAt: new Date('2025-01-03T00:00:00Z') },
      // user1/book2: updatedAt tie, the smallest id (d) must survive
      { id: 'e', userId: 'user1', mediaItemId: 'book2', currentTime: 5, updatedAt: new Date('2025-01-01T00:00:00Z') },
      { id: 'd', userId: 'user1', mediaItemId: 'book2', currentTime: 6, updatedAt: new Date('2025-01-01T00:00:00Z') },
      // same item for another user and another item for the same user are not duplicates
      { id: 'f', userId: 'user2', mediaItemId: 'book1', currentTime: 1, updatedAt: new Date('2024-01-01T00:00:00Z') },
      { id: 'g', userId: 'user1', mediaItemId: 'book3', currentTime: 1, updatedAt: new Date('2024-01-01T00:00:00Z') }
    ])
  })

  afterEach(async () => {
    sinon.restore()
    await sequelize.close()
  })

  describe('up', () => {
    it('keeps only the newest row per (userId, mediaItemId), smallest id on a tie', async () => {
      await up({ context: { queryInterface, logger: Logger } })

      expect(await ids()).to.deep.equal(['c', 'd', 'f', 'g'])
    })

    it('adds a unique index on (userId, mediaItemId) and keeps the existing index', async () => {
      await up({ context: { queryInterface, logger: Logger } })

      const indexes = await queryInterface.showIndex('mediaProgresses')
      const unique = indexes.find((i) => i.name === indexName)
      expect(unique).to.exist
      expect(unique.unique).to.be.true
      expect(unique.fields.map((f) => f.attribute)).to.deep.equal(['userId', 'mediaItemId'])
      expect(indexes.some((i) => i.name === 'media_progresses_user_item_finished_time')).to.be.true

      let error = null
      try {
        await queryInterface.bulkInsert('mediaProgresses', [{ id: 'h', userId: 'user1', mediaItemId: 'book1', currentTime: 1, updatedAt: new Date() }])
      } catch (err) {
        error = err
      }
      expect(error).to.be.instanceOf(Sequelize.UniqueConstraintError)
    })

    it('is idempotent', async () => {
      await up({ context: { queryInterface, logger: Logger } })
      await up({ context: { queryInterface, logger: Logger } })

      expect(await ids()).to.deep.equal(['c', 'd', 'f', 'g'])
      const indexes = await queryInterface.showIndex('mediaProgresses')
      expect(indexes.filter((i) => i.name === indexName)).to.have.length(1)
    })

    it('treats a NULL updatedAt as the oldest row so the index can still be created', async () => {
      await queryInterface.dropTable('mediaProgresses')
      await sequelize.query('CREATE TABLE mediaProgresses (id VARCHAR(255) PRIMARY KEY, userId VARCHAR(255) NOT NULL, mediaItemId VARCHAR(255) NOT NULL, currentTime FLOAT, updatedAt DATETIME)')
      await sequelize.query(`INSERT INTO mediaProgresses (id, userId, mediaItemId, currentTime, updatedAt) VALUES
        ('n1', 'user1', 'book1', 1, NULL),
        ('n2', 'user1', 'book1', 2, '2025-01-01 00:00:00.000 +00:00'),
        ('n3', 'user1', 'book2', 3, NULL),
        ('n4', 'user1', 'book2', 4, NULL)`)

      await up({ context: { queryInterface, logger: Logger } })

      expect(await ids()).to.deep.equal(['n2', 'n3'])
      const indexes = await queryInterface.showIndex('mediaProgresses')
      expect(indexes.some((i) => i.name === indexName)).to.be.true
    })

    it('does nothing when the table does not exist yet', async () => {
      await queryInterface.dropTable('mediaProgresses')
      await up({ context: { queryInterface, logger: Logger } })
      expect(await queryInterface.showAllTables()).to.not.include('mediaProgresses')
    })
  })

  describe('down', () => {
    it('removes the unique index and keeps the rows', async () => {
      await up({ context: { queryInterface, logger: Logger } })
      await down({ context: { queryInterface, logger: Logger } })

      const indexes = await queryInterface.showIndex('mediaProgresses')
      expect(indexes.some((i) => i.name === indexName)).to.be.false
      expect(await ids()).to.deep.equal(['c', 'd', 'f', 'g'])

      // safe to run again
      await down({ context: { queryInterface, logger: Logger } })
    })
  })
})
