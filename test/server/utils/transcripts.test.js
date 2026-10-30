const { expect } = require('chai')
const os = require('os')
const Path = require('path')
const fs = require('fs')

const transcripts = require('../../../server/utils/transcripts')
const { parsePodcastRssFeedXml } = require('../../../server/utils/podcastUtils')

const ITEM_ID = '0f6d1d5e-1111-4c4b-9a65-0f3f4c1d2e3f'

describe('transcripts utils', () => {
  describe('formatFromType', () => {
    it('maps the MIME types of the podcast namespace', () => {
      expect(transcripts.formatFromType('text/vtt')).to.equal('vtt')
      expect(transcripts.formatFromType('application/x-subrip')).to.equal('srt')
      expect(transcripts.formatFromType('application/srt')).to.equal('srt')
      expect(transcripts.formatFromType('application/json')).to.equal('json')
      expect(transcripts.formatFromType('text/html; charset=utf-8')).to.equal('html')
      expect(transcripts.formatFromType('text/plain')).to.equal('txt')
    })

    it('falls back to the extension of the URL or path', () => {
      expect(transcripts.formatFromType(null, 'https://example.com/ep1.srt?x=1')).to.equal('srt')
      expect(transcripts.formatFromType('application/octet-stream', 'https://example.com/ep1.vtt')).to.equal('vtt')
      expect(transcripts.formatFromType(undefined, '/data/ep 1.htm')).to.equal('html')
      expect(transcripts.formatFromType('audio/mpeg', 'https://example.com/ep1.mp3')).to.equal(null)
    })
  })

  describe('feed transcript tags', () => {
    it('keeps valid http(s) tags of readable formats, drops the rest and duplicates', () => {
      const out = transcripts.normalizeFeedTranscripts([
        { url: ' https://example.com/t.vtt ', type: 'text/vtt', language: 'en', rel: 'captions' },
        { url: 'https://example.com/t.vtt', type: 'text/vtt' },
        { url: 'javascript:alert(1)', type: 'text/vtt' },
        { url: 'file:///etc/passwd', type: 'text/plain' },
        { url: 'https://example.com/t.bin', type: 'application/octet-stream' },
        { url: 'https://example.com/t.json', type: 'application/json', language: 'x'.repeat(200) },
        null,
        'nope'
      ])
      expect(out).to.have.length(2)
      expect(out[0]).to.deep.equal({ url: 'https://example.com/t.vtt', type: 'text/vtt', language: 'en', rel: 'captions' })
      expect(out[1].language).to.have.length(64)
      expect(transcripts.normalizeFeedTranscripts(undefined)).to.deep.equal([])
    })

    it('caps the number of tags kept', () => {
      const many = Array.from({ length: 30 }, (_, i) => ({ url: `https://example.com/${i}.vtt`, type: 'text/vtt' }))
      expect(transcripts.normalizeFeedTranscripts(many)).to.have.length(transcripts.MAX_FEED_TRANSCRIPTS)
    })

    it('parses <podcast:transcript> from an RSS feed into the episodes (additive field)', async () => {
      const xml = `<?xml version="1.0"?>
<rss version="2.0" xmlns:podcast="https://podcastindex.org/namespace/1.0">
  <channel>
    <title>Show</title>
    <item>
      <title>Ep 1</title>
      <guid>ep-1</guid>
      <enclosure url="https://example.com/ep1.mp3" type="audio/mpeg" length="1" />
      <podcast:transcript url="https://example.com/ep1.vtt" type="text/vtt" language="en" rel="captions" />
      <podcast:transcript url="https://example.com/ep1.html" type="text/html" />
    </item>
    <item>
      <title>Ep 2</title>
      <enclosure url="https://example.com/ep2.mp3" type="audio/mpeg" length="1" />
    </item>
  </channel>
</rss>`
      const { podcast } = await parsePodcastRssFeedXml(xml)
      expect(podcast.episodes[0].transcripts).to.deep.equal([
        { url: 'https://example.com/ep1.vtt', type: 'text/vtt', language: 'en', rel: 'captions' },
        { url: 'https://example.com/ep1.html', type: 'text/html', language: null, rel: null }
      ])
      expect(podcast.episodes[1].transcripts).to.deep.equal([])
      // existing fields are unchanged
      expect(podcast.episodes[0].guid).to.equal('ep-1')
      expect(podcast.episodes[0].enclosure.url).to.equal('https://example.com/ep1.mp3')
    })
  })

  describe('timestamps', () => {
    it('parses VTT and SRT timestamps', () => {
      expect(transcripts.parseTimestamp('00:00:01.500')).to.equal(1.5)
      expect(transcripts.parseTimestamp('01:02:03,004')).to.equal(3723.004)
      expect(transcripts.parseTimestamp('02:03.4')).to.equal(123.4)
      expect(transcripts.parseTimestamp('nope')).to.equal(null)
    })

    it('formats as HH:MM:SS.mmm', () => {
      expect(transcripts.formatTimestamp(0)).to.equal('00:00:00.000')
      expect(transcripts.formatTimestamp(3723.0045)).to.equal('01:02:03.005')
      expect(transcripts.formatTimestamp(-3)).to.equal('00:00:00.000')
    })
  })

  describe('parseSubtitles', () => {
    it('reads WebVTT with header, notes, cue ids, settings and voice tags', () => {
      const vtt = `﻿WEBVTT Kind: captions

NOTE a note
with two lines

1
00:00:01.000 --> 00:00:03.500 align:start
<v Alice>Hello &amp; welcome</v>

00:00:04.000 --> 00:00:06.000
second <b>line</b>
continued
`
      expect(transcripts.parseSubtitles(vtt)).to.deep.equal([
        { start: 1, end: 3.5, text: 'Hello & welcome', speaker: 'Alice' },
        { start: 4, end: 6, text: 'second line\ncontinued' }
      ])
    })

    it('reads SRT with CRLF line ends', () => {
      const srt = '1\r\n00:00:01,000 --> 00:00:02,000\r\nOne\r\n\r\n2\r\n00:00:02,500 --> 00:00:04,000\r\nTwo\r\n'
      expect(transcripts.parseSubtitles(srt)).to.deep.equal([
        { start: 1, end: 2, text: 'One' },
        { start: 2.5, end: 4, text: 'Two' }
      ])
    })

    it('ends a cue at a separator line that holds only spaces', () => {
      const srt = '1\n00:00:01,000 --> 00:00:02,000\nOne\n  \n2\n00:00:02,500 --> 00:00:04,000\nTwo\n\t\n\n3\n00:00:05,000 --> 00:00:06,000\nThree\n'
      expect(transcripts.parseSubtitles(srt)).to.deep.equal([
        { start: 1, end: 2, text: 'One' },
        { start: 2.5, end: 4, text: 'Two' },
        { start: 5, end: 6, text: 'Three' }
      ])
    })

    it('round-trips through buildVtt, escaping markup in cue text', () => {
      const cues = [
        { start: 0, end: 1.25, text: 'a <script> & --> b', speaker: 'Bob' },
        { start: 2, end: 3, text: 'plain' }
      ]
      const vtt = transcripts.buildVtt(cues, ['made --> here'])
      expect(vtt.startsWith('WEBVTT\n\nNOTE made -> here\n\n')).to.be.true
      expect(vtt).to.include('a &lt;script&gt; &amp; --&gt; b')
      expect(vtt).to.not.include('<script>')
      expect(transcripts.parseSubtitles(vtt)).to.deep.equal(cues)
    })
  })

  describe('parseJsonTranscript', () => {
    it('reads Podcast Index JSON segments', () => {
      const json = JSON.stringify({
        version: '1.0.0',
        segments: [
          { speaker: 'Host', startTime: 0.5, endTime: 3, body: 'Welcome to the show.' },
          { speaker: 'Guest', startTime: 3.2, endTime: 5, body: 'Thanks for having me.' },
          { startTime: 'x', body: 'bad' }
        ]
      })
      expect(transcripts.parseJsonTranscript(json)).to.deep.equal([
        { start: 0.5, end: 3, text: 'Welcome to the show.', speaker: 'Host' },
        { start: 3.2, end: 5, text: 'Thanks for having me.', speaker: 'Guest' }
      ])
    })

    it('groups word-level segments into cues per speaker', () => {
      const words = 'This is a test. It works well enough for now.'.split(' ')
      const segments = words.map((w, i) => ({ speaker: i < 4 ? 'A' : 'B', startTime: i * 0.4, endTime: i * 0.4 + 0.3, body: w }))
      const cues = transcripts.parseJsonTranscript({ segments })
      expect(cues.map((c) => [c.speaker, c.text])).to.deep.equal([
        ['A', 'This is a test.'],
        ['B', 'It works well enough for now.']
      ])
    })

    it('rejects invalid JSON', () => {
      expect(() => transcripts.parseJsonTranscript('{')).to.throw(transcripts.TranscriptError)
      expect(() => transcripts.parseJsonTranscript('{}')).to.throw(transcripts.TranscriptError)
    })
  })

  describe('parseTranscript', () => {
    it('turns HTML into plain text and never keeps markup', () => {
      const out = transcripts.parseTranscript('<html><script>alert(1)</script><p><cite>Host:</cite> Hi &amp; bye</p><p>Line<br>two</p></html>', 'html')
      expect(out.timed).to.be.false
      expect(out.text).to.equal('Host: Hi & bye\nLine\ntwo')
    })

    it('reads plain text and rejects unknown formats', () => {
      expect(transcripts.parseTranscript('﻿hello\r\nworld\n', 'txt')).to.deep.equal({ timed: false, text: 'hello\nworld' })
      expect(() => transcripts.parseTranscript('x', 'doc')).to.throw(transcripts.TranscriptError)
    })
  })

  describe('cuesFromWords', () => {
    it('ends cues after sentences, at long pauses and when they get too long', () => {
      const words = []
      let t = 0
      const say = (text, gap = 0.1) => {
        for (const w of text.split(' ')) {
          words.push([t, t + 0.3, ` ${w}`])
          t += 0.3 + gap
        }
      }
      say('This is the first sentence of the test.')
      say('Short.')
      t += 3
      say('After a long pause we start a new cue')
      const cues = transcripts.cuesFromWords(words)
      expect(cues.map((c) => c.text)).to.deep.equal(['This is the first sentence of the test.', 'Short.', 'After a long pause we start a new cue'])
      expect(cues[0].start).to.equal(0)
      for (const cue of cues) expect(cue.end).to.be.at.least(cue.start)
    })

    it('splits a run-on stream at the length limit', () => {
      const words = Array.from({ length: 100 }, (_, i) => [i * 0.2, i * 0.2 + 0.15, 'word'])
      const cues = transcripts.cuesFromWords(words)
      expect(cues.length).to.be.greaterThan(5)
      for (const cue of cues) {
        expect(cue.text.length).to.be.at.most(90)
        expect(cue.end - cue.start).to.be.at.most(7.5)
      }
    })

    it('ignores empty and malformed words', () => {
      expect(transcripts.cuesFromWords([[0, 1, '  '], [1, 2], 'x', [NaN, 1, 'a']])).to.deep.equal([])
    })
  })

  describe('ranges', () => {
    it('plans overlapping ranges that cover the whole audio', () => {
      const ranges = transcripts.planRanges(1000, 300, 4)
      expect(ranges[0]).to.deep.equal({ start: 0, length: 300 })
      expect(ranges[1].start).to.equal(296)
      const last = ranges[ranges.length - 1]
      expect(last.start + last.length).to.equal(1000)
      expect(transcripts.planRanges(0, 300, 4)).to.deep.equal([])
      expect(transcripts.planRanges(100, 300, 4)).to.deep.equal([{ start: 0, length: 100 }])
    })

    it('joins words of overlapping ranges without duplicates', () => {
      const results = [
        {
          start: 0,
          length: 10,
          words: [
            [1, 1.5, 'a'],
            [7.9, 8.2, 'b'],
            [9.1, 9.5, 'c'],
            [9.8, 10, 'cu']
          ]
        },
        {
          start: 8,
          length: 10,
          words: [
            [8.0, 8.2, 'b'],
            [9.1, 9.5, 'c'],
            [9.8, 10.2, 'cut'],
            [12, 12.5, 'd']
          ]
        }
      ]
      // overlap 8..10, midpoint 9: words before 9 from the first range, from 9 on from the second
      expect(transcripts.joinRangeWords(results).map((w) => w[2])).to.deep.equal(['a', 'b', 'c', 'cut', 'd'])
    })
  })

  describe('read-along reuse', () => {
    it('builds cues from read-along sentences and EPUB texts, splitting long timed sentences', () => {
      const long = 'This sentence is long enough that it should be split into more than one cue when word timings are there for it.'
      const tokens = long.split(' ')
      const data = {
        sentences: [
          { id: 's2', sec: 0, start: 5, end: 9 },
          { id: 's1', sec: 0, start: 1, end: 4 },
          { id: 's3', sec: 0, start: 10, end: 10 + tokens.length * 0.3, w: tokens.map((_, i) => [10 + i * 0.3, 10 + i * 0.3 + 0.25]) },
          { id: 's4', sec: 0, start: 40, end: 41 }
        ]
      }
      const texts = new Map([
        ['s1', 'First.'],
        ['s2', ' Second   one. '],
        ['s3', long]
      ])
      const cues = transcripts.cuesFromReadAlong(data, texts)
      expect(cues[0]).to.deep.equal({ start: 1, end: 4, text: 'First.' })
      expect(cues[1]).to.deep.equal({ start: 5, end: 9, text: 'Second one.' })
      expect(cues.length).to.be.greaterThan(3)
      expect(
        cues
          .slice(2)
          .map((c) => c.text)
          .join(' ')
      ).to.equal(long)
    })

    it('reads sentence texts from an EPUB made by chapterbot', async () => {
      const archiver = require('../../../server/libs/archiver')
      const tmp = fs.mkdtempSync(Path.join(os.tmpdir(), 'abs-transcripts-epub-'))
      const epubPath = Path.join(tmp, 'book.epub')
      await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(epubPath)
        const archive = archiver('zip')
        out.on('close', resolve)
        archive.on('error', reject)
        archive.pipe(out)
        archive.append('application/epub+zip', { name: 'mimetype' })
        archive.append('<html><body><h2>Ch 1</h2><p><span id="s1">Hello &amp; welcome.</span> <span id="s2">It&#8217;s <i>here</i>.</span></p></body></html>', { name: 'OEBPS/ch001.xhtml' })
        archive.append('<html><body><p><span id="s3">Last one.</span></p></body></html>', { name: 'OEBPS/ch002.xhtml' })
        archive.finalize()
      })
      try {
        const texts = await transcripts.readEpubSentenceTexts(epubPath)
        expect([...texts.entries()]).to.deep.equal([
          ['s1', 'Hello & welcome.'],
          ['s2', 'It’s here.'],
          ['s3', 'Last one.']
        ])
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true })
      }
    })
  })

  it('moves per-file sidecar cues onto the book timeline', () => {
    const merged = transcripts.mergeTrackCues([
      { offset: 0, duration: 10, cues: [{ start: 1, end: 2, text: 'a' }] },
      {
        offset: 10,
        duration: 10,
        cues: [
          { start: 0.5, end: 1, text: 'b' },
          { start: 50, end: 51, text: 'past the end' }
        ]
      }
    ])
    expect(merged).to.deep.equal([
      { start: 1, end: 2, text: 'a' },
      { start: 10.5, end: 11, text: 'b' }
    ])
  })

  it('prefers a timed creator transcript, then local, then generated, then untimed', () => {
    const t = (id, source, format, timed) => ({ id, source, format, timed })
    expect(transcripts.preferredTranscriptId([t('generated', 'generated', 'vtt', true), t('feed-0', 'feed', 'html', false), t('feed-1', 'feed', 'srt', true), t('feed-2', 'feed', 'vtt', true)])).to.equal('feed-2')
    expect(transcripts.preferredTranscriptId([t('generated', 'generated', 'vtt', true), t('local', 'local', 'srt', true)])).to.equal('local')
    expect(transcripts.preferredTranscriptId([t('generated', 'generated', 'vtt', true), t('feed-0', 'feed', 'html', false)])).to.equal('generated')
    expect(transcripts.preferredTranscriptId([t('feed-0', 'feed', 'html', false)])).to.equal('feed-0')
    expect(transcripts.preferredTranscriptId([])).to.equal(null)
  })

  describe('storage', () => {
    let tmp
    let previousMetadataPath
    beforeEach(() => {
      previousMetadataPath = global.MetadataPath
      tmp = fs.mkdtempSync(Path.join(os.tmpdir(), 'abs-transcripts-'))
      global.MetadataPath = tmp
    })
    afterEach(() => {
      global.MetadataPath = previousMetadataPath
      fs.rmSync(tmp, { recursive: true, force: true })
    })

    it('stores generated transcripts in the metadata folder, not the library', async () => {
      const cues = [{ start: 0, end: 1, text: 'hi' }]
      await transcripts.saveGenerated(ITEM_ID, null, cues, { source: 'transcribe', model: 'small.en' })
      const meta = await transcripts.readGeneratedMeta(ITEM_ID, null)
      expect(meta.path).to.equal(Path.join(tmp, 'items', ITEM_ID, 'transcripts', 'book.generated.vtt'))
      expect(meta.model).to.equal('small.en')
      expect(meta.from).to.equal('transcribe')
      expect(transcripts.parseSubtitles(fs.readFileSync(meta.path, 'utf8'))).to.deep.equal(cues)
      expect(await transcripts.removeGenerated(ITEM_ID, null)).to.be.true
      expect(await transcripts.readGeneratedMeta(ITEM_ID, null)).to.equal(null)
      expect(await transcripts.removeGenerated(ITEM_ID, null)).to.be.false
    })

    it('rejects ids that could leave the folder', () => {
      expect(() => transcripts.dir('../etc')).to.throw(transcripts.TranscriptError)
      expect(() => transcripts.keyFor('../../x')).to.throw(transcripts.TranscriptError)
      expect(() => transcripts.keyFor('book')).to.throw(transcripts.TranscriptError)
      expect(() => transcripts.feedCachePath(ITEM_ID, 'ep1', 99, 'vtt')).to.throw(transcripts.TranscriptError)
      expect(() => transcripts.feedCachePath(ITEM_ID, 'ep1', 0, 'exe')).to.throw(transcripts.TranscriptError)
    })

    it('removes every stored file of an episode only', async () => {
      const folder = transcripts.dir(ITEM_ID)
      fs.mkdirSync(folder, { recursive: true })
      for (const name of ['ep1.generated.vtt', 'ep1.feed-0.vtt', 'ep10.generated.vtt', 'book.generated.vtt']) fs.writeFileSync(Path.join(folder, name), 'x')
      await transcripts.removeEpisodeFiles(ITEM_ID, 'ep1')
      expect(fs.readdirSync(folder).sort()).to.deep.equal(['book.generated.vtt', 'ep10.generated.vtt'])
    })

    it('finds .vtt/.srt sidecars next to audio files', async () => {
      const lib = Path.join(tmp, 'lib')
      fs.mkdirSync(lib)
      fs.writeFileSync(Path.join(lib, 'Part 1.mp3'), 'a')
      fs.writeFileSync(Path.join(lib, 'Part 2.mp3'), 'a')
      fs.writeFileSync(Path.join(lib, 'Part 2.srt'), '1\n00:00:01,000 --> 00:00:02,000\nx\n')
      const found = await transcripts.findLocalSidecars([
        { path: Path.join(lib, 'Part 1.mp3'), offset: 0, duration: 100 },
        { path: Path.join(lib, 'Part 2.mp3'), offset: 100, duration: 100 }
      ])
      expect(found.format).to.equal('srt')
      expect(found.files).to.deep.equal([{ path: Path.join(lib, 'Part 2.srt'), offset: 100, duration: 100, format: 'srt' }])
      expect(await transcripts.findLocalSidecars([{ path: Path.join(lib, 'Part 1.mp3'), offset: 0, duration: 1 }])).to.equal(null)
    })
  })
})
