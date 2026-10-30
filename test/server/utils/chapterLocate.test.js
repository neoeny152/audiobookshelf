const { expect } = require('chai')
const sinon = require('sinon')

const Logger = require('../../../server/Logger')
const chapterSnap = require('../../../server/utils/chapterSnap')
const chapterSnapRunner = require('../../../server/utils/chapterSnapRunner')
const { timedTokens, searchKey, findHeadings, startBefore, createLocator, _anchorCache } = require('../../../server/utils/chapterLocate')

/** Words for a book where chapter k's heading is spoken at headings[k]: filler every second, the heading two words */
function bookWords(headings) {
  const words = []
  for (let t = 0; t < 4000; t += 1) {
    const h = headings.find((x) => t >= x.at - 1 && t < x.at + 2)
    if (h) continue
    words.push([t, t + 0.6, 'filler'])
  }
  for (const h of headings) {
    words.push([h.at, h.at + 0.4, 'Chapter'])
    words.push([h.at + 0.4, h.at + 0.9, `${h.n}.`])
  }
  return words.sort((a, b) => a[0] - b[0])
}

function fakeClient(words, { transcribeError = null } = {}) {
  return {
    mapFiles: sinon.spy((timeline) => timeline.map((t) => ({ path: t.path, offset: t.offset, duration: t.duration }))),
    transcribe: sinon.spy(async ({ ranges }) => {
      if (transcribeError) throw transcribeError
      return { model: 'base.en', results: ranges.map(({ start, length }) => ({ start, length, text: '', words: words.filter((w) => w[0] >= start && w[0] < start + length) })) }
    })
  }
}

const timeline = chapterSnap.buildTimeline([{ duration: 4000, metadata: { path: '/books/b/book.mp3' } }])
const titles = ['Opening', 'Chapter 1', 'Chapter 2', 'Chapter 3']

describe('chapterLocate', () => {
  beforeEach(() => {
    sinon.stub(Logger, 'info')
    sinon.stub(Logger, 'warn')
    sinon.stub(Logger, 'debug')
    _anchorCache.clear()
  })
  afterEach(() => sinon.restore())

  describe('helpers', () => {
    it('keeps word times on tokens and joins spoken compound numbers', () => {
      const toks = timedTokens([
        [1, 1.5, 'Chapter'],
        [1.5, 2, 'twenty'],
        [2, 2.4, 'one.'],
        [3, 3.5, 'Chapter'],
        [3.5, 4, '22.']
      ])
      expect(toks.map((t) => [t.tok, t.start])).to.deep.equal([
        ['chapter', 1],
        ['21', 1.5],
        ['chapter', 3],
        ['22', 3.5]
      ])
    })

    it('searches heading titles and named titles, not front matter or a bare heading word', () => {
      expect(searchKey('Chapter 12')).to.deep.equal({ key: ['chapter', '12'], exactFirst: true })
      expect(searchKey('Prologue')).to.deep.equal({ key: ['prologue'], exactFirst: true })
      expect(searchKey('The House of Mars')).to.deep.equal({ key: ['house', 'mars'], exactFirst: false })
      expect(searchKey('Dedication')).to.equal(null)
      expect(searchKey('Opening Credits')).to.equal(null)
      expect(searchKey('Chapter')).to.equal(null)
      expect(searchKey('Helldiver')).to.equal(null)
    })

    it('finds "chapter 1" but not inside "chapter 12"', () => {
      const toks = timedTokens([
        [1, 1.4, 'Chapter'],
        [1.4, 1.8, '12'],
        [9, 9.4, 'chapter'],
        [9.4, 9.8, 'one']
      ])
      expect(findHeadings(toks, searchKey('Chapter 1')).map((h) => h.start)).to.deep.equal([9])
    })

    it('starts leadSec before the heading, or halfway into a short gap', () => {
      const words = [
        [0, 1, 'end.'],
        [3, 3.4, 'Chapter']
      ]
      expect(startBefore(words, { start: 3, word: 1 }, 0.25)).to.equal(2.75)
      expect(startBefore([[0, 2.9, 'end'], [3, 3.4, 'Chapter']], { start: 3, word: 1 }, 0.25)).to.be.closeTo(2.95, 1e-9)
    })
  })

  describe('createLocator', () => {
    const proposals = (list) => Object.freeze(list.map(([index, start]) => Object.freeze({ index, originalStart: start, proposedStart: start, reason: 'nearest-longest-pause', confidence: 'high', pause: null })))

    it('leaves a start where the heading is heard and moves one whose heading is further away', async () => {
      const client = fakeClient(bookWords([{ n: 1, at: 1000 }, { n: 2, at: 2045 }, { n: 3, at: 3000 }]))
      const locator = createLocator({ titles, client, cacheKey: 'li-1' })
      const { verdicts, warnings } = await locator.verify({ proposals: proposals([[1, 999.5], [2, 2000], [3, 2999.6]]), timeline, signal: null })
      expect(warnings).to.deep.equal([])
      expect(verdicts.map((v) => v.index)).to.deep.equal([1, 2, 3])
      expect(verdicts[0]).to.not.have.property('start')
      expect(verdicts[0].speech).to.include({ heading: true })
      // chapter 2: 45 s late of the first window, found in the 60 s rung
      expect(verdicts[1].start).to.be.closeTo(2044.75, 1e-9)
      expect(verdicts[1].headingAt).to.equal(2045)
      expect(verdicts[1].speech).to.include({ heading: true, located: true })
      // the first window around chapter 2 (35 s), then the wider one
      expect(client.transcribe.callCount).to.equal(4)
    })

    it('predicts the next chapters with the offset of the last heading found', async () => {
      const client = fakeClient(bookWords([{ n: 1, at: 1100 }, { n: 2, at: 2100 }, { n: 3, at: 3100 }]))
      const locator = createLocator({ titles, client, cacheKey: 'li-2' })
      const { verdicts } = await locator.verify({ proposals: proposals([[1, 1000], [2, 2000], [3, 3000]]), timeline, signal: null })
      expect(verdicts.map((v) => v.start)).to.deep.equal([1099.75, 2099.75, 3099.75])
      // chapter 1 needed the 180 s rung; chapters 2 and 3 were in the first window around the predicted start
      expect(client.transcribe.callCount).to.equal(3 + 1 + 1)
    })

    it('keeps the anchors for the next batch of the same book', async () => {
      const words = bookWords([{ n: 1, at: 1100 }, { n: 2, at: 2100 }, { n: 3, at: 3100 }])
      await createLocator({ titles, client: fakeClient(words), cacheKey: 'li-3' }).verify({ proposals: proposals([[1, 1000]]), timeline, signal: null })
      const client = fakeClient(words)
      const { verdicts } = await createLocator({ titles, client, cacheKey: 'li-3' }).verify({ proposals: proposals([[3, 3000]]), timeline, signal: null })
      expect(verdicts[0].start).to.equal(3099.75)
      expect(client.transcribe.callCount).to.equal(1)
    })

    it('predicts a chapter not heard from the headings found around it', async () => {
      // chapter 2 is not read out; chapters 1 and 3 are found 100 s after their reference starts
      const client = fakeClient(bookWords([{ n: 1, at: 1100 }, { n: 3, at: 3100 }]))
      const { verdicts } = await createLocator({ titles, client, cacheKey: 'li-p' }).verify({ proposals: proposals([[1, 1000], [2, 2000], [3, 3000]]), timeline, signal: null })
      expect(verdicts[1]).to.include({ index: 2, start: 2099.75, headingAt: 2099.75, predicted: true })
      expect(verdicts[1].speech).to.include({ heading: false, predicted: true })
      expect(verdicts[0]).to.not.have.property('predicted')
    })

    it('keys anchors on the caller reference starts when the snap re-anchored them', async () => {
      const client = fakeClient(bookWords([{ n: 1, at: 1100 }, { n: 2, at: 2100 }]))
      // re-anchored starts (originalStart) are off by a growing amount; the reference starts carry a steady +100 s
      const list = Object.freeze([
        Object.freeze({ index: 1, originalStart: 1010, referenceStart: 1000, proposedStart: 1010, reason: 'nearest-longest-pause', confidence: 'high', pause: null }),
        Object.freeze({ index: 2, originalStart: 2050, referenceStart: 2000, proposedStart: 2050, reason: 'nearest-longest-pause', confidence: 'high', pause: null })
      ])
      const { verdicts } = await createLocator({ titles, client, cacheKey: 'li-k' }).verify({ proposals: list, timeline, signal: null })
      expect(verdicts.map((v) => v.start)).to.deep.equal([1099.75, 2099.75])
      // chapter 2 was in the first window around 2000 + 100
      expect(client.transcribe.callCount).to.equal(3 + 1)
    })

    it('reports a heading not found anywhere as not heard, without moving', async () => {
      const client = fakeClient(bookWords([]))
      const { verdicts } = await createLocator({ titles, client }).verify({ proposals: proposals([[1, 1000]]), timeline, signal: null })
      expect(verdicts[0]).to.not.have.property('start')
      expect(verdicts[0].speech).to.include({ heading: false })
    })

    it('leaves chapters it has no time for unchecked, for the next batch', async () => {
      let t = 0
      const client = fakeClient(bookWords([{ n: 1, at: 1000 }, { n: 2, at: 2000 }]))
      client.transcribe = sinon.spy(async (args) => {
        t += 28000
        return fakeClient(bookWords([{ n: 1, at: 1000 }, { n: 2, at: 2000 }])).transcribe(args)
      })
      const locator = createLocator({ titles, client, now: () => t, deadlineMs: 30000 })
      const { verdicts, warnings } = await locator.verify({ proposals: proposals([[1, 999.5], [2, 1999.5], [3, 2999.5]]), timeline, signal: null })
      expect(verdicts.map((v) => v.index)).to.deep.equal([1])
      expect(warnings[0]).to.match(/time limit reached: 2 chapters not checked/)
    })

    it('falls back to the plain speech check on a sidecar without /v1/transcribe', async () => {
      const error = Object.assign(new Error('Chapterbot POST /v1/transcribe returned 404'), { code: 'http_error', status: 404 })
      const fallback = { verify: sinon.spy(async () => ({ verdicts: [{ index: 1, speech: { heading: true } }], warnings: [] })) }
      const { verdicts } = await createLocator({ titles, client: fakeClient([], { transcribeError: error }), fallback }).verify({ proposals: proposals([[1, 1000]]), timeline, signal: null })
      expect(fallback.verify.calledOnce).to.equal(true)
      expect(verdicts).to.deep.equal([{ index: 1, speech: { heading: true } }])
    })

    it('reports a busy sidecar', async () => {
      const error = Object.assign(new Error('busy'), { code: 'http_error', status: 503 })
      const { verdicts, warnings } = await createLocator({ titles, client: fakeClient([], { transcribeError: error }) }).verify({ proposals: proposals([[1, 1000], [2, 2000]]), timeline, signal: null })
      expect(verdicts).to.deep.equal([])
      expect(warnings).to.deep.equal(['Speech check skipped: chapterbot is busy, 2 chapters not checked, try again later'])
    })
  })

  describe('in the snap runner', () => {
    // chapters at 1000/2000/3000; the 1.5 s pauses before the spoken headings sit 40 s after the given starts
    const bookPauses = [1038.5, 2038.5, 3038.5].map((s) => [s, s + 1.5])
    const detect = async ({ startSec, durationSec }) => {
      const lines = []
      for (const [s, e] of bookPauses) {
        const ls = s - startSec
        const le = e - startSec
        if (le <= 0 || ls >= durationSec) continue
        lines.push(`[silencedetect @ 0x1] silence_start: ${ls.toFixed(4)}`)
        lines.push(`[silencedetect @ 0x1] silence_end: ${le.toFixed(4)} | silence_duration: ${(le - ls).toFixed(4)}`)
      }
      return { lines }
    }
    const chapters = [0, 1000, 2000, 3000].map((start, id) => ({ id, title: titles[id], start }))

    it('moves a located start onto the pause before its heading', async () => {
      const client = fakeClient(bookWords([{ n: 1, at: 1040.05 }, { n: 2, at: 2040.05 }, { n: 3, at: 3040.05 }]))
      const result = await chapterSnapRunner.runSnap({
        libraryItemId: 'li-r',
        timeline,
        T: 4000,
        chapters,
        options: { ...chapterSnap.DEFAULT_OPTIONS, verify: true },
        detect,
        verifiers: [createLocator({ titles, client, cacheKey: 'li-r' })]
      })
      expect(result.chapters.slice(1).map((c) => [c.proposedStart, c.reason, c.confidence])).to.deep.equal([
        [1039.75, 'heading-located', 'high'],
        [2039.75, 'heading-located', 'high'],
        [3039.75, 'heading-located', 'high']
      ])
      expect(result.chapters[1]).to.include({ originalStart: 1000, delta: 39.75, changed: true })
      expect(result.chapters[1].speech).to.include({ heading: true, located: true })
      expect(result.options).to.include({ reanchor: true, locate: true })
    })

    it('puts a predicted start on the longest pause near the prediction, and leaves it without one', async () => {
      // chapter 2 is not read out: its pause (1.5 s) sits 40 s after the given start like the others
      const client = fakeClient(bookWords([{ n: 1, at: 1040.05 }, { n: 3, at: 3040.05 }]))
      const result = await chapterSnapRunner.runSnap({
        libraryItemId: 'li-pr',
        timeline,
        T: 4000,
        chapters,
        options: { ...chapterSnap.DEFAULT_OPTIONS, verify: true },
        detect,
        verifiers: [createLocator({ titles, client, cacheKey: 'li-pr' })]
      })
      expect(result.chapters[2]).to.include({ proposedStart: 2039.75, reason: 'aligned-to-headings', confidence: 'medium' })
      expect(result.chapters[2].speech).to.include({ predicted: true })

      const noPause = await chapterSnapRunner.runSnap({
        libraryItemId: 'li-pr2',
        timeline,
        T: 4000,
        chapters,
        options: { ...chapterSnap.DEFAULT_OPTIONS, verify: true },
        detect: async ({ startSec, durationSec }) => (startSec < 2100 && startSec + durationSec > 1990 ? { lines: [] } : detect({ startSec, durationSec })),
        verifiers: [createLocator({ titles, client, cacheKey: 'li-pr2' })]
      })
      expect(noPause.chapters[2].reason).to.not.equal('aligned-to-headings')
    })

    it('does not move a located start past a neighbour', async () => {
      // chapter 2's heading is heard before chapter 1's located start
      const client = fakeClient(bookWords([{ n: 1, at: 1040.05 }, { n: 2, at: 1030 }, { n: 3, at: 3040.05 }]))
      const result = await chapterSnapRunner.runSnap({
        libraryItemId: 'li-o',
        timeline,
        T: 4000,
        chapters: [0, 1000, 1060, 3000].map((start, id) => ({ id, title: titles[id], start })),
        options: { ...chapterSnap.DEFAULT_OPTIONS, verify: true },
        // no pauses: every start stays where it was given until the speech check moves it
        detect: async () => ({ lines: [] }),
        verifiers: [createLocator({ titles, client })]
      })
      expect(result.chapters[1]).to.include({ reason: 'heading-located', proposedStart: 1039.825 })
      expect(result.chapters[2]).to.include({ reason: 'no-pause-in-window', proposedStart: 1060 })
      expect(result.chapters[2].speech.located).to.equal(false)
    })
  })
})
