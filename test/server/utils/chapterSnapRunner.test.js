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
      expect(result.chapters[1]).to.include({ reason: REASONS.INSIDE_PAUSE, proposedStart: 3600, changed: false, confidence: 'medium' })
      expect(result.chapters[1].pause).to.include({ start: 3599.55, end: 3600.5, duration: 0.95, crossesFileBoundary: true })
      expect(result.stats.pausesFound).to.equal(2)
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
})
