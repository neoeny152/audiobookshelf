const SocketAuthority = require('../SocketAuthority')

/**
 * Set a book's chapters: saves the media, writes the metadata file (absMetadata comes last in the metadata precedence,
 * so saved chapters survive rescans) and emits item_updated. Nothing is written when the chapters are unchanged.
 *
 * Shared by POST /api/items/:id/chapters and the auto pipeline. The caller validates the chapters.
 *
 * @param {import('../models/LibraryItem')} libraryItem - expanded book item
 * @param {{title: string, start: number, end: number}[]} chapters
 * @returns {Promise<{updated: boolean}>}
 */
async function applyChapters(libraryItem, chapters) {
  let hasUpdates = false
  if (chapters.length !== libraryItem.media.chapters.length) {
    libraryItem.media.chapters = chapters.map((c, index) => {
      return {
        id: index,
        title: c.title,
        start: c.start,
        end: c.end
      }
    })
    hasUpdates = true
  } else {
    for (const [index, chapter] of chapters.entries()) {
      const currentChapter = libraryItem.media.chapters[index]
      if (currentChapter.title !== chapter.title || currentChapter.start !== chapter.start || currentChapter.end !== chapter.end) {
        currentChapter.title = chapter.title
        currentChapter.start = chapter.start
        currentChapter.end = chapter.end
        hasUpdates = true
      }
    }
  }

  if (hasUpdates) {
    libraryItem.media.changed('chapters', true)
    await libraryItem.media.save()

    await libraryItem.saveMetadataFile()

    SocketAuthority.libraryItemEmitter('item_updated', libraryItem)
  }
  return { updated: hasUpdates }
}

/**
 * Same validation as POST /api/items/:id/chapters.
 *
 * @param {*} chapters
 * @returns {boolean}
 */
function isValidChapterPayload(chapters) {
  return Array.isArray(chapters) && !chapters.some((c) => !c || !c.title || typeof c.title !== 'string' || c.start === undefined || typeof c.start !== 'number' || c.end === undefined || typeof c.end !== 'number')
}

module.exports = { applyChapters, isValidChapterPayload }
