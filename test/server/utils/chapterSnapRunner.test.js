const { expect } = require('chai')
const sinon = require('sinon')

const Logger = require('../../../server/Logger')
const chapterSnap = require('../../../server/utils/chapterSnap')
const chapterSnapRunner = require('../../../server/utils/chapterSnapRunner')
const { REASONS } = chapterSnap

// Book: four 1000 s files. Chapters every 500 s; each has a 2 s pause ending 3 s after it.
const TRACK_SEC = 1000
const timeline = chapterSnap.buildTimeline([0, 1, 2, 3].map((i) => ({ duration: TRACK_SEC, metadata: { path: `/books/b/part${i}.mp3` } })))
const T = TRACK_SEC * 4
const chapterStarts = [0, 500, 1500, 2500, 3500]
const chapters = chapterStarts.map((start, i) => ({ id: i, title: `Chapter ${i}`, start }))
const bookPauses = chapterStarts.slice(1).map((t) => [t + 1, t + 3])

/**
 * Fake ffmpeg: answers with silencedetect lines for the book pauses that fall inside the requested window
 */
function linesFor({ path, startSec, durationSec }) {
  const track = timeline.find((t) => t.path === path)
  const lines = []
  for (const [s, e] of bookPauses) {
    const ls = s - track.offset - startSec
    const le = e - track.offset - startSec
    if (le <= 0 || ls >= durationSec) continue
    lines.push(`[silencedetect @ 0x1] silence_start: ${ls.toFixed(4)}`)
    lines.push(`[silencedetect @ 0x1] silence_end: ${le.toFixed(4)} | silence_duration: ${(le - ls).toFixed(4)}`)
  }
  return lines
}

function run(overrides = {}) {
  return chapterSnapRunner.runSnap({
    libraryItemId: 'li-1',
    timeline,
    T,
    chapters,
    indexes: null,
    options: { ...chapterSnap.DEFAULT_OPTIONS },
    detect: async (params) => ({ lines: linesFor(params) }),
    ...overrides
  })
}

describe('chapterSnapRunner', () => {
  beforeEach(() => {
    sinon.stub(Logger, 'info')
    sinon.stub(Logger, 'warn')
    sinon.stub(Logger, 'error')
  })

  afterEach(() => {
    sinon.restore()
    chapterSnapRunner._runningJobs.clear()
  })

  it('snaps every chapter to its pause', async () => {
    const result = await run()
    expect(result.complete).to.equal(true)
    expect(result.chapters.map((c) => c.proposedStart)).to.deep.equal([0, 502.75, 1502.75, 2502.75, 3502.75])
    expect(result.chapters.slice(1).every((c) => c.reason === REASONS.NEAREST_LONGEST_PAUSE && c.confidence === 'high')).to.equal(true)
    expect(result.chapters.map((c) => c.trackIndex)).to.deep.equal([0, 0, 1, 2, 3])
    expect(result.stats).to.include({ segments: 4, ffmpegCalls: 4, failedSegments: 0, pausesFound: 4, moved: 4, unchanged: 1, skipped: 0 })
    expect(result.proposedChapters[4].end).to.equal(T)
  })

  it('never runs more than POOL detects at once', async () => {
    let active = 0
    let peak = 0
    const many = Array.from({ length: 60 }, (_, i) => ({ id: i, start: i * 60 }))
    const result = await run({
      chapters: many,
      pool: 3,
      detect: async (params) => {
        active++
        peak = Math.max(peak, active)
        await new Promise((resolve) => setTimeout(resolve, 2))
        active--
        return { lines: linesFor(params) }
      }
    })
    expect(result.stats.ffmpegCalls).to.be.greaterThan(3)
    expect(peak).to.be.at.most(3)
    expect(chapterSnapRunner.POOL).to.be.within(1, 3)
  })

  it('stops starting segments after the deadline and marks chapters not-analysed', async () => {
    let clock = 0
    const result = await run({
      pool: 1,
      deadlineMs: 1000,
      now: () => clock,
      detect: async (params) => {
        clock += 600
        return { lines: linesFor(params) }
      }
    })
    expect(result.complete).to.equal(false)
    expect(result.stats.ffmpegCalls).to.equal(2)
    const reasons = result.chapters.map((c) => c.reason)
    expect(reasons.slice(0, 2)).to.deep.equal([REASONS.FIRST_CHAPTER, REASONS.NEAREST_LONGEST_PAUSE])
    expect(reasons.slice(3)).to.deep.equal([REASONS.NOT_ANALYSED, REASONS.NOT_ANALYSED])
    expect(result.chapters[4]).to.include({ proposedStart: 3500, changed: false, confidence: 'none' })
    expect(result.warnings.some((w) => w.includes('not analysed'))).to.equal(true)
    expect(result.stats.skipped).to.equal(2)
  })

  it('marks only the failed segment chapters as analysis-failed', async () => {
    const result = await run({
      detect: async (params) => {
        if (params.path.endsWith('part2.mp3')) throw new Error('ffmpeg exited with code 1')
        return { lines: linesFor(params) }
      }
    })
    expect(result.complete).to.equal(false)
    expect(result.stats.failedSegments).to.equal(1)
    expect(result.chapters[3]).to.include({ reason: REASONS.ANALYSIS_FAILED, proposedStart: 2500, changed: false })
    expect(result.chapters[2].reason).to.equal(REASONS.NEAREST_LONGEST_PAUSE)
    expect(result.chapters[4].reason).to.equal(REASONS.NEAREST_LONGEST_PAUSE)
    expect(result.warnings).to.have.length(1)
    expect(result.warnings[0]).to.include('track 2')
    expect(result.warnings[0]).to.not.include('/books')
  })

  it('does not echo ffmpeg error text to the client, but logs it', async () => {
    const ffmpegMessage = 'ffmpeg exited with code 1: file:/mnt/nas/secret/part2.mp3: No such file or directory'
    const result = await run({
      detect: async (params) => {
        if (params.path.endsWith('part2.mp3')) throw new Error(ffmpegMessage)
        return { lines: linesFor(params) }
      }
    })
    expect(result.warnings).to.have.length(1)
    expect(result.warnings[0]).to.match(/^Silence detection failed for track 2 at [0-9.]+s$/)
    expect(JSON.stringify(result)).to.not.include('/mnt/nas')
    expect(JSON.stringify(result)).to.not.include('No such file')
    expect(Logger.warn.calledWithMatch(sinon.match('No such file or directory'))).to.equal(true)
  })

  it('throws ALL_FAILED when every segment fails', async () => {
    try {
      await run({ detect: async () => Promise.reject(new Error('spawn ffmpeg ENOENT')) })
      expect.fail('expected ALL_FAILED')
    } catch (error) {
      expect(error.code).to.equal('ALL_FAILED')
    }
  })

  it('honours indexes', async () => {
    const result = await run({ indexes: new Set([2]) })
    expect(result.stats.segments).to.equal(1)
    expect(result.chapters.map((c) => c.reason)).to.deep.equal([REASONS.FIRST_CHAPTER, REASONS.NOT_REQUESTED, REASONS.NEAREST_LONGEST_PAUSE, REASONS.NOT_REQUESTED, REASONS.NOT_REQUESTED])
  })

  it('stops on abort, kills running detects and rejects', async () => {
    const ac = new AbortController()
    const kills = []
    let calls = 0
    const promise = run({
      pool: 2,
      signal: ac.signal,
      detect: ({ signal }) =>
        new Promise((resolve, reject) => {
          calls++
          signal.addEventListener('abort', () => {
            kills.push('SIGKILL')
            reject(new Error('FFMPEG_CANCELED'))
          })
        })
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    ac.abort()
    try {
      await promise
      expect.fail('expected a rejection')
    } catch (error) {
      expect(error.code).to.equal('SNAP_ABORTED')
    }
    expect(calls).to.equal(2)
    expect(kills).to.have.length(2)
  })

  it('limits jobs per item and server-wide and releases slots', () => {
    const a = chapterSnapRunner.acquire('a')
    expect(a.ok).to.equal(true)
    expect(chapterSnapRunner.acquire('a')).to.include({ ok: false, status: 409 })
    const b = chapterSnapRunner.acquire('b')
    expect(b.ok).to.equal(true)
    expect(chapterSnapRunner.acquire('c')).to.include({ ok: false, status: 429 })
    a.release()
    a.release()
    expect(chapterSnapRunner._runningJobs.size).to.equal(1)
    const c = chapterSnapRunner.acquire('c')
    expect(c.ok).to.equal(true)
    b.release()
    c.release()
  })

  it('allows one running snap per user so one user cannot hold every slot', () => {
    const a = chapterSnapRunner.acquire('a', 'user-1')
    expect(a.ok).to.equal(true)
    expect(chapterSnapRunner.acquire('b', 'user-1')).to.include({ ok: false, status: 429 })
    const b = chapterSnapRunner.acquire('b', 'user-2')
    expect(b.ok).to.equal(true)
    a.release()
    const c = chapterSnapRunner.acquire('c', 'user-1')
    expect(c.ok).to.equal(true)
    b.release()
    c.release()
    expect(chapterSnapRunner._runningJobs.size).to.equal(0)
  })

  it('releases the slot when the job throws', async () => {
    const slot = chapterSnapRunner.acquire('li-1')
    try {
      await run({ detect: async () => Promise.reject(new Error('boom')) })
    } catch {
    } finally {
      slot.release()
    }
    expect(chapterSnapRunner.acquire('li-1').ok).to.equal(true)
  })

  it('lets a verifier set speech and lower confidence but not move starts', async () => {
    const verifier = {
      verify: sinon.spy(async ({ proposals }) => {
        expect(() => {
          proposals[1].proposedStart = 1
        }).to.throw(TypeError)
        return [
          { index: 1, speech: { text: 'Chapter one' }, confidence: 'low', proposedStart: 1 },
          { index: 2, confidence: 'high' }
        ]
      })
    }
    const result = await run({ verifiers: [verifier] })
    expect(verifier.verify.calledOnce).to.equal(true)
    expect(result.chapters[1]).to.include({ proposedStart: 502.75, confidence: 'low' })
    expect(result.chapters[1].speech).to.deep.equal({ text: 'Chapter one' })
    expect(result.chapters[2]).to.include({ proposedStart: 1502.75, confidence: 'high', speech: null })
  })

  it('accepts {verdicts, warnings} from a verifier and adds its warnings', async () => {
    const verifier = {
      verify: async () => ({
        verdicts: [{ index: 3, speech: { before: 'a', after: 'b', heading: false, late: true, early: false }, confidence: 'low' }],
        warnings: ['Speech check failed: 1 chapters not checked', 42]
      })
    }
    const result = await run({ verifiers: [verifier] })
    expect(result.chapters[3]).to.include({ proposedStart: 2502.75, confidence: 'low' })
    expect(result.chapters[3].speech).to.include({ late: true })
    expect(result.warnings).to.deep.equal(['Speech check failed: 1 chapters not checked'])
  })

  it('aborts when the client goes away during the speech check', async () => {
    const ac = new AbortController()
    const verifier = {
      verify: async () => {
        ac.abort()
        return []
      }
    }
    const error = await run({ verifiers: [verifier], signal: ac.signal }).catch((e) => e)
    expect(error.code).to.equal('SNAP_ABORTED')
  })

  describe('multi-file joints', () => {
    // Two 3600 s files split at a chapter: part 0 ends with 0.45 s of silence, part 1 starts with 0.5 s,
    // and part 1 has a 2.5 s mid-sentence pause ending at book 3612
    const jointTimeline = chapterSnap.buildTimeline([0, 1].map((i) => ({ duration: 3600, metadata: { path: `/books/j/part${i}.mp3` } })))
    const filePauses = {
      '/books/j/part0.mp3': [[3599.55, 3600]],
      '/books/j/part1.mp3': [
        [0, 0.5],
        [9.5, 12]
      ]
    }

    /**
     * Fake ffmpeg that, like silencedetect, only reports silences at least d long, clipped to the window
     */
    function detectWithD({ path, startSec, durationSec, minSilenceSec }) {
      const lines = []
      for (const [s, e] of filePauses[path]) {
        const ls = Math.max(0, s - startSec)
        const le = Math.min(durationSec, e - startSec)
        if (le - ls < minSilenceSec || le <= 0 || ls >= durationSec) continue
        lines.push(`[silencedetect @ 0x1] silence_start: ${ls.toFixed(4)}`)
        lines.push(`[silencedetect @ 0x1] silence_end: ${le.toFixed(4)} | silence_duration: ${(le - ls).toFixed(4)}`)
      }
      return { lines }
    }

    it('finds a pause split into two halves shorter than minSilenceSec', async () => {
      const calls = []
      const result = await run({
        timeline: jointTimeline,
        T: 7200,
        chapters: [
          { id: 0, start: 0 },
          { id: 1, start: 3600 }
        ],
        detect: async (params) => {
          calls.push(params.minSilenceSec)
          return detectWithD(params)
        }
      })
      expect(calls).to.deep.equal([chapterSnap.JOINT_MIN_SILENCE, chapterSnap.JOINT_MIN_SILENCE])
      expect(result.chapters[1]).to.include({ reason: REASONS.INSIDE_PAUSE, proposedStart: 3600, changed: false, confidence: 'medium', trackIndex: 1 })
      expect(result.chapters[1].pause).to.include({ start: 3599.55, end: 3600.5, duration: 0.95, crossesFileBoundary: true })
      expect(result.stats.pausesFound).to.equal(2)
    })

    it('keeps every chapter of a chapter-per-file book on its file start, also with anchorInsidePause', async () => {
      // Each part ends with 1.2 s of silence and the next one starts with speech: the pause ends exactly at the joint
      const durations = [3932.4996, 4152.9208, 4029.649]
      const files = chapterSnap.buildTimeline(durations.map((duration, i) => ({ duration, metadata: { path: `/books/bi/part${i}.mp3` } })))
      const total = durations.reduce((sum, d) => sum + d, 0)
      const detect = async ({ path, startSec, durationSec }) => {
        const track = files.find((t) => t.path === path)
        const s = Math.max(0, track.duration - 1.2 - startSec)
        const e = Math.min(durationSec, track.duration - startSec)
        if (e - s <= 0) return { lines: [] }
        return { lines: [`[silencedetect @ 0x1] silence_start: ${s.toFixed(6)}`, `[silencedetect @ 0x1] silence_end: ${e.toFixed(6)} | silence_duration: ${(e - s).toFixed(6)}`] }
      }
      for (const anchorInsidePause of [false, true]) {
        const result = await run({
          timeline: files,
          T: total,
          chapters: files.map((t, i) => ({ id: i, start: t.offset })),
          detect,
          options: { ...chapterSnap.DEFAULT_OPTIONS, anchorInsidePause }
        })
        expect(result.chapters.map((c) => c.trackIndex), `anchor ${anchorInsidePause}`).to.deep.equal([0, 1, 2])
        expect(result.chapters.slice(1).map((c) => c.reason)).to.deep.equal([REASONS.INSIDE_PAUSE, REASONS.INSIDE_PAUSE])
        expect(result.stats.moved, `anchor ${anchorInsidePause}`).to.equal(0)
      }
    })

    it('decodes a 0.5 s head piece of the next file and still finds the joint pause', async () => {
      const result = await run({
        timeline: jointTimeline,
        T: 7200,
        chapters: [
          { id: 0, start: 0 },
          { id: 1, start: 3574.5 }
        ],
        detect: async (params) => detectWithD(params)
      })
      expect(result.stats.segments).to.equal(2)
      expect(result.stats.ffmpegCalls).to.equal(2)
      expect(result.stats.pausesFound).to.equal(1)
      // The joint pause ends 26 s after the start, outside the 25 s window, so the chapter stays
      expect(result.chapters[1]).to.include({ reason: REASONS.NO_PAUSE_IN_WINDOW, proposedStart: 3574.5 })
    })
  })

  describe('retry after the time limit', () => {
    // File A (1030 s, longer than a whole-file segment) then file B. Chapter 1 at 1000 is covered by the A piece only,
    // chapter 2 at 1020 by the A and the B piece. The deadline falls after the A piece.
    const retryTimeline = chapterSnap.buildTimeline([
      { duration: 1030, metadata: { path: '/books/r/a.mp3' } },
      { duration: 1000, metadata: { path: '/books/r/b.mp3' } }
    ])
    const retryT = 2030
    const original = [
      { id: 'c0', title: 'Zero', start: 0 },
      { id: 'c1', title: 'One', start: 1000 },
      { id: 'c2', title: 'Two', start: 1020 }
    ]

    function linesForPauses(pauses, { path, startSec, durationSec }) {
      const track = retryTimeline.find((t) => t.path === path)
      const lines = []
      for (const [s, e] of pauses) {
        const ls = s - track.offset - startSec
        const le = e - track.offset - startSec
        if (le <= 0 || ls >= durationSec) continue
        lines.push(`[silencedetect @ 0x1] silence_start: ${Math.max(0, ls).toFixed(4)}`)
        lines.push(`[silencedetect @ 0x1] silence_end: ${Math.min(durationSec, le).toFixed(4)} | silence_duration: 1`)
      }
      return lines
    }

    async function firstCall() {
      let clock = 0
      return run({
        timeline: retryTimeline,
        T: retryT,
        chapters: original,
        pool: 1,
        deadlineMs: 1000,
        now: () => clock,
        detect: async (params) => {
          clock += 2000
          return { lines: linesForPauses([[1015.25, 1018.25]], params) }
        }
      })
    }

    // The second analysis sees a pause the first one did not (different segment layout, clipping, noisy decode)
    const secondDetect = async (params) => ({ lines: linesForPauses([[1001, 1002]], params) })

    it('keeps starts strictly increasing when the retry sends the first proposedChapters', async () => {
      const first = await firstCall()
      expect(first.complete).to.equal(false)
      expect(first.chapters.map((c) => c.reason)).to.deep.equal([REASONS.FIRST_CHAPTER, REASONS.NEAREST_LONGEST_PAUSE, REASONS.NOT_ANALYSED])
      expect(first.chapters[1].proposedStart).to.equal(1018)
      expect(first.warnings.some((w) => w.includes('proposedChapters'))).to.equal(true)

      const retryIndexes = first.chapters.filter((c) => c.reason === REASONS.NOT_ANALYSED).map((c) => c.index)
      const second = await run({
        timeline: retryTimeline,
        T: retryT,
        chapters: chapterSnap.validateChapters(first.proposedChapters, retryT),
        indexes: chapterSnap.validateIndexes(retryIndexes, 3),
        detect: secondDetect
      })
      expect(second.complete).to.equal(true)
      const starts = second.proposedChapters.map((c) => c.start)
      expect(starts).to.deep.equal([0, 1018, 1020])
      expect(second.proposedChapters.map((c) => c.id)).to.deep.equal(['c0', 'c1', 'c2'])
      expect(second.chapters[1].reason).to.equal(REASONS.NOT_REQUESTED)
      expect(second.chapters[2].reason).to.equal(REASONS.NO_PAUSE_IN_WINDOW)
    })

    it('shows why: a retry with the original starts could cross the neighbour moved by the first call', async () => {
      const first = await firstCall()
      const second = await run({ timeline: retryTimeline, T: retryT, chapters: original, indexes: new Set([2]), detect: secondDetect })
      // Each response is valid on its own, but combining them would cross
      expect(second.chapters[2].proposedStart).to.equal(1001.75)
      expect(first.chapters[1].proposedStart).to.be.greaterThan(second.chapters[2].proposedStart)
    })
  })

  describe('long single-file book (no drift)', () => {
    // Pause list recorded from a full linear `ffmpeg -i book.m4b -af silencedetect=noise=-38dB:d=0.7` of a real 9.4 h
    // single-file m4b (AAC 44.1 kHz, start_time 0). Windowed input-seek runs on that file at 4 min, 3 h 57 min and 9 h 22 min
    // agreed with it to the microsecond once the seek point was added back. That was a one-off manual check: this test
    // uses a fake ffmpeg, so it only locks the runner's own mapping (seek point added back, leadSec applied). It cannot
    // catch a seek or timestamp error inside real ffmpeg.
    const LONG_T = 33804.051156
    const longTimeline = chapterSnap.buildTimeline([{ duration: LONG_T, metadata: { path: '/books/long/book.m4b' } }])
    const realPauses = [
      [246.766213, 247.996145],
      [248.77424, 250.095215],
      [260.227823, 261.108345],
      [263.361723, 264.403855],
      [266.779751, 267.53737],
      [273.935057, 275.060385],
      [275.947642, 280.147506],
      [280.551293, 281.628707],
      [283.442336, 284.504671],
      [285.784603, 288.344331],
      [292.678912, 293.510227],
      [295.626667, 296.683175],
      [304.194354, 304.92771],
      [309.147619, 309.849546],
      [310.620272, 311.570431],
      [14242.250023, 14243.277188],
      [14247.993243, 14248.831633],
      [14257.300862, 14258.426825],
      [14259.880295, 14260.807823],
      [14261.817823, 14266.019524],
      [14266.438186, 14267.52746],
      [14269.738073, 14272.31068],
      [14284.38127, 14285.450612],
      [14290.156349, 14291.19737],
      [14295.852404, 14296.899819],
      [33738.156916, 33739.120159],
      [33744.503356, 33745.636463],
      [33748.275442, 33749.224014],
      [33750.496667, 33751.281361],
      [33752.470023, 33753.649773],
      [33754.346576, 33755.693605],
      [33758.27898, 33759.118889],
      [33762.723129, 33763.445079],
      [33763.982472, 33765.032245],
      [33766.545465, 33770.081905],
      [33797.546009, 33802.766871]
    ]
    // Fake ffmpeg with input seeking: timestamps restart at 0 at the seek point, a pause cut by the window is clipped.
    // detectSilences passes -ss as toFixed(3), so the fake seeks to that rounded point while the runner adds back the
    // unrounded localStart (an error of at most 0.5 ms, inside the 1 ms tolerance below).
    const seekDetect = async ({ startSec: requestedSec, durationSec }) => {
      const startSec = Number(Math.max(0, requestedSec).toFixed(3))
      const lines = []
      for (const [s, e] of realPauses) {
        const ls = Math.max(0, s - startSec)
        const le = Math.min(durationSec, e - startSec)
        if (le <= 0 || ls >= durationSec) continue
        lines.push(`[Parsed_silencedetect_0 @ 0x1] silence_start: ${ls.toFixed(6)}`)
        if (e - startSec <= durationSec) lines.push(`[Parsed_silencedetect_0 @ 0x1] silence_end: ${le.toFixed(6)} | silence_duration: ${(le - ls).toFixed(6)}`)
      }
      return { lines }
    }

    it('places every start the same distance before its pause end at the start, middle and end of the book', async () => {
      // QA input: published chapter marks + 3 s (the middle one has a sub-millisecond part so -ss rounding is exercised)
      const starts = [0, 280.62, 14267.1504, 33773.16]
      const result = await run({
        timeline: longTimeline,
        T: LONG_T,
        chapters: starts.map((start, i) => ({ id: i, start })),
        detect: seekDetect
      })
      expect(result.complete).to.equal(true)
      const expected = [
        [275.947642, 280.147506],
        [14261.817823, 14266.019524],
        [33766.545465, 33770.081905]
      ]
      expected.forEach(([s, e], k) => {
        const chapter = result.chapters[k + 1]
        expect(chapter.pause.start, `chapter ${k + 1} pause start`).to.be.closeTo(s, 0.001)
        expect(chapter.pause.end, `chapter ${k + 1} pause end`).to.be.closeTo(e, 0.001)
        // The runner's seek-offset mapping adds no position-dependent offset: always leadSec before the pause end
        expect(chapter.proposedStart, `chapter ${k + 1} start`).to.be.closeTo(e - chapterSnap.DEFAULT_OPTIONS.leadSec, 0.001)
      })
    })

    it('puts 8 s late marks, and 2 s early marks with anchorInsidePause, on the same anchor in the break pause', async () => {
      // Published marks 277.62, 14264.15, 33770.16. Late marks land in the pause after the spoken heading and subtitle
      // (up to 5.6 s after the break) or in speech; early marks land inside the break pause or just before it.
      const breaks = [280.147506, 14266.019524, 33770.081905]
      for (const [label, offset] of [
        ['late8', 8],
        ['early2', -2]
      ]) {
        const starts = [0, 277.62 + offset, 14264.15 + offset, 33770.16 + offset]
        const options = { ...chapterSnap.DEFAULT_OPTIONS, anchorInsidePause: true }
        const result = await run({ timeline: longTimeline, T: LONG_T, chapters: starts.map((start, i) => ({ id: i, start })), detect: seekDetect, options })
        breaks.forEach((e, k) => {
          expect(result.chapters[k + 1].proposedStart, `${label} chapter ${k + 1}`).to.be.closeTo(e - chapterSnap.DEFAULT_OPTIONS.leadSec, 0.001)
        })
      }
    })

    it('kept the late marks in the post-heading pause with the old rules (3 s look-back, no anchoring)', async () => {
      const starts = [0, 285.62, 14272.15]
      const result = await run({
        timeline: longTimeline,
        T: LONG_T,
        chapters: starts.map((start, i) => ({ id: i, start })),
        detect: seekDetect,
        options: { ...chapterSnap.DEFAULT_OPTIONS, headingLookbackSec: 3, anchorInsidePause: false }
      })
      expect(result.chapters[1]).to.include({ reason: REASONS.INSIDE_PAUSE, proposedStart: 285.62 })
      expect(result.chapters[2]).to.include({ reason: REASONS.INSIDE_PAUSE, proposedStart: 14272.15 })
    })
  })
})
