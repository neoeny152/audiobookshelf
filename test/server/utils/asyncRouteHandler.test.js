const { expect } = require('chai')
const sinon = require('sinon')
const http = require('http')
const express = require('express')

const Logger = require('../../../server/Logger')
const ApiRouter = require('../../../server/routers/ApiRouter')
const MiscController = require('../../../server/controllers/MiscController')
const ApiCacheManager = require('../../../server/managers/ApiCacheManager')
const Auth = require('../../../server/Auth')
const { wrapAsyncRoutes, apiErrorHandler } = require('../../../server/utils/asyncRouteHandler')

/**
 * Serve an express app on a random port, send one request and resolve with { status, body }.
 * Rejects after 2 s (an unhandled async error leaves the request hanging).
 */
function request(app, method, path) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app).listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      const timer = setTimeout(() => {
        server.close()
        reject(new Error('request timed out'))
      }, 2000)
      const req = http.request({ host: '127.0.0.1', port, path, method }, (res) => {
        let body = ''
        res.on('data', (chunk) => (body += chunk))
        res.on('end', () => {
          clearTimeout(timer)
          server.close()
          resolve({ status: res.statusCode, body })
        })
      })
      req.on('error', (error) => {
        clearTimeout(timer)
        server.close()
        reject(error)
      })
      req.end()
    })
  })
}

describe('asyncRouteHandler (#5215: a failed request must not crash the server)', () => {
  let unhandled
  let onUnhandled
  let mochaListeners

  beforeEach(() => {
    sinon.stub(Logger, 'error')
    unhandled = []
    // Mocha fails the run on unhandled rejections; record them instead so the test can assert on them
    mochaListeners = process.listeners('unhandledRejection')
    process.removeAllListeners('unhandledRejection')
    onUnhandled = (reason) => unhandled.push(reason)
    process.on('unhandledRejection', onUnhandled)
  })

  afterEach(() => {
    process.removeListener('unhandledRejection', onUnhandled)
    mochaListeners.forEach((listener) => process.on('unhandledRejection', listener))
    sinon.restore()
  })

  it('turns a rejected async handler into a 500 response', async () => {
    const app = wrapAsyncRoutes(express())
    app.get('/boom', async () => {
      throw new Error('SequelizeUniqueConstraintError')
    })
    app.use(apiErrorHandler('Test'))

    const res = await request(app, 'GET', '/boom')
    expect(res.status).to.equal(500)
    expect(res.body).to.equal('Internal Server Error')
    expect(res.body).to.not.include('SequelizeUniqueConstraintError')
    expect(unhandled).to.have.length(0)
  })

  it('keeps working for normal sync and async handlers and middleware chains', async () => {
    const app = wrapAsyncRoutes(express())
    app.get(
      '/ok',
      (req, res, next) => {
        req.value = 'a'
        next()
      },
      async (req, res) => {
        res.json({ value: req.value })
      }
    )
    app.use(apiErrorHandler('Test'))

    const res = await request(app, 'GET', '/ok')
    expect(res.status).to.equal(200)
    expect(JSON.parse(res.body)).to.deep.equal({ value: 'a' })
    expect(app.get('x-powered-by')).to.equal(true) // app.get(setting) still reads settings
  })

  it('keeps the default handling for errors that carry a 4xx status', async () => {
    const app = wrapAsyncRoutes(express())
    app.set('env', 'test') // keep the default handler quiet
    app.get('/bad', async () => {
      const error = new Error('Request Entity Too Large')
      error.status = 413
      throw error
    })
    app.use(apiErrorHandler('Test'))

    const res = await request(app, 'GET', '/bad')
    expect(res.status).to.equal(413)
  })

  it('does not reply twice when the handler already responded before failing', async () => {
    const app = wrapAsyncRoutes(express())
    app.get('/early', async (req, res) => {
      res.sendStatus(200)
      await Promise.resolve()
      throw new Error('failed after reply')
    })
    app.use(apiErrorHandler('Test'))

    const res = await request(app, 'GET', '/early')
    expect(res.status).to.equal(200)
    await new Promise((resolve) => setImmediate(resolve))
    expect(unhandled).to.have.length(0)
  })

  it('ApiRouter answers 500 instead of an unhandled rejection when a controller throws', async () => {
    sinon.stub(MiscController, 'getLoggerData').rejects(new Error('Validation error: bookAuthors UNIQUE'))
    const apiRouter = new ApiRouter({ auth: new Auth(), apiCacheManager: new ApiCacheManager() })

    const res = await request(apiRouter.router, 'GET', '/logger-data')
    expect(res.status).to.equal(500)
    await new Promise((resolve) => setImmediate(resolve))
    expect(unhandled).to.have.length(0)
  })
})
