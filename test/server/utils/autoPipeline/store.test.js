const { expect } = require('chai')
const sinon = require('sinon')
const os = require('os')
const Path = require('path')
const fs = require('fs')

const fsExtra = require('../../../../server/libs/fsExtra')
const { PipelineStore, writeJsonAtomic } = require('../../../../server/utils/autoPipeline/store')
const settings = require('../../../../server/utils/autoPipeline/settings')

describe('autoPipeline store', () => {
  let root
  let store

  beforeEach(() => {
    root = fs.mkdtempSync(Path.join(os.tmpdir(), 'abs-pipeline-store-'))
    store = new PipelineStore(root)
  })

  afterEach(() => {
    sinon.restore()
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('writes atomically: a failed write leaves the previous file and no temp file', async () => {
    const file = Path.join(root, 'a', 'state.json')
    await writeJsonAtomic(file, { v: 1 })
    sinon.stub(fsExtra, 'rename').rejects(new Error('disk full'))
    let failed = false
    try {
      await writeJsonAtomic(file, { v: 2 })
    } catch {
      failed = true
    }
    expect(failed).to.equal(true)
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).to.deep.equal({ v: 1 })
    expect(fs.readdirSync(Path.dirname(file))).to.deep.equal(['state.json'])
  })

  it('loads every state, skips broken files and clears leftover temp files', async () => {
    await store.saveState({ libraryItemId: 'item-1', status: 'queued' })
    await store.saveState({ libraryItemId: 'item-2', status: 'chapters' })
    fs.mkdirSync(Path.join(root, 'item-3'))
    fs.writeFileSync(Path.join(root, 'item-3', 'state.json'), '{ not json')
    fs.writeFileSync(Path.join(root, 'item-1', 'state.json.123.tmp'), 'partial')
    fs.writeFileSync(Path.join(root, 'epub-jobs.json'), '[]')
    // a state in the wrong folder is ignored
    fs.mkdirSync(Path.join(root, 'item-4'))
    fs.writeFileSync(Path.join(root, 'item-4', 'state.json'), JSON.stringify({ libraryItemId: 'other' }))

    const states = await store.loadAll()
    expect(states.map((s) => s.libraryItemId).sort()).to.deep.equal(['item-1', 'item-2'])
    expect(fs.readdirSync(Path.join(root, 'item-1'))).to.deep.equal(['state.json'])
  })

  it('returns nothing for a missing root', async () => {
    expect(await new PipelineStore(Path.join(root, 'nope')).loadAll()).to.deep.equal([])
  })

  it('refuses ids that are not plain ids', () => {
    expect(() => store.itemDir('../etc')).to.throw('Invalid library item id')
    expect(() => store.itemDir('a/b')).to.throw()
  })

  it('keeps proposals, analysis and backups per item; removeItem keeps backups unless all', async () => {
    await store.saveState({ libraryItemId: 'item-1' })
    await store.saveProposal('item-1', { proposedChapters: [] })
    await store.saveAnalysis('item-1', { snap: {} })
    const t = new Date('2026-10-28T10:00:00.000Z')
    const first = await store.writeBackup('item-1', { chapters: [{ title: 'A', start: 0, end: 10 }], source: 'audible:aligned', reason: 'auto' }, t)
    const second = await store.writeBackup('item-1', { chapters: [], source: 'restore', reason: 'x' }, t)
    expect(first).to.equal('chapters-2026-10-28T10-00-00.000Z.json')
    expect(second).to.equal('chapters-2026-10-28T10-00-00.000Z-2.json')
    const later = await store.writeBackup('item-1', { chapters: [{ title: 'B', start: 0, end: 5 }], source: 's', reason: 'r' }, new Date('2026-10-29T10:00:00.000Z'))

    const list = await store.listBackups('item-1')
    expect(list[0]).to.include({ name: later, chapters: 1, source: 's' })
    expect(list).to.have.length(3)
    expect((await store.readBackup('item-1', first)).chapters).to.have.length(1)
    expect(await store.readBackup('item-1', '../state.json')).to.equal(null)

    await store.removeItem('item-1')
    expect(await store.readState('item-1')).to.equal(null)
    expect(await store.readProposal('item-1')).to.equal(null)
    expect(await store.readAnalysis('item-1')).to.equal(null)
    expect(await store.listBackups('item-1')).to.have.length(3)
    await store.removeItem('item-1', { all: true })
    expect(fs.existsSync(Path.join(root, 'item-1'))).to.equal(false)
  })
})

describe('autoPipeline settings', () => {
  it('defaults are off, 95 %, chapters on, EPUB off, 5 settle minutes', () => {
    expect(settings.defaultAutoPipelineSettings()).to.deep.equal({ mode: 'off', autoMatch: true, autoMatchMinConfidence: 95, autoMatchProvider: null, autoChapters: true, autoEpub: false, settleMinutes: 5 })
  })

  it('merges a partial object and validates each field', () => {
    const current = settings.defaultAutoPipelineSettings()
    expect(settings.mergeAutoPipelineSettings(current, { mode: 'dryRun', autoEpub: true, bogus: 1 })).to.deep.equal({ ...current, mode: 'dryRun', autoEpub: true })
    const bad = ['x', [], { mode: 'sometimes' }, { autoMatch: 'yes' }, { autoMatchMinConfidence: 49 }, { autoMatchMinConfidence: 101 }, { autoMatchMinConfidence: 95.5 }, { settleMinutes: 0 }, { settleMinutes: 121 }, { autoMatchProvider: 'google' }, { autoMatchProvider: 5 }]
    for (const value of bad) expect(() => settings.mergeAutoPipelineSettings(current, value), JSON.stringify(value)).to.throw(settings.AutoPipelineSettingsError)
    expect(settings.mergeAutoPipelineSettings(current, { autoMatchProvider: 'audible.uk' }).autoMatchProvider).to.equal('audible.uk')
    expect(settings.mergeAutoPipelineSettings({ ...current, autoMatchProvider: 'audible.uk' }, { autoMatchProvider: null }).autoMatchProvider).to.equal(null)
  })

  it('normalizes stored values key by key', () => {
    expect(settings.normalizeAutoPipelineSettings(undefined).mode).to.equal('off')
    expect(settings.normalizeAutoPipelineSettings({ mode: 'on', settleMinutes: 9999 })).to.include({ mode: 'on', settleMinutes: 5 })
  })

  it('gate, provider and region', () => {
    expect(settings.isGateOn({})).to.equal(false)
    expect(settings.isGateOn({ ABS_AUTO_PIPELINE: 'true' })).to.equal(false)
    expect(settings.isGateOn({ ABS_AUTO_PIPELINE: '1' })).to.equal(true)
    expect(settings.effectiveProvider({ provider: 'google' }, { autoMatchProvider: null })).to.equal('google')
    expect(settings.effectiveProvider({ provider: 'google' }, { autoMatchProvider: 'audible.de' })).to.equal('audible.de')
    expect(settings.regionForProvider('audible')).to.equal('us')
    expect(settings.regionForProvider('audible.uk')).to.equal('uk')
    expect(settings.regionForProvider('google')).to.equal(null)
  })
})
