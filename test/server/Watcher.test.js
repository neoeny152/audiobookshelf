const { expect } = require('chai')
const sinon = require('sinon')

const Logger = require('../../server/Logger')
const Watcher = require('../../server/Watcher')

describe('Watcher ignore dirs', () => {
  let clock

  beforeEach(() => {
    clock = sinon.useFakeTimers()
    sinon.stub(Logger, 'debug')
    Watcher.ignoreDirs = []
    Watcher.pendingDirsToRemoveFromIgnore = []
  })

  afterEach(() => {
    for (const timer of Watcher.removeFromIgnoreTimers.values()) clearTimeout(timer)
    Watcher.removeFromIgnoreTimers.clear()
    Watcher.ignoreDirs = []
    Watcher.pendingDirsToRemoveFromIgnore = []
    sinon.restore()
  })

  it('releases each dir 5 s after its own removeIgnoreDir, even when released close together', () => {
    Watcher.addIgnoreDir('/books/A')
    Watcher.addIgnoreDir('/books/B')
    Watcher.removeIgnoreDir('/books/A')
    clock.tick(1000)
    Watcher.removeIgnoreDir('/books/B')
    expect(Watcher.checkShouldIgnorePath('/books/A/x.epub')).to.equal(true)
    clock.tick(4000)
    expect(Watcher.checkShouldIgnorePath('/books/A/x.epub')).to.equal(false)
    expect(Watcher.checkShouldIgnorePath('/books/B/x.epub')).to.equal(true)
    clock.tick(1000)
    expect(Watcher.checkShouldIgnorePath('/books/B/x.epub')).to.equal(false)
  })

  it('keeps ignoring a dir that is added again before its release', () => {
    Watcher.addIgnoreDir('/books/A')
    Watcher.removeIgnoreDir('/books/A')
    clock.tick(2000)
    Watcher.addIgnoreDir('/books/A')
    clock.tick(10000)
    expect(Watcher.checkShouldIgnorePath('/books/A/x.epub')).to.equal(true)
  })
})
