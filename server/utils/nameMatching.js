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

module.exports = { nameKey, namesMatch, dedupeNames, dedupeSeries }
