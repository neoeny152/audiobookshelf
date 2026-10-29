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

    it('fetches the read-along JSON of a job, null on 404, and enforces its size limit', async () => {
      const jobId = '0123456789abcdef0123456789abcdef'
      let answer = { status: 200, body: { kind: 'abs-readalong', version: 1 } }
      fake = await startFakeServer((req, res) => {
        if (typeof answer.body === 'string') {
          res.writeHead(answer.status, { 'Content-Type': 'application/json' })
          return res.end(answer.body)
        }
        sendJson(res, answer.status, answer.body)
      })
      configureFor(fake.url)
      expect(await chapterbotClient.downloadJobReadAlong(jobId)).to.deep.equal({ kind: 'abs-readalong', version: 1 })
      expect(fake.requests[0].url).to.equal(`/v1/jobs/${jobId}/readalong`)
      expect(fake.requests[0].headers.authorization).to.equal(`Bearer ${TOKEN}`)

      answer = { status: 404, body: { detail: { code: 'not_found', message: 'no read-along data' } } }
      expect(await chapterbotClient.downloadJobReadAlong(jobId)).to.equal(null)

      answer = { status: 409, body: { detail: { code: 'not_done' } } }
      let error = await chapterbotClient.downloadJobReadAlong(jobId).catch((e) => e)
      expect([error.code, error.status]).to.deep.equal(['http_error', 409])

      answer = { status: 200, body: 'not json' }
      error = await chapterbotClient.downloadJobReadAlong(jobId).catch((e) => e)
      expect(error.code).to.equal('bad_response')

      answer = { status: 200, body: [1, 2] }
      error = await chapterbotClient.downloadJobReadAlong(jobId).catch((e) => e)
      expect(error.code).to.equal('bad_response')

      answer = { status: 200, body: { pad: 'x'.repeat(500) } }
      error = await chapterbotClient.downloadJobReadAlong(jobId, { maxBytes: 100 }).catch((e) => e)
      expect(error.code).to.equal('too_large')
      expectNoToken(error.message)

      error = await chapterbotClient.downloadJobReadAlong('../etc').catch((e) => e)
      expect(error.code).to.equal('bad_request')
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
      expect(chapterbotClient.advertisedFeatures(Date.now() + chapterbotClient.HEALTH_FRESH_MS + 60000)).to.deep.equal([])
      await chapterbotClient._health.inflight

      healthy = false
      await chapterbotClient.checkHealth()
      expect(chapterbotClient.advertisedFeatures()).to.deep.equal([])
    })

    describe('feature advertisement while the sidecar is busy', () => {
      const ALL = ['chapterbotVerify', 'chapterbotEpub']

      it('probes /healthz with a timeout that tolerates a busy (CPU-bound) sidecar', () => {
        expect(chapterbotClient.HEALTH_TIMEOUT_MS).to.be.at.least(15000)
        expect(chapterbotClient.HEALTH_FRESH_MS).to.be.at.least(10 * 60000)
      })

      it('keeps the features when a probe times out after a healthy one (busy transcribing)', async () => {
        let slowMs = 0
        fake = await startFakeServer((req, res) => {
          setTimeout(() => sendJson(res, 200, { ok: true, epubWorkers: 1 }), slowMs)
        })
        configureFor(fake.url)
        expect(await chapterbotClient.checkHealth()).to.equal(true)

        slowMs = 300
        expect(await chapterbotClient.checkHealth({ timeoutMs: 30 })).to.equal(true)
        expect(chapterbotClient.advertisedFeatures()).to.deep.equal(ALL)
        // repeated slow probes warn only once
        await chapterbotClient.checkHealth({ timeoutMs: 30 })
        expect(warn.callCount).to.equal(1)
        expectNoToken(warn.firstCall.args[0])
      })

      it('keeps the features when the sidecar cannot be reached for a moment (restart)', async () => {
        fake = await startFakeServer((req, res) => sendJson(res, 200, { ok: true, epubWorkers: 1 }))
        const url = fake.url
        configureFor(url)
        expect(await chapterbotClient.checkHealth()).to.equal(true)
        await fake.close()
        fake = null
        expect(await chapterbotClient.checkHealth()).to.equal(true)
        expect(chapterbotClient.advertisedFeatures()).to.deep.equal(ALL)
      })

      it('drops the features once the last-known-good result is too old', async () => {
        fake = await startFakeServer((req, res) => setTimeout(() => sendJson(res, 200, { ok: true }), 300))
        configureFor(fake.url)
        chapterbotClient._health.ok = true
        chapterbotClient._health.okAt = Date.now() - chapterbotClient.HEALTH_FRESH_MS - 1000
        expect(await chapterbotClient.checkHealth({ timeoutMs: 30 })).to.equal(false)
        expect(chapterbotClient.advertisedFeatures()).to.deep.equal([])
      })

      it('drops the features at once on an explicit unhealthy answer', async () => {
        let healthy = true
        fake = await startFakeServer((req, res) => sendJson(res, healthy ? 200 : 503, { ok: healthy, epubWorkers: healthy ? 1 : 0 }))
        configureFor(fake.url)
        expect(await chapterbotClient.checkHealth()).to.equal(true)
        healthy = false
        expect(await chapterbotClient.checkHealth()).to.equal(false)
        expect(chapterbotClient.advertisedFeatures()).to.deep.equal([])
      })

      it('counts answered /v1 calls (EPUB job polls) as proof of life while /healthz is too slow', async () => {
        const jobId = '0123456789abcdef0123456789abcdef'
        fake = await startFakeServer((req, res) => {
          if (req.url === '/healthz') return setTimeout(() => sendJson(res, 200, { ok: true }), 300)
          sendJson(res, 200, { jobId, status: 'running' })
        })
        configureFor(fake.url)
        // the healthy probe was long ago, every recent probe timed out
        chapterbotClient._health.ok = true
        chapterbotClient._health.okAt = Date.now() - chapterbotClient.HEALTH_FRESH_MS - 1000
        expect(await chapterbotClient.checkHealth({ timeoutMs: 30 })).to.equal(false)
        await chapterbotClient.getJob(jobId)
        expect(chapterbotClient.advertisedFeatures()).to.deep.equal(ALL)
      })

      it('counts a "busy" 503 from /v1 as proof of life, but not after /healthz said unhealthy', async () => {
        let healthy = true
        fake = await startFakeServer((req, res) => {
          if (req.url === '/healthz') return sendJson(res, healthy ? 200 : 503, { ok: healthy })
          sendJson(res, 503, { detail: { code: 'busy', message: 'try later' } })
        })
        configureFor(fake.url)
        expect(await chapterbotClient.checkHealth()).to.equal(true)
        // the healthy probe was long ago
        chapterbotClient._health.okAt = Date.now() - chapterbotClient.HEALTH_FRESH_MS - 1000
        expect(chapterbotClient.advertisedFeatures()).to.deep.equal([])
        await chapterbotClient.getInfo().catch(() => null)
        expect(chapterbotClient.advertisedFeatures()).to.deep.equal(ALL)

        healthy = false
        await chapterbotClient.checkHealth()
        await chapterbotClient.getInfo().catch(() => null)
        expect(chapterbotClient.advertisedFeatures()).to.deep.equal([])
      })

      it('does not count a /v1 503 as proof of life before /healthz ever answered, but does count a 2xx', async () => {
        const jobId = '0123456789abcdef0123456789abcdef'
        let jobStatus = 503
        fake = await startFakeServer((req, res) => {
          if (jobStatus === 503) return sendJson(res, 503, { detail: { code: 'epub_worker_dead', message: 'no worker' } })
          sendJson(res, 200, { jobId, status: 'running' })
        })
        configureFor(fake.url)
        expect(chapterbotClient._health.ok).to.equal(null)
        await chapterbotClient.getJob(jobId).catch(() => null)
        expect(chapterbotClient._health.okAt).to.equal(0)

        jobStatus = 200
        await chapterbotClient.getJob(jobId)
        expect(chapterbotClient._health.okAt).to.be.greaterThan(0)
      })

      for (const [label, status, body] of [
        ['a 502 from a reverse proxy', 502, '<html>Bad Gateway</html>'],
        ['a 504 from a reverse proxy', 504, '<html>Gateway Timeout</html>'],
        ['a 503 without the sidecar {ok: false} body', 503, '<html>Service Unavailable</html>'],
        ['a 503 with a JSON body that is not {ok: false}', 503, JSON.stringify({ detail: 'busy' })]
      ]) {
        it(`keeps the last result on ${label}`, async () => {
          let answer = null
          fake = await startFakeServer((req, res) => {
            if (!answer) return sendJson(res, 200, { ok: true, epubWorkers: 1 })
            res.writeHead(answer.status, { 'Content-Type': 'text/html' })
            res.end(answer.body)
          })
          configureFor(fake.url)
          expect(await chapterbotClient.checkHealth()).to.equal(true)
          answer = { status, body }
          expect(await chapterbotClient.checkHealth()).to.equal(true)
          expect(chapterbotClient._health.ok).to.equal(true)
          expect(chapterbotClient.advertisedFeatures()).to.deep.equal(ALL)
        })
      }

      for (const [label, status, body] of [
        ['a 503 {ok: false} (EPUB worker died)', 503, { ok: false, epubWorkers: 0 }],
        ['a 401', 401, { detail: 'unauthorized' }],
        ['a 500', 500, { detail: 'boom' }],
        ['a 200 without ok: true', 200, { status: 'weird' }]
      ]) {
        it(`drops the features at once on ${label}`, async () => {
          let answer = null
          fake = await startFakeServer((req, res) => (answer ? sendJson(res, answer.status, answer.body) : sendJson(res, 200, { ok: true })))
          configureFor(fake.url)
          expect(await chapterbotClient.checkHealth()).to.equal(true)
          answer = { status, body }
          expect(await chapterbotClient.checkHealth()).to.equal(false)
          expect(chapterbotClient._health.ok).to.equal(false)
          expect(chapterbotClient.advertisedFeatures()).to.deep.equal([])
        })
      }

      it('drops the features at once on a 200 that is not JSON', async () => {
        let garbage = false
        fake = await startFakeServer((req, res) => {
          if (!garbage) return sendJson(res, 200, { ok: true })
          res.writeHead(200, { 'Content-Type': 'text/plain' })
          res.end('not json')
        })
        configureFor(fake.url)
        expect(await chapterbotClient.checkHealth()).to.equal(true)
        garbage = true
        expect(await chapterbotClient.checkHealth()).to.equal(false)
      })

      it('warms up at start so the first /status already has the answer', async () => {
        fake = await startFakeServer((req, res) => sendJson(res, 200, { ok: true, epubWorkers: 1 }))
        configureFor(fake.url)
        const pending = chapterbotClient.warmUp()
        expect(pending).to.be.instanceOf(Promise)
        await pending
        expect(chapterbotClient.advertisedFeatures()).to.deep.equal(ALL)
        // the warm-up counts as the recent check: no second probe
        expect(fake.requests).to.have.length(1)
      })

      it('warmUp does nothing when chapterbot is not configured', () => {
        chapterbotClient.configure({})
        expect(chapterbotClient.warmUp()).to.equal(null)
      })
    })
  })
})
