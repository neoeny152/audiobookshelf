const { expect } = require('chai')

const { getItemHealth } = require('../../../server/utils/itemHealth')
const chapterPlan = require('../../../server/utils/autoPipeline/chapterPlan')

const ASIN = 'B00I2VWW5U'
const FILE_SEC = 1000
const autoFix = { available: true, autoRepair: false, minConfidence: 90 }

function mp3(i, { seek = 'xing', measured = null } = {}) {
  return { index: i + 1, codec: 'mp3', duration: FILE_SEC, mp3SeekIndex: seek, metadata: { size: 10, mtimeMs: 20 }, mp3Measured: measured === null ? null : { duration: measured, size: 10, mtimeMs: 20 } }
}

const scannerChapters = [0, 1].map((i) => ({ title: `part${i}`, start: i * FILE_SEC, end: (i + 1) * FILE_SEC }))
const audibleChapters = [0, 1, 2].map((i) => ({ title: `Chapter ${i}`, start: (i * 2 * FILE_SEC) / 3, end: ((i + 1) * 2 * FILE_SEC) / 3 }))

function health({ files = [mp3(0), mp3(1)], asin = ASIN, chapters = audibleChapters, state = null } = {}) {
  const libraryItem = { id: 'li-1', media: { includedAudioFiles: files, duration: files.length * FILE_SEC, asin, chapters } }
  return getItemHealth({ libraryItem, pipelineState: state, scannerChapters, processing: false, autoFix })
}

describe('itemHealth', () => {
  it('a matched book with pipeline-applied chapters is healthy', () => {
    const result = health({ state: { match: { result: 'matched', confidence: 97 }, chapters: { appliedHash: chapterPlan.chaptersHash(audibleChapters) } } })
    expect(result).to.include({ libraryItemId: 'li-1', next: null })
    expect(result.issues).to.deep.equal([])
    expect(result.match).to.deep.equal({ asin: ASIN, confidence: null, reason: null })
    expect(result.chapters).to.include({ count: 3, kind: 'pipeline', end: 2000 })
    expect(result.autoFix).to.equal(autoFix)
  })

  it('MP3s off by more than 1 s: seek-index first, drift from the measurements, chapters past the real end', () => {
    const result = health({ files: [mp3(0, { seek: 'none', measured: 1041.24 }), mp3(1, { seek: 'none', measured: 1049.04 })], asin: null, chapters: scannerChapters })
    expect(result.duration).to.deep.equal({ stored: 2000, drift: 90.3, unmeasured: 0 })
    expect(result.seekIndex).to.deep.equal({ needsRepairCount: 2, maxDrift: 49, processing: false })
    expect(result.issues).to.deep.equal(['seek-index', 'unmatched', 'chapters-from-files', 'chapters-length', 'chapters-unverified'])
    expect(result.next).to.equal('repair')
  })

  it('an MP3 not measured yet counts as unmeasured, not as needing a repair', () => {
    const result = health({ files: [mp3(0, { seek: 'none' }), mp3(1)] })
    expect(result.duration).to.include({ drift: 0, unmeasured: 1 })
    expect(result.seekIndex.needsRepairCount).to.equal(0)
    expect(result.issues).to.not.include('seek-index')
  })

  it('a low-confidence or ambiguous pipeline match replaces unmatched, with its score', () => {
    for (const reason of ['low-confidence', 'ambiguous']) {
      const result = health({ asin: null, state: { match: { result: 'needs-review', reason, confidence: 85 } } })
      expect(result.match).to.deep.equal({ asin: null, confidence: 85, reason })
      expect(result.issues[0]).to.equal('low-confidence')
      expect(result.next).to.equal('match')
    }
    expect(health({ asin: null, state: { match: { result: 'needs-review', reason: 'no-match', confidence: null } } }).issues[0]).to.equal('unmatched')
  })

  it('chapter count differs from the Audible source the pipeline looked up', () => {
    const state = { chapters: { source: { kind: 'aligned', asin: ASIN, chapters: 50, runtimeSec: 2000 } } }
    const result = health({ state })
    expect(result.chapters.audible).to.deep.equal({ count: 50, runtimeSec: 2000 })
    expect(result.issues).to.deep.equal(['chapters-count', 'chapters-unverified'])
    expect(result.next).to.equal('chapters')
    // an Audible source of another ASIN (matched again since) is not compared
    expect(health({ state, asin: 'B0OTHER001' }).chapters.audible).to.equal(null)
  })

  it('a book without chapters, or without audio', () => {
    expect(health({ chapters: [] }).issues).to.deep.equal(['chapters-from-files', 'chapters-unverified'])
    expect(health({ chapters: [] }).chapters).to.include({ kind: 'none', end: null })
    expect(health({ files: [], asin: null, chapters: [] }))
      .to.include({ next: null })
      .and.to.have.property('issues')
      .that.deep.equals([])
  })
})
