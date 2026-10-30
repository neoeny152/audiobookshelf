const Path = require('path')
const { Sequelize } = require('sequelize')
const globals = require('../globals')

/**
 * Search library items by file name or path (upstream #5680)
 *
 * File paths are only searched when the query looks like a file name or a path,
 * i.e. it ends with a known audio/ebook extension or contains a path separator.
 * Ordinary metadata queries never pay the cost of scanning libraryItems.libraryFiles.
 */

const SearchableFileExtensions = new Set([...globals.SupportedAudioTypes, ...globals.SupportedEbookTypes])

/**
 * Normalize a search query for file path matching.
 * Windows separators are converted to "/" (paths are stored as POSIX).
 *
 * @param {string} query
 * @returns {string}
 */
function normalizeFileQuery(query) {
  if (!query || typeof query !== 'string') return ''
  return query.trim().replace(/\\/g, '/')
}

/**
 * @param {string} query
 * @returns {boolean} true when the query should also be matched against file names and paths
 */
function isFileSearchQuery(query) {
  const normalized = normalizeFileQuery(query)
  if (normalized.length < 3) return false
  if (normalized.includes('/')) return true

  const ext = Path.extname(normalized).slice(1).toLowerCase()
  return !!ext && SearchableFileExtensions.has(ext)
}

/**
 * Build a LIKE pattern for a substring match. "!" is the LIKE escape character
 * (a backslash would be mangled by Sequelize replacement parsing).
 *
 * @param {string} query
 * @returns {string}
 */
function getFileSearchLikePattern(query) {
  const normalized = normalizeFileQuery(query)
  return `%${normalized.replace(/[%_!]/g, (c) => `!${c}`)}%`
}

/**
 * libraryFiles is stored as JSON text written with JSON.stringify, which only escapes
 * double quotes, backslashes and control characters. For any other query, a match in a
 * file path is also a match in the raw column text, so a plain LIKE on the column can
 * skip parsing the JSON of rows that cannot match.
 *
 * @param {string} query
 * @returns {boolean}
 */
function canPrefilterLibraryFilesText(query) {
  // Backslashes are already converted to "/" by normalizeFileQuery
  return !/["\u0000-\u001f]/.test(normalizeFileQuery(query))
}

/**
 * Sequelize where clause matching a library item by its folder/file path or any of its library file paths.
 * Uses the replacement :fileSearchPattern (see getFileSearchLikePattern).
 *
 * @param {string} [libraryItemAlias=libraryItem] table alias of the libraryItems table in the query
 * @param {string} [query] the search query, used to skip JSON parsing of rows that cannot match
 * @returns {import('sequelize').WhereOptions}
 */
function getLibraryItemFileMatchWhere(libraryItemAlias = 'libraryItem', query = null) {
  const li = `\`${libraryItemAlias}\``
  let filesMatch = `EXISTS (SELECT 1 FROM json_each(${li}.libraryFiles) WHERE json_valid(${li}.libraryFiles) AND json_extract(json_each.value, '$.metadata.path') LIKE :fileSearchPattern ESCAPE '!')`
  if (query && canPrefilterLibraryFilesText(query)) {
    filesMatch = `(${li}.libraryFiles LIKE :fileSearchPattern ESCAPE '!' AND ${filesMatch})`
  }
  const literal = Sequelize.literal(`(${li}.path LIKE :fileSearchPattern ESCAPE '!' OR ${filesMatch})`)
  // Wrapped so it can be used as an element of a where array
  return { [Sequelize.Op.and]: [literal] }
}

/**
 * Find the library file that matched a file search query.
 * Prefers files whose name matches over files that only match by folder.
 *
 * @param {{path:string, relPath:string, libraryFiles:object[]}} libraryItem
 * @param {string} query
 * @returns {string|null} path of the matched file relative to the library folder, or the item's relative path
 */
function getMatchedFilePath(libraryItem, query) {
  const needle = normalizeFileQuery(query).toLowerCase()
  if (!needle) return null

  const files = libraryItem.libraryFiles || []
  const byName = files.find((file) => file.metadata.filename.toLowerCase().includes(needle))
  if (byName) return byName.metadata.relPath

  // A query matching the item folder is reported as the item's relative path
  if (libraryItem.path.toLowerCase().includes(needle)) return libraryItem.relPath
  const byPath = files.find((file) => file.metadata.path.toLowerCase().includes(needle))
  return byPath ? byPath.metadata.relPath : null
}

module.exports = {
  isFileSearchQuery,
  getFileSearchLikePattern,
  canPrefilterLibraryFilesText,
  getLibraryItemFileMatchWhere,
  getMatchedFilePath
}
