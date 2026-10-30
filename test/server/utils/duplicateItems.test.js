const { expect } = require('chai')

const { normalizeTitle, normalizeAuthor, normalizeAsin, normalizeIsbn, normalizeFeedUrl, durationsMatch, getGroupKey, findDuplicateGroups } = require('../../../server/utils/duplicateItems')

describe('duplicateItems', () => {
  describe('normalizers', () => {
    it('normalizeTitle ignores case, accents, punctuation, leading articles and (Unabridged)', () => {
      expect(normalizeTitle('The Hobbit (Unabridged)')).to.equal('hobbit')
      expect(normalizeTitle('hobbit')).to.equal('hobbit')
      expect(normalizeTitle('Les Misérables')).to.equal(normalizeTitle('les miserables'))
      expect(normalizeTitle('Harry Potter & the Goblet of Fire')).to.equal(normalizeTitle('Harry Potter and the Goblet of Fire'))
      expect(normalizeTitle('Dune: Part One')).to.not.equal(normalizeTitle('Dune'))
      expect(normalizeTitle('')).to.equal('')
      expect(normalizeTitle(null)).to.equal('')
    })

    it('normalizeAuthor matches name order and initials written differently', () => {
      const key = normalizeAuthor('J.R.R. Tolkien')
      expect(key).to.equal('jrr tolkien')
      expect(normalizeAuthor('Tolkien, J. R. R.')).to.equal(key)
      expect(normalizeAuthor('JRR Tolkien')).to.equal(key)
      expect(normalizeAuthor('Brandon Sanderson')).to.not.equal(key)
    })

    it('normalizeAsin accepts 10 character ASINs only', () => {
      expect(normalizeAsin(' b002v0qk4c ')).to.equal('B002V0QK4C')
      expect(normalizeAsin('123')).to.equal(null)
      expect(normalizeAsin(null)).to.equal(null)
    })

    it('normalizeIsbn compares ISBN-10 and ISBN-13 forms of the same book', () => {
      expect(normalizeIsbn('0-261-10221-4')).to.equal('9780261102217')
      expect(normalizeIsbn('978-0-261-10221-7')).to.equal('9780261102217')
      expect(normalizeIsbn('080442957X')).to.equal('9780804429573')
      expect(normalizeIsbn('12345')).to.equal(null)
    })

    it('normalizeFeedUrl ignores scheme, www and trailing slash', () => {
      expect(normalizeFeedUrl('https://www.Example.com/feed/')).to.equal('example.com/feed')
      expect(normalizeFeedUrl('http://example.com/feed')).to.equal('example.com/feed')
    })

    it('durationsMatch allows 1% difference', () => {
      expect(durationsMatch(36000, 36300)).to.equal(true)
      expect(durationsMatch(36000, 36500)).to.equal(false)
      expect(durationsMatch(0, 0)).to.equal(true)
      expect(durationsMatch(0, 100)).to.equal(false)
    })

    it('getGroupKey is stable and changes with membership', () => {
      expect(getGroupKey(['a', 'b'])).to.equal(getGroupKey(['a', 'b']))
      expect(getGroupKey(['a', 'b'])).to.not.equal(getGroupKey(['a', 'b', 'c']))
      expect(getGroupKey(['a', 'b'])).to.match(/^[0-9a-f]{24}$/)
    })
  })

  describe('findDuplicateGroups (books)', () => {
    const book = (id, fields) => ({ id, title: 'The Hobbit', author: 'J.R.R. Tolkien', duration: 36000, hasEbook: false, ...fields })

    it('groups the same title and author with durations within 1%', () => {
      const groups = findDuplicateGroups([book('a'), book('b', { title: 'Hobbit (Unabridged)', author: 'Tolkien, J. R. R.', duration: 36200 }), book('c', { title: 'Other' })])
      expect(groups).to.have.length(1)
      expect(groups[0].itemIds).to.deep.equal(['a', 'b'])
      expect(groups[0].matchTypes).to.deep.equal(['title'])
      expect(groups[0].key).to.equal(getGroupKey(['a', 'b']))
    })

    it('does not group the same title when durations differ (another edition)', () => {
      expect(findDuplicateGroups([book('a'), book('b', { duration: 50000 })])).to.deep.equal([])
    })

    it('needs an author for title matching', () => {
      expect(findDuplicateGroups([book('a', { author: null }), book('b', { author: '' })])).to.deep.equal([])
    })

    it('groups by ASIN or ISBN regardless of title and duration, strongest match type first', () => {
      const groups = findDuplicateGroups([book('a', { asin: 'B002V0QK4C', title: 'Hobbit' }), book('b', { asin: 'b002v0qk4c', title: 'Der Hobbit', duration: 30000 }), book('c', { isbn: '0-261-10221-4', title: 'X', author: 'Y' }), book('d', { isbn: '9780261102217', title: 'Z', author: 'W', duration: 20000 })])
      expect(groups).to.have.length(2)
      const byIds = Object.fromEntries(groups.map((g) => [g.itemIds.join(','), g.matchTypes]))
      expect(byIds['a,b']).to.deep.equal(['asin'])
      expect(byIds['c,d']).to.deep.equal(['isbn'])
    })

    it('joins chains into one group and lists every match type', () => {
      const groups = findDuplicateGroups([book('a', { asin: 'B002V0QK4C' }), book('b', { asin: 'B002V0QK4C', duration: 40000 }), book('c', { duration: 36100 })])
      expect(groups).to.have.length(1)
      expect(groups[0].itemIds).to.deep.equal(['a', 'b', 'c'])
      expect(groups[0].matchTypes).to.deep.equal(['asin', 'title'])
    })

    it('does not pair an audiobook with the ebook of the same book', () => {
      const groups = findDuplicateGroups([book('a', { asin: 'B002V0QK4C' }), book('b', { asin: 'B002V0QK4C', duration: 0, hasEbook: true })])
      expect(groups).to.deep.equal([])
    })

    it('groups two ebook-only copies', () => {
      const groups = findDuplicateGroups([book('a', { duration: 0, hasEbook: true }), book('b', { duration: 0, hasEbook: true })])
      expect(groups).to.have.length(1)
    })

    it('skips items with neither audio nor ebook and ignores repeated ids', () => {
      expect(findDuplicateGroups([book('a', { duration: 0 }), book('b', { duration: 0 })])).to.deep.equal([])
      expect(findDuplicateGroups([book('a'), book('a')])).to.deep.equal([])
      expect(findDuplicateGroups(null)).to.deep.equal([])
    })
  })

  describe('findDuplicateGroups (podcasts)', () => {
    it('groups podcasts with the same feed or iTunes id', () => {
      const groups = findDuplicateGroups(
        [
          { id: 'a', title: 'Show', feedUrl: 'https://example.com/feed' },
          { id: 'b', title: 'Show (copy)', feedUrl: 'http://www.example.com/feed/' },
          { id: 'c', title: 'Other', itunesId: '123' },
          { id: 'd', title: 'Other 2', itunesId: 123 },
          { id: 'e', title: 'Show' }
        ],
        'podcast'
      )
      expect(groups.map((g) => g.itemIds)).to.have.deep.members([
        ['a', 'b'],
        ['c', 'd']
      ])
      groups.forEach((g) => expect(g.matchTypes).to.deep.equal(['feed']))
    })
  })
})
