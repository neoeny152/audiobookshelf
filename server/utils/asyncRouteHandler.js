const Logger = require('../Logger')

const ROUTE_METHODS = ['all', 'get', 'post', 'put', 'patch', 'delete', 'use']

/**
 * Express 4 does not catch rejected promises returned by route handlers.
 * The rejection becomes an `unhandledRejection` and the server exits (see Server.js),
 * so one failing request (for example a duplicate join row insert) could take the whole server down.
 *
 * Wraps a handler so a rejected promise (or a thrown error) is passed to `next(err)`.
 * The handler arity is kept, so Express still tells error handlers (4 args) from normal ones.
 *
 * @param {Function} fn
 * @returns {Function}
 */
function wrapHandler(fn) {
  if (typeof fn !== 'function') return fn
  // Express sub-apps and routers are functions too; they handle their own errors
  if (fn.__asyncWrapped || typeof fn.handle === 'function' || typeof fn.set === 'function' || Array.isArray(fn.stack)) return fn

  let wrapped
  if (fn.length === 4) {
    wrapped = function (err, req, res, next) {
      try {
        const result = fn.call(this, err, req, res, next)
        if (result && typeof result.catch === 'function') result.catch(next)
        return result
      } catch (error) {
        next(error)
      }
    }
  } else {
    wrapped = function (req, res, next) {
      try {
        const result = fn.call(this, req, res, next)
        if (result && typeof result.catch === 'function') result.catch(next)
        return result
      } catch (error) {
        next(error)
      }
    }
  }
  Object.defineProperty(wrapped, 'name', { value: fn.name })
  wrapped.__asyncWrapped = true
  return wrapped
}

/**
 * @param {any[]} args
 * @returns {any[]}
 */
function wrapArgs(args) {
  return args.map((arg) => (Array.isArray(arg) ? wrapArgs(arg) : wrapHandler(arg)))
}

/**
 * Patch the route methods of an express app or router instance so every handler registered
 * afterwards is wrapped with {@link wrapHandler}. Only this instance is changed.
 *
 * @param {import('express').Express|import('express').Router} app
 * @returns {typeof app}
 */
function wrapAsyncRoutes(app) {
  for (const method of ROUTE_METHODS) {
    const original = app[method]
    if (typeof original !== 'function') continue
    app[method] = function (...args) {
      // app.get('setting') reads a setting, it does not register a route
      if (method === 'get' && args.length === 1 && typeof args[0] === 'string') {
        return original.apply(this, args)
      }
      return original.apply(this, wrapArgs(args))
    }
  }
  return app
}

/**
 * Final error handler: a failed request gets a plain 500 instead of crashing the server.
 * Errors that already carry a 4xx status (for example from upload or body parsing) keep
 * the default Express handling they had before.
 *
 * @param {string} label
 */
function apiErrorHandler(label) {
  return function (err, req, res, next) {
    const status = Number(err?.status || err?.statusCode)
    if (status >= 400 && status < 500) return next(err)

    Logger.error(`[${label}] Request "${req.method} ${req.originalUrl || req.url}" failed`, err)
    if (res.headersSent) {
      // Response already started (e.g. handler replied early then kept working) - nothing else to send
      if (!res.writableEnded) res.end()
      return
    }
    res.status(500).send('Internal Server Error')
  }
}

module.exports = { wrapHandler, wrapAsyncRoutes, apiErrorHandler }
