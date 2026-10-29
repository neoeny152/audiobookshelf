const express = require('express')

/** Body limit for every JSON route except the local session sync routes */
const DEFAULT_JSON_LIMIT = '10mb'

/**
 * Body limit for /api/session/local and /api/session/local-all (#4755).
 * The mobile apps upload each offline session with its full chapters and audio tracks, so a backlog of
 * offline sessions easily goes past 10mb and then never syncs.
 */
const LOCAL_SESSION_JSON_LIMIT = '50mb'

const LOCAL_SESSION_SYNC_PATHS = ['/api/session/local', '/api/session/local-all']

/**
 * @param {string} path request path relative to the router base path
 * @returns {boolean}
 */
function isLocalSessionSyncPath(path) {
  if (!path) return false
  const normalized = path.toLowerCase().replace(/\/+$/, '')
  return LOCAL_SESSION_SYNC_PATHS.includes(normalized)
}

/**
 * Router-level JSON parser.
 * Skips internal-api routes and the local session sync routes. The local session sync routes parse
 * their own body with a larger limit in ApiRouter, after authentication, so unauthenticated requests
 * never get the larger limit.
 *
 * @returns {import('express').RequestHandler}
 */
function createJsonBodyParser() {
  const parser = express.json({ limit: DEFAULT_JSON_LIMIT })
  return (req, res, next) => {
    if (req.path.startsWith('/internal-api') || isLocalSessionSyncPath(req.path)) return next()
    return parser(req, res, next)
  }
}

/** Route-level JSON parser for the local session sync routes */
const localSessionJsonParser = express.json({ limit: LOCAL_SESSION_JSON_LIMIT })

module.exports = {
  DEFAULT_JSON_LIMIT,
  LOCAL_SESSION_JSON_LIMIT,
  isLocalSessionSyncPath,
  createJsonBodyParser,
  localSessionJsonParser
}
