const { expect } = require('chai')
const sinon = require('sinon')

const Logger = require('../../../server/Logger')
const chapterbotSpeech = require('../../../server/utils/chapterbotSpeech')
const { ChapterbotError } = require('../../../server/utils/chapterbotClient')

const { tokens, tokenMatch, isHeadingExpected, heardHeading, assessSpeech, createVerifier } = chapterbotSpeech

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

  describe('heardHeading', () => {
    const fixtures = [
      ["Chapter 3 The rain didn't let up...", 'Chapter 3'],
      ['Chapter Twenty-One. Morning came.', 'Chapter 21'],
      ['chapter twenty one, morning came', 'Chapter 21'],
      ['Chapter Twelve.', 'Chapter 12'],
      ['CHAPTER XII. The rain.', 'Chapter 12'],
      ['Chapter I. It began.', 'Chapter 1'],
      ['Chapter 007', 'Chapter 7'],
      ['Chapter one hundred and two. The end.', 'Chapter 102'],
      ['Chapter One Hundred. The end.', 'Chapter 100'],
      ['Prologue. In the year of the comet', 'Prologue'],
      ['Epilogue. Ten years later', 'Epilogue'],
      ['Interlude: Quasar. The ship drifted.', 'Interlude'],
      ['Part Two. The Return.', 'Part 2'],
      ['Part II: Winter', 'Part 2'],
      ['Heat two of seven. Chapter three. The track was wet.', 'Chapter 3'],
      ['Black Ice, Chapter Four. Snow.', 'Chapter 4'],
      ['End of chapter two. Chapter three.', 'Chapter 3'],
      ['End of prologue. Chapter one.', 'Chapter 1'],
      ['Chapter I It began.', 'Chapter 1'],
      ['Part V', 'Part 5'],
      ['Chapter One. Two days later.', 'Chapter 1'],
      ['Chapter one hundred twenty one.', 'Chapter 121']
    ]
    for (const [after, heard] of fixtures) {
      it(`hears "${heard}" in "${after}"`, () => {
        expect(heardHeading(after)).to.equal(heard)
      })
    }

    const misses = [
      ['nothing heard', ''],
      ['no heading', 'The rain had not stopped for three days.'],
      ['heading more than 5 words in', 'and she never looked back again. Chapter Twelve. The rain'],
      ['"chapter" without a number', 'Chapter. The rain had not stopped.'],
      ['"part" in prose', 'Part of me wanted to stay.'],
      ['"chapter" in prose', 'That chapter of my life was over.'],
      ['a word made of roman numeral letters', 'Chapter civil war had begun.'],
      ['the previous chapter closing', 'End of chapter two. And so it was.'],
      ['the pronoun I after part', 'The part I liked best was'],
      ['the pronoun I after a heading word', 'Part I was afraid of the dark.'],
      ['number words it cannot read', 'chapter one thousand'],
      ['number words run together', 'Chapter twenty twenty'],
      ['not a string', undefined]
    ]
    for (const [name, after] of misses) {
      it(`hears nothing: ${name}`, () => {
        expect(heardHeading(after)).to.equal(null)
      })
    }
  })

  describe('tokenMatch', () => {
    it('allows spelling variants of title words', () => {
      expect(tokenMatch('clare', 'claire')).to.equal(true)
      expect(tokenMatch('claires', 'claire')).to.equal(true)
      expect(tokenMatch('ava', 'eva')).to.equal(true)
      expect(tokenMatch('catherine', 'katherine')).to.equal(true)
      expect(tokenMatch('chapters', 'chapter')).to.equal(true)
    })

    it('keeps different words, short words and numbers apart', () => {
      expect(tokenMatch('clara', 'claire')).to.equal(false)
      expect(tokenMatch('hannah', 'claire')).to.equal(false)
      expect(tokenMatch('eli', 'eva')).to.equal(false)
      expect(tokenMatch('evan', 'eva')).to.equal(false)
      expect(tokenMatch('mark', 'mary')).to.equal(false)
      expect(tokenMatch('12', '1')).to.equal(false)
      expect(tokenMatch('21st', '21')).to.equal(false)
      expect(tokenMatch('ab', 'eb')).to.equal(false)
      expect(tokenMatch('', 'eva')).to.equal(false)
    })

    it('does not take a common word that sounds alike for the title word', () => {
      const pairs = [
        ['right', 'night'],
        ['rather', 'father'],
        ['later', 'water'],
        ['there', 'where'],
        ['horse', 'house'],
        ['bother', 'mother'],
        ['better', 'letter'],
        ['live', 'love'],
        ['last', 'lost'],
        ['tame', 'time'],
        ['ruin', 'rain'],
        ['fare', 'fire'],
        ['hype', 'hope'],
        ['ran', 'run'],
        ['tim', 'tom'],
        ['port', 'part'],
        ['ever', 'over'],
        ['and', 'end']
      ]
      for (const [heard, want] of pairs) expect(tokenMatch(heard, want), `${heard} / ${want}`).to.equal(false)
    })

    it('allows the plural or possessive of a spelling variant', () => {
      expect(tokenMatch('clares', 'claire')).to.equal(true)
      expect(tokenMatch('quaser', 'quasar')).to.equal(true)
      expect(tokenMatch('kwasar', 'quasar')).to.equal(false)
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
        name: 'QA The Last Flight: a name title heard with another spelling (Claire / Clare)',
        title: 'Claire',
        before: 'and she hung up without another word.',
        after: 'Clare. Monday, February 21st. The day before the crash. The sound of the shower',
        expected: { heading: true, late: false, early: false, heard: null }
      },
      {
        name: 'a short name title heard with a vowel swapped (Eva / Ava)',
        title: 'Eva',
        before: 'the line went dead.',
        after: 'Ava. Berkeley, California. August 1999.',
        expected: { heading: true, late: false, early: false }
      },
      {
        name: 'a name title heard exactly, after a short lead-in',
        title: 'Claire',
        before: 'she closed the door.',
        after: 'Part two. Claire. Tuesday, February 22nd.',
        expected: { heading: true, late: false, early: false }
      },
      {
        name: 'a possessive is the same name',
        title: 'Claire',
        before: 'nothing more.',
        after: "Claire's phone rang at six.",
        expected: { heading: true, late: false, early: false }
      },
      {
        name: 'a different name is not the heading',
        title: 'Claire',
        before: 'and she hung up without another word.',
        after: 'Eva. Berkeley, California. August 1999. The day began',
        expected: { heading: false, late: false, early: false }
      },
      {
        name: 'a similar but different name is not the heading (Claire / Clara)',
        title: 'Claire',
        before: 'and she hung up.',
        after: 'Clara. Monday, February 21st.',
        expected: { heading: false, late: false, early: false }
      },
      {
        name: 'a short name with more than a vowel changed is not the heading (Eva / Eli)',
        title: 'Eva',
        before: 'the line went dead.',
        after: 'Eli. Berkeley, California.',
        expected: { heading: false, late: false, early: false }
      },
      {
        name: 'the name more than 5 words in is not the heading',
        title: 'Claire',
        before: 'and so.',
        after: 'On the day before the crash, everyone at the house said Clare woke early.',
        expected: { heading: false, late: false, early: false }
      },
      {
        name: 'numbers never match fuzzily',
        title: 'Chapter 1',
        before: 'the end.',
        after: 'Chapter twelve. The rain.',
        expected: { heading: false, late: false, early: false }
      },
      {
        name: 'not LATE when the heading heard before the start is a different word (Quasar / Kwasar)',
        title: 'Interlude Quasar',
        before: 'and that was all. Interlude. Kwasar.',
        after: 'The ship drifted on for days.',
        expected: { heading: false, late: false, early: false }
      },
      {
        name: 'LATE uses the same spelling tolerance (Quasar / Quaser)',
        title: 'Interlude Quasar',
        before: 'and that was all. Interlude. Quaser.',
        after: 'The ship drifted on for days.',
        expected: { heading: false, late: true, early: false }
      },
      {
        name: 'EARLY uses the same spelling tolerance (Quasar / Quaser)',
        title: 'Interlude Quasar',
        before: 'music',
        after: 'This audiobook is produced by Macmillan Audio. Interlude. Quaser. The ship',
        expected: { heading: false, late: false, early: true }
      },
      {
        name: 'a single-word title is not heard in a common word that sounds alike (Night / Right)',
        title: 'Night',
        before: 'and then she slept.',
        after: 'Right, so where were we?',
        expected: { heading: false, late: false, early: false }
      },
      {
        name: 'a single-word title is not heard in a common word that sounds alike (Father / rather)',
        title: 'Father',
        before: 'and then she slept.',
        after: 'I would rather not say.',
        expected: { heading: false, late: false, early: false }
      },
      {
        name: 'a title with a stop word is not heard in a common word that sounds alike (The Letter / Better)',
        title: 'The Letter',
        before: 'and then she slept.',
        after: 'Better late than never.',
        expected: { heading: false, late: false, early: false }
      },
      {
        name: 'a near miss on the heading word does not make the start LATE (Part / port)',
        title: 'Part Two',
        before: 'and so it went. Port two.',
        after: 'The rain fell',
        expected: { heading: false, late: false, early: false }
      },
      {
        name: 'a near miss on the heading word does not count as the start of the heading (Part / port)',
        title: 'Part One',
        before: 'and so it went. Part one.',
        after: 'Port one is open.',
        expected: { heading: false, late: true, early: false }
      },
      {
        name: 'front matter not read out is not expected (Dedication)',
        title: 'Dedication',
        before: 'This is Macmillan Audio.',
        after: 'For my mother, who taught me to read.',
        expected: { heading: false, late: false, early: false },
        headingExpected: false
      },
      {
        name: 'front matter not read out is not expected (Epigraph)',
        title: 'Epigraph',
        before: 'for my mother.',
        after: 'We are all of us broken, that is how the light gets in.',
        expected: { heading: false, late: false, early: false },
        headingExpected: false
      },
      {
        name: 'front matter that is read out is still heard',
        title: 'Dedication',
        before: 'This is Macmillan Audio.',
        after: 'Dedication. For my mother.',
        expected: { heading: true, late: false, early: false },
        headingExpected: false
      },
      {
        name: 'the chapter number read out alone (Keep Them Close)',
        title: 'Chapter 2: Allison',
        before: 'the truck lurched toward the rail.',
        after: '2. Allison. By some small miracle, the truck does not collide.',
        expected: { heading: true, late: false, early: false }
      },
      {
        name: 'another number first is not the heading',
        title: 'Chapter 2: Allison',
        before: 'she said.',
        after: '3. Allison. The crowd is on its feet.',
        expected: { heading: false }
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
        expect(speech).to.have.keys(['before', 'after', 'heading', 'late', 'early', 'heard', 'expected'])
        expect(speech.expected).to.equal(f.headingExpected ?? true)
        expect(speech).to.include(f.expected)
        expect(speech.before).to.equal(f.before)
        expect(speech.after).to.equal(f.after)
      })
    }

    it('reports the heading heard at the start of the after-clip, whatever the title is', () => {
      // QA: the title is a file-style name, the narrator reads out a chapter number
      const speech = assessSpeech('Black Ice - Part 02', 'and the door slammed behind her.', "Chapter 3 The rain didn't let up all night.")
      expect(speech).to.include({ heading: false, late: false, early: false, heard: 'Chapter 3' })
      expect(assessSpeech('Chapter 12', 'the end.', 'Chapter Twelve. The rain had not stopped.').heard).to.equal('Chapter 12')
      expect(assessSpeech('Chapter 12', 'the end.', 'The rain had not stopped for three days.').heard).to.equal(null)
      expect(assessSpeech('Chapter 9', '', '').heard).to.equal(null)
    })

    it('hears nothing at a start flagged EARLY or LATE (the clip may hold the neighbouring chapter)', () => {
      const early = assessSpeech('Chapter 4', '', 'End of chapter three. Thank you for listening. Chapter four. The rain')
      expect(early).to.include({ heading: false, early: true, heard: null })
      const late = assessSpeech('Chapter 4', 'and that was that. Chapter four.', 'Part two. The rain had stopped.')
      expect(late).to.include({ late: true, heard: null })
      expect(heardHeading('Part two. The rain had stopped.')).to.equal('Part 2')
    })

    it('reports speech.expected = false only for front and back matter titles', () => {
      const unspoken = ['Dedication', 'Epigraph', 'Foreword', 'Preface', 'Acknowledgments', 'Acknowledgements', 'Opening Credits', 'End Credits', 'Introduction', 'Copyright', 'About the Author', 'Also by Julie Clark', 'Praise for The Last Flight', '2. Dedication', 'CREDITS', '01 - Dedication', '1 Opening Credits', 'Track 02 - Credits', 'Forward', 'Contents']
      for (const title of unspoken) expect(isHeadingExpected(title), title).to.equal(false)
      const spoken = ['Claire', 'Eva', 'Prologue', 'Epilogue', 'Chapter 1', 'Part 2', 'The End of the Affair', 'Credit Where Due', 'Ending', 'Forward March', 'Contents Under Pressure', '1984', '', null]
      for (const title of spoken) expect(isHeadingExpected(title), String(title)).to.equal(true)
      expect(assessSpeech('Opening Credits', '', 'This is Macmillan Audio.').expected).to.equal(false)
      expect(assessSpeech('Claire', '', 'Clare.').expected).to.equal(true)
    })

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
      expect(verdicts[0]).to.deep.equal({ index: 1, speech: { before: 'the end.', after: 'Chapter one. Hello.', heading: true, late: false, early: false, heard: 'Chapter 1', expected: true } })
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

    it('takes a smaller or larger start limit and a longer deadline (auto pipeline chunks)', async () => {
      const client = fakeClient()
      const proposals = Array.from({ length: 31 }, (_, i) => proposal(i, i * 10))
      const small = await createVerifier({ titles: [], client, maxStarts: 3 }).verify({ proposals, timeline })
      expect(small.verdicts).to.have.length(3)
      expect(small.warnings[0]).to.include('limited to 3 chapters per request: 27 not checked')

      let t = 0
      const now = () => t
      const big = createVerifier({ titles: [], client: fakeClient(), now, deadlineMs: 10 * 60 * 1000, maxStarts: 30 })
      // far past the HTTP budget of 55 s: the pipeline deadline still has room
      t = 120000
      const result = await big.verify({ proposals, timeline })
      expect(result.verdicts).to.have.length(30)
      expect(result.warnings).to.deep.equal([])
    })

    it('sizes batches to the time left and stops inside the budget', async () => {
      const client = fakeClient()
      let t = 0
      const now = () => t
      client.verify = sinon.spy(async ({ starts }) => {
        t += 20000
        return { results: starts.map((start) => ({ start, before: '', after: '' })) }
      })
      const verifier = createVerifier({ titles: [], client, now, deadlineMs: 55000 })
      const proposals = Array.from({ length: 16 }, (_, i) => proposal(i, i * 10))
      const { verdicts, warnings } = await verifier.verify({ proposals, timeline })
      // 55 s left: 5 starts; 35 s: 5; 15 s: 4 (fits 4 x 3 s + 2 s); then nothing fits
      expect(client.verify.getCalls().map((c) => c.args[0].starts.length)).to.deep.equal([5, 5, 4])
      expect(client.verify.getCalls().map((c) => c.args[0].timeoutMs)).to.deep.equal([55000, 35000, 15000])
      expect(verdicts).to.have.length(14)
      expect(warnings).to.deep.equal(['Speech check time limit reached: 1 chapters not checked. Resend with "indexes" set to them to check them.'])
    })

    it('counts the time the snap took before verify against the same budget', async () => {
      const client = fakeClient()
      let t = 0
      const now = () => t
      client.verify = sinon.spy(async ({ starts }) => {
        t += 3000
        return { results: starts.map((start) => ({ start, before: '', after: '' })) }
      })
      const verifier = createVerifier({ titles: [], client, now, deadlineMs: 55000 })
      t = 50000 // the silence snap ran for 50 s
      const proposals = Array.from({ length: 4 }, (_, i) => proposal(i, i * 10))
      const { verdicts, warnings } = await verifier.verify({ proposals, timeline })
      expect(client.verify.calledOnce).to.equal(true)
      expect(client.verify.firstCall.args[0].starts).to.have.length(1)
      expect(client.verify.firstCall.args[0].timeoutMs).to.equal(5000)
      expect(verdicts).to.have.length(1)
      expect(warnings[0]).to.include('2 chapters not checked')

      t = 54000
      const late = createVerifier({ titles: [], client: fakeClient(), now, deadlineMs: 1000 })
      t = 56000
      const outcome = await late.verify({ proposals, timeline })
      expect(outcome.verdicts).to.deep.equal([])
      expect(outcome.warnings[0]).to.include('3 chapters not checked')
    })

    it('reports a batch that hits the time limit as not checked', async () => {
      const client = fakeClient()
      client.verify = sinon.spy(async () => {
        throw new ChapterbotError('timeout', 'Chapterbot POST /v1/verify timed out after 55000 ms')
      })
      const { verdicts, warnings } = await createVerifier({ titles: [], client }).verify({ proposals: [proposal(0, 0), proposal(1, 10), proposal(2, 20)], timeline })
      expect(verdicts).to.deep.equal([])
      expect(warnings).to.deep.equal(['Speech check time limit reached: 2 chapters not checked. Resend with "indexes" set to them to check them.'])
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
