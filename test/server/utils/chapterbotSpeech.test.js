const { expect } = require('chai')
const sinon = require('sinon')

const Logger = require('../../../server/Logger')
const chapterbotSpeech = require('../../../server/utils/chapterbotSpeech')
const { ChapterbotError } = require('../../../server/utils/chapterbotClient')

const { tokens, assessSpeech, createVerifier } = chapterbotSpeech

describe('chapterbotSpeech', () => {
  describe('tokens (build-chapters.ps1 Tokens)', () => {
    it('normalises number words, roman numerals, leading zeros and apostrophes', () => {
      expect(tokens('Chapter Twelve.')).to.deep.equal(['chapter', '12'])
      expect(tokens('Chapter twenty-one')).to.deep.equal(['chapter', '21'])
      expect(tokens('Chapter Twenty')).to.deep.equal(['chapter', '20'])
      expect(tokens('CHAPTER XII')).to.deep.equal(['chapter', '12'])
      expect(tokens('Chapter 007')).to.deep.equal(['chapter', '7'])
      expect(tokens('Chapter I')).to.deep.equal(['chapter', '1'])
      expect(tokens('I said it')).to.deep.equal(['i', 'said', 'it'])
      expect(tokens("Don’t stop, Ana's")).to.deep.equal(['dont', 'stop', 'anas'])
      expect(tokens('')).to.deep.equal([])
    })
  })

  describe('assessSpeech (verify-report.ps1 rules)', () => {
    const fixtures = [
      {
        name: 'heading right at the start',
        title: 'Chapter 12',
        before: 'and that, she decided, was the end of it.',
        after: 'Chapter Twelve. The rain had not stopped for three days.',
        expected: { heading: true, late: false, early: false }
      },
      {
        name: 'LATE: heading heard at the end of the before-clip',
        title: 'Chapter 12',
        before: 'was the end of it. Chapter Twelve.',
        after: 'The rain had not stopped for three days and the river',
        expected: { heading: false, late: true, early: false }
      },
      {
        name: 'EARLY: heading more than 5 words into the after-clip',
        title: 'Chapter 12',
        before: 'she turned to the window',
        after: 'and she never looked back at the house again. Chapter Twelve. The rain',
        expected: { heading: false, late: false, early: true }
      },
      {
        name: 'a short lead-in is part of the heading',
        title: 'Chapter 3',
        before: 'and then it was quiet.',
        after: 'Heat two of seven. Chapter three. The track was wet.',
        expected: { heading: true, late: false, early: false }
      },
      {
        name: 'roman numerals in the title match spoken numbers',
        title: 'Chapter XXI',
        before: 'the door closed.',
        after: 'Chapter twenty one. Morning came.',
        expected: { heading: true, late: false, early: false }
      },
      {
        name: 'a list index is not read out',
        title: '3. Prologue',
        before: 'Opening credits music fades out.',
        after: 'Prologue. In the year of the comet',
        expected: { heading: true, late: false, early: false }
      },
      {
        name: 'heard in both clips is not LATE when the after-clip starts with it',
        title: 'Chapter 4',
        before: 'end of chapter 4 she said',
        after: 'Chapter four. Snow.',
        expected: { heading: true, late: false, early: false }
      },
      {
        name: 'named titles get heading but never LATE or EARLY',
        title: 'The Ashes of Rome',
        before: 'and so it ended. The Ashes of Rome.',
        after: 'one two three four five six seven, The Ashes of Rome',
        expected: { heading: false, late: false, early: false }
      },
      {
        name: 'named title heard at the start',
        title: 'The Ashes of Rome',
        before: 'and so it ended.',
        after: 'The Ashes of Rome. It began with fire.',
        expected: { heading: true, late: false, early: false }
      },
      {
        name: 'nothing heard',
        title: 'Chapter 9',
        before: '',
        after: '',
        expected: { heading: false, late: false, early: false }
      }
    ]

    for (const f of fixtures) {
      it(f.name, () => {
        const speech = assessSpeech(f.title, f.before, f.after)
        expect(speech).to.have.keys(['before', 'after', 'heading', 'late', 'early'])
        expect(speech).to.include(f.expected)
        expect(speech.before).to.equal(f.before)
        expect(speech.after).to.equal(f.after)
      })
    }

    it('caps the echoed transcripts', () => {
      const speech = assessSpeech('Chapter 1', 'x '.repeat(2000), 'y '.repeat(2000))
      expect(speech.before.length).to.equal(1000)
      expect(speech.after.length).to.equal(1000)
    })
  })

  describe('createVerifier', () => {
    const timeline = [
      { index: 0, path: '/books/A/1.mp3', offset: 0, duration: 1000 },
      { index: 1, path: '/books/A/2.mp3', offset: 1000, duration: 1000 }
    ]
    const mapped = [
      { path: 'A/1.mp3', offset: 0, duration: 1000 },
      { path: 'A/2.mp3', offset: 1000, duration: 1000 }
    ]

    function proposal(index, proposedStart, reason = 'nearest-longest-pause') {
      return { index, originalStart: proposedStart, proposedStart, reason, confidence: 'high', pause: null }
    }

    function fakeClient(transcripts = {}) {
      return {
        mapFiles: sinon.spy(() => mapped),
        verify: sinon.spy(async ({ starts }) => ({ model: 'base.en', results: starts.map((start) => ({ start, before: transcripts[start]?.[0] ?? 'end.', after: transcripts[start]?.[1] ?? 'Chapter something.' })) }))
      }
    }

    beforeEach(() => {
      sinon.stub(Logger, 'warn')
    })

    afterEach(() => {
      sinon.restore()
    })

    it('checks proposed starts, fills speech and lowers confidence only for LATE/EARLY', async () => {
      const client = fakeClient({
        500.5: ['the end.', 'Chapter one. Hello.'],
        1500.25: ['the end. Chapter two.', 'Hello there friend.'],
        1800: ['quiet', 'and then a long time passed before Chapter three. Rain.']
      })
      const titles = ['Intro', 'Chapter 1', 'Chapter 2', 'Chapter 3']
      const verifier = createVerifier({ titles, client, skipReasons: new Set(['not-requested']) })
      const proposals = [proposal(0, 0, 'first-chapter'), proposal(1, 500.5), proposal(2, 1500.25), proposal(3, 1800)]
      const { verdicts, warnings } = await verifier.verify({ proposals, timeline })

      expect(client.verify.calledOnce).to.equal(true)
      expect(client.verify.firstCall.args[0]).to.include({ beforeSec: 8, afterSec: 10 })
      expect(client.verify.firstCall.args[0].files).to.deep.equal(mapped)
      expect(client.verify.firstCall.args[0].starts).to.deep.equal([500.5, 1500.25, 1800])
      expect(warnings).to.deep.equal([])
      expect(verdicts).to.have.length(3)
      expect(verdicts[0]).to.deep.equal({ index: 1, speech: { before: 'the end.', after: 'Chapter one. Hello.', heading: true, late: false, early: false } })
      expect(verdicts[1]).to.include({ index: 2, confidence: 'low' })
      expect(verdicts[1].speech).to.include({ late: true, early: false })
      expect(verdicts[2]).to.include({ index: 3, confidence: 'low' })
      expect(verdicts[2].speech).to.include({ late: false, early: true })
      for (const v of verdicts) expect(v).to.not.have.any.keys('proposedStart', 'start')
    })

    it('skips the first chapter, starts under 1 s and skipped reasons', async () => {
      const client = fakeClient()
      const verifier = createVerifier({ titles: [], client, skipReasons: new Set(['not-requested', 'not-analysed']) })
      const { verdicts } = await verifier.verify({ proposals: [proposal(0, 0), proposal(1, 0.5), proposal(2, 100, 'not-requested'), proposal(3, 200, 'not-analysed')], timeline })
      expect(verdicts).to.deep.equal([])
      expect(client.verify.called).to.equal(false)
      expect(client.mapFiles.called).to.equal(false)
    })

    it('batches requests and bounds the number of checked starts', async () => {
      const client = fakeClient()
      const n = chapterbotSpeech.MAX_VERIFY_STARTS + 5
      const proposals = Array.from({ length: n + 1 }, (_, i) => proposal(i, i * 10))
      const { verdicts, warnings } = await createVerifier({ titles: [], client }).verify({ proposals, timeline })
      expect(client.verify.callCount).to.equal(Math.ceil(chapterbotSpeech.MAX_VERIFY_STARTS / chapterbotSpeech.BATCH_SIZE))
      for (const call of client.verify.getCalls()) expect(call.args[0].starts.length).to.be.at.most(chapterbotSpeech.BATCH_SIZE)
      expect(verdicts).to.have.length(chapterbotSpeech.MAX_VERIFY_STARTS)
      expect(warnings).to.have.length(1)
      expect(warnings[0]).to.include('5 not checked')
    })

    it('stops at the deadline and reports what was not checked', async () => {
      const client = fakeClient()
      let t = 0
      const now = () => t
      client.verify = sinon.spy(async ({ starts }) => {
        t += 70000
        return { results: starts.map((start) => ({ start, before: '', after: '' })) }
      })
      const proposals = Array.from({ length: 31 }, (_, i) => proposal(i, i * 10))
      const { verdicts, warnings } = await createVerifier({ titles: [], client, now, deadlineMs: 120000 }).verify({ proposals, timeline })
      expect(client.verify.callCount).to.equal(2)
      expect(verdicts).to.have.length(20)
      expect(warnings).to.deep.equal(['Speech check time limit reached: 10 chapters not checked'])
    })

    it('turns sidecar failures into a warning and leaves speech empty', async () => {
      const client = fakeClient()
      client.verify = sinon.spy(async () => {
        throw new ChapterbotError('http_error', 'Chapterbot POST /v1/verify returned 503 (busy)', { status: 503 })
      })
      const { verdicts, warnings } = await createVerifier({ titles: [], client }).verify({ proposals: [proposal(0, 0), proposal(1, 10)], timeline })
      expect(verdicts).to.deep.equal([])
      expect(warnings).to.deep.equal(['Speech check skipped: chapterbot is busy, 1 chapters not checked, try again later'])
    })

    it('never sends anything when a file is outside the path map', async () => {
      const client = fakeClient()
      client.mapFiles = sinon.spy(() => {
        throw new ChapterbotError('path_unmapped', 'File is outside every CHAPTERBOT_PATH_MAP prefix')
      })
      const { verdicts, warnings } = await createVerifier({ titles: [], client }).verify({ proposals: [proposal(0, 0), proposal(1, 10)], timeline })
      expect(client.verify.called).to.equal(false)
      expect(verdicts).to.deep.equal([])
      expect(warnings[0]).to.include('outside the configured chapterbot path map')
    })
  })
})
