/**
 * Duplicate item detection (#5676)
 *
 * Pure helpers that group library items which look like the same book (or podcast)
 * present more than once, e.g. in different folders or formats.
 * Nothing here touches the database; DuplicateItemManager feeds rows in and stores the groups.
 *
 * Match types, strongest first:
 *  - asin:  same ASIN
 *  - isbn:  same ISBN (ISBN-10 and ISBN-13 compared as ISBN-13)
 *  - title: same normalized title + primary author (or no author on either), total duration within DURATION_TOLERANCE
 *  - feed:  podcasts with the same RSS feed URL or iTunes ID
 *
 * Books only match within the same format: two audiobooks, or two ebook-only items.
 * An audiobook and the ebook of the same title kept as separate items are not flagged.
 */

const crypto = require('crypto')

const MATCH_TYPES = ['asin', 'isbn', 'title', 'feed']
const DURATION_TOLERANCE = 0.01

/**
 * @typedef DuplicateCandidate
 * @property {string} id library item id
 * @property {string} [title]
 * @property {string} [author] primary author (books) or podcast author
 * @property {string} [asin]
 * @property {string} [isbn]
 * @property {number} [duration] total audio duration in seconds (books)
 * @property {boolean} [hasEbook]
 * @property {string} [feedUrl] podcasts
 * @property {string} [itunesId] podcasts
 *
 * @typedef DuplicateGroup
 * @property {string} key stable id for the group (hash of the sorted member ids)
 * @property {string[]} itemIds sorted library item ids
 * @property {string[]} matchTypes how members matched, strongest first
 */

/**
 * Lowercase, strip accents and punctuation, collapse whitespace
 * @param {string} str
 * @returns {string}
 */
function simplify(str) {
  if (!str || typeof str !== 'string') return ''
  return str
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

/**
 * "The Hobbit (Unabridged)" and "Hobbit" compare equal
 * @param {string} title
 * @returns {string}
 */
function normalizeTitle(title) {
  return simplify(title)
    .replace(/\b(unabridged|abridged)\b/g, ' ')
    .replace(/^(the|a|an) /, '')
    .trim()
    .replace(/\s+/g, ' ')
}

/**
 * "Tolkien, J.R.R.", "J. R. R. Tolkien" and "JRR Tolkien" compare equal
 * @param {string} author
 * @returns {string}
 */
function normalizeAuthor(author) {
  const tokens = simplify(author).split(' ').filter(Boolean)
  // Join runs of initials so "j r r" matches "jrr"
  const merged = []
  let prevWasInitial = false
  for (const token of tokens) {
    const isInitial = token.length === 1
    if (isInitial && prevWasInitial) {
      merged[merged.length - 1] += token
    } else {
      merged.push(token)
    }
    prevWasInitial = isInitial
  }
  return merged.sort().join(' ')
}

/**
 * @param {string} asin
 * @returns {string|null}
 */
function normalizeAsin(asin) {
  if (!asin || typeof asin !== 'string') return null
  const value = asin.trim().toUpperCase()
  return /^[A-Z0-9]{10}$/.test(value) ? value : null
}

/**
 * ISBN-10 converted to ISBN-13 so both forms of the same book match
 * @param {string} isbn
 * @returns {string|null}
 */
function normalizeIsbn(isbn) {
  if (!isbn || typeof isbn !== 'string') return null
  const value = isbn.toUpperCase().replace(/[^0-9X]/g, '')
  if (/^\d{13}$/.test(value)) return value
  if (!/^\d{9}[\dX]$/.test(value)) return null
  const core = '978' + value.slice(0, 9)
  let sum = 0
  for (let i = 0; i < 12; i++) sum += Number(core[i]) * (i % 2 === 0 ? 1 : 3)
  return core + ((10 - (sum % 10)) % 10)
}

/**
 * @param {string} feedUrl
 * @returns {string|null}
 */
function normalizeFeedUrl(feedUrl) {
  if (!feedUrl || typeof feedUrl !== 'string') return null
  const value = feedUrl
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/+$/, '')
  return value || null
}

/**
 * Books only match within one format
 * @param {DuplicateCandidate} candidate
 * @returns {'audio'|'ebook'|null}
 */
function getFormat(candidate) {
  if (Number(candidate.duration) > 0) return 'audio'
  if (candidate.hasEbook) return 'ebook'
  return null
}

/**
 * @param {number} a
 * @param {number} b
 * @returns {boolean}
 */
function durationsMatch(a, b) {
  a = Number(a) || 0
  b = Number(b) || 0
  if (!a && !b) return true
  if (!a || !b) return false
  return Math.abs(a - b) <= DURATION_TOLERANCE * Math.max(a, b)
}

/**
 * @param {string[]} itemIds sorted
 * @returns {string}
 */
function getGroupKey(itemIds) {
  return crypto.createHash('sha1').update(itemIds.join(',')).digest('hex').slice(0, 24)
}

/**
 * Group candidates that look like the same item.
 * Linear in the number of candidates apart from sorting within same-title buckets.
 *
 * @param {DuplicateCandidate[]} candidates
 * @param {'book'|'podcast'} mediaType
 * @returns {DuplicateGroup[]}
 */
function findDuplicateGroups(candidates, mediaType = 'book') {
  /** @type {Map<string, string>} union-find parent */
  const parent = new Map()
  /** @type {[string, string, string][]} links made, to report which match types joined each group */
  const edges = []

  const find = (id) => {
    let root = id
    while (parent.get(root) !== root) root = parent.get(root)
    // Path compression
    while (parent.get(id) !== root) {
      const next = parent.get(id)
      parent.set(id, root)
      id = next
    }
    return root
  }
  const union = (a, b, matchType) => {
    edges.push([a, b, matchType])
    const rootA = find(a)
    const rootB = find(b)
    if (rootA !== rootB) parent.set(rootB, rootA)
  }
  /**
   * Link every candidate sharing a key to the first one in its bucket
   * @param {Map<string, DuplicateCandidate[]>} buckets
   * @param {string} matchType
   */
  const linkBuckets = (buckets, matchType) => {
    for (const bucket of buckets.values()) {
      for (let i = 1; i < bucket.length; i++) union(bucket[0].id, bucket[i].id, matchType)
    }
  }
  const addToBucket = (buckets, key, candidate) => {
    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key).push(candidate)
  }

  const seenIds = new Set()
  const usable = []
  for (const candidate of candidates || []) {
    if (!candidate?.id || seenIds.has(candidate.id)) continue
    seenIds.add(candidate.id)
    parent.set(candidate.id, candidate.id)
    usable.push(candidate)
  }

  if (mediaType === 'podcast') {
    const byFeed = new Map()
    const byItunesId = new Map()
    for (const candidate of usable) {
      const feed = normalizeFeedUrl(candidate.feedUrl)
      if (feed) addToBucket(byFeed, feed, candidate)
      const itunesId = candidate.itunesId ? String(candidate.itunesId).trim() : ''
      if (itunesId) addToBucket(byItunesId, itunesId, candidate)
    }
    linkBuckets(byFeed, 'feed')
    linkBuckets(byItunesId, 'feed')
  } else {
    const byAsin = new Map()
    const byIsbn = new Map()
    const byTitle = new Map()
    for (const candidate of usable) {
      const format = getFormat(candidate)
      if (!format) continue
      const asin = normalizeAsin(candidate.asin)
      if (asin) addToBucket(byAsin, `${format}|${asin}`, candidate)
      const isbn = normalizeIsbn(candidate.isbn)
      if (isbn) addToBucket(byIsbn, `${format}|${isbn}`, candidate)
      const title = normalizeTitle(candidate.title)
      const author = normalizeAuthor(candidate.author)
      if (title) addToBucket(byTitle, `${format}|${title}|${author}`, candidate)
    }
    linkBuckets(byAsin, 'asin')
    linkBuckets(byIsbn, 'isbn')
    // Same title and author: only the same book when durations agree (a dramatized edition or another translation runs longer).
    // Each run is measured from its shortest item so small steps do not chain past the tolerance.
    for (const bucket of byTitle.values()) {
      if (bucket.length < 2) continue
      bucket.sort((a, b) => (Number(a.duration) || 0) - (Number(b.duration) || 0))
      let shortest = bucket[0]
      for (let i = 1; i < bucket.length; i++) {
        if (durationsMatch(shortest.duration, bucket[i].duration)) union(shortest.id, bucket[i].id, 'title')
        else shortest = bucket[i]
      }
    }
  }

  /** @type {Map<string, {itemIds: string[], matchTypes: Set<string>}>} */
  const groupsByRoot = new Map()
  for (const candidate of usable) {
    const root = find(candidate.id)
    if (!groupsByRoot.has(root)) groupsByRoot.set(root, { itemIds: [], matchTypes: new Set() })
    groupsByRoot.get(root).itemIds.push(candidate.id)
  }
  for (const [a, , matchType] of edges) {
    groupsByRoot.get(find(a)).matchTypes.add(matchType)
  }

  /** @type {DuplicateGroup[]} */
  const groups = []
  for (const group of groupsByRoot.values()) {
    if (group.itemIds.length < 2) continue
    const itemIds = group.itemIds.sort()
    groups.push({
      key: getGroupKey(itemIds),
      itemIds,
      matchTypes: MATCH_TYPES.filter((type) => group.matchTypes.has(type))
    })
  }
  return groups.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}

module.exports = {
  MATCH_TYPES,
  normalizeTitle,
  normalizeAuthor,
  normalizeAsin,
  normalizeIsbn,
  normalizeFeedUrl,
  durationsMatch,
  getGroupKey,
  findDuplicateGroups
}
