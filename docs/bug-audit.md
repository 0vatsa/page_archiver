# Page Archiver — Bug Audit

Date: 2026-10-09 · Scope: whole repo at `master` (`4230478`) — extension (`background.js`, `lib/`, `popup.*`, `options.*`, `content.js`, `manifest.json`), native host and installer.

## How this was done

1. Read every file end to end and listed each feature's **goal** (the README's promise), then worked backwards: what input, timing or environment breaks that promise?
2. Reproduced every suspicion that could be tested, either in headless Chromium with the unpacked extension loaded or by driving the native host over its stdio protocol. Scripts live outside the repo, so nothing was added to it.
3. Gave each finding a confidence label:
   - **Confirmed:** reproduced.
   - **Code:** certain from reading the code, but not run.
   - **Platform:** depends on documented Chrome behaviour, not reproduced here.
   - **Plausible:** a real path exists, but it needs checking on a real browser.

## The features and their promises

| Feature | Promise (README) |
|---|---|
| Focus-based capture | "If you have visited a page, it is saved." Captures happen only while you're on the page, once per *interval of active viewing* per URL per tab, and "switching tabs rapidly does not trigger a flood of captures". |
| Bookmark capture | A new bookmark is archived immediately, and later visits follow the normal rules. |
| Filters | Bookmarks-only, skip home pages, block/allow list with "home page only", in a documented precedence. |
| Log | Browser storage by default, or SQLite (with a full MHTML copy) through the helper app. |
| GitHub clone | Bookmarking `github.com/owner/repo` clones it once into the configured folder. |
| UI | The popup tells you whether this page is archived and why not. |

## Summary

| # | Finding | Severity | Confidence |
|---|---|---|---|
| 1 | Simultaneous captures overwrite each other in the browser-storage log | **High** | Confirmed |
| 2 | First capture after the browser starts fails about half the time, silently | **High** | Confirmed (headless) |
| 3 | Leaving a tab doesn't cancel its pending capture, so rapid tab switching floods captures | **High** | Confirmed |
| 4 | Bookmarking a filtered page still marks it as captured, so it stays suppressed after you unblock it | **High** | Confirmed |
| 5 | The service worker going to sleep loses pending captures and all interval history | **High** | Platform |
| 6 | Pages over ~48 MB are missing from SQLite entirely, not just their blob | **High** | Platform |
| 7 | The browser-storage log hits the 10 MB quota and then silently stops (and settings stop saving) | **High** | Code |
| 8 | Manual "Archive now" doesn't cancel the pending auto-capture, so it duplicates | Medium | Confirmed |
| 9 | Pages are captured and viewing time counted while you're not looking (background windows, browser unfocused, idle) | Medium | Code |
| 10 | GitHub auto-clone: non-repo URLs, timeouts, partial clones, mass clones on sync | Medium | Confirmed / Code |
| 11 | Non-Latin page titles produce meaningless filenames | Medium | Confirmed |
| 12 | One failed ping permanently switches storage to the browser, nearly silently | Medium | Code |
| 13 | Popup status is stale or wrong in several cases | Medium | Code / Plausible |
| 14 | Allow list + hidden "home page only" flag silently skips home pages, with no way to fix it | Medium | Code |
| 15 | "Skip home pages" also skips `/?query` URLs (e.g. WordPress `?p=123`) | Medium | Code |
| 16 | Incognito pages get archived to disk if the extension is allowed in incognito | Medium | Code |
| 17 | Tabs' URLs that can't be captured aren't all excluded (view-source, Web Store, file://…) | Low | Plausible |
| 18 | A download that *starts* is recorded as archived even if it's cancelled or fails | Low | Plausible |
| 19 | Popup and an open Options tab overwrite each other's settings | Low | Code |
| 20 | `#fragment` and tracking-parameter variants count as separate pages | Low | Code |
| 21 | Native host crashes on a malformed message | Low | Confirmed |
| 22 | Clearing the SQLite log doesn't shrink the database file | Low | Confirmed |
| 23 | `EXPORT_MHTML` replies exceed Chrome's 1 MB limit (blocks the planned "open saved copy") | Low now | Confirmed |
| 24 | Installer prints the wrong DB path and misses Chromium, per-user Windows installs and macOS PATH issues | Low | Code |
| 25 | `content.js` is dead weight; unused permissions | Low | Confirmed |
| 26 | Every capture shows up in the download bubble and download history | Low | Code |

---

## High

### 1. Simultaneous captures overwrite each other in the browser-storage log
**Where:** `background.js:196` `localRecordSnapshot` → `getLocalDB()` … `saveLocalDB(db)`

Each write reads the whole log, appends a record and writes the whole log back. Two captures that overlap both read the same old copy, and the last write wins.

**Evidence:** bookmarking 4 open pages at once wrote **4 files but left 1 record** in the log, in two runs out of two. Finding #3 makes overlapping captures common.

**Impact:** captures go missing from the log, page counts and snapshot counts are wrong, and the popup says "Not archived yet" for pages that were saved.

**Fix:** put local writes through a single promise queue (`writeChain = writeChain.then(...)`). Better still, store one key per snapshot (or use IndexedDB) instead of rewriting one big object.

### 2. First capture after the browser starts fails about half the time, silently
**Where:** `background.js:348` (`FileReader.readAsDataURL(mhtmlData)`); error swallowed at `:388`

`pageCapture.saveAsMHTML` returns a Blob, but reading it throws `NotFoundError`.

**Evidence:**
- Capturing the same page 12× in fresh browsers gave `FAIL ok ok …` in 2 of 4 runs. Only the first capture failed; every later one succeeded.
- `blob.arrayBuffer()` fails the same way.
- It isn't related to size: a 0.5 MB page failed while 1–6 MB pages worked once warmed up.

This is almost certainly the "intermittent auto-capture" noted last session.

**Impact:** the first page you look at after launching the browser (often a restored session) may not be archived. There's no file, no record and no visible error. Focus captures retry on the next focus because no state was recorded, but bookmark captures don't (see #4).

**Caveat:** reproduced in headless Chromium; confirm on real Chrome and Brave.

**Fix:** retry the read once or twice on `NotFoundError`, re-capturing if needed. Also surface failures, for example a "!" badge plus a "last capture failed" line in the popup.

### 3. Leaving a tab doesn't cancel its pending capture
**Where:** `background.js:434` sets a per-tab `setTimeout`. `onActivated` (`:443`) and `onFocusChanged` (`:451`) only clear the timer of the tab being focused, never the one being left.

**Evidence:** opening 5 pages about 0.3 s apart (initial delay 3 s) produced **5 captures**. The README says only the tab you stay on should be captured.

**Impact:** a burst of captures for pages you only glanced at, which also triggers #1.

**Fix:** when a tab loses focus (tab switch, window switch, browser blur), clear its timer. In the timer callback, also re-check that the tab is still active in the focused window before capturing.

### 4. Bookmarking a filtered page still marks it as captured
**Where:** `background.js:519–533`. After `captureAndSave(tabId, "bookmark")`, the code sets `lastCapturedAtByUrl`, `skipUntilByUrl` and resets the viewing time whatever the result was.

**Evidence:** bookmarked a page while its site was blocked (correctly skipped), unblocked the site, left the tab and came back. **Not captured.**

**Impact:** for a whole interval (default 5 min, up to 24 h) the page is treated as freshly archived even though no copy exists. The same thing happens when the capture *fails* (#2).

**Fix:** only update that state when the result has `success === true`. Also note that `skipUntilByUrl` is keyed by `bookmark.url` while lookups use `tab.url`. Normalise both or drop `skipUntil`, since `lastCapturedAtByUrl` already covers it.

### 5. The service worker going to sleep loses pending captures and interval history
**Where:** `tabState` is an in-memory `Map` (`background.js:37`); delays use `setTimeout` (`:434`).

An MV3 service worker is shut down after about 30 s with no events. A pending `setTimeout` does not keep it alive.

**Impact:**
- **(a)** With "Wait for the page to load" set to 30 s or more (the UI allows up to 120 s), the capture can silently never happen.
- **(b)** Whenever the worker restarts (idle, browser update, extension reload), every URL's "last captured" time and accumulated viewing time is forgotten. Each tab is then re-captured on its next focus regardless of the interval: duplicates.

**Fix:** keep `tabState` in `chrome.storage.session` (survives worker restarts, cleared when the browser closes). Use `chrome.alarms` for delays of 30 s or more, or cap the delay below 30 s in the UI.

### 6. Pages over ~48 MB are missing from SQLite entirely
**Where:** `background.js:380` sends `RECORD_SNAPSHOT` with the whole MHTML as base64. The failure is only `console.error`'d at `:232`.

Chrome limits messages from the browser to a native host to 64 MiB (documented). Base64 makes data 33 % larger, so an MHTML over about 48 MB can't be sent. The *whole record* is lost, not just the blob. The 10 s timeout (`:156`) can also fire on slow disks for large writes, while the host may still be writing.

**Fix:** send the metadata first and the blob separately, in pieces, or have the host read the downloaded `.mhtml` from disk. Write the metadata row even if the blob fails, and show an error.

### 7. The browser-storage log hits the 10 MB quota and then silently stops
**Where:** `manifest.json` has no `unlimitedStorage`; `saveLocalDB` (`background.js:192`) never checks `chrome.runtime.lastError`.

A snapshot record is about 375 bytes, so roughly **28 k captures** fill the 10 MB `storage.local` quota. Page records come out of the same budget. After that:
- every log write fails silently;
- because settings share the same storage area, **saving settings fails too**;
- each capture also rewrites the whole log, so it gets slower as the log grows.

**Fix:** add the `unlimitedStorage` permission, check `lastError` on writes, and move the log to IndexedDB or per-record keys (this also fixes #1).

## Medium

### 8. Manual "Archive now" duplicates a pending auto-capture
**Where:** the `MANUAL_CAPTURE` handler (`background.js:577`) doesn't clear the tab's timer, and the timer callback (`:434`) doesn't re-check the interval.

**Evidence:** "Archive now" during the delay produced captures `manual, visit` for the same page.

**Fix:** clear the tab's timer on manual and bookmark captures, and re-check the interval inside the timer callback.

### 9. Captures and viewing time while you're not looking
**Where:** `background.js:466` (`onUpdated` "complete" only checks `tab.active`), `:451` and `:443`.

- **Background windows:** the active tab of an unfocused window counts as "active". Pages that auto-refresh there (dashboards, feeds) are captured and accumulate viewing time.
- **Browser unfocused:** a page that finishes loading while you're in another app is still captured. This breaks "No captures happen while you are away from the browser."
- **Switching windows:** moving focus directly from one window to another (without passing through "no window") never stops the previous window's tab clock, so its viewing time keeps growing.
- **Idle:** a locked screen or walking away with the browser focused still counts as viewing; there's no `chrome.idle` check.

**Fix:** only treat a tab as active if its window is the focused window. Stop the clock for every tab except the focused one. Pause on `chrome.idle` "idle"/"locked".

### 10. GitHub auto-clone edge cases
**Where:** `background.js:261` `isGithubRepoUrl`, `:272` `maybeCloneGithubRepo`; `native-host/page_archiver_host.py:212`, `:235`.

| | Problem | Evidence |
|---|---|---|
| a | Any 2-segment path counts as a repo: `github.com/settings/tokens` → clone `settings/tokens`, likewise `orgs/…`, `topics/…`, `sponsors/…`, `marketplace/…`. | Confirmed (parser output) |
| b | The extension gives up after 10 s (`sendToHost` timeout), so a large repo reports "Native host timed out" while the clone continues or is killed when the connection drops. | Code |
| c | Any non-empty target folder is reported as "already cloned", including a half-finished clone (e.g. from b). It is never repaired. | Confirmed |
| d | The clone is awaited *before* the bookmark capture (`:495`), so the capture waits up to 10 s. If the tab navigates meanwhile, the bookmark capture is lost. | Code |
| e | `bookmarks.onCreated` also fires for bookmark imports and for bookmarks arriving through **Chrome Sync from another device**, so you get a burst of clones and notifications. | Platform |
| f | `git` inherits the host's stdin and has no `GIT_TERMINAL_PROMPT=0`. Private or non-existent repos can pop credential prompts (e.g. Git Credential Manager windows). | Plausible |
| g | `Owner/Repo` and `owner/repo` clone into two folders. | Confirmed (parser output) |

**Fix:**
- Exclude GitHub's reserved top-level paths.
- Run clones in the background on the host (reply right away, then report the result with a separate check or a notification).
- Clone into a temporary folder and rename it when done.
- Run the clone *after* the capture, without blocking it.
- Ignore events during `onImportBegan`/`onImportEnded`, and consider only cloning when the bookmarked page is open in a tab.
- Use `stdin=DEVNULL` and `GIT_TERMINAL_PROMPT=0`.
- Lowercase the target folder name.

### 11. Non-Latin page titles produce meaningless filenames
**Where:** `background.js:335` `title.replace(/[^a-z0-9]/gi, "_")`

**Evidence:** "日本語のページ" → `_`, "Привет мир" → `_`. Every Japanese, Chinese, Russian, Arabic, Hindi or emoji-only title becomes `___2026-…mhtml`.

**Fix:** keep Unicode letters and numbers (`/[^\p{L}\p{N}]+/gu`) and strip only characters filesystems reject. Fall back to the hostname when the result is empty.

### 12. One failed ping permanently switches storage to the browser
**Where:** `popup.js:458`, `options.js:306` (behaviour kept from the original popup)

Opening the popup or Options while the helper app is slow (more than 10 s, e.g. the database is busy) or briefly unavailable rewrites `useNativeHost = false`. The "Storage issue" pill shows **only on that one popup open**. From then on captures quietly go to the browser log, and the two logs drift apart.

**Fix:** never change the setting from a read. Show a persistent "SQLite unreachable" state and let the user choose. Optionally queue records and retry.

### 13. Popup status is stale or wrong
**Where:** `popup.js`

- **(a)** After a successful "Archive now" the popup reloads stats immediately. But the log write is fire-and-forget (`background.js:380`), so the new record may not be there yet. After 1.5 s the status can flip to "Not archived yet". This is likely in SQLite mode. *Plausible.*
- **(b)** "Archived …" only checks the 30 most recent pages (`:95`), so an older archived page shows "Not archived yet". *Code.*
- **(c)** "Next copy after N min more on this page" (`:157`) suggests it will happen automatically while you stay. In fact recapture only happens on the next focus or load. *Code.*

**Fix:**
- (a) Make `captureAndSave` await the log write before replying, or return the new record.
- (b) Add a `GET_PAGE` lookup by URL.
- (c) Reword the line, or schedule the recapture.

### 14. Allow list + hidden "home page only" flag
**Where:** `lib/filter.js:49`; `options.js` shows the toggle only in block mode.

An entry set to "home page only" in block mode keeps `stemOnly: true` after switching to allow mode. Its home page is then skipped, there's no visible control to change that, and the popup's "Change" link leads to a page that can't change it.

**Fix:** either show the toggle in allow mode too, or ignore and clear `stemOnly` when in allow mode.

### 15. "Skip home pages" also skips `/?query` URLs
**Where:** `lib/filter.js:38`: `isRoot` only looks at the path.

`example.com/?p=123` (WordPress default links), `site.com/?article=…`, `/?s=search` are all treated as home pages and skipped.

**Fix:** treat a URL as a home page only when the path is `/` **and** there's no query string (decide whether a hash counts).

### 16. Incognito pages get archived
**Where:** `manifest.json` has no `"incognito"` key, so the default "spanning" mode applies.

If a user enables "Allow in Incognito" (some do, for other features), private pages are written to Downloads and the log.

**Fix:** set `"incognito": "not_allowed"`, or skip `tab.incognito` unless a clearly-labelled opt-in is on.

## Low

### 17. Some URLs that can't be captured aren't excluded
**Where:** `background.js:316`, `:402` and `ui/dom.js:81` only exclude `chrome://`, `chrome-extension://` and `about:`.

`view-source:`, `devtools:`, `chrome-search:`, `edge://`, `brave://`, the Chrome Web Store, `file://` without file access, and PDF viewer tabs all lead to capture errors. The popup offers "Archive now" there and then fails.

**Fix:** only allow `http:`/`https:` (plus `file:` when `chrome.extension.isAllowedFileSchemeAccess()` is true), and exclude the Web Store hosts.

### 18. A started download is recorded as archived
**Where:** `background.js:356`. The `downloads.download` callback fires when the download *starts*.

A cancelled "Save as" dialog (with "Save without asking" off), a full disk or a blocked download still produces a log record and the ✓ badge.

**Fix:** wait for `downloads.onChanged` to reach `complete` before recording, and record `interrupted` as a failure.

### 19. Popup and Options overwrite each other
**Where:** `options.js` keeps its own copies of settings and never listens to `storage.onChanged`.

Unblocking a site from the popup and then editing the list in an Options tab that was already open puts the site back.

**Fix:** listen to `chrome.storage.onChanged` and re-render.

### 20. `#fragment` and tracking parameters count as separate pages
**Where:** timing state and the log are keyed by the exact `tab.url`.

`/article#comments` and `/article?utm_source=x` are separate pages with separate timers, giving extra captures and duplicate log entries.

**Fix:** normalise URLs (drop the fragment, optionally common tracking parameters) for timing state and log keys, while still saving the full URL.

### 21. Native host crashes on a malformed message
**Where:** `page_archiver_host.py:306`. `json.loads` isn't inside the error handling.

**Evidence:** a bad message followed by a valid `PING` gave exit code 1 and no reply. Unlikely from the extension, but trivial to harden.

### 22. Clearing the SQLite log doesn't shrink the file
**Where:** `page_archiver_host.py:188`

**Evidence:** the database stayed at 3.1 MB after clearing.

**Fix:** run `VACUUM` (and `PRAGMA wal_checkpoint(TRUNCATE)`) after clearing.

### 23. `EXPORT_MHTML` replies exceed Chrome's 1 MB limit
**Where:** `page_archiver_host.py:196`

**Evidence:** a 3 MB snapshot produced a 4.2 MB reply. Chrome rejects messages over 1 MB from a host. Not used yet, but it blocks the planned "open a saved copy" feature.

**Fix:** send it in pieces, or have the host write the file to disk and return its path.

### 24. Installer issues
**Where:** `native-host/install.py`

- Prints the wrong database path and query command (`~/page-archiver/archive.db`, `:192`, `:197`).
- No Chromium (`~/.config/chromium/NativeMessagingHosts`), Flatpak or Snap support.
- Windows detection only checks `HKLM` (`:116`), so per-user Chrome or Brave installs are missed and it falls back to "chrome".
- **macOS:** a browser started from the Dock gets a minimal `PATH`. `#!/usr/bin/env python3` may hit the Xcode stub, and Homebrew `git` won't be found ("git is not installed").
- Uninstall leaves the `.conf` and `.bat` behind.

**Fix:**
- Print the configured path.
- Add the missing browser locations and check `HKCU` on Windows.
- Write an absolute interpreter path into a small launcher script.
- Have the host look for `git` in common locations.

### 25. `content.js` is dead weight; unused permissions
`content.js` sends `PAGE_SETTLED`, which nothing handles (verified: resolves with `undefined`, no error). It still runs a `MutationObserver` on every page and wakes the service worker on every load and big DOM change.

The `scripting` and `activeTab` permissions are unused; the README says `scripting` injects the content script, which isn't true.

**Fix:** remove it all, or implement "re-capture after the page settles" (already planned).

### 26. Download noise
Every capture appears in the download bubble and in `chrome://downloads`, so heavy users get thousands of entries.

**Fix:** consider `chrome.downloads.setUiOptions({ enabled: false })` around captures (needs the `downloads.ui` permission), and optionally `chrome.downloads.erase` for capture entries.

---

## Suggested fix order

1. **#1, #7:** move the browser log to IndexedDB or per-record keys with serialized writes, plus `unlimitedStorage`.
2. **#3, #8, #9, #4, #5:** rework scheduling so one place owns "which tab is really being viewed". Cancel other timers, check the focused window and idle state, persist state in `storage.session`, and only mark success on success.
3. **#2, #18:** make captures reliable (retry the blob read, wait for download completion) and show failures in the UI.
4. **#10, #6, #12:** native-host robustness (background clones, blob in pieces, no silent storage switch).
5. The rest are small, independent fixes.
