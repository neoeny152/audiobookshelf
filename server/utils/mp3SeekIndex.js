const Path = require('path')
const fsp = require('fs').promises
const { spawn } = require('child_process')
const Logger = require('../Logger')

/**
 * MP3 seek index (Xing/Info/VBRI header) detection and repair.
 *
 * Without one of these headers ffprobe estimates an MP3's duration from the first frames' bitrate
 * ("Estimating duration from bitrate, this may be inaccurate"). For a VBR or mixed-bitrate file the estimate is wrong,
 * so the stored duration, every later track's startOffset, and byte-estimated seeking in players all drift.
 * A CBR file without a header is fine: the estimate is exact.
 *
 * Detection reads the ID3v2 header and the first 64 KB after it, so it is cheap enough for scans. It cannot tell a
 * true CBR file (estimate exact) from one with occasional smaller frames (estimate off by tens of seconds over hours,
 * seen on real files that sample as constant 128 kbps), so every file without a header is flagged; measureDuration()
 * walks all frame headers (reads the whole file, no decoding) to report the real error on demand.
 * Repair remuxes with stream copy and a Xing header (audio is never re-encoded), verifies, then replaces the file.
 *
 * @typedef {'xing'|'info'|'vbri'|'none'|'unknown'} Mp3SeekIndexStatus
 *  xing/info/vbri: header present. none: no header, ffprobe estimates the duration (needs repair).
 *  unknown: no MPEG audio frame found near the start.
 */

const BITRATES = {
  // [version][layer] kbps, index 1-14. version: 1 = MPEG1, 2 = MPEG2/2.5
  1: {
    1: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
    2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
    3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
  },
  2: {
    1: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
    2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
    3: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
  }
}
const SAMPLE_RATES = {
  3: [44100, 48000, 32000], // MPEG1
  2: [22050, 24000, 16000], // MPEG2
  0: [11025, 12000, 8000] // MPEG2.5
}

const HEAD_READ_BYTES = 64 * 1024
const MEASURE_CHUNK_BYTES = 1024 * 1024
const MIN_FRAME_CHAIN = 4

/**
 * Parse a 4 byte MPEG audio frame header.
 *
 * @param {Buffer} buf
 * @param {number} off
 * @returns {{versionBits:number, layer:number, bitrate:number, sampleRate:number, channelMode:number, frameLength:number, sideInfoSize:number, samplesPerFrame:number}|null}
 */
function parseFrameHeader(buf, off) {
  if (off < 0 || off + 4 > buf.length) return null
  const b1 = buf[off + 1]
  const b2 = buf[off + 2]
  const b3 = buf[off + 3]
  if (buf[off] !== 0xff || (b1 & 0xe0) !== 0xe0) return null

  const versionBits = (b1 >> 3) & 3 // 0 = 2.5, 1 = reserved, 2 = MPEG2, 3 = MPEG1
  const layerBits = (b1 >> 1) & 3 // 1 = III, 2 = II, 3 = I
  const bitrateIndex = (b2 >> 4) & 0xf
  const sampleRateIndex = (b2 >> 2) & 3
  if (versionBits === 1 || layerBits === 0 || bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 3) return null

  const layer = 4 - layerBits
  const isMpeg1 = versionBits === 3
  const bitrate = BITRATES[isMpeg1 ? 1 : 2][layer][bitrateIndex] * 1000
  const sampleRate = SAMPLE_RATES[versionBits][sampleRateIndex]
  const padding = (b2 >> 1) & 1
  const channelMode = (b3 >> 6) & 3
  const mono = channelMode === 3

  let frameLength
  if (layer === 1) frameLength = (Math.floor((12 * bitrate) / sampleRate) + padding) * 4
  else if (layer === 3 && !isMpeg1) frameLength = Math.floor((72 * bitrate) / sampleRate) + padding
  else frameLength = Math.floor((144 * bitrate) / sampleRate) + padding

  const sideInfoSize = isMpeg1 ? (mono ? 17 : 32) : mono ? 9 : 17
  const samplesPerFrame = layer === 1 ? 384 : layer === 3 && !isMpeg1 ? 576 : 1152
  return { versionBits, layer, bitrate, sampleRate, channelMode, frameLength, sideInfoSize, samplesPerFrame }
}

function sameStream(a, b) {
  return a.versionBits === b.versionBits && a.layer === b.layer && a.sampleRate === b.sampleRate
}

/**
 * Size of the ID3v2 tag at the start of the buffer (0 if none).
 *
 * @param {Buffer} buf
 * @returns {number}
 */
function id3v2Size(buf) {
  if (buf.length < 10 || buf.toString('latin1', 0, 3) !== 'ID3') return 0
  const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f)
  const hasFooter = (buf[5] & 0x10) !== 0
  return 10 + size + (hasFooter ? 10 : 0)
}

/**
 * Walk consecutive frames from `off` and return their headers (stops at the first gap or buffer end).
 *
 * @param {Buffer} buf
 * @param {number} off
 * @param {number} [max]
 */
function walkFrames(buf, off, max = Infinity) {
  const frames = []
  let first = null
  while (frames.length < max) {
    const header = parseFrameHeader(buf, off)
    if (!header || (first && !sameStream(first, header))) break
    if (off + header.frameLength > buf.length) break
    first = first || header
    frames.push({ off, ...header })
    off += header.frameLength
  }
  return frames
}

/**
 * Find the first frame in `buf` (from `start`) that is followed by a chain of valid frames of the same stream,
 * so a stray 0xFFE sync inside tag data or audio payload is not taken for a frame.
 *
 * @param {Buffer} buf
 * @param {number} [start=0]
 * @param {number} [minChain]
 * @returns {Array<{off:number}>} the frames walked from the match, empty if none
 */
function findFrameChain(buf, start = 0, minChain = MIN_FRAME_CHAIN) {
  for (let off = Math.max(0, start); off + 4 <= buf.length; off++) {
    if (buf[off] !== 0xff) continue
    const frames = walkFrames(buf, off)
    if (frames.length >= minChain) return frames
  }
  return []
}

/**
 * Which seek header (if any) the given first frame carries.
 *
 * @param {Buffer} buf
 * @param {{off:number, sideInfoSize:number, frameLength:number}} frame
 * @returns {'xing'|'info'|'vbri'|null}
 */
function readSeekHeaderTag(buf, frame) {
  const xingOff = frame.off + 4 + frame.sideInfoSize
  const tag = buf.toString('latin1', xingOff, xingOff + 4)
  if (tag === 'Xing') return 'xing'
  if (tag === 'Info') return 'info'
  if (buf.toString('latin1', frame.off + 36, frame.off + 40) === 'VBRI') return 'vbri'
  return null
}

/**
 * Detect the seek index status from the bytes right after the ID3v2 tag(s).
 *
 * @param {Buffer} head
 * @returns {{status: Mp3SeekIndexStatus}}
 */
function detectFromBuffer(head) {
  const frames = findFrameChain(head, 0)
  if (!frames.length) return { status: 'unknown' }
  return { status: readSeekHeaderTag(head, frames[0]) || 'none' }
}

async function readAt(handle, position, length) {
  const buf = Buffer.alloc(length)
  const { bytesRead } = await handle.read(buf, 0, length, position)
  return buf.subarray(0, bytesRead)
}

/**
 * Offset of the first byte after any ID3v2 tag(s); some files carry more than one back to back.
 *
 * @param {import('fs').promises.FileHandle} handle
 */
async function getAudioStart(handle) {
  let audioStart = 0
  for (let i = 0; i < 4; i++) {
    const tagSize = id3v2Size(await readAt(handle, audioStart, 10))
    if (!tagSize) break
    audioStart += tagSize
  }
  return audioStart
}

/**
 * Detect whether an MP3 file has a seek index. Reads at most ~64 KB regardless of file size.
 *
 * @param {string} filePath
 * @returns {Promise<{status: Mp3SeekIndexStatus}>}
 */
async function detectSeekIndex(filePath) {
  const handle = await fsp.open(filePath, 'r')
  try {
    const audioStart = await getAudioStart(handle)
    return detectFromBuffer(await readAt(handle, audioStart, HEAD_READ_BYTES))
  } finally {
    await handle.close()
  }
}

/**
 * Count every MPEG frame (headers only, no decoding) and return the duration they add up to: what a decoder plays,
 * and what a Xing header would record. A Xing/Info frame at the start is not counted. Bytes that are not part of a
 * frame chain (ID3v1/APE tags at the end, junk) are skipped by searching for the next run of valid frames.
 *
 * Reads the whole file in 1 MB chunks: I/O bound, a few seconds for a 300 MB file.
 *
 * @param {string} filePath
 * @param {{signal?: AbortSignal}} [opts]
 * @returns {Promise<{duration: number, frames: number, bitrates: number[]}>}
 */
async function measureDuration(filePath, { signal = null } = {}) {
  const handle = await fsp.open(filePath, 'r')
  try {
    const { size } = await handle.stat()
    let pos = await getAudioStart(handle)
    let buf = Buffer.alloc(0)
    let bufStart = pos
    let first = null
    let frames = 0
    let samples = 0
    const bitrates = new Set()
    let checkedFirst = false

    while (true) {
      if (signal?.aborted) throw new Error('MEASURE_CANCELED')
      // Keep at least a few frames worth of bytes ahead of the cursor
      const off = pos - bufStart
      if (buf.length - off < 8192 && bufStart + buf.length < size) {
        const chunk = await readAt(handle, bufStart + buf.length, MEASURE_CHUNK_BYTES)
        buf = Buffer.concat([buf.subarray(off), chunk])
        bufStart = pos
        continue
      }
      const at = pos - bufStart
      if (at + 4 > buf.length) break

      const header = parseFrameHeader(buf, at)
      const fits = header && at + header.frameLength <= buf.length
      if (fits && (!first || sameStream(first, header))) {
        if (!first) {
          // Lock on only when the next frames follow, so a stray sync is not taken for the stream
          if (walkFrames(buf, at, MIN_FRAME_CHAIN).length < MIN_FRAME_CHAIN && bufStart + buf.length < size) {
            pos++
            continue
          }
          first = header
        }
        if (!checkedFirst) {
          checkedFirst = true
          if (readSeekHeaderTag(buf, { off: at, ...header })) {
            pos += header.frameLength
            continue
          }
        }
        frames++
        samples += header.samplesPerFrame
        bitrates.add(header.bitrate)
        pos += header.frameLength
        continue
      }
      if (header && !fits && bufStart + buf.length >= size) break // truncated last frame
      // Resync: next position where a chain of frames of the same stream starts
      const chain = findFrameChain(buf, at + 1)
      const next = chain.find((f) => !first || sameStream(first, f))
      if (next) pos = bufStart + next.off
      else if (bufStart + buf.length >= size) break
      else pos = bufStart + Math.max(at + 1, buf.length - 8192)
    }

    return { duration: first ? samples / first.sampleRate : 0, frames, bitrates: [...bitrates].sort((a, b) => a - b) }
  } finally {
    await handle.close()
  }
}

/**
 * @param {Mp3SeekIndexStatus|null|undefined} status
 * @returns {boolean}
 */
function needsRepair(status) {
  return status === 'none'
}

/**
 * True when an audio file object (from the database) is an MP3 that this check applies to.
 *
 * @param {{codec?:string, metadata?:{ext?:string}}} audioFile
 */
function isMp3AudioFile(audioFile) {
  if (audioFile?.codec) return audioFile.codec === 'mp3'
  return (audioFile?.metadata?.ext || '').toLowerCase() === '.mp3'
}

/**
 * Temp file next to the original (same filesystem, so the final rename is atomic). A dotfile with a .tmp
 * extension, which the scanner and watcher both ignore.
 *
 * @param {string} filePath
 */
function getTempPath(filePath) {
  return Path.join(Path.dirname(filePath), `.${Path.basename(filePath)}.seekfix.tmp`)
}

/**
 * ffmpeg argv for the remux: every stream copied (audio and cover art), tags and chapters kept, Xing header written.
 * Paths get a `file:` prefix so names like `concat:` are never read as protocols.
 *
 * @param {string} input
 * @param {string} output
 * @returns {string[]}
 */
function buildRemuxArgs(input, output) {
  return ['-nostdin', '-hide_banner', '-v', 'error', '-y', '-i', 'file:' + input, '-map', '0', '-c', 'copy', '-id3v2_version', '3', '-write_xing', '1', '-f', 'mp3', 'file:' + output]
}

/**
 * ffprobe argv that demuxes the whole file and counts audio packets (= MPEG frames; the Xing frame is not a packet).
 *
 * @param {string} filePath
 */
function buildCountPacketsArgs(filePath) {
  return ['-v', 'error', '-select_streams', 'a:0', '-count_packets', '-show_entries', 'stream=nb_read_packets:format=duration', '-of', 'json', 'file:' + filePath]
}

/**
 * ffmpeg argv that decodes the audio to nothing and reports progress (out_time_us) on stdout.
 *
 * @param {string} filePath
 */
function buildDecodeArgs(filePath) {
  return ['-nostdin', '-hide_banner', '-v', 'error', '-nostats', '-progress', 'pipe:1', '-i', 'file:' + filePath, '-map', '0:a:0', '-f', 'null', '-']
}

/**
 * @param {string} stdout - ffprobe json from buildCountPacketsArgs
 * @returns {{packets: number|null, duration: number|null}}
 */
function parseCountPackets(stdout) {
  let json
  try {
    json = JSON.parse(stdout)
  } catch {
    return { packets: null, duration: null }
  }
  const packets = Number(json?.streams?.[0]?.nb_read_packets)
  const duration = Number(json?.format?.duration)
  return { packets: Number.isFinite(packets) ? packets : null, duration: Number.isFinite(duration) ? duration : null }
}

/**
 * Last out_time_us from ffmpeg -progress output, in seconds.
 *
 * @param {string} text
 * @returns {number|null}
 */
function parseProgressSeconds(text) {
  const matches = [...String(text).matchAll(/out_time_us=(\d+)/g)]
  if (!matches.length) return null
  return Number(matches[matches.length - 1][1]) / 1e6
}

/**
 * Check a remux before it replaces the original.
 *
 * @param {Object} p
 * @param {number|null} p.oldPackets
 * @param {number|null} p.newPackets
 * @param {number|null} p.newProbedDuration - ffprobe duration of the remuxed file
 * @param {number|null} p.decodedDuration - decoded duration of the remuxed file
 * @param {Mp3SeekIndexStatus} p.newStatus - seek index detected in the remuxed file
 * @param {number} [p.tolerance=0.1]
 * @returns {{ok: boolean, reason?: string}}
 */
function verifyRemux({ oldPackets, newPackets, newProbedDuration, decodedDuration, newStatus, tolerance = 0.1 }) {
  if (!oldPackets || !newPackets) return { ok: false, reason: 'Could not count audio frames' }
  if (oldPackets !== newPackets) return { ok: false, reason: `Audio frame count changed (${oldPackets} -> ${newPackets})` }
  if (newStatus !== 'xing' && newStatus !== 'info') return { ok: false, reason: `Remuxed file has no Xing/Info header (${newStatus})` }
  if (newProbedDuration == null || decodedDuration == null) return { ok: false, reason: 'Could not read the remuxed duration' }
  const diff = Math.abs(newProbedDuration - decodedDuration)
  if (diff > tolerance) return { ok: false, reason: `Probed duration ${newProbedDuration.toFixed(2)}s differs from decoded ${decodedDuration.toFixed(2)}s` }
  return { ok: true }
}

/**
 * Spawn a binary (no shell) and collect its output.
 *
 * @param {string} bin
 * @param {string[]} args
 * @param {{signal?: AbortSignal, onStdout?: (chunk: string) => void}} [opts]
 * @returns {Promise<{code: number, stdout: string, stderr: string}>} rejects with FFMPEG_CANCELED on abort
 */
function runProcess(bin, args, { signal = null, onStdout = null } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('FFMPEG_CANCELED'))
    const child = spawn(bin, args, { windowsHide: true })
    let stdout = ''
    let stderr = ''
    const onAbort = () => child.kill('SIGKILL')
    signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', (d) => {
      const s = d.toString()
      // -progress output can be long for a big file; keep only the tail
      stdout = (stdout + s).slice(-65536)
      onStdout?.(s)
    })
    child.stderr.on('data', (d) => {
      stderr = (stderr + d.toString()).slice(-8192)
    })
    child.on('error', (err) => {
      signal?.removeEventListener('abort', onAbort)
      reject(err)
    })
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort)
      if (signal?.aborted) return reject(new Error('FFMPEG_CANCELED'))
      resolve({ code, stdout, stderr })
    })
  })
}

/**
 * Remux one MP3 with a Xing header, verify it and replace the original.
 * The original is untouched unless every check passes; the temp file is removed on any failure.
 *
 * @param {string} filePath
 * @param {Object} [opts]
 * @param {number} [opts.expectedDuration] - for decode progress
 * @param {(fraction: number) => void} [opts.onProgress] - 0..1
 * @param {AbortSignal} [opts.signal]
 * @param {string} [opts.backupPath] - copy the original here before replacing
 * @param {typeof runProcess} [opts.run] - injectable for tests
 * @param {typeof detectSeekIndex} [opts.detect] - injectable for tests
 * @param {Object} [opts.fs] - injectable for tests (copyFile, rename, stat, chmod, chown, rm)
 * @returns {Promise<{oldPackets:number, newProbedDuration:number, decodedDuration:number}>}
 */
async function repairFile(filePath, { expectedDuration = 0, onProgress = () => {}, signal = null, backupPath = null, run = runProcess, detect = detectSeekIndex, fs = fsp } = {}) {
  const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg'
  const ffprobe = process.env.FFPROBE_PATH || 'ffprobe'
  const tempPath = getTempPath(filePath)

  try {
    const before = await run(ffprobe, buildCountPacketsArgs(filePath), { signal })
    const { packets: oldPackets } = parseCountPackets(before.stdout)
    if (before.code !== 0 || !oldPackets) throw new Error(`ffprobe failed on original: ${before.stderr.trim() || 'no audio frames'}`)
    onProgress(0.1)

    const remux = await run(ffmpeg, buildRemuxArgs(filePath, tempPath), { signal })
    if (remux.code !== 0) throw new Error(`Remux failed: ${remux.stderr.trim()}`)
    onProgress(0.3)

    const after = await run(ffprobe, buildCountPacketsArgs(tempPath), { signal })
    const { packets: newPackets, duration: newProbedDuration } = parseCountPackets(after.stdout)
    const newStatus = (await detect(tempPath)).status
    onProgress(0.4)

    const decode = await run(ffmpeg, buildDecodeArgs(tempPath), {
      signal,
      onStdout: (chunk) => {
        const sec = parseProgressSeconds(chunk)
        if (sec != null && expectedDuration > 0) onProgress(0.4 + 0.6 * Math.min(1, sec / expectedDuration))
      }
    })
    if (decode.code !== 0) throw new Error(`Decode check failed: ${decode.stderr.trim()}`)
    const decodedDuration = parseProgressSeconds(decode.stdout)

    const verdict = verifyRemux({ oldPackets, newPackets, newProbedDuration, decodedDuration, newStatus })
    if (!verdict.ok) throw new Error(`Verification failed: ${verdict.reason}`)

    // Keep the original's permissions and owner; the rename replaces the file in one step
    const stat = await fs.stat(filePath)
    await fs.chmod(tempPath, stat.mode & 0o7777)
    if (typeof process.getuid === 'function') {
      await fs.chown(tempPath, stat.uid, stat.gid).catch((err) => Logger.warn(`[mp3SeekIndex] Could not keep owner of "${filePath}": ${err.message}`))
    }
    if (backupPath) await fs.copyFile(filePath, backupPath)
    await fs.rename(tempPath, filePath)
    onProgress(1)
    return { oldPackets, newProbedDuration, decodedDuration }
  } catch (err) {
    await fs.rm(tempPath, { force: true }).catch(() => {})
    throw err
  }
}

/**
 * Move chapter times from the old (estimated) track timeline to the repaired one: each time keeps its position
 * within the file it falls in, and moves by how much the files before it grew or shrank. That is the dominant effect
 * for chapters set on ABS's timeline (snap, set from tracks); chapters taken from an external source that already
 * used true times (e.g. Audible) do not need it.
 *
 * @param {{start:number, end:number, title:string, id?:number}[]} chapters
 * @param {number[]} oldDurations - included audio file durations before, in track order
 * @param {number[]} newDurations - same files after
 * @returns {{chapters: {id:number, start:number, end:number, title:string}[], maxShift: number}}
 */
function shiftChapters(chapters, oldDurations, newDurations) {
  const oldStarts = []
  const newStarts = []
  let o = 0
  let n = 0
  for (let i = 0; i < oldDurations.length; i++) {
    oldStarts.push(o)
    newStarts.push(n)
    o += oldDurations[i]
    n += newDurations[i]
  }
  const oldTotal = o
  const newTotal = n

  const mapTime = (t, isEnd) => {
    // An end time belongs to the file it closes, so look up just before it
    const probe = isEnd ? t - 1e-6 : t
    let i = oldStarts.length - 1
    while (i > 0 && oldStarts[i] > probe) i--
    const within = t - oldStarts[i]
    // Never past the end of the file it is in (or the new total for the last one)
    const fileEnd = newStarts[i] + newDurations[i]
    return Math.min(newStarts[i] + within, fileEnd, newTotal)
  }

  let maxShift = 0
  const shifted = chapters.map((ch, index) => {
    const start = Number(mapTime(ch.start, false).toFixed(3))
    let end = Number(mapTime(ch.end, true).toFixed(3))
    // A last chapter that ran to the old end runs to the new end
    if (index === chapters.length - 1 && ch.end >= oldTotal - 0.5) end = Number(newTotal.toFixed(3))
    maxShift = Math.max(maxShift, Math.abs(start - ch.start))
    return { id: index, start, end, title: ch.title }
  })
  // Keep chapters contiguous: each ends where the next starts
  for (let i = 0; i < shifted.length - 1; i++) {
    if (Math.abs(chapters[i].end - chapters[i + 1].start) < 0.001) shifted[i].end = shifted[i + 1].start
  }
  return { chapters: shifted, maxShift }
}

module.exports = {
  parseFrameHeader,
  id3v2Size,
  findFrameChain,
  readSeekHeaderTag,
  detectFromBuffer,
  detectSeekIndex,
  measureDuration,
  needsRepair,
  isMp3AudioFile,
  getTempPath,
  buildRemuxArgs,
  buildCountPacketsArgs,
  buildDecodeArgs,
  parseCountPackets,
  parseProgressSeconds,
  verifyRemux,
  runProcess,
  repairFile,
  shiftChapters
}
