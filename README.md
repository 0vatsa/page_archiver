# Page Archiver

A Chrome/Brave extension that captures pages you visit as `.mhtml` files and logs them to a local database. Captures are triggered by user focus — no background polling.

---

## Rationale — What this extension is trying to solve

The web is not a library. It has no central filing system, no preservation mandate, no guarantee that anything posted today will be accessible tomorrow. Brink Lindsey put it well (https://brinklindsey.substack.com/p/the-curse-of-presentism):

> [...] we have failed to construct our new online world in a way that preserves the past and renders it accessible. The internet’s great virtue is its decentralization: it’s a protocol for sharing information, but the information that’s posted and shared comes from all of us as we build and fill up the umpteen sites that now populate the World Wide Web. It’s up to us to maintain these websites, or not; there is no centralized authority in charge of indexing and preserving all that’s posted. The internet is “not a place in any reliable sense of the word,” writes [Adrienne LaFrance](https://www.theatlantic.com/technology/archive/2015/10/raiders-of-the-lost-web/409210/). “It’s not a repository. It is not a library. It is a constantly changing patchwork of perpetual nowness.”
> The internet’s decentralization, the key to its power as a communications tool, is thus also its Achilles’ heel as a storehouse of knowledge. The main problems are now known as “content drift” and “link rot.” [Jonathan Zittrain](https://www.theatlantic.com/technology/archive/2021/06/the-internet-is-a-collective-hallucination/619320/) explains:
> > It turns out that link rot and content drift are endemic to the web, which is both unsurprising and shockingly risky for a library that has “billions of books and no central filing system.” Imagine if libraries didn’t exist and there was only a “sharing economy” for physical books: People could register what books they happened to have at home, and then others who wanted them could visit and peruse them. It’s no surprise that such a system could fall out of date, with books no longer where they were advertised to be—especially if someone reported a book being in someone else’s home in 2015, and then an interested reader saw that 2015 report in 2021 and tried to visit the original home mentioned as holding it. That’s what we have right now on the web.
> Which means that our whole scholarly apparatus for recording sources of information is now falling apart on a daily basis. A 2014 survey of citations in Supreme Court opinions and Harvard Law Review articles found that 50 percent of the links in court opinions since 1996, and 75 percent of the links in law review articles, were no longer operational. Meanwhile, links in more casual texts are even more ephemeral.

This is not a minor inconvenience — it is a structural property of how the web works. Because the internet is decentralized, the information on it is only as permanent as whoever is paying to host it. Links rot. Pages drift. Entire domains disappear.

The abundance of online information makes this worse, not better. Because so much is available instantly, it is easy to assume that whatever you need will be there when you go back for it. It usually is — until it isn't.

This extension is built around a simple, deterministic guarantee: if you have visited a page, it is saved. Not a cached fragment, not a Wayback Machine snapshot from an approximate date, but the exact page as rendered in your browser at the moment you were looking at it. Every time you focus a tab, the extension checks whether enough time has passed since the last capture and, if so, saves the full page as a self-contained MHTML archive to your local disk — and optionally into a local SQLite database as a binary blob.

Visited means saved. The page may disappear from the web tomorrow, the domain may lapse, the hosting bill may go unpaid — none of that affects your local copy. You are not dependent on any third-party archive service, any cloud provider, or any server remaining online. The archive is on your machine, queryable with standard tools, entirely under your control. This determinism is the point. It is a personal, local answer to the link rot and content drift that Lindsey describes — not a solution to the broader cultural problem, but a complete solution for your own browsing history.

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

When the native host is active, the same schema is written to a real SQLite database. The default path is:

```
~/Downloads/page-archiver/_sqlitedb/page_archiver.db
```

You can set a custom path during `python3 install.py` — the installer prompts for it and writes your choice to `native-host/page_archiver_host.conf`. To change it later, edit that file:

```
db_path = /your/custom/path/archive.db
```

The host reads the config on every startup, so no reinstall is needed after changing the path.

Column names use snake_case (`first_seen`, `last_seen`, `snapshot_count`, `captured_at`, `size_bytes`, `page_id`).

The `snapshots` table has an `mhtml_blob` column that stores the raw MHTML bytes of each capture. This means even if you delete the `.mhtml` files from your Downloads folder, the full content is preserved in the database.

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

-- Total MB of files archived
SELECT ROUND(SUM(size_bytes) / 1048576.0, 2) AS mb FROM snapshots;

-- Total MB of MHTML blobs stored in DB
SELECT ROUND(SUM(LENGTH(mhtml_blob)) / 1048576.0, 2) AS blob_mb
FROM snapshots WHERE mhtml_blob IS NOT NULL;

-- Extract a snapshot blob back to a file (run in Python)
-- import sqlite3, base64
-- conn = sqlite3.connect("page_archiver.db")
-- row = conn.execute("SELECT mhtml_blob, filename FROM snapshots WHERE id = 1").fetchone()
-- open("recovered.mhtml", "wb").write(row[0])
```

Logs are written to `_sqlitedb/host.log` (same directory as the database).

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
