const Path = require('path')
const fs = require('../libs/fsExtra')

/**
 * Guard for re-pointing an existing library item at a new path because an inode matched.
 *
 * Inode numbers alone are not a safe identity: on Unraid user shares (shfs) inodes from different
 * disks can be the same number, and XFS/ext4 reuse inode numbers right after a delete. Matching on the
 * inode alone let a new book take over another book's record (cover, metadata, progress).
 * Upstream issues #1447, #4943, #4981, #4963.
 *
 * An inode match is only accepted when all of these hold:
 *  1. the item's old path is gone (or the "move" is a case-only rename of the same directory)
 *  2. no other library item already sits at the new path
 *  3. at least one file overlaps: same file name and size, or same file inode and size
 *
 * Known trade-off of rule 3: if every file changed size at the moment of the move (a tagger re-tags
 * and renames the folder in one step, and no cover or other file stayed unchanged) the move is not
 * followed. Nothing is deleted: the full scan marks the old item missing and adds a new item, and
 * listening progress stays on the missing record.
 */

/**
 * @typedef InoMatchCandidateFile
 * @property {string} filename
 * @property {number} size
 * @property {string} [ino]
 */

/**
 * @typedef InoMatchGuardResult
 * @property {boolean} ok
 * @property {string} [reason]
 */

/**
 * @param {*} size
 * @returns {number|null} positive size, null if unknown or empty
 */
function toPositiveSize(size) {
  const value = Number(size)
  return Number.isFinite(value) && value > 0 ? value : null
}

/**
 * @param {import('../models/LibraryItem').LibraryFileObject|import('../objects/files/LibraryFile')} libraryFile
 * @returns {InoMatchCandidateFile}
 */
function libraryFileToCandidate(libraryFile) {
  const metadata = libraryFile?.metadata || {}
  return {
    filename: metadata.filename || (metadata.path ? Path.posix.basename(metadata.path) : ''),
    size: metadata.size,
    ino: libraryFile?.ino != null ? String(libraryFile.ino) : undefined
  }
}

/**
 * Two files are taken to be the same file when they have the same non-zero size and either the same
 * name or the same inode. A reused or colliding inode alone is not enough.
 *
 * @param {InoMatchCandidateFile} a
 * @param {InoMatchCandidateFile} b
 * @returns {boolean}
 */
function isSameFile(a, b) {
  const size = toPositiveSize(a?.size)
  if (size === null || size !== toPositiveSize(b?.size)) return false
  if (a.filename && a.filename === b.filename) return true
  return !!a.ino && a.ino === b.ino
}

/**
 * @param {(import('../models/LibraryItem').LibraryFileObject)[]} existingLibraryFiles
 * @param {InoMatchCandidateFile[]} targetFiles
 * @returns {boolean}
 */
function hasOverlappingFile(existingLibraryFiles, targetFiles) {
  if (!existingLibraryFiles?.length || !targetFiles?.length) return false
  const existing = existingLibraryFiles.map(libraryFileToCandidate)
  return targetFiles.some((target) => existing.some((file) => isSameFile(file, target)))
}

/**
 * Stat a path without logging errors
 *
 * @param {string} path
 * @returns {Promise<{ino: string, size: number, isFile: boolean}|null>}
 */
async function statQuiet(path) {
  try {
    const stat = await fs.stat(path, { bigint: true })
    return { ino: String(stat.ino), size: Number(stat.size), isFile: stat.isFile() }
  } catch {
    return null
  }
}

/**
 * The old path still exists. Only allowed when it is the same directory under a case-only rename
 * (case-insensitive file systems), detected by an equal lower-cased path and the same inode.
 *
 * @param {string} oldPath
 * @param {string} targetPath
 * @returns {Promise<boolean>}
 */
async function isCaseOnlyRename(oldPath, targetPath) {
  if (oldPath.toLowerCase() !== targetPath.toLowerCase()) return false
  const [oldStat, targetStat] = await Promise.all([statQuiet(oldPath), statQuiet(targetPath)])
  return !!oldStat && !!targetStat && oldStat.ino === targetStat.ino
}

/**
 * @param {Object} params
 * @param {{id: string, path: string, libraryFiles: Object[]}} params.libraryItem existing item matched by inode
 * @param {string} params.targetPath path the item would be moved to
 * @param {InoMatchCandidateFile[]|(() => Promise<InoMatchCandidateFile[]>)} params.targetFiles files found at the target path
 * @param {boolean|(() => Promise<boolean>)} params.otherItemAtTargetPath another item already uses the target path
 * @returns {Promise<InoMatchGuardResult>}
 */
async function checkInoMatch({ libraryItem, targetPath, targetFiles, otherItemAtTargetPath }) {
  if (!libraryItem) return { ok: false, reason: 'no library item' }
  if (libraryItem.path === targetPath) return { ok: true }

  if (await fs.pathExists(libraryItem.path)) {
    if (!(await isCaseOnlyRename(libraryItem.path, targetPath))) {
      return { ok: false, reason: `old path "${libraryItem.path}" still exists` }
    }
  }

  const otherItem = typeof otherItemAtTargetPath === 'function' ? await otherItemAtTargetPath() : otherItemAtTargetPath
  if (otherItem) {
    return { ok: false, reason: `another library item already exists at "${targetPath}"` }
  }

  const files = typeof targetFiles === 'function' ? await targetFiles() : targetFiles
  if (!hasOverlappingFile(libraryItem.libraryFiles, files)) {
    return { ok: false, reason: `no file at "${targetPath}" matches a file of the library item by name and size or inode and size` }
  }

  return { ok: true }
}

/**
 * Files at the target path of a watcher update, read from disk.
 * Checks the changed files plus the item's known files at their relative paths (a moved folder keeps them).
 *
 * @param {string} targetPath
 * @param {boolean} isSingleMedia target path is a single media file
 * @param {string[]|string} changedFiles relative paths from the watcher update
 * @param {{libraryFiles: Object[]}} libraryItem
 * @returns {Promise<InoMatchCandidateFile[]>}
 */
async function getTargetFilesOnDisk(targetPath, isSingleMedia, changedFiles, libraryItem) {
  if (isSingleMedia) {
    const stat = await statQuiet(targetPath)
    return stat?.isFile ? [{ filename: Path.posix.basename(targetPath), size: stat.size, ino: stat.ino }] : []
  }

  const relPaths = new Set()
  for (const file of Array.isArray(changedFiles) ? changedFiles : []) {
    if (file) relPaths.add(file)
  }
  for (const libraryFile of libraryItem?.libraryFiles || []) {
    const relPath = libraryFile?.metadata?.relPath || libraryFile?.metadata?.filename
    if (relPath) relPaths.add(relPath)
  }

  const files = []
  for (const relPath of relPaths) {
    const stat = await statQuiet(Path.posix.join(targetPath, relPath))
    if (stat?.isFile) files.push({ filename: Path.posix.basename(relPath), size: stat.size, ino: stat.ino })
  }
  return files
}

module.exports = {
  checkInoMatch,
  getTargetFilesOnDisk,
  hasOverlappingFile,
  isSameFile,
  libraryFileToCandidate
}
