/**
 * Auto pipeline library settings (fork only): `library.settings.autoPipeline` of book libraries.
 *
 * The pipeline only runs when the server is started with ABS_AUTO_PIPELINE=1 (see isGateOn). Without it the setting is
 * stored but has no effect, and the autoPipeline server feature is not advertised.
 *
 * Stock clients (old Vue web client, iOS, Android, Plappa) never send `autoPipeline`; updateLibrary keeps stored keys
 * a request leaves out, so their saves preserve it.
 */

const MODES = Object.freeze(['off', 'dryRun', 'on'])

const DEFAULT_AUTO_PIPELINE = Object.freeze({
  mode: 'off',
  autoMatch: true,
  autoMatchMinConfidence: 95,
  autoMatchProvider: null,
  autoChapters: true,
  autoEpub: false,
  settleMinutes: 5,
  /** rewrite MP3s whose stored length is off (seek index repair, with a backup) without asking */
  autoRepairSeekIndex: false,
  /** work through never-processed books of the library in the quiet hours [sweepStart, sweepEnd), server local time */
  nightlySweep: false,
  sweepStart: '01:00',
  sweepEnd: '06:00'
})

const PROVIDER_RE = /^audible(\.[a-z]{2,3})?$/
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/

class AutoPipelineSettingsError extends Error {
  constructor(message) {
    super(message)
    this.name = 'AutoPipelineSettingsError'
  }
}

/**
 * @returns {typeof DEFAULT_AUTO_PIPELINE}
 */
function defaultAutoPipelineSettings() {
  return { ...DEFAULT_AUTO_PIPELINE }
}

/**
 * Stored settings with every key present (older or partial stored objects are filled from the defaults).
 *
 * @param {*} stored
 * @returns {typeof DEFAULT_AUTO_PIPELINE}
 */
function normalizeAutoPipelineSettings(stored) {
  const out = defaultAutoPipelineSettings()
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return out
  try {
    return mergeAutoPipelineSettings(out, stored)
  } catch {
    // an invalid stored value (edited by hand) falls back to the defaults key by key
    for (const key of Object.keys(out)) {
      try {
        Object.assign(out, mergeAutoPipelineSettings(out, { [key]: stored[key] }))
      } catch {
        // keep the default
      }
    }
    return out
  }
}

/**
 * Merge a partial update over the current settings, validating every field it carries.
 * Unknown keys are ignored.
 *
 * @param {Object} current - full settings object
 * @param {*} update - request value
 * @returns {typeof DEFAULT_AUTO_PIPELINE}
 * @throws {AutoPipelineSettingsError}
 */
function mergeAutoPipelineSettings(current, update) {
  if (!update || typeof update !== 'object' || Array.isArray(update)) throw new AutoPipelineSettingsError('Setting "autoPipeline" must be an object')
  const next = { ...defaultAutoPipelineSettings(), ...current }
  for (const key of Object.keys(DEFAULT_AUTO_PIPELINE)) {
    if (!(key in update) || update[key] === undefined) continue
    const value = update[key]
    switch (key) {
      case 'mode':
        if (!MODES.includes(value)) throw new AutoPipelineSettingsError(`Setting "autoPipeline.mode" must be one of ${MODES.join(', ')}`)
        break
      case 'autoMatch':
      case 'autoChapters':
      case 'autoEpub':
      case 'autoRepairSeekIndex':
      case 'nightlySweep':
        if (typeof value !== 'boolean') throw new AutoPipelineSettingsError(`Setting "autoPipeline.${key}" must be a boolean`)
        break
      case 'autoMatchMinConfidence':
        if (!Number.isInteger(value) || value < 50 || value > 100) throw new AutoPipelineSettingsError('Setting "autoPipeline.autoMatchMinConfidence" must be an integer from 50 to 100')
        break
      case 'settleMinutes':
        if (!Number.isInteger(value) || value < 1 || value > 120) throw new AutoPipelineSettingsError('Setting "autoPipeline.settleMinutes" must be an integer from 1 to 120')
        break
      case 'autoMatchProvider':
        if (value !== null && (typeof value !== 'string' || !PROVIDER_RE.test(value))) throw new AutoPipelineSettingsError('Setting "autoPipeline.autoMatchProvider" must be null or an Audible provider (audible, audible.uk, ...)')
        break
      case 'sweepStart':
      case 'sweepEnd':
        if (typeof value !== 'string' || !TIME_RE.test(value)) throw new AutoPipelineSettingsError(`Setting "autoPipeline.${key}" must be a time HH:MM`)
        break
    }
    next[key] = value
  }
  if (next.sweepStart === next.sweepEnd) throw new AutoPipelineSettingsError('Settings "autoPipeline.sweepStart" and "autoPipeline.sweepEnd" must differ')
  return next
}

/**
 * The server gate: ABS_AUTO_PIPELINE=1. Production never sets it.
 *
 * @param {Object} [env]
 * @returns {boolean}
 */
function isGateOn(env = process.env) {
  return String(env.ABS_AUTO_PIPELINE || '').trim() === '1'
}

/**
 * @param {{provider?: string}} library
 * @param {{autoMatchProvider: string|null}} settings
 * @returns {string}
 */
function effectiveProvider(library, settings) {
  return settings.autoMatchProvider || library?.provider || 'google'
}

/**
 * @param {string} provider
 * @returns {boolean}
 */
function isAudibleProvider(provider) {
  return typeof provider === 'string' && PROVIDER_RE.test(provider)
}

/**
 * Audible region of a provider, the same as the stock chapter lookup: audible -> us, audible.uk -> uk.
 *
 * @param {string} provider
 * @returns {string|null} null for a provider that is not Audible
 */
function regionForProvider(provider) {
  if (!isAudibleProvider(provider)) return null
  return provider.includes('.') ? provider.split('.').pop() : 'us'
}

module.exports = {
  MODES,
  DEFAULT_AUTO_PIPELINE,
  AutoPipelineSettingsError,
  defaultAutoPipelineSettings,
  normalizeAutoPipelineSettings,
  mergeAutoPipelineSettings,
  isGateOn,
  effectiveProvider,
  isAudibleProvider,
  regionForProvider
}
