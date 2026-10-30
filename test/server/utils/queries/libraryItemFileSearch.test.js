const { expect } = require('chai')
const { Sequelize } = require('sequelize')
const sinon = require('sinon')

const Database = require('../../../../server/Database')
const Logger = require('../../../../server/Logger')
const libraryItemFileSearch = require('../../../../server/utils/queries/libraryItemFileSearch')
const libraryItemFilters = require('../../../../server/utils/queries/libraryItemFilters')

describe('libraryItemFileSearch helpers', () => {
  describe('isFileSearchQuery', () => {
    it('is true for queries ending with an audio or ebook extension', () => {
      expect(libraryItemFileSearch.isFileSearchQuery('lalalalala.mp3')).to.be.true
      expect(libraryItemFileSearch.isFileSearchQuery('Golden Son.M4B')).to.be.true
      expect(libraryItemFileSearch.isFileSearchQuery('book.epub')).to.be.true
    })

    it('is true for queries containing a path separator', () => {
      expect(libraryItemFileSearch.isFileSearchQuery('Pierce Brown/Golden Son')).to.be.true
      expect(libraryItemFileSearch.isFileSearchQuery('Pierce Brown\\Golden Son')).to.be.true
    })

    it('is false for ordinary metadata queries', () => {
      expect(libraryItemFileSearch.isFileSearchQuery('Golden Son')).to.be.false
      expect(libraryItemFileSearch.isFileSearchQuery('Mr. Mercedes')).to.be.false
      expect(libraryItemFileSearch.isFileSearchQuery('notes.txt')).to.be.false
      expect(libraryItemFileSearch.isFileSearchQuery('.mp3')).to.be.false
      expect(libraryItemFileSearch.isFileSearchQuery('')).to.be.false
      expect(libraryItemFileSearch.isFileSearchQuery(null)).to.be.false
    })
  })

  describe('getFileSearchLikePattern', () => {
    it('escapes LIKE wildcards and normalizes separators', () => {
      expect(libraryItemFileSearch.getFileSearchLikePattern('a_b%c!d.mp3')).to.equal('%a!_b!%c!!d.mp3%')
      expect(libraryItemFileSearch.getFileSearchLikePattern(' Author\\Book ')).to.equal('%Author/Book%')
    })
  })

  describe('canPrefilterLibraryFilesText', () => {
    it('is false for queries containing characters JSON.stringify escapes', () => {
      expect(libraryItemFileSearch.canPrefilterLibraryFilesText('golden son.mp3')).to.be.true
      expect(libraryItemFileSearch.canPrefilterLibraryFilesText('Café/Ünïcode.mp3')).to.be.true
      expect(libraryItemFileSearch.canPrefilterLibraryFilesText('Pierce Brown\\Golden Son')).to.be.true
      expect(libraryItemFileSearch.canPrefilterLibraryFilesText('say "hi".mp3')).to.be.false
      expect(libraryItemFileSearch.canPrefilterLibraryFilesText('tab\there.mp3')).to.be.false
    })
  })

  describe('getMatchedFilePath', () => {
    const libraryItem = {
      path: '/books/Pierce Brown/Golden Son',
      relPath: 'Pierce Brown/Golden Son',
      libraryFiles: [{ metadata: { filename: 'cover.jpg', path: '/books/Pierce Brown/Golden Son/cover.jpg', relPath: 'cover.jpg' } }, { metadata: { filename: 'Golden Son 01.mp3', path: '/books/Pierce Brown/Golden Son/Golden Son 01.mp3', relPath: 'Golden Son 01.mp3' } }]
    }

    it('returns the matching file relative path', () => {
      expect(libraryItemFileSearch.getMatchedFilePath(libraryItem, 'son 01.MP3')).to.equal('Golden Son 01.mp3')
    })

    it('returns the item relative path when the query matches the folder', () => {
      expect(libraryItemFileSearch.getMatchedFilePath(libraryItem, 'pierce brown/golden')).to.equal('Pierce Brown/Golden Son')
    })

    it('returns null when nothing matches', () => {
      expect(libraryItemFileSearch.getMatchedFilePath(libraryItem, 'nothing.mp3')).to.be.null
    })
  })
})

describe('library search by file name or path (#5680)', () => {
  let library
  let libraryFolder
  let podcastLibrary
  let podcastFolder
  let adminUser
  let restrictedUser

  async function createBook(title, relPath, filenames, { explicit = false, tags = [] } = {}) {
    const book = await Database.bookModel.create({ title, explicit, audioFiles: [], tags, narrators: [], genres: [], chapters: [] })
    const itemPath = `/books/${relPath}`
    return Database.libraryItemModel.create({
      path: itemPath,
      relPath,
      isFile: false,
      libraryFiles: filenames.map((filename, index) => ({
        ino: `${relPath}-${index}`,
        fileType: 'audio',
        metadata: { filename, ext: filename.slice(filename.lastIndexOf('.')), path: `${itemPath}/${filename}`, relPath: filename, size: 1 }
      })),
      mediaId: book.id,
      mediaType: 'book',
      libraryId: library.id,
      libraryFolderId: libraryFolder.id
    })
  }

  beforeEach(async () => {
    global.ServerSettings = {}
    Database.sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false })
    Database.sequelize.uppercaseFirst = (str) => (str ? `${str[0].toUpperCase()}${str.substr(1)}` : '')
    await Database.buildModels()

    library = await Database.libraryModel.create({ name: 'Books', mediaType: 'book' })
    libraryFolder = await Database.libraryFolderModel.create({ path: '/books', libraryId: library.id })
    podcastLibrary = await Database.libraryModel.create({ name: 'Podcasts', mediaType: 'podcast' })
    podcastFolder = await Database.libraryFolderModel.create({ path: '/podcasts', libraryId: podcastLibrary.id })

    await createBook('Lalalalala Songbook', 'Singer/Songbook', ['lalalalala.mp3'])
    await createBook('Golden Son', 'Pierce Brown/Golden Son', ['Golden Son 01.mp3', 'Golden Son 02.mp3'])
    await createBook('Morning Star', 'Pierce Brown/Morning Star', ['Morning Star 01.mp3'])
    await createBook('Secret Book', 'Hidden/Secret', ['secret_track.mp3'], { explicit: true })
    await createBook('Percent Book', 'Odd/Percent', ['100%_done.mp3'])
    await createBook('mp3 lalalalala.mp3 fan book', 'Fan/Book', ['fan.mp3'])

    const podcast = await Database.podcastModel.create({ title: 'My Show', explicit: false, tags: [], genres: [], autoDownloadEpisodes: false })
    await Database.libraryItemModel.create({
      path: '/podcasts/My Show',
      relPath: 'My Show',
      isFile: false,
      libraryFiles: [{ ino: 'p1', fileType: 'audio', metadata: { filename: 'episode-042.mp3', ext: '.mp3', path: '/podcasts/My Show/episode-042.mp3', relPath: 'episode-042.mp3', size: 1 } }],
      mediaId: podcast.id,
      mediaType: 'podcast',
      libraryId: podcastLibrary.id,
      libraryFolderId: podcastFolder.id
    })

    adminUser = await Database.userModel.create({
      username: 'admin',
      pash: 'hash',
      token: 'token-admin',
      type: 'admin',
      isActive: true,
      permissions: Database.userModel.getDefaultPermissionsForUserType('admin'),
      bookmarks: [],
      extraData: {}
    })
    const permissions = Database.userModel.getDefaultPermissionsForUserType('user')
    permissions.accessExplicitContent = false
    restrictedUser = await Database.userModel.create({
      username: 'restricted',
      pash: 'hash',
      token: 'token-user',
      type: 'user',
      isActive: true,
      permissions,
      bookmarks: [],
      extraData: {}
    })

    sinon.stub(Logger, 'info')
    sinon.stub(Logger, 'warn')
    sinon.stub(Logger, 'error')
  })

  afterEach(async () => {
    sinon.restore()
    await Database.sequelize.sync({ force: true })
  })

  const titles = (matches) => matches.book.map((m) => m.libraryItem.media.metadata.title)

  it('finds a book by audio file name and reports the matched file', async () => {
    const results = await libraryItemFilters.search(adminUser, library, 'lalalalala.mp3', 12)
    const fileMatch = results.book.find((m) => m.libraryItem.media.metadata.title === 'Lalalalala Songbook')
    expect(fileMatch).to.exist
    expect(fileMatch.matchKey).to.equal('file')
    expect(fileMatch.matchText).to.equal('lalalalala.mp3')
  })

  it('lists metadata matches first and does not duplicate them', async () => {
    const results = await libraryItemFilters.search(adminUser, library, 'lalalalala.mp3', 12)
    expect(titles(results)).to.deep.equal(['mp3 lalalalala.mp3 fan book', 'Lalalalala Songbook'])
    expect(results.book[0]).to.not.have.property('matchKey')
  })

  it('matches item folder paths, case-insensitive, with either separator', async () => {
    const results = await libraryItemFilters.search(adminUser, library, 'pierce brown\\golden', 12)
    expect(titles(results)).to.deep.equal(['Golden Son'])
    expect(results.book[0].matchText).to.equal('Pierce Brown/Golden Son')
  })

  it('treats LIKE wildcards in the query literally', async () => {
    const results = await libraryItemFilters.search(adminUser, library, '100%_done.mp3', 12)
    expect(titles(results)).to.deep.equal(['Percent Book'])
    const none = await libraryItemFilters.search(adminUser, library, '1%_d%.mp3', 12)
    expect(none.book).to.have.length(0)
  })

  it('respects user permissions', async () => {
    const admin = await libraryItemFilters.search(adminUser, library, 'secret_track.mp3', 12)
    expect(titles(admin)).to.deep.equal(['Secret Book'])
    const restricted = await libraryItemFilters.search(restrictedUser, library, 'secret_track.mp3', 12)
    expect(restricted.book).to.have.length(0)
  })

  it('caps results at the limit', async () => {
    const results = await libraryItemFilters.search(adminUser, library, 'Pierce Brown/', 1)
    expect(results.book).to.have.length(1)
  })

  it('does not search files for ordinary metadata queries', async () => {
    const results = await libraryItemFilters.search(adminUser, library, 'Pierce Brown', 12)
    expect(results.book).to.have.length(0)
  })

  it('keeps the existing response shape', async () => {
    const results = await libraryItemFilters.search(adminUser, library, 'lalalalala.mp3', 12)
    expect(results).to.have.all.keys('book', 'narrators', 'tags', 'genres', 'series', 'authors')
  })

  it('matches file names containing double quotes and non-ASCII characters', async () => {
    await createBook('Quote Book', 'Quotes/Book', ['Say "Hi".mp3'])
    await createBook('Cafe Book', 'Cafe/Book', ['Café Ünïcode.mp3'])
    const quoted = await libraryItemFilters.search(adminUser, library, 'say "hi".mp3', 12)
    expect(titles(quoted)).to.deep.equal(['Quote Book'])
    expect(quoted.book[0].matchText).to.equal('Say "Hi".mp3')
    const unicode = await libraryItemFilters.search(adminUser, library, 'Café Ünïcode.mp3', 12)
    expect(titles(unicode)).to.deep.equal(['Cafe Book'])
  })

  it('only matches file paths, not other stored file fields', async () => {
    // "Singer/Songbook-0" is the ino of a file in the raw libraryFiles JSON, but not part of any path
    const results = await libraryItemFilters.search(adminUser, library, 'Singer/Songbook-0', 12)
    expect(results.book).to.have.length(0)
  })

  it('finds podcasts by episode file name', async () => {
    const results = await libraryItemFilters.search(adminUser, podcastLibrary, 'episode-042.mp3', 12)
    expect(results.podcast).to.have.length(1)
    expect(results.podcast[0].matchKey).to.equal('file')
    expect(results.podcast[0].matchText).to.equal('episode-042.mp3')
  })
})
