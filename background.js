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
  return localRecordSnapshot(data);
}

async function dbGetStats() {
  const { useNativeHost = false } = await getSetting(["useNativeHost"]);
  return useNativeHost ? sendToHost({ type: "GET_STATS" }) : localGetStats();
}

async function dbClear() {
  const { useNativeHost = false } = await getSetting(["useNativeHost"]);
  return useNativeHost ? sendToHost({ type: "CLEAR_DB" }) : localClearDB();
}

// ─── Filter check ─────────────────────────────────────────────────────────────

async function isUrlAllowed(url) {
  const { filterMode = "none", filterSites = [] } = await getSetting(["filterMode", "filterSites"]);
  if (filterMode === "none" || !filterSites.length) return true;

  let hostname, pathname;
  try {
    const parsed = new URL(url);
    hostname = parsed.hostname.toLowerCase();
    pathname = parsed.pathname;
  } catch { return true; }

  const entries = filterSites.map(e =>
    typeof e === "string"
      ? { host: e.toLowerCase(), stemOnly: false }
      : { host: e.host.toLowerCase(), stemOnly: !!e.stemOnly }
  );

  if (filterMode === "allow") {
    return entries.some(({ host }) => hostname === host || hostname.endsWith("." + host));
  }

  if (filterMode === "block") {
    const matched = entries.find(({ host }) => hostname === host || hostname.endsWith("." + host));
    if (!matched) return true;
    if (matched.stemOnly) {
      return !(pathname === "/" || pathname === "");
    }
    return false;
  }

  return true;
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

    if (!(await isUrlAllowed(url))) {
      console.log(`[PageArchiver] Skipped (filtered): ${url}`);
      return { success: false, filtered: true };
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

    dbRecordSnapshot({ url, title, filename, capturedAt, sizeBytes, trigger })
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
