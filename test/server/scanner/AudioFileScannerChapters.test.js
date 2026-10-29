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

  it('falls back to file names when every title equals the book title', () => {
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
