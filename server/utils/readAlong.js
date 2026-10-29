const Path = require('path')
const fs = require('../libs/fsExtra')
const Logger = require('../Logger')
const { filePathToPOSIX } = require('./fileUtils')

/**
 * Read-along data for EPUBs made from audio (chapterbot "EPUB from audio").
 *
 * The sidecar builds `readalong.json` together with the EPUB: every timed sentence in the EPUB is a
 * `<span id="sN">`, and the JSON gives each id its start and end on the book timeline (the same timeline as
 * the player's current time). The JSON is bound to one EPUB through the OPF's dc:identifier and
 * dcterms:modified, which it copies; clients compare them with the opened EPUB before using it.
 *
 * Storage: MetadataPath/items/<libraryItemId>/readalong/<ino>.json, keyed by the ino of the EPUB library file.
 * It is outside the library folder (the watcher and scanner never see it) and goes away with the item's
 * metadata folder, or with the EPUB when it is deleted through the server (remove()). An entry whose EPUB went away
 * outside the server is kept (a whole transcription to rebuild); clients check the OPF identifier/modified anyway. Each file is the validated sidecar JSON plus "epubPath", the EPUB's path relative to the
 * item folder, used to find the entry again when the EPUB's ino changes (copy, restore, other filesystem).
 *
 * Served by GET /api/items/:id/ebook/:fileid/readalong (feature "readAlong").
 */

const KIND = 'abs-readalong'
const VERSION = 1
const MAX_SENTENCES = 200000
const MAX_SECTIONS = 10000
const MAX_STRING = 1024
/** Largest stored file the server reads back while looking for an entry by path */
const MAX_FILE_BYTES = 32 * 1024 * 1024
const SENTENCE_ID_RE = /^s[1-9][0-9]{0,6}$/
const SECTION_HREF_RE = /^[\w./-]{1,256}$/
/** inos from fs.stat are decimal; anything else is never used as a file name */
const INO_RE = /^[0-9A-Za-z_-]{1,64}$/

class ReadAlongError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ReadAlongError'
  }
}

function fail(message) {
  throw new ReadAlongError(message)
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function checkString(value, name, { optional = false } = {}) {
  if (value === undefined || value === null) {
    if (optional) return undefined
    fail(`${name} is missing`)
  }
  if (typeof value !== 'string' || !value || value.length > MAX_STRING) fail(`${name} must be a non-empty string`)
  return value
}

function checkTime(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) fail(`${name} must be a finite number >= 0`)
  return value
}

/**
 * Check a parsed readalong.json (version 1) and return a normalized copy.
 * Unknown fields are kept (adding fields keeps version 1), except "epubPath", which the server owns.
 *
 * @param {*} obj
 * @returns {Object}
 * @throws {ReadAlongError}
 */
function validate(obj) {
  if (!isPlainObject(obj)) fail('read-along data must be an object')
  if (obj.kind !== KIND) fail(`kind must be "${KIND}"`)
  if (obj.version !== VERSION) fail(`version must be ${VERSION}`)
  checkString(obj.identifier, 'identifier')
  checkString(obj.modified, 'modified')
  checkString(obj.epubFile, 'epubFile', { optional: true })
  checkString(obj.model, 'model', { optional: true })
  if (obj.timeline !== undefined && obj.timeline !== 'book') fail('timeline must be "book"')
  if (obj.audioDuration !== undefined && obj.audioDuration !== null) checkTime(obj.audioDuration, 'audioDuration')

  if (!Array.isArray(obj.sections) || obj.sections.length > MAX_SECTIONS) fail(`sections must be an array of at most ${MAX_SECTIONS} entries`)
  const sections = obj.sections.map((section, i) => {
    if (!isPlainObject(section)) fail(`sections[${i}] must be an object`)
    if (typeof section.href !== 'string' || !SECTION_HREF_RE.test(section.href) || section.href.split('/').includes('..')) fail(`sections[${i}].href is not a valid path`)
    if (section.title !== undefined && section.title !== null && typeof section.title !== 'string') fail(`sections[${i}].title must be a string`)
    return { ...section }
  })

  if (!Array.isArray(obj.sentences) || obj.sentences.length > MAX_SENTENCES) fail(`sentences must be an array of at most ${MAX_SENTENCES} entries`)
  const ids = new Set()
  let prevStart = -Infinity
  const sentences = obj.sentences.map((sentence, i) => {
    const name = `sentences[${i}]`
    if (!isPlainObject(sentence)) fail(`${name} must be an object`)
    if (typeof sentence.id !== 'string' || !SENTENCE_ID_RE.test(sentence.id)) fail(`${name}.id is not a valid sentence id`)
    if (ids.has(sentence.id)) fail(`${name}.id "${sentence.id}" is not unique`)
    ids.add(sentence.id)
    if (!Number.isInteger(sentence.sec) || sentence.sec < 0 || sentence.sec >= sections.length) fail(`${name}.sec is out of range`)
    checkTime(sentence.start, `${name}.start`)
    checkTime(sentence.end, `${name}.end`)
    if (sentence.end < sentence.start) fail(`${name} ends before it starts`)
    if (sentence.start < prevStart) fail(`${name} is out of order`)
    prevStart = sentence.start
    if (sentence.w !== undefined) {
      if (!Array.isArray(sentence.w)) fail(`${name}.w must be an array`)
      for (const pair of sentence.w) {
        if (!Array.isArray(pair) || pair.length !== 2 || !pair.every((t) => typeof t === 'number' && Number.isFinite(t))) fail(`${name}.w must hold [start, end] pairs of finite numbers`)
      }
    }
    return { ...sentence }
  })

  const normalized = { ...obj, sections, sentences }
  delete normalized.epubPath
  return normalized
}

/**
 * @param {string} libraryItemId
 * @returns {string} MetadataPath/items/<libraryItemId>/readalong
 */
function dir(libraryItemId) {
  if (typeof libraryItemId !== 'string' || !/^[\w-]{1,128}$/.test(libraryItemId)) throw new ReadAlongError('Invalid library item id')
  return Path.join(global.MetadataPath, 'items', libraryItemId, 'readalong')
}

function isSafeIno(ino) {
  return typeof ino === 'string' && INO_RE.test(ino)
}

/**
 * Store validated read-along data for the EPUB with this ino. Written atomically (temp file, then rename).
 *
 * @param {string} libraryItemId
 * @param {string} ino - of the EPUB library file
 * @param {string} epubPath - the EPUB's path relative to the item folder
 * @param {Object} obj - from validate()
 * @returns {Promise<string>} the stored path
 */
async function save(libraryItemId, ino, epubPath, obj) {
  if (!isSafeIno(ino)) throw new ReadAlongError('Invalid ino')
  if (typeof epubPath !== 'string' || !epubPath) throw new ReadAlongError('Invalid EPUB path')
  const folder = dir(libraryItemId)
  await fs.ensureDir(folder)
  const target = Path.join(folder, `${ino}.json`)
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`
  // validate() drops any epubPath from the sidecar; it goes first so the entry is easy to recognise by hand
  const body = JSON.stringify({ epubPath: filePathToPOSIX(epubPath), ...obj })
  try {
    await fs.writeFile(temp, body, 'utf8')
    await fs.rename(temp, target)
  } catch (error) {
    await fs.remove(temp).catch(() => {})
    throw error
  }
  return target
}

/**
 * The EPUB's path relative to its item folder, POSIX style.
 *
 * @param {import('../models/LibraryItem')} libraryItem
 * @param {{metadata?: {relPath?: string, path?: string}}} libraryFile
 * @returns {string|null}
 */
function relativeEpubPath(libraryItem, libraryFile) {
  const meta = libraryFile?.metadata || {}
  if (meta.path && libraryItem?.path) {
    const rel = Path.posix.relative(filePathToPOSIX(libraryItem.path), filePathToPOSIX(meta.path))
    if (rel && !rel.startsWith('..')) return rel
  }
  return meta.relPath ? filePathToPOSIX(meta.relPath) : null
}

/** save() writes epubPath first: `{"epubPath":"…",` */
const EPUB_PATH_PREFIX_RE = /^\{"epubPath":("(?:[^"\\]|\\.)*")[,}]/
const PREFIX_BYTES = 8192

/**
 * The epubPath of a stored entry. Reads only the start of the file when it was written by save(), so looking up an
 * EPUB without data does not parse every (possibly large) entry of the item each time.
 *
 * @param {string} path
 * @returns {Promise<string|null>}
 */
async function readStoredEpubPath(path) {
  let handle = null
  try {
    const stat = await fs.stat(path)
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null
    handle = await fs.open(path, 'r')
    const buffer = Buffer.alloc(Math.min(PREFIX_BYTES, stat.size))
    const { bytesRead } = await fs.read(handle, buffer, 0, buffer.length, 0)
    const match = EPUB_PATH_PREFIX_RE.exec(buffer.toString('utf8', 0, bytesRead))
    if (match) return JSON.parse(match[1])
    // not in save()'s layout (edited by hand): read it all
    const stored = JSON.parse(await fs.readFile(path, 'utf8'))
    return typeof stored?.epubPath === 'string' ? stored.epubPath : null
  } catch {
    return null
  } finally {
    if (handle !== null) await fs.close(handle).catch(() => {})
  }
}

/**
 * Find the stored read-along data for an EPUB library file.
 *
 * 1. <ino>.json
 * 2. otherwise (the EPUB's ino changed) an entry whose epubPath is the file's current path and whose ino belongs to
 *    no other file of the item; it is renamed to the new ino so the next lookup is direct
 *
 * @param {import('../models/LibraryItem')} libraryItem
 * @param {{ino: string, metadata?: Object}} libraryFile
 * @returns {Promise<string|null>}
 */
async function find(libraryItem, libraryFile) {
  if (!libraryItem?.id || !libraryFile?.ino) return null
  let folder
  try {
    folder = dir(libraryItem.id)
  } catch {
    return null
  }
  const ino = String(libraryFile.ino)
  if (isSafeIno(ino)) {
    const direct = Path.join(folder, `${ino}.json`)
    if (await fs.pathExists(direct)) return direct
  }

  const epubPath = relativeEpubPath(libraryItem, libraryFile)
  if (!epubPath) return null
  let names
  try {
    names = await fs.readdir(folder)
  } catch {
    return null
  }
  const otherInos = new Set((libraryItem.libraryFiles || []).map((lf) => String(lf.ino)).filter((i) => i !== ino))
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const oldIno = name.slice(0, -'.json'.length)
    // still the key of another file in this item: not a stale entry
    if (otherInos.has(oldIno)) continue
    const path = Path.join(folder, name)
    const stored = await readStoredEpubPath(path)
    if (stored !== epubPath) continue
    if (!isSafeIno(ino)) return path
    const target = Path.join(folder, `${ino}.json`)
    try {
      await fs.rename(path, target)
      Logger.info(`[readAlong] Re-keyed read-along data of "${epubPath}" in item "${libraryItem.id}" from ino ${oldIno} to ${ino}`)
      return target
    } catch (error) {
      Logger.warn(`[readAlong] Re-keying read-along data of "${epubPath}" failed: ${error.code || error.message}`)
      return path
    }
  }
  return null
}

/**
 * Remove the stored read-along data of an EPUB library file (deleted through the server).
 *
 * @param {string} libraryItemId
 * @param {string} ino - of the EPUB library file
 * @returns {Promise<boolean>} whether an entry was removed
 */
async function remove(libraryItemId, ino) {
  ino = String(ino ?? '')
  if (!isSafeIno(ino)) return false
  let target
  try {
    target = Path.join(dir(libraryItemId), `${ino}.json`)
  } catch {
    return false
  }
  if (!(await fs.pathExists(target))) return false
  await fs.remove(target)
  return true
}

module.exports = {
  KIND,
  VERSION,
  MAX_SENTENCES,
  ReadAlongError,
  validate,
  dir,
  save,
  find,
  remove,
  relativeEpubPath
}
