const http = require('http')
const https = require('https')
const Path = require('path')
const Logger = require('../Logger')

/**
 * Client for the optional abs-chapterbot sidecar (Whisper speech check and EPUB-from-audio).
 *
 * Off unless configured from the environment:
 * - CHAPTERBOT_URL: base URL of the sidecar, e.g. http://chapterbot:8765 (http or https, no credentials, query or hash)
 * - CHAPTERBOT_TOKEN: shared bearer token (at least 16 characters, as the sidecar requires)
 * - CHAPTERBOT_PATH_MAP: comma list of "absPrefix=sidecarRelativePrefix". The sidecar wants paths relative to its
 *   MEDIA_ROOT, so "/audiobooks=" turns "/audiobooks/Author/Book/01.mp3" into "Author/Book/01.mp3" and
 *   "/audiobooks=books" into "books/Author/Book/01.mp3". A file outside every mapped prefix is an error and is never sent.
 *
 * Only the configured base URL is ever contacted (redirects are not followed). The token is only ever written to the
 * Authorization header: it is never logged and never part of an error message.
 */

const FEATURES = Object.freeze(['chapterbotVerify', 'chapterbotEpub'])
const MIN_TOKEN_LENGTH = 16
const DEFAULT_TIMEOUT_MS = 30000
/**
 * /healthz is cheap, but a sidecar busy transcribing (CPU-bound Whisper threads) can take many seconds to answer it.
 * The probe runs in the background, so a generous timeout costs nothing.
 */
const HEALTH_TIMEOUT_MS = 20000
/** Health is re-checked at most this often (in the background, never blocking /status) */
const HEALTH_RECHECK_MS = 60000
/**
 * Last-known-good window: the features stay advertised while the sidecar was last seen working at most this long ago.
 * A probe that times out or cannot connect does not drop them on its own (a busy or restarting sidecar is still the
 * sidecar); only an explicit unhealthy answer from /healthz does, or this window running out.
 */
const HEALTH_FRESH_MS = 15 * 60000
const MAX_JSON_BYTES = 2 * 1024 * 1024
const MAX_ERROR_BYTES = 64 * 1024
const JOB_ID_RE = /^[0-9a-f]{32}$/

class ChapterbotError extends Error {
  /**
   * @param {string} code - stable machine code (not_configured, path_unmapped, timeout, unreachable, http_error, bad_response, too_large, aborted)
   * @param {string} message - safe to log; never contains the token
   * @param {Object} [extra]
   * @param {number} [extra.status] - HTTP status from the sidecar
   * @param {string} [extra.detailCode] - the sidecar's own error code
   */
  constructor(code, message, extra = {}) {
    super(message)
    this.name = 'ChapterbotError'
    this.code = code
    if (extra.status !== undefined) this.status = extra.status
    if (extra.detailCode !== undefined) this.detailCode = extra.detailCode
  }
}

function normalizeSlashes(value) {
  return String(value).replace(/\\/g, '/')
}

function isAbsolutePrefix(value) {
  return value.startsWith('/') || /^[A-Za-z]:\//.test(value)
}

/**
 * Parse CHAPTERBOT_PATH_MAP. Throws on a malformed entry.
 *
 * @param {string} raw
 * @returns {{abs: string, rel: string}[]} longest prefix first
 */
function parsePathMap(raw) {
  const entries = []
  for (const part of String(raw || '').split(',')) {
    const item = part.trim()
    if (!item) continue
    const eq = item.indexOf('=')
    if (eq < 0) throw new Error(`CHAPTERBOT_PATH_MAP entry "${item}" must look like /absPrefix=relativePrefix`)
    let abs = normalizeSlashes(item.slice(0, eq).trim())
    let rel = normalizeSlashes(item.slice(eq + 1).trim())
    if (!isAbsolutePrefix(abs)) throw new Error(`CHAPTERBOT_PATH_MAP prefix "${abs}" must be absolute`)
    abs = Path.posix.normalize(abs).replace(/\/+$/, '')
    if (abs.split('/').includes('..')) throw new Error(`CHAPTERBOT_PATH_MAP prefix "${abs}" must not contain ".."`)
    rel = rel.replace(/^\/+|\/+$/g, '')
    if (rel) {
      if (isAbsolutePrefix(rel) || rel.split('/').some((seg) => seg === '..' || seg === '.' || seg === '')) {
        throw new Error(`CHAPTERBOT_PATH_MAP target "${rel}" must be a plain relative path`)
      }
    }
    entries.push({ abs, rel })
  }
  return entries.sort((a, b) => b.abs.length - a.abs.length)
}

/**
 * Map an absolute server path to a path relative to the sidecar's MEDIA_ROOT.
 *
 * @param {string} absPath
 * @param {{abs: string, rel: string}[]} pathMap
 * @returns {string}
 * @throws {ChapterbotError} path_unmapped
 */
function mapPath(absPath, pathMap) {
  const unmapped = () => new ChapterbotError('path_unmapped', 'File is outside every CHAPTERBOT_PATH_MAP prefix')
  if (typeof absPath !== 'string' || !absPath || absPath.includes('\0')) throw unmapped()
  const raw = normalizeSlashes(absPath)
  if (!isAbsolutePrefix(raw) || raw.split('/').includes('..')) throw unmapped()
  const p = Path.posix.normalize(raw)
  for (const { abs, rel } of pathMap || []) {
    // abs is '' for a "/" prefix: everything below the root
    if (!p.startsWith(abs + '/')) continue
    const rest = p.slice(abs.length + 1)
    if (!rest) continue
    return rel ? `${rel}/${rest}` : rest
  }
  throw unmapped()
}

/**
 * @typedef ChapterbotConfig
 * @property {string} origin
 * @property {string} basePath - '' or '/prefix' (no trailing slash)
 * @property {boolean} secure
 * @property {string} hostname
 * @property {number} port
 * @property {string} token
 * @property {{abs: string, rel: string}[]} pathMap
 */

/**
 * @param {Object} env
 * @returns {ChapterbotConfig|null} null when not configured or misconfigured (logged once, without the token)
 */
function loadConfig(env) {
  const rawUrl = (env.CHAPTERBOT_URL || '').trim()
  if (!rawUrl) return null
  const token = (env.CHAPTERBOT_TOKEN || '').trim()
  if (token.length < MIN_TOKEN_LENGTH) {
    Logger.warn(`[Chapterbot] CHAPTERBOT_URL is set but CHAPTERBOT_TOKEN is missing or shorter than ${MIN_TOKEN_LENGTH} characters, chapterbot is disabled`)
    return null
  }
  let url
  try {
    url = new URL(rawUrl)
  } catch {
    Logger.warn(`[Chapterbot] CHAPTERBOT_URL is not a valid URL, chapterbot is disabled`)
    return null
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    Logger.warn(`[Chapterbot] CHAPTERBOT_URL must be a plain http(s) URL without credentials, query or hash, chapterbot is disabled`)
    return null
  }
  let pathMap
  try {
    pathMap = parsePathMap(env.CHAPTERBOT_PATH_MAP)
  } catch (error) {
    Logger.warn(`[Chapterbot] ${error.message}, chapterbot is disabled`)
    return null
  }
  if (!pathMap.length) {
    Logger.warn(`[Chapterbot] CHAPTERBOT_PATH_MAP is empty, so no file could be sent; chapterbot is disabled`)
    return null
  }
  const secure = url.protocol === 'https:'
  return Object.freeze({
    origin: url.origin,
    basePath: url.pathname.replace(/\/+$/, ''),
    secure,
    hostname: url.hostname.replace(/^\[|\]$/g, ''),
    port: url.port ? Number(url.port) : secure ? 443 : 80,
    token,
    pathMap: Object.freeze(pathMap.map((e) => Object.freeze(e)))
  })
}

/** @type {ChapterbotConfig|null|undefined} undefined = not loaded yet */
let config
/**
 * ok: the last verdict /healthz gave (null = none yet, or only failed probes since configure)
 * okAt: when the sidecar was last seen working (a healthy /healthz, or any answered /v1 call while not unhealthy)
 */
const health = { checkedAt: 0, okAt: 0, ok: null, inflight: null, failing: false }

function getConfig() {
  if (config === undefined) config = loadConfig(process.env)
  return config
}

function isConfigured() {
  return !!getConfig()
}

/**
 * Re-read the configuration (tests). Pass an env object or nothing for process.env.
 *
 * @param {Object} [env]
 */
function configure(env = process.env) {
  config = loadConfig(env)
  health.checkedAt = 0
  health.okAt = 0
  health.ok = null
  health.inflight = null
  health.failing = false
  return config
}

function requireConfig() {
  const cfg = getConfig()
  if (!cfg) throw new ChapterbotError('not_configured', 'Chapterbot is not configured')
  return cfg
}

/**
 * One HTTP request to the sidecar. `path` is built by this module from fixed templates only.
 *
 * @param {string} method
 * @param {string} path - starts with /v1/ or is /healthz
 * @param {Object} [opts]
 * @param {*} [opts.body] - JSON body
 * @param {number} [opts.timeoutMs] - whole request, connect to last byte
 * @param {number} [opts.maxBytes] - response body limit
 * @param {AbortSignal} [opts.signal]
 * @param {boolean} [opts.auth]
 * @param {import('stream').Writable} [opts.sink] - stream a 2xx body here instead of parsing JSON
 * @param {boolean} [opts.anyStatus] - resolve non-2xx answers too (json is undefined when the body is not JSON)
 * @returns {Promise<{status: number, headers: Object, json?: *, bytes?: number}>}
 */
function request(method, path, opts = {}) {
  const cfg = requireConfig()
  const { body, timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = MAX_JSON_BYTES, signal = null, auth = true, sink = null, anyStatus = false } = opts
  const label = `${method} ${path}`

  // Never contact anything but the configured base URL
  const target = new URL(cfg.basePath + path, cfg.origin)
  if (target.origin !== cfg.origin || !(target.pathname === `${cfg.basePath}/healthz` || target.pathname.startsWith(`${cfg.basePath}/v1/`))) {
    return Promise.reject(new ChapterbotError('bad_request', `Refusing chapterbot request ${label}`))
  }

  return new Promise((resolve, reject) => {
    let settled = false
    let timer = null
    let req = null

    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
      if (error) {
        if (req) req.destroy()
        reject(error)
      } else {
        resolve(value)
      }
    }
    const onAbort = () => finish(new ChapterbotError('aborted', `Chapterbot ${label} aborted`))

    if (signal?.aborted) return onAbort()

    // Listen on the sink from the start: a file sink can fail (e.g. open() EACCES) before the response arrives,
    // and an 'error' with no listener would crash the process
    if (sink) sink.on('error', (error) => finish(new ChapterbotError('write_failed', `Writing chapterbot ${label} response failed: ${error.code || error.message}`)))

    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8')
    const headers = { Accept: sink ? 'application/epub+zip, application/json' : 'application/json' }
    if (payload) {
      headers['Content-Type'] = 'application/json'
      headers['Content-Length'] = String(payload.length)
    }
    if (auth) headers.Authorization = `Bearer ${cfg.token}`

    const transport = cfg.secure ? https : http
    req = transport.request({ hostname: cfg.hostname, port: cfg.port, method, path: target.pathname, headers, agent: false })

    timer = setTimeout(() => finish(new ChapterbotError('timeout', `Chapterbot ${label} timed out after ${timeoutMs} ms`)), timeoutMs)
    if (signal) signal.addEventListener('abort', onAbort)

    req.on('error', (error) => {
      // Only the error code: messages can echo request details
      finish(new ChapterbotError('unreachable', `Chapterbot ${label} failed: ${error.code || 'network error'}`))
    })

    req.on('response', (res) => {
      const status = res.statusCode || 0
      const ok = status >= 200 && status < 300
      // A /v1 answer proves the sidecar is up even while /healthz is too slow (busy) to answer in time.
      // /healthz itself is judged by checkHealth.
      if (target.pathname !== `${cfg.basePath}/healthz`) noteAlive(status)
      const limit = ok ? maxBytes : MAX_ERROR_BYTES

      if (ok && sink) {
        let bytes = 0
        res.on('data', (chunk) => {
          bytes += chunk.length
          if (bytes > limit) return finish(new ChapterbotError('too_large', `Chapterbot ${label} response is larger than ${limit} bytes`))
          if (!sink.write(chunk)) res.pause()
        })
        const expected = /^\d+$/.test(res.headers['content-length'] || '') ? Number(res.headers['content-length']) : null
        sink.on('drain', () => res.resume())
        sink.on('finish', () => finish(null, { status, headers: res.headers, bytes }))
        res.on('end', () => {
          if (settled) return
          // never hand on a body cut short (e.g. the job deleted on the sidecar mid-download)
          if (expected !== null && bytes !== expected) return finish(new ChapterbotError('unreachable', `Chapterbot ${label} response ended after ${bytes} of ${expected} bytes`))
          sink.end()
        })
        res.on('error', () => finish(new ChapterbotError('unreachable', `Chapterbot ${label} response was interrupted`)))
        return
      }

      const chunks = []
      let bytes = 0
      res.on('data', (chunk) => {
        bytes += chunk.length
        if (bytes > limit) return finish(new ChapterbotError('too_large', `Chapterbot ${label} response is larger than ${limit} bytes`))
        chunks.push(chunk)
      })
      res.on('error', () => finish(new ChapterbotError('unreachable', `Chapterbot ${label} response was interrupted`)))
      res.on('end', () => {
        if (settled) return
        let json
        const text = Buffer.concat(chunks).toString('utf8')
        try {
          json = text ? JSON.parse(text) : null
        } catch {
          json = undefined
        }
        if (!ok && anyStatus) return finish(null, { status, headers: res.headers, json })
        if (!ok) {
          const detail = json && typeof json.detail === 'object' && !Array.isArray(json.detail) ? json.detail : null
          const detailCode = typeof detail?.code === 'string' ? detail.code.slice(0, 64) : undefined
          const detailMessage = typeof detail?.message === 'string' ? `: ${detail.message.slice(0, 200)}` : ''
          return finish(new ChapterbotError('http_error', `Chapterbot ${label} returned ${status}${detailCode ? ` (${detailCode})` : ''}${detailMessage}`, { status, detailCode }))
        }
        if (json === undefined) return finish(new ChapterbotError('bad_response', `Chapterbot ${label} returned invalid JSON`))
        finish(null, { status, headers: res.headers, json })
      })
    })

    if (payload) req.write(payload)
    req.end()
  })
}

/**
 * The sidecar answered a /v1 call: refresh the last-known-good time.
 * - 2xx: unless /healthz said it is broken
 * - 429/503 ("busy"): only once /healthz has said it is healthy. Before any /healthz verdict a 503 could just as well
 *   come from a dead EPUB worker, so it is no proof of a working sidecar.
 *
 * @param {number} status
 */
function noteAlive(status) {
  if (status >= 200 && status < 300) {
    if (health.ok !== false) health.okAt = Date.now()
  } else if (status === 429 || status === 503) {
    if (health.ok === true) health.okAt = Date.now()
  }
}

/**
 * Whether a non-200 /healthz answer says nothing about the sidecar itself: a reverse proxy in front of a sidecar that
 * is restarting or too busy to answer (502/504), or a 503 without the sidecar's own {ok: false} body.
 *
 * @param {number} status
 * @param {*} json
 */
function isTransientHealthAnswer(status, json) {
  if (status === 502 || status === 504) return true
  return status === 503 && !(json && typeof json === 'object' && json.ok === false)
}

/**
 * GET /healthz (no token sent). Updates the cached health used for /status.
 *
 * - 200 {ok: true}: healthy
 * - 503 {ok: false} (an EPUB worker died), other 4xx/5xx, a 200 without ok: true, garbage: unhealthy, features drop at once
 * - timeout / connection error, 502/504 or a 503 without {ok: false} (a proxy in front of a restarting or busy
 *   sidecar): no verdict, the last-known-good result is kept (see HEALTH_FRESH_MS)
 *
 * @param {Object} [opts]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<boolean>} whether the features are advertised afterwards
 */
async function checkHealth({ timeoutMs = HEALTH_TIMEOUT_MS } = {}) {
  health.checkedAt = Date.now()
  try {
    const { status, json } = await request('GET', '/healthz', { auth: false, timeoutMs, maxBytes: 4096, anyStatus: true })
    if (status < 200 || status >= 300) {
      const message = `Chapterbot GET /healthz returned ${status}`
      if (isTransientHealthAnswer(status, json)) throw new ChapterbotError('unreachable', message, { status })
      throw new ChapterbotError('http_error', message, { status })
    }
    const ok = json?.ok === true
    if (!ok && health.ok !== false) Logger.warn(`[Chapterbot] Health check says the sidecar is unhealthy`)
    health.ok = ok
    if (ok) health.okAt = Date.now()
    health.failing = false
  } catch (error) {
    if (error.code === 'http_error' || error.code === 'bad_response' || error.code === 'too_large') {
      if (health.ok !== false) Logger.warn(`[Chapterbot] Health check failed: ${error.message}`)
      health.ok = false
    } else if (!health.failing) {
      // busy or restarting: keep the last verdict, warn once per run of failures
      Logger.warn(`[Chapterbot] Health check failed, keeping the last result for now: ${error.message}`)
    }
    health.failing = true
  }
  return isAdvertised()
}

function isAdvertised(now = Date.now()) {
  return health.ok !== false && health.okAt > 0 && now - health.okAt <= HEALTH_FRESH_MS
}

/**
 * Start a background health check when the last one is older than HEALTH_RECHECK_MS (or `force`).
 *
 * @param {number} [now]
 * @param {boolean} [force]
 * @returns {Promise<boolean>|null} the running check, if any
 */
function refreshHealth(now = Date.now(), force = false) {
  if (!getConfig()) return null
  if (!health.inflight && (force || now - health.checkedAt >= HEALTH_RECHECK_MS)) {
    health.inflight = checkHealth()
      .catch(() => false)
      .finally(() => {
        health.inflight = null
      })
  }
  return health.inflight
}

/**
 * Probe the sidecar once at server start, so the first GET /status after a restart already has an answer.
 * Never throws and never blocks startup.
 *
 * @returns {Promise<boolean>|null}
 */
function warmUp() {
  return refreshHealth(Date.now(), true)
}

/**
 * Feature names for GET /status. Never blocks: a stale health check is refreshed in the background
 * and the answer uses the cached result.
 *
 * @param {number} [now]
 * @returns {string[]}
 */
function advertisedFeatures(now = Date.now()) {
  if (!getConfig()) return []
  refreshHealth(now)
  return isAdvertised(now) ? [...FEATURES] : []
}

/**
 * Timeline tracks -> sidecar files. Zero-length tracks are left out (they hold no audio).
 *
 * @param {{path: string, offset: number, duration: number}[]} timeline
 * @returns {{path: string, offset: number, duration: number}[]}
 * @throws {ChapterbotError} path_unmapped
 */
function mapFiles(timeline) {
  const cfg = requireConfig()
  return timeline.filter((t) => t.duration > 0).map((t) => ({ path: mapPath(t.path, cfg.pathMap), offset: t.offset, duration: t.duration }))
}

/**
 * Map one path (e.g. a cover) with the configured map.
 *
 * @param {string} absPath
 * @returns {string}
 */
function mapOnePath(absPath) {
  return mapPath(absPath, requireConfig().pathMap)
}

/**
 * POST /v1/verify
 *
 * @param {Object} params
 * @param {{path: string, offset: number, duration: number}[]} params.files - already mapped
 * @param {number[]} params.starts
 * @param {number} [params.beforeSec]
 * @param {number} [params.afterSec]
 * @param {AbortSignal} [params.signal]
 * @param {number} [params.timeoutMs]
 * @returns {Promise<{model: string, results: {start: number, before: string, after: string}[]}>}
 */
async function verify({ files, starts, beforeSec = 8, afterSec = 10, signal = null, timeoutMs = 120000 }) {
  const { json } = await request('POST', '/v1/verify', { body: { files, starts, beforeSec, afterSec, includeWords: false }, signal, timeoutMs })
  if (!json || !Array.isArray(json.results)) throw new ChapterbotError('bad_response', 'Chapterbot verify returned no results')
  const results = json.results
    .filter((r) => r && typeof r.start === 'number' && Number.isFinite(r.start))
    .map((r) => ({
      start: r.start,
      before: typeof r.before === 'string' ? r.before : '',
      after: typeof r.after === 'string' ? r.after : ''
    }))
  return { model: typeof json.model === 'string' ? json.model : null, results }
}

/**
 * POST /v1/transcribe: whole ranges of the book with word timestamps on the book timeline (chapter heading search).
 * A sidecar without the endpoint answers 404 (ChapterbotError with status 404).
 *
 * @param {Object} params
 * @param {{path: string, offset: number, duration: number}[]} params.files - already mapped
 * @param {{start: number, length: number}[]} params.ranges
 * @param {AbortSignal} [params.signal]
 * @param {number} [params.timeoutMs]
 * @returns {Promise<{model: string|null, results: {start: number, length: number, text: string, words: [number, number, string][]}[]}>}
 */
async function transcribe({ files, ranges, signal = null, timeoutMs = 120000 }) {
  const { json } = await request('POST', '/v1/transcribe', { body: { files, ranges, includeWords: true }, signal, timeoutMs })
  if (!json || !Array.isArray(json.results)) throw new ChapterbotError('bad_response', 'Chapterbot transcribe returned no results')
  const results = json.results
    .filter((r) => r && typeof r.start === 'number' && Number.isFinite(r.start))
    .map((r) => ({
      start: r.start,
      length: typeof r.length === 'number' ? r.length : 0,
      text: typeof r.text === 'string' ? r.text : '',
      words: (Array.isArray(r.words) ? r.words : []).filter((w) => Array.isArray(w) && w.length >= 3 && Number.isFinite(w[0]) && Number.isFinite(w[1]) && typeof w[2] === 'string')
    }))
  return { model: typeof json.model === 'string' ? json.model : null, results }
}

function checkJobId(jobId) {
  if (typeof jobId !== 'string' || !JOB_ID_RE.test(jobId)) throw new ChapterbotError('bad_request', 'Invalid chapterbot job id')
  return jobId
}

/**
 * POST /v1/epub/jobs
 *
 * @param {Object} payload - EpubRequest (paths already mapped)
 * @returns {Promise<{jobId: string, status: string}>}
 */
async function createEpubJob(payload) {
  const { json } = await request('POST', '/v1/epub/jobs', { body: payload, timeoutMs: 60000 })
  if (!json || typeof json.jobId !== 'string' || !JOB_ID_RE.test(json.jobId)) throw new ChapterbotError('bad_response', 'Chapterbot returned no job id')
  return { jobId: json.jobId, status: typeof json.status === 'string' ? json.status : 'queued' }
}

/**
 * GET /v1/jobs/{id}
 *
 * @param {string} jobId
 * @returns {Promise<Object>}
 */
async function getJob(jobId) {
  const { json } = await request('GET', `/v1/jobs/${checkJobId(jobId)}`, { timeoutMs: 15000, maxBytes: 64 * 1024 })
  if (!json || typeof json.status !== 'string') throw new ChapterbotError('bad_response', 'Chapterbot returned no job status')
  return json
}

/**
 * GET /v1/jobs/{id}/result streamed into `sink`
 *
 * @param {string} jobId
 * @param {import('stream').Writable} sink
 * @param {{maxBytes?: number, timeoutMs?: number}} [opts]
 * @returns {Promise<{bytes: number}>}
 */
async function downloadJobResult(jobId, sink, { maxBytes = 500 * 1024 * 1024, timeoutMs = 30 * 60000 } = {}) {
  const { bytes } = await request('GET', `/v1/jobs/${checkJobId(jobId)}/result`, { sink, maxBytes, timeoutMs })
  return { bytes }
}

/**
 * GET /v1/jobs/{id}/readalong: the read-along JSON built with a finished EPUB job's result
 *
 * @param {string} jobId
 * @param {{maxBytes?: number, timeoutMs?: number}} [opts]
 * @returns {Promise<Object|null>} null when the job has no read-along data (404: a sidecar older than the feature)
 */
async function downloadJobReadAlong(jobId, { maxBytes = 32 * 1024 * 1024, timeoutMs = 2 * 60000 } = {}) {
  const { status, json } = await request('GET', `/v1/jobs/${checkJobId(jobId)}/readalong`, { maxBytes, timeoutMs, anyStatus: true })
  if (status === 404) return null
  if (status < 200 || status >= 300) throw new ChapterbotError('http_error', `Chapterbot GET /v1/jobs/{id}/readalong returned ${status}`, { status })
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new ChapterbotError('bad_response', 'Chapterbot returned invalid read-along data')
  return json
}

/**
 * DELETE /v1/jobs/{id}: cancels a queued/running job, deletes a finished one
 *
 * @param {string} jobId
 * @returns {Promise<Object>}
 */
async function deleteJob(jobId) {
  const { json } = await request('DELETE', `/v1/jobs/${checkJobId(jobId)}`, { timeoutMs: 15000, maxBytes: 64 * 1024 })
  return json
}

/**
 * GET /v1/info
 *
 * @returns {Promise<Object>}
 */
async function getInfo() {
  const { json } = await request('GET', '/v1/info', { timeoutMs: 10000, maxBytes: 64 * 1024 })
  return json
}

module.exports = {
  FEATURES,
  JOB_ID_RE,
  ChapterbotError,
  parsePathMap,
  mapPath,
  loadConfig,
  configure,
  isConfigured,
  getConfig,
  request,
  checkHealth,
  warmUp,
  advertisedFeatures,
  mapFiles,
  mapOnePath,
  verify,
  transcribe,
  createEpubJob,
  getJob,
  downloadJobResult,
  downloadJobReadAlong,
  deleteJob,
  getInfo,
  HEALTH_TIMEOUT_MS,
  HEALTH_FRESH_MS,
  /** for tests */
  _health: health
}
