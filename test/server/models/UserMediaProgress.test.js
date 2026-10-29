const { expect } = require('chai')
const { Sequelize } = require('sequelize')
const sinon = require('sinon')

const Database = require('../../../server/Database')
const Logger = require('../../../server/Logger')

describe('User.createUpdateMediaProgressFromPayload - duplicate rows (#3845)', () => {
  let item

  async function loadUser(id) {
    const user = await Database.userModel.findByPk(id)
    user.mediaProgresses = await Database.mediaProgressModel.findAll({ where: { userId: id } })
    return user
  }

  beforeEach(async () => {
    global.ServerSettings = {}
    Database.sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false })
    Database.sequelize.uppercaseFirst = (str) => (str ? `${str[0].toUpperCase()}${str.substr(1)}` : '')
    await Database.buildModels()

    sinon.stub(Logger, 'info')
    sinon.stub(Logger, 'debug')
    sinon.stub(Logger, 'warn')
    sinon.stub(Logger, 'error')

    const library = await Database.libraryModel.create({ name: 'Lib', mediaType: 'book' })
    const folder = await Database.libraryFolderModel.create({ path: '/lib', libraryId: library.id })
    const book = await Database.bookModel.create({ title: 'Book', audioFiles: [], tags: [], narrators: [], genres: [], chapters: [], duration: 1000 })
    item = await Database.libraryItemModel.create({ libraryFiles: [], mediaId: book.id, mediaType: 'book', libraryId: library.id, libraryFolderId: folder.id })

    await Database.userModel.create({ id: 'u1', username: 'u1', type: 'root', isActive: true, permissions: { accessAllLibraries: true, accessAllTags: true, accessExplicitContent: true } })
  })

  afterEach(async () => {
    sinon.restore()
    await Database.sequelize.sync({ force: true })
  })

  const rows = () => Database.mediaProgressModel.findAll({ where: { userId: 'u1' } })

  it('creates one row when two requests for a new item arrive at the same time', async () => {
    // Two requests load their own user instance (as /api/session/local and /api/me/progress/batch/update do)
    const [userA, userB] = [await loadUser('u1'), await loadUser('u1')]

    const results = await Promise.all([userA.createUpdateMediaProgressFromPayload({ libraryItemId: item.id, duration: 1000, currentTime: 100 }), userB.createUpdateMediaProgressFromPayload({ libraryItemId: item.id, duration: 1000, currentTime: 200 })])

    expect(results.every((r) => r.mediaProgress)).to.be.true
    const all = await rows()
    expect(all).to.have.length(1)
    expect(all[0].currentTime).to.equal(200)
  })

  it('updates the existing row when another process inserted it first (unique index)', async () => {
    await Database.ensureMediaProgressUniqueIndex()
    const user = await loadUser('u1')

    // Simulate a write from outside this process landing between the lookup and the insert
    const originalCreate = Database.mediaProgressModel.create.bind(Database.mediaProgressModel)
    sinon.stub(Database.mediaProgressModel, 'create').callsFake(async (payload) => {
      await originalCreate({ ...payload, currentTime: 50 })
      return originalCreate(payload)
    })

    const result = await user.createUpdateMediaProgressFromPayload({ libraryItemId: item.id, duration: 1000, currentTime: 300 })

    expect(result.mediaProgress).to.exist
    const all = await rows()
    expect(all).to.have.length(1)
    expect(all[0].currentTime).to.equal(300)
    expect(user.mediaProgresses.filter((mp) => mp.mediaItemId === item.mediaId)).to.have.length(1)
  })

  it('runs skipIf under the same lock as the write, after writes queued before it (#5627)', async () => {
    const [userA, userB] = [await loadUser('u1'), await loadUser('u1')]
    const storedTime = async () => (await rows())[0]?.currentTime ?? 0

    // Session B moves progress to 600; session A's stale check must see that write, not run before it
    const [resultB, resultA] = await Promise.all([userB.createUpdateMediaProgressFromPayload({ libraryItemId: item.id, duration: 1000, currentTime: 600 }), userA.createUpdateMediaProgressFromPayload({ libraryItemId: item.id, duration: 1000, currentTime: 100 }, { skipIf: async () => (await storedTime()) > 100 })])

    expect(resultB.mediaProgress).to.exist
    expect(resultA).to.deep.equal({ skipped: true })
    expect(await storedTime()).to.equal(600)
  })

  it('writes when skipIf returns false', async () => {
    const user = await loadUser('u1')
    const result = await user.createUpdateMediaProgressFromPayload({ libraryItemId: item.id, duration: 1000, currentTime: 100 }, { skipIf: () => false })
    expect(result.mediaProgress).to.exist
    expect((await rows())[0].currentTime).to.equal(100)
  })
})
