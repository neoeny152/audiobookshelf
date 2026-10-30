const { expect } = require('chai')

const chapterSnap = require('../../../server/utils/chapterSnap')
const { reanchorStarts } = require('../../../server/utils/chapterReanchor')

// Red Rising shape: four part files, the reference list (Audible) runs 20 s, 47 s and 86 s long at the part starts
const files = [
  ['Part  I  Slave.mp3', 7571.365],
  ['Part  II  Reborn.mp3', 13280.173],
  ['Part  III  Gold.mp3', 18416.831],
  ['Part  IV  Reaper.mp3', 18859.242]
]
const timeline = chapterSnap.buildTimeline(files.map(([name, duration]) => ({ duration, metadata: { path: `/books/Pierce Brown/Red Rising/${name}` } })))
const T = timeline.reduce((s, t) => s + t.duration, 0)
const reference = [
  ['Opening Credits', 0],
  ['Part I', 185],
  ['Chapter 1', 203],
  ['Chapter 6', 6449.7],
  ['Part II', 7591.459],
  ['Chapter 7', 7609.459],
  ['Chapter 19', 20116.6],
  ['Part III', 20898.459],
  ['Chapter 20', 20925.459],
  ['Part IV', 39354.1],
  ['Chapter 34', 39380.1],
  ['Chapter 44', 56633.7]
].map(([title, start], id) => ({ id, title, start }))

describe('chapterReanchor', () => {
  it('maps the reference list onto part files named like a chapter', () => {
    const r = reanchorStarts(reference, timeline, T)
    expect(r.anchors.map((a) => [a.index, a.trackIndex])).to.deep.equal([
      [4, 1],
      [7, 2],
      [9, 3]
    ])
    // the anchored chapters sit exactly on their files
    expect(r.starts[4]).to.be.closeTo(timeline[1].offset, 0.001)
    expect(r.starts[7]).to.be.closeTo(timeline[2].offset, 0.001)
    expect(r.starts[9]).to.be.closeTo(timeline[3].offset, 0.001)
    // in between, linear: Chapter 7 keeps its 18 s after Part II, shrunk by the span's rate
    expect(r.starts[5] - r.starts[4]).to.be.closeTo(18 * ((timeline[2].offset - timeline[1].offset) / (20898.459 - 7591.459)), 0.001)
    // past the last anchor the average rate of the anchored spans applies
    expect(r.rate).to.be.within(0.997, 0.999)
    expect(r.starts[11]).to.be.closeTo(timeline[3].offset + (56633.7 - 39354.1) * r.rate, 0.001)
    expect(r.starts[0]).to.equal(0)
    for (let i = 1; i < r.starts.length; i++) expect(r.starts[i]).to.be.greaterThan(r.starts[i - 1])
  })

  it('leaves a book alone when the file names do not name chapters', () => {
    const plain = chapterSnap.buildTimeline(files.map(([, duration], i) => ({ duration, metadata: { path: `/books/b/Red Rising-Part0${i + 1}.mp3` } })))
    expect(reanchorStarts(reference, plain, T)).to.equal(null)
  })

  it('does not anchor a chapter far from the file start', () => {
    const far = reference.map((c) => (c.title === 'Part II' || c.title === 'Chapter 7' ? { ...c, start: c.start + 400 } : c))
    const r = reanchorStarts(far, timeline, T)
    expect(r.anchors.map((a) => a.index)).to.deep.equal([7, 9])
  })

  it('does not anchor on a lone number or a short word', () => {
    const named = chapterSnap.buildTimeline([
      { duration: 100, metadata: { path: '/b/1.mp3' } },
      { duration: 100, metadata: { path: '/b/2.mp3' } }
    ])
    const list = [
      { id: 0, title: '1', start: 0 },
      { id: 1, title: '2', start: 103 }
    ]
    expect(reanchorStarts(list, named, 200)).to.equal(null)
  })

  it('maps past a single anchor with the rate of the span before it', () => {
    const two = chapterSnap.buildTimeline([
      { duration: 1000, metadata: { path: '/b/Prologue.mp3' } },
      { duration: 1000, metadata: { path: '/b/Chapter 1.mp3' } }
    ])
    const list = [
      { id: 0, title: 'Prologue', start: 0 },
      { id: 1, title: 'Chapter 1', start: 1010 },
      { id: 2, title: 'Chapter 2', start: 1500 }
    ]
    const r = reanchorStarts(list, two, 2000)
    expect(r.rate).to.be.closeTo(1000 / 1010, 1e-9)
    expect(r.starts).to.deep.equal([0, 1000, Math.round((1000 + 490 * r.rate) * 1000) / 1000])
  })

  it('gives up when the mapped list would run past the end of the book', () => {
    const two = chapterSnap.buildTimeline([
      { duration: 1000, metadata: { path: '/b/Part One.mp3' } },
      { duration: 100, metadata: { path: '/b/Part Two.mp3' } }
    ])
    const list = [
      { id: 0, title: 'Part One', start: 0 },
      { id: 1, title: 'Part Two', start: 1040 },
      { id: 2, title: 'Chapter 9', start: 1145 }
    ]
    expect(reanchorStarts(list, two, 1100)).to.equal(null)
  })
})
