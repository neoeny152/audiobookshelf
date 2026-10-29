const { expect } = require('chai')

const plan = require('../../../../server/utils/autoPipeline/chapterPlan')

const ch = (rows) => rows.map(([title, start, end]) => ({ title, start, end }))

/** audnexus-style response */
function audible({ starts, runtimeMs, intro = 0, outro = 0, isAccurate = true }) {
  const chapters = starts.map((s, i) => ({
    title: `Chapter ${i + 1}`,
    startOffsetMs: s,
    startOffsetSec: Math.floor(s / 1000),
    lengthMs: (i + 1 < starts.length ? starts[i + 1] : runtimeMs) - s
  }))
  return { asin: 'B0TEST0001', chapters, runtimeLengthMs: runtimeMs, runtimeLengthSec: Math.floor(runtimeMs / 1000), brandIntroDurationMs: intro, brandOutroDurationMs: outro, isAccurate }
}

describe('autoPipeline chapterPlan', () => {
  describe('classifyChapters', () => {
    const scanner = ch([
      ['part0', 0, 1000],
      ['part1', 1000, 2000]
    ])

    it('none, scanner, pipeline and user', () => {
      expect(plan.classifyChapters([], scanner)).to.equal('none')
      expect(plan.classifyChapters(null, scanner)).to.equal('none')
      expect(
        plan.classifyChapters(
          ch([
            ['part0', 0, 1000.0004],
            ['part1', 1000.0004, 2000]
          ]),
          scanner
        )
      ).to.equal('scanner')
      const edited = ch([
        ['Opening', 0, 1000],
        ['part1', 1000, 2000]
      ])
      expect(plan.classifyChapters(edited, scanner)).to.equal('user')
      expect(plan.classifyChapters(edited, scanner, plan.chaptersHash(edited))).to.equal('pipeline')
      // a start moved by more than 1 ms is an edit
      expect(
        plan.classifyChapters(
          ch([
            ['part0', 0, 1000.01],
            ['part1', 1000.01, 2000]
          ]),
          scanner
        )
      ).to.equal('user')
    })
  })

  describe('clearlyBad', () => {
    it('flags one chapter for a long book, out of range, overlapping, not increasing and very long chapters', () => {
      expect(plan.clearlyBad(ch([['Book', 0, 7200]]), 7200)).to.equal('one-chapter')
      expect(plan.clearlyBad(ch([['Book', 0, 1200]]), 1200)).to.equal(null)
      expect(
        plan.clearlyBad(
          ch([
            ['a', 0, 100],
            ['b', 100, 9000]
          ]),
          8000
        )
      ).to.equal('outside-book')
      expect(
        plan.clearlyBad(
          ch([
            ['a', 0, 500],
            ['b', 400, 1000]
          ]),
          1000
        )
      ).to.equal('overlapping')
      expect(
        plan.clearlyBad(
          ch([
            ['a', 0, 500],
            ['b', 500, 600],
            ['c', 500, 1000]
          ]),
          1000
        )
      ).to.equal('not-increasing')
      expect(
        plan.clearlyBad(
          ch([
            ['a', 0, 10000],
            ['b', 10000, 20000]
          ]),
          20000
        )
      ).to.equal('chapters-too-long')
      expect(
        plan.clearlyBad(
          ch([
            ['a', 0, 3000],
            ['b', 3000, 6000]
          ]),
          6000
        )
      ).to.equal(null)
    })
  })

  describe('removeBranding', () => {
    it('ports the client: shifts by the intro, placeholders inside it, drops an outro-only last chapter', () => {
      const data = audible({ starts: [0, 1500, 600000, 1200000], runtimeMs: 1205000, intro: 2000, outro: 5000 })
      const out = plan.removeBranding(data)
      expect(out.chapters.map((c) => c.startOffsetMs)).to.deep.equal([0, 1000, 598000])
      expect(out.runtimeLengthMs).to.equal(1198000)
      expect(out.runtimeLengthSec).to.equal(1198)
      // input untouched
      expect(data.chapters).to.have.length(4)
    })
  })

  describe('pickAudibleSource', () => {
    const T = 3600

    it('aligned within max(3 s, 0.05 %), titles and times from Audible, ends at the next start', () => {
      const src = plan.pickAudibleSource(audible({ starts: [0, 1200500, 2400000], runtimeMs: 3601000 }), T)
      expect(src).to.include({ result: 'aligned', variant: 'raw', diffSec: 1, isAccurate: true })
      expect(src.chapters).to.deep.equal(
        ch([
          ['Chapter 1', 0, 1200.5],
          ['Chapter 2', 1200.5, 2400],
          ['Chapter 3', 2400, 3600]
        ])
      )
    })

    it('picks the debranded variant when it fits the audio better', () => {
      const data = audible({ starts: [0, 1202000, 2402000], runtimeMs: 3606000, intro: 2000, outro: 4000 })
      const src = plan.pickAudibleSource(data, T)
      expect(src).to.include({ result: 'aligned', variant: 'debranded', diffSec: 0 })
      expect(src.chapters.map((c) => c.start)).to.deep.equal([0, 1200, 2400])
      // the raw variant wins when the audio still has the branding
      expect(plan.pickAudibleSource(data, 3606).variant).to.equal('raw')
    })

    it('near within 30 s or when Audible says the times are not accurate; mismatch beyond 30 s', () => {
      expect(plan.pickAudibleSource(audible({ starts: [0, 1200000], runtimeMs: 3620000 }), T).result).to.equal('near')
      expect(plan.pickAudibleSource(audible({ starts: [0, 1200000], runtimeMs: 3600000, isAccurate: false }), T).result).to.equal('near')
      expect(plan.pickAudibleSource(audible({ starts: [0, 1200000], runtimeMs: 3700000 }), T).result).to.equal('mismatch')
      expect(plan.pickAudibleSource(audible({ starts: [0, 1200000], runtimeMs: 3700000, isAccurate: false }), T).result).to.equal('mismatch')
      // 0.05 % of a 30 h book is 54 s: still aligned at 40 s
      expect(plan.pickAudibleSource(audible({ starts: [0, 1200000], runtimeMs: 108040000 }), 108000).result).to.equal('aligned')
    })

    it('none without data', () => {
      expect(plan.pickAudibleSource(null, T).result).to.equal('none')
      expect(plan.pickAudibleSource({ chapters: [] }, T).result).to.equal('none')
    })

    it('drops chapters past the end and starts that do not increase', () => {
      const data = audible({ starts: [0, 1000000, 1000000, 3700000], runtimeMs: 3601000 })
      expect(plan.pickAudibleSource(data, T).chapters.map((c) => c.start)).to.deep.equal([0, 1000])
    })
  })

  describe('audioFingerprint', () => {
    it('depends on ino, size and duration, not on order; excluded files do not count', () => {
      const a = { ino: '1', duration: 100, metadata: { size: 10 } }
      const b = { ino: '2', duration: 200, metadata: { size: 20 } }
      expect(plan.audioFingerprint([a, b])).to.equal(plan.audioFingerprint([b, a]))
      expect(plan.audioFingerprint([a, b])).to.not.equal(plan.audioFingerprint([a, { ...b, metadata: { size: 21 } }]))
      expect(plan.audioFingerprint([a])).to.equal(plan.audioFingerprint([a, { ...b, exclude: true }]))
    })
  })

  describe('evaluatePolicy', () => {
    const speech = (over = {}) => ({ heading: true, late: false, early: false, heard: null, expected: true, ...over })
    const snap = (chapters, over = {}) => ({
      complete: true,
      stats: { failedSegments: 0 },
      chapters: chapters.map((c, i) => ({ index: i, reason: 'nearest-longest-pause', confidence: 'high', speech: i ? speech() : null, ...c })),
      ...over
    })

    it('applies only when every chapter after the first is high confidence and heard right', () => {
      expect(plan.evaluatePolicy({ source: 'aligned', snap: snap([{}, {}, {}]) })).to.deep.equal({ apply: true, blockers: [], failing: [] })
      expect(plan.evaluatePolicy({ source: 'scanner', snap: snap([{}, {}]) }).apply).to.equal(true)
    })

    it('a near source, an incomplete snap or extra blockers never apply', () => {
      expect(plan.evaluatePolicy({ source: 'near', snap: snap([{}, {}]) })).to.deep.include({ apply: false, blockers: ['source-near'] })
      expect(plan.evaluatePolicy({ source: 'aligned', snap: snap([{}, {}], { complete: false }) }).blockers).to.include('snap-incomplete')
      expect(plan.evaluatePolicy({ source: 'aligned', snap: snap([{}, {}], { stats: { failedSegments: 1 } }) }).blockers).to.include('analysis-failed')
      expect(plan.evaluatePolicy({ source: 'aligned', snap: snap([{}, {}]), extra: ['user-edited'] }).apply).to.equal(false)
    })

    it('lists the failing reasons per chapter', () => {
      const result = plan.evaluatePolicy({
        source: 'aligned',
        snap: snap([{}, { confidence: 'medium' }, { speech: null }, { speech: speech({ late: true, heading: false }), confidence: 'low' }, { speech: speech({ early: true }) }, { speech: speech({ heading: false }) }, { speech: speech({ heading: false, expected: false }) }, { speech: speech({ heading: false, heard: 'Chapter 9' }) }, { reason: 'not-analysed', speech: null }])
      })
      expect(result.apply).to.equal(false)
      const why = Object.fromEntries(result.failing.map((f) => [f.index, f.why]))
      expect(why[1]).to.deep.equal(['confidence-medium'])
      expect(why[2]).to.deep.equal(['no-speech-check'])
      expect(why[3]).to.deep.equal(['confidence-low', 'late', 'heading-not-heard'])
      expect(why[4]).to.deep.equal(['early'])
      expect(why[5]).to.deep.equal(['heading-not-heard'])
      expect(why[6]).to.equal(undefined) // front matter: no heading expected
      expect(why[7]).to.deep.equal(['heading-not-heard', 'heard-other-heading'])
      expect(why[8]).to.deep.equal(['not-analysed', 'no-speech-check'])
      expect(plan.summarizeFailing(result)).to.equal('1 medium confidence, 2 not speech checked, 1 low confidence, 1 LATE, 3 heading not heard, 1 EARLY, 1 other heading heard, 1 not analysed')
    })
  })

  it('chaptersEqual compares titles and times within 1 ms', () => {
    const a = ch([
      ['A', 0, 10],
      ['B', 10, 20]
    ])
    expect(
      plan.chaptersEqual(
        a,
        ch([
          ['A', 0, 10.0005],
          ['B', 10.0005, 20]
        ])
      )
    ).to.equal(true)
    expect(
      plan.chaptersEqual(
        a,
        ch([
          ['A', 0, 10],
          ['C', 10, 20]
        ])
      )
    ).to.equal(false)
    expect(
      plan.chaptersEqual(
        a,
        ch([
          ['A', 0, 10.01],
          ['B', 10.01, 20]
        ])
      )
    ).to.equal(false)
    expect(plan.chaptersEqual(a, a.slice(0, 1))).to.equal(false)
  })
})
