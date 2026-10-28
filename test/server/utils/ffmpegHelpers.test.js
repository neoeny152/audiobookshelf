const { expect } = require('chai')
const sinon = require('sinon')
const fileUtils = require('../../../server/utils/fileUtils')
const fs = require('../../../server/libs/fsExtra')
const EventEmitter = require('events')

const { generateFFMetadata, addCoverAndMetadataToFile, detectSilences } = require('../../../server/utils/ffmpegHelpers')
const Ffmpeg = require('../../../server/libs/fluentFfmpeg')
const Logger = require('../../../server/Logger')

global.isWin = process.platform === 'win32'

describe('generateFFMetadata', () => {
  function createTestSetup() {
    const metadata = {
      title: 'My Audiobook',
      artist: 'John Doe',
      album: 'Best Audiobooks'
    }

    const chapters = [
      { start: 0, end: 1000, title: 'Chapter 1' },
      { start: 1000, end: 2000, title: 'Chapter 2' }
    ]

    return { metadata, chapters }
  }

  let metadata = null
  let chapters = null
  beforeEach(() => {
    const input = createTestSetup()
    metadata = input.metadata
    chapters = input.chapters
  })

  it('should generate ffmetadata content with chapters', () => {
    const result = generateFFMetadata(metadata, chapters)

    expect(result).to.equal(';FFMETADATA1\ntitle=My Audiobook\nartist=John Doe\nalbum=Best Audiobooks\n\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=1000000\ntitle=Chapter 1\n\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=1000000\nEND=2000000\ntitle=Chapter 2\n')
  })

  it('should generate ffmetadata content without chapters', () => {
    chapters = null

    const result = generateFFMetadata(metadata, chapters)

    expect(result).to.equal(';FFMETADATA1\ntitle=My Audiobook\nartist=John Doe\nalbum=Best Audiobooks\n')
  })

  it('should handle chapters with no title', () => {
    chapters = [
      { start: 0, end: 1000 },
      { start: 1000, end: 2000 }
    ]

    const result = generateFFMetadata(metadata, chapters)

    expect(result).to.equal(';FFMETADATA1\ntitle=My Audiobook\nartist=John Doe\nalbum=Best Audiobooks\n\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=1000000\n\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=1000000\nEND=2000000\n')
  })

  it('should handle metadata escaping special characters (=, ;, #,  and a newline)', () => {
    metadata.title = 'My Audiobook; with = special # characters\n'
    chapters[0].title = 'Chapter #1'

    const result = generateFFMetadata(metadata, chapters)

    expect(result).to.equal(';FFMETADATA1\ntitle=My Audiobook\\; with \\= special \\# characters\\\n\nartist=John Doe\nalbum=Best Audiobooks\n\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=1000000\ntitle=Chapter \\#1\n\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=1000000\nEND=2000000\ntitle=Chapter 2\n')
  })
})

describe('addCoverAndMetadataToFile', () => {
  function createTestSetup() {
    const audioFilePath = '/path/to/audio/file.mp3'
    const coverFilePath = '/path/to/cover/image.jpg'
    const metadataFilePath = '/path/to/metadata/file.txt'
    const track = 1
    const mimeType = 'audio/mpeg'

    const ffmpegStub = new EventEmitter()
    ffmpegStub.input = sinon.stub().returnsThis()
    ffmpegStub.outputOptions = sinon.stub().returnsThis()
    ffmpegStub.output = sinon.stub().returnsThis()
    ffmpegStub.input = sinon.stub().returnsThis()
    ffmpegStub.run = sinon.stub().callsFake(() => {
      ffmpegStub.emit('end')
    })
    const copyStub = sinon.stub().resolves()
    const fsRemoveStub = sinon.stub(fs, 'remove').resolves()

    return { audioFilePath, coverFilePath, metadataFilePath, track, mimeType, ffmpegStub, copyStub, fsRemoveStub }
  }

  let audioFilePath = null
  let coverFilePath = null
  let metadataFilePath = null
  let track = null
  let mimeType = null
  let ffmpegStub = null
  let copyStub = null
  let fsRemoveStub = null
  beforeEach(() => {
    const input = createTestSetup()
    audioFilePath = input.audioFilePath
    coverFilePath = input.coverFilePath
    metadataFilePath = input.metadataFilePath
    track = input.track
    mimeType = input.mimeType
    ffmpegStub = input.ffmpegStub
    copyStub = input.copyStub
    fsRemoveStub = input.fsRemoveStub
  })

  it('should add cover image and metadata to audio file', async () => {
    // Act
    await addCoverAndMetadataToFile(audioFilePath, coverFilePath, metadataFilePath, track, mimeType, null, ffmpegStub, copyStub)

    // Assert
    expect(ffmpegStub.input.calledThrice).to.be.true
    expect(ffmpegStub.input.getCall(0).args[0]).to.equal(audioFilePath)
    expect(ffmpegStub.input.getCall(1).args[0]).to.equal(metadataFilePath)
    expect(ffmpegStub.input.getCall(2).args[0]).to.equal(coverFilePath)

    expect(ffmpegStub.outputOptions.callCount).to.equal(4)
    expect(ffmpegStub.outputOptions.getCall(0).args[0]).to.deep.equal(['-map 0:a', '-map_metadata 1', '-map_metadata 0', '-map_chapters 1', '-c copy'])
    expect(ffmpegStub.outputOptions.getCall(1).args[0]).to.deep.equal(['-metadata track=1'])
    expect(ffmpegStub.outputOptions.getCall(2).args[0]).to.deep.equal(['-id3v2_version 3'])
    expect(ffmpegStub.outputOptions.getCall(3).args[0]).to.deep.equal(['-map 2:v', '-disposition:v:0 attached_pic', '-metadata:s:v', 'title=Cover', '-metadata:s:v', 'comment=Cover'])

    expect(ffmpegStub.output.calledOnce).to.be.true
    expect(ffmpegStub.output.firstCall.args[0]).to.equal('/path/to/audio/file.tmp.mp3')

    expect(ffmpegStub.run.calledOnce).to.be.true

    expect(copyStub.calledOnce).to.be.true
    expect(copyStub.firstCall.args[0]).to.equal('/path/to/audio/file.tmp.mp3')
    expect(copyStub.firstCall.args[1]).to.equal('/path/to/audio/file.mp3')
    expect(fsRemoveStub.calledOnce).to.be.true
    expect(fsRemoveStub.firstCall.args[0]).to.equal('/path/to/audio/file.tmp.mp3')

    // Restore the stub
    sinon.restore()
  })

  it('should handle missing cover image', async () => {
    // Arrange
    coverFilePath = null

    // Act
    await addCoverAndMetadataToFile(audioFilePath, coverFilePath, metadataFilePath, track, mimeType, null, ffmpegStub, copyStub)

    // Assert
    expect(ffmpegStub.input.calledTwice).to.be.true
    expect(ffmpegStub.input.getCall(0).args[0]).to.equal(audioFilePath)
    expect(ffmpegStub.input.getCall(1).args[0]).to.equal(metadataFilePath)

    expect(ffmpegStub.outputOptions.callCount).to.equal(4)
    expect(ffmpegStub.outputOptions.getCall(0).args[0]).to.deep.equal(['-map 0:a', '-map_metadata 1', '-map_metadata 0', '-map_chapters 1', '-c copy'])
    expect(ffmpegStub.outputOptions.getCall(1).args[0]).to.deep.equal(['-metadata track=1'])
    expect(ffmpegStub.outputOptions.getCall(2).args[0]).to.deep.equal(['-id3v2_version 3'])
    expect(ffmpegStub.outputOptions.getCall(3).args[0]).to.deep.equal(['-map 0:v?'])

    expect(ffmpegStub.output.calledOnce).to.be.true
    expect(ffmpegStub.output.firstCall.args[0]).to.equal('/path/to/audio/file.tmp.mp3')

    expect(ffmpegStub.run.calledOnce).to.be.true

    expect(copyStub.callCount).to.equal(1)
    expect(copyStub.firstCall.args[0]).to.equal('/path/to/audio/file.tmp.mp3')
    expect(copyStub.firstCall.args[1]).to.equal('/path/to/audio/file.mp3')
    expect(fsRemoveStub.calledOnce).to.be.true
    expect(fsRemoveStub.firstCall.args[0]).to.equal('/path/to/audio/file.tmp.mp3')

    // Restore the stub
    sinon.restore()
  })

  it('should handle error during ffmpeg execution', async () => {
    // Arrange
    ffmpegStub.run = sinon.stub().callsFake(() => {
      ffmpegStub.emit('error', new Error('FFmpeg error'))
    })

    // Act
    try {
      await addCoverAndMetadataToFile(audioFilePath, coverFilePath, metadataFilePath, track, mimeType, null, ffmpegStub, copyStub)
      expect.fail('Expected an error to be thrown')
    } catch (error) {
      // Assert
      expect(error.message).to.equal('FFmpeg error')
    }

    // Assert
    expect(ffmpegStub.input.calledThrice).to.be.true
    expect(ffmpegStub.input.getCall(0).args[0]).to.equal(audioFilePath)
    expect(ffmpegStub.input.getCall(1).args[0]).to.equal(metadataFilePath)
    expect(ffmpegStub.input.getCall(2).args[0]).to.equal(coverFilePath)

    expect(ffmpegStub.outputOptions.callCount).to.equal(4)
    expect(ffmpegStub.outputOptions.getCall(0).args[0]).to.deep.equal(['-map 0:a', '-map_metadata 1', '-map_metadata 0', '-map_chapters 1', '-c copy'])
    expect(ffmpegStub.outputOptions.getCall(1).args[0]).to.deep.equal(['-metadata track=1'])
    expect(ffmpegStub.outputOptions.getCall(2).args[0]).to.deep.equal(['-id3v2_version 3'])
    expect(ffmpegStub.outputOptions.getCall(3).args[0]).to.deep.equal(['-map 2:v', '-disposition:v:0 attached_pic', '-metadata:s:v', 'title=Cover', '-metadata:s:v', 'comment=Cover'])

    expect(ffmpegStub.output.calledOnce).to.be.true
    expect(ffmpegStub.output.firstCall.args[0]).to.equal('/path/to/audio/file.tmp.mp3')

    expect(ffmpegStub.run.calledOnce).to.be.true

    expect(copyStub.called).to.be.false
    expect(fsRemoveStub.called).to.be.false

    // Restore the stub
    sinon.restore()
  })

  it('should handle m4b embedding', async () => {
    // Arrange
    mimeType = 'audio/mp4'
    audioFilePath = '/path/to/audio/file.m4b'

    // Act
    await addCoverAndMetadataToFile(audioFilePath, coverFilePath, metadataFilePath, track, mimeType, null, ffmpegStub, copyStub)

    // Assert
    expect(ffmpegStub.input.calledThrice).to.be.true
    expect(ffmpegStub.input.getCall(0).args[0]).to.equal(audioFilePath)
    expect(ffmpegStub.input.getCall(1).args[0]).to.equal(metadataFilePath)
    expect(ffmpegStub.input.getCall(2).args[0]).to.equal(coverFilePath)

    expect(ffmpegStub.outputOptions.callCount).to.equal(4)
    expect(ffmpegStub.outputOptions.getCall(0).args[0]).to.deep.equal(['-map 0:a', '-map_metadata 1', '-map_metadata 0', '-map_chapters 1', '-c copy'])
    expect(ffmpegStub.outputOptions.getCall(1).args[0]).to.deep.equal(['-metadata track=1'])
    expect(ffmpegStub.outputOptions.getCall(2).args[0]).to.deep.equal(['-f mp4'])
    expect(ffmpegStub.outputOptions.getCall(3).args[0]).to.deep.equal(['-map 2:v', '-disposition:v:0 attached_pic', '-metadata:s:v', 'title=Cover', '-metadata:s:v', 'comment=Cover'])

    expect(ffmpegStub.output.calledOnce).to.be.true
    expect(ffmpegStub.output.firstCall.args[0]).to.equal('/path/to/audio/file.tmp.m4b')

    expect(ffmpegStub.run.calledOnce).to.be.true

    expect(copyStub.calledOnce).to.be.true
    expect(copyStub.firstCall.args[0]).to.equal('/path/to/audio/file.tmp.m4b')
    expect(copyStub.firstCall.args[1]).to.equal('/path/to/audio/file.m4b')
    expect(fsRemoveStub.calledOnce).to.be.true
    expect(fsRemoveStub.firstCall.args[0]).to.equal('/path/to/audio/file.tmp.m4b')

    // Restore the stub
    sinon.restore()
  })
})

describe('detectSilences', () => {
  const params = { path: '/books/Black Ice/concat:part 01.mp3', startSec: 1234.5, durationSec: 58.5, noiseDb: -38, minSilenceSec: 0.7 }

  /**
   * Real fluent-ffmpeg command with run() replaced, so the argv it would spawn can be checked
   */
  function createCommand(onRun) {
    const command = Ffmpeg()
    command.kill = sinon.spy()
    command.run = sinon.spy(() => {
      command.argsAtRun = command._getArguments()
      command.stderrListenersAtRun = command.listenerCount('stderr')
      onRun(command)
    })
    return command
  }

  beforeEach(() => {
    sinon.stub(Logger, 'error')
    sinon.stub(Logger, 'debug')
  })

  afterEach(() => {
    sinon.restore()
  })

  it('builds separate argv elements with a file: input and a numeric filter', async () => {
    const command = createCommand((cmd) => cmd.emit('end'))
    await detectSilences(params, command)

    const args = command.argsAtRun
    const ssIndex = args.indexOf('-ss')
    expect(ssIndex).to.be.greaterThan(-1)
    expect(args[ssIndex + 1]).to.equal('1234.500')
    expect(args[ssIndex + 2]).to.equal('-i')
    expect(args[ssIndex + 3]).to.equal('file:/books/Black Ice/concat:part 01.mp3')
    const tIndex = args.indexOf('-t')
    expect(args[tIndex + 1]).to.equal('58.500')
    expect(args).to.include.members(['-vn', '-sn', '-dn', '-hide_banner', '-nostats'])
    expect(args).to.include('silencedetect=noise=-38.0dB:d=0.70')
    const fIndex = args.indexOf('-f')
    expect(args[fIndex + 1]).to.equal('null')
    expect(args[args.length - 1]).to.equal('-')
    // the path is a single element and appears nowhere else
    expect(args.filter((a) => a.includes('Black Ice'))).to.have.length(1)
    expect(command.stderrListenersAtRun).to.equal(1)
  })

  it('collects only silence lines', async () => {
    const command = createCommand((cmd) => {
      cmd.emit('stderr', "Input #0, mp3, from 'file:/books/a.mp3':")
      cmd.emit('stderr', '[silencedetect @ 0x1] silence_start: 12.3456')
      cmd.emit('stderr', 'size=N/A time=00:00:30.00 bitrate=N/A speed= 600x')
      cmd.emit('stderr', '[silencedetect @ 0x1] silence_end: 14.5678 | silence_duration: 2.2222')
      cmd.emit('end')
    })
    const result = await detectSilences(params, command)
    expect(result).to.deep.equal({ lines: ['[silencedetect @ 0x1] silence_start: 12.3456', '[silencedetect @ 0x1] silence_end: 14.5678 | silence_duration: 2.2222'] })
  })

  it('rejects on an ffmpeg error and on a timeout', async () => {
    const failing = createCommand((cmd) => cmd.emit('error', new Error('ffmpeg exited with code 1: No such file'), '', 'x'.repeat(5000)))
    try {
      await detectSilences(params, failing)
      expect.fail('expected a rejection')
    } catch (error) {
      expect(error.message).to.include('exited with code 1')
    }
    expect(Logger.error.firstCall.args[0].length).to.be.below(2048 + 200)

    const timedOut = createCommand((cmd) => cmd.emit('error', new Error('process ran into a timeout (30s)')))
    try {
      await detectSilences(params, timedOut)
      expect.fail('expected a rejection')
    } catch (error) {
      expect(error.message).to.include('timeout')
    }
  })

  it('kills with SIGKILL on abort and rejects with FFMPEG_CANCELED', async () => {
    const ac = new AbortController()
    const command = createCommand(() => {})
    command.kill = sinon.spy(() => command.emit('error', new Error('ffmpeg was killed with signal SIGKILL')))
    const promise = detectSilences({ ...params, signal: ac.signal }, command)
    ac.abort()
    try {
      await promise
      expect.fail('expected a rejection')
    } catch (error) {
      expect(error.message).to.equal('FFMPEG_CANCELED')
    }
    expect(command.kill.calledOnceWith('SIGKILL')).to.be.true
  })

  it('rejects without spawning when already aborted or given bad numbers', async () => {
    const ac = new AbortController()
    ac.abort()
    const command = createCommand((cmd) => cmd.emit('end'))
    await detectSilences({ ...params, signal: ac.signal }, command).then(
      () => expect.fail('expected a rejection'),
      (error) => expect(error.message).to.equal('FFMPEG_CANCELED')
    )
    await detectSilences({ ...params, noiseDb: '-38dB; rm -rf /' }, command).then(
      () => expect.fail('expected a rejection'),
      (error) => expect(error.message).to.include('noiseDb')
    )
    expect(command.run.called).to.be.false
  })
})
