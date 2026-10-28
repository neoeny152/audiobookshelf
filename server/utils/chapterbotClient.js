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
const HEALTH_TIMEOUT_MS = 5000
/** Health is re-checked at most this often (in the background, never blocking /status) */
const HEALTH_RECHECK_MS = 60000
/** The features are advertised while the last health check succeeded and is at most this old */
const HEALTH_FRESH_MS = 5 * 60000
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
const health = { checkedAt: 0, okAt: 0, ok: false, inflight: null }

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
  health.ok = false
  health.inflight = null
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
 * @returns {Promise<{status: number, headers: Object, json?: *, bytes?: number}>}
 */
function request(method, path, opts = {}) {
  const cfg = requireConfig()
  const { body, timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = MAX_JSON_BYTES, signal = null, auth = true, sink = null } = opts
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
 * GET /healthz (no token sent). Updates the cached health used for /status.
 *
 * @returns {Promise<boolean>}
 */
async function checkHealth() {
  const now = Date.now()
  health.checkedAt = now
  try {
    const { json } = await request('GET', '/healthz', { auth: false, timeoutMs: HEALTH_TIMEOUT_MS, maxBytes: 4096 })
    health.ok = json?.ok === true
    if (health.ok) health.okAt = Date.now()
  } catch (error) {
    if (health.ok) Logger.warn(`[Chapterbot] Health check failed: ${error.message}`)
    health.ok = false
  }
  return health.ok
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
  if (!health.inflight && now - health.checkedAt >= HEALTH_RECHECK_MS) {
    health.inflight = checkHealth()
      .catch(() => false)
      .finally(() => {
        health.inflight = null
      })
  }
  return health.ok && now - health.okAt <= HEALTH_FRESH_MS ? [...FEATURES] : []
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
  advertisedFeatures,
  mapFiles,
  mapOnePath,
  verify,
  createEpubJob,
  getJob,
  downloadJobResult,
  deleteJob,
  getInfo,
  /** for tests */
  _health: health
}
