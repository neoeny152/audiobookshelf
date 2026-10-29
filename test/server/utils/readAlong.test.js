const { expect } = require('chai')
const sinon = require('sinon')
const os = require('os')
const Path = require('path')
const fs = require('fs')

const Logger = require('../../../server/Logger')
const readAlong = require('../../../server/utils/readAlong')

const ITEM_ID = '7c1a3c55-2a8e-4c4b-9a65-0f3f4c1d2e3f'

function sample(overrides = {}) {
  return {
    kind: 'abs-readalong',
    version: 1,
    identifier: 'urn:uuid:5b1c0000-0000-5000-8000-000000000000',
    modified: '2026-10-28T12:34:56Z',
    epubFile: 'book.epub',
    timeline: 'book',
    audioDuration: 4000,
    model: 'small.en',
    sections: [
      { href: 'OEBPS/ch001.xhtml', title: 'Chapter 1' },
      { href: 'OEBPS/ch002.xhtml', title: 'Chapter 2' }
    ],
    sentences: [
      { id: 's1', sec: 0, start: 12.34, end: 15.9 },
      {
        id: 's2',
        sec: 0,
        start: 16.02,
        end: 21.75,
        w: [
          [16.02, 16.3],
          [16.3, 16.71]
        ]
      },
      { id: 's3', sec: 1, start: 21.75, end: 21.75 }
    ],
    ...overrides
  }
}

describe('readAlong', () => {
  describe('validate', () => {
    it('accepts the version 1 format and keeps unknown fields', () => {
      const data = sample({ futureField: { x: 1 } })
      data.sentences[0].extra = true
      const out = readAlong.validate(data)
      expect(out).to.deep.equal(data)
      expect(out).to.not.equal(data)
      expect(out.sentences[0]).to.not.equal(data.sentences[0])
    })

    it('drops a sidecar-supplied epubPath (the server owns it)', () => {
      expect(readAlong.validate(sample({ epubPath: '../../etc/passwd' }))).to.not.have.property('epubPath')
    })

    it('accepts optional fields left out and an empty sentence list', () => {
      const data = sample({ sentences: [] })
      delete data.epubFile
      delete data.model
      delete data.timeline
      delete data.audioDuration
      expect(readAlong.validate(data).sentences).to.deep.equal([])
    })

    const bad = {
      'not an object': () => [],
      'wrong kind': () => sample({ kind: 'other' }),
      'newer version': () => sample({ version: 2 }),
      'missing identifier': () => sample({ identifier: undefined }),
      'empty modified': () => sample({ modified: '' }),
      'numeric modified': () => sample({ modified: 12 }),
      'other timeline': () => sample({ timeline: 'file' }),
      'negative duration': () => sample({ audioDuration: -1 }),
      'sections not an array': () => sample({ sections: {} }),
      'bad section href': () => sample({ sections: [{ href: 'OEBPS/ch 1.xhtml' }] }),
      'section href with ..': () => sample({ sections: [{ href: 'OEBPS/../x.xhtml' }, { href: 'b' }] }),
      'sentences not an array': () => sample({ sentences: null }),
      'bad id': () => sample({ sentences: [{ id: 's0', sec: 0, start: 1, end: 2 }] }),
      'id too long': () => sample({ sentences: [{ id: 's12345678', sec: 0, start: 1, end: 2 }] }),
      'duplicate id': () =>
        sample({
          sentences: [
            { id: 's1', sec: 0, start: 1, end: 2 },
            { id: 's1', sec: 0, start: 3, end: 4 }
          ]
        }),
      'sec out of range': () => sample({ sentences: [{ id: 's1', sec: 2, start: 1, end: 2 }] }),
      'fractional sec': () => sample({ sentences: [{ id: 's1', sec: 0.5, start: 1, end: 2 }] }),
      'infinite time': () => sample({ sentences: [{ id: 's1', sec: 0, start: 1, end: Infinity }] }),
      'string time': () => sample({ sentences: [{ id: 's1', sec: 0, start: '1', end: 2 }] }),
      'end before start': () => sample({ sentences: [{ id: 's1', sec: 0, start: 3, end: 2 }] }),
      'out of order': () =>
        sample({
          sentences: [
            { id: 's1', sec: 0, start: 5, end: 6 },
            { id: 's2', sec: 0, start: 4, end: 6 }
          ]
        }),
      'w not pairs': () => sample({ sentences: [{ id: 's1', sec: 0, start: 1, end: 2, w: [[1]] }] }),
      'w with NaN': () => sample({ sentences: [{ id: 's1', sec: 0, start: 1, end: 2, w: [[1, NaN]] }] }),
      'too many sentences': () => sample({ sentences: new Array(readAlong.MAX_SENTENCES + 1) })
    }
    for (const [label, make] of Object.entries(bad)) {
      it(`rejects ${label}`, () => {
        expect(() => readAlong.validate(make())).to.throw(readAlong.ReadAlongError)
      })
    }
  })

  describe('storage', () => {
    let metadataPath
    let itemDir

    beforeEach(() => {
      sinon.stub(Logger, 'info')
      sinon.stub(Logger, 'warn')
      metadataPath = fs.mkdtempSync(Path.join(os.tmpdir(), 'abs-readalong-meta-'))
      itemDir = fs.mkdtempSync(Path.join(os.tmpdir(), 'abs-readalong-item-'))
      global.MetadataPath = metadataPath
    })

    afterEach(() => {
      sinon.restore()
      fs.rmSync(metadataPath, { recursive: true, force: true })
      fs.rmSync(itemDir, { recursive: true, force: true })
    })

    const epub = (ino, name = 'Book (from audio).epub') => ({ ino, metadata: { filename: name, ext: '.epub', path: Path.join(itemDir, name).replace(/\\/g, '/'), relPath: name } })
    const item = (files) => ({ id: ITEM_ID, path: itemDir, libraryFiles: files })

    it('stores under the item metadata folder keyed by ino, atomically, with epubPath', async () => {
      const path = await readAlong.save(ITEM_ID, '12345', 'Book (from audio).epub', readAlong.validate(sample()))
      expect(path).to.equal(Path.join(metadataPath, 'items', ITEM_ID, 'readalong', '12345.json'))
      expect(readAlong.dir(ITEM_ID)).to.equal(Path.dirname(path))
      const stored = JSON.parse(fs.readFileSync(path, 'utf8'))
      expect(stored).to.deep.equal({ epubPath: 'Book (from audio).epub', ...sample() })
      expect(fs.readdirSync(Path.dirname(path))).to.deep.equal(['12345.json'])
    })

    it('refuses unsafe inos and item ids as file names', async () => {
      for (const ino of ['../x', 'a/b', '', '..']) {
        let error = null
        await readAlong.save(ITEM_ID, ino, 'x.epub', sample()).catch((e) => (error = e))
        expect(error, ino).to.be.instanceOf(readAlong.ReadAlongError)
      }
      expect(() => readAlong.dir('../evil')).to.throw(readAlong.ReadAlongError)
    })

    it('finds the data by ino', async () => {
      const file = epub('111')
      expect(await readAlong.find(item([file]), file)).to.equal(null)
      const path = await readAlong.save(ITEM_ID, '111', 'Book (from audio).epub', sample())
      expect(await readAlong.find(item([file]), file)).to.equal(path)
    })

    it('re-keys an entry by its EPUB path when the ino changed', async () => {
      await readAlong.save(ITEM_ID, '111', 'Book (from audio).epub', sample())
      const moved = epub('222')
      const found = await readAlong.find(item([moved]), moved)
      expect(found).to.equal(Path.join(readAlong.dir(ITEM_ID), '222.json'))
      expect(fs.readdirSync(readAlong.dir(ITEM_ID))).to.deep.equal(['222.json'])
      expect(await readAlong.find(item([moved]), moved)).to.equal(found)
    })

    it('does not take over the entry of another file that still exists, nor one for another path', async () => {
      await readAlong.save(ITEM_ID, '111', 'Book (from audio).epub', sample())
      // same path but the old ino is still a file of the item (it is that file's entry)
      const current = epub('111', 'Other.epub')
      const other = epub('333')
      expect(await readAlong.find(item([current, other]), other)).to.equal(null)
      // different path
      const renamed = epub('444', 'Renamed.epub')
      expect(await readAlong.find(item([renamed]), renamed)).to.equal(null)
      expect(fs.readdirSync(readAlong.dir(ITEM_ID))).to.deep.equal(['111.json'])
    })

    it('returns null for an item without data', async () => {
      const file = epub('555')
      expect(await readAlong.find(item([file]), file)).to.equal(null)
      expect(await readAlong.find(null, file)).to.equal(null)
    })
  })
})
