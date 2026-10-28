const { expect } = require('chai')
const sinon = require('sinon')
const os = require('os')
const Path = require('path')
const { spawnSync } = require('child_process')
const fs = require('../../../server/libs/fsExtra')

const Logger = require('../../../server/Logger')
const chapterSnap = require('../../../server/utils/chapterSnap')
const chapterSnapRunner = require('../../../server/utils/chapterSnapRunner')
const { detectSilences } = require('../../../server/utils/ffmpegHelpers')

/**
 * Real ffmpeg integration. Skipped when there is no FFMPEG_PATH and no ffmpeg on PATH.
 * Validates the input -ss timestamp assumption and the file: prefix (including on Windows).
 */
function findFfmpeg() {
  const bin = process.env.FFMPEG_PATH || 'ffmpeg'
  const result = spawnSync(bin, ['-version'], { encoding: 'utf8' })
  return result.status === 0 ? bin : null
}

const TOLERANCE = 0.05

describe('chapterSnap integration (real ffmpeg)', function () {
  this.timeout(60000)

  // Resolved at load time: other suites (BinaryManager) delete process.env.FFMPEG_PATH before this one runs
  const ffmpegBin = findFfmpeg()
  const savedFfmpegPath = process.env.FFMPEG_PATH
  let dir

  /**
   * Generate a tone with silent ranges. argv only, no shell.
   */
  function generate(outFile, durationSec, silences, codecArgs) {
    const enable = silences.map(([s, e]) => `between(t,${s},${e})`).join('+')
    const args = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=22050:duration=${durationSec}`, '-af', `volume=enable='${enable}':volume=0`, ...codecArgs, outFile]
    const result = spawnSync(ffmpegBin, args, { encoding: 'utf8' })
    if (result.status !== 0) throw new Error(`ffmpeg generate failed: ${result.stderr}`)
  }

  function pausesOf(lines, seg) {
    return chapterSnap.parseSilencedetect(lines, seg)
  }

  before(function () {
    if (!ffmpegBin) return this.skip()
    if (ffmpegBin !== 'ffmpeg') process.env.FFMPEG_PATH = ffmpegBin
    dir = require('fs').mkdtempSync(Path.join(os.tmpdir(), 'abs snap '))
    // Two files split in the middle of a 2 s silence (book 8-10), plus a pause at book 15-16.5
    generate(Path.join(dir, 'part0.wav'), 9, [[8, 9]], ['-c:a', 'pcm_s16le'])
    generate(
      Path.join(dir, 'part1.wav'),
      11,
      [
        [0, 1],
        [6, 7.5]
      ],
      ['-c:a', 'pcm_s16le']
    )
    // Two files with a 0.95 s pause on the joint at book 9, each half shorter than the default minSilenceSec
    generate(Path.join(dir, 'joint0.wav'), 9, [[8.55, 9]], ['-c:a', 'pcm_s16le'])
    generate(Path.join(dir, 'joint1.wav'), 11, [[0, 0.5]], ['-c:a', 'pcm_s16le'])
    // Single files with pauses at 10-12 and 20-21.5
    generate(
      Path.join(dir, 'single.mp3'),
      30,
      [
        [10, 12],
        [20, 21.5]
      ],
      ['-c:a', 'libmp3lame', '-b:a', '64k']
    )
    generate(
      Path.join(dir, 'single.m4b'),
      30,
      [
        [10, 12],
        [20, 21.5]
      ],
      ['-c:a', 'aac', '-b:a', '64k', '-f', 'mp4']
    )
  })

  after(async function () {
    if (dir) await fs.remove(dir)
    if (savedFfmpegPath === undefined) delete process.env.FFMPEG_PATH
    else process.env.FFMPEG_PATH = savedFfmpegPath
  })

  beforeEach(() => {
    sinon.stub(Logger, 'info')
  })

  afterEach(() => {
    sinon.restore()
  })

  for (const file of ['single.mp3', 'single.m4b']) {
    it(`reports times relative to the input seek point (${file})`, async () => {
      const seg = { localStart: 9, localDur: 5, reachesFileEnd: false }
      const { lines } = await detectSilences({ path: Path.join(dir, file), startSec: seg.localStart, durationSec: seg.localDur, noiseDb: -38, minSilenceSec: 0.7 })
      const pauses = pausesOf(lines, seg)
      expect(pauses).to.have.length(1)
      expect(pauses[0].start).to.be.closeTo(1, TOLERANCE)
      expect(pauses[0].end).to.be.closeTo(3, TOLERANCE)
    })

    it(`snaps a single-file book (${file})`, async () => {
      const timeline = chapterSnap.buildTimeline([{ duration: 30, metadata: { path: Path.join(dir, file) } }])
      const result = await chapterSnapRunner.runSnap({
        libraryItemId: 'it',
        timeline,
        T: 30,
        chapters: chapterSnap.validateChapters([{ start: 0 }, { start: 13 }, { start: 22.5 }], 30),
        options: chapterSnap.parseOptions({})
      })
      expect(result.complete).to.equal(true)
      expect(result.chapters[1].pause.start).to.be.closeTo(10, TOLERANCE)
      expect(result.chapters[1].pause.end).to.be.closeTo(12, TOLERANCE)
      expect(result.chapters[1].proposedStart).to.be.closeTo(12 - 0.25, TOLERANCE)
      expect(result.chapters[2].pause.end).to.be.closeTo(21.5, TOLERANCE)
      expect(result.chapters[2].proposedStart).to.be.closeTo(21.5 - 0.25, TOLERANCE)
    })
  }

  it('joins a pause split across two files and snaps on the book timeline', async () => {
    const timeline = chapterSnap.buildTimeline([
      { duration: 9, metadata: { path: Path.join(dir, 'part0.wav') } },
      { duration: 11, metadata: { path: Path.join(dir, 'part1.wav') } }
    ])
    const result = await chapterSnapRunner.runSnap({
      libraryItemId: 'it',
      timeline,
      T: 20,
      chapters: chapterSnap.validateChapters([{ start: 0 }, { start: 10.5 }, { start: 17 }], 20),
      options: chapterSnap.parseOptions({})
    })
    expect(result.complete).to.equal(true)
    const [, first, second] = result.chapters
    expect(first.pause.start).to.be.closeTo(8, TOLERANCE)
    expect(first.pause.end).to.be.closeTo(10, TOLERANCE)
    expect(first.pause.crossesFileBoundary).to.equal(true)
    expect(first.proposedStart).to.be.closeTo(9.75, TOLERANCE)
    expect(first.trackIndex).to.equal(1)
    expect(second.pause.start).to.be.closeTo(15, TOLERANCE)
    expect(second.pause.end).to.be.closeTo(16.5, TOLERANCE)
    expect(second.proposedStart).to.be.closeTo(16.25, TOLERANCE)
  })

  it('finds a joint pause whose halves are each shorter than minSilenceSec', async () => {
    const timeline = chapterSnap.buildTimeline([
      { duration: 9, metadata: { path: Path.join(dir, 'joint0.wav') } },
      { duration: 11, metadata: { path: Path.join(dir, 'joint1.wav') } }
    ])
    const result = await chapterSnapRunner.runSnap({
      libraryItemId: 'it',
      timeline,
      T: 20,
      chapters: chapterSnap.validateChapters([{ start: 0 }, { start: 9 }], 20),
      options: chapterSnap.parseOptions({})
    })
    expect(result.complete).to.equal(true)
    const chapter = result.chapters[1]
    expect(chapter.reason).to.equal(chapterSnap.REASONS.INSIDE_PAUSE)
    expect(chapter.proposedStart).to.equal(9)
    expect(chapter.pause.start).to.be.closeTo(8.55, TOLERANCE)
    expect(chapter.pause.end).to.be.closeTo(9.5, TOLERANCE)
    expect(chapter.pause.crossesFileBoundary).to.equal(true)
  })
})
