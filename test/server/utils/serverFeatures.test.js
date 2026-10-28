const { expect } = require('chai')

const { SERVER_FEATURES, buildStatusPayload } = require('../../../server/utils/serverFeatures')
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
      serverFeatures: ['batchEpisodes', 'libraryDownloadPost']
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

  it('every advertised feature has its routes registered', () => {
    const apiRouter = new ApiRouter({ auth: new Auth(), apiCacheManager: new ApiCacheManager() })
    const routes = apiRouter.router._router.stack.filter((l) => l.route).map((l) => `${Object.keys(l.route.methods).join(',')} ${l.route.path}`)
    const featureRoutes = {
      batchEpisodes: ['post /podcasts/batch/episodes/update', 'post /podcasts/batch/episodes/delete'],
      libraryDownloadPost: ['post /libraries/:id/download', 'get /libraries/:id/download']
    }
    expect(Object.keys(featureRoutes).sort()).to.deep.equal([...SERVER_FEATURES].sort())
    for (const feature of SERVER_FEATURES) {
      for (const route of featureRoutes[feature]) {
        expect(routes, `${feature}: ${route}`).to.include(route)
      }
    }
  })
})
