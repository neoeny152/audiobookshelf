const { expect } = require('chai')

const { scoreCandidate, pickMatch, titleVariants, itemForScoring } = require('../../../../server/utils/autoPipeline/matchScore')

// Dungeon Crawler Carl, book 1: about 13 h 40 min
const DCC_MIN = 820

function item(overrides = {}) {
  return {
    title: 'Dungeon Crawler Carl 01 - Dungeon Crawler Carl',
    subtitle: '',
    authors: ['Matt Dinniman'],
    narrators: ['Jeff Hays'],
    durationSec: DCC_MIN * 60,
    series: [],
    ...overrides
  }
}

function candidate(overrides = {}) {
  return {
    title: 'Dungeon Crawler Carl',
    subtitle: 'A LitRPG/Gamelit Adventure',
    author: 'Matt Dinniman',
    narrator: 'Jeff Hays',
    duration: DCC_MIN,
    series: [{ series: 'Dungeon Crawler Carl', sequence: '1' }],
    asin: 'B08BX5HZ5M',
    cover: null,
    ...overrides
  }
}

describe('autoPipeline matchScore', () => {
  describe('titleVariants', () => {
    it('strips series prefixes, list indexes and book numbers', () => {
      expect(titleVariants("Dungeon Crawler Carl 02 - Carl's Doomsday Scenario", ['Dungeon Crawler Carl'])).to.include("Carl's Doomsday Scenario")
      expect(titleVariants('Black Ice (Book 3)', [])).to.include('Black Ice')
      expect(titleVariants('The Gate, Book 2', [])).to.include('The Gate')
      expect(titleVariants('01 - The Hobbit', [])).to.include('The Hobbit')
      expect(titleVariants('Mistborn #1 - The Final Empire', ['Mistborn'])).to.include('The Final Empire')
      expect(titleVariants('The Final Empire (Mistborn, Book 1)', ['Mistborn'])).to.include('The Final Empire')
    })

    it('never produces an empty variant when the title is the series name', () => {
      const variants = titleVariants('Dungeon Crawler Carl', ['Dungeon Crawler Carl'])
      expect(variants[0]).to.equal('Dungeon Crawler Carl')
      expect(variants.every((v) => v.length > 0)).to.equal(true)
    })
  })

  describe('scoreCandidate', () => {
    it('scores the same book and edition 100 % even with a decorated folder title', () => {
      const s = scoreCandidate(item(), candidate())
      expect(s.confidence).to.equal(100)
      expect(s.caps).to.deep.equal([])
      expect(s.components).to.include({ title: 1, author: 1, duration: 1, narrator: 1 })
      expect(s.components.series).to.equal(null) // the item has no series yet
    })

    it('scores a later book through its series prefix', () => {
      const s = scoreCandidate(item({ title: "Dungeon Crawler Carl 02 - Carl's Doomsday Scenario", durationSec: 900 * 60 }), candidate({ title: "Carl's Doomsday Scenario", duration: 901, asin: 'B08V8B2CGV', series: [{ series: 'Dungeon Crawler Carl', sequence: '2' }] }))
      expect(s.components.title).to.equal(1)
      expect(s.confidence).to.be.at.least(95)
    })

    it('uses "title: subtitle" on both sides', () => {
      const s = scoreCandidate(item({ title: 'Dungeon Crawler Carl', subtitle: 'A LitRPG/Gamelit Adventure' }), candidate())
      expect(s.components.title).to.equal(1)
    })

    it('duration: full score within max(2 min, 1 %), falling to 0 at 10 %', () => {
      expect(scoreCandidate(item(), candidate({ duration: DCC_MIN + 8 })).components.duration).to.equal(1) // 8 < 8.2 (1 %)
      const mid = scoreCandidate(item(), candidate({ duration: DCC_MIN + 45 })).components.duration
      expect(mid).to.be.above(0).and.below(1)
      expect(scoreCandidate(item(), candidate({ duration: DCC_MIN + 90 })).components.duration).to.equal(0)
      // short book: the 2 minute floor applies
      expect(scoreCandidate(item({ durationSec: 60 * 60 }), candidate({ duration: 61.5 })).components.duration).to.equal(1)
    })

    it('caps a wrong title at 60 even when everything else matches', () => {
      const s = scoreCandidate(item(), candidate({ title: 'The Eye of the World', subtitle: null, series: null }))
      expect(s.components.title).to.be.below(0.75)
      expect(s.confidence).to.be.at.most(60)
      expect(s.caps).to.include('title')
    })

    it('caps a wrong author at 60', () => {
      const s = scoreCandidate(item(), candidate({ author: 'Brandon Sanderson' }))
      expect(s.confidence).to.be.at.most(60)
      expect(s.caps).to.include('author')
    })

    it('caps another edition (duration off by more than 15 %) at 70', () => {
      const s = scoreCandidate(item(), candidate({ duration: DCC_MIN * 0.5 }))
      expect(s.confidence).to.be.at.most(70)
      expect(s.caps).to.include('duration')
    })

    it('caps at 80 when fewer than two of author and duration are known', () => {
      const noDuration = scoreCandidate(item(), candidate({ duration: 0 }))
      expect(noDuration.components.duration).to.equal(null)
      expect(noDuration.confidence).to.equal(80)
      const noAuthor = scoreCandidate(item({ authors: [] }), candidate())
      expect(noAuthor.confidence).to.equal(80)
      expect(noAuthor.caps).to.deep.equal(['evidence'])
    })

    it('narrator separates re-recorded editions', () => {
      const same = scoreCandidate(item(), candidate())
      const other = scoreCandidate(item(), candidate({ narrator: 'Someone Else Entirely', asin: 'B0OTHER001' }))
      expect(other.components.narrator).to.be.below(0.5)
      expect(other.confidence).to.be.below(same.confidence)
    })

    it('series: 1 for the same sequence, 0 for another sequence, null when unknown', () => {
      const withSeries = item({ series: [{ name: 'Dungeon Crawler Carl', sequence: '1' }] })
      expect(scoreCandidate(withSeries, candidate()).components.series).to.equal(1)
      expect(scoreCandidate(withSeries, candidate({ series: [{ series: 'Dungeon Crawler Carl', sequence: '2' }] })).components.series).to.equal(0)
      expect(scoreCandidate(withSeries, candidate({ series: [{ series: 'Wheel of Time', sequence: '1' }] })).components.series).to.equal(null)
      expect(scoreCandidate(item({ series: [{ name: 'DCC', sequence: '1.0' }] }), candidate({ series: [{ series: 'DCC', sequence: '1' }] })).components.series).to.equal(1)
    })

    it('a book number the candidate does not have caps at 70: the next book of a series is not this one', () => {
      // a folder named for book 2, Audible's book 1 has almost the same title, author, narrator and length
      const s = scoreCandidate(item({ title: 'Dungeon Crawler Carl 02' }), candidate())
      expect(s.caps).to.include('number')
      expect(s.confidence).to.be.at.most(70)
      expect(scoreCandidate(item({ title: 'Dungeon Crawler Carl 02' }), candidate({ series: [{ series: 'Dungeon Crawler Carl', sequence: '2' }] })).caps).to.not.include('number')
      expect(scoreCandidate(item({ title: 'Black Ice (Book 3)' }), candidate({ title: 'Black Ice', series: [{ series: 'Ice', sequence: '3' }] })).caps).to.not.include('number')
      // numbers that are part of the title, and years, are fine
      expect(scoreCandidate(item({ title: 'Catch-22' }), candidate({ title: 'Catch-22', series: null })).caps).to.not.include('number')
      expect(scoreCandidate(item({ title: '1984' }), candidate({ title: '1984', series: null })).caps).to.not.include('number')
    })

    it('the same series with another position caps at 60', () => {
      const s = scoreCandidate(item({ title: 'Dungeon Crawler Carl', series: [{ name: 'Dungeon Crawler Carl', sequence: '2' }] }), candidate())
      expect(s.components.series).to.equal(0)
      expect(s.caps).to.include('series')
      expect(s.confidence).to.be.at.most(60)
    })

    it('handles missing fields without throwing', () => {
      const s = scoreCandidate({ title: 'X', authors: [], narrators: [], durationSec: null, series: [] }, { title: null })
      expect(s.confidence).to.be.at.most(60)
      expect(s.asin).to.equal(null)
    })
  })

  describe('pickMatch', () => {
    it('matches the best candidate at or above the threshold', () => {
      const decision = pickMatch(item(), [candidate({ asin: 'B0WRONG001', title: 'Something Else', author: 'Other Person' }), candidate()], 95)
      expect(decision.result).to.equal('matched')
      expect(decision.asin).to.equal('B08BX5HZ5M')
      expect(decision.confidence).to.equal(100)
      expect(decision.candidate.asin).to.equal('B08BX5HZ5M')
      expect(decision.candidates).to.have.length(2)
      expect(decision.candidates[0].asin).to.equal('B08BX5HZ5M')
    })

    it('needs review below the threshold and keeps the top 3', () => {
      const pool = [1, 2, 3, 4].map((n) => candidate({ asin: `B0LOW00000${n}`, author: 'Other Person' }))
      const decision = pickMatch(item(), pool, 95)
      expect(decision).to.include({ result: 'needs-review', reason: 'low-confidence' })
      expect(decision.candidate).to.equal(null)
      expect(decision.candidates).to.have.length(3)
    })

    it('needs review when a second edition with another ASIN comes within 3 points', () => {
      // same book, another narrator: both 95 % or more and close together
      const a = candidate({ asin: 'B0EDITION1' })
      const b = candidate({ asin: 'B0EDITION2', narrator: 'Jeff Hays, Other Voice' })
      const decision = pickMatch(item({ narrators: [] }), [a, b], 95)
      expect(decision).to.include({ result: 'needs-review', reason: 'ambiguous' })
    })

    it('the same ASIN twice is not ambiguous', () => {
      const decision = pickMatch(item(), [candidate(), candidate()], 95)
      expect(decision.result).to.equal('matched')
    })

    it('no candidates (or none with an ASIN) is needs-review: no-match', () => {
      expect(pickMatch(item(), [], 95)).to.include({ result: 'needs-review', reason: 'no-match' })
      expect(pickMatch(item(), [candidate({ asin: null })], 95)).to.include({ result: 'needs-review', reason: 'no-match' })
      expect(pickMatch(item(), null, 95)).to.include({ result: 'needs-review', reason: 'no-match' })
    })

    it('only scores the first 5 search results', () => {
      const pool = [1, 2, 3, 4, 5].map((n) => candidate({ asin: `B0WRONG00${n}`, title: 'Unrelated Book', author: 'Other Person' }))
      pool.push(candidate())
      expect(pickMatch(item(), pool, 95).result).to.equal('needs-review')
    })

    it('respects the configured threshold', () => {
      const c = candidate({ duration: 0 }) // capped at 80
      expect(pickMatch(item(), [c], 95).result).to.equal('needs-review')
      expect(pickMatch(item(), [c], 80).result).to.equal('matched')
    })
  })

  it('itemForScoring reads an expanded library item', () => {
    const li = {
      media: {
        title: 'Black Ice',
        subtitle: null,
        authors: [{ name: 'A. Writer' }],
        narrators: ['Jo Reader'],
        duration: 3600,
        series: [{ name: 'Ice', bookSeries: { sequence: '3' } }]
      }
    }
    expect(itemForScoring(li)).to.deep.equal({ title: 'Black Ice', subtitle: '', authors: ['A. Writer'], narrators: ['Jo Reader'], durationSec: 3600, series: [{ name: 'Ice', sequence: '3' }] })
  })

  it('itemForScoring uses the measured length of MP3s without a seek header', () => {
    const mp3 = { codec: 'mp3', duration: 1800, mp3SeekIndex: 'none', metadata: { size: 1, mtimeMs: 2 }, mp3Measured: { duration: 1890, size: 1, mtimeMs: 2 } }
    const li = { media: { title: 'Black Ice', duration: 3600, includedAudioFiles: [mp3, { ...mp3, mp3SeekIndex: 'xing' }] } }
    expect(itemForScoring(li).durationSec).to.equal(3690)
  })
})
