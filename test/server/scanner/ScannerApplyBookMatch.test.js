const { expect } = require('chai')
const { Sequelize } = require('sequelize')
const sinon = require('sinon')
const os = require('os')
const Path = require('path')
const fs = require('fs')

const Database = require('../../../server/Database')
const Logger = require('../../../server/Logger')
const SocketAuthority = require('../../../server/SocketAuthority')
const Scanner = require('../../../server/scanner/Scanner')
const BookFinder = require('../../../server/finders/BookFinder')
const { applyChapters } = require('../../../server/utils/applyChapters')

describe('Scanner.applyBookMatch and applyChapters (shared by quick match, the chapters route and the auto pipeline)', () => {
  let metadataDir
  let itemId
  let libraryId
  const apiRouterCtx = { checkRemoveAuthorsWithNoBooks: sinon.stub().resolves() }

  const match = (overrides = {}) => ({ title: 'Matched Title', subtitle: 'Sub', author: 'A. Writer', narrator: 'Jo Reader, Second Voice', publisher: 'Pub', asin: 'B0TEST0001', cover: null, genres: ['Fantasy'], series: [{ series: 'Ice', sequence: '3' }], ...overrides })

  beforeEach(async () => {
    metadataDir = fs.mkdtempSync(Path.join(os.tmpdir(), 'abs-applymatch-'))
    global.MetadataPath = metadataDir
    global.ServerSettings = { storeMetadataWithItem: false, metadataFileFormat: 'json' }
    Database.sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false })
    Database.sequelize.uppercaseFirst = (str) => (str ? `${str[0].toUpperCase()}${str.substr(1)}` : '')
    await Database.buildModels()
    sinon.stub(Database, 'serverSettings').value({ scannerPreferMatchedMetadata: false })
    sinon.stub(Logger, 'info')
    sinon.stub(Logger, 'debug')
    sinon.stub(Logger, 'warn')
    sinon.stub(Logger, 'error')
    sinon.stub(SocketAuthority, 'emitter')
    sinon.stub(SocketAuthority, 'libraryItemEmitter')

    const library = await Database.libraryModel.create({ name: 'Books', mediaType: 'book' })
    libraryId = library.id
    const folder = await Database.libraryFolderModel.create({ path: '/books', libraryId })
    const book = await Database.bookModel.create({ title: 'Black Ice', publisher: 'Mine', audioFiles: [], tags: [], narrators: [], genres: [], chapters: [{ id: 0, title: 'One', start: 0, end: 10 }] })
    const li = await Database.libraryItemModel.create({ libraryFiles: [], mediaId: book.id, mediaType: 'book', libraryId, libraryFolderId: folder.id, path: '/books/Black Ice', relPath: 'Black Ice' })
    const author = await Database.authorModel.create({ name: 'A. Writer', libraryId })
    await Database.bookAuthorModel.create({ bookId: book.id, authorId: author.id })
    itemId = li.id
  })

  afterEach(async () => {
    sinon.restore()
    await Database.sequelize.close()
    fs.rmSync(metadataDir, { recursive: true, force: true })
  })

  const item = () => Database.libraryItemModel.getExpandedById(itemId)

  it('fills empty fields only, adds series, saves the metadata file and emits item_updated', async () => {
    const result = await Scanner.applyBookMatch(apiRouterCtx, await item(), match())
    expect(result.updated).to.equal(true)
    const li = await item()
    expect(li.media.title).to.equal('Black Ice') // not empty: kept
    expect(li.media.publisher).to.equal('Mine')
    expect(li.media.subtitle).to.equal('Sub')
    expect(li.media.asin).to.equal('B0TEST0001')
    expect(li.media.narrators).to.deep.equal(['Jo Reader', 'Second Voice'])
    expect(li.media.series.map((s) => [s.name, s.bookSeries.sequence])).to.deep.equal([['Ice', '3']])
    expect(JSON.parse(fs.readFileSync(Path.join(metadataDir, 'items', itemId, 'metadata.json'), 'utf8')).asin).to.equal('B0TEST0001')
    expect(SocketAuthority.libraryItemEmitter.calledWith('item_updated')).to.equal(true)
  })

  it('overrides fields with scannerPreferMatchedMetadata, like quick match', async () => {
    Database.serverSettings.scannerPreferMatchedMetadata = true
    await Scanner.applyBookMatch(apiRouterCtx, await item(), match())
    const li = await item()
    expect(li.media.title).to.equal('Matched Title')
    expect(li.media.publisher).to.equal('Pub')
  })

  it('runs author/series links through the serialized queue: parallel matches of one book make no duplicate join rows (#5215 #5319)', async () => {
    const spy = sinon.spy(Scanner, 'runBookLinkUpdate')
    // override: the author list is replaced too. The series name differs only in case from an existing one: one series row, one link (#4255)
    await Database.seriesModel.create({ name: 'ice', libraryId })
    const opts = () => ({ overrideDetails: true })
    await Promise.all([Scanner.applyBookMatch(apiRouterCtx, await item(), match({ author: 'New Author' }), opts()), Scanner.applyBookMatch(apiRouterCtx, await item(), match({ author: 'New Author' }), opts())])
    expect(spy.callCount).to.equal(2)
    const li = await item()
    expect(li.media.authors.map((a) => a.name)).to.deep.equal(['New Author'])
    expect(await Database.seriesModel.count()).to.equal(1)
    expect((await Database.bookSeriesModel.findAll({ raw: true })).filter((r) => r.bookId === li.media.id)).to.have.length(1)
    expect((await Database.authorModel.findAll({ raw: true })).filter((r) => r.name === 'New Author')).to.have.length(1)
    expect((await Database.bookAuthorModel.findAll({ raw: true })).filter((r) => r.bookId === li.media.id)).to.have.length(1)
  })

  it('quick match applies the first search result through applyBookMatch', async () => {
    sinon.stub(BookFinder, 'search').resolves([match({ asin: 'B0FIRST001' }), match({ asin: 'B0SECOND01' })])
    const spy = sinon.spy(Scanner, 'applyBookMatch')
    const li = await item()
    const result = await Scanner.quickMatchLibraryItem(apiRouterCtx, li, { provider: 'audible' })
    expect(spy.calledOnce).to.equal(true)
    expect(spy.firstCall.args[2].asin).to.equal('B0FIRST001')
    expect(result.updated).to.equal(true)
    expect(result.libraryItem.media.metadata.asin).to.equal('B0FIRST001')

    BookFinder.search.resolves([])
    expect(await Scanner.quickMatchLibraryItem(apiRouterCtx, await item(), { provider: 'audible' })).to.deep.equal({ warning: 'No audible match found' })
  })

  it('applyChapters writes only when something changed', async () => {
    let li = await item()
    expect(await applyChapters(li, [{ title: 'One', start: 0, end: 10 }])).to.deep.equal({ updated: false })
    expect(SocketAuthority.libraryItemEmitter.called).to.equal(false)
    expect(
      await applyChapters(li, [
        { title: 'One', start: 0, end: 5 },
        { title: 'Two', start: 5, end: 10 }
      ])
    ).to.deep.equal({ updated: true })
    li = await item()
    expect(li.media.chapters).to.deep.equal([
      { id: 0, title: 'One', start: 0, end: 5 },
      { id: 1, title: 'Two', start: 5, end: 10 }
    ])
    expect(JSON.parse(fs.readFileSync(Path.join(metadataDir, 'items', itemId, 'metadata.json'), 'utf8')).chapters).to.have.length(2)
    expect(SocketAuthority.libraryItemEmitter.calledOnceWith('item_updated')).to.equal(true)
  })
})
