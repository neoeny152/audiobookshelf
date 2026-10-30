const { expect } = require('chai')
const { Sequelize } = require('sequelize')
const sinon = require('sinon')
const http = require('http')
const os = require('os')
const Path = require('path')
const fs = require('fs')
const express = require('express')

const Database = require('../../../server/Database')
const ApiRouter = require('../../../server/routers/ApiRouter')
const ApiCacheManager = require('../../../server/managers/ApiCacheManager')
const Auth = require('../../../server/Auth')
const Logger = require('../../../server/Logger')
const SocketAuthority = require('../../../server/SocketAuthority')
const TaskManager = require('../../../server/managers/TaskManager')
const chapterbotClient = require('../../../server/utils/chapterbotClient')
const TranscriptManager = require('../../../server/managers/TranscriptManager')
const transcripts = require('../../../server/utils/transcripts')
const readAlong = require('../../../server/utils/readAlong')
const { filePathToPOSIX } = require('../../../server/utils/fileUtils')

const TOKEN = 'transcript-test-token-0123456789'

/** Fake chapterbot: /v1/transcribe answers one word per second of the requested range. */
async function startSidecar() {
  const sidecar = { requests: [], failNext: 0, status: 200 }
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null
      sidecar.requests.push({ method: req.method, url: req.url, body, auth: req.headers.authorization })
      if (req.url === '/v1/health' || req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ status: 'ok' }))
      }
      if (req.method === 'POST' && req.url === '/v1/transcribe') {
        if (sidecar.failNext > 0) {
          sidecar.failNext--
          res.writeHead(503, { 'content-type': 'application/json' })
          return res.end(JSON.stringify({ detail: 'busy' }))
        }
        if (sidecar.status !== 200) {
          res.writeHead(sidecar.status, { 'content-type': 'application/json' })
          return res.end(JSON.stringify({ detail: 'nope' }))
        }
        const results = body.ranges.map((r) => {
          const words = []
          for (let t = Math.ceil(r.start); t < r.start + r.length; t++) {
            words.push([t, t + 0.5, t % 10 === 9 ? ` w${t}.` : ` w${t}`])
          }
          return { start: r.start, length: r.length, text: words.map((w) => w[2]).join(''), words }
        })
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ model: 'small.en', results }))
      }
      res.writeHead(404)
      res.end()
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  sidecar.url = `http://127.0.0.1:${server.address().port}`
  sidecar.close = () => new Promise((resolve) => server.close(resolve))
  return sidecar
}

function until(cond, timeoutMs = 5000) {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (cond()) return resolve()
      if (Date.now() - started > timeoutMs) return reject(new Error('timed out waiting'))
      setTimeout(tick, 5)
    }
    tick()
  })
}

describe('TranscriptManager and /api/items/:id/transcripts', () => {
  let sidecar
  let apiRouter
  let server
  let base
  let reqUser
  let libraryDir
  let metadataDir
  let bookLibraryId
  let podcastLibraryId
  let bookItemId
  let podcastItemId
  let episodeId
  let adminEvents
  let fetched

  const admin = { id: 'admin-1', username: 'admin', isAdminOrUp: true, canUpdate: true, canDelete: true, checkCanAccessLibraryItem: () => true }
  const viewer = { id: 'user-2', username: 'listener', isAdminOrUp: false, canUpdate: false, canDelete: false, checkCanAccessLibraryItem: () => true }

  async function createBook(dir, durations = [700, 500]) {
    const audioFiles = durations.map((duration, i) => ({
      index: i + 1,
      ino: `bino${i}`,
      duration,
      exclude: false,
      mimeType: 'audio/mpeg',
      metadata: { filename: `part${i}.mp3`, ext: '.mp3', path: filePathToPOSIX(Path.join(dir, `part${i}.mp3`)), relPath: `part${i}.mp3` }
    }))
    for (const af of audioFiles) fs.writeFileSync(af.metadata.path, 'audio')
    const book = await Database.bookModel.create({ title: 'Book One', audioFiles, tags: [], narrators: [], genres: [], chapters: [], duration: durations.reduce((a, b) => a + b, 0) })
    const li = await Database.libraryItemModel.create({ libraryFiles: [], mediaId: book.id, mediaType: 'book', libraryId: bookLibraryId, path: filePathToPOSIX(dir), relPath: 'Book One' })
    return li.id
  }

  async function createPodcast(dir, extraData) {
    const podcast = await Database.podcastModel.create({ title: 'Pod', tags: [], genres: [], autoDownloadEpisodes: false, feedURL: 'https://example.com/feed.xml' })
    const li = await Database.libraryItemModel.create({ libraryFiles: [], mediaId: podcast.id, mediaType: 'podcast', libraryId: podcastLibraryId, path: filePathToPOSIX(dir), relPath: 'Pod' })
    const audioPath = filePathToPOSIX(Path.join(dir, 'ep1.mp3'))
    fs.writeFileSync(audioPath, 'audio')
    const episode = await Database.podcastEpisodeModel.create({
      podcastId: podcast.id,
      title: 'Episode 1',
      index: 1,
      enclosureURL: 'https://example.com/ep1.mp3',
      audioFile: { ino: 'eino1', duration: 25, metadata: { filename: 'ep1.mp3', ext: '.mp3', path: audioPath, relPath: 'ep1.mp3' } },
      extraData
    })
    return { libraryItemId: li.id, episodeId: episode.id }
  }

  beforeEach(async () => {
    global.ServerSettings = {}
    Database.sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false })
    Database.sequelize.uppercaseFirst = (str) => (str ? `${str[0].toUpperCase()}${str.substr(1)}` : '')
    await Database.buildModels()
    apiRouter = new ApiRouter({ auth: new Auth(), apiCacheManager: new ApiCacheManager() })

    sinon.stub(Logger, 'info')
    sinon.stub(Logger, 'warn')
    sinon.stub(Logger, 'error')
    sinon.stub(Logger, 'debug')
    adminEvents = []
    sinon.stub(SocketAuthority, 'adminEmitter').callsFake((evt, data) => adminEvents.push({ evt, data }))
    sinon.stub(SocketAuthority, 'emitter').callsFake((evt, data) => adminEvents.push({ evt, data, all: true }))
    sinon.stub(SocketAuthority, 'libraryItemEmitter')

    libraryDir = fs.mkdtempSync(Path.join(os.tmpdir(), 'abs-tr-lib-'))
    metadataDir = fs.mkdtempSync(Path.join(os.tmpdir(), 'abs-tr-meta-'))
    global.MetadataPath = metadataDir

    const bookLibrary = await Database.libraryModel.create({ name: 'Books', mediaType: 'book' })
    const podcastLibrary = await Database.libraryModel.create({ name: 'Podcasts', mediaType: 'podcast', settings: { ...Database.libraryModel.getDefaultLibrarySettingsForMediaType('podcast') } })
    bookLibraryId = bookLibrary.id
    podcastLibraryId = podcastLibrary.id
    fs.mkdirSync(Path.join(libraryDir, 'book'))
    fs.mkdirSync(Path.join(libraryDir, 'pod'))
    bookItemId = await createBook(Path.join(libraryDir, 'book'))
    ;({ libraryItemId: podcastItemId, episodeId } = await createPodcast(Path.join(libraryDir, 'pod'), {
      guid: 'ep-1',
      transcripts: [
        { url: 'https://example.com/ep1.vtt', type: 'text/vtt', language: 'en', rel: 'captions' },
        { url: 'https://example.com/ep1.html', type: 'text/html', language: 'en', rel: null }
      ]
    }))

    sidecar = await startSidecar()
    chapterbotClient.configure({ CHAPTERBOT_URL: sidecar.url, CHAPTERBOT_TOKEN: TOKEN, CHAPTERBOT_PATH_MAP: `${filePathToPOSIX(libraryDir)}=media` })

    TranscriptManager.reset()
    TranscriptManager.rangeSec = 300
    TranscriptManager.overlapSec = 4
    TranscriptManager.retryBaseMs = 1
    fetched = []
    TranscriptManager.fetchUrl = async (url) => {
      fetched.push(url)
      if (url.endsWith('.vtt')) return { data: Buffer.from('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<v Host>Hello from the creator\n'), contentType: 'text/vtt' }
      if (url.endsWith('.html')) return { data: Buffer.from('<p><script>x()</script>Hi <b>there</b></p>'), contentType: 'text/html' }
      throw new Error('404')
    }

    reqUser = admin
    const app = express()
    app.use(express.json())
    app.use((req, res, next) => {
      req.user = reqUser
      next()
    })
    app.use('/api', apiRouter.router)
    server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s))
    })
    base = `http://127.0.0.1:${server.address().port}/api/items`
  })

  afterEach(async () => {
    await TranscriptManager.idle()
    TranscriptManager.reset()
    TranscriptManager.fetchUrl = (url) => TranscriptManager.defaultFetch(url)
    chapterbotClient.configure({})
    sinon.restore()
    await new Promise((resolve) => server.close(resolve))
    await sidecar.close()
    fs.rmSync(libraryDir, { recursive: true, force: true })
    fs.rmSync(metadataDir, { recursive: true, force: true })
  })

  const getJson = async (url) => {
    const res = await fetch(url)
    expect(res.status, url).to.equal(200)
    return res.json()
  }

  it('lists an empty transcript list for a book without transcripts', async () => {
    const body = await getJson(`${base}/${bookItemId}/transcripts`)
    expect(body).to.deep.include({ libraryItemId: bookItemId, episodeId: null, transcripts: [], preferredId: null, canGenerate: true, job: null })
  })

  it('validates the episode id', async () => {
    expect((await fetch(`${base}/${podcastItemId}/transcripts`)).status).to.equal(400)
    expect((await fetch(`${base}/${podcastItemId}/transcripts?episodeId=nope`)).status).to.equal(404)
    expect((await fetch(`${base}/${bookItemId}/transcripts?episodeId=${episodeId}`)).status).to.equal(400)
  })

  describe('feed transcripts', () => {
    it('lists the creator transcripts of an episode and fetches them on demand', async () => {
      let body = await getJson(`${base}/${podcastItemId}/transcripts?episodeId=${episodeId}`)
      expect(body.transcripts.map((t) => [t.id, t.source, t.format, t.timed, t.downloaded, t.language])).to.deep.equal([
        ['feed-0', 'feed', 'vtt', true, false, 'en'],
        ['feed-1', 'feed', 'html', false, false, 'en']
      ])
      expect(body.preferredId).to.equal('feed-0')

      let res = await fetch(`${base}/${podcastItemId}/transcripts/feed-0?episodeId=${episodeId}`)
      expect(res.status).to.equal(200)
      expect(res.headers.get('content-type')).to.match(/^text\/vtt/)
      expect(transcripts.parseSubtitles(await res.text())).to.deep.equal([{ start: 1, end: 2, text: 'Hello from the creator', speaker: 'Host' }])

      res = await fetch(`${base}/${podcastItemId}/transcripts/feed-0?episodeId=${episodeId}&format=json`)
      expect(await res.json()).to.deep.equal({ id: 'feed-0', source: 'feed', format: 'vtt', timed: true, cues: [{ start: 1, end: 2, text: 'Hello from the creator', speaker: 'Host' }] })

      // cached: fetched only once
      await fetch(`${base}/${podcastItemId}/transcripts/feed-0?episodeId=${episodeId}`)
      expect(fetched).to.deep.equal(['https://example.com/ep1.vtt'])
      body = await getJson(`${base}/${podcastItemId}/transcripts?episodeId=${episodeId}`)
      expect(body.transcripts[0].downloaded).to.equal(true)
      expect(fs.existsSync(Path.join(metadataDir, 'items', podcastItemId, 'transcripts', `${episodeId}.feed-0.vtt`))).to.equal(true)
      // nothing written next to the audio
      expect(fs.readdirSync(Path.join(libraryDir, 'pod'))).to.deep.equal(['ep1.mp3'])
    })

    it('serves an HTML transcript as plain text, and the original only as a sandboxed download', async () => {
      let res = await fetch(`${base}/${podcastItemId}/transcripts/feed-1?episodeId=${episodeId}`)
      expect(res.headers.get('content-type')).to.match(/^text\/plain/)
      expect(await res.text()).to.equal('Hi there')
      res = await fetch(`${base}/${podcastItemId}/transcripts/feed-1?episodeId=${episodeId}&format=original`)
      expect(res.status).to.equal(200)
      expect(res.headers.get('content-disposition')).to.match(/^attachment/)
      expect(res.headers.get('content-security-policy')).to.include('sandbox')
      expect(res.headers.get('x-content-type-options')).to.equal('nosniff')
    })

    it('answers 502 when the feed transcript cannot be downloaded or read, and 404 for unknown ids', async () => {
      TranscriptManager.fetchUrl = async () => ({ data: Buffer.from('not a subtitle file'), contentType: 'text/vtt' })
      expect((await fetch(`${base}/${podcastItemId}/transcripts/feed-0?episodeId=${episodeId}`)).status).to.equal(502)
      TranscriptManager.reset()
      TranscriptManager.fetchUrl = async () => {
        throw new Error('ECONNREFUSED')
      }
      expect((await fetch(`${base}/${podcastItemId}/transcripts/feed-0?episodeId=${episodeId}`)).status).to.equal(502)
      expect((await fetch(`${base}/${podcastItemId}/transcripts/feed-7?episodeId=${episodeId}`)).status).to.equal(404)
      expect((await fetch(`${base}/${podcastItemId}/transcripts/bogus?episodeId=${episodeId}`)).status).to.equal(404)
      expect((await fetch(`${base}/${podcastItemId}/transcripts/feed-0?episodeId=${episodeId}&format=exe`)).status).to.equal(400)
    })

    it('does not download a failed feed transcript again for a few minutes', async () => {
      const realNow = TranscriptManager.now
      TranscriptManager.fetchUrl = async (url) => {
        fetched.push(url)
        throw new Error('ECONNREFUSED')
      }
      try {
        expect((await fetch(`${base}/${podcastItemId}/transcripts/feed-0?episodeId=${episodeId}`)).status).to.equal(502)
        expect((await fetch(`${base}/${podcastItemId}/transcripts/feed-0?episodeId=${episodeId}`)).status).to.equal(502)
        expect(fetched).to.have.length(1)
        TranscriptManager.now = () => realNow() + 10 * 60 * 1000
        expect((await fetch(`${base}/${podcastItemId}/transcripts/feed-0?episodeId=${episodeId}`)).status).to.equal(502)
        expect(fetched).to.have.length(2)
      } finally {
        TranscriptManager.now = realNow
      }
    })

    it('downloads feed transcripts with a new episode when the library setting is on', async () => {
      const library = await Database.libraryModel.findByPk(podcastLibraryId)
      library.settings = { ...library.settings, downloadPodcastTranscripts: true }
      library.changed('settings', true)
      await library.save()
      const li = await Database.libraryItemModel.getExpandedById(podcastItemId)
      await TranscriptManager.onEpisodeDownloaded(li, li.media.podcastEpisodes[0])
      expect(fetched.sort()).to.deep.equal(['https://example.com/ep1.html', 'https://example.com/ep1.vtt'])
      // a timed creator transcript exists: no auto transcription even if it were on
      expect(TranscriptManager.getJob(podcastItemId, episodeId)).to.equal(null)
    })

    it('stores the feed tags when the episode is created from RSS', async () => {
      const podcast = await Database.podcastModel.create({ title: 'P2', tags: [], genres: [] })
      const ep = await Database.podcastEpisodeModel.createFromRssPodcastEpisode({ title: 'x', enclosure: { url: 'https://e/x.mp3' }, guid: 'g', transcripts: [{ url: 'https://e/x.srt', type: 'application/x-subrip' }, { url: 'ftp://bad' }] }, podcast.id, { toJSON: () => ({ ino: '1', metadata: { path: '/x.mp3' } }), chapters: [] })
      expect(ep.extraData).to.deep.equal({ guid: 'g', transcripts: [{ url: 'https://e/x.srt', type: 'application/x-subrip', language: null, rel: null }] })
    })
  })

  describe('local sidecars', () => {
    it('merges per-file sidecars onto the book timeline', async () => {
      fs.writeFileSync(Path.join(libraryDir, 'book', 'part1.vtt'), 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nsecond file\n')
      const body = await getJson(`${base}/${bookItemId}/transcripts`)
      expect(body.transcripts.map((t) => [t.id, t.source, t.format, t.fileCount])).to.deep.equal([['local', 'local', 'vtt', 1]])
      expect(body.preferredId).to.equal('local')
      const json = await getJson(`${base}/${bookItemId}/transcripts/local?format=json`)
      expect(json.cues).to.deep.equal([{ start: 701, end: 702, text: 'second file' }])
    })
  })

  describe('generated transcripts', () => {
    it('only admins can generate, cancel, delete and refresh', async () => {
      reqUser = viewer
      const post = (path, body) => fetch(`${base}/${bookItemId}/transcripts/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
      expect((await post('generate')).status).to.equal(403)
      reqUser = { ...viewer, canUpdate: true, canDelete: true }
      expect((await post('generate')).status).to.equal(403)
      expect((await post('refresh-feed')).status).to.equal(403)
      expect((await fetch(`${base}/${bookItemId}/transcripts/job`, { method: 'DELETE' })).status).to.equal(403)
      expect((await fetch(`${base}/${bookItemId}/transcripts/generated`, { method: 'DELETE' })).status).to.equal(403)
      // and they do not see the job or the generate option, which is not worked out for them
      const canGenerateFor = sinon.spy(TranscriptManager, 'canGenerateFor')
      const body = await getJson(`${base}/${bookItemId}/transcripts`)
      expect(body.canGenerate).to.equal(false)
      expect(canGenerateFor.called).to.equal(false)
      expect(sidecar.requests.filter((r) => r.url === '/v1/transcribe')).to.have.length(0)
    })

    it('transcribes a book in overlapping ranges through chapterbot and stores a WebVTT in the metadata folder', async () => {
      sidecar.failNext = 1 // one transient 503 is retried
      const res = await fetch(`${base}/${bookItemId}/transcripts/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      expect(res.status).to.equal(202)
      const started = (await res.json()).job
      expect(started).to.include({ libraryItemId: bookItemId, episodeId: null })
      expect(started.status).to.be.oneOf(['queued', 'running'])
      await TranscriptManager.idle()

      const job = TranscriptManager.getJob(bookItemId, null)
      expect(job).to.include({ status: 'done', progress: 1, generatedFrom: 'transcribe' })
      const calls = sidecar.requests.filter((r) => r.url === '/v1/transcribe')
      expect(calls[0].auth).to.equal(`Bearer ${TOKEN}`)
      expect(calls[0].body.files).to.deep.equal([
        { path: 'media/book/part0.mp3', offset: 0, duration: 700 },
        { path: 'media/book/part1.mp3', offset: 700, duration: 500 }
      ])
      const ranges = calls.slice(1).map((c) => c.body.ranges[0])
      expect(ranges[0]).to.deep.equal({ start: 0, length: 300 })
      expect(ranges[ranges.length - 1].start + ranges[ranges.length - 1].length).to.equal(1200)

      const json = await getJson(`${base}/${bookItemId}/transcripts/generated?format=json`)
      const words = json.cues.flatMap((c) => c.text.split(' '))
      // every second exactly once, across range edges
      expect(words).to.deep.equal(Array.from({ length: 1200 }, (_, t) => (t % 10 === 9 ? `w${t}.` : `w${t}`)))
      expect(fs.existsSync(Path.join(metadataDir, 'items', bookItemId, 'transcripts', 'book.generated.vtt'))).to.equal(true)
      expect(fs.readdirSync(Path.join(libraryDir, 'book')).sort()).to.deep.equal(['part0.mp3', 'part1.mp3'])

      const list = await getJson(`${base}/${bookItemId}/transcripts`)
      expect(list.transcripts.map((t) => [t.id, t.model, t.generatedFrom])).to.deep.equal([['generated', 'small.en', 'transcribe']])
      expect(list.preferredId).to.equal('generated')

      expect(adminEvents.some((e) => e.evt === 'task_progress' && e.data.libraryItemId === bookItemId)).to.equal(true)
      expect(adminEvents.some((e) => e.evt === 'transcript_updated' && e.all)).to.equal(true)
      expect(TaskManager.tasks.find((t) => t.action === 'generate-transcript')).to.equal(undefined)

      // delete
      expect((await fetch(`${base}/${bookItemId}/transcripts/generated`, { method: 'DELETE' })).status).to.equal(200)
      expect((await getJson(`${base}/${bookItemId}/transcripts`)).transcripts).to.deep.equal([])
      expect((await fetch(`${base}/${bookItemId}/transcripts/generated`, { method: 'DELETE' })).status).to.equal(404)
    })

    it('transcribes a podcast episode, and refuses a second job for the same episode', async () => {
      const post = () => fetch(`${base}/${podcastItemId}/transcripts/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ episodeId }) })
      expect((await post()).status).to.equal(202)
      expect((await post()).status).to.equal(409)
      await TranscriptManager.idle()
      const list = await getJson(`${base}/${podcastItemId}/transcripts?episodeId=${episodeId}`)
      expect(list.transcripts.map((t) => t.id)).to.deep.equal(['feed-0', 'feed-1', 'generated'])
      // the creator's timed transcript stays preferred
      expect(list.preferredId).to.equal('feed-0')
      const calls = sidecar.requests.filter((r) => r.url === '/v1/transcribe')
      expect(calls[0].body.files).to.deep.equal([{ path: 'media/pod/ep1.mp3', offset: 0, duration: 25 }])
    })

    it('reuses the read-along data of an EPUB made from the audio instead of transcribing', async () => {
      const archiver = require('../../../server/libs/archiver')
      const epubPath = Path.join(libraryDir, 'book', 'Book One (from audio).epub')
      await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(epubPath)
        const archive = archiver('zip')
        out.on('close', resolve)
        archive.on('error', reject)
        archive.pipe(out)
        archive.append('<html><body><p><span id="s1">Once upon a time.</span> <span id="s2">The end.</span></p></body></html>', { name: 'OEBPS/ch001.xhtml' })
        archive.finalize()
      })
      const ino = String(fs.statSync(epubPath, { bigint: true }).ino)
      const li = await Database.libraryItemModel.getExpandedById(bookItemId)
      li.libraryFiles = [{ ino, fileType: 'ebook', isSupplementary: false, metadata: { filename: Path.basename(epubPath), ext: '.epub', path: filePathToPOSIX(epubPath), relPath: Path.basename(epubPath) } }]
      li.changed('libraryFiles', true)
      await li.save()
      await readAlong.save(bookItemId, ino, Path.basename(epubPath), {
        kind: 'abs-readalong',
        version: 1,
        identifier: 'urn:x',
        modified: '2026-10-28T00:00:00Z',
        audioDuration: 1200,
        model: 'medium.en',
        sections: [{ href: 'OEBPS/ch001.xhtml' }],
        sentences: [
          { id: 's1', sec: 0, start: 3, end: 5 },
          { id: 's2', sec: 0, start: 6, end: 7 }
        ]
      })

      expect((await fetch(`${base}/${bookItemId}/transcripts/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).to.equal(202)
      await TranscriptManager.idle()
      expect(TranscriptManager.getJob(bookItemId, null)).to.include({ status: 'done', generatedFrom: 'readalong' })
      expect(sidecar.requests.filter((r) => r.url === '/v1/transcribe')).to.have.length(0)
      const json = await getJson(`${base}/${bookItemId}/transcripts/generated?format=json`)
      expect(json.cues).to.deep.equal([
        { start: 3, end: 5, text: 'Once upon a time.' },
        { start: 6, end: 7, text: 'The end.' }
      ])
      const list = await getJson(`${base}/${bookItemId}/transcripts`)
      expect(list.transcripts[0]).to.include({ model: 'medium.en', generatedFrom: 'readalong' })

      // method transcribe forces a new transcription
      expect((await fetch(`${base}/${bookItemId}/transcripts/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"method":"transcribe"}' })).status).to.equal(202)
      await TranscriptManager.idle()
      expect(TranscriptManager.getJob(bookItemId, null)).to.include({ status: 'done', generatedFrom: 'transcribe' })

      // without chapterbot a book with read-along data can still be generated, an episode cannot
      chapterbotClient.configure({})
      expect((await getJson(`${base}/${bookItemId}/transcripts`)).canGenerate).to.equal(true)
      expect((await getJson(`${base}/${podcastItemId}/transcripts?episodeId=${episodeId}`)).canGenerate).to.equal(false)
      const refused = await fetch(`${base}/${podcastItemId}/transcripts/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ episodeId }) })
      expect(refused.status).to.equal(400)
      expect(await refused.text()).to.match(/needs chapterbot/)
      expect((await fetch(`${base}/${bookItemId}/transcripts/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).to.equal(202)
      await TranscriptManager.idle()
      expect(TranscriptManager.getJob(bookItemId, null)).to.include({ status: 'done', generatedFrom: 'readalong' })
    })

    it('lists canGenerate false without chapterbot when a book has no read-along data', async () => {
      chapterbotClient.configure({})
      expect((await getJson(`${base}/${bookItemId}/transcripts`)).canGenerate).to.equal(false)
    })

    it('forgets finished jobs after an hour, and a retry wait ends at once on cancel', async () => {
      TranscriptManager.start(await Database.libraryItemModel.getExpandedById(bookItemId), null, admin)
      await TranscriptManager.idle()
      expect(TranscriptManager.jobs.size).to.equal(1)
      const realNow = TranscriptManager.now
      TranscriptManager.now = () => realNow() + 2 * 60 * 60 * 1000
      try {
        TranscriptManager.pruneFinished()
        expect(TranscriptManager.jobs.size).to.equal(0)
      } finally {
        TranscriptManager.now = realNow
      }

      const controller = new AbortController()
      const waiting = TranscriptManager.sleep(60000, controller.signal)
      controller.abort()
      let error = null
      await waiting.catch((e) => (error = e))
      expect(error?.message).to.equal('aborted')
      const aborted = new AbortController()
      aborted.abort()
      let early = null
      await TranscriptManager.sleep(60000, aborted.signal).catch((e) => (early = e))
      expect(early?.message).to.equal('aborted')
    })

    it('fails cleanly when the sidecar refuses, and reports a sidecar without /v1/transcribe', async () => {
      sidecar.status = 422
      TranscriptManager.start(await Database.libraryItemModel.getExpandedById(bookItemId), null, admin)
      await TranscriptManager.idle()
      expect(TranscriptManager.getJob(bookItemId, null)).to.include({ status: 'failed' })
      expect(TranscriptManager.getJob(bookItemId, null).error).to.match(/Chapterbot could not transcribe/)

      sidecar.status = 404
      TranscriptManager.start(await Database.libraryItemModel.getExpandedById(bookItemId), null, admin)
      await TranscriptManager.idle()
      expect(TranscriptManager.getJob(bookItemId, null).error).to.match(/too old/)
      expect(await transcripts.readGeneratedMeta(bookItemId, null)).to.equal(null)
    })

    it('cancels a queued job and a running one', async () => {
      const book = await Database.libraryItemModel.getExpandedById(bookItemId)
      const pod = await Database.libraryItemModel.getExpandedById(podcastItemId)
      let release
      const gate = new Promise((resolve) => (release = resolve))
      const transcribe = sinon.stub(chapterbotClient, 'transcribe').callsFake(async ({ signal }) => {
        await Promise.race([gate, new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))))])
        return { model: 'm', results: [] }
      })
      TranscriptManager.start(book, null, admin)
      TranscriptManager.start(pod, episodeId, admin)
      expect(TranscriptManager.getJob(podcastItemId, episodeId).status).to.equal('queued')
      expect((await fetch(`${base}/${podcastItemId}/transcripts/job?episodeId=${episodeId}`, { method: 'DELETE' })).status).to.equal(200)
      expect(TranscriptManager.getJob(podcastItemId, episodeId).status).to.equal('cancelled')

      await until(() => transcribe.called)
      expect((await fetch(`${base}/${bookItemId}/transcripts/job`, { method: 'DELETE' })).status).to.equal(200)
      await TranscriptManager.idle()
      expect(TranscriptManager.getJob(bookItemId, null).status).to.equal('cancelled')
      expect((await fetch(`${base}/${bookItemId}/transcripts/job`, { method: 'DELETE' })).status).to.equal(404)
      release()
    })

    it('auto-transcribes a new episode without a timed creator transcript when the library setting is on', async () => {
      const library = await Database.libraryModel.findByPk(podcastLibraryId)
      library.settings = { ...library.settings, autoTranscribePodcastEpisodes: true }
      library.changed('settings', true)
      await library.save()
      const li = await Database.libraryItemModel.getExpandedById(podcastItemId)
      const episode = li.media.podcastEpisodes[0]
      episode.extraData = { guid: 'ep-1', transcripts: [{ url: 'https://example.com/ep1.html', type: 'text/html' }] }
      episode.changed('extraData', true)
      await episode.save()
      await TranscriptManager.onEpisodeDownloaded(li, episode)
      await TranscriptManager.idle()
      expect(TranscriptManager.getJob(podcastItemId, episodeId)).to.include({ status: 'done', origin: 'auto' })
    })
  })

  describe('refresh from feed', () => {
    it('stores the tags of the matching episodes', async () => {
      const podcastUtils = require('../../../server/utils/podcastUtils')
      sinon.stub(podcastUtils, 'getPodcastFeed').resolves({
        episodes: [{ guid: 'ep-1', enclosure: { url: 'https://example.com/ep1.mp3' }, transcripts: [{ url: 'https://example.com/new.json', type: 'application/json', language: 'de', rel: null }] }]
      })
      // a cached copy of the old list goes away
      fs.mkdirSync(transcripts.dir(podcastItemId), { recursive: true })
      fs.writeFileSync(transcripts.feedCachePath(podcastItemId, episodeId, 0, 'vtt'), 'WEBVTT\n')
      const res = await fetch(`${base}/${podcastItemId}/transcripts/refresh-feed`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      expect(await res.json()).to.deep.equal({ updated: 1, withTranscripts: 1 })
      const list = await getJson(`${base}/${podcastItemId}/transcripts?episodeId=${episodeId}`)
      expect(list.transcripts.map((t) => [t.id, t.format, t.language, t.downloaded])).to.deep.equal([['feed-0', 'json', 'de', false]])
      expect((await fetch(`${base}/${bookItemId}/transcripts/refresh-feed`, { method: 'POST' })).status).to.equal(400)
    })
  })
})
