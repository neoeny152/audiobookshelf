const { expect } = require('chai')
const sinon = require('sinon')
const os = require('os')
const Path = require('path')
const EventEmitter = require('events')

const fs = require('../../../server/libs/fsExtra')
const Logger = require('../../../server/Logger')
const prober = require('../../../server/utils/prober')
const ffmpegHelpers = require('../../../server/utils/ffmpegHelpers')
const CoverManager = require('../../../server/managers/CoverManager')
const CacheManager = require('../../../server/managers/CacheManager')
const MediaProbeData = require('../../../server/scanner/MediaProbeData')

// Regression tests for #3697 and #4867: the first video stream of an m4b is not
// always the cover. Libation/OpenAudible files can have a chapter-image or
// timed-thumbnail stream before the attached picture.

function audioStream(index) {
  return { index, codec_type: 'audio', codec_name: 'aac', bit_rate: '64000', sample_rate: '44100', channels: 2, channel_layout: 'stereo', disposition: { default: 1 } }
}
function videoStream(index, codec_name, width, height, attached_pic = 0) {
  return { index, codec_type: 'video', codec_name, width, height, disposition: { default: 0, attached_pic } }
}

// Typical Libation layout: audio, a timed 1x1 chapter-image track, then the real cover
const libationStreams = () => [audioStream(0), videoStream(1, 'h264', 1, 1, 0), videoStream(2, 'png', 600, 600, 1)]

describe('embedded cover art stream selection (#3697, #4867)', () => {
  describe('prober.getCoverArtStream', () => {
    it('prefers the attached_pic stream over an earlier video stream', () => {
      expect(prober.getCoverArtStream(libationStreams()).index).to.equal(2)
    })

    it('accepts attached_pic given as a string', () => {
      const streams = [audioStream(0), videoStream(1, 'mjpeg', 10, 10, 0), videoStream(2, 'mjpeg', 5, 5, '1')]
      expect(prober.getCoverArtStream(streams).index).to.equal(2)
    })

    it('picks the largest attached picture when there are several', () => {
      const streams = [audioStream(0), videoStream(1, 'mjpeg', 100, 100, 1), videoStream(2, 'mjpeg', 1000, 1000, 1), videoStream(3, 'mjpeg', 1000, 1000, 1)]
      expect(prober.getCoverArtStream(streams).index).to.equal(2)
    })

    it('falls back to the largest video stream when none is marked attached_pic', () => {
      const streams = [audioStream(0), videoStream(1, 'h264', 1, 1), videoStream(2, 'mjpeg', 500, 500)]
      expect(prober.getCoverArtStream(streams).index).to.equal(2)
    })

    it('keeps the first video stream for plain files and returns null without video', () => {
      expect(prober.getCoverArtStream([audioStream(0), videoStream(1, 'mjpeg', 500, 500, 1)]).index).to.equal(1)
      expect(prober.getCoverArtStream([audioStream(0)])).to.equal(null)
      expect(prober.getCoverArtStream(undefined)).to.equal(null)
    })
  })

  describe('prober.parseProbeData', () => {
    it('reports the codec of the attached picture as embeddedCoverArt', () => {
      const parsed = prober.parseProbeData({ format: { duration: '10', size: '1000', bit_rate: '64000', tags: { title: 'Book' } }, streams: libationStreams(), chapters: [] })
      expect(parsed.video_stream.index).to.equal(2)

      const probeData = new MediaProbeData()
      probeData.setData(parsed)
      expect(probeData.embeddedCoverArt).to.equal('png')
    })
  })

  describe('ffmpegHelpers.extractCoverArt', () => {
    function ffmpegStub() {
      const stub = new EventEmitter()
      stub.addOption = sinon.stub().returnsThis()
      stub.output = sinon.stub().returnsThis()
      stub.run = sinon.stub().callsFake(() => stub.emit('end'))
      return stub
    }

    beforeEach(() => {
      sinon.stub(fs, 'ensureDir').resolves()
      sinon.stub(Logger, 'debug')
    })
    afterEach(() => sinon.restore())

    it('maps the given absolute stream index', async () => {
      const ffmpeg = ffmpegStub()
      const result = await ffmpegHelpers.extractCoverArt('/books/a.m4b', '/meta/cover.png', 2, ffmpeg)
      expect(result).to.equal('/meta/cover.png')
      expect(ffmpeg.addOption.firstCall.args[0]).to.deep.equal(['-map 0:2', '-frames:v 1'])
    })

    it('maps the first video stream when no index is given', async () => {
      const ffmpeg = ffmpegStub()
      await ffmpegHelpers.extractCoverArt('/books/a.m4b', '/meta/cover.jpg', null, ffmpeg)
      expect(ffmpeg.addOption.firstCall.args[0]).to.deep.equal(['-map 0:v:0', '-frames:v 1'])
    })
  })

  describe('CoverManager.saveEmbeddedCoverArt', () => {
    let tmpDir

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(Path.join(os.tmpdir(), 'abs-cover-'))
      global.ServerSettings = { storeCoverWithItem: true }
      sinon.stub(CacheManager, 'purgeCoverCache').resolves()
      sinon.stub(Logger, 'warn')
      sinon.stub(Logger, 'error')
    })
    afterEach(async () => {
      sinon.restore()
      await fs.remove(tmpDir)
    })

    it('extracts the attached_pic stream and names the file after its codec', async () => {
      sinon.stub(prober, 'rawProbe').resolves({ streams: libationStreams() })
      const extract = sinon.stub(ffmpegHelpers, 'extractCoverArt').callsFake(async (input, output) => output)

      // Saved before the fix: codec of the first video stream
      const audioFiles = [{ embeddedCoverArt: 'h264', metadata: { path: '/books/Book/book.m4b' } }]
      const coverPath = await CoverManager.saveEmbeddedCoverArt(audioFiles, 'li_1', tmpDir)

      expect(extract.calledOnce).to.be.true
      expect(extract.firstCall.args[2]).to.equal(2)
      expect(coverPath).to.equal(Path.join(tmpDir, 'cover.png'))
    })

    it('falls back to the first video stream when probing fails', async () => {
      sinon.stub(prober, 'rawProbe').resolves({ error: 'probe failed' })
      const extract = sinon.stub(ffmpegHelpers, 'extractCoverArt').resolves(false)

      const audioFiles = [{ embeddedCoverArt: 'mjpeg', metadata: { path: '/books/Book/book.m4b' } }]
      const coverPath = await CoverManager.saveEmbeddedCoverArt(audioFiles, 'li_1', tmpDir)

      expect(extract.firstCall.args[1]).to.equal(Path.join(tmpDir, 'cover.jpg'))
      expect(extract.firstCall.args[2]).to.equal(null)
      expect(coverPath).to.equal(null)
      expect(Logger.error.calledOnce).to.be.true
    })
  })
})
