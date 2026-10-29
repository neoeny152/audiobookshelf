/**
 * Auto pipeline persistence (JSON files, no database migration so upstream syncs stay simple):
 *
 * - <root>/<itemId>/state.json      pipeline state of the item
 * - <root>/<itemId>/proposal.json   the chapter proposal waiting for review
 * - <root>/<itemId>/analysis.json   snap and speech check results while the chapters step runs (resume after a restart
 *                                   or a busy sidecar without redoing the silence detection)
 * - <root>/<itemId>/backups/chapters-<ISO>.json   chapters before every change the pipeline made
 *
 * <root> is MetadataPath/pipeline. Every write goes to a temp file first and is renamed into place.
 */

const Path = require('path')
const fs = require('../../libs/fsExtra')

/** item ids are uuids; anything else is never used as a path */
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/
const BACKUP_RE = /^chapters-[0-9TZ.:-]+(?:-\d+)?\.json$/

let tempCounter = 0

/**
 * Write JSON atomically: a temp file in the same folder, then rename.
 *
 * @param {string} file
 * @param {*} value
 */
async function writeJsonAtomic(file, value) {
  await fs.ensureDir(Path.dirname(file))
  const temp = `${file}.${process.pid}.${Date.now()}.${++tempCounter}.tmp`
  try {
    await fs.writeFile(temp, JSON.stringify(value, null, 2))
    await fs.rename(temp, file)
  } catch (error) {
    await fs.remove(temp).catch(() => {})
    throw error
  }
}

/**
 * @param {string} file
 * @returns {Promise<*|null>} null when missing or unreadable
 */
async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch {
    return null
  }
}

class PipelineStore {
  /**
   * @param {string} root - MetadataPath/pipeline
   */
  constructor(root) {
    this.root = root
  }

  itemDir(itemId) {
    if (!ID_RE.test(String(itemId))) throw new Error('Invalid library item id')
    return Path.join(this.root, itemId)
  }

  /**
   * Every stored state.
   *
   * @returns {Promise<Object[]>}
   */
  async loadAll() {
    let names = []
    try {
      names = await fs.readdir(this.root)
    } catch {
      return []
    }
    const states = []
    for (const name of names) {
      if (!ID_RE.test(name)) continue
      const state = await readJson(Path.join(this.root, name, 'state.json'))
      if (state && state.libraryItemId === name) states.push(state)
    }
    // leftover temp files of a write that was cut off
    for (const name of names) {
      if (!ID_RE.test(name)) continue
      const dir = Path.join(this.root, name)
      const files = await fs.readdir(dir).catch(() => [])
      for (const f of files) if (f.endsWith('.tmp')) await fs.remove(Path.join(dir, f)).catch(() => {})
    }
    return states
  }

  saveState(state) {
    return writeJsonAtomic(Path.join(this.itemDir(state.libraryItemId), 'state.json'), state)
  }

  readState(itemId) {
    return readJson(Path.join(this.itemDir(itemId), 'state.json'))
  }

  saveProposal(itemId, proposal) {
    return writeJsonAtomic(Path.join(this.itemDir(itemId), 'proposal.json'), proposal)
  }

  readProposal(itemId) {
    return readJson(Path.join(this.itemDir(itemId), 'proposal.json'))
  }

  async removeProposal(itemId) {
    await fs.remove(Path.join(this.itemDir(itemId), 'proposal.json'))
  }

  saveAnalysis(itemId, analysis) {
    return writeJsonAtomic(Path.join(this.itemDir(itemId), 'analysis.json'), analysis)
  }

  readAnalysis(itemId) {
    return readJson(Path.join(this.itemDir(itemId), 'analysis.json'))
  }

  async removeAnalysis(itemId) {
    await fs.remove(Path.join(this.itemDir(itemId), 'analysis.json'))
  }

  /**
   * Remove the state and the proposal of an item (backups are kept for undo, unless `all`).
   *
   * @param {string} itemId
   * @param {{all?: boolean}} [opts]
   */
  async removeItem(itemId, { all = false } = {}) {
    const dir = this.itemDir(itemId)
    if (all) return fs.remove(dir)
    await fs.remove(Path.join(dir, 'state.json'))
    await fs.remove(Path.join(dir, 'proposal.json'))
    await fs.remove(Path.join(dir, 'analysis.json'))
  }

  /**
   * @param {string} itemId
   * @param {{chapters: Object[], source: string, reason: string}} backup
   * @param {Date} [date]
   * @returns {Promise<string>} the backup name
   */
  async writeBackup(itemId, backup, date = new Date()) {
    const dir = Path.join(this.itemDir(itemId), 'backups')
    await fs.ensureDir(dir)
    const stamp = date.toISOString().replace(/:/g, '-')
    let name = `chapters-${stamp}.json`
    for (let n = 2; await fs.pathExists(Path.join(dir, name)); n++) name = `chapters-${stamp}-${n}.json`
    await writeJsonAtomic(Path.join(dir, name), { ...backup, createdAt: date.getTime() })
    return name
  }

  /**
   * @param {string} itemId
   * @returns {Promise<{name: string, createdAt: number|null, source: string|null, reason: string|null, chapters: number}[]>} newest first
   */
  async listBackups(itemId) {
    const dir = Path.join(this.itemDir(itemId), 'backups')
    const names = (await fs.readdir(dir).catch(() => [])).filter((n) => BACKUP_RE.test(n))
    const out = []
    for (const name of names) {
      const b = await readJson(Path.join(dir, name))
      if (!b || !Array.isArray(b.chapters)) continue
      out.push({ name, createdAt: Number.isFinite(b.createdAt) ? b.createdAt : null, source: b.source || null, reason: b.reason || null, chapters: b.chapters.length })
    }
    out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0) || (a.name < b.name ? 1 : -1))
    return out
  }

  /**
   * @param {string} itemId
   * @param {string} name
   * @returns {Promise<Object|null>}
   */
  async readBackup(itemId, name) {
    if (!BACKUP_RE.test(String(name))) return null
    return readJson(Path.join(this.itemDir(itemId), 'backups', name))
  }
}

module.exports = { PipelineStore, writeJsonAtomic, readJson, ID_RE }
