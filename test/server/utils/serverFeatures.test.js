const { expect } = require('chai')

const { SERVER_FEATURES, OPTIONAL_FEATURES, availableOptionalFeatures, buildStatusPayload } = require('../../../server/utils/serverFeatures')
const { version } = require('../../../package.json')
const ApiRouter = require('../../../server/routers/ApiRouter')
const Auth = require('../../../server/Auth')
const ApiCacheManager = require('../../../server/managers/ApiCacheManager')

describe('serverFeatures', () => {
  const fakeDatabase = (hasRootUser) => ({
    hasRootUser,
    serverSettings: { language: 'en-us', authActiveAuthMethods: ['local'], authFormData: { authLoginCustomMessage: null } }
  })

  it('GET /status payload keeps every stock key and only adds serverFeatures', () => {
    const payload = buildStatusPayload(fakeDatabase(true))
    expect(payload).to.deep.equal({
      app: 'audiobookshelf',
      serverVersion: version,
      isInit: true,
      language: 'en-us',
      authMethods: ['local'],
      authFormData: { authLoginCustomMessage: null },
      serverFeatures: ['batchEpisodes', 'libraryDownloadPost', 'readAlong', 'mp3SeekIndex', 'transcripts']
    })
  })

  it('GET /status still includes paths when the server is not initialized', () => {
    global.ConfigPath = '/config'
    global.MetadataPath = '/metadata'
    const payload = buildStatusPayload(fakeDatabase(false))
    expect(payload.isInit).to.equal(false)
    expect(payload.ConfigPath).to.equal('/config')
    expect(payload.MetadataPath).to.equal('/metadata')
    expect(payload.serverFeatures).to.deep.equal([...SERVER_FEATURES])
  })

  it('returns a copy so callers cannot mutate the feature list', () => {
    const payload = buildStatusPayload(fakeDatabase(true))
    payload.serverFeatures.push('bogus')
    expect(SERVER_FEATURES).to.not.include('bogus')
    expect(Object.isFrozen(SERVER_FEATURES)).to.be.true
  })

  it('adds only known optional features that are currently available', () => {
    expect(buildStatusPayload(fakeDatabase(true), []).serverFeatures).to.deep.equal(['batchEpisodes', 'libraryDownloadPost', 'readAlong', 'mp3SeekIndex', 'transcripts'])
    expect(buildStatusPayload(fakeDatabase(true), ['chapterbotEpub', 'bogus', 'chapterbotVerify']).serverFeatures).to.deep.equal(['batchEpisodes', 'libraryDownloadPost', 'readAlong', 'mp3SeekIndex', 'transcripts', 'chapterbotVerify', 'chapterbotEpub'])
  })

  it('lists chapterbotEpubCurrent with chapterbotEpub and autoPipeline only behind its gate', () => {
    expect(availableOptionalFeatures([])).to.deep.equal([])
    expect(availableOptionalFeatures(['chapterbotVerify'])).to.deep.equal(['chapterbotVerify'])
    expect(availableOptionalFeatures(['chapterbotVerify', 'chapterbotEpub'])).to.deep.equal(['chapterbotVerify', 'chapterbotEpub', 'chapterbotEpubCurrent', 'transcriptsGenerate'])
    expect(availableOptionalFeatures([], { autoPipeline: true })).to.deep.equal(['autoPipeline'])
    expect(buildStatusPayload(fakeDatabase(true), availableOptionalFeatures(['chapterbotVerify', 'chapterbotEpub'], { autoPipeline: true })).serverFeatures).to.deep.equal(['batchEpisodes', 'libraryDownloadPost', 'readAlong', 'mp3SeekIndex', 'transcripts', 'chapterbotVerify', 'chapterbotEpub', 'chapterbotEpubCurrent', 'transcriptsGenerate', 'autoPipeline'])
    expect(buildStatusPayload(fakeDatabase(true), availableOptionalFeatures([], { autoPipeline: false })).serverFeatures).to.not.include('autoPipeline')
  })

  it('every advertised feature has its routes registered', () => {
    const apiRouter = new ApiRouter({ auth: new Auth(), apiCacheManager: new ApiCacheManager() })
    const routes = apiRouter.router._router.stack.filter((l) => l.route).map((l) => `${Object.keys(l.route.methods).join(',')} ${l.route.path}`)
    const featureRoutes = {
      batchEpisodes: ['post /podcasts/batch/episodes/update', 'post /podcasts/batch/episodes/delete'],
      libraryDownloadPost: ['post /libraries/:id/download', 'get /libraries/:id/download'],
      readAlong: ['get /items/:id/ebook/:fileid/readalong'],
      mp3SeekIndex: ['get /tools/item/:id/seek-index', 'post /tools/item/:id/repair-seek-index', 'delete /tools/item/:id/repair-seek-index'],
      chapterbotVerify: ['post /items/:id/chapters/snap'],
      chapterbotEpub: ['post /items/:id/epub', 'get /items/:id/epub/:jobId', 'delete /items/:id/epub/:jobId'],
      chapterbotEpubCurrent: ['get /items/:id/epub'],
      transcripts: ['get /items/:id/transcripts', 'get /items/:id/transcripts/:transcriptId', 'post /items/:id/transcripts/refresh-feed', 'delete /items/:id/transcripts/generated'],
      transcriptsGenerate: ['post /items/:id/transcripts/generate', 'delete /items/:id/transcripts/job'],
      autoPipeline: ['get /libraries/:id/pipeline', 'post /libraries/:id/pipeline/run', 'get /items/:id/pipeline', 'post /items/:id/pipeline/run', 'delete /items/:id/pipeline', 'get /items/:id/pipeline/proposal', 'post /items/:id/pipeline/proposal/approve', 'post /items/:id/pipeline/proposal/reject', 'get /items/:id/pipeline/backups', 'post /items/:id/pipeline/backups/:name/restore']
    }
    expect(Object.keys(featureRoutes).sort()).to.deep.equal([...SERVER_FEATURES, ...OPTIONAL_FEATURES].sort())
    for (const feature of [...SERVER_FEATURES, ...OPTIONAL_FEATURES]) {
      for (const route of featureRoutes[feature]) {
        expect(routes, `${feature}: ${route}`).to.include(route)
      }
    }
  })
})
