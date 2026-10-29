const { expect } = require('chai')
const sinon = require('sinon')

const Database = require('../../../server/Database')
const Logger = require('../../../server/Logger')
const PlaybackSessionManager = require('../../../server/managers/PlaybackSessionManager')

describe('PlaybackSessionManager - syncSession', () => {
  const PlaybackSession = require('../../../server/objects/PlaybackSession')
  const SocketAuthority = require('../../../server/SocketAuthority')

  const libraryItem = { id: 'li1', libraryId: 'lib1', media: { id: 'book1' } }
  const sessionStart = 1_700_000_000_000
  let manager
  let user
  let findProgress
  let savedSession
  let written

  function makeSession(overrides = {}) {
    return new PlaybackSession({
      id: 'sess-a',
      userId: 'u1',
      libraryId: 'lib1',
      libraryItemId: 'li1',
      bookId: 'book1',
      episodeId: null,
      mediaType: 'book',
      displayTitle: 'Book',
      duration: 36000,
      timeListening: 30,
      currentTime: 100,
      startedAt: sessionStart,
      updatedAt: sessionStart,
      ...overrides
    })
  }

  function storedProgress(updatedAt, currentTime, isFinished = false) {
    findProgress.resolves({ id: 'mp1', updatedAt: new Date(updatedAt), currentTime, isFinished })
  }

  beforeEach(() => {
    sinon.stub(Logger, 'info')
    sinon.stub(Logger, 'warn')
    sinon.stub(Logger, 'error')
    sinon.stub(Logger, 'debug')
    sinon.stub(SocketAuthority, 'clientEmitter')
    sinon.stub(SocketAuthority, 'adminEmitter')
    sinon.stub(Database, 'libraryItemModel').get(() => ({ getExpandedById: sinon.stub().resolves(libraryItem) }))
    sinon.stub(Database, 'libraryModel').get(() => ({ findByPk: sinon.stub().resolves({ id: 'lib1', librarySettings: {} }) }))
    written = []
    findProgress = sinon.stub().resolves(null)
    sinon.stub(Database, 'mediaProgressModel').get(() => ({ findOne: findProgress }))
    savedSession = sinon.stub(Database, 'createPlaybackSession').resolves(true)
    sinon.stub(Database, 'updatePlaybackSession').resolves(true)
    user = {
      id: 'u1',
      username: 'u1',
      toJSONForPublic: () => ({}),
      // Like User.createUpdateMediaProgressFromPayload: skipIf runs under the lock, before the write
      createUpdateMediaProgressFromPayload: sinon.stub().callsFake(async (payload, options = {}) => {
        if (options.skipIf && (await options.skipIf())) return { skipped: true }
        written.push(payload)
        return {
          mediaProgress: { id: 'mp1', updatedAt: new Date(sessionStart + 60_000), currentTime: payload.currentTime, isFinished: false, getOldMediaProgress: () => payload }
        }
      })
    }
    manager = new PlaybackSessionManager()
  })

  afterEach(() => {
    sinon.restore()
  })

  it('does not rewind progress another session moved ahead, but keeps listening time (#5627)', async () => {
    const sessionA = makeSession({ id: 'sess-a' })
    sessionA.lastProgressUpdatedAt = sessionStart
    // Session B on another device synced to 600s after session A last synced
    storedProgress(sessionStart + 5_000, 600)

    const result = await manager.syncSession(user, sessionA, { currentTime: 100, timeListened: 10 })

    expect(result).to.be.true
    expect(written).to.have.length(0)
    expect(sessionA.timeListening).to.equal(40)
    expect(savedSession.calledOnceWith(sessionA)).to.be.true
  })

  it('also skips a stale close of an old session (#5627)', async () => {
    const sessionA = makeSession({ id: 'sess-a' })
    sessionA.lastProgressUpdatedAt = sessionStart
    storedProgress(sessionStart + 5_000, 600)

    await manager.closeSession(user, sessionA, { currentTime: 100, timeListened: 5 })

    expect(written).to.have.length(0)
  })

  it('does not un-finish an item finished elsewhere (#5627)', async () => {
    const sessionA = makeSession()
    sessionA.lastProgressUpdatedAt = sessionStart
    storedProgress(sessionStart + 5_000, 0, true)

    await manager.syncSession(user, sessionA, { currentTime: 900, timeListened: 10 })

    expect(written).to.have.length(0)
  })

  it('still writes when the stale session moves past the stored progress, and becomes current again', async () => {
    const sessionA = makeSession()
    sessionA.lastProgressUpdatedAt = sessionStart
    storedProgress(sessionStart + 5_000, 600)

    await manager.syncSession(user, sessionA, { currentTime: 650, timeListened: 10 })

    expect(written.map((p) => p.currentTime)).to.deep.equal([650])
    expect(sessionA.lastProgressUpdatedAt).to.equal(sessionStart + 60_000)
    expect(sessionA.lastProgressCurrentTime).to.equal(650)
  })

  it('lets a session rewind progress it wrote itself', async () => {
    const sessionA = makeSession()
    sessionA.lastProgressUpdatedAt = sessionStart + 5_000
    storedProgress(sessionStart + 5_000, 600)

    await manager.syncSession(user, sessionA, { currentTime: 100, timeListened: 10 })

    expect(written.map((p) => p.currentTime)).to.deep.equal([100])
  })

  it('still rewinds after a write elsewhere that left the position alone, e.g. remove-from-continue-listening', async () => {
    const sessionA = makeSession()
    sessionA.lastProgressUpdatedAt = sessionStart
    sessionA.lastProgressCurrentTime = 600
    // hideFromContinueListening / ebook progress / a batch update with the same time bumped updatedAt only
    storedProgress(sessionStart + 5_000, 600)

    const result = await manager.syncSession(user, sessionA, { currentTime: 570, timeListened: 10 })

    expect(result).to.be.true
    expect(written.map((p) => p.currentTime)).to.deep.equal([570])
  })

  it('does not lock the session after a same-position write, then guards a real move again', async () => {
    const sessionA = makeSession()
    sessionA.lastProgressUpdatedAt = sessionStart
    sessionA.lastProgressCurrentTime = 600
    storedProgress(sessionStart + 5_000, 600.004)
    await manager.syncSession(user, sessionA, { currentTime: 580, timeListened: 10 })
    expect(written.map((p) => p.currentTime)).to.deep.equal([580])

    // Another device now moves the position after this session's write
    storedProgress(sessionStart + 120_000, 900)
    await manager.syncSession(user, sessionA, { currentTime: 560, timeListened: 10 })
    expect(written.map((p) => p.currentTime)).to.deep.equal([580])
  })

  it('treats a row created elsewhere after a session that started without progress as moved', async () => {
    const sessionA = makeSession()
    sessionA.lastProgressUpdatedAt = sessionStart
    sessionA.lastProgressCurrentTime = null
    storedProgress(sessionStart + 5_000, 300)

    await manager.syncSession(user, sessionA, { currentTime: 50, timeListened: 10 })

    expect(written).to.have.length(0)
  })

  it('runs the stale check inside the progress write lock (skipIf)', async () => {
    const sessionA = makeSession()
    await manager.syncSession(user, sessionA, { currentTime: 100, timeListened: 10 })

    const options = user.createUpdateMediaProgressFromPayload.firstCall.args[1]
    expect(options.skipIf).to.be.a('function')
  })

  it('uses the server duration over a client-sent duration (#5471)', async () => {
    const sessionA = makeSession({ duration: 36000 })

    await manager.syncSession(user, sessionA, { currentTime: 10, duration: 10, timeListened: 10 })

    expect(user.createUpdateMediaProgressFromPayload.firstCall.args[0].duration).to.equal(36000)
  })

  it('falls back to the client duration when the session has none', async () => {
    const sessionA = makeSession({ duration: 0 })

    await manager.syncSession(user, sessionA, { currentTime: 10, duration: 500, timeListened: 10 })

    expect(user.createUpdateMediaProgressFromPayload.firstCall.args[0].duration).to.equal(500)
  })
})
