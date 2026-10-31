# About this fork

This is an unofficial personal fork of [advplyr/audiobookshelf](https://github.com/advplyr/audiobookshelf), used for learning and experiments. It is not affiliated with or supported by the Audiobookshelf project. Please report problems with Audiobookshelf itself upstream, not here.

- **Upstream base:** `.upstream-base` holds the upstream `master` commit this branch is synced to (currently `edb1f7ef`, v2.37.2).
- **Matching web client:** [neoeny152/audiobookshelf-client-react](https://github.com/neoeny152/audiobookshelf-client-react). Most features below have their UI there. The stock Vue client keeps working but does not show them.

## Added

### Chapters
- **Chapter snap:** `POST /api/items/:id/chapters/snap` proposes chapter starts moved onto the nearest pause in the audio, including pauses split across a file joint. It never writes chapters itself.
- **Speech check:** optional, checks whether the chapter heading is spoken at the snapped start (`options.verify`). It needs the chapterbot sidecar.
- **Re-anchoring** (`options.reanchor`, default on): before snapping, a reference list (e.g. Audible's) that drifts against books split into part files is shifted onto the files named like its chapters.
- **Heading search** (`options.locate`, default on with the speech check): a heading not heard at its start is looked for in a wider transcript and the start moves there; unheard chapters are predicted from the headings found around them.

### Ebooks
- **EPUB from audio:** `POST /api/items/:id/epub`, with job status and cancel. It needs the sidecar. The EPUB is written next to the audio as `<Title> (from audio).epub` and becomes the primary ebook when the book has none, or when it comes with read-along data (a published ebook then stays as a supplementary file). A job that a sidecar restart interrupted is resumed instead of starting over (at most 3 times, never after a cancel). While the sidecar runs a chapter speech check it pauses EPUB jobs, and they go on afterwards.
- **Read-along:** sentence timings are stored with the EPUB and served at `GET /api/items/:id/ebook/:fileid/readalong`.

### Transcripts
- Transcripts for audiobooks and podcast episodes, from creator feeds (`<podcast:transcript>`), `.vtt`/`.srt` files next to the audio, or generated: from the read-along data of an EPUB made from the audio, otherwise through the sidecar. Podcast library settings `downloadPodcastTranscripts` and `autoTranscribePodcastEpisodes` ([#5683](https://github.com/advplyr/audiobookshelf/issues/5683), [#2919](https://github.com/advplyr/audiobookshelf/issues/2919)).

### Library maintenance
- **Automatic processing of new books:** waits for the files to settle, then MP3 seek index repair (only with consent), Audible match (only above a confidence threshold, never over an existing ASIN), Audible chapters snapped and speech checked (applied only when every check passes, otherwise left for review), and optionally an EPUB from the audio. EPUBs from automatic processing start only inside the library's quiet hours (one still running when they end finishes, the next waits for the next night); EPUBs a person asks for start at once. Every change is backed up and can be undone. Per-library mode `off` (default), `dryRun` or `on`, an optional nightly sweep of never-processed books, and a library run limited to the books that need work. Nothing runs unless the server is started with `ABS_AUTO_PIPELINE=1`.
- **MP3 seek index:** finds MP3s without a seek (Xing/VBRI) header whose measured length differs from the stored one, and remuxes them with a header (no re-encoding), keeping the originals as a restorable backup; a repair cut short by a restart resumes (`/api/tools/item/:id/seek-index`, `.../repair-seek-index`, `.../seek-index/backups/:backupId[/restore]`).
- **Book health:** `GET /api/items/:id/health` says what is probably wrong with a book's length, match and chapters, and what to do first; `GET /api/libraries/:id/needs-work` lists the books with such an issue (update permission). The client's guided fix is built on these.
- **Needs-work run:** `POST /api/libraries/:id/pipeline/run` with `{ "scope": "needs-work" }` queues every book on that list for automatic processing (books already queued or waiting for a review are left as they are).
- **Possible duplicates:** detected after scans and listed for the Issues page, by ASIN, ISBN, title + author + length, or podcast feed; never deleted or merged ([#5676](https://github.com/advplyr/audiobookshelf/issues/5676)).
- **Library search** also matches file names and paths ([#5680](https://github.com/advplyr/audiobookshelf/issues/5680)).

### API
- Batch podcast episode update and delete, and a POST variant of the library multi-item download.
- `serverFeatures` in `GET /status`, so clients can detect the endpoints above. Stock clients ignore it.

## Fixes for upstream issues

| Area | Change | Upstream |
|---|---|---|
| Stability | A failed async request gets a 500 instead of exiting the server; one failing item no longer aborts a scan | [#5215](https://github.com/advplyr/audiobookshelf/issues/5215), [#5319](https://github.com/advplyr/audiobookshelf/issues/5319) |
| Scanner | Never inserts the same book-author / book-series row twice | [#2650](https://github.com/advplyr/audiobookshelf/issues/2650), [#5215](https://github.com/advplyr/audiobookshelf/issues/5215) |
| Scanner | Inode match guard for moved items, in the watcher and the full scan | [#1447](https://github.com/advplyr/audiobookshelf/issues/1447), [#4943](https://github.com/advplyr/audiobookshelf/issues/4943), [#4981](https://github.com/advplyr/audiobookshelf/issues/4981), [#4963](https://github.com/advplyr/audiobookshelf/issues/4963) |
| Scanner | No duplicate items from concurrent watcher and library scans; exact duplicate records removed | |
| Authors / series | Case-insensitive name matching, case-only renames, merged authors keep their details | [#4255](https://github.com/advplyr/audiobookshelf/issues/4255), [#4033](https://github.com/advplyr/audiobookshelf/issues/4033), [#5278](https://github.com/advplyr/audiobookshelf/issues/5278), [#4934](https://github.com/advplyr/audiobookshelf/issues/4934) |
| Media | Duration and chapters count only included audio files | [#5311](https://github.com/advplyr/audiobookshelf/issues/5311) |
| Media | Track title tags become chapter names unless all equal the book title | [#5639](https://github.com/advplyr/audiobookshelf/issues/5639) |
| Media | Embedded cover: the attached picture stream is used, and an existing cover is checked first | [#3697](https://github.com/advplyr/audiobookshelf/issues/3697), [#4867](https://github.com/advplyr/audiobookshelf/issues/4867) |
| Media | The item is rescanned after M4B encode, so the new bitrate and file are stored | [#5675](https://github.com/advplyr/audiobookshelf/issues/5675) |
| Progress | Stale sessions no longer rewind progress, and the server's duration is trusted | [#5627](https://github.com/advplyr/audiobookshelf/issues/5627), [#5471](https://github.com/advplyr/audiobookshelf/issues/5471) |
| Progress | No duplicate media progress rows from concurrent writes | [#3845](https://github.com/advplyr/audiobookshelf/issues/3845) |
| Progress | Larger offline session syncs are accepted (after authentication) | [#4755](https://github.com/advplyr/audiobookshelf/issues/4755) |
| Progress | `items-in-progress` no longer joins every podcast episode, which ran out of memory on large podcasts | [#5677](https://github.com/advplyr/audiobookshelf/issues/5677) |

Each commit names the issue it addresses. Fixes that fit upstream are offered back as pull requests.

## Settings

| Env | Effect |
|---|---|
| `ABS_AUTO_PIPELINE=1` | Enables automatic processing of new books |
| `CHAPTERBOT_URL`, `CHAPTERBOT_TOKEN`, `CHAPTERBOT_PATH_MAP` | Connect the optional chapterbot sidecar (speech check, EPUB from audio, transcript generation). The sidecar is not part of this repository. Without it these features are not advertised. |
| `REACT_CLIENT_PATH` | Serve the React client in-process (as upstream) |

## Container images

The images are built by `.github/workflows/fork-image.yml` (this repo) and by the client fork's workflow of the same name. Each is multi-arch (amd64 and arm64), built natively per architecture. Every tag contains `fork`.

| Image | Contents |
|---|---|
| `ghcr.io/neoeny152/abs-fork-react` | This server and the React client. This is the image to run for the fork's features. |
| `ghcr.io/neoeny152/abs-fork` | This server and the stock Vue web client |

Tags:
- `fork`: the latest build
- `fork-<version>`: from a `v<upstream version>-neo.<n>` git tag
- `fork-sha-<commit>`

The combined image is built from the client's `Dockerfile`, with this repo as the `abs-server` build context:

```
docker buildx build -f audiobookshelf-client-react/Dockerfile \
  --build-context abs-client=audiobookshelf-client-react \
  --build-context abs-server=audiobookshelf \
  -t abs-fork-react:local audiobookshelf
```

Run it like the official image: port 80, `/config`, `/metadata` and your library mounts.

## How this fork is maintained

- The owner's private branch is the source of truth. This public branch is replayed from it commit by commit, keeping the original authors and dates.
- `.github/workflows/upstream-check.yml` opens an issue each day that upstream has new commits. It never merges anything: syncing is done by hand on the private branch, then replayed here and recorded in `.upstream-base`.
- The code is written with AI assistance (Claude) and reviewed by the owner.
- GPL-3.0, like upstream.
