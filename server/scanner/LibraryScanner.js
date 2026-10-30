const sequelize = require('sequelize')
const Path = require('path')
const packageJson = require('../../package.json')
const Logger = require('../Logger')
const SocketAuthority = require('../SocketAuthority')
const Database = require('../Database')
const fs = require('../libs/fsExtra')
const fileUtils = require('../utils/fileUtils')
const scanUtils = require('../utils/scandir')
const { LogLevel, ScanResult } = require('../utils/constants')
const libraryFilters = require('../utils/queries/libraryFilters')
const TaskManager = require('../managers/TaskManager')
const LibraryItemScanner = require('./LibraryItemScanner')
const LibraryScan = require('./LibraryScan')
const LibraryItemScanData = require('./LibraryItemScanData')
const inoMatchGuard = require('./inoMatchGuard')
const Task = require('../objects/Task')

class LibraryScanner {
  constructor() {
    this.cancelLibraryScan = {}
    /** @type {string[]} - library ids */
    this.librariesScanning = []

    this.scanningFilesChanged = false
    /** @type {[import('../Watcher').PendingFileUpdate[], Task][]} */
    this.pendingFileUpdatesToScan = []

    /**
     * Tail of the per-library work queue. Full library scans and watcher folder updates
     * for the same library run one at a time so they cannot both create the same item.
     * @type {Map<string, Promise<void>>}
     */
    this.libraryLocks = new Map()
  }

  /**
   * Run fn exclusively for a library: waits for any running full scan or watcher update of the same library
   *
   * @template T
   * @param {string} libraryId
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  async runWithLibraryLock(libraryId, fn) {
    const previous = this.libraryLocks.get(libraryId) || Promise.resolve()
    let release
    const current = new Promise((resolve) => (release = resolve))
    const tail = previous.then(() => current)
    this.libraryLocks.set(libraryId, tail)

    await previous
    try {
      return await fn()
    } finally {
      release()
      if (this.libraryLocks.get(libraryId) === tail) this.libraryLocks.delete(libraryId)
    }
  }

  /**
   * Hand new items to the auto pipeline (fork only). It only records them as queued (no work inside the scan lock) and
   * does nothing unless ABS_AUTO_PIPELINE=1 and the library's autoPipeline mode is not off.
   *
   * @param {import('../models/Library')} library
   * @param {import('../models/LibraryItem')[]} libraryItems
   */
  queueForAutoPipeline(library, libraryItems) {
    if (!library || !libraryItems?.length) return
    // required here: AutoPipelineManager requires the scanner modules
    const AutoPipelineManager = require('../managers/AutoPipelineManager')
    AutoPipelineManager.onItemsAdded(
      library,
      libraryItems.map((li) => li.id)
    ).catch((error) => Logger.error(`[LibraryScanner] Queueing new items for the auto pipeline failed`, error))
  }

  /**
   * @param {string} libraryId
   * @returns {boolean}
   */
  isLibraryScanning(libraryId) {
    return this.librariesScanning.some((lid) => lid === libraryId)
  }

  /**
   *
   * @param {string} libraryId
   */
  setCancelLibraryScan(libraryId) {
    if (!this.isLibraryScanning(libraryId)) return
    this.cancelLibraryScan[libraryId] = true
  }

  /**
   *
   * @param {import('../models/Library')} library
   * @param {boolean} [forceRescan]
   */
  async scan(library, forceRescan = false) {
    if (this.isLibraryScanning(library.id)) {
      Logger.error(`[LibraryScanner] Already scanning ${library.id}`)
      return
    }

    if (!library.libraryFolders.length) {
      Logger.warn(`[LibraryScanner] Library has no folders to scan "${library.name}"`)
      return
    }

    const metadataPrecedence = library.settings.metadataPrecedence || Database.libraryModel.defaultMetadataPrecedence
    if (library.isBook && metadataPrecedence.join() !== library.lastScanMetadataPrecedence.join()) {
      const lastScanMetadataPrecedence = library.lastScanMetadataPrecedence?.join() || 'Unset'
      Logger.info(`[LibraryScanner] Library metadata precedence changed since last scan. From [${lastScanMetadataPrecedence}] to [${metadataPrecedence.join()}]`)
      forceRescan = true
    }

    const libraryScan = new LibraryScan()
    libraryScan.setData(library)
    libraryScan.verbose = true
    this.librariesScanning.push(libraryScan.libraryId)

    const taskData = {
      libraryId: library.id,
      libraryName: library.name,
      libraryMediaType: library.mediaType
    }
    const taskTitleString = {
      text: `Scanning "${library.name}" library`,
      key: 'MessageTaskScanningLibrary',
      subs: [library.name]
    }
    const task = TaskManager.createAndAddTask('library-scan', taskTitleString, null, true, taskData)

    Logger.info(`[LibraryScanner] Starting${forceRescan ? ' (forced)' : ''} library scan ${libraryScan.id} for ${libraryScan.libraryName}`)

    try {
      const canceled = await this.runWithLibraryLock(library.id, () => this.scanLibrary(libraryScan, forceRescan))
      libraryScan.setComplete()

      Logger.info(`[LibraryScanner] Library scan "${libraryScan.id}" ${canceled ? 'canceled after' : 'completed in'} ${libraryScan.elapsedTimestamp} | ${libraryScan.resultStats}`)

      if (!canceled) {
        library.lastScan = Date.now()
        library.lastScanVersion = packageJson.version
        if (library.isBook) {
          const newExtraData = library.extraData || {}
          newExtraData.lastScanMetadataPrecedence = metadataPrecedence
          library.extraData = newExtraData
          library.changed('extraData', true)
        }
        await library.save()
      }

      task.data.scanResults = libraryScan.scanResults
      if (canceled) {
        const taskFinishedString = {
          text: 'Task canceled by user',
          key: 'MessageTaskCanceledByUser'
        }
        task.setFinished(taskFinishedString)
      } else {
        task.setFinished(null, true)
      }
    } catch (err) {
      libraryScan.setComplete()

      Logger.error(`[LibraryScanner] Library scan ${libraryScan.id} failed after ${libraryScan.elapsedTimestamp} | ${libraryScan.resultStats}.`, err)

      task.data.scanResults = libraryScan.scanResults
      const taskFailedString = {
        text: 'Failed',
        key: 'MessageTaskFailed'
      }
      task.setFailed(taskFailedString)
    }

    if (this.cancelLibraryScan[libraryScan.libraryId]) delete this.cancelLibraryScan[libraryScan.libraryId]
    this.librariesScanning = this.librariesScanning.filter((lid) => lid !== library.id)

    TaskManager.taskFinished(task)

    // Possible duplicates are re-checked after every library scan, scheduled ones included (#5676)
    require('../managers/DuplicateItemManager').scheduleCheck(library.id)

    libraryScan.saveLog()
  }

  /**
   *
   * @param {import('./LibraryScan')} libraryScan
   * @param {boolean} forceRescan
   * @returns {Promise<boolean>} true if scan canceled
   */
  async scanLibrary(libraryScan, forceRescan) {
    // Make sure library filter data is set
    //   this is used to check for existing authors & series
    await libraryFilters.getFilterData(libraryScan.libraryMediaType, libraryScan.libraryId)

    /** @type {LibraryItemScanData[]} */
    let libraryItemDataFound = []

    // Scan each library folder
    for (let i = 0; i < libraryScan.libraryFolders.length; i++) {
      const folder = libraryScan.libraryFolders[i]
      const itemDataFoundInFolder = await this.scanFolder(libraryScan.library, folder)
      libraryScan.addLog(LogLevel.INFO, `${itemDataFoundInFolder.length} item data found in folder "${folder.path}"`)
      libraryItemDataFound = libraryItemDataFound.concat(itemDataFoundInFolder)
    }

    if (this.shouldCancelScan(libraryScan)) return true

    let existingLibraryItems = await Database.libraryItemModel.findAll({
      where: {
        libraryId: libraryScan.libraryId
      }
    })

    // Remove exact duplicate item records left by earlier concurrent scans (keeps the oldest, never touches files)
    const duplicateResults = await this.removeExactDuplicateLibraryItems(existingLibraryItems, libraryScan)
    existingLibraryItems = duplicateResults.libraryItems

    if (this.shouldCancelScan(libraryScan)) return true

    const libraryItemIdsMissing = []
    let libraryItemsUpdated = []
    for (const existingLibraryItem of existingLibraryItems) {
      // First try to find matching library item with exact file path
      let libraryItemData = libraryItemDataFound.find((lid) => lid.path === existingLibraryItem.path)
      if (!libraryItemData) {
        // Fallback to finding matching library item with matching inode value
        libraryItemData = await this.findGuardedInoMatchItemData(existingLibraryItem, existingLibraryItems, libraryItemDataFound, libraryScan)
        if (libraryItemData) {
          libraryScan.addLog(LogLevel.INFO, `Library item with path "${existingLibraryItem.path}" was not found, but library item inode "${existingLibraryItem.ino}" was found at path "${libraryItemData.path}"`)
        }
      }

      if (!libraryItemData) {
        // Podcast folder can have no episodes and still be valid
        if (libraryScan.libraryMediaType === 'podcast' && (await fs.pathExists(existingLibraryItem.path))) {
          libraryScan.addLog(LogLevel.INFO, `Library item "${existingLibraryItem.relPath}" folder exists but has no episodes`)
        } else {
          libraryScan.addLog(LogLevel.WARN, `Library Item "${existingLibraryItem.path}" (inode: ${existingLibraryItem.ino}) is missing`)
          libraryScan.resultsMissing++
          if (!existingLibraryItem.isMissing) {
            libraryItemIdsMissing.push(existingLibraryItem.id)

            // TODO: Temporary while using old model to socket emit
            const libraryItem = await Database.libraryItemModel.getExpandedById(existingLibraryItem.id)
            if (libraryItem) {
              libraryItem.isMissing = true
              await libraryItem.save()
              libraryItemsUpdated.push(libraryItem)
            }
          }
        }
      } else {
        libraryItemDataFound = libraryItemDataFound.filter((lidf) => lidf !== libraryItemData)
        let libraryItemDataUpdated = await libraryItemData.checkLibraryItemData(existingLibraryItem, libraryScan)
        if (libraryItemDataUpdated || forceRescan) {
          if (forceRescan || libraryItemData.hasLibraryFileChanges || libraryItemData.hasPathChange) {
            // One failing item must not abort the whole scan (#5319)
            let rescanResult = null
            try {
              rescanResult = await LibraryItemScanner.rescanLibraryItemMedia(existingLibraryItem, libraryItemData, libraryScan.library.settings, libraryScan)
            } catch (error) {
              libraryScan.addLog(LogLevel.ERROR, `Failed to rescan library item "${existingLibraryItem.relPath}": ${error?.message || error}`)
              Logger.error(`[LibraryScanner] Failed to rescan library item "${existingLibraryItem.relPath}"`, error)
            }
            if (!rescanResult) {
              // Skipped - error logged above
            } else if (!forceRescan || rescanResult.wasUpdated) {
              libraryScan.resultsUpdated++
              libraryItemsUpdated.push(rescanResult.libraryItem)
            } else {
              libraryScan.addLog(LogLevel.DEBUG, `Library item "${existingLibraryItem.relPath}" is up-to-date`)
            }
          } else {
            libraryScan.resultsUpdated++
            // TODO: Temporary while using old model to socket emit
            const libraryItem = await Database.libraryItemModel.getExpandedById(existingLibraryItem.id)
            libraryItemsUpdated.push(libraryItem)
          }
        } else {
          libraryScan.addLog(LogLevel.DEBUG, `Library item "${existingLibraryItem.relPath}" is up-to-date`)
        }
      }

      // Emit item updates in chunks of 10 to client
      if (libraryItemsUpdated.length === 10) {
        SocketAuthority.libraryItemsEmitter('items_updated', libraryItemsUpdated)
        libraryItemsUpdated = []
      }

      if (this.shouldCancelScan(libraryScan)) return true
    }
    // Emit item updates to client
    if (libraryItemsUpdated.length) {
      SocketAuthority.libraryItemsEmitter('items_updated', libraryItemsUpdated)
    }

    if (this.shouldCancelScan(libraryScan)) return true

    // Update missing library items
    if (libraryItemIdsMissing.length) {
      libraryScan.addLog(LogLevel.INFO, `Updating ${libraryItemIdsMissing.length} library items missing`)
      await Database.libraryItemModel.update(
        {
          isMissing: true,
          lastScan: Date.now(),
          lastScanVersion: packageJson.version
        },
        {
          where: {
            id: libraryItemIdsMissing
          }
        }
      )
    }

    await this.syncReferencedDuplicatesMissing(duplicateResults.referencedDuplicates, libraryScan)

    if (this.shouldCancelScan(libraryScan)) return true

    // Add new library items
    if (libraryItemDataFound.length) {
      let newLibraryItems = []
      for (const libraryItemData of libraryItemDataFound) {
        // One failing item must not abort the whole scan or keep the other new books out (#5319)
        let newLibraryItem = null
        try {
          newLibraryItem = await LibraryItemScanner.scanNewLibraryItem(libraryItemData, libraryScan.library.settings, libraryScan)
        } catch (error) {
          libraryScan.addLog(LogLevel.ERROR, `Failed to add new library item "${libraryItemData.relPath}": ${error?.message || error}`)
          Logger.error(`[LibraryScanner] Failed to add new library item "${libraryItemData.relPath}"`, error)
        }
        if (newLibraryItem) {
          newLibraryItems.push(newLibraryItem)

          libraryScan.resultsAdded++
        }

        // Emit new items in chunks of 10 to client
        if (newLibraryItems.length === 10) {
          SocketAuthority.libraryItemsEmitter('items_added', newLibraryItems)
          this.queueForAutoPipeline(libraryScan.library, newLibraryItems)
          newLibraryItems = []
        }

        if (this.shouldCancelScan(libraryScan)) return true
      }
      // Emit new items to client
      if (newLibraryItems.length) {
        SocketAuthority.libraryItemsEmitter('items_added', newLibraryItems)
        this.queueForAutoPipeline(libraryScan.library, newLibraryItems)
      }
    }

    // Author book count updates and empty authors/series cleanup after all items are processed
    await LibraryItemScanner.finalizeAuthorsAndSeriesFromScan(libraryScan.libraryId, libraryScan)

    libraryScan.addLog(LogLevel.INFO, `Scan completed. ${libraryScan.resultStats}`)
    return false
  }

  /**
   * Full scan fallback when no scanned item data has the existing item's path: find item data whose inode
   * matches the existing item, and accept it only when the inode match guard passes
   * (old path gone, no other item at the new path, at least one overlapping file). #1447 #4943
   *
   * @param {import('../models/LibraryItem')} existingLibraryItem
   * @param {import('../models/LibraryItem')[]} existingLibraryItems all items of the library (after duplicate cleanup)
   * @param {LibraryItemScanData[]} libraryItemDataFound item data not yet matched
   * @param {LibraryScan} libraryScan
   * @returns {Promise<LibraryItemScanData|null>}
   */
  async findGuardedInoMatchItemData(existingLibraryItem, existingLibraryItems, libraryItemDataFound, libraryScan) {
    const candidates = libraryItemDataFound.filter((lid) => ItemToItemInoMatch(lid, existingLibraryItem) || ItemToFileInoMatch(lid, existingLibraryItem) || ItemToFileInoMatch(existingLibraryItem, lid))
    for (const lid of candidates) {
      const result = await inoMatchGuard.checkInoMatch({
        libraryItem: existingLibraryItem,
        targetPath: lid.path,
        targetFiles: (lid.libraryFiles || []).map(inoMatchGuard.libraryFileToCandidate),
        otherItemAtTargetPath: existingLibraryItems.some((li) => li.id !== existingLibraryItem.id && li.path === lid.path)
      })
      if (result.ok) return lid
      libraryScan.addLog(LogLevel.WARN, `Library item "${existingLibraryItem.path}" (inode ${existingLibraryItem.ino}) has an inode match at "${lid.path}" that was not used: ${result.reason}`)
    }
    return null
  }

  /**
   * Find library items that share the exact same path and inode (duplicates created by concurrent scans).
   * The oldest record is kept. Newer records are removed from the database only when nothing references them
   * (progress, listening sessions, open playback, bookmarks, playlists, collections, share links, feeds).
   * Files on disk are never touched.
   * Duplicates that cannot be removed safely are logged and left out of the scan; they follow the kept item's missing state.
   *
   * @param {import('../models/LibraryItem')[]} libraryItems
   * @param {import('./LibraryScan')} libraryScan
   * @returns {Promise<{libraryItems: import('../models/LibraryItem')[], referencedDuplicates: {duplicate: import('../models/LibraryItem'), keep: import('../models/LibraryItem')}[]}>}
   *   library items to continue scanning with, and duplicates that were kept
   */
  async removeExactDuplicateLibraryItems(libraryItems, libraryScan) {
    /** @type {Map<string, import('../models/LibraryItem')[]>} */
    const groups = new Map()
    for (const libraryItem of libraryItems) {
      if (!libraryItem.path || !libraryItem.ino) continue
      const key = `${libraryItem.path}\u0000${libraryItem.ino}`
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(libraryItem)
    }

    const idsToSkip = new Set()
    /** @type {{duplicate: import('../models/LibraryItem'), keep: import('../models/LibraryItem')}[]} */
    const referencedDuplicates = []
    for (const group of groups.values()) {
      if (group.length < 2) continue

      group.sort((a, b) => getTime(a.createdAt) - getTime(b.createdAt) || getTime(a.addedAt) - getTime(b.addedAt) || String(a.id).localeCompare(String(b.id)))
      const [keep, ...duplicates] = group
      for (const duplicate of duplicates) {
        idsToSkip.add(duplicate.id)

        // Removing the record also destroys its media (LibraryItem afterDestroy), so never remove one sharing media with the kept item
        if (duplicate.mediaId === keep.mediaId || duplicate.mediaType !== keep.mediaType) {
          libraryScan.addLog(LogLevel.WARN, `Duplicate library item "${duplicate.id}" of "${keep.id}" at path "${duplicate.path}" shares media or has a different media type - not removing, resolve manually`)
          referencedDuplicates.push({ duplicate, keep })
          continue
        }

        const references = await getLibraryItemReferences(duplicate)
        // Checked last and synchronously right before removing, so playback started during the database checks is seen
        if (getOpenPlaybackSessionCount(duplicate.id)) references.push('an open playback session')
        if (references.length) {
          libraryScan.addLog(LogLevel.WARN, `Duplicate library item "${duplicate.id}" of "${keep.id}" at path "${duplicate.path}" has ${references.join(', ')} - not removing, resolve manually`)
          referencedDuplicates.push({ duplicate, keep })
          continue
        }

        libraryScan.addLog(LogLevel.WARN, `Removing duplicate library item record "${duplicate.id}" at path "${duplicate.path}" (inode ${duplicate.ino}), keeping oldest "${keep.id}"`)
        await Database.libraryItemModel.removeById(duplicate.id)
        SocketAuthority.emitter('item_removed', {
          id: duplicate.id,
          libraryId: duplicate.libraryId
        })
      }
    }

    return {
      libraryItems: idsToSkip.size ? libraryItems.filter((li) => !idsToSkip.has(li.id)) : libraryItems,
      referencedDuplicates
    }
  }

  /**
   * Duplicates that had to be kept are left out of the scan, so give them the missing state of the item they duplicate
   *
   * @param {{duplicate: import('../models/LibraryItem'), keep: import('../models/LibraryItem')}[]} referencedDuplicates
   * @param {import('./LibraryScan')} libraryScan
   */
  async syncReferencedDuplicatesMissing(referencedDuplicates, libraryScan) {
    if (!referencedDuplicates.length) return

    const keepIds = [...new Set(referencedDuplicates.map(({ keep }) => keep.id))]
    const keptItems = await Database.libraryItemModel.findAll({ attributes: ['id', 'isMissing'], where: { id: keepIds } })
    const keepMissing = new Map(keptItems.map((li) => [li.id, !!li.isMissing]))

    const libraryItemsUpdated = []
    for (const { duplicate, keep } of referencedDuplicates) {
      if (!keepMissing.has(keep.id)) continue
      const isMissing = keepMissing.get(keep.id)
      if (!!duplicate.isMissing === isMissing) continue

      libraryScan.addLog(LogLevel.INFO, `Duplicate library item "${duplicate.id}" marked ${isMissing ? 'missing' : 'present'} like "${keep.id}"`)
      const libraryItem = await Database.libraryItemModel.getExpandedById(duplicate.id)
      if (!libraryItem) continue
      libraryItem.isMissing = isMissing
      await libraryItem.save()
      libraryItemsUpdated.push(libraryItem)
    }
    if (libraryItemsUpdated.length) {
      SocketAuthority.libraryItemsEmitter('items_updated', libraryItemsUpdated)
    }
  }

  shouldCancelScan(libraryScan) {
    if (this.cancelLibraryScan[libraryScan.libraryId]) {
      libraryScan.addLog(LogLevel.INFO, `Scan canceled. ${libraryScan.resultStats}`)
      return true
    }
    return false
  }

  /**
   * Get scan data for library folder
   * @param {import('../models/Library')} library
   * @param {import('../models/LibraryFolder')} folder
   * @returns {LibraryItemScanData[]}
   */
  async scanFolder(library, folder) {
    const folderPath = fileUtils.filePathToPOSIX(folder.path)

    const pathExists = await fs.pathExists(folderPath)
    if (!pathExists) {
      Logger.error(`[scandir] Invalid folder path does not exist "${folderPath}"`)
      return []
    }

    const fileItems = await fileUtils.recurseFiles(folderPath)
    const libraryItemGrouping = scanUtils.groupFileItemsIntoLibraryItemDirs(library.mediaType, fileItems, library.settings.audiobooksOnly)

    if (!Object.keys(libraryItemGrouping).length) {
      Logger.error(`Root path has no media folders: ${folderPath}`)
      return []
    }

    const items = []
    for (const libraryItemPath in libraryItemGrouping) {
      let isFile = false // item is not in a folder
      let libraryItemData = null
      let fileObjs = []
      if (libraryItemPath === libraryItemGrouping[libraryItemPath]) {
        // Media file in root only get title
        libraryItemData = {
          mediaMetadata: {
            title: Path.basename(libraryItemPath, Path.extname(libraryItemPath))
          },
          path: Path.posix.join(folderPath, libraryItemPath),
          relPath: libraryItemPath
        }
        fileObjs = await scanUtils.buildLibraryFile(folderPath, [libraryItemPath])
        isFile = true
      } else {
        libraryItemData = scanUtils.getDataFromMediaDir(library.mediaType, folderPath, libraryItemPath)
        fileObjs = await scanUtils.buildLibraryFile(libraryItemData.path, libraryItemGrouping[libraryItemPath])
      }

      const libraryItemFolderStats = await fileUtils.getFileTimestampsWithIno(libraryItemData.path)

      if (!libraryItemFolderStats.ino) {
        Logger.warn(`[LibraryScanner] Library item folder "${libraryItemData.path}" has no inode value`)
        continue
      }

      items.push(
        new LibraryItemScanData({
          libraryFolderId: folder.id,
          libraryId: folder.libraryId,
          mediaType: library.mediaType,
          ino: libraryItemFolderStats.ino,
          mtimeMs: libraryItemFolderStats.mtimeMs || 0,
          ctimeMs: libraryItemFolderStats.ctimeMs || 0,
          birthtimeMs: libraryItemFolderStats.birthtimeMs || 0,
          path: libraryItemData.path,
          relPath: libraryItemData.relPath,
          isFile,
          mediaMetadata: libraryItemData.mediaMetadata || null,
          libraryFiles: fileObjs
        })
      )
    }
    return items
  }

  /**
   * Scan files changed from Watcher
   * @param {import('../Watcher').PendingFileUpdate[]} fileUpdates
   * @param {Task} pendingTask
   */
  async scanFilesChanged(fileUpdates, pendingTask) {
    if (!fileUpdates?.length) return

    // If already scanning files from watcher then add these updates to queue
    if (this.scanningFilesChanged) {
      this.pendingFileUpdatesToScan.push([fileUpdates, pendingTask])
      Logger.debug(`[LibraryScanner] Already scanning files from watcher - file updates pushed to queue (size ${this.pendingFileUpdatesToScan.length})`)
      return
    }
    this.scanningFilesChanged = true

    const results = {
      added: 0,
      updated: 0,
      removed: 0
    }

    // files grouped by folder
    const folderGroups = this.getFileUpdatesGrouped(fileUpdates)
    /** @type {Promise<void>[]} folder scans waiting for their library to be free */
    const waitingFolderScans = []

    for (const folderId in folderGroups) {
      const libraryId = folderGroups[folderId].libraryId

      const library = await Database.libraryModel.findByPk(libraryId, {
        include: {
          model: Database.libraryFolderModel,
          where: {
            id: folderId
          }
        }
      })
      if (!library) {
        Logger.error(`[LibraryScanner] Library "${libraryId}" not found in files changed ${libraryId}`)
        continue
      }
      const folder = library.libraryFolders[0]

      const filePathItems = folderGroups[folderId].fileUpdates.map((fileUpdate) => fileUtils.getFilePathItemFromFileUpdate(fileUpdate))
      const fileUpdateGroup = scanUtils.groupFileItemsIntoLibraryItemDirs(library.mediaType, filePathItems, !!library.settings?.audiobooksOnly, true)

      if (!Object.keys(fileUpdateGroup).length) {
        Logger.info(`[LibraryScanner] No important changes to scan for in folder "${folderId}"`)
        continue
      }
      // Runs after any full scan or earlier watcher update of this library so both do not add the same item.
      // The lock queue is joined right away, so updates for one library keep their order.
      const libraryBusy = this.libraryLocks.has(library.id)
      const folderScan = this.runWithLibraryLock(library.id, () => this.scanFolderUpdates(library, folder, fileUpdateGroup)).then((folderScanResults) => this.tallyFolderScanResults(libraryId, folderScanResults, results))
      if (libraryBusy) {
        // Do not hold up watcher updates of other libraries while this library is busy (a full scan can take hours)
        Logger.info(`[LibraryScanner] Library "${library.name}" is being scanned - folder "${folderId}" updates will run after it`)
        waitingFolderScans.push(
          folderScan.catch((error) => {
            Logger.error(`[LibraryScanner] Failed to scan file updates in folder "${folderId}"`, error)
          })
        )
      } else {
        await folderScan
      }
    }

    // Let the next queued watcher updates start, then finish this task once the busy libraries are done
    this.scanningFilesChanged = false
    if (this.pendingFileUpdatesToScan.length) {
      Logger.debug(`[LibraryScanner] File updates finished scanning with more updates in queue (${this.pendingFileUpdatesToScan.length})`)
      this.scanFilesChanged(...this.pendingFileUpdatesToScan.shift())
    }
    if (waitingFolderScans.length) {
      await Promise.all(waitingFolderScans)
    }

    // Complete task and send results to client
    const resultStrs = []
    if (results.added) resultStrs.push(`${results.added} added`)
    if (results.updated) resultStrs.push(`${results.updated} updated`)
    if (results.removed) resultStrs.push(`${results.removed} missing`)
    let scanResultStr = 'No changes needed'
    if (resultStrs.length) scanResultStr = resultStrs.join(', ')

    pendingTask.data.scanResults = {
      ...results,
      text: scanResultStr,
      elapsed: Date.now() - pendingTask.startedAt
    }
    pendingTask.setFinished(null, true)
    TaskManager.taskFinished(pendingTask)
  }

  /**
   * Add folder scan results to the watcher task totals
   *
   * @param {string} libraryId
   * @param {Record<string,number>} folderScanResults
   * @param {{added:number, updated:number, removed:number}} results
   */
  async tallyFolderScanResults(libraryId, folderScanResults, results) {
    Logger.debug(`[LibraryScanner] Folder scan results`, folderScanResults)

    let resetFilterData = false
    Object.values(folderScanResults).forEach((scanResult) => {
      if (scanResult === ScanResult.ADDED) {
        resetFilterData = true
        results.added++
      } else if (scanResult === ScanResult.REMOVED) {
        resetFilterData = true
        results.removed++
      } else if (scanResult === ScanResult.UPDATED) {
        resetFilterData = true
        results.updated++
      }
    })

    // If something was updated then reset numIssues filter data for library
    if (resetFilterData) {
      await Database.resetLibraryIssuesFilterData(libraryId)
    }
  }

  /**
   * Group array of PendingFileUpdate from Watcher by folder
   * @param {import('../Watcher').PendingFileUpdate[]} fileUpdates
   * @returns {Record<string,{libraryId:string, folderId:string, fileUpdates:import('../Watcher').PendingFileUpdate[]}>}
   */
  getFileUpdatesGrouped(fileUpdates) {
    const folderGroups = {}
    fileUpdates.forEach((file) => {
      if (folderGroups[file.folderId]) {
        folderGroups[file.folderId].fileUpdates.push(file)
      } else {
        folderGroups[file.folderId] = {
          libraryId: file.libraryId,
          folderId: file.folderId,
          fileUpdates: [file]
        }
      }
    })
    return folderGroups
  }

  /**
   * Scan grouped paths for library folder coming from Watcher
   * @param {import('../models/Library')} library
   * @param {import('../models/LibraryFolder')} folder
   * @param {Record<string, string[]>} fileUpdateGroup
   * @returns {Promise<Record<string,number>>}
   */
  async scanFolderUpdates(library, folder, fileUpdateGroup) {
    // Make sure library filter data is set
    //   this is used to check for existing authors & series
    await libraryFilters.getFilterData(library.mediaType, library.id)
    Logger.debug(`[Scanner] Scanning file update groups in folder "${folder.id}" of library "${library.name}"`)
    Logger.debug(`[Scanner] scanFolderUpdates fileUpdateGroup`, fileUpdateGroup)

    // First pass - Remove files in parent dirs of items and remap the fileupdate group
    //    Test Case: Moving audio files from library item folder to author folder should trigger a re-scan of the item
    const updateGroup = { ...fileUpdateGroup }
    for (const itemDir in updateGroup) {
      if (isSingleMediaFile(fileUpdateGroup, itemDir)) continue // Media in root path

      const itemDirNestedFiles = fileUpdateGroup[itemDir].filter((b) => b.includes('/'))
      if (!itemDirNestedFiles.length) continue

      const firstNest = itemDirNestedFiles[0].split('/').shift()
      const altDir = `${itemDir}/${firstNest}`

      const fullPath = Path.posix.join(fileUtils.filePathToPOSIX(folder.path), itemDir)
      const childLibraryItem = await Database.libraryItemModel.findOne({
        attributes: ['id', 'path'],
        where: {
          path: {
            [sequelize.Op.startsWith]: fullPath + '/'
          }
        }
      })
      if (!childLibraryItem) {
        continue
      }

      const altFullPath = Path.posix.join(fileUtils.filePathToPOSIX(folder.path), altDir)
      const altChildLibraryItem = await Database.libraryItemModel.findOne({
        attributes: ['id', 'path'],
        where: {
          path: {
            [sequelize.Op.startsWith]: altFullPath + '/'
          }
        }
      })
      if (altChildLibraryItem) {
        continue
      }

      delete fileUpdateGroup[itemDir]
      fileUpdateGroup[altDir] = itemDirNestedFiles.map((f) => f.split('/').slice(1).join('/'))
      Logger.warn(`[LibraryScanner] Some files were modified in a parent directory of a library item "${childLibraryItem.path}" - ignoring`)
    }

    // Second pass: Check for new/updated/removed items
    const itemGroupingResults = {}
    for (const itemDir in fileUpdateGroup) {
      const fullPath = Path.posix.join(fileUtils.filePathToPOSIX(folder.path), itemDir)

      const itemDirParts = itemDir.split('/').slice(0, -1)

      const potentialChildDirs = [fullPath]
      for (let i = 0; i < itemDirParts.length; i++) {
        potentialChildDirs.push(
          Path.posix.join(
            fileUtils.filePathToPOSIX(folder.path),
            itemDir
              .split('/')
              .slice(0, -1 - i)
              .join('/')
          )
        )
      }

      // Check if book dir group is already an item
      let existingLibraryItem = await Database.libraryItemModel.findOneExpanded({
        libraryId: library.id,
        path: potentialChildDirs
      })

      let updatedLibraryItemDetails = {}
      if (!existingLibraryItem) {
        const isSingleMedia = isSingleMediaFile(fileUpdateGroup, itemDir)
        existingLibraryItem = await findLibraryItemByGuardedInoMatch(library.id, fullPath, isSingleMedia, fileUpdateGroup[itemDir])
        if (existingLibraryItem) {
          // Update library item paths for scan
          existingLibraryItem.path = fullPath
          existingLibraryItem.relPath = itemDir
          updatedLibraryItemDetails.path = fullPath
          updatedLibraryItemDetails.relPath = itemDir
          updatedLibraryItemDetails.libraryFolderId = folder.id
          updatedLibraryItemDetails.isFile = isSingleMedia
        }
      }
      if (existingLibraryItem) {
        // Is the item exactly - check if was deleted
        if (existingLibraryItem.path === fullPath) {
          const exists = await fs.pathExists(fullPath)
          if (!exists) {
            Logger.info(`[LibraryScanner] Scanning file update group and library item was deleted "${existingLibraryItem.media.title}" - marking as missing`)
            existingLibraryItem.isMissing = true
            await existingLibraryItem.save()
            SocketAuthority.libraryItemEmitter('item_updated', existingLibraryItem)

            itemGroupingResults[itemDir] = ScanResult.REMOVED
            continue
          }
        }
        // Scan library item for updates
        Logger.debug(`[LibraryScanner] Folder update for relative path "${itemDir}" is in library item "${existingLibraryItem.media.title}" with id "${existingLibraryItem.id}" - scan for updates`)
        try {
          itemGroupingResults[itemDir] = await LibraryItemScanner.scanLibraryItem(existingLibraryItem.id, updatedLibraryItemDetails)
        } catch (error) {
          // One failing item must not stop the other folder updates (#5319)
          Logger.error(`[LibraryScanner] Failed to scan library item "${existingLibraryItem.relPath}" for folder update "${itemDir}"`, error)
          itemGroupingResults[itemDir] = ScanResult.NOTHING
        }
        continue
      } else if (library.settings.audiobooksOnly && !hasAudioFiles(fileUpdateGroup, itemDir)) {
        Logger.debug(`[LibraryScanner] Folder update for relative path "${itemDir}" has no audio files`)
        continue
      } else if (!(await fs.pathExists(fullPath))) {
        Logger.info(`[LibraryScanner] File update group "${itemDir}" does not exist - ignoring`)

        itemGroupingResults[itemDir] = ScanResult.NOTHING
        continue
      }

      // Check if a library item is a subdirectory of this dir
      const childItem = await Database.libraryItemModel.findOne({
        attributes: ['id', 'path'],
        where: {
          path: {
            [sequelize.Op.startsWith]: fullPath + '/'
          }
        }
      })
      if (childItem) {
        Logger.warn(`[LibraryScanner] Files were modified in a parent directory of a library item "${childItem.path}" - ignoring`)
        itemGroupingResults[itemDir] = ScanResult.NOTHING
        continue
      }

      Logger.debug(`[LibraryScanner] Folder update group must be a new item "${itemDir}" in library "${library.name}"`)
      const isSingleMediaItem = isSingleMediaFile(fileUpdateGroup, itemDir)
      let newLibraryItem = null
      try {
        newLibraryItem = await LibraryItemScanner.scanPotentialNewLibraryItem(fullPath, library, folder, isSingleMediaItem)
      } catch (error) {
        // One failing item must not stop the other folder updates (#5319)
        Logger.error(`[LibraryScanner] Failed to add new library item for folder update "${itemDir}"`, error)
      }
      if (newLibraryItem) {
        SocketAuthority.libraryItemEmitter('item_added', newLibraryItem)
        this.queueForAutoPipeline(library, [newLibraryItem])
      }
      itemGroupingResults[itemDir] = newLibraryItem ? ScanResult.ADDED : ScanResult.NOTHING
    }

    return itemGroupingResults
  }
}
module.exports = new LibraryScanner()

/**
 * @param {Date|number|string} value
 * @returns {number}
 */
function getTime(value) {
  const time = value ? new Date(value).valueOf() : NaN
  return isNaN(time) ? 0 : time
}

/**
 * Describe anything still referencing a library item or its media
 *
 * @param {import('../models/LibraryItem')} libraryItem
 * @returns {Promise<string[]>}
 */
async function getLibraryItemReferences(libraryItem) {
  const references = []

  let mediaItemIds = [libraryItem.mediaId]
  if (libraryItem.mediaType === 'podcast') {
    const episodes = await Database.podcastEpisodeModel.findAll({ attributes: ['id'], where: { podcastId: libraryItem.mediaId } })
    mediaItemIds = episodes.map((ep) => ep.id)
  }

  if (mediaItemIds.length) {
    const numProgress = await Database.mediaProgressModel.count({ where: { mediaItemId: mediaItemIds } })
    if (numProgress) references.push(`${numProgress} media progress`)

    const numPlaylistItems = await Database.playlistMediaItemModel.count({ where: { mediaItemId: mediaItemIds } })
    if (numPlaylistItems) references.push(`${numPlaylistItems} playlist entries`)

    const numShares = await Database.mediaItemShareModel.count({ where: { mediaItemId: mediaItemIds } })
    if (numShares) references.push(`${numShares} share links`)

    const numSessions = await Database.playbackSessionModel.count({ where: { mediaItemId: mediaItemIds } })
    if (numSessions) references.push(`${numSessions} listening sessions`)
  }

  if (libraryItem.mediaType === 'book') {
    const numCollectionBooks = await Database.collectionBookModel.count({ where: { bookId: libraryItem.mediaId } })
    if (numCollectionBooks) references.push(`${numCollectionBooks} collection entries`)
  }

  const numFeeds = await Database.feedModel.count({ where: { entityId: libraryItem.id } })
  if (numFeeds) references.push(`${numFeeds} rss feeds`)

  const users = await Database.userModel.findAll({ attributes: ['id', 'bookmarks'] })
  const numBookmarks = users.reduce((total, user) => total + (user.bookmarks || []).filter((b) => b.libraryItemId === libraryItem.id).length, 0)
  if (numBookmarks) references.push(`${numBookmarks} bookmarks`)

  return references
}

/**
 * Number of in-memory playback sessions open for a library item
 *
 * @param {string} libraryItemId
 * @returns {number}
 */
function getOpenPlaybackSessionCount(libraryItemId) {
  const sessions = SocketAuthority.Server?.playbackSessionManager?.sessions || []
  return sessions.filter((session) => session.libraryItemId === libraryItemId).length
}

function ItemToFileInoMatch(libraryItem1, libraryItem2) {
  return !!libraryItem1.ino && libraryItem1.isFile && (libraryItem2.libraryFiles || []).some((lf) => lf.ino === libraryItem1.ino)
}

function ItemToItemInoMatch(libraryItem1, libraryItem2) {
  return !!libraryItem1.ino && libraryItem1.ino === libraryItem2.ino
}

function hasAudioFiles(fileUpdateGroup, itemDir) {
  return isSingleMediaFile(fileUpdateGroup, itemDir) ? scanUtils.checkFilepathIsAudioFile(fileUpdateGroup[itemDir]) : fileUpdateGroup[itemDir].some(scanUtils.checkFilepathIsAudioFile)
}

function isSingleMediaFile(fileUpdateGroup, itemDir) {
  return itemDir === fileUpdateGroup[itemDir]
}

const INO_MATCH_ATTRIBUTES = ['id', 'path', 'ino', 'isFile', 'libraryFiles']

/**
 * Items whose own inode is the inode of the updated path (folder renamed or moved)
 *
 * @param {string} libraryId
 * @param {string} fullPath
 * @returns {Promise<import('../models/LibraryItem')[]>}
 */
async function findLibraryItemsByItemToItemInoMatch(libraryId, fullPath) {
  const ino = await fileUtils.getIno(fullPath)
  if (!ino) return []
  const libraryItems = await Database.libraryItemModel.findAll({
    attributes: INO_MATCH_ATTRIBUTES,
    where: {
      libraryId: libraryId,
      ino: ino
    }
  })
  if (libraryItems.length) Logger.debug(`[LibraryScanner] Found ${libraryItems.length} library item(s) with matching inode "${ino}" for path "${fullPath}"`)
  return libraryItems
}

/**
 * Items with a library file whose inode is the inode of the updated single media file (file moved out of an item folder)
 *
 * @param {string} libraryId
 * @param {string} fullPath
 * @param {boolean} isSingleMedia
 * @returns {Promise<import('../models/LibraryItem')[]>}
 */
async function findLibraryItemsByItemToFileInoMatch(libraryId, fullPath, isSingleMedia) {
  if (!isSingleMedia) return []
  // check if it was moved from another folder by comparing the ino to the library files
  const ino = await fileUtils.getIno(fullPath)
  if (!ino) return []
  const libraryItems = await Database.libraryItemModel.findAll({
    attributes: INO_MATCH_ATTRIBUTES,
    where: [
      {
        libraryId: libraryId
      },
      sequelize.where(sequelize.literal('(SELECT count(*) FROM json_each(libraryFiles) WHERE json_valid(json_each.value) AND json_each.value->>"$.ino" = :inode)'), {
        [sequelize.Op.gt]: 0
      })
    ],
    replacements: {
      inode: ino
    }
  })
  if (libraryItems.length) Logger.debug(`[LibraryScanner] Found ${libraryItems.length} library item(s) with a library file matching inode "${ino}" for path "${fullPath}"`)
  return libraryItems
}

/**
 * Single file items whose inode is the inode of one of the updated files (file moved from the root folder into a folder)
 *
 * @param {string} libraryId
 * @param {string} fullPath
 * @param {boolean} isSingleMedia
 * @param {string[]} itemFiles
 * @returns {Promise<import('../models/LibraryItem')[]>}
 */
async function findLibraryItemsByFileToItemInoMatch(libraryId, fullPath, isSingleMedia, itemFiles) {
  if (isSingleMedia) return []
  // check if it was moved from the root folder by comparing the ino to the ino of the scanned files
  let itemFileInos = []
  for (const itemFile of itemFiles || []) {
    const ino = await fileUtils.getIno(Path.posix.join(fullPath, itemFile))
    if (ino) itemFileInos.push(ino)
  }
  if (!itemFileInos.length) return []
  const libraryItems = await Database.libraryItemModel.findAll({
    attributes: INO_MATCH_ATTRIBUTES,
    where: {
      libraryId: libraryId,
      ino: {
        [sequelize.Op.in]: itemFileInos
      }
    }
  })
  if (libraryItems.length) Logger.debug(`[LibraryScanner] Found ${libraryItems.length} library item(s) with inode matching one of "${itemFileInos.join(',')}" for path "${fullPath}"`)
  return libraryItems
}

/**
 * Watcher fallback when no item exists at the updated path: find an existing item that was moved here, by inode.
 * An inode match alone is not trusted (Unraid shfs inode collisions, inode reuse after delete),
 * so every candidate must pass the inode match guard. #1447 #4943 #4981 #4963
 *
 * @param {string} libraryId
 * @param {string} fullPath
 * @param {boolean} isSingleMedia
 * @param {string[]|string} itemFiles relative paths from the watcher update
 * @returns {Promise<import('../models/LibraryItem')|null>} expanded library item
 */
async function findLibraryItemByGuardedInoMatch(libraryId, fullPath, isSingleMedia, itemFiles) {
  const candidates = [...(await findLibraryItemsByItemToItemInoMatch(libraryId, fullPath)), ...(await findLibraryItemsByItemToFileInoMatch(libraryId, fullPath, isSingleMedia)), ...(await findLibraryItemsByFileToItemInoMatch(libraryId, fullPath, isSingleMedia, itemFiles))]
  const checkedIds = new Set()
  for (const candidate of candidates) {
    if (checkedIds.has(candidate.id)) continue
    checkedIds.add(candidate.id)

    const result = await inoMatchGuard.checkInoMatch({
      libraryItem: candidate,
      targetPath: fullPath,
      targetFiles: () => inoMatchGuard.getTargetFilesOnDisk(fullPath, isSingleMedia, itemFiles, candidate),
      otherItemAtTargetPath: async () =>
        (await Database.libraryItemModel.count({
          where: {
            path: fullPath,
            id: {
              [sequelize.Op.ne]: candidate.id
            }
          }
        })) > 0
    })
    if (!result.ok) {
      Logger.warn(`[LibraryScanner] Library item "${candidate.path}" (inode ${candidate.ino}) has an inode match at "${fullPath}" that was not used: ${result.reason}`)
      continue
    }

    Logger.info(`[LibraryScanner] Library item "${candidate.path}" was moved to "${fullPath}" (inode match)`)
    return Database.libraryItemModel.findOneExpanded({ id: candidate.id })
  }
  return null
}
