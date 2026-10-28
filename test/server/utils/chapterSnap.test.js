const { expect } = require('chai')

const chapterSnap = require('../../../server/utils/chapterSnap')
const { REASONS, SnapInputError, DEFAULT_OPTIONS } = chapterSnap

const WIDE = { lo: 0, loOpen: true, hi: 1e9, hiOpen: false }

function opts(overrides = {}) {
  return { ...DEFAULT_OPTIONS, ...overrides }
}

function pause(start, end, extra = {}) {
  return { start, end, startClipped: false, endClipped: false, crossesFileBoundary: false, ...extra }
}

function track(index, offset, duration, path = `/books/part${index}.mp3`) {
  return { index, path, offset, duration }
}

function snap(t, pauses, extra = {}) {
  return chapterSnap.snapOne({ index: 1, t, pauses, timeline: [track(0, 0, 1e6)], options: opts(extra.options), bounds: extra.bounds || WIDE, skipReason: extra.skipReason })
}

// Real ffmpeg stderr (ffmpeg 4.x and 6.x prefixes)
const STDERR_FIXTURE = [
  "Input #0, mp3, from 'file:/books/Black Ice/part01.mp3':",
  '  Duration: 00:59:58.12, start: 0.025057, bitrate: 64 kb/s',
  '  Stream #0:0: Audio: mp3, 22050 Hz, mono, fltp, 64 kb/s',
  'Stream mapping:',
  '  Stream #0:0 -> #0:0 (mp3 (mp3float) -> pcm_s16le (native))',
  '[silencedetect @ 0000023a4f1e6c40] silence_start: 12.3456',
  '[silencedetect @ 0000023a4f1e6c40] silence_end: 14.5678 | silence_duration: 2.2222',
  '[Parsed_silencedetect_0 @ 0x55d5c8a4b2c0] silence_start: 30.1',
  '[Parsed_silencedetect_0 @ 0x55d5c8a4b2c0] silence_end: 30.95 | silence_duration: 0.85',
  'size=N/A time=00:00:58.00 bitrate=N/A speed= 512x'
]

describe('chapterSnap', () => {
  describe('parseOptions', () => {
    it('returns defaults for an empty body', () => {
      expect(chapterSnap.parseOptions(undefined)).to.deep.equal(DEFAULT_OPTIONS)
      expect(chapterSnap.parseOptions(null)).to.deep.equal(DEFAULT_OPTIONS)
      expect(chapterSnap.parseOptions({})).to.deep.equal(DEFAULT_OPTIONS)
    })

    it('clamps finite numbers at each bound', () => {
      expect(chapterSnap.parseOptions({ windowSec: 999 }).windowSec).to.equal(60)
      expect(chapterSnap.parseOptions({ windowSec: 0 }).windowSec).to.equal(2)
      expect(chapterSnap.parseOptions({ noiseDb: 0 }).noiseDb).to.equal(-20)
      expect(chapterSnap.parseOptions({ noiseDb: -200 }).noiseDb).to.equal(-80)
      expect(chapterSnap.parseOptions({ minSilenceSec: 0 }).minSilenceSec).to.equal(0.2)
      expect(chapterSnap.parseOptions({ minSilenceSec: 10 }).minSilenceSec).to.equal(5)
      expect(chapterSnap.parseOptions({ leadSec: 5 }).leadSec).to.equal(1)
      expect(chapterSnap.parseOptions({ leadSec: -1 }).leadSec).to.equal(0)
      expect(chapterSnap.parseOptions({ headingLookbackSec: 10 }).headingLookbackSec).to.equal(6)
      expect(chapterSnap.parseOptions({ headingLookbackSec: -1 }).headingLookbackSec).to.equal(0)
      expect(chapterSnap.parseOptions({ headingLookbackSec: 0 }).headingLookbackSec).to.equal(0)
      expect(chapterSnap.parseOptions({ windowSec: 10, snapToFileStart: true })).to.deep.equal({ ...DEFAULT_OPTIONS, windowSec: 10, snapToFileStart: true })
    })

    it('rejects present fields that are not finite numbers', () => {
      for (const bad of ['10', null, NaN, Infinity, -Infinity, {}, [], true]) {
        expect(() => chapterSnap.parseOptions({ windowSec: bad }), String(bad)).to.throw(SnapInputError)
      }
      expect(() => chapterSnap.parseOptions({ noiseDb: '-38dB' })).to.throw(SnapInputError)
    })

    it('rejects verify:true, a non-boolean snapToFileStart and a non-object', () => {
      expect(() => chapterSnap.parseOptions({ verify: true })).to.throw(SnapInputError, 'verify not implemented')
      expect(chapterSnap.parseOptions({ verify: false })).to.deep.equal(DEFAULT_OPTIONS)
      expect(() => chapterSnap.parseOptions({ snapToFileStart: 'yes' })).to.throw(SnapInputError)
      expect(() => chapterSnap.parseOptions({ snapToFileStart: 1 })).to.throw(SnapInputError)
      expect(() => chapterSnap.parseOptions('fast')).to.throw(SnapInputError)
      expect(() => chapterSnap.parseOptions([1])).to.throw(SnapInputError)
    })

    it('ignores unknown keys', () => {
      expect(chapterSnap.parseOptions({ path: '/etc/passwd', foo: 1 })).to.deep.equal(DEFAULT_OPTIONS)
    })
  })

  describe('validateChapters / validateIndexes', () => {
    const T = 1000

    function expectIndexError(chapters, index) {
      try {
        chapterSnap.validateChapters(chapters, T)
        expect.fail('expected an error')
      } catch (error) {
        expect(error).to.be.instanceOf(SnapInputError)
        expect(error.index).to.equal(index)
      }
    }

    it('rejects bad arrays', () => {
      expect(() => chapterSnap.validateChapters('x', T)).to.throw(SnapInputError)
      expect(() => chapterSnap.validateChapters({ 0: { start: 0 } }, T)).to.throw(SnapInputError)
      expect(() => chapterSnap.validateChapters([], T)).to.throw(SnapInputError)
      const tooMany = Array.from({ length: 1001 }, (_, i) => ({ start: i * 0.5 }))
      expect(() => chapterSnap.validateChapters(tooMany, T)).to.throw(SnapInputError, 'Too many')
      const max = Array.from({ length: 1000 }, (_, i) => ({ start: i * 0.5 }))
      expect(chapterSnap.validateChapters(max, T)).to.have.length(1000)
    })

    it('rejects bad starts with the index', () => {
      expectIndexError([{ start: 0 }, { start: NaN }], 1)
      expectIndexError([{ start: 0 }, { start: Infinity }], 1)
      expectIndexError([{ start: 0 }, { start: '10' }], 1)
      expectIndexError([{ start: -1 }], 0)
      expectIndexError([{ start: 0 }, { start: 1000 }], 1)
      expectIndexError([{ start: 0 }, { start: 10 }, { start: 10 }], 2)
      expectIndexError([{ start: 0 }, { start: 10 }, { start: 5 }], 2)
      expectIndexError([{ start: 0 }, null], 1)
    })

    it('rejects bad titles', () => {
      expectIndexError([{ start: 0, title: 5 }], 0)
      expectIndexError([{ start: 0 }, { start: 1, title: 'x'.repeat(1001) }], 1)
      expect(chapterSnap.validateChapters([{ start: 0, title: 'x'.repeat(1000) }], T)[0].title).to.have.length(1000)
    })

    it('accepts the media.chapters shape and echoes id/title', () => {
      const chapters = [
        { id: 0, title: 'Opening Credits', start: 0, end: 41.87 },
        { id: 1, title: 'Chapter 1', start: 41.87, end: 900 }
      ]
      expect(chapterSnap.validateChapters(chapters, T)).to.deep.equal([
        { id: 0, title: 'Opening Credits', start: 0 },
        { id: 1, title: 'Chapter 1', start: 41.87 }
      ])
      expect(chapterSnap.validateChapters([{ start: 0 }], T)).to.deep.equal([{ id: 0, title: undefined, start: 0 }])
    })

    it('validates indexes', () => {
      expect(chapterSnap.validateIndexes(undefined, 3)).to.equal(null)
      expect([...chapterSnap.validateIndexes([2, 0], 3)]).to.deep.equal([2, 0])
      expect(() => chapterSnap.validateIndexes([1, 1], 3)).to.throw(SnapInputError)
      expect(() => chapterSnap.validateIndexes([3], 3)).to.throw(SnapInputError)
      expect(() => chapterSnap.validateIndexes([-1], 3)).to.throw(SnapInputError)
      expect(() => chapterSnap.validateIndexes([1.5], 3)).to.throw(SnapInputError)
      expect(() => chapterSnap.validateIndexes(['1'], 3)).to.throw(SnapInputError)
      expect(() => chapterSnap.validateIndexes([0, 1, 2, 0], 3)).to.throw(SnapInputError)
      expect(() => chapterSnap.validateIndexes('1', 3)).to.throw(SnapInputError)
    })
  })

  describe('buildTimeline', () => {
    function getTracklistOffsets(audioFiles) {
      // Same as Book.getTracklist over includedAudioFiles
      let startOffset = 0
      return audioFiles
        .filter((af) => !af.exclude)
        .map((af) => {
          const offset = startOffset
          startOffset += af.duration
          return offset
        })
    }

    it('matches getTracklist offsets for 1 and 10 files', () => {
      const one = [{ duration: 98765.432, metadata: { path: '/b/book.m4b' } }]
      expect(chapterSnap.buildTimeline(one)).to.deep.equal([{ index: 0, path: '/b/book.m4b', offset: 0, duration: 98765.432 }])

      const ten = Array.from({ length: 10 }, (_, i) => ({ duration: 600 + i * 1.1, metadata: { path: `/b/${i}.mp3` } }))
      const timeline = chapterSnap.buildTimeline(ten)
      expect(timeline.map((t) => t.offset)).to.deep.equal(getTracklistOffsets(ten))
      expect(timeline[9].path).to.equal('/b/9.mp3')
      expect(chapterSnap.computeDuration(timeline, undefined)).to.be.closeTo(
        ten.reduce((s, af) => s + af.duration, 0),
        1e-9
      )
      expect(chapterSnap.computeDuration(timeline, 1000)).to.equal(1000)
    })

    it('skips excluded files', () => {
      const files = [
        { duration: 100, metadata: { path: '/a' } },
        { duration: 50, exclude: true, metadata: { path: '/x' } },
        { duration: 200, metadata: { path: '/b' } }
      ]
      const timeline = chapterSnap.buildTimeline(files)
      expect(timeline.map((t) => [t.index, t.path, t.offset])).to.deep.equal([
        [0, '/a', 0],
        [1, '/b', 100]
      ])
      expect(timeline.map((t) => t.offset)).to.deep.equal(getTracklistOffsets(files))
    })
  })

  describe('planSegments', () => {
    const big = [track(0, 0, 36000)]

    it('gives chapter 0 no window', () => {
      const plan = chapterSnap.planSegments([0, 5000], null, big, 36000, opts())
      expect(plan.windows[0]).to.equal(null)
      expect(plan.chapterSegments[0]).to.deep.equal([])
      expect(plan.segments).to.have.length(1)
      expect(plan.segments[0].localStart).to.be.closeTo(5000 - 25 - 3.5 - 3, 1e-9)
      expect(plan.segments[0].localDur).to.be.closeTo(25 + 3.5 + 3 + 25 + 1, 1e-9)
      expect(plan.chapterSegments[1]).to.deep.equal([0])
    })

    it('reaches headingLookbackSec further back, and not with the look-back off', () => {
      const plan = chapterSnap.planSegments([0, 5000], null, big, 36000, opts({ windowSec: 2, headingLookbackSec: 6 }))
      expect(plan.windows[1][0]).to.be.closeTo(5000 - 2 - 3.5 - 6, 1e-9)
      expect(plan.segments[0].localStart).to.be.closeTo(5000 - 11.5, 1e-9)
      const off = chapterSnap.planSegments([0, 5000], null, big, 36000, opts({ windowSec: 2, headingLookbackSec: 0 }))
      expect(off.windows[1]).to.deep.equal([5000 - 5.5, 5000 + 3])
    })

    it('skips chapters not in indexes', () => {
      const plan = chapterSnap.planSegments([0, 5000, 9000], new Set([2]), big, 36000, opts())
      expect(plan.segments).to.have.length(1)
      expect(plan.chapterSegments[1]).to.deep.equal([])
      expect(plan.chapterSegments[2]).to.deep.equal([0])
    })

    it('merges overlapping windows and respects MAX_SPAN', () => {
      const plan = chapterSnap.planSegments([0, 1000, 1030], null, big, 36000, opts())
      expect(plan.segments).to.have.length(1)
      expect(plan.chapterSegments[1]).to.deep.equal([0])
      expect(plan.chapterSegments[2]).to.deep.equal([0])

      // A chain of overlapping windows every 40 s would merge forever without MAX_SPAN
      const starts = [0]
      for (let t = 1000; t < 3000; t += 40) starts.push(t)
      const chain = chapterSnap.planSegments(starts, null, big, 36000, opts())
      expect(chain.segments.length).to.be.greaterThan(1)
      for (const seg of chain.segments) expect(seg.localDur).to.be.at.most(chapterSnap.MAX_SPAN + 1e-9)
      starts.forEach((_, i) => {
        if (i > 0) expect(chain.chapterSegments[i].length).to.be.greaterThan(0)
      })
    })

    it('splits a window that crosses a file boundary', () => {
      const timeline = [track(0, 0, 2000), track(1, 2000, 2000)]
      const plan = chapterSnap.planSegments([0, 2010], null, timeline, 4000, opts())
      expect(plan.segments).to.have.length(2)
      const [a, b] = plan.segments
      expect(a.trackIndex).to.equal(0)
      expect(a.localStart).to.be.closeTo(2010 - 31.5, 1e-9)
      expect(a.localDur).to.be.closeTo(21.5, 1e-9)
      expect(a.reachesFileEnd).to.equal(true)
      expect(b.trackIndex).to.equal(1)
      expect(b.localStart).to.equal(0)
      expect(b.localDur).to.be.closeTo(36, 1e-9)
      expect(b.reachesFileEnd).to.equal(false)
      expect(plan.chapterSegments[1]).to.deep.equal([0, 1])
    })

    it('uses one whole-file segment for files of 900 s or less', () => {
      const timeline = [track(0, 0, 900), track(1, 900, 901)]
      const plan = chapterSnap.planSegments([0, 450, 1300], null, timeline, 1801, opts())
      expect(plan.segments).to.have.length(2)
      expect(plan.segments[0]).to.include({ trackIndex: 0, localStart: 0, localDur: 900, wholeFile: true, reachesFileEnd: true })
      expect(plan.segments[1].wholeFile).to.equal(false)
    })

    it('keeps segments within [0, file.duration] and drops slivers', () => {
      const timeline = [track(0, 0, 1000), track(1, 1000, 1000.3), track(2, 2000.3, 1000)]
      const starts = [0, 5, 1990, 2990]
      const plan = chapterSnap.planSegments(starts, null, timeline, 3000.3, opts({ minSilenceSec: 0.7 }))
      for (const seg of plan.segments) {
        const t = timeline[seg.trackIndex]
        expect(seg.localStart).to.be.at.least(0)
        expect(seg.localStart + seg.localDur).to.be.at.most(t.duration + 1e-9)
        expect(seg.localDur).to.be.at.least(seg.detectMinSilenceSec)
        expect(seg.detectMinSilenceSec).to.equal(seg.touchesJoint ? chapterSnap.JOINT_MIN_SILENCE : 0.7)
      }
    })

    it('keeps a short piece at a file joint and detects joint segments with a low d', () => {
      // The window of a chapter at 3574.5 reaches only 0.5 s into part 1, less than minSilenceSec
      const timeline = [track(0, 0, 3600), track(1, 3600, 3600), track(2, 7200, 3600)]
      const plan = chapterSnap.planSegments([0, 3574.5], null, timeline, 10800, opts())
      expect(plan.segments).to.have.length(2)
      const [tail, head] = plan.segments
      expect(tail).to.include({ trackIndex: 0, reachesFileEnd: true, touchesJoint: true, detectMinSilenceSec: chapterSnap.JOINT_MIN_SILENCE })
      expect(head).to.include({ trackIndex: 1, localStart: 0, touchesJoint: true, detectMinSilenceSec: chapterSnap.JOINT_MIN_SILENCE })
      expect(head.localDur).to.be.closeTo(0.5, 1e-9)
      expect(plan.chapterSegments[1]).to.deep.equal([0, 1])

      // A piece away from any joint keeps the requested d
      const inner = chapterSnap.planSegments([0, 5000], null, timeline, 10800, opts())
      expect(inner.segments[0]).to.include({ touchesJoint: false, detectMinSilenceSec: 0.7 })

      // The first file's head and the last file's tail are not joints
      const edges = chapterSnap.planSegments([0, 10790], null, timeline, 10800, opts())
      expect(edges.segments[0]).to.include({ trackIndex: 2, reachesFileEnd: true, touchesJoint: false, detectMinSilenceSec: 0.7 })

      // A requested d below the joint d is used as is
      const lowD = chapterSnap.planSegments([0, 3574.5], null, timeline, 10800, opts({ minSilenceSec: 0.05 }))
      expect(lowD.segments[0].detectMinSilenceSec).to.equal(0.05)
    })

    it('rejects plans over the budget', () => {
      const starts = Array.from({ length: 200 }, (_, i) => i * 200)
      expect(() => chapterSnap.planSegments(starts, null, [track(0, 0, 50000)], 50000, opts({ windowSec: 60 }))).to.throw(SnapInputError, 'Too much audio')
    })
  })

  describe('parseSilencedetect', () => {
    const seg = { localStart: 100, localDur: 60, reachesFileEnd: false }

    it('parses real stderr fixtures', () => {
      const pauses = chapterSnap.parseSilencedetect(STDERR_FIXTURE, seg)
      expect(pauses).to.deep.equal([
        { start: 12.3456, end: 14.5678, startClipped: false, endClipped: false },
        { start: 30.1, end: 30.95, startClipped: false, endClipped: false }
      ])
    })

    it('clamps a negative start and marks it clipped only past the file start', () => {
      const lines = ['[silencedetect @ 0x1] silence_start: -0.0213333', '[silencedetect @ 0x1] silence_end: 1.5 | silence_duration: 1.52']
      expect(chapterSnap.parseSilencedetect(lines, seg)[0]).to.deep.equal({ start: 0, end: 1.5, startClipped: true, endClipped: false })
      expect(chapterSnap.parseSilencedetect(lines, { ...seg, localStart: 0 })[0].startClipped).to.equal(false)
    })

    it('closes an unterminated start at the segment length', () => {
      const lines = ['[silencedetect @ 0x1] silence_start: 58.2']
      expect(chapterSnap.parseSilencedetect(lines, seg)).to.deep.equal([{ start: 58.2, end: 60, startClipped: false, endClipped: true }])
      expect(chapterSnap.parseSilencedetect(lines, { ...seg, reachesFileEnd: true })[0].endClipped).to.equal(false)
    })

    it('marks an end at the segment end as clipped unless at end of file', () => {
      const lines = ['[silencedetect @ 0x1] silence_start: 58.2', '[silencedetect @ 0x1] silence_end: 60 | silence_duration: 1.8']
      expect(chapterSnap.parseSilencedetect(lines, seg)[0].endClipped).to.equal(true)
      expect(chapterSnap.parseSilencedetect(lines, { ...seg, reachesFileEnd: true })[0].endClipped).to.equal(false)
    })

    it('ignores an end without a start', () => {
      const lines = ['[silencedetect @ 0x1] silence_end: 3.2 | silence_duration: 1.0', '[silencedetect @ 0x1] silence_start: 10', '[silencedetect @ 0x1] silence_end: 11 | silence_duration: 1']
      expect(chapterSnap.parseSilencedetect(lines, seg)).to.deep.equal([{ start: 10, end: 11, startClipped: false, endClipped: false }])
    })
  })

  describe('toBookPauses', () => {
    it('applies offset and localStart and merges padded overlaps', () => {
      const timeline = [track(0, 0, 1000), track(1, 1000, 5000)]
      const seg1 = { trackIndex: 1, localStart: 200, localDur: 60 }
      const seg2 = { trackIndex: 1, localStart: 250, localDur: 60 }
      const pauses = chapterSnap.toBookPauses(
        [
          { seg: seg1, pauses: [{ start: 55, end: 60, startClipped: false, endClipped: true }] },
          { seg: seg2, pauses: [{ start: 5, end: 12, startClipped: false, endClipped: false }] }
        ],
        timeline
      )
      expect(pauses).to.have.length(1)
      expect(pauses[0]).to.deep.equal({ start: 1255, end: 1262, startClipped: false, endClipped: false, crossesFileBoundary: false })
    })

    it('joins tail silence with head silence across a file joint', () => {
      const timeline = [track(0, 0, 600), track(1, 600, 600)]
      const tail = { seg: { trackIndex: 0, localStart: 0, localDur: 600, reachesFileEnd: true }, pauses: [{ start: 598.9, end: 600, startClipped: false, endClipped: false }] }
      const head = { seg: { trackIndex: 1, localStart: 0, localDur: 600, reachesFileEnd: true }, pauses: [{ start: 0, end: 0.8, startClipped: false, endClipped: false }] }
      const pauses = chapterSnap.toBookPauses([tail, head], timeline)
      expect(pauses).to.have.length(1)
      expect(pauses[0].start).to.be.closeTo(598.9, 1e-9)
      expect(pauses[0].end).to.be.closeTo(600.8, 1e-9)
      expect(pauses[0].crossesFileBoundary).to.equal(true)

      const result = chapterSnap.snapOne({ index: 1, t: 600.0, pauses, timeline, options: opts(), bounds: chapterSnap.boundsFor([0, 600, 1100], 1, 1200) })
      expect(result.reason).to.equal(REASONS.INSIDE_PAUSE)
      expect(result.proposedStart).to.equal(600)
    })

    it('joins two halves each shorter than minSilenceSec into one pause at the joint', () => {
      // Part 0 ends with 0.45 s of silence, part 1 starts with 0.5 s: a real 0.95 s pause on the joint at 3600
      const timeline = [track(0, 0, 3600), track(1, 3600, 3600)]
      const tail = { seg: { trackIndex: 0, localStart: 3571.5, localDur: 28.5, reachesFileEnd: true }, pauses: [pause(28.05, 28.5)] }
      const head = { seg: { trackIndex: 1, localStart: 0, localDur: 26, reachesFileEnd: false }, pauses: [pause(0, 0.5), pause(9.5, 12)] }
      const pauses = chapterSnap.toBookPauses([tail, head], timeline, 0.7)
      expect(pauses).to.have.length(2)
      expect(pauses[0].start).to.be.closeTo(3599.55, 1e-9)
      expect(pauses[0].end).to.be.closeTo(3600.5, 1e-9)
      expect(pauses[0].crossesFileBoundary).to.equal(true)

      const result = chapterSnap.snapOne({ index: 1, t: 3600, pauses, timeline, options: opts(), bounds: chapterSnap.boundsFor([0, 3600, 5000], 1, 7200) })
      expect(result.reason).to.equal(REASONS.INSIDE_PAUSE)
      expect(result.proposedStart).to.equal(3600)
      expect(chapterSnap.confidenceFor(result)).to.equal('medium')
    })

    it('drops short pauses away from a joint and short joint halves that join nothing', () => {
      const timeline = [track(0, 0, 3600), track(1, 3600, 3600)]
      const tail = { seg: { trackIndex: 0, localStart: 3500, localDur: 100, reachesFileEnd: true }, pauses: [pause(50, 50.4), pause(60, 61), pause(99.6, 100)] }
      const head = { seg: { trackIndex: 1, localStart: 0, localDur: 30, reachesFileEnd: false }, pauses: [pause(5, 5.3)] }
      const pauses = chapterSnap.toBookPauses([tail, head], timeline, 0.7)
      expect(pauses.map((p) => [p.start, p.end])).to.deep.equal([[3560, 3561]])
      // Without minSilenceSec nothing is filtered
      expect(chapterSnap.toBookPauses([tail, head], timeline)).to.have.length(4)
    })
  })

  describe('snapOne', () => {
    it('inside-pause uses SLACK at both edges', () => {
      const p = [pause(100, 102)]
      expect(snap(99.7, p).reason).to.equal(REASONS.INSIDE_PAUSE)
      expect(snap(99.7, p).proposedStart).to.equal(99.7)
      expect(snap(102.3, p).reason).to.equal(REASONS.INSIDE_PAUSE)
      expect(snap(102.31, p).reason).to.equal(REASONS.NEAREST_LONGEST_PAUSE)
      expect(snap(102.31, p).proposedStart).to.equal(101.75)
    })

    it('a long far pause beats a short near pause', () => {
      // short: |102-100| - 4*0.8 = -1.2 ; long: |110-100| - 4*3 = -2
      const r = snap(100, [pause(101.2, 102), pause(107, 110)])
      expect(r.proposedStart).to.equal(109.75)
      expect(r.pause.end).to.equal(110)
      expect(r.alternatives.map((a) => a.pause.end)).to.deep.equal([102])
    })

    it('caps the length bonus at BONUS_CAP', () => {
      expect(chapterSnap.pauseScore(pause(100, 105), 110)).to.equal(chapterSnap.pauseScore(pause(102, 105), 110))
    })

    it('breaks an exact tie toward the earlier pause', () => {
      // both score 0: |33-45|-12 and |57-45|-12
      expect(snap(45, [pause(30, 33), pause(52, 57)]).pause.end).to.equal(33)
    })

    it('includes a pause ending exactly at t+W and excludes one past it', () => {
      expect(snap(100.3, [pause(124, 125.3)]).reason).to.equal(REASONS.NEAREST_LONGEST_PAUSE)
      expect(snap(100.3, [pause(124, 125.31)]).reason).to.equal(REASONS.NO_PAUSE_IN_WINDOW)
      expect(snap(100, [pause(73, 75)]).reason).to.equal(REASONS.NEAREST_LONGEST_PAUSE)
      expect(snap(100, [pause(73, 74.99)]).reason).to.equal(REASONS.NO_PAUSE_IN_WINDOW)
    })

    it('matches analyze.snap on a golden table', () => {
      // analyze.py: sil = [(10,11),(30,33),(50,50.8),(52,57)], WINDOW=25, LEAD=0.25, SLACK=0.3
      const sil = [pause(10, 11), pause(30, 33), pause(50, 50.8), pause(52, 57)]
      const table = [
        // t, python result
        [10.5, 10.5],
        [11.3, 11.3],
        [9.7, 9.7],
        [20, 32.75],
        [45, 32.75],
        [54, 54],
        [60, 56.75],
        [47, 56.75],
        [49, 56.75],
        [100, 100]
      ]
      for (const [t, expected] of table) {
        expect(snap(t, sil).proposedStart, `t=${t}`).to.be.closeTo(expected, 1e-9)
      }
    })

    it('starts leadSec before the pause end, never before the pause or 0', () => {
      expect(snap(100, [pause(104, 106)]).proposedStart).to.equal(105.75)
      expect(snap(100, [pause(104, 106)], { options: { leadSec: 1 } }).proposedStart).to.equal(105)
      expect(snap(100, [pause(105.5, 106)], { options: { leadSec: 1, minSilenceSec: 0.2 } }).proposedStart).to.equal(105.5)
      expect(snap(100, [pause(105.8, 106)], { options: { leadSec: 0.25 } }).proposedStart).to.equal(105.8)
      expect(chapterSnap.pauseTarget(pause(0, 0.1), 1)).to.equal(0)
    })

    it('ignores pauses outside the neighbour bounds and uses the next candidate', () => {
      const starts = [0, 100, 110]
      const bounds = chapterSnap.boundsFor(starts, 1, 1000)
      expect(bounds).to.deep.equal({ lo: 1, loOpen: false, hi: 109, hiOpen: false })
      // the best pause would put chapter 1 past chapter 2's original start
      const r = snap(100, [pause(95, 96), pause(112, 115)], { bounds })
      expect(r.pause.end).to.equal(96)
      expect(r.proposedStart).to.equal(95.75)

      const none = snap(100, [pause(112, 115)], { bounds })
      expect(none).to.include({ reason: REASONS.NO_PAUSE_IN_WINDOW, proposedStart: 100, pause: null })
      expect(chapterSnap.confidenceFor(none)).to.equal('none')
    })

    it('uses open bounds when the original gap is under 2*MIN_GAP', () => {
      expect(chapterSnap.boundsFor([0, 100, 101.5], 1, 1000)).to.deep.equal({ lo: 1, loOpen: false, hi: 101.5, hiOpen: true })
      expect(chapterSnap.boundsFor([0, 100, 101.5], 2, 1000)).to.deep.equal({ lo: 100, loOpen: true, hi: 999, hiOpen: false })
      expect(chapterSnap.boundsFor([0, 100], 1, 100.5)).to.deep.equal({ lo: 1, loOpen: false, hi: 100.5, hiOpen: true })
    })

    it('reports skip reasons unchanged', () => {
      for (const skipReason of [REASONS.NOT_REQUESTED, REASONS.NOT_ANALYSED, REASONS.ANALYSIS_FAILED]) {
        const r = snap(100, [pause(104, 106)], { skipReason })
        expect(r).to.include({ reason: skipReason, proposedStart: 100, pause: null })
      }
    })

    describe('heading-lookback', () => {
      // Late mark: true break 90-94.2, spoken heading 94.2-95, short pause after the heading 95-96.1, mark at 95.8
      const breakPause = pause(90, 94.2)
      const afterHeading = pause(95, 96.1)

      it('moves a late start inside the short post-heading pause back to the long pause', () => {
        const r = snap(95.8, [breakPause, afterHeading])
        expect(r).to.include({ reason: REASONS.HEADING_LOOKBACK, proposedStart: 93.95, pause: breakPause })
        expect(chapterSnap.confidenceFor(r)).to.equal('high')
      })

      it('also looks back from a nearest-longest pause', () => {
        const q = pause(88, 93)
        const p = pause(95, 98.5)
        // both lengths reach BONUS_CAP, so the nearer pause wins the score
        const r = snap(100, [q, p])
        expect(r).to.include({ reason: REASONS.HEADING_LOOKBACK, proposedStart: 92.75, pause: q })
        expect(r.lookbackFrom).to.include({ reason: REASONS.NEAREST_LONGEST_PAUSE, proposedStart: 98.25, pause: p })
      })

      it('does not move a correct start inside the long pause to an earlier, shorter pause', () => {
        const r = snap(93, [pause(88, 89), pause(90.5, 94.2)])
        expect(r).to.include({ reason: REASONS.INSIDE_PAUSE, proposedStart: 93 })
        expect(r.pause.end).to.equal(94.2)
      })

      it('ignores a longer pause that ends more than headingLookbackSec before the chosen pause', () => {
        expect(snap(95.8, [pause(87.8, 92), afterHeading]).reason).to.equal(REASONS.HEADING_LOOKBACK)
        expect(snap(95.8, [pause(87.79, 91.99), afterHeading])).to.include({ reason: REASONS.INSIDE_PAUSE, proposedStart: 95.8 })
        expect(snap(95.8, [pause(85, 90.5), afterHeading], { options: { headingLookbackSec: 6 } }).reason).to.equal(REASONS.HEADING_LOOKBACK)
      })

      it('needs both HEADING_MIN_EXTRA more seconds and HEADING_RATIO times the length', () => {
        // 1 s chosen pause: the +0.5 s rule decides (1.5 > 1.3)
        const short = pause(95, 96)
        expect(snap(95.5, [pause(92, 93.5), short]).reason).to.equal(REASONS.HEADING_LOOKBACK)
        expect(snap(95.5, [pause(92.01, 93.5), short]).reason).to.equal(REASONS.INSIDE_PAUSE)
        // 2 s chosen pause: the x1.3 rule decides (2.6 > 2.5)
        const long = pause(95, 97)
        expect(snap(95.5, [pause(90.9, 93.5), long]).reason).to.equal(REASONS.HEADING_LOOKBACK)
        expect(snap(95.5, [pause(90.91, 93.5), long]).reason).to.equal(REASONS.INSIDE_PAUSE)
      })

      it('picks the longest qualifying pause', () => {
        const r = snap(95.8, [pause(88, 91), pause(92.4, 93.2), pause(93.5, 94.4), afterHeading], { options: { headingLookbackSec: 6 } })
        expect(r.pause.end).to.equal(91)
      })

      it('is off with headingLookbackSec 0', () => {
        expect(snap(95.8, [breakPause, afterHeading], { options: { headingLookbackSec: 0 } })).to.include({ reason: REASONS.INSIDE_PAUSE, proposedStart: 95.8, pause: afterHeading })
      })

      it('keeps the chosen pause when the earlier one is outside the neighbour bounds', () => {
        const bounds = chapterSnap.boundsFor([0, 93, 95.8], 2, 1000)
        expect(bounds.lo).to.equal(94)
        expect(snap(95.8, [breakPause, afterHeading], { bounds })).to.include({ reason: REASONS.INSIDE_PAUSE, proposedStart: 95.8, pause: afterHeading })
      })

      it('falls back to the chosen pause when the order pass rejects the look-back', () => {
        // chapter 1 (at 80) moves to the break pause end, so chapter 2 cannot take it too
        const starts = [0, 80, 95.8]
        const proposals = starts.map((t, i) => chapterSnap.snapOne({ index: i, t, pauses: [breakPause, afterHeading], timeline: [track(0, 0, 1000)], options: opts(), bounds: chapterSnap.boundsFor(starts, i, 1000) }))
        expect(proposals[2].reason).to.equal(REASONS.HEADING_LOOKBACK)
        chapterSnap.resolveOrder(starts, proposals)
        expect(proposals[1]).to.include({ reason: REASONS.NEAREST_LONGEST_PAUSE, proposedStart: 93.95 })
        expect(proposals[2]).to.include({ reason: REASONS.INSIDE_PAUSE, proposedStart: 95.8, pause: afterHeading })
      })
    })

    describe('file-start', () => {
      const timeline = [track(0, 0, 600), track(1, 600, 600), track(2, 1200, 600)]
      const bounds = { lo: 0, loOpen: true, hi: 1e9, hiOpen: false }
      const fs = (t, snapToFileStart, tl = timeline) => chapterSnap.snapOne({ index: 1, t, pauses: [], timeline: tl, options: opts({ snapToFileStart }), bounds })

      it('is skipped when the option is off', () => {
        expect(fs(602.5, false).reason).to.equal(REASONS.NO_PAUSE_IN_WINDOW)
      })

      it('snaps to a file start up to 4 s before the chapter', () => {
        expect(fs(602.5, true)).to.include({ reason: REASONS.FILE_START, proposedStart: 600 })
        expect(fs(604.0, true)).to.include({ reason: REASONS.FILE_START, proposedStart: 600 })
        expect(fs(604.01, true).reason).to.equal(REASONS.NO_PAUSE_IN_WINDOW)
        expect(fs(600, true).reason).to.equal(REASONS.NO_PAUSE_IN_WINDOW)
      })

      it('takes the last file when several qualify', () => {
        const tl = [track(0, 0, 600), track(1, 600, 2), track(2, 602, 600)]
        expect(fs(603, true, tl).proposedStart).to.equal(602)
      })
    })

    it('puts the first chapter at 0 and does not force later chapters under 1 s to 0', () => {
      const first = chapterSnap.snapOne({ index: 0, t: 3.2, pauses: [], timeline: [], options: opts(), bounds: WIDE })
      expect(first).to.include({ reason: REASONS.FIRST_CHAPTER, proposedStart: 0 })
      const response = chapterSnap.buildResponse({
        libraryItemId: 'li',
        T: 100,
        options: opts(),
        chapters: [{ id: 0, start: 3.2 }],
        proposals: [{ ...first, confidence: 'high' }],
        timeline: [track(0, 0, 100)],
        complete: true,
        stats: {},
        warnings: []
      })
      expect(response.chapters[0].delta).to.equal(-3.2)

      const second = chapterSnap.snapOne({ index: 1, t: 0.5, pauses: [], timeline: [], options: opts(), bounds: { lo: 0, loOpen: true, hi: 50, hiOpen: false } })
      expect(second.proposedStart).to.equal(0.5)
    })
  })

  describe('resolveOrder', () => {
    function runAll(starts, pauses, T, options = opts(), timeline = [track(0, 0, T)]) {
      const proposals = starts.map((t, i) => chapterSnap.snapOne({ index: i, t, pauses, timeline, options, bounds: chapterSnap.boundsFor(starts, i, T) }))
      return chapterSnap.resolveOrder(starts, proposals)
    }

    it('gives the second of two chapters on the same pause an alternative', () => {
      const starts = [0, 100, 110]
      const { proposals } = runAll(starts, [pause(104, 106), pause(114, 114.9)], 1000)
      expect(proposals[1].proposedStart).to.equal(105.75)
      expect(proposals[2]).to.include({ reason: REASONS.NEAREST_LONGEST_PAUSE, proposedStart: 114.65 })
    })

    it('reverts with order-conflict when no alternative fits', () => {
      const starts = [0, 100, 110]
      const { proposals } = runAll(starts, [pause(104, 106)], 1000)
      expect(proposals[1].proposedStart).to.equal(105.75)
      expect(proposals[2]).to.include({ reason: REASONS.ORDER_CONFLICT, proposedStart: 110 })
      expect(proposals[2].pause.end).to.equal(106)
      expect(chapterSnap.confidenceFor(proposals[2])).to.equal('none')
    })

    it('keeps output strictly increasing and inside the original bounds (property test)', () => {
      let seed = 12345
      const rand = () => {
        seed = (seed * 1103515245 + 12345) % 2147483648
        return seed / 2147483648
      }
      for (let iter = 0; iter < 1000; iter++) {
        const T = 200 + rand() * 5000
        const n = 1 + Math.floor(rand() * 25)
        const starts = []
        let t = rand() * 5
        for (let i = 0; i < n && t < T; i++) {
          starts.push(Math.round(t * 1000) / 1000)
          t += 0.002 + rand() * (rand() < 0.3 ? 3 : 300)
        }
        const pauses = []
        let p = 0
        while (p < T) {
          p += rand() * 60
          const len = 0.2 + rand() * 6
          if (p + len < T) pauses.push(pause(p, p + len, { endClipped: rand() < 0.1 }))
          p += len
        }
        const options = opts({ windowSec: 2 + rand() * 58, leadSec: rand(), headingLookbackSec: rand() < 0.2 ? 0 : rand() * 6, snapToFileStart: rand() < 0.5 })
        const timeline = [track(0, 0, T / 3), track(1, T / 3, T / 3), track(2, (2 * T) / 3, T / 3)]
        const { proposals, fallback } = runAll(starts, pauses, T, options, timeline)

        expect(fallback).to.equal(false)
        expect(proposals).to.have.length(starts.length)
        expect(proposals[0].proposedStart).to.equal(0)
        for (let i = 0; i < proposals.length; i++) {
          const x = proposals[i].proposedStart
          expect(proposals[i].index).to.equal(i)
          expect(x).to.be.below(T)
          if (i > 0) {
            expect(x, `iter ${iter} i ${i}`).to.be.above(proposals[i - 1].proposedStart)
            expect(x).to.be.above(starts[i - 1] - 0.0005)
          }
          if (i + 1 < starts.length) expect(x).to.be.below(starts[i + 1] + 0.0005)
        }
      }
    })
  })

  describe('confidenceFor', () => {
    const c = (reason, p, originalStart, proposedStart) => chapterSnap.confidenceFor({ reason, pause: p, originalStart, proposedStart })

    it('covers each tier boundary', () => {
      expect(c(REASONS.FIRST_CHAPTER, null, 3, 0)).to.equal('high')
      expect(c(REASONS.FILE_START, null, 602, 600)).to.equal('high')
      expect(c(REASONS.NO_PAUSE_IN_WINDOW, null, 10, 10)).to.equal('none')
      expect(c(REASONS.NOT_REQUESTED, null, 10, 10)).to.equal('none')

      expect(c(REASONS.INSIDE_PAUSE, pause(10, 11.2), 10.5, 10.5)).to.equal('high')
      expect(c(REASONS.INSIDE_PAUSE, pause(10, 11.19), 10.5, 10.5)).to.equal('medium')
      expect(c(REASONS.INSIDE_PAUSE, pause(10, 10.9), 10.5, 10.5)).to.equal('medium')
      expect(c(REASONS.INSIDE_PAUSE, pause(10, 10.89), 10.5, 10.5)).to.equal('low')

      expect(c(REASONS.NEAREST_LONGEST_PAUSE, pause(10, 11.2), 16, 11)).to.equal('high')
      expect(c(REASONS.NEAREST_LONGEST_PAUSE, pause(10, 11.2), 16.01, 11)).to.equal('medium')
      expect(c(REASONS.NEAREST_LONGEST_PAUSE, pause(10, 11.19), 12, 11)).to.equal('medium')
      expect(c(REASONS.NEAREST_LONGEST_PAUSE, pause(10, 10.89), 12, 10.64)).to.equal('low')
      expect(c(REASONS.NEAREST_LONGEST_PAUSE, pause(10, 13), 26, 11)).to.equal('medium')
      expect(c(REASONS.NEAREST_LONGEST_PAUSE, pause(10, 13), 26.01, 11)).to.equal('low')
      expect(c(REASONS.NEAREST_LONGEST_PAUSE, pause(10, 13, { endClipped: true }), 13, 12.75)).to.equal('low')
      expect(c(REASONS.NEAREST_LONGEST_PAUSE, pause(10, 12, { startClipped: true }), 13, 11.75)).to.equal('low')
      expect(c(REASONS.NEAREST_LONGEST_PAUSE, pause(10, 13.5, { startClipped: true }), 14, 13.25)).to.equal('high')
    })

    it('only lowers confidence', () => {
      expect(chapterSnap.lowerConfidence('high', 'low')).to.equal('low')
      expect(chapterSnap.lowerConfidence('low', 'high')).to.equal('low')
      expect(chapterSnap.lowerConfidence('medium', 'bogus')).to.equal('medium')
    })
  })

  describe('buildResponse', () => {
    it('builds proposedChapters that pass the updateMediaChapters payload check', () => {
      const chapters = [
        { id: 0, title: 'Opening', start: 0 },
        { id: 1, title: '', start: 41.87 },
        { id: 2, title: undefined, start: 900 }
      ]
      const proposals = [
        { index: 0, originalStart: 0, proposedStart: 0, reason: REASONS.FIRST_CHAPTER, pause: null, confidence: 'high' },
        { index: 1, originalStart: 41.87, proposedStart: 39.6200004, reason: REASONS.NEAREST_LONGEST_PAUSE, pause: pause(38.1, 39.8700004), confidence: 'high' },
        { index: 2, originalStart: 900, proposedStart: 900, reason: REASONS.NO_PAUSE_IN_WINDOW, pause: null, confidence: 'none' }
      ]
      const response = chapterSnap.buildResponse({
        libraryItemId: 'li-1',
        T: 1234.56789,
        options: opts(),
        chapters,
        itemChapters: [{ title: 'Opening' }, { title: 'Item Chapter One' }],
        proposals,
        timeline: [track(0, 0, 600), track(1, 600, 634.56789)],
        complete: true,
        stats: { segments: 1, ffmpegCalls: 1, failedSegments: 0, analysedSec: 58.5, pausesFound: 3, elapsedMs: 5 },
        warnings: []
      })

      const chapterPayloadInvalid = (c) => !c.title || typeof c.title !== 'string' || c.start === undefined || typeof c.start !== 'number' || c.end === undefined || typeof c.end !== 'number'
      expect(response.proposedChapters.some(chapterPayloadInvalid)).to.equal(false)
      expect(response.proposedChapters).to.deep.equal([
        { id: 0, title: 'Opening', start: 0, end: 39.62 },
        { id: 1, title: 'Item Chapter One', start: 39.62, end: 900 },
        { id: 2, title: 'Chapter 3', start: 900, end: 1234.568 }
      ])
      expect(response.duration).to.equal(1234.568)
      expect(response.chapters[1]).to.deep.equal({
        index: 1,
        id: 1,
        title: 'Item Chapter One',
        originalStart: 41.87,
        proposedStart: 39.62,
        delta: -2.25,
        changed: true,
        pause: { start: 38.1, end: 39.87, duration: 1.77, startClipped: false, endClipped: false, crossesFileBoundary: false },
        reason: REASONS.NEAREST_LONGEST_PAUSE,
        confidence: 'high',
        trackIndex: 0,
        speech: null
      })
      expect(response.chapters[2].trackIndex).to.equal(1)
      expect(response.stats).to.include({ moved: 1, unchanged: 2, skipped: 0 })
      expect(response.options).to.deep.equal(DEFAULT_OPTIONS)
    })
  })
})
