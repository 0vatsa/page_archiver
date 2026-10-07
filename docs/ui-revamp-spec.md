# Page Archiver — UI Revamp Spec

Status: **Implemented** · Scope: **presentation layer only**

> **Decisions (§11):** rust accent and icon redraw approved; read-only `GET_TAB_STATUS` and the toolbar badge approved; `favicon` permission approved; Options page opens as a full tab; plain JavaScript only (ES modules, no build step, no Node/npm dependencies).
>
> **Notes from implementation:**
> - The popup keeps the original behaviour of switching back to browser storage when SQLite is selected but the helper app is unreachable. It now reports this in the header ("Storage issue") instead of doing it silently.
> - The original "Initial delay" field turned `0` into `10` (`parseInt(v) || 10`), so "capture immediately" could never be saved. The new stepper saves `0` as documented. Clamps are otherwise unchanged.
> - In headless-Chromium testing, focus-triggered auto-capture fails intermittently (about 1 in 3 runs) with both the original and the new `background.js`. That's the untouched capture path, so it's listed in §12.

This spec covers the visual and interaction redesign of the extension's UI. **No capture behavior, filter logic, storage schema or native-host protocol changes are made in this phase.** Functional changes are listed in [§12 Deferred](#12-deferred-to-the-functionality-session) for the next session.

---

## 1. Why the current UI feels amateur

An audit of `popup.html` / `popup.js` against standard heuristics (Nielsen's 10, WCAG 2.2 AA, Chrome extension UX conventions).

### 1.1 No visibility of system status (biggest problem)

The core promise of the product is *"visited means saved"*, yet the popup never answers the three questions a user opens it for:

1. **Is it working right now?** There is no on/off or health indicator.
2. **Is *this* page archived, and if not, why?** Filters, bookmarks-only, root-page rules and the active-time interval all silently decide whether a page is captured. The popup shows none of this. A page skipped by the block list looks identical to one that's waiting for its timer.
3. **Where did my files go?** The footer is static text that's wrong when silent downloads are off; there's no way to open a capture.

### 1.2 Flat hierarchy: everything has the same weight

- One long scrolling column: header, 3 stats, 2 buttons, 6 settings, a collapsible filter, a 30-row list and a footer, all at the same 12–13px size and grey. The popup runs past Chrome's 600px max height, so users always scroll.
- The everyday stuff (status, Capture Now, recent pages) shares the screen with set-once configuration (SQLite, GitHub clone, initial delay). The popup is trying to be both the dashboard and the settings page.
- **Capture Now** (primary action) and **Clear DB** (destructive) are side by side at the same size. That invites a costly mis-click, which only a native `confirm()` dialog guards against.

### 1.3 Jargon and leaky abstractions in copy

| Current label | Problem |
|---|---|
| Capture interval | It is actually *active viewing time per URL per tab*, which nobody would guess from the label |
| Initial delay | Implementation term; users think "wait for page to load" |
| Save to SQLite | Storage engine name, not user benefit |
| stem only | Unclear term; means "root page only" |
| Ignore root pages | "Root" is developer vocabulary |
| Clear DB | Doesn't say that files on disk are kept |
| Pages / Snapshots / MB saved | "Snapshots" vs "pages" is never explained; in native mode "MB" means file size, not DB size |
| "Run install.sh then restart Brave" | **Wrong**: the installer is `install.py`, and it assumes Brave even on Chrome |

### 1.4 Craft issues

- **Contrast fails WCAG AA.** Hint/label grey `#555` on `#1a1a1a` is ~2.3:1, footer `#444` is ~1.9:1, and placeholder `#444` on `#252525` is barely visible. The minimum is 4.5:1 for small text.
- **Tiny targets.** 14px native checkboxes with a grey accent color. Only the checkbox and label are clickable, not the row.
- **Not keyboard/screen-reader accessible.** Mode tabs, the filter header and "stem only" chips are `<div>`/`<span>` click handlers with no role, tabindex or `aria-*`. The remove button is a bare "×" with no label.
- **Dark-only.** Ignores `prefers-color-scheme`, so it looks out of place in a light browser.
- **Toast spam.** Every keystroke-commit fires a toast ("Interval set to 5 min"), and toasts are the only success and error channel.
- **Redundant state echoes.** Hints like "no popup" / "all pages" restate the checkbox state in small grey text next to it.
- **No loading or empty-state design.** Stats show `0` while loading, then jump. In native mode each popup open makes 2–3 native-host round trips with no skeleton.
- **Dependency not expressed.** "Clone bookmarked GitHub repos" can be turned on without a native host. The SQLite toggle silently flips itself back off when the host is missing.
- **Recent list is inert.** No favicons, rows aren't clickable, full URLs are truncated mid-host, and there's no search.
- **Icon.** One 618×618 PNG is downscaled for 16/48/128, so it's muddy at toolbar size.
- **Code structure.** About 300 lines of inline CSS, hard-coded hex values (no tokens), and `innerHTML` templating mixed with listeners.

---

## 2. Design goals & principles

1. **Glanceable first.** Opening the popup should answer "is it working / is this page saved" in under 1 second without scrolling.
2. **Separate *operate* from *configure*.** The popup is for operating; a full **Options page** holds configuration.
3. **Explain decisions.** Any time the extension decides *not* to capture, the UI can say why in plain language and offer a one-click fix.
4. **Calm and trustworthy.** It's an archival tool, so it should feel quiet, precise and durable. No novelty, minimal motion, no toast spam.
5. **Safe by default.** Destructive actions are visually separated, clearly worded and confirmed in-context.
6. **Accessible to AA.** Keyboard, screen reader, contrast, reduced motion, light and dark.
7. **Zero behavior change.** Every control reads and writes the **exact same `chrome.storage.local` keys and values** as today (see §10).

---

## 3. Information architecture

```
Toolbar icon
 └─ Popup (380 × ≤560px)            ← operate / glance
     ├─ Header: brand · health status · ⚙ (opens Options)
     ├─ This page card              ← status + why + primary action
     ├─ Summary strip               ← totals
     ├─ Recent captures             ← searchable, clickable
     └─ Footer: storage destination · "All settings →"

Options page (full tab, chrome.runtime.openOptionsPage)   ← configure
 ├─ Capture        timing (active-time interval, page-load wait), downloads
 ├─ What to archive bookmarks-only, root pages, site list (off/block/allow)
 ├─ Storage        browser storage vs SQLite, connection health, data management (danger zone)
 ├─ Integrations   GitHub auto-clone (gated on native host)
 └─ About          what/why (from README rationale), privacy, permissions explained, version
```

Rationale: settings change rarely, but the popup is opened often. Moving them out cuts the popup roughly in half and removes the need to scroll. Options pages also get proper width for the site list and setup instructions.

---

## 4. Popup — detailed spec

### 4.1 Layout (wireframe)

```
┌────────────────────────────────────────────┐
│ ▣ Page Archiver              ● Archiving  ⚙│  header, 48px
├────────────────────────────────────────────┤
│ THIS PAGE                                  │
│ ┌────────────────────────────────────────┐ │
│ │ [fav] How link rot works — The Atlantic│ │
│ │       theatlantic.com/technology/…     │ │
│ │                                        │ │
│ │ ✓ Archived 4 min ago · 3 snapshots     │ │  status line (state-dependent)
│ │                                        │ │
│ │ [  Archive now  ]              [ ⋯ ]   │ │  primary + overflow
│ └────────────────────────────────────────┘ │
├────────────────────────────────────────────┤
│ 1,204 pages   3,980 snapshots   2.1 GB     │  summary strip, 1 line
├────────────────────────────────────────────┤
│ Recent                         [⌕ Filter ] │
│ [fav] Title of page              4m        │
│       host.com · 3 snapshots               │
│ [fav] …                                    │
│ (scrolls within, max ~6 rows visible)      │
├────────────────────────────────────────────┤
│ Saving to Downloads/page-archiver + SQLite │
│                          All settings →    │
└────────────────────────────────────────────┘
```

### 4.2 Header

- 20px icon, "Page Archiver" in 14px/600.
- **Health pill**, right-aligned. Its states come from data the popup already fetches:
  - `● Archiving`: neutral/positive. This is the default.
  - `● Bookmarks only`: info. Shown when `onlyBookmarks` is true, so the user knows most pages are intentionally skipped.
  - `▲ Storage issue`: warning. Shown when `useNativeHost` is true but `PING_HOST` fails. Clicking it opens Options → Storage.
- ⚙ icon button (`aria-label="Open settings"`). It calls `chrome.runtime.openOptionsPage()`.

### 4.3 "This page" card

It shows the active tab's favicon (`tab.favIconUrl`), title and a display URL. The display URL is the host in normal weight plus the path in muted text, truncated in the middle rather than at the end.

**Status line states** (icon + one sentence + optional action):

| State | Copy | Tone | Inline action |
|---|---|---|---|
| Unsupported page (`chrome://`, `about:`, extension, new tab) | "This page can't be archived." | muted | none. Primary button disabled with tooltip |
| Archived before (URL in recent list) | "Archived 4 min ago · 3 snapshots" | success | none |
| Not yet archived, eligible | "Will archive after you've been here ~5 min" (or "…shortly" if never captured) | neutral | none |
| Excluded by block list | "Not archived: example.com is on your block list." | muted | **Unblock** |
| Not in allow list | "Not archived: example.com isn't on your allow list." | muted | **Allow site** |
| Root page skipped | "Not archived: home pages are skipped." | muted | **Change** → Options |
| Bookmarks-only and not bookmarked | "Not archived: only bookmarked pages are saved." | muted | **Change** → Options |
| Capture in progress | spinner, "Archiving…" | neutral | none |
| Capture failed | "Couldn't archive: {error}" | error | **Retry** |

How the state is resolved: see §9 (data plumbing). Quick actions ("Unblock", "Allow site") write the same `filterSites`/`filterMode` keys the current filter UI writes. They're a shortcut to existing behavior, not new behavior.

**Primary button** "Archive now". Full-width accent button, 36px tall, sends `MANUAL_CAPTURE`. Its states are idle → loading (spinner, label "Archiving…", disabled) → success (check icon for 1.5s, then back to idle) or error (inline status line, not a toast).

> Note: manual capture still respects filters today (`captureAndSave` calls `shouldCapture`). The UI must therefore disable the button or show the filter reason rather than pretend it will work. Whether manual capture should *bypass* filters is a functionality question (§12).

**Overflow menu ⋯** (a real `menu` with keyboard support):
- "Block this site" / "Remove from block list" (contextual to `filterMode`)
- "Add to allow list" (when in allow mode)
- "Open archive folder" (`chrome.downloads.showDefaultFolder()`; UI-only)

### 4.4 Summary strip

One line: `1,204 pages · 3,980 snapshots · 2.1 GB`. Numbers use `Intl.NumberFormat`. Sizes auto-scale KB/MB/GB (currently always MB). It has a tooltip explaining "page = unique URL, snapshot = one capture." It's de-emphasised (secondary text), not three big tiles. Totals are context, not the headline.

### 4.5 Recent captures

- Row: 16px favicon (`chrome://favicon` is not available in MV3, so use the `_favicon` API via the `"favicon"` permission, or fall back to a letter avatar; see §11 open question). Title (13px, 1 line), meta line `host · 3 snapshots` (12px muted) and a relative time right-aligned (`4m`, `2h`, `3d`, then an absolute date after 7d). The full timestamp is in `title=`.
- The whole row is a link: click opens the live URL in a new tab (`chrome.tabs.create`). Middle-click/⌘-click opens in the background.
- **Filter field**: client-side substring filter over the 30 rows already returned. No new query; this is presentation only. Hidden when there are fewer than 6 rows.
- The list scrolls internally, so the page doesn't.
- Empty state: an illustration-free, centered 2-line message: "Nothing archived yet" / "Pages you spend time on will appear here." With a link button: "Archive this page now".
- Loading: 4 skeleton rows (no shimmer if `prefers-reduced-motion`).
- Error (stats fetch failed): inline banner "Couldn't load your archive." with a **Retry** button and, in native mode, "Check storage settings →".

### 4.6 Footer

Dynamic, accurate copy:
- Silent downloads on: "Saving to Downloads/page-archiver"
- Silent downloads off: "Asking where to save each capture"
- Native host on: append " + SQLite"

Right side: "All settings →" link.

---

## 5. Options page — detailed spec

A new `options.html`, registered via `"options_ui": { "page": "options.html", "open_in_tab": true }`. It uses a left nav (sections) and a content column, max width 720px. All settings **auto-save** on change. A per-row, unobtrusive "Saved" check fades in for 1.5s next to the control. No toasts.

### 5.1 Capture

| Control | Storage key | Component | Copy |
|---|---|---|---|
| Re-archive after | `captureInterval` (min, 1–1440) | Segmented presets `1 · 5 · 15 · 30 · 60 min · Custom` (Custom reveals a stepper) | Label: **"Re-archive a page after"**. Help: "Counts only time you're actively viewing that page in a tab. Switching away pauses the clock." |
| Wait for page to load | `initialDelay` (s, 0–120) | Stepper with "s" suffix | Help: "Gives dynamic pages time to finish loading before saving. 0 saves immediately." |
| Save without asking | `silentDownload` (bool) | Switch | Help: "Files go straight to Downloads/page-archiver." With a **warning callout** shown persistently: "Your browser's 'Ask where to save each file' setting overrides this." Plus a button: **Open browser download settings** (opens `chrome://settings/downloads`). |

Validation: clamp exactly as today (1–1440, 0–120). Out-of-range input shows inline error text under the field *before* clamping on blur ("Must be between 1 and 1440 minutes"). The value written to storage is identical to today's clamp.

### 5.2 What to archive

A section intro, one sentence: "By default every page you spend time on is archived. Narrow it down here."

| Control | Key | Component | Copy |
|---|---|---|---|
| Only bookmarked pages | `onlyBookmarks` | Switch | "Skip pages that aren't in your bookmarks. New bookmarks are archived immediately." |
| Skip home pages | `ignoreRootPages` | Switch | "Skip pages like example.com/ but keep example.com/article. Sites in your list below use their own setting." |

**Site list** (`filterMode`, `filterSites`):

- Mode as a **radio-group segmented control** with descriptions:
  - Off: "Archive all sites"
  - Block list: "Archive everything except these sites"
  - Allow list: "Archive only these sites"
- Add field: "Add a site (e.g. twitter.com or paste a URL)", plus an **Add** button. It normalises to the hostname exactly as today. Duplicates show inline "Already in your list" under the field.
- Table rows: favicon · hostname · (block mode) **"Home page only"** switch, which replaces "stem only" · remove icon button (`aria-label="Remove example.com"`).
  - "Home page only" help on block: "Block example.com/ but still archive its subpages." On allow, `stemOnly` currently also has meaning (it skips the root) but isn't exposed in the UI. **Keep parity: don't expose it on allow for now.** Flag it for the functionality session.
- Removing a row shows an inline **Undo** for 5s (re-inserts at the same index) instead of a confirm.
- The list is still kept when mode is Off. Show it dimmed with "Not active while filtering is off."
- **"How rules combine"** disclosure: a numbered list of the 5-step precedence from the README, in plain language. This is the single biggest comprehension aid for the filter system.

### 5.3 Storage

- **Where captures are recorded**: a radio card pair (not a checkbox):
  - **Browser storage** (default): "Simple, no setup. Keeps a log of captures inside the browser."
  - **SQLite database** (advanced): "Queryable database on your disk that also stores a full copy of each page. Requires the helper app."
  - Selecting SQLite runs the existing `PING_HOST` flow. Card states: *Checking…* → *Connected* (shows DB path with a copy button, blob size if present) or *Helper not installed*. In the second case, show an **inline setup panel** with numbered steps:
    1. Copy your extension ID (a copy button pre-filled with `chrome.runtime.id`)
    2. Run `cd native-host && python3 install.py` (copy button)
    3. Restart your browser, then **Check again**
  - The selection reverts to Browser storage on failure, as today. But the setup panel stays open so the revert isn't a silent surprise.
- **Danger zone** (red-bordered section at the bottom):
  - "Clear archive log". Help: "Removes the list of captures from {browser storage | the SQLite database}. Saved .mhtml files in your Downloads folder are not deleted." **In SQLite mode, add: "Full page copies stored in the database will be permanently deleted."** (true today: `CLEAR_DB` deletes rows including blobs, and the current copy hides that).
  - Confirmation: an in-page dialog showing the counts ("Delete 3,980 snapshot records?"). The destructive button is labelled **"Clear log"**, not "OK". Replace `window.confirm`.

### 5.4 Integrations

- **Clone GitHub repos when bookmarked** (`cloneGithubRepos`), as a switch.
  - **Disabled with explanation** unless the native host pings OK: "Requires the helper app and git. Set up in Storage →". *Edge case:* if the stored value is already `true` while the host is down, show the switch as on with a warning, "Not working: helper app unreachable". Don't silently rewrite the stored value (behavior parity).
  - Help: "Bookmarking github.com/owner/repo clones it into the folder you chose during setup."

### 5.5 About

Includes a condensed version of the README rationale (2 short paragraphs + the "visited means saved" line), a "Privacy" block ("Captures read what's already loaded in your browser. No extra requests are made to the site, and nothing leaves your computer."), a permissions table in plain language, the version from `chrome.runtime.getManifest().version` and a link to the repo.

---

## 6. Visual design system

### 6.1 Personality

*Archival, precise, quiet.* Think a well-made notebook or library catalogue rather than a dev tool. Neutral surfaces, one restrained accent, generous but tight spacing, and real typographic hierarchy.

### 6.2 Tokens (`ui/tokens.css`, shared by popup and options)

Define every color as a CSS custom property on `:root`, with a dark override under `@media (prefers-color-scheme: dark)`.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | `#FAFAF9` | `#161616` | page background |
| `--surface` | `#FFFFFF` | `#1F1F1F` | cards |
| `--surface-2` | `#F2F2F0` | `#262626` | hover, inputs |
| `--border` | `#E4E4E1` | `#323232` | dividers |
| `--text` | `#1C1C1A` | `#EDEDEB` | primary text |
| `--text-2` | `#5C5C58` | `#A3A3A0` | secondary (≥ 4.5:1 on bg) |
| `--text-3` | `#6B6B65` | `#8A8A86` | tertiary/meta (~5.1:1 on bg) |
| `--accent` | `#B4531B` (archival amber/rust) | `#E58A4E` | primary button, focus, links |
| `--accent-fg` | `#FFFFFF` | `#1A1A1A` | text on accent |
| `--success` | `#2F7D4F` | `#5BBF85` | archived |
| `--warning` | `#9A6B00` | `#E0B34A` | storage issue |
| `--danger` | `#B3261E` | `#F2867E` | destructive |
| `--focus` | `= --accent` at 2px outline + 2px offset | | |

The accent is a proposal; see §11. Every text/background pair must be validated at ≥ 4.5:1 (≥ 3:1 for icons and UI boundaries) before merge.

**Type**: system UI stack (`system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`), `font-variant-numeric: tabular-nums` for counts and times.

| Role | Size/weight/line-height |
|---|---|
| Title | 15/600/20 |
| Body | 13/400/18 |
| Label | 13/500/18 |
| Meta | 12/400/16 |
| Overline (section label) | 11/600/14, +0.04em tracking, uppercase, `--text-3` |

Minimum size is 12px, except the uppercase 11px overline (the current UI uses 10px in many places).

**Spacing**: 4px grid (4, 8, 12, 16, 20, 24). Popup gutters 16px.
**Radius**: 6px controls, 10px cards, 999px pills.
**Elevation**: borders, not shadows. A single soft shadow only on menus/dialogs.
**Motion**: 120–160ms ease-out for hover/press/disclosure. Everything disabled under `prefers-reduced-motion: reduce`.
**Icons**: one inline SVG set (e.g. Lucide, vendored as inline SVG, no CDN in an extension), 16px, 1.5px stroke, `currentColor`.

### 6.3 Components

| Component | Notes |
|---|---|
| Button | `primary` (accent fill), `secondary` (surface + border), `ghost`, `danger`. Heights 32 (default) / 36 (primary in popup). Loading state with spinner and preserved width. |
| Icon button | 28×28 hit area min, required `aria-label`, tooltip. |
| Switch | 32×18 track, full row is the hit target (`<label>` wraps the row), `role="switch"` + `aria-checked`. Replaces all checkboxes. |
| Segmented control | `role="radiogroup"`, arrow-key navigation. Used for filter mode and interval presets. |
| Stepper | Number input + −/+ buttons, unit suffix, inline validation. |
| Setting row | Label + help text (stacked, help in `--text-2`) left, control right. Help is linked via `aria-describedby`. |
| Card | surface, border, 10px radius, 12–16px padding. |
| Banner/Callout | info / warning / error / success with icon, title, body, optional action. |
| List row | favicon/avatar, title, meta, trailing time, hover `--surface-2`, focus ring. |
| Status pill | dot + label, tone variants. |
| Menu | `role="menu"`, arrow keys, Esc closes, returns focus to trigger. |
| Dialog | `<dialog>` element, focus-trapped, Esc cancels, destructive button on the right. |
| Inline "Saved" | check icon + "Saved", `aria-live="polite"`, fades after 1.5s. |
| Toast | Kept **only** for results from actions whose origin is gone (e.g. popup re-render). Never used for settings changes. |
| Skeleton | for stats and list while loading. |

### 6.4 Toolbar icon

- Redraw the icon on a 16px grid and export `16, 32, 48, 128` PNGs (plus the 618px master). Update `manifest.json` `icons` and `action.default_icon` to map each size. This is UI-only.
- Optional (§9): action badge (a small dot after a capture) via `chrome.action.setBadgeText`/`setBadgeBackgroundColor`. Presentational, but it needs a background-worker hook. Include it only if §11 Q2 is approved.

---

## 7. Content & voice guidelines

- Use the user's vocabulary: **archive / archived / saved copy**, not capture/snapshot/DB/stem/root in labels. ("Snapshot" can remain in counts with a tooltip definition.)
- Use sentence case everywhere.
- State outcomes, not mechanisms: "Re-archive a page after 5 min of viewing", not "Capture interval".
- Errors should say what happened, why, and what to do: "Couldn't reach the helper app. Is it installed? [Setup steps]".
- Never claim something that may be false (e.g. footer path when silent download is off; "restart Brave" on Chrome).
- Use relative time in lists, with absolute time on hover.

---

## 8. Accessibility requirements (acceptance gate)

- All interactive elements are native `button`/`a`/`input` or have the correct ARIA role, plus `tabindex` and keyboard handlers.
- Visible focus ring on every focusable element (`:focus-visible`, 2px accent, 2px offset).
- Logical tab order: header → this-page card → recent filter → list rows → footer.
- Popup keyboard shortcuts: `/` focuses the recent filter, `Enter` on a row opens it, `Esc` clears the filter or closes a menu.
- Text contrast ≥ 4.5:1, non-text ≥ 3:1, in **both** themes.
- Hit targets ≥ 24×24 (WCAG 2.2 2.5.8), switch rows full-width.
- Status changes (capture result, "Saved") are announced via `aria-live="polite"`. Errors use `role="alert"`.
- Respect `prefers-reduced-motion` and `prefers-color-scheme`. Works at 200% zoom in the Options page.
- No information conveyed by color alone (status pills have icon + text).

---

## 9. Data plumbing (what the UI reads)

The UI uses **only existing messages and storage keys**, with one optional exception flagged below.

| Need | Source (existing) |
|---|---|
| Totals, recent list | `GET_STATS` (`pages`, `snapshots`, `mb`, `blob_mb`, `recent[]`, `db`) |
| Manual capture | `MANUAL_CAPTURE` → `{success, filename}` / `{success:false, filtered, reason}` / `{success:false, error}` |
| Host health | `PING_HOST` → `{ok, db}` |
| Clear | `CLEAR_DB` |
| Settings | `chrome.storage.local` keys in §10 |
| Active tab info | `chrome.tabs.query({active:true,currentWindow:true})` (title, url, favIconUrl) |
| "Archived N ago" | Match the active tab URL against `recent[]` (best-effort; only the last 30 pages) |
| Filter verdict for "This page" | **Mirror** of `shouldCapture` evaluated in the popup from storage keys + `chrome.bookmarks.search`. Put it in a shared pure module, `lib/filter.js`, imported by both `background.js` and the popup, so there's one source of truth. Refactoring `shouldCapture` into that module **must be a pure move with no logic change**. |
| "Will archive after ~X min" | Optional: a new **read-only** `GET_TAB_STATUS` message returning `{lastCapturedAt, activeMs, intervalMs, pendingDelay}` from the existing `tabState` map. It doesn't mutate state. Without it, the popup shows the generic "Will archive after you've been here a few minutes". **Needs approval (§11 Q2).** Note that `tabState` is in-memory and lost when the MV3 service worker sleeps, so the UI must handle "unknown" gracefully. |

Reason codes from `shouldCapture` map to copy: `blocked`, `stem-block`, `not-in-allowlist`, `stem-only`, `ignore-root`, `only-bookmarks` → the table in §4.3.

---

## 10. Behavior-parity contract (must not change)

**Storage keys & types**: `captureInterval` (int min, default 5), `initialDelay` (int s, default 10), `silentDownload` (bool, default true), `useNativeHost` (bool, default false), `onlyBookmarks` (bool, default false), `ignoreRootPages` (bool, default false), `cloneGithubRepos` (bool, default false), `filterMode` (`"none"|"block"|"allow"`), `filterSites` (`[{host, stemOnly}]`, legacy string entries still read), `page_archiver_db` (untouched by UI).

**Messages**: `GET_STATS`, `MANUAL_CAPTURE`, `CLEAR_DB`, `PING_HOST`, `SETTINGS_UPDATED`. Same names and payloads.

**Defaults & clamps** are identical. The SQLite "revert on failed ping" behavior is preserved. A settings change takes effect immediately, as today.

Regression check: export `chrome.storage.local.get(null)` before and after toggling every control through old UI and new UI. The resulting objects must be identical.

---

## 11. Open questions (need a decision before build)

1. **Accent color / brand.** Proceed with archival rust (`#B4531B` / `#E58A4E`), or something else? Is an icon redraw in scope?
2. **Read-only background hooks.** May this phase add the read-only `GET_TAB_STATUS` message and the presentational badge? Both are additive and change no capture behavior. If not, they move to the next session and the popup uses the fallback copy.
3. **Favicons.** Add the `"favicon"` permission (MV3 `_favicon/` URL) for list favicons? It triggers a permission prompt on update. The alternative is letter avatars.
4. **Options page as a full tab vs embedded.** Recommendation: full tab (`open_in_tab: true`) for room and setup instructions.
5. **Framework.** Recommendation: stay vanilla JS + ES modules + plain CSS (no build step, matches repo, small surface). Small `h()` helper + template functions instead of ad-hoc `innerHTML`.

---

## 12. Deferred to the functionality session

Noted during the audit. **Not** to be done in this phase:

- **Pause archiving** (global on/off, "pause for 1h", "don't archive this tab"). This is the most-requested pattern for capture tools and needs a background change. The header pill (§4.2) is designed to host it later.
- Should **manual "Archive now" bypass filters**? (Currently it doesn't. The UI will explain this, not change it.)
- **Open a saved copy** from the recent list. Needs download IDs stored, or `EXPORT_MHTML` (exists in the native host but isn't wired up).
- Per-page **snapshot history** view and full **archive search** beyond the last 30 pages.
- `content.js` sends `PAGE_SETTLED`, but `background.js` has no handler. That's dead code, or a missing feature.
- `stemOnly` on allow-list entries has logic in `shouldCapture` but no UI.
- Local-storage DB grows unbounded in `chrome.storage.local` (no quota handling); stats `mb` semantics differ between local and native modes.
- Incognito / private window policy.
- Notifications for capture failures (currently only GitHub clone notifies).
- Focus-triggered auto-capture intermittently produces no file in headless Chromium: the delay timer fires but nothing is written, and `captureAndSave` swallows the error into the worker console. This happens with the pre-revamp code too. Investigate whether `pageCapture` runs too early, and surface the failure in the UI.

---

## 13. Implementation plan (for this phase)

File layout (no build step):

```
ui/tokens.css          design tokens, light/dark
ui/components.css      buttons, switch, segmented, cards, list rows, dialog…
ui/icons.js            inline SVG icon strings
ui/dom.js              tiny h()/render helpers, escHtml, timeAgo, formatBytes
lib/filter.js          (pure move of shouldCapture helpers — only if §9 approved)
popup.html/.css/.js    rewritten per §4
options.html/.css/.js  new, per §5
icons/icon-{16,32,48,128}.png
manifest.json          options_ui, icon sizes (+ "favicon" if Q3 approved)
```

Suggested order (each step shippable):

1. Tokens + components + light/dark, and fix the contrast and copy bugs (`install.sh`, Brave).
2. Options page with all settings moved and auto-save + parity test (§10).
3. Popup rewrite: header, This-page card (filter verdict), summary, recent list, footer.
4. Accessibility pass (§8) with keyboard-only and screen-reader (VoiceOver/NVDA) walkthrough.
5. Icon set (+ badge / `GET_TAB_STATUS` if approved).

### Acceptance criteria

- [ ] Popup fits without page scroll at 380px wide on a fresh profile and with 30 recent items (list scrolls internally).
- [ ] Opening the popup on any http(s) page shows, without scrolling, whether that page is archived and if not, why.
- [ ] All settings are reachable from Options; the popup contains no configuration controls besides contextual site quick-actions.
- [ ] Storage parity test (§10) passes for every control.
- [ ] No `window.confirm`/`alert`; no toast on settings changes.
- [ ] Contrast ≥ AA in light and dark (checked with a tool, results noted in PR).
- [ ] Full keyboard operation; axe DevTools reports 0 serious/critical issues on popup and options.
- [ ] No regressions: capture-on-focus, bookmark capture, filters, SQLite and GitHub clone behave exactly as before (manual smoke test checklist in PR).
