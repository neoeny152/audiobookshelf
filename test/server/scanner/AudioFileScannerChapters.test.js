const { expect } = require('chai')

const AudioFileScanner = require('../../../server/scanner/AudioFileScanner')

// Regression tests for #5639: multi-file chapter names fell back to file names
// when a single track's title tag equalled the book title.
describe('AudioFileScanner.getBookChaptersFromAudioFiles (multi-file tag titles)', () => {
  const libraryScan = { addLog: () => {} }

  function audioFile(filename, tagTitle, duration = 100) {
    return {
      duration,
      chapters: [],
      metadata: { filename, path: `/books/Book/${filename}` },
      metaTags: tagTitle === undefined ? {} : { tagTitle }
    }
  }

  it('uses tag titles when one track title equals the book title', () => {
    const files = [audioFile('01.mp3', 'My Book'), audioFile('02.mp3', 'Chapter 1'), audioFile('03.mp3', 'Chapter 2')]
    const chapters = AudioFileScanner.getBookChaptersFromAudioFiles('My Book', files, libraryScan)
    expect(chapters.map((c) => c.title)).to.deep.equal(['My Book', 'Chapter 1', 'Chapter 2'])
    expect(chapters.map((c) => c.start)).to.deep.equal([0, 100, 200])
  })

  it('uses tag titles when they are all set, unique and differ from the book title', () => {
    const files = [audioFile('01.mp3', 'Opening'), audioFile('02.mp3', 'Middle')]
    const chapters = AudioFileScanner.getBookChaptersFromAudioFiles('My Book', files, libraryScan)
    expect(chapters.map((c) => c.title)).to.deep.equal(['Opening', 'Middle'])
  })

  it('falls back to file names when every title equals the book title (caught by the uniqueness rule)', () => {
    const files = [audioFile('01.mp3', 'My Book'), audioFile('02.mp3', 'My Book')]
    const chapters = AudioFileScanner.getBookChaptersFromAudioFiles('My Book', files, libraryScan)
    expect(chapters.map((c) => c.title)).to.deep.equal(['01', '02'])
  })

  it('falls back to file names when a title tag is missing', () => {
    const files = [audioFile('01.mp3', 'Opening'), audioFile('02.mp3')]
    const chapters = AudioFileScanner.getBookChaptersFromAudioFiles('My Book', files, libraryScan)
    expect(chapters.map((c) => c.title)).to.deep.equal(['01', '02'])
  })

  it('falls back to file names when title tags repeat', () => {
    const files = [audioFile('01.mp3', 'Part'), audioFile('02.mp3', 'Part'), audioFile('03.mp3', 'Other')]
    const chapters = AudioFileScanner.getBookChaptersFromAudioFiles('My Book', files, libraryScan)
    expect(chapters.map((c) => c.title)).to.deep.equal(['01', '02', '03'])
  })
})

// Chapters must stay inside the book duration, which only counts included files (#5311)
describe('AudioFileScanner.getBookChaptersFromAudioFiles (excluded audio files)', () => {
  const Book = require('../../../server/models/Book')
  const libraryScan = { addLog: () => {} }

  function audioFile(filename, duration, extra = {}) {
    return {
      duration,
      chapters: [],
      metadata: { filename, path: `/books/Book/${filename}` },
      metaTags: {},
      ...extra
    }
  }

  it('builds file chapters only from included audio files', () => {
    const files = [audioFile('01.mp3', 100), audioFile('02.mp3', 50, { exclude: true }), audioFile('03.mp3', 100)]
    const chapters = AudioFileScanner.getBookChaptersFromAudioFiles('My Book', files, libraryScan)
    const duration = Book.getDurationFromAudioFiles(files)
    expect(chapters.map((c) => c.title)).to.deep.equal(['01', '03'])
    expect(chapters.map((c) => [c.start, c.end])).to.deep.equal([
      [0, 100],
      [100, 200]
    ])
    expect(chapters[chapters.length - 1].end).to.be.at.most(duration)
  })

  it('builds embedded chapters only from included audio files', () => {
    const files = [
      audioFile('01.m4b', 100, { chapters: [{ id: 0, start: 0, end: 100, title: 'One' }] }),
      audioFile('02.m4b', 50, { exclude: true, chapters: [{ id: 0, start: 0, end: 50, title: 'Bonus' }] }),
      audioFile('03.m4b', 100, { chapters: [{ id: 0, start: 0, end: 100, title: 'Three' }] })
    ]
    const chapters = AudioFileScanner.getBookChaptersFromAudioFiles('My Book', files, libraryScan)
    expect(chapters.map((c) => c.title)).to.deep.equal(['One', 'Three'])
    expect(chapters[chapters.length - 1].end).to.be.at.most(Book.getDurationFromAudioFiles(files))
  })

  it('skips an excluded first file when picking embedded chapters', () => {
    const files = [audioFile('00.m4b', 30, { exclude: true, chapters: [{ id: 0, start: 0, end: 30, title: 'Sample' }] }), audioFile('01.m4b', 100, { chapters: [{ id: 0, start: 0, end: 100, title: 'One' }] })]
    const chapters = AudioFileScanner.getBookChaptersFromAudioFiles('My Book', files, libraryScan)
    expect(chapters.map((c) => [c.title, c.start, c.end])).to.deep.equal([['One', 0, 100]])
  })

  it('returns no chapters when every audio file is excluded', () => {
    const files = [audioFile('01.mp3', 100, { exclude: true }), audioFile('02.mp3', 100, { exclude: true })]
    expect(AudioFileScanner.getBookChaptersFromAudioFiles('My Book', files, libraryScan)).to.deep.equal([])
  })
})
