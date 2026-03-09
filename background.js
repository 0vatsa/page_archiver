// background.js — Page Archiver
//
// Capture strategy:
//   - When a tab becomes active AND visible (user switches to it or comes back
//     to the window), check if enough time has passed since the last capture
//     for that tab. If yes, wait initialDelay seconds then capture.
//   - No periodic alarms. Captures only happen when the user is actually on
//     the page, and only if the configured interval has elapsed since the
//     last capture of that URL.

const HOST_NAME = "com.page_archiver.host";

// ─── Settings ─────────────────────────────────────────────────────────────────

function getSetting(keys) {
  return new Promise(res => chrome.storage.local.get(keys, res));
}

async function getConfig() {
  const { captureInterval = 5, initialDelay = 10 } =
    await getSetting(["captureInterval", "initialDelay"]);
  return {
    intervalMs: captureInterval * 60 * 1000,
    delayMs:    initialDelay * 1000,
  };
}

// ─── Per-tab state ────────────────────────────────────────────────────────────
// Tracks when each tab was last captured and any pending delay timer.

const tabState = new Map();
// tabState[tabId] = { lastCapturedAt: timestamp|null, delayTimer: timeoutId|null, url: string }

function getTabState(tabId) {
  if (!tabState.has(tabId)) {
    tabState.set(tabId, { lastCapturedAt: null, delayTimer: null, url: null });
  }
  return tabState.get(tabId);
}

function clearDelayTimer(tabId) {
  const s = tabState.get(tabId);
  if (s && s.delayTimer) {
    clearTimeout(s.delayTimer);
    s.delayTimer = null;
  }
}

// ─── Native messaging ─────────────────────────────────────────────────────────

function sendToHost(msg) {
  return new Promise((resolve, reject) => {
    let port;
    try {
      port = chrome.runtime.connectNative(HOST_NAME);
    } catch (e) {
      reject(new Error(`Native host connection failed: ${e.message}`));
      return;
    }

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      port.disconnect();
      reject(new Error("Native host timed out"));
    }, 10000);

    port.onMessage.addListener((response) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      port.disconnect();
      resolve(response);
    });

    port.onDisconnect.addListener(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const err = chrome.runtime.lastError;
      reject(new Error(err ? err.message : "Native host disconnected unexpectedly"));
    });

    port.postMessage(msg);
  });
}

// ─── chrome.storage.local DB (default) ───────────────────────────────────────

const DB_KEY = "page_archiver_db";

async function getLocalDB() {
  return new Promise(res => {
    chrome.storage.local.get([DB_KEY], r => res(r[DB_KEY] || { pages: [], snapshots: [] }));
  });
}
async function saveLocalDB(db) {
  return new Promise(res => chrome.storage.local.set({ [DB_KEY]: db }, res));
}

async function localRecordSnapshot({ url, title, filename, capturedAt, sizeBytes, trigger }) {
  const db   = await getLocalDB();
  let page   = db.pages.find(p => p.url === url);
  if (!page) {
    page = { id: Date.now() + Math.random(), url, title, firstSeen: capturedAt, lastSeen: capturedAt, snapshotCount: 0 };
    db.pages.push(page);
  } else {
    page.lastSeen = capturedAt;
    page.title    = title;
  }
  page.snapshotCount = (page.snapshotCount || 0) + 1;
  db.snapshots.push({ id: Date.now() + Math.random(), pageId: page.id, url, title, filename, capturedAt, sizeBytes: sizeBytes || 0, trigger });
  await saveLocalDB(db);
}

async function localGetStats() {
  const { pages, snapshots } = await getLocalDB();
  const mb     = snapshots.reduce((s, sn) => s + (sn.sizeBytes || 0), 0) / (1024 * 1024);
  const recent = [...pages]
    .sort((a, b) => new Date(b.lastSeen) - new Date(a.lastSeen))
    .slice(0, 30)
    .map(p => ({ url: p.url, title: p.title, last_seen: p.lastSeen, snapshot_count: p.snapshotCount }));
  return { ok: true, pages: pages.length, snapshots: snapshots.length, mb: parseFloat(mb.toFixed(2)), recent };
}

async function localClearDB() {
  await saveLocalDB({ pages: [], snapshots: [] });
  return { ok: true };
}

// ─── Unified DB interface ─────────────────────────────────────────────────────

async function dbRecordSnapshot(data) {
  const { useNativeHost = false } = await getSetting(["useNativeHost"]);
  if (useNativeHost) {
    return sendToHost({ type: "RECORD_SNAPSHOT", ...data })
      .catch(e => console.error("[PageArchiver] Native DB write failed:", e.message));
  }
  // chrome.storage.local doesn't store blobs — drop mhtmlBase64 for local path
  const { mhtmlBase64, ...localData } = data;
  return localRecordSnapshot(localData);
}

async function dbGetStats() {
  const { useNativeHost = false } = await getSetting(["useNativeHost"]);
  return useNativeHost ? sendToHost({ type: "GET_STATS" }) : localGetStats();
}

async function dbClear() {
  const { useNativeHost = false } = await getSetting(["useNativeHost"]);
  return useNativeHost ? sendToHost({ type: "CLEAR_DB" }) : localClearDB();
}

// ─── Bookmark check ──────────────────────────────────────────────────────────

async function isBookmarked(url) {
  return new Promise(resolve => {
    chrome.bookmarks.search({ url }, results => {
      resolve(results && results.length > 0);
    });
  });
}

// ─── Filter check ─────────────────────────────────────────────────────────────
// Returns { allowed: bool, reason: string }

async function shouldCapture(url) {
  const {
    filterMode      = "none",
    filterSites     = [],
    onlyBookmarks   = false,
    ignoreRootPages = false,
  } = await getSetting(["filterMode", "filterSites", "onlyBookmarks", "ignoreRootPages"]);

  let hostname, pathname;
  try {
    const parsed = new URL(url);
    hostname = parsed.hostname.toLowerCase();
    pathname = parsed.pathname;
  } catch { return { allowed: true }; }

  const isRoot = pathname === "/" || pathname === "";

  // Check if currently bookmarked
  const bookmarked = await isBookmarked(url);

  // Bookmark always wins — if bookmarked, capture unconditionally
  if (bookmarked) return { allowed: true, reason: "bookmarked" };

  // If onlyBookmarks toggle is on and page is NOT bookmarked, skip
  if (onlyBookmarks) return { allowed: false, reason: "only-bookmarks" };

  // Normalise filter site entries
  const entries = filterSites.map(e =>
    typeof e === "string"
      ? { host: e.toLowerCase(), stemOnly: false }
      : { host: e.host.toLowerCase(), stemOnly: !!e.stemOnly }
  );

  // Find if this hostname is explicitly listed
  const listed = entries.find(({ host }) =>
    hostname === host || hostname.endsWith("." + host)
  );

  if (filterMode === "allow") {
    if (!listed) return { allowed: false, reason: "not-in-allowlist" };
    // Listed in allow — stemOnly applies
    if (listed.stemOnly && isRoot) return { allowed: false, reason: "stem-only" };
    return { allowed: true };
  }

  if (filterMode === "block") {
    if (listed) {
      // stemOnly: block root only, allow subpages
      if (listed.stemOnly) {
        return isRoot
          ? { allowed: false, reason: "stem-block" }
          : { allowed: true };
      }
      return { allowed: false, reason: "blocked" };
    }
    // Not explicitly listed — apply global ignoreRootPages if enabled
    if (ignoreRootPages && isRoot) return { allowed: false, reason: "ignore-root" };
    return { allowed: true };
  }

  // filterMode === "none"
  // No list active — still apply global ignoreRootPages for unlisted sites
  if (ignoreRootPages && isRoot) return { allowed: false, reason: "ignore-root" };

  return { allowed: true };
}

// ─── Core capture ─────────────────────────────────────────────────────────────

async function captureAndSave(tabId, trigger = "focus") {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab || !tab.url ||
        tab.url.startsWith("chrome://") ||
        tab.url.startsWith("chrome-extension://") ||
        tab.url.startsWith("about:")) {
      return;
    }

    const url   = tab.url;
    const title = tab.title || "untitled";

    // Bookmark trigger bypasses shouldCapture — we already know it's a bookmark
    // and the onCreated event may fire before chrome.bookmarks.search reflects it.
    if (trigger !== "bookmark") {
      const { allowed, reason } = await shouldCapture(url);
      if (!allowed) {
        console.log(`[PageArchiver] Skipped (${reason}): ${url}`);
        return { success: false, filtered: true, reason };
      }
    }

    const capturedAt = new Date().toISOString();
    const safeName   = title.replace(/[^a-z0-9]/gi, "_").replace(/_+/g, "_").slice(0, 60);
    const timestamp  = capturedAt.replace(/[:.]/g, "-");
    const filename   = `page-archiver/${safeName}__${timestamp}.mhtml`;

    const mhtmlData = await new Promise((resolve, reject) => {
      chrome.pageCapture.saveAsMHTML({ tabId }, (data) => {
        if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
        else resolve(data);
      });
    });

    const sizeBytes = mhtmlData.size || 0;

    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload  = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(mhtmlData);
    });

    const { silentDownload = true } = await getSetting(["silentDownload"]);
    await new Promise((resolve, reject) => {
      chrome.downloads.download(
        { url: dataUrl, filename, saveAs: !silentDownload, conflictAction: "uniquify" },
        (downloadId) => {
          if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
          else resolve(downloadId);
        }
      );
    });

    // Update last captured time for this tab
    const state = getTabState(tabId);
    state.lastCapturedAt = Date.now();
    state.url            = url;

    // Strip the data URL prefix to get raw base64 for DB storage
    const mhtmlBase64 = dataUrl.split(",")[1] || "";

    dbRecordSnapshot({ url, title, filename, capturedAt, sizeBytes, trigger, mhtmlBase64 })
      .catch(e => console.error("[PageArchiver] DB write failed:", e.message));

    console.log(`[PageArchiver] Captured (${trigger}): ${url}`);
    return { success: true, filename };

  } catch (err) {
    console.error("[PageArchiver] Capture failed:", err);
    return { success: false, error: err.message };
  }
}

// ─── Focus-based capture logic ────────────────────────────────────────────────
// Called whenever the user focuses a tab (tab switch, window focus, page load).

async function onTabFocused(tabId) {
  if (!tabId || tabId < 0) return;

  let tab;
  try { tab = await chrome.tabs.get(tabId); } catch { return; }
  if (!tab.url || tab.url.startsWith("chrome://") || tab.url.startsWith("chrome-extension://") || tab.url.startsWith("about:")) return;

  const { intervalMs, delayMs } = await getConfig();
  const state = getTabState(tabId);

  // Cancel any existing pending delay for this tab
  clearDelayTimer(tabId);

  // Decide if enough time has passed since last capture of this tab
  const now          = Date.now();
  const lastAt       = state.lastCapturedAt;
  const urlChanged   = state.url !== tab.url;
  const intervalElapsed = !lastAt || (now - lastAt) >= intervalMs;

  if (!intervalElapsed && !urlChanged) {
    console.log(`[PageArchiver] Skipped (interval not elapsed): ${tab.url}`);
    return;
  }

  // Wait initialDelay seconds then capture (gives page time to finish loading)
  state.delayTimer = setTimeout(async () => {
    state.delayTimer = null;
    await captureAndSave(tabId, urlChanged ? "visit" : "focus");
  }, delayMs);
}

// ─── Event listeners ──────────────────────────────────────────────────────────

// Tab becomes active in its window
chrome.tabs.onActivated.addListener(({ tabId }) => {
  onTabFocused(tabId);
});

// Window gains focus — capture the active tab in that window
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  chrome.tabs.query({ active: true, windowId }, ([tab]) => {
    if (tab) onTabFocused(tab.id);
  });
});

// Page finishes loading in the active tab
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  if (!tab.active) return; // only care if it's the tab the user is looking at
  onTabFocused(tabId);
});

// Tab closed — clean up state
chrome.tabs.onRemoved.addListener((tabId) => {
  clearDelayTimer(tabId);
  tabState.delete(tabId);
});

// ─── Bookmark created — fast-capture the active tab if URL matches ────────────
// When a user bookmarks a page, capture it after 1s regardless of interval.
// We find the tab showing that URL and bypass the normal delay/interval check.

chrome.bookmarks.onCreated.addListener(async (_id, bookmark) => {
  if (!bookmark.url) return;

  // Find any active tab showing this URL
  chrome.tabs.query({ url: bookmark.url }, async (tabs) => {
    if (!tabs || !tabs.length) return;

    // Prefer the currently focused tab; fall back to first match
    const active = tabs.find(t => t.active) || tabs[0];
    const tabId  = active.id;

    // Cancel any pending delay for this tab — we're taking over
    clearDelayTimer(tabId);

    const state = getTabState(tabId);

    // Schedule capture at 1s (gives the browser a moment to settle the bookmark)
    state.delayTimer = setTimeout(async () => {
      state.delayTimer = null;
      await captureAndSave(tabId, "bookmark");
      // Reset lastCapturedAt so next focus uses normal interval from this point
      state.lastCapturedAt = Date.now();
    }, 1000);

    console.log(`[PageArchiver] Bookmark detected, fast-capture in 1s: ${bookmark.url}`);
  });
});

// ─── Messages from popup ──────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {

  if (message.type === "GET_STATS") {
    dbGetStats().then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (message.type === "MANUAL_CAPTURE") {
    chrome.tabs.query({ active: true, currentWindow: true }, async ([tab]) => {
      if (tab) sendResponse(await captureAndSave(tab.id, "manual"));
    });
    return true;
  }

  if (message.type === "CLEAR_DB") {
    dbClear().then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (message.type === "PING_HOST") {
    sendToHost({ type: "PING" })
      .then(res => sendResponse({ ok: true, db: res.db }))
      .catch(e  => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (message.type === "SETTINGS_UPDATED") {
    // Settings are read fresh on every capture — nothing to do here.
    sendResponse({ ok: true });
    return true;
  }
});

console.log("[PageArchiver] Background worker started.");
