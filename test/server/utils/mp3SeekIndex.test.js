const { expect } = require('chai')
const sinon = require('sinon')
const os = require('os')
const Path = require('path')
const fs = require('fs')

const Logger = require('../../../server/Logger')
const mp3SeekIndex = require('../../../server/utils/mp3SeekIndex')

// MPEG1 Layer III, 44.1 kHz, joint stereo. Bitrate index 9 = 128 kbps (frame 417 bytes, 418 padded), 5 = 64 kbps (208/209)
const SPF = 1152
const SR = 44100

/**
 * One synthetic MP3 frame: a real header and a zeroed payload of the right length.
 *
 * @param {{bitrateIndex?: number, padding?: boolean, tag?: 'Xing'|'Info'|'VBRI'|null}} [opts]
 */
function frame({ bitrateIndex = 9, padding = false, tag = null } = {}) {
  const header = Buffer.from([0xff, 0xfb, (bitrateIndex << 4) | (padding ? 2 : 0), 0x40])
  const parsed = mp3SeekIndex.parseFrameHeader(header, 0)
  const buf = Buffer.alloc(parsed.frameLength)
  header.copy(buf, 0)
  if (tag === 'VBRI') buf.write('VBRI', 36, 'latin1')
  else if (tag) buf.write(tag, 4 + 32, 'latin1')
  return buf
}

function frames(count, opts) {
  return Buffer.concat(Array.from({ length: count }, () => frame(opts)))
}

/** ID3v2.3 tag with a body of `size` bytes (syncsafe size). */
function id3(size) {
  const buf = Buffer.alloc(10 + size)
  buf.write('ID3', 0, 'latin1')
  buf[3] = 3
  buf[6] = (size >> 21) & 0x7f
  buf[7] = (size >> 14) & 0x7f
  buf[8] = (size >> 7) & 0x7f
  buf[9] = size & 0x7f
  return buf
}

describe('mp3SeekIndex', () => {
  beforeEach(() => {
    sinon.stub(Logger, 'warn')
  })
  afterEach(() => {
    sinon.restore()
  })

  describe('parseFrameHeader', () => {
    it('parses MPEG1 Layer III 128 kbps 44.1 kHz', () => {
      const h = mp3SeekIndex.parseFrameHeader(Buffer.from([0xff, 0xfb, 0x90, 0x40]), 0)
      expect(h).to.include({ layer: 3, bitrate: 128000, sampleRate: 44100, frameLength: 417, sideInfoSize: 32, samplesPerFrame: 1152 })
    })

    it('adds the padding byte', () => {
      expect(mp3SeekIndex.parseFrameHeader(Buffer.from([0xff, 0xfb, 0x92, 0x40]), 0).frameLength).to.equal(418)
    })

    it('handles MPEG2 mono (side info 9, 576 samples)', () => {
      // MPEG2 (version bits 10), Layer III, 64 kbps (index 8), 22.05 kHz, mono
      const h = mp3SeekIndex.parseFrameHeader(Buffer.from([0xff, 0xf3, 0x80, 0xc0]), 0)
      expect(h).to.include({ bitrate: 64000, sampleRate: 22050, sideInfoSize: 9, samplesPerFrame: 576, frameLength: 208 })
    })

    it('rejects bad sync, reserved values and free bitrate', () => {
      expect(mp3SeekIndex.parseFrameHeader(Buffer.from([0xff, 0x1b, 0x90, 0x40]), 0)).to.be.null
      expect(mp3SeekIndex.parseFrameHeader(Buffer.from([0xff, 0xfb, 0xf0, 0x40]), 0)).to.be.null
      expect(mp3SeekIndex.parseFrameHeader(Buffer.from([0xff, 0xfb, 0x0c, 0x40]), 0)).to.be.null
      expect(mp3SeekIndex.parseFrameHeader(Buffer.from([0xff, 0xeb, 0x90, 0x40]), 0)).to.be.null // version reserved
    })
  })

  describe('id3v2Size', () => {
    it('reads the syncsafe size', () => {
      expect(mp3SeekIndex.id3v2Size(id3(300))).to.equal(310)
      expect(mp3SeekIndex.id3v2Size(id3(200000))).to.equal(200010)
    })
    it('is 0 without a tag', () => {
      expect(mp3SeekIndex.id3v2Size(frames(1))).to.equal(0)
    })
  })

  describe('detectFromBuffer', () => {
    it('finds Xing, Info and VBRI headers', () => {
      expect(mp3SeekIndex.detectFromBuffer(Buffer.concat([frame({ tag: 'Xing' }), frames(10)])).status).to.equal('xing')
      expect(mp3SeekIndex.detectFromBuffer(Buffer.concat([frame({ tag: 'Info' }), frames(10)])).status).to.equal('info')
      expect(mp3SeekIndex.detectFromBuffer(Buffer.concat([frame({ tag: 'VBRI' }), frames(10)])).status).to.equal('vbri')
    })

    it('reports none when the first frame is audio', () => {
      expect(mp3SeekIndex.detectFromBuffer(frames(10)).status).to.equal('none')
    })

    it('skips a stray sync before the real frames', () => {
      const junk = Buffer.from([0x00, 0xff, 0xfb, 0x90, 0x40, 0x12, 0x34])
      expect(mp3SeekIndex.detectFromBuffer(Buffer.concat([junk, frame({ tag: 'Xing' }), frames(10)])).status).to.equal('xing')
    })

    it('reports unknown when there are no frames', () => {
      expect(mp3SeekIndex.detectFromBuffer(Buffer.alloc(4096, 0x41)).status).to.equal('unknown')
    })
  })

  describe('detectSeekIndex and measureDuration (files)', () => {
    let dir
    before(() => {
      dir = fs.mkdtempSync(Path.join(os.tmpdir(), 'abs seekidx '))
    })
    after(() => {
      fs.rmSync(dir, { recursive: true, force: true })
    })

    function write(name, ...parts) {
      const p = Path.join(dir, name)
      fs.writeFileSync(p, Buffer.concat(parts))
      return p
    }

    it('reads past a large ID3v2 tag (cover art) and finds no header', async () => {
      const p = write('big-tag.mp3', id3(300000), frames(50))
      expect((await mp3SeekIndex.detectSeekIndex(p)).status).to.equal('none')
    })

    it('finds a Xing header after an ID3v2 tag', async () => {
      const p = write('xing.mp3', id3(1000), frame({ tag: 'Xing' }), frames(50))
      expect((await mp3SeekIndex.detectSeekIndex(p)).status).to.equal('xing')
    })

    it('measures the frame count duration: unpadded "128 kbps" frames last longer than the bitrate estimate', async () => {
      // Every frame 417 bytes (padding never set), like the Red Rising files: real 0.23% longer than bytes*8/128000
      const count = 3000
      const p = write('unpadded.mp3', id3(500), frames(count), Buffer.from('TAG'), Buffer.alloc(125))
      const { duration, frames: n, bitrates } = await mp3SeekIndex.measureDuration(p)
      expect(n).to.equal(count)
      expect(duration).to.be.closeTo((count * SPF) / SR, 1e-9)
      expect(bitrates).to.deep.equal([128000])
      const estimate = (count * 417 * 8) / 128000
      expect(duration - estimate).to.be.greaterThan(0.15)
    })

    it('counts mixed bitrate frames, skips the Xing frame and resyncs over junk', async () => {
      const p = write('mixed.mp3', frame({ tag: 'Xing' }), frames(1000), Buffer.alloc(777, 0x55), frames(500, { bitrateIndex: 5 }), frames(500, { padding: true }))
      const { duration, frames: n, bitrates } = await mp3SeekIndex.measureDuration(p)
      expect(n).to.equal(2000)
      expect(duration).to.be.closeTo((2000 * SPF) / SR, 1e-9)
      expect(bitrates).to.deep.equal([64000, 128000])
    })

    it('walks files larger than one read chunk', async () => {
      const count = 6000 // ~2.5 MB
      const p = write('long.mp3', frames(count, { padding: true }))
      const { frames: n } = await mp3SeekIndex.measureDuration(p)
      expect(n).to.equal(count)
    })
  })

  describe('command construction', () => {
    it('remuxes with stream copy only, keeps every stream and writes a Xing header', () => {
      const args = mp3SeekIndex.buildRemuxArgs('/books/a b/concat:x.mp3', '/books/a b/.concat:x.mp3.seekfix.tmp')
      expect(args).to.include.members(['-map', '0', '-c', 'copy', '-write_xing', '1', '-id3v2_version', '3', '-f', 'mp3'])
      expect(args[args.indexOf('-c') + 1]).to.equal('copy')
      expect(args).to.not.include.members(['-c:a', '-b:a', '-codec:a', '-q:a'])
      expect(args).to.include('file:/books/a b/concat:x.mp3')
      expect(args[args.length - 1]).to.equal('file:/books/a b/.concat:x.mp3.seekfix.tmp')
    })

    it('puts the temp file next to the original as an ignored dotfile', () => {
      const original = Path.join('/books', 'Author', 'Book', 'Part 1.mp3')
      const tmp = mp3SeekIndex.getTempPath(original)
      expect(Path.dirname(tmp)).to.equal(Path.dirname(original))
      expect(Path.basename(tmp)).to.equal('.Part 1.mp3.seekfix.tmp')
    })

    it('counts packets and decodes with file: paths', () => {
      expect(mp3SeekIndex.buildCountPacketsArgs('/x.mp3')).to.include.members(['-count_packets', 'file:/x.mp3'])
      const decode = mp3SeekIndex.buildDecodeArgs('/x.mp3')
      expect(decode).to.include.members(['-progress', 'pipe:1', '-f', 'null', 'file:/x.mp3'])
    })

    it('parses ffprobe packet counts and ffmpeg progress', () => {
      expect(mp3SeekIndex.parseCountPackets('{"streams":[{"nb_read_packets":"290481"}],"format":{"duration":"7588.780000"}}')).to.deep.equal({ packets: 290481, duration: 7588.78 })
      expect(mp3SeekIndex.parseCountPackets('nope')).to.deep.equal({ packets: null, duration: null })
      expect(mp3SeekIndex.parseProgressSeconds('out_time_us=1000000\nprogress=continue\nout_time_us=7588780000\nprogress=end\n')).to.equal(7588.78)
      expect(mp3SeekIndex.parseProgressSeconds('progress=end')).to.be.null
    })
  })

  describe('verifyRemux', () => {
    const good = { oldPackets: 100, newPackets: 100, newProbedDuration: 7588.78, decodedDuration: 7588.75, newStatus: 'xing' }
    it('passes when frames match and probed == decoded', () => {
      expect(mp3SeekIndex.verifyRemux(good)).to.deep.equal({ ok: true })
    })
    it('fails on a frame count change', () => {
      expect(mp3SeekIndex.verifyRemux({ ...good, newPackets: 99 }).ok).to.be.false
    })
    it('fails without a header in the output', () => {
      expect(mp3SeekIndex.verifyRemux({ ...good, newStatus: 'none' }).ok).to.be.false
    })
    it('fails when probed and decoded durations differ by more than 0.1 s', () => {
      expect(mp3SeekIndex.verifyRemux({ ...good, decodedDuration: 7588.6 }).ok).to.be.false
    })
    it('fails on missing values', () => {
      expect(mp3SeekIndex.verifyRemux({ ...good, decodedDuration: null }).ok).to.be.false
      expect(mp3SeekIndex.verifyRemux({ ...good, oldPackets: null }).ok).to.be.false
    })
  })

  describe('repairFile', () => {
    const path = '/books/Book/Part 1.mp3'
    const tmp = mp3SeekIndex.getTempPath(path)

    function fakeFs() {
      return {
        stat: sinon.stub().resolves({ mode: 0o100664, uid: 99, gid: 100 }),
        chmod: sinon.stub().resolves(),
        chown: sinon.stub().resolves(),
        copyFile: sinon.stub().resolves(),
        rename: sinon.stub().resolves(),
        rm: sinon.stub().resolves(),
        mkdir: sinon.stub().resolves()
      }
    }

    function fakeRun({ oldPackets = 1000, newPackets = 1000, probed = 26.122, decoded = 26.12, remuxCode = 0 } = {}) {
      return sinon.stub().callsFake(async (bin, args, opts) => {
        if (args.includes('-count_packets')) {
          const isTmp = args[args.length - 1] === 'file:' + tmp
          return { code: 0, stdout: JSON.stringify({ streams: [{ nb_read_packets: String(isTmp ? newPackets : oldPackets) }], format: { duration: String(probed) } }), stderr: '' }
        }
        if (args.includes('-write_xing')) return { code: remuxCode, stdout: '', stderr: remuxCode ? 'boom' : '' }
        if (args.includes('-progress')) {
          const out = `out_time_us=${Math.round(decoded * 5e5)}\nprogress=continue\nout_time_us=${Math.round(decoded * 1e6)}\nprogress=end\n`
          opts.onStdout?.(out)
          return { code: 0, stdout: out, stderr: '' }
        }
        throw new Error('unexpected command')
      })
    }

    it('remuxes, verifies, keeps permissions and renames the temp over the original', async () => {
      const fsStub = fakeFs()
      const run = fakeRun()
      const progress = []
      const result = await mp3SeekIndex.repairFile(path, { run, fs: fsStub, detect: async () => ({ status: 'xing' }), expectedDuration: 26.12, onProgress: (f) => progress.push(f) })
      expect(result).to.include({ oldPackets: 1000, newProbedDuration: 26.122, decodedDuration: 26.12 })
      const remuxCall = run.getCalls().find((c) => c.args[1].includes('-write_xing'))
      expect(remuxCall.args[1]).to.deep.equal(mp3SeekIndex.buildRemuxArgs(path, tmp))
      expect(fsStub.chmod.calledWith(tmp, 0o664)).to.be.true
      expect(fsStub.rename.calledOnceWith(tmp, path)).to.be.true
      expect(fsStub.rm.called).to.be.false
      expect(progress[progress.length - 1]).to.equal(1)
      expect(progress.every((p, i) => i === 0 || p >= progress[i - 1])).to.be.true
    })

    it('copies a backup before replacing when asked', async () => {
      const fsStub = fakeFs()
      const backupPath = Path.join('/meta', 'backup', 'Part 1.mp3')
      await mp3SeekIndex.repairFile(path, { run: fakeRun(), fs: fsStub, detect: async () => ({ status: 'xing' }), backupPath })
      expect(fsStub.mkdir.calledWith(Path.dirname(backupPath), { recursive: true })).to.be.true
      expect(fsStub.copyFile.calledOnceWith(path, backupPath)).to.be.true
      expect(fsStub.copyFile.calledBefore(fsStub.rename)).to.be.true
    })

    it('does not replace the original when the backup copy is incomplete', async () => {
      const fsStub = fakeFs()
      const backupPath = Path.join('/meta', 'backup', 'Part 1.mp3')
      fsStub.stat.withArgs(path).resolves({ mode: 0o100664, uid: 99, gid: 100, size: 1000 })
      fsStub.stat.withArgs(backupPath).resolves({ size: 10 })
      let error
      try {
        await mp3SeekIndex.repairFile(path, { run: fakeRun(), fs: fsStub, detect: async () => ({ status: 'xing' }), backupPath })
      } catch (err) {
        error = err
      }
      expect(error?.message).to.match(/incomplete/)
      expect(fsStub.rename.called).to.be.false
      expect(fsStub.rm.calledWith(tmp)).to.be.true
    })

    it('leaves the original alone and removes the temp when the frame count differs', async () => {
      const fsStub = fakeFs()
      let error
      try {
        await mp3SeekIndex.repairFile(path, { run: fakeRun({ newPackets: 999 }), fs: fsStub, detect: async () => ({ status: 'xing' }) })
      } catch (err) {
        error = err
      }
      expect(error?.message).to.match(/frame count/)
      expect(fsStub.rename.called).to.be.false
      expect(fsStub.rm.calledWith(tmp)).to.be.true
    })

    it('fails when the new header does not give the decoded duration', async () => {
      const fsStub = fakeFs()
      let error
      try {
        await mp3SeekIndex.repairFile(path, { run: fakeRun({ probed: 26.5 }), fs: fsStub, detect: async () => ({ status: 'xing' }) })
      } catch (err) {
        error = err
      }
      expect(error?.message).to.match(/differs from decoded/)
      expect(fsStub.rename.called).to.be.false
    })

    it('fails when the remux fails', async () => {
      const fsStub = fakeFs()
      let error
      try {
        await mp3SeekIndex.repairFile(path, { run: fakeRun({ remuxCode: 1 }), fs: fsStub, detect: async () => ({ status: 'xing' }) })
      } catch (err) {
        error = err
      }
      expect(error?.message).to.match(/Remux failed: boom/)
      expect(fsStub.rename.called).to.be.false
      expect(fsStub.rm.calledWith(tmp)).to.be.true
    })
  })

  describe('restoreFile', () => {
    let dir
    beforeEach(() => {
      dir = fs.mkdtempSync(Path.join(os.tmpdir(), 'abs seekrestore '))
    })
    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true })
    })

    it('puts the backup over the file through a temp file next to it', async () => {
      const backup = Path.join(dir, 'backup.mp3')
      const target = Path.join(dir, 'Part 1.mp3')
      fs.writeFileSync(backup, 'original')
      fs.writeFileSync(target, 'repaired file')
      await mp3SeekIndex.restoreFile(backup, target)
      expect(fs.readFileSync(target, 'utf8')).to.equal('original')
      expect(fs.readdirSync(dir).sort()).to.deep.equal(['Part 1.mp3', 'backup.mp3'])
    })

    it('leaves the file alone when the backup is missing', async () => {
      const target = Path.join(dir, 'Part 1.mp3')
      fs.writeFileSync(target, 'repaired file')
      let error
      try {
        await mp3SeekIndex.restoreFile(Path.join(dir, 'nope.mp3'), target)
      } catch (err) {
        error = err
      }
      expect(error).to.exist
      expect(fs.readFileSync(target, 'utf8')).to.equal('repaired file')
      expect(fs.readdirSync(dir)).to.deep.equal(['Part 1.mp3'])
    })
  })

  describe('needsRepair', () => {
    const af = (over = {}) => ({ duration: 7571.36475, mp3SeekIndex: 'none', metadata: { size: 100, mtimeMs: 5 }, mp3Measured: { duration: 7588.78, size: 100, mtimeMs: 5 }, ...over })
    it('needs a missing header and a measured drift above 1 s', () => {
      expect(mp3SeekIndex.getDrift(af())).to.be.closeTo(17.415, 0.001)
      expect(mp3SeekIndex.needsRepair(af())).to.be.true
    })
    it('ignores true CBR files whose estimate is right', () => {
      expect(mp3SeekIndex.needsRepair(af({ mp3Measured: { duration: 7571.9, size: 100, mtimeMs: 5 } }))).to.be.false
    })
    it('ignores files with a header, or not measured yet, or measured before they changed', () => {
      expect(mp3SeekIndex.needsRepair(af({ mp3SeekIndex: 'xing' }))).to.be.false
      expect(mp3SeekIndex.needsRepair(af({ mp3Measured: null }))).to.be.false
      expect(mp3SeekIndex.getDrift(af({ metadata: { size: 101, mtimeMs: 5 } }))).to.be.null
      expect(mp3SeekIndex.needsRepair(af({ metadata: { size: 100, mtimeMs: 6 } }))).to.be.false
    })
  })

  describe('shiftChapters', () => {
    // Red Rising: estimated vs real part durations
    const oldD = [7571.36475, 13280.172938, 18416.831063, 18859.242]
    const newD = [7588.78, 13310.72, 18459.193, 18902.622]

    it('moves each time by the growth of the files before it, keeping its place within its file', () => {
      const chapters = [
        { id: 0, start: 0, end: 100, title: 'Opening' },
        { id: 1, start: 100, end: 7571.36475, title: 'Part 1' },
        { id: 2, start: 7571.36475, end: 8000, title: 'Part 2' },
        { id: 3, start: 8000, end: oldD[0] + oldD[1] + 50, title: 'Ch' },
        { id: 4, start: oldD[0] + oldD[1] + 50, end: oldD.reduce((a, b) => a + b), title: 'Last' }
      ]
      const { chapters: out, maxShift } = mp3SeekIndex.shiftChapters(chapters, oldD, newD)
      expect(out[0].start).to.equal(0)
      expect(out[1].start).to.equal(100)
      expect(out[2].start).to.be.closeTo(7588.78, 0.001)
      expect(out[3].start).to.be.closeTo(8000 + (7588.78 - 7571.36475), 0.001)
      expect(out[4].start).to.be.closeTo(newD[0] + newD[1] + 50, 0.001)
      // Contiguous and the last one runs to the new end
      for (let i = 0; i < out.length - 1; i++) expect(out[i].end).to.equal(out[i + 1].start)
      expect(out[4].end).to.be.closeTo(newD.reduce((a, b) => a + b), 0.001)
      expect(maxShift).to.be.closeTo(newD[0] + newD[1] - oldD[0] - oldD[1], 0.002)
    })

    it('is a no-op when durations are unchanged', () => {
      const chapters = [
        { id: 0, start: 0, end: 50, title: 'a' },
        { id: 1, start: 50, end: 100, title: 'b' }
      ]
      const { chapters: out, maxShift } = mp3SeekIndex.shiftChapters(chapters, [60, 40], [60, 40])
      expect(out.map((c) => [c.start, c.end])).to.deep.equal([
        [0, 50],
        [50, 100]
      ])
      expect(maxShift).to.equal(0)
    })
  })
})
