const { expect } = require('chai')
const sinon = require('sinon')
const http = require('http')
const express = require('express')

const SessionController = require('../../../server/controllers/SessionController')
const MeController = require('../../../server/controllers/MeController')
const { createJsonBodyParser, isLocalSessionSyncPath } = require('../../../server/utils/jsonBodyParser')
// Loaded at file load (no hook timeout): it pulls in every controller. Handlers are bound in the
// constructor, so the stubs below still apply.
const ApiRouter = require('../../../server/routers/ApiRouter')

function request(server, method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const { port } = server.address()
    const payload = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
        headers: { ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}), ...headers }
      },
      (res) => {
        let data = ''
        res.on('data', (d) => (data += d))
        res.on('end', () => resolve({ status: res.statusCode, body: data }))
      }
    )
    req.on('error', (err) => (err.code === 'ECONNRESET' || err.code === 'EPIPE' ? resolve({ status: 'reset' }) : reject(err)))
    if (payload) req.write(payload)
    req.end()
  })
}

/** About 12mb of sessions, each with a big chapter list, like an offline backlog from the mobile app */
function largeLocalSessionsPayload() {
  const chapters = Array.from({ length: 400 }, (_, i) => ({ id: i, start: i * 60, end: (i + 1) * 60, title: `Chapter ${i} `.padEnd(200, 'x') }))
  return { sessions: Array.from({ length: 150 }, (_, i) => ({ id: `local-${i}`, libraryItemId: 'li1', currentTime: i, chapters })) }
}

describe('JSON body limits (#4755)', () => {
  let server
  let seenBody

  beforeEach(async () => {
    seenBody = null
    const respond = (req, res) => {
      seenBody = req.body
      res.json({ ok: true })
    }
    sinon.stub(SessionController, 'syncLocalSessions').callsFake(respond)
    sinon.stub(SessionController, 'syncLocal').callsFake(respond)
    sinon.stub(MeController, 'batchUpdateMediaProgress').callsFake(respond)

    // Real ApiRouter route definitions, mounted the way Server.js mounts them
    const apiRouter = new ApiRouter({ auth: { authRateLimiter: (req, res, next) => next() }, apiCacheManager: { middleware: (req, res, next) => next() } })
    const fakeAuth = (req, res, next) => {
      if (req.headers.authorization !== 'Bearer ok') return res.sendStatus(401)
      req.user = { id: 'u1' }
      next()
    }
    const router = express.Router()
    router.use(createJsonBodyParser())
    router.use('/api', fakeAuth, apiRouter.router)
    router.post('/internal-api/echo', (req, res) => res.json({ body: req.body === undefined ? 'unparsed' : req.body }))
    const app = express()
    app.use('/', router)
    app.use((err, req, res, next) => res.sendStatus(err.status || 500))

    server = http.createServer(app)
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  })

  afterEach(async () => {
    sinon.restore()
    await new Promise((resolve) => server.close(resolve))
  })

  it('accepts a local-all payload over 10mb', async () => {
    const payload = largeLocalSessionsPayload()
    expect(Buffer.byteLength(JSON.stringify(payload))).to.be.greaterThan(10 * 1024 * 1024)

    const res = await request(server, 'POST', '/api/session/local-all', payload, { authorization: 'Bearer ok' })

    expect(res.status).to.equal(200)
    expect(seenBody.sessions).to.have.length(150)
  })

  it('accepts a single local session over 10mb', async () => {
    const payload = largeLocalSessionsPayload()
    const res = await request(server, 'POST', '/api/session/local', payload, { authorization: 'Bearer ok' })
    expect(res.status).to.equal(200)
    expect(seenBody.sessions).to.have.length(150)
  })

  it('keeps the 10mb limit on other routes', async () => {
    const res = await request(server, 'PATCH', '/api/me/progress/batch/update', largeLocalSessionsPayload(), { authorization: 'Bearer ok' })
    expect(res.status).to.equal(413)
  })

  it('still parses small bodies on other routes', async () => {
    const res = await request(server, 'PATCH', '/api/me/progress/batch/update', [{ libraryItemId: 'li1', currentTime: 5 }], { authorization: 'Bearer ok' })
    expect(res.status).to.equal(200)
    expect(seenBody).to.deep.equal([{ libraryItemId: 'li1', currentTime: 5 }])
  })

  it('does not parse the large body before authentication', async () => {
    const res = await request(server, 'POST', '/api/session/local-all', largeLocalSessionsPayload())
    expect(res.status).to.equal(401)
    expect(seenBody).to.equal(null)
  })

  it('does not parse internal-api bodies', async () => {
    const res = await request(server, 'POST', '/internal-api/echo', { a: 1 })
    expect(JSON.parse(res.body).body).to.equal('unparsed')
  })

  it('matches the local session sync paths only', () => {
    expect(isLocalSessionSyncPath('/api/session/local')).to.be.true
    expect(isLocalSessionSyncPath('/api/session/local-all/')).to.be.true
    expect(isLocalSessionSyncPath('/api/session/local-allx')).to.be.false
    expect(isLocalSessionSyncPath('/api/session/123/sync')).to.be.false
    expect(isLocalSessionSyncPath('/api/me/progress/batch/update')).to.be.false
  })
})
