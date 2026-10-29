const { expect } = require('chai')
const sinon = require('sinon')

const fs = require('../../../server/libs/fsExtra')
const inoMatchGuard = require('../../../server/scanner/inoMatchGuard')

/**
 * Fake file system for the guard: paths that exist, with optional stat data
 * @param {Record<string, {ino?: number, size?: number, dir?: boolean}>} entries
 */
function useFakeFs(entries) {
  sinon.stub(fs, 'pathExists').callsFake(async (path) => Object.prototype.hasOwnProperty.call(entries, path))
  sinon.stub(fs, 'stat').callsFake(async (path) => {
    const entry = entries[path]
    if (!entry) {
      const error = new Error(`ENOENT: no such file or directory, stat '${path}'`)
      error.code = 'ENOENT'
      throw error
    }
    return { ino: BigInt(entry.ino ?? 0), size: BigInt(entry.size ?? 0), isFile: () => !entry.dir }
  })
}

const libraryFile = (relPath, size, ino) => ({ ino: String(ino), metadata: { filename: relPath.split('/').pop(), relPath, path: `/x/${relPath}`, size } })

describe('inoMatchGuard', () => {
  afterEach(() => {
    sinon.restore()
  })

  describe('isSameFile', () => {
    it('matches on the same name and size', () => {
      expect(inoMatchGuard.isSameFile({ filename: 'a.mp3', size: 10, ino: '1' }, { filename: 'a.mp3', size: 10, ino: '2' })).to.be.true
    })

    it('matches on the same inode and size (renamed file)', () => {
      expect(inoMatchGuard.isSameFile({ filename: 'a.mp3', size: 10, ino: '1' }, { filename: 'b.mp3', size: 10, ino: '1' })).to.be.true
    })

    it('does not match a reused inode with a different size', () => {
      expect(inoMatchGuard.isSameFile({ filename: 'a.mp3', size: 10, ino: '1' }, { filename: 'b.mp3', size: 11, ino: '1' })).to.be.false
    })

    it('does not match the same name with a different size', () => {
      expect(inoMatchGuard.isSameFile({ filename: 'cover.jpg', size: 10 }, { filename: 'cover.jpg', size: 20 })).to.be.false
    })

    it('does not match empty or unknown sizes', () => {
      expect(inoMatchGuard.isSameFile({ filename: 'a.txt', size: 0 }, { filename: 'a.txt', size: 0 })).to.be.false
      expect(inoMatchGuard.isSameFile({ filename: 'a.txt' }, { filename: 'a.txt' })).to.be.false
    })

    it('treats bigint-like and string sizes as numbers', () => {
      expect(inoMatchGuard.isSameFile({ filename: 'a.mp3', size: '10' }, { filename: 'a.mp3', size: 10 })).to.be.true
    })
  })

  describe('hasOverlappingFile', () => {
    it('is false without files on either side', () => {
      expect(inoMatchGuard.hasOverlappingFile([], [{ filename: 'a.mp3', size: 1 }])).to.be.false
      expect(inoMatchGuard.hasOverlappingFile([libraryFile('a.mp3', 1, 1)], [])).to.be.false
      expect(inoMatchGuard.hasOverlappingFile(undefined, undefined)).to.be.false
    })

    it('is true when any file matches', () => {
      const existing = [libraryFile('cover.jpg', 50, 1), libraryFile('CD1/track.mp3', 1000, 2)]
      expect(
        inoMatchGuard.hasOverlappingFile(existing, [
          { filename: 'other.mp3', size: 5 },
          { filename: 'track.mp3', size: 1000 }
        ])
      ).to.be.true
    })
  })

  describe('checkInoMatch', () => {
    const item = { id: 'a', path: '/books/Author/Book A', libraryFiles: [libraryFile('a.mp3', 1000, 101)] }

    it('accepts a folder that was renamed (old path gone, same files)', async () => {
      useFakeFs({ '/books/Author/Book A2': { ino: 100, dir: true } })
      const result = await inoMatchGuard.checkInoMatch({ libraryItem: item, targetPath: '/books/Author/Book A2', targetFiles: [{ filename: 'a.mp3', size: 1000, ino: '101' }], otherItemAtTargetPath: false })
      expect(result).to.deep.equal({ ok: true })
    })

    it('rejects when the old path still exists (inode collision across Unraid disks)', async () => {
      useFakeFs({ '/books/Author/Book A': { ino: 100, dir: true }, '/books/Other/Book B': { ino: 100, dir: true } })
      const result = await inoMatchGuard.checkInoMatch({ libraryItem: item, targetPath: '/books/Other/Book B', targetFiles: [{ filename: 'a.mp3', size: 1000, ino: '101' }], otherItemAtTargetPath: false })
      expect(result.ok).to.be.false
      expect(result.reason).to.include('still exists')
    })

    it('accepts a case-only rename where the old path still resolves to the same directory', async () => {
      useFakeFs({ '/books/Author/Book A': { ino: 100, dir: true }, '/books/Author/book a': { ino: 100, dir: true } })
      const result = await inoMatchGuard.checkInoMatch({ libraryItem: item, targetPath: '/books/Author/book a', targetFiles: [{ filename: 'a.mp3', size: 1000 }], otherItemAtTargetPath: false })
      expect(result.ok).to.be.true
    })

    it('rejects a case-only path difference that is a different directory', async () => {
      useFakeFs({ '/books/Author/Book A': { ino: 100, dir: true }, '/books/Author/book a': { ino: 555, dir: true } })
      const result = await inoMatchGuard.checkInoMatch({ libraryItem: item, targetPath: '/books/Author/book a', targetFiles: [{ filename: 'a.mp3', size: 1000 }], otherItemAtTargetPath: false })
      expect(result.ok).to.be.false
    })

    it('rejects when another item already uses the target path', async () => {
      useFakeFs({})
      const result = await inoMatchGuard.checkInoMatch({ libraryItem: item, targetPath: '/books/Other/Book B', targetFiles: [{ filename: 'a.mp3', size: 1000 }], otherItemAtTargetPath: async () => true })
      expect(result.ok).to.be.false
      expect(result.reason).to.include('another library item')
    })

    it('rejects when no file overlaps (inode reused after a delete)', async () => {
      useFakeFs({})
      const result = await inoMatchGuard.checkInoMatch({ libraryItem: item, targetPath: '/books/Other/Book B', targetFiles: async () => [{ filename: 'b.mp3', size: 2000, ino: '101' }], otherItemAtTargetPath: false })
      expect(result.ok).to.be.false
      expect(result.reason).to.include('no file')
    })

    it('does not look at the target files when an earlier check fails', async () => {
      useFakeFs({ '/books/Author/Book A': { ino: 100, dir: true } })
      const targetFiles = sinon.stub().resolves([])
      const otherItemAtTargetPath = sinon.stub().resolves(false)
      await inoMatchGuard.checkInoMatch({ libraryItem: item, targetPath: '/books/Other/Book B', targetFiles, otherItemAtTargetPath })
      expect(targetFiles.called).to.be.false
      expect(otherItemAtTargetPath.called).to.be.false
    })

    it('accepts the same path without checks', async () => {
      useFakeFs({ '/books/Author/Book A': { ino: 100, dir: true } })
      const result = await inoMatchGuard.checkInoMatch({ libraryItem: item, targetPath: item.path, targetFiles: [], otherItemAtTargetPath: true })
      expect(result.ok).to.be.true
    })
  })

  describe('getTargetFilesOnDisk', () => {
    it('stats a single media file', async () => {
      useFakeFs({ '/books/x.m4b': { ino: 300, size: 5000 } })
      const files = await inoMatchGuard.getTargetFilesOnDisk('/books/x.m4b', true, 'x.m4b', { libraryFiles: [] })
      expect(files).to.deep.equal([{ filename: 'x.m4b', size: 5000, ino: '300' }])
    })

    it('ignores a single media path that is a directory or missing', async () => {
      useFakeFs({ '/books/dir': { ino: 1, dir: true } })
      expect(await inoMatchGuard.getTargetFilesOnDisk('/books/dir', true, 'dir', { libraryFiles: [] })).to.deep.equal([])
      expect(await inoMatchGuard.getTargetFilesOnDisk('/books/none.m4b', true, 'none.m4b', { libraryFiles: [] })).to.deep.equal([])
    })

    it('stats changed files and the item files at their relative paths', async () => {
      useFakeFs({
        '/books/New/new.mp3': { ino: 1, size: 10 },
        '/books/New/CD1/track.mp3': { ino: 2, size: 20 }
      })
      const files = await inoMatchGuard.getTargetFilesOnDisk('/books/New', false, ['new.mp3', 'gone.mp3'], { libraryFiles: [libraryFile('CD1/track.mp3', 20, 2), libraryFile('missing.mp3', 30, 3)] })
      expect(files).to.deep.equal([
        { filename: 'new.mp3', size: 10, ino: '1' },
        { filename: 'track.mp3', size: 20, ino: '2' }
      ])
    })
  })
})
