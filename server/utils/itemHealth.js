/**
 * Book health (fork only, pure, no I/O): what is probably wrong with a book's length, match and chapters, and the
 * step that comes first in fixing it. Uses only what is stored: seek index measurements on the audio files and the
 * auto pipeline's last state (its match scores and Audible chapter source).
 */

const { getTotalDrift, getDrift, needsRepair } = require('./mp3SeekIndex')
const chapterPlan = require('./autoPipeline/chapterPlan')

const LOW_CONFIDENCE_REASONS = new Set(['low-confidence', 'ambiguous'])

function round1(v) {
  return Math.round(v * 10) / 10
}

/**
 * @param {Object} params
 * @param {import('../models/LibraryItem')} params.libraryItem - expanded book item
 * @param {Object|null} params.pipelineState - AutoPipelineManager state of the item
 * @param {Object[]} params.scannerChapters - chapters the scanner would make of the audio files
 * @param {boolean} params.processing - a seek index task is queued or running for the item
 * @param {{available: boolean, autoRepair: boolean, minConfidence: number}} params.autoFix
 */
function getItemHealth({ libraryItem, pipelineState, scannerChapters, processing, autoFix }) {
  const media = libraryItem.media
  const audioFiles = media.includedAudioFiles
  const stored = media.duration || 0
  const { drift, unmeasured } = getTotalDrift(audioFiles)
  const flagged = audioFiles.filter((af) => needsRepair(af))

  const pipelineMatch = pipelineState?.match?.result && pipelineState.match.result !== 'matched' ? pipelineState.match : null
  const match = { asin: media.asin || null, confidence: pipelineMatch?.confidence ?? null, reason: pipelineMatch?.reason ?? null }

  const current = media.chapters || []
  const kind = chapterPlan.classifyChapters(current, scannerChapters, pipelineState?.chapters?.appliedHash)
  const source = pipelineState?.chapters?.source
  const chapters = {
    count: current.length,
    kind,
    end: current.length ? current[current.length - 1].end : null,
    audible: source?.asin && source.asin === media.asin && source.chapters ? { count: source.chapters, runtimeSec: source.runtimeSec } : null
  }

  const issues = []
  if (audioFiles.length) {
    if (flagged.length) issues.push('seek-index')
    if (!match.asin) issues.push(LOW_CONFIDENCE_REASONS.has(match.reason) ? 'low-confidence' : 'unmatched')
    if (kind === 'scanner' || kind === 'none') issues.push('chapters-from-files')
    if (chapters.end !== null && Math.abs(chapters.end - (stored + drift)) > chapterPlan.NEAR_SEC) issues.push('chapters-length')
    if (chapters.audible && chapters.audible.count !== chapters.count) issues.push('chapters-count')
    if (kind !== 'pipeline') issues.push('chapters-unverified')
  }
  let next = null
  if (issues.includes('seek-index')) next = 'repair'
  else if (issues.includes('unmatched') || issues.includes('low-confidence')) next = 'match'
  else if (issues.some((i) => i.startsWith('chapters-'))) next = 'chapters'

  return {
    libraryItemId: libraryItem.id,
    duration: { stored, drift: round1(drift), unmeasured },
    seekIndex: { needsRepairCount: flagged.length, maxDrift: round1(flagged.reduce((max, af) => Math.max(max, Math.abs(getDrift(af))), 0)), processing },
    match,
    chapters,
    issues,
    next,
    autoFix
  }
}

module.exports = { getItemHealth }
