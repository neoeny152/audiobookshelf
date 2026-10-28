const { expect } = require('chai')
const sinon = require('sinon')
const http = require('http')
const { Writable } = require('stream')

const Logger = require('../../../server/Logger')
const chapterbotClient = require('../../../server/utils/chapterbotClient')

const TOKEN = 'test-token-0123456789abcdef'

/**
 * Fake sidecar: records every request, answers with `handler(req, body, res)`.
 */
async function startFakeServer(handler) {
  const requests = []
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      const entry = { method: req.method, url: req.url, headers: req.headers, body: text ? JSON.parse(text) : null }
      requests.push(entry)
      handler(entry, res)
    })
  })
  const sockets = new Set()
  server.on('connection', (s) => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    server,
    requests,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy()
        server.close(resolve)
      })
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

function expectNoToken(value) {
  expect(String(value)).to.not.include(TOKEN)
  expect(String(value)).to.not.include(TOKEN.slice(0, 12))
}

describe('chapterbotClient', () => {
  let fake
  let warn

  beforeEach(() => {
    warn = sinon.stub(Logger, 'warn')
  })

  afterEach(async () => {
    sinon.restore()
    chapterbotClient.configure({})
    if (fake) await fake.close()
    fake = null
  })

  describe('configuration', () => {
    it('is off without CHAPTERBOT_URL', () => {
      expect(chapterbotClient.configure({})).to.equal(null)
      expect(chapterbotClient.isConfigured()).to.equal(false)
      expect(chapterbotClient.advertisedFeatures()).to.deep.equal([])
    })

    it('stays off when misconfigured and never logs the token', () => {
      const cases = [
        { CHAPTERBOT_URL: 'http://sidecar:8765', CHAPTERBOT_TOKEN: 'short', CHAPTERBOT_PATH_MAP: '/audiobooks=' },
        { CHAPTERBOT_URL: 'ftp://sidecar', CHAPTERBOT_TOKEN: TOKEN, CHAPTERBOT_PATH_MAP: '/audiobooks=' },
        { CHAPTERBOT_URL: 'http://user:pw@sidecar', CHAPTERBOT_TOKEN: TOKEN, CHAPTERBOT_PATH_MAP: '/audiobooks=' },
        { CHAPTERBOT_URL: 'http://sidecar?x=1', CHAPTERBOT_TOKEN: TOKEN, CHAPTERBOT_PATH_MAP: '/audiobooks=' },
        { CHAPTERBOT_URL: 'not a url', CHAPTERBOT_TOKEN: TOKEN, CHAPTERBOT_PATH_MAP: '/audiobooks=' },
        { CHAPTERBOT_URL: 'http://sidecar', CHAPTERBOT_TOKEN: TOKEN, CHAPTERBOT_PATH_MAP: '' },
        { CHAPTERBOT_URL: 'http://sidecar', CHAPTERBOT_TOKEN: TOKEN, CHAPTERBOT_PATH_MAP: 'relative=' },
        { CHAPTERBOT_URL: 'http://sidecar', CHAPTERBOT_TOKEN: TOKEN, CHAPTERBOT_PATH_MAP: '/audiobooks=../up' }
      ]
      for (const env of cases) {
        expect(chapterbotClient.configure(env), JSON.stringify(env.CHAPTERBOT_PATH_MAP)).to.equal(null)
      }
      expect(warn.callCount).to.equal(cases.length)
      for (const call of warn.getCalls()) expectNoToken(call.args.join(' '))
    })

    it('parses a valid configuration', () => {
      const cfg = chapterbotClient.configure({ CHAPTERBOT_URL: 'https://sidecar.lan:9000/cb/', CHAPTERBOT_TOKEN: TOKEN, CHAPTERBOT_PATH_MAP: '/audiobooks=, /mnt/other/=other/books/' })
      expect(cfg).to.include({ origin: 'https://sidecar.lan:9000', basePath: '/cb', secure: true, hostname: 'sidecar.lan', port: 9000 })
      expect(cfg.pathMap).to.deep.equal([
        { abs: '/audiobooks', rel: '' },
        { abs: '/mnt/other', rel: 'other/books' }
      ])
    })
  })

  describe('mapPath', () => {
    const map = chapterbotClient.parsePathMap('/audiobooks=,/audiobooks/kids=children,/mnt/x=lib')

    it('maps by the longest matching prefix', () => {
      expect(chapterbotClient.mapPath('/audiobooks/Author/Book/01.mp3', map)).to.equal('Author/Book/01.mp3')
      expect(chapterbotClient.mapPath('/audiobooks/kids/Book/01.mp3', map)).to.equal('children/Book/01.mp3')
      expect(chapterbotClient.mapPath('/mnt/x/A/B.m4b', map)).to.equal('lib/A/B.m4b')
      expect(chapterbotClient.mapPath('/audiobooks//Author/./Book/01.mp3', map)).to.equal('Author/Book/01.mp3')
    })

    it('refuses files outside every prefix, traversal and non-absolute paths', () => {
      const bad = ['/audiobooks2/Book/01.mp3', '/etc/passwd', '/audiobooks', '/audiobooks/', '/audiobooks/../etc/passwd', 'audiobooks/Book/01.mp3', '', null, '/audiobooks/a\0b.mp3']
      for (const p of bad) {
        expect(() => chapterbotClient.mapPath(p, map), String(p))
          .to.throw(chapterbotClient.ChapterbotError)
          .with.property('code', 'path_unmapped')
      }
    })

    it('accepts Windows separators on both sides', () => {
      const winMap = chapterbotClient.parsePathMap('C:\\Books=')
      expect(chapterbotClient.mapPath('C:\\Books\\Author\\01.mp3', winMap)).to.equal('Author/01.mp3')
    })
  })

  describe('requests', () => {
    function configureFor(url, extra = {}) {
      return chapterbotClient.configure({ CHAPTERBOT_URL: url, CHAPTERBOT_TOKEN: TOKEN, CHAPTERBOT_PATH_MAP: '/audiobooks=', ...extra })
    }

    it('sends the bearer token on /v1 calls but not on /healthz', async () => {
      fake = await startFakeServer((req, res) => {
        if (req.url === '/healthz') return sendJson(res, 200, { ok: true, epubWorkers: 1 })
        if (req.url === '/v1/verify') return sendJson(res, 200, { model: 'base.en', results: [{ start: 10, before: 'end.', after: 'Chapter Two.' }] })
        sendJson(res, 404, {})
      })
      configureFor(fake.url)
      expect(await chapterbotClient.checkHealth()).to.equal(true)
      const result = await chapterbotClient.verify({ files: [{ path: 'A/B.mp3', offset: 0, duration: 100 }], starts: [10] })
      expect(result).to.deep.equal({ model: 'base.en', results: [{ start: 10, before: 'end.', after: 'Chapter Two.' }] })

      expect(fake.requests[0].headers.authorization).to.equal(undefined)
      expect(fake.requests[1].headers.authorization).to.equal(`Bearer ${TOKEN}`)
      expect(fake.requests[1].body).to.deep.equal({ files: [{ path: 'A/B.mp3', offset: 0, duration: 100 }], starts: [10], beforeSec: 8, afterSec: 10, includeWords: false })
    })

    it('keeps the base path of CHAPTERBOT_URL', async () => {
      fake = await startFakeServer((req, res) => sendJson(res, 200, { version: '1' }))
      configureFor(`${fake.url}/chapterbot/`)
      await chapterbotClient.getInfo()
      expect(fake.requests[0].url).to.equal('/chapterbot/v1/info')
    })

    it('times out, and neither the error nor the log carries the token', async () => {
      fake = await startFakeServer(() => {
        /* never answers */
      })
      configureFor(fake.url)
      const started = Date.now()
      let error
      try {
        await chapterbotClient.request('GET', '/v1/info', { timeoutMs: 150 })
      } catch (e) {
        error = e
      }
      expect(Date.now() - started).to.be.below(2000)
      expect(error).to.be.instanceOf(chapterbotClient.ChapterbotError)
      expect(error.code).to.equal('timeout')
      expectNoToken(error.message)
      expectNoToken(error.stack)
      expectNoToken(JSON.stringify(error))
    })

    it('reports HTTP errors with the sidecar code but without the token', async () => {
      fake = await startFakeServer((req, res) => sendJson(res, 400, { detail: { code: 'path_not_found', message: 'no such file', path: 'A/B.mp3' } }))
      configureFor(fake.url)
      const error = await chapterbotClient.verify({ files: [{ path: 'A/B.mp3', offset: 0, duration: 1 }], starts: [0] }).catch((e) => e)
      expect(error).to.include({ code: 'http_error', status: 400, detailCode: 'path_not_found' })
      expectNoToken(error.message)
      expectNoToken(JSON.stringify(error))
    })

    it('reports an unreachable sidecar without the token', async () => {
      fake = await startFakeServer(() => {})
      const url = fake.url
      await fake.close()
      fake = null
      configureFor(url)
      const error = await chapterbotClient.getInfo().catch((e) => e)
      expect(error.code).to.equal('unreachable')
      expectNoToken(error.message)
      expect(await chapterbotClient.checkHealth()).to.equal(false)
    })

    it('limits the response size', async () => {
      fake = await startFakeServer((req, res) => sendJson(res, 200, { pad: 'x'.repeat(5000) }))
      configureFor(fake.url)
      const error = await chapterbotClient.request('GET', '/v1/info', { maxBytes: 1000 }).catch((e) => e)
      expect(error.code).to.equal('too_large')
    })

    it('does not follow redirects', async () => {
      const other = await startFakeServer((req, res) => sendJson(res, 200, { ok: true }))
      try {
        fake = await startFakeServer((req, res) => {
          res.writeHead(302, { Location: `${other.url}/v1/info` })
          res.end()
        })
        configureFor(fake.url)
        const error = await chapterbotClient.getInfo().catch((e) => e)
        expect(error).to.include({ code: 'http_error', status: 302 })
        expect(other.requests).to.have.length(0)
      } finally {
        await other.close()
      }
    })

    it('refuses bad job ids and foreign paths without sending anything', async () => {
      fake = await startFakeServer((req, res) => sendJson(res, 200, {}))
      configureFor(fake.url)
      for (const id of ['../info', 'abc', 'A'.repeat(32), '0123456789abcdef0123456789abcdef/../../x']) {
        const error = await chapterbotClient.getJob(id).catch((e) => e)
        expect(error.code, id).to.equal('bad_request')
      }
      const error = await chapterbotClient.request('GET', '/../admin').catch((e) => e)
      expect(error.code).to.equal('bad_request')
      expect(fake.requests).to.have.length(0)
    })

    it('mapFiles refuses an unmapped file and skips empty tracks', () => {
      chapterbotClient.configure({ CHAPTERBOT_URL: 'http://127.0.0.1:1', CHAPTERBOT_TOKEN: TOKEN, CHAPTERBOT_PATH_MAP: '/audiobooks=' })
      expect(
        chapterbotClient.mapFiles([
          { path: '/audiobooks/A/1.mp3', offset: 0, duration: 10 },
          { path: '/audiobooks/A/2.mp3', offset: 10, duration: 0 }
        ])
      ).to.deep.equal([{ path: 'A/1.mp3', offset: 0, duration: 10 }])
      expect(() => chapterbotClient.mapFiles([{ path: '/elsewhere/A/1.mp3', offset: 0, duration: 10 }])).to.throw(chapterbotClient.ChapterbotError)
    })

    it('aborts on the signal', async () => {
      fake = await startFakeServer(() => {})
      configureFor(fake.url)
      const ac = new AbortController()
      const p = chapterbotClient.request('GET', '/v1/info', { signal: ac.signal, timeoutMs: 5000 })
      setTimeout(() => ac.abort(), 20)
      const error = await p.catch((e) => e)
      expect(error.code).to.equal('aborted')
    })

    it('streams a job result into a sink and enforces its size limit', async () => {
      const jobId = '0123456789abcdef0123456789abcdef'
      const epub = Buffer.alloc(3000, 7)
      fake = await startFakeServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/epub+zip' })
        res.end(epub)
      })
      configureFor(fake.url)
      const chunks = []
      const sink = new Writable({
        write(chunk, enc, cb) {
          chunks.push(chunk)
          cb()
        }
      })
      const { bytes } = await chapterbotClient.downloadJobResult(jobId, sink)
      expect(bytes).to.equal(3000)
      expect(Buffer.concat(chunks).equals(epub)).to.equal(true)
      expect(fake.requests[0].url).to.equal(`/v1/jobs/${jobId}/result`)
      expect(fake.requests[0].headers.authorization).to.equal(`Bearer ${TOKEN}`)

      const small = new Writable({ write: (c, e, cb) => cb() })
      const error = await chapterbotClient.downloadJobResult(jobId, small, { maxBytes: 100 }).catch((e) => e)
      expect(error.code).to.equal('too_large')
    })

    it('turns a sink that fails before the response into an error instead of an unhandled event', async () => {
      const jobId = '0123456789abcdef0123456789abcdef'
      let respond
      fake = await startFakeServer((req, res) => {
        respond = () => {
          res.writeHead(200, { 'Content-Type': 'application/epub+zip' })
          res.end(Buffer.alloc(10))
        }
      })
      configureFor(fake.url)
      const sink = new Writable({ write: (c, e, cb) => cb() })
      const pending = chapterbotClient.downloadJobResult(jobId, sink).catch((e) => e)
      // like fs.createWriteStream failing to open its file while the request is in flight
      sink.emit('error', Object.assign(new Error('permission denied /secret/path'), { code: 'EACCES' }))
      const error = await pending
      expect(error.code).to.equal('write_failed')
      expect(error.message).to.include('EACCES')
      if (respond) respond()
    })

    it('rejects a job result that ends short of its Content-Length', async () => {
      const jobId = '0123456789abcdef0123456789abcdef'
      fake = await startFakeServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/epub+zip', 'Content-Length': '100' })
        res.write(Buffer.alloc(40))
        setTimeout(() => res.socket.destroy(), 20)
      })
      configureFor(fake.url)
      let ended = false
      const sink = new Writable({ write: (c, e, cb) => cb() })
      sink.on('finish', () => {
        ended = true
      })
      const error = await chapterbotClient.downloadJobResult(jobId, sink).catch((e) => e)
      expect(error).to.be.instanceOf(Error)
      expect(error.code).to.equal('unreachable')
      expect(ended).to.equal(false)
    })

    it('advertises the features only after a recent successful health check, without blocking', async () => {
      let healthy = true
      fake = await startFakeServer((req, res) => sendJson(res, healthy ? 200 : 503, { ok: healthy, epubWorkers: healthy ? 1 : 0 }))
      configureFor(fake.url)

      // first call only starts the check
      expect(chapterbotClient.advertisedFeatures()).to.deep.equal([])
      await chapterbotClient._health.inflight
      expect(chapterbotClient.advertisedFeatures()).to.deep.equal(['chapterbotVerify', 'chapterbotEpub'])
      expect(fake.requests).to.have.length(1)

      // a result older than the freshness window is not advertised
      expect(chapterbotClient.advertisedFeatures(Date.now() + 10 * 60000)).to.deep.equal([])
      await chapterbotClient._health.inflight

      healthy = false
      await chapterbotClient.checkHealth()
      expect(chapterbotClient.advertisedFeatures()).to.deep.equal([])
    })
  })
})
