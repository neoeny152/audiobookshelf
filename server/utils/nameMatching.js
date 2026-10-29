/**
 * Helpers for matching author and series names.
 * Names are compared case-insensitively everywhere (lookups in the DB already use lower(name)),
 * so "Max" and "max" are the same author and "Harry Potter" / "harry potter" the same series.
 */

/**
 * @param {string} name
 * @returns {string}
 */
function nameKey(name) {
  return typeof name === 'string' ? name.trim().toLowerCase() : ''
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function namesMatch(a, b) {
  return nameKey(a) === nameKey(b)
}

/**
 * Remove empty and duplicate names (case-insensitive). The first spelling wins.
 * e.g. ["Foo", "foo", " Bar ", ""] => ["Foo", "Bar"]
 *
 * @param {string[]} names
 * @returns {string[]}
 */
function dedupeNames(names) {
  if (!Array.isArray(names)) return names
  const seen = new Set()
  const result = []
  for (const name of names) {
    if (typeof name !== 'string') continue
    const trimmed = name.trim()
    const key = trimmed.toLowerCase()
    if (!key || seen.has(key)) continue
    seen.add(key)
    result.push(trimmed)
  }
  return result
}

/**
 * Remove duplicate series objects by name (case-insensitive). The first one wins;
 * if it has no sequence it takes the sequence of a later duplicate.
 *
 * @template T
 * @param {T[]} seriesObjects
 * @param {string} [nameProp] property holding the series name (default "name")
 * @param {string} [sequenceProp] property holding the sequence (default "sequence")
 * @returns {T[]}
 */
function dedupeSeries(seriesObjects, nameProp = 'name', sequenceProp = 'sequence') {
  if (!Array.isArray(seriesObjects)) return seriesObjects
  /** @type {Map<string, T>} */
  const byKey = new Map()
  for (const seriesObj of seriesObjects) {
    const key = nameKey(seriesObj?.[nameProp])
    if (!key) continue
    const existing = byKey.get(key)
    if (!existing) {
      byKey.set(key, { ...seriesObj })
    } else if (!existing[sequenceProp] && seriesObj[sequenceProp]) {
      existing[sequenceProp] = seriesObj[sequenceProp]
    }
  }
  return [...byKey.values()]
}

/**
 * Lowercase only A-Z, exactly like SQLite's built-in lower() (no ICU).
 * Lookups that must agree with a SQL lower(name) comparison (the in-memory filter data cache)
 * use this, so "Émile" and "émile" are different names whether or not the cache is loaded.
 *
 * @param {string} str
 * @returns {string}
 */
function asciiLowerCase(str) {
  return typeof str === 'string' ? str.replace(/[A-Z]+/g, (s) => s.toLowerCase()) : ''
}

/**
 * Sequelize condition: column equals name, ignoring ASCII case.
 * Both sides go through SQLite's lower(), so a non-ASCII name still matches its exact spelling
 * (JS toLowerCase() on one side only would turn "Émile" into "émile", which lower(name) never returns).
 *
 * @param {string} name
 * @param {string} [column]
 */
function sqlNameEquals(name, column = 'name') {
  const { where, fn, col } = require('sequelize')
  return where(fn('lower', col(column)), fn('lower', name))
}

/**
 * Pick which of a book's linked authors/series to keep for the wanted names.
 * For each wanted name, the linked records with that name in any case are candidates; the one with the
 * exact spelling is kept, otherwise the first one (callers pass links oldest first). Other candidates are
 * near-duplicates left by older bugs ("max" and "Max" both linked) and are not kept, nor are records that
 * match no wanted name.
 *
 * @template {{ name: string }} T
 * @param {T[]} linkedRecords in link order, oldest first
 * @param {string[]} wantedNames
 * @returns {Map<T, string>} kept record => wanted spelling
 */
function pickLinksToKeep(linkedRecords, wantedNames) {
  /** @type {Map<T, string>} */
  const kept = new Map()
  for (const wantedName of wantedNames) {
    const candidates = linkedRecords.filter((record) => namesMatch(record.name, wantedName))
    if (!candidates.length) continue
    const keep = candidates.find((record) => record.name === wantedName) || candidates[0]
    if (!kept.has(keep)) kept.set(keep, wantedName)
  }
  return kept
}

module.exports = { nameKey, namesMatch, dedupeNames, dedupeSeries, asciiLowerCase, sqlNameEquals, pickLinksToKeep }
