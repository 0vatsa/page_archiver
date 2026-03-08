# Page Archiver

A Chrome/Brave extension that captures pages you visit as `.mhtml` files and logs them to a local database. Captures are triggered by user focus — no background polling.

---

## How it works

Whenever you switch to a tab or return to the browser window, the extension checks whether enough time has passed since that page was last captured (based on your configured interval). If yes, it waits your configured initial delay (to let the page finish loading), then captures.

This means:

- No captures happen while you are away from the browser.
- Revisiting the same page after the interval elapses captures it again, picking up any changes.
- Switching tabs rapidly does not trigger a flood of captures — only the focused tab is eligible, and only after the interval.

---

## Installation

### 1. Load the extension

1. Go to `brave://extensions` or `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** and select the `page-archiver/` folder
4. Note your **Extension ID** — the 32-character string shown under the extension name

### 2. Optional: SQLite native host

By default the extension stores its log in `chrome.storage.local` (a browser-internal JSON store). If you want a real SQLite database you can query with standard tools, install the native host:

```
cd native-host
python3 install.py
```

The installer auto-detects your OS (Linux, macOS, Windows) and browser (Chrome, Brave), prompts for your extension ID, and registers the host. To uninstall:

```
python3 install.py --uninstall
```

After installing the native host, open the extension popup and toggle **Save to SQLite** on. The popup will confirm the connection and show the path to your `.db` file.

---

## Settings

All settings are in the popup. Changes take effect immediately — no restart needed.

| Setting | Default | Description |
|---|---|---|
| Silent downloads | On | When on, files save directly to `Downloads/page-archiver/` with no dialog. Turn off to choose the save location each time. |
| Capture interval | 5 min | Minimum time between captures of the same page. The page must be re-focused after this interval for a new capture to trigger. |
| Initial delay | 10 sec | Time to wait after a tab is focused before capturing. Gives dynamic pages time to finish loading. Set to 0 to capture immediately. |
| Save to SQLite | Off | When on, capture metadata is written to a real SQLite database via the native host. Requires running `install.py` first. |

---

## Site filter

The filter panel has three modes, mutually exclusive:

**Off** — no filtering, all pages are captured.

**Block list** — capture everything except the domains you add. Each entry in the block list has a **stem only** toggle. With stem only off (default), the entire domain is blocked including all paths. With stem only on, only the root URL (`domain.com/`) is blocked — subpages like `domain.com/home` are still captured.

**Allow list** — capture only the domains you add. Subdomains are matched automatically: adding `github.com` also covers `gist.github.com`.

When you type a URL into the add field, the extension strips the protocol and path and stores only the hostname.

---

## File output

Files are saved to:

```
~/Downloads/page-archiver/<Title>__<ISO-timestamp>.mhtml
```

Example:

```
Downloads/page-archiver/GitHub_Explore__2026-03-08T14-30-00-000Z.mhtml
```

MHTML is a single-file web archive format. It can be opened directly in Chrome or Brave by dragging the file into a tab.

---

## Database

### Default: chrome.storage.local

Stored as JSON inside the browser profile. Two logical tables:

**pages** — one entry per unique URL

| Field | Type | Notes |
|---|---|---|
| id | number | unique |
| url | string | |
| title | string | updated on each capture |
| firstSeen | ISO string | |
| lastSeen | ISO string | |
| snapshotCount | number | |

**snapshots** — one entry per capture event

| Field | Type | Notes |
|---|---|---|
| id | number | unique |
| pageId | number | references pages.id |
| url | string | URL at capture time |
| title | string | title at capture time |
| filename | string | path within Downloads |
| capturedAt | ISO string | |
| sizeBytes | number | |
| trigger | string | `visit`, `focus`, or `manual` |

To inspect from the browser console (background service worker DevTools):

```js
chrome.storage.local.get(['page_archiver_db'], console.log)
```

### Optional: SQLite

When the native host is active, the same schema is written to:

```
~/page-archiver/archive.db
```

Column names use snake_case (`first_seen`, `last_seen`, `snapshot_count`, `captured_at`, `size_bytes`, `page_id`).

Example queries:

```sql
-- 20 most recent captures
SELECT url, captured_at, trigger, size_bytes
FROM snapshots
ORDER BY captured_at DESC
LIMIT 20;

-- Pages captured more than 10 times
SELECT url, snapshot_count
FROM pages
WHERE snapshot_count > 10
ORDER BY snapshot_count DESC;

-- Total MB archived
SELECT ROUND(SUM(size_bytes) / 1048576.0, 2) AS mb FROM snapshots;
```

Logs are written to `~/page-archiver/host.log`.

---

## Permissions

| Permission | Why |
|---|---|
| `pageCapture` | Capture the page as MHTML |
| `downloads` | Save files to disk |
| `tabs` | Detect tab focus and page loads |
| `storage` | Persist settings and DB |
| `scripting` | Inject content script for DOM-settled detection |
| `nativeMessaging` | Talk to the SQLite host process (only used if SQLite is enabled) |

---

## Privacy

The website or server cannot detect that a capture occurred. `pageCapture` reads from the browser's already-loaded DOM and resources in memory — no additional network requests are made to the origin server.

---

## Notes

- `chrome://`, `chrome-extension://`, and `about:` pages are skipped.
- Clearing the DB from the popup removes log records only — already-downloaded `.mhtml` files are not deleted.
- On Windows, the native host installer writes a `.bat` wrapper alongside the Python script, since Chrome's native messaging requires a directly executable file path.
- If the SQLite toggle is turned on but the native host is unreachable, the toggle reverts automatically and the extension falls back to `chrome.storage.local`.
