// popup.js

// ── Helpers ───────────────────────────────────────────────────────────────────

function showToast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2000);
}

function escHtml(str) {
  return str.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function timeAgo(isoString) {
  const diff = Date.now() - new Date(isoString).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1)  return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function getSetting(keys) {
  return new Promise(res => chrome.storage.local.get(keys, res));
}
function setSetting(obj) {
  return new Promise(res => chrome.storage.local.set(obj, res));
}
function notifyBackground() {
  chrome.runtime.sendMessage({ type: "SETTINGS_UPDATED" });
}

// ── Stats + page list ─────────────────────────────────────────────────────────

async function renderStats() {
  const data = await new Promise(res =>
    chrome.runtime.sendMessage({ type: "GET_STATS" }, res)
  );

  if (!data || !data.ok) {
    document.getElementById("stat-pages").textContent = "—";
    document.getElementById("stat-snaps").textContent = "—";
    document.getElementById("stat-mb").textContent    = "—";
    document.getElementById("page-list").innerHTML =
      `<div class="no-pages">Native host not running.<br>Run install.sh then restart Brave.</div>`;
    return;
  }

  document.getElementById("stat-pages").textContent = data.pages;
  document.getElementById("stat-snaps").textContent = data.snapshots;
  document.getElementById("stat-mb").textContent    = data.mb;

  const list = document.getElementById("page-list");
  if (!data.recent || !data.recent.length) {
    list.innerHTML = `<div class="no-pages">No pages archived yet.</div>`;
    return;
  }

  list.innerHTML = data.recent.map(p => `
    <div class="page-row">
      <div class="title">${escHtml(p.title || "Untitled")}</div>
      <div class="meta">${escHtml(p.url)} &middot; ${timeAgo(p.last_seen)} &middot; ${p.snapshot_count} snapshot${p.snapshot_count !== 1 ? "s" : ""}</div>
    </div>`).join("");
}

// ── Silent downloads ──────────────────────────────────────────────────────────

const silentCb   = document.getElementById("toggle-silent");
const silentHint = document.getElementById("silent-hint");

getSetting(["silentDownload"]).then(({ silentDownload = true }) => {
  silentCb.checked     = silentDownload;
  silentHint.textContent = silentDownload ? "no popup" : "asks where to save";
});

silentCb.addEventListener("change", () => {
  const v = silentCb.checked;
  setSetting({ silentDownload: v });
  silentHint.textContent = v ? "no popup" : "asks where to save";
  showToast(v ? "Silent downloads on" : "Download dialog on");
});

// ── Interval setting ──────────────────────────────────────────────────────────

const intervalInput = document.getElementById("input-interval");

getSetting(["captureInterval"]).then(({ captureInterval = 5 }) => {
  intervalInput.value = captureInterval;
});

intervalInput.addEventListener("change", () => {
  const v = Math.max(1, Math.min(1440, parseInt(intervalInput.value) || 5));
  intervalInput.value = v;
  setSetting({ captureInterval: v });
  notifyBackground();
  showToast(`Interval set to ${v} min`);
});

// ── Initial delay setting ─────────────────────────────────────────────────────

const delayInput = document.getElementById("input-delay");

getSetting(["initialDelay"]).then(({ initialDelay = 10 }) => {
  delayInput.value = initialDelay;
});

delayInput.addEventListener("change", () => {
  const v = Math.max(0, Math.min(120, parseInt(delayInput.value) || 10));
  delayInput.value = v;
  setSetting({ initialDelay: v });
  notifyBackground();
  showToast(`Initial delay set to ${v}s`);
});

// ── SQLite toggle ─────────────────────────────────────────────────────────────

const sqliteCb     = document.getElementById("toggle-sqlite");
const dbHint       = document.getElementById("db-hint");
const sqliteStatus = document.getElementById("sqlite-status");

function setStatusMsg(msg) {
  if (!msg) { sqliteStatus.style.display = "none"; return; }
  sqliteStatus.style.display = "block";
  sqliteStatus.innerHTML = msg;
}

async function pingHost() {
  return new Promise(res => chrome.runtime.sendMessage({ type: "PING_HOST" }, res));
}

async function applySqliteState(enabled) {
  dbHint.textContent = enabled ? "SQLite" : "browser storage";
  if (enabled) {
    setStatusMsg("Connecting to native host...");
    const res = await pingHost();
    if (res && res.ok) {
      const stats = await new Promise(r => chrome.runtime.sendMessage({ type: "GET_STATS" }, r));
      const blobNote = stats && stats.blob_mb > 0 ? ` | ${stats.blob_mb} MB in blobs` : "";
      setStatusMsg(`Connected &mdash; ${escHtml(res.db)}${blobNote}`);
    } else {
      setStatusMsg(`Native host not found. Run: cd native-host &amp;&amp; bash install.sh &lt;extension-id&gt; then restart Brave.`);
      sqliteCb.checked   = false;
      dbHint.textContent = "browser storage";
      await setSetting({ useNativeHost: false });
    }
  } else {
    setStatusMsg(null);
  }
}

getSetting(["useNativeHost"]).then(({ useNativeHost = false }) => {
  sqliteCb.checked = useNativeHost;
  if (useNativeHost) applySqliteState(true);
});

sqliteCb.addEventListener("change", async () => {
  const v = sqliteCb.checked;
  await setSetting({ useNativeHost: v });
  notifyBackground();
  await applySqliteState(v);
  showToast(v ? "SQLite mode on" : "Browser storage mode");
  renderStats();
});

// ── Site filter ───────────────────────────────────────────────────────────────

let filterMode  = "none";
let filterSites = [];

const filterHeader  = document.getElementById("filter-header");
const filterBody    = document.getElementById("filter-body");
const filterChevron = document.getElementById("filter-chevron");
const modeBadge     = document.getElementById("filter-mode-badge");
const siteListEl    = document.getElementById("site-list");
const siteInput     = document.getElementById("site-input");

filterHeader.addEventListener("click", () => {
  const open = filterBody.classList.toggle("open");
  filterChevron.classList.toggle("open", open);
});

document.querySelectorAll(".mode-tab").forEach(tab => {
  tab.addEventListener("click", () => {
    filterMode = tab.dataset.mode;
    saveFilter();
    renderFilter();
  });
});

function renderFilter() {
  ["none","block","allow"].forEach(m => {
    document.getElementById(`tab-${m}`).classList.toggle("active", filterMode === m);
  });

  modeBadge.textContent = filterMode === "none" ? "off" : filterMode;
  modeBadge.className   = `filter-mode-tag ${filterMode}`;

  if (!filterSites.length) {
    siteListEl.innerHTML = `<div class="no-sites">No sites added yet.</div>`;
    return;
  }

  const isBlock = filterMode === "block";
  siteListEl.innerHTML = filterSites.map((entry, i) => {
    const stemEl = isBlock
      ? `<span class="stem-label${entry.stemOnly ? " active" : ""}" data-index="${i}">stem only</span>`
      : "";
    return `<div class="site-row">
      <span class="site-host">${escHtml(entry.host)}</span>
      ${stemEl}
      <button class="remove-btn" data-index="${i}">×</button>
    </div>`;
  }).join("");

  siteListEl.querySelectorAll(".remove-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      filterSites.splice(parseInt(btn.dataset.index), 1);
      saveFilter(); renderFilter();
    });
  });

  siteListEl.querySelectorAll(".stem-label").forEach(lbl => {
    lbl.addEventListener("click", () => {
      const i = parseInt(lbl.dataset.index);
      filterSites[i].stemOnly = !filterSites[i].stemOnly;
      saveFilter(); renderFilter();
    });
  });
}

function saveFilter() {
  setSetting({ filterMode, filterSites });
  notifyBackground();
}

function addSite() {
  let val = siteInput.value.trim().toLowerCase();
  if (!val) return;
  try { val = new URL(val.includes("://") ? val : "https://" + val).hostname; } catch (_) {}
  if (!val) return;
  if (filterSites.some(e => e.host === val)) { showToast("Already in list"); return; }
  filterSites.push({ host: val, stemOnly: false });
  siteInput.value = "";
  saveFilter(); renderFilter();
}

document.getElementById("btn-add-site").addEventListener("click", addSite);
siteInput.addEventListener("keydown", e => { if (e.key === "Enter") addSite(); });

getSetting(["filterMode", "filterSites"]).then(data => {
  filterMode  = data.filterMode  || "none";
  const raw   = data.filterSites || [];
  filterSites = raw.map(e => typeof e === "string" ? { host: e, stemOnly: false } : e);
  renderFilter();
});

// ── Action buttons ────────────────────────────────────────────────────────────

document.getElementById("btn-capture").addEventListener("click", () => {
  const btn = document.getElementById("btn-capture");
  btn.textContent = "Capturing...";
  btn.disabled = true;
  chrome.runtime.sendMessage({ type: "MANUAL_CAPTURE" }, result => {
    btn.textContent = "Capture Now";
    btn.disabled    = false;
    if (result?.success) showToast("Saved: " + result.filename.split("/").pop());
    else showToast("Capture failed: " + (result?.error || "unknown error"));
    renderStats();
  });
});

document.getElementById("btn-clear").addEventListener("click", () => {
  if (!confirm("Clear all archived page records? Downloaded files will remain.")) return;
  chrome.runtime.sendMessage({ type: "CLEAR_DB" }, () => {
    showToast("DB cleared");
    renderStats();
  });
});

// ── Init ──────────────────────────────────────────────────────────────────────
renderStats();

// ── Only bookmarks toggle ─────────────────────────────────────────────────────

const bookmarksCb   = document.getElementById("toggle-bookmarks");
const bookmarksHint = document.getElementById("bookmarks-hint");

getSetting(["onlyBookmarks"]).then(({ onlyBookmarks = false }) => {
  bookmarksCb.checked    = onlyBookmarks;
  bookmarksHint.textContent = onlyBookmarks ? "bookmarks only" : "all pages";
});

bookmarksCb.addEventListener("change", () => {
  const v = bookmarksCb.checked;
  setSetting({ onlyBookmarks: v });
  notifyBackground();
  bookmarksHint.textContent = v ? "bookmarks only" : "all pages";
  showToast(v ? "Only archiving bookmarks" : "Archiving all pages");
});

// ── Ignore root pages toggle ──────────────────────────────────────────────────

const ignoreRootCb = document.getElementById("toggle-ignore-root");

getSetting(["ignoreRootPages"]).then(({ ignoreRootPages = false }) => {
  ignoreRootCb.checked = ignoreRootPages;
});

ignoreRootCb.addEventListener("change", () => {
  const v = ignoreRootCb.checked;
  setSetting({ ignoreRootPages: v });
  notifyBackground();
  showToast(v ? "Ignoring root pages" : "Capturing root pages");
});

// ── GitHub auto-clone toggle ───────────────────────────────────────────────────

const githubCloneCb = document.getElementById("toggle-github-clone");

getSetting(["cloneGithubRepos"]).then(({ cloneGithubRepos = false }) => {
  githubCloneCb.checked = cloneGithubRepos;
});

githubCloneCb.addEventListener("change", () => {
  const v = githubCloneCb.checked;
  setSetting({ cloneGithubRepos: v });
  notifyBackground();
  showToast(v ? "GitHub auto-clone on" : "GitHub auto-clone off");
});
