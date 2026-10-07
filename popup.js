// popup.js — glanceable status, manual capture and recent pages.
// Configuration lives on the options page (options.html).

import {
  $, escHtml, getSetting, setSetting, send, notifyBackground,
  fmtNum, fmtSize, timeAgo, fmtDateTime, fmtDuration,
  parseUrl, isArchivableUrl, displayHost, displayPath, faviconHtml, wireFaviconFallback,
} from "./ui/dom.js";
import { icon, hydrateIcons } from "./ui/icons.js";
import { evaluateFilter, findListedEntry } from "./lib/filter.js";

const SETTING_KEYS = [
  "silentDownload", "useNativeHost", "onlyBookmarks", "ignoreRootPages",
  "filterMode", "filterSites", "captureInterval", "initialDelay",
];

const state = {
  tab:        null,
  settings:   {},
  stats:      null,   // GET_STATS response (or null while loading)
  statsError: false,
  tabStatus:  null,   // GET_TAB_STATUS response
  verdict:    null,   // { allowed, reason }
  capture:    "idle", // idle | busy | done | error
  storageReverted: false,
  captureError: "",
  query:      "",
};

hydrateIcons();
wireFaviconFallback(document.body);

// ── Navigation ──────────────────────────────────────────────────────────────

function openOptions(section) {
  if (section) {
    chrome.tabs.create({ url: chrome.runtime.getURL(`options.html#${section}`) });
    window.close();
  } else {
    chrome.runtime.openOptionsPage();
  }
}

$("#btn-settings").addEventListener("click", () => openOptions());
$("#btn-all-settings").addEventListener("click", () => openOptions());

// ── Header health pill ──────────────────────────────────────────────────────

function renderHealth() {
  const pill  = $("#health");
  const label = $("#health-label");
  const { useNativeHost, onlyBookmarks, filterMode } = state.settings;

  let tone = "success", text = "Archiving", action = null, title = "Pages you spend time on are being archived.";
  if (state.storageReverted) {
    tone = "warning"; text = "Storage issue"; action = "storage";
    title = "Couldn't reach the SQLite helper app, so captures are logged in browser storage for now. Click for details.";
  } else if (useNativeHost && state.statsError) {
    tone = "warning"; text = "Storage issue"; action = "storage";
    title = "Can't reach the SQLite helper app. Click for details.";
  } else if (onlyBookmarks) {
    tone = "info"; text = "Bookmarks only";
    title = "Only bookmarked pages are archived.";
  } else if (filterMode === "allow") {
    tone = "info"; text = "Allow list only";
    title = "Only sites on your allow list are archived.";
  }

  pill.className = `pill ${tone}${action ? " actionable" : ""}`;
  label.textContent = text;
  pill.title = title;
  pill.onclick = action ? () => openOptions(action) : null;
  if (action) { pill.setAttribute("role", "button"); pill.tabIndex = 0; }
  else { pill.setAttribute("role", "status"); pill.removeAttribute("tabindex"); }
  pill.onkeydown = action ? e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openOptions(action); } } : null;
}

// ── This page ───────────────────────────────────────────────────────────────

function renderPageHead() {
  const tab = state.tab;
  if (!tab) return;
  $("#page-favicon").innerHTML = tab.favIconUrl && /^https?:|^data:/.test(tab.favIconUrl)
    ? `<span class="favicon" aria-hidden="true" data-letter="${escHtml(displayHost(tab.url).charAt(0))}"><img src="${escHtml(tab.favIconUrl)}" alt=""></span>`
    : faviconHtml(isArchivableUrl(tab.url) ? tab.url : "", tab.title);
  $("#page-title").textContent = tab.title || displayHost(tab.url) || "Untitled";
  $("#page-title").title = tab.title || "";
  const path = displayPath(tab.url);
  $("#page-url").innerHTML = parseUrl(tab.url)?.protocol?.startsWith("http")
    ? `<span class="host">${escHtml(displayHost(tab.url))}</span><span class="path">${escHtml(path)}</span>`
    : `<span class="host">${escHtml(tab.url || "")}</span>`;
  $("#page-url").title = tab.url || "";
}

function recentMatch() {
  if (!state.tab || !state.stats?.recent) return null;
  return state.stats.recent.find(p => p.url === state.tab.url) || null;
}

function hostOf(url) {
  return parseUrl(url)?.hostname.toLowerCase() || "";
}

// Describe the current page's status: { tone, iconName, text, sub, action }
function describeStatus() {
  const tab = state.tab;
  if (!tab || !isArchivableUrl(tab.url)) {
    return { tone: "", iconName: "ban", text: "This page can't be archived.",
             sub: "Browser and extension pages are skipped." };
  }
  if (state.capture === "busy") {
    return { tone: "progress", spinner: true, text: "Archiving…" };
  }
  if (state.capture === "error") {
    return { tone: "danger", iconName: "alertCircle", text: "Couldn't archive this page.",
             sub: state.captureError, action: { label: "Try again", run: capture } };
  }

  const v = state.verdict;
  const host = hostOf(tab.url);
  const listed = findListedEntry(host, state.settings.filterSites || []);
  if (v && !v.allowed) {
    switch (v.reason) {
      case "blocked":
        return { iconName: "ban", text: `Not archived: ${listed?.host || host} is on your block list.`,
                 action: { label: `Unblock ${listed?.host || host}`, run: () => removeSite(listed?.host) } };
      case "stem-block":
        return { iconName: "home", text: `Not archived: home page of ${listed?.host || host} is blocked.`,
                 sub: "Its other pages are still archived.",
                 action: { label: "Change", run: () => openOptions("filters") } };
      case "not-in-allowlist":
        return { iconName: "filter", text: `Not archived: ${displayHost(tab.url)} isn't on your allow list.`,
                 action: { label: `Allow ${displayHost(tab.url)}`, run: () => addSite(displayHost(tab.url)) } };
      case "stem-only":
        return { iconName: "home", text: "Not archived: home pages of this site are skipped.",
                 action: { label: "Change", run: () => openOptions("filters") } };
      case "ignore-root":
        return { iconName: "home", text: "Not archived: home pages are skipped.",
                 sub: "Pages deeper in this site are still archived.",
                 action: { label: "Change", run: () => openOptions("filters") } };
      case "only-bookmarks":
        return { iconName: "bookmark", text: "Not archived: only bookmarked pages are saved.",
                 sub: "Bookmark this page to archive it now.",
                 action: { label: "Change", run: () => openOptions("filters") } };
      default:
        return { iconName: "ban", text: "Not archived because of your filters.",
                 action: { label: "Review filters", run: () => openOptions("filters") } };
    }
  }

  const match = recentMatch();
  const ts    = state.tabStatus;
  let next = "";
  if (ts?.known && ts.pending) {
    next = "Saving a new copy in a moment.";
  } else if (ts?.known && ts.lastCapturedAt && ts.activeMs < ts.intervalMs) {
    next = `Next copy after ${fmtDuration(ts.intervalMs - ts.activeMs)} more on this page.`;
  }

  if (state.capture === "done" || match) {
    const when = state.capture === "done" ? "just now" : timeAgo(match.last_seen);
    const n    = match?.snapshot_count;
    return { tone: "success", iconName: "checkCircle",
             text: `Archived ${when}${n ? ` · ${fmtNum(n)} snapshot${n === 1 ? "" : "s"}` : ""}`,
             title: match ? fmtDateTime(match.last_seen) : "", sub: next };
  }
  if (ts?.known && ts.pending) {
    return { tone: "progress", spinner: true, text: "Archiving in a moment…",
             sub: "Waiting for the page to finish loading." };
  }
  if (!state.stats && !state.statsError) {
    return { loading: true };
  }
  return { iconName: "clock", text: "Not archived yet.",
           sub: "It will be saved shortly after you return to this tab — or archive it now." };
}

function renderStatus() {
  const el = $("#page-status");
  const s  = describeStatus();
  if (s.loading) return;
  el.className = `page-status ${s.tone || ""}`;
  el.innerHTML = `
    ${s.spinner ? '<span class="spinner" aria-hidden="true"></span>' : icon(s.iconName)}
    <div class="status-body">
      <div${s.title ? ` title="${escHtml(s.title)}"` : ""}>${escHtml(s.text)}</div>
      ${s.sub ? `<div class="status-sub">${escHtml(s.sub)}</div>` : ""}
      ${s.action ? `<button class="btn-link status-action" type="button">${escHtml(s.action.label)}</button>` : ""}
    </div>`;
  if (s.action) el.querySelector(".status-action").addEventListener("click", s.action.run);

  // Primary button
  const btn = $("#btn-capture");
  const archivable = state.tab && isArchivableUrl(state.tab.url);
  const filtered   = state.verdict && !state.verdict.allowed;
  btn.disabled = !archivable || filtered || state.capture === "busy";
  btn.title = !archivable ? "This page can't be archived"
            : filtered ? "Your filters exclude this page" : "";
  const label = btn.querySelector(".label");
  const iconSlot = btn.firstElementChild;
  if (state.capture === "busy") {
    iconSlot.outerHTML = '<span class="spinner" aria-hidden="true"></span>';
    label.textContent = "Archiving…";
  } else if (state.capture === "done") {
    iconSlot.outerHTML = icon("check");
    label.textContent = "Archived";
  } else {
    iconSlot.outerHTML = icon("archive");
    label.textContent = recentMatch() && !filtered ? "Archive again" : "Archive now";
  }
}

async function evaluateVerdict() {
  const tab = state.tab;
  if (!tab || !isArchivableUrl(tab.url)) { state.verdict = null; return; }
  const bookmarked = await new Promise(res =>
    chrome.bookmarks.search({ url: tab.url }, r => res(!!(r && r.length))));
  state.verdict = evaluateFilter(tab.url, state.settings, bookmarked);
}

// ── Manual capture ──────────────────────────────────────────────────────────

async function capture() {
  if (state.capture === "busy") return;
  state.capture = "busy";
  renderStatus();
  const result = await send({ type: "MANUAL_CAPTURE" });
  if (result?.success) {
    state.capture = "done";
    renderStatus();
    await loadStats();
    setTimeout(() => { state.capture = "idle"; renderStatus(); }, 1500);
  } else {
    state.capture = "error";
    state.captureError = result?.filtered
      ? "Your filters exclude this page."
      : (result?.error || "The page may still be loading, or the browser blocked the capture.");
    renderStatus();
  }
}
$("#btn-capture").addEventListener("click", capture);

// ── Site list quick actions (write the same keys as the options page) ───────

async function saveFilter(filterSites) {
  state.settings.filterSites = filterSites;
  await setSetting({ filterMode: state.settings.filterMode || "none", filterSites });
  notifyBackground();
  await evaluateVerdict();
  renderStatus();
  buildMenu();
}

async function removeSite(host) {
  if (!host) return;
  const sites = (state.settings.filterSites || []).filter(e =>
    (typeof e === "string" ? e : e.host).toLowerCase() !== host);
  await saveFilter(sites);
}

async function addSite(host) {
  if (!host) return;
  const sites = [...(state.settings.filterSites || [])];
  if (!sites.some(e => (typeof e === "string" ? e : e.host).toLowerCase() === host)) {
    sites.push({ host, stemOnly: false });
  }
  await saveFilter(sites);
}

// ── Overflow menu ───────────────────────────────────────────────────────────

const menu    = $("#more-menu");
const moreBtn = $("#btn-more");

function buildMenu() {
  const items = [];
  const tab   = state.tab;
  if (tab && isArchivableUrl(tab.url) && parseUrl(tab.url)?.protocol.startsWith("http")) {
    const host   = hostOf(tab.url);
    const short  = displayHost(tab.url);
    const listed = findListedEntry(host, state.settings.filterSites || []);
    const mode   = state.settings.filterMode || "none";
    if (mode === "block") {
      items.push(listed
        ? { icon: "unlock", label: `Unblock ${listed.host}`, run: () => removeSite(listed.host) }
        : { icon: "ban",    label: `Block ${short}`,         run: () => addSite(short) });
    } else if (mode === "allow") {
      items.push(listed
        ? { icon: "x",     label: `Remove ${listed.host} from allow list`, run: () => removeSite(listed.host) }
        : { icon: "check", label: `Allow ${short}`,                        run: () => addSite(short) });
    } else {
      items.push({ icon: "filter", label: "Exclude sites…", run: () => openOptions("filters") });
    }
  }
  items.push({ icon: "folder", label: "Open archive folder", run: () => chrome.downloads.showDefaultFolder() });
  items.push("sep");
  items.push({ icon: "settings", label: "Settings", run: () => openOptions() });

  menu.innerHTML = items.map((it, i) => it === "sep"
    ? "<hr>"
    : `<button type="button" role="menuitem" tabindex="-1" data-i="${i}">${icon(it.icon)}<span>${escHtml(it.label)}</span></button>`
  ).join("");
  menu.querySelectorAll("[role=menuitem]").forEach(b => {
    b.addEventListener("click", () => { closeMenu(); items[+b.dataset.i].run(); });
  });
}

function openMenu() {
  buildMenu();
  menu.hidden = false;
  moreBtn.setAttribute("aria-expanded", "true");
  menu.querySelector("[role=menuitem]")?.focus();
}
function closeMenu(focusTrigger = false) {
  if (menu.hidden) return;
  menu.hidden = true;
  moreBtn.setAttribute("aria-expanded", "false");
  if (focusTrigger) moreBtn.focus();
}

moreBtn.addEventListener("click", () => (menu.hidden ? openMenu() : closeMenu()));
menu.addEventListener("keydown", e => {
  const items = [...menu.querySelectorAll("[role=menuitem]")];
  const i = items.indexOf(document.activeElement);
  if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length].focus(); }
  if (e.key === "ArrowUp")   { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
  if (e.key === "Home")      { e.preventDefault(); items[0].focus(); }
  if (e.key === "End")       { e.preventDefault(); items[items.length - 1].focus(); }
  if (e.key === "Escape")    { e.preventDefault(); e.stopPropagation(); closeMenu(true); }
  if (e.key === "Tab")       { closeMenu(); }
});
document.addEventListener("click", e => {
  if (!menu.hidden && !e.target.closest(".menu-anchor")) closeMenu();
});

// ── Summary + recent list ───────────────────────────────────────────────────

function renderSummary() {
  const el = $("#summary");
  const s  = state.stats;
  if (!s) {
    el.textContent = state.statsError ? "Archive totals unavailable." : "";
    return;
  }
  el.innerHTML =
    `<b>${fmtNum(s.pages)}</b> page${s.pages === 1 ? "" : "s"}<span class="sep">·</span>` +
    `<b>${fmtNum(s.snapshots)}</b> snapshot${s.snapshots === 1 ? "" : "s"}<span class="sep">·</span>` +
    `<b>${fmtSize(s.mb)}</b>`;
}

function renderRecent() {
  const list  = $("#recent-list");
  const extra = $("#recent-state");
  const search = $("#recent-search");
  extra.innerHTML = "";

  if (state.statsError) {
    list.innerHTML = "";
    search.hidden = true;
    const native = state.settings.useNativeHost;
    extra.innerHTML = `
      <div class="banner danger" role="alert">
        ${icon("alertCircle")}
        <div><strong>Couldn't load your archive.</strong><br>
          ${native ? "The SQLite helper app didn't respond." : "The extension's background worker didn't respond."}
          <div style="margin-top:6px; display:flex; gap:12px">
            <button class="btn-link" type="button" id="btn-retry">Retry</button>
            ${native ? '<button class="btn-link" type="button" id="btn-storage">Check storage settings</button>' : ""}
          </div>
        </div>
      </div>`;
    $("#btn-retry").addEventListener("click", () => loadStats());
    $("#btn-storage")?.addEventListener("click", () => openOptions("storage"));
    return;
  }

  const recent = state.stats?.recent || [];
  if (!recent.length) {
    list.innerHTML = "";
    search.hidden = true;
    const canArchive = state.tab && isArchivableUrl(state.tab.url) && !(state.verdict && !state.verdict.allowed);
    extra.innerHTML = `
      <div class="empty">
        <strong>Nothing archived yet</strong>
        Pages you spend time on will appear here.
        ${canArchive ? '<br><button class="btn-link" type="button" id="btn-empty-capture">Archive this page now</button>' : ""}
      </div>`;
    $("#btn-empty-capture")?.addEventListener("click", capture);
    return;
  }

  search.hidden = recent.length < 6;
  const q = state.query.trim().toLowerCase();
  const rows = q
    ? recent.filter(p => (p.title || "").toLowerCase().includes(q) || (p.url || "").toLowerCase().includes(q))
    : recent;

  if (!rows.length) {
    list.innerHTML = "";
    extra.innerHTML = `<div class="empty">No recent pages match “${escHtml(state.query.trim())}”.</div>`;
    return;
  }

  list.innerHTML = rows.map(p => {
    const n = p.snapshot_count || 0;
    return `<li><a href="${escHtml(p.url)}" target="_blank" rel="noopener" title="${escHtml(p.url)}">
      ${faviconHtml(p.url, p.title)}
      <span class="r-main">
        <span class="r-title" style="display:block">${escHtml(p.title || displayHost(p.url) || "Untitled")}</span>
        <span class="r-meta" style="display:block">${escHtml(displayHost(p.url))} · ${fmtNum(n)} snapshot${n === 1 ? "" : "s"}</span>
      </span>
      <time class="r-time num" datetime="${escHtml(p.last_seen)}" title="${escHtml(fmtDateTime(p.last_seen))}">${escHtml(timeAgo(p.last_seen, { short: true }))}</time>
    </a></li>`;
  }).join("");
}

$("#recent-filter").addEventListener("input", e => { state.query = e.target.value; renderRecent(); });
$("#recent-filter").addEventListener("keydown", e => {
  if (e.key === "Escape" && e.target.value) { e.preventDefault(); e.stopPropagation(); e.target.value = ""; state.query = ""; renderRecent(); }
});
document.addEventListener("keydown", e => {
  if (e.key === "/" && document.activeElement?.tagName !== "INPUT" && !$("#recent-search").hidden) {
    e.preventDefault();
    $("#recent-filter").focus();
  }
});

async function loadStats() {
  const data = await send({ type: "GET_STATS" });
  if (data && data.ok) { state.stats = data; state.statsError = false; }
  else { state.stats = null; state.statsError = true; }
  renderHealth();
  renderSummary();
  renderRecent();
  renderStatus();
}

// ── Footer ──────────────────────────────────────────────────────────────────

function renderFooter() {
  const { silentDownload = true, useNativeHost = false } = state.settings;
  let text = silentDownload ? "Saving to Downloads/page-archiver" : "Asking where to save each copy";
  if (useNativeHost) text += " + SQLite";
  $("#footer-dest").textContent = text;
  $("#footer-dest").title = text;
}

// ── Init ────────────────────────────────────────────────────────────────────

async function init() {
  const [tabs, settings] = await Promise.all([
    chrome.tabs.query({ active: true, currentWindow: true }),
    getSetting(SETTING_KEYS),
  ]);
  state.tab = tabs[0] || null;
  state.settings = settings;

  // As before the redesign: if SQLite is selected but the helper app is
  // unreachable, fall back to browser storage (and say so in the header).
  if (settings.useNativeHost) {
    const ping = await send({ type: "PING_HOST" });
    if (!(ping && ping.ok)) {
      await setSetting({ useNativeHost: false });
      state.settings.useNativeHost = false;
      state.storageReverted = true;
    }
  }

  renderHealth();
  renderFooter();
  renderPageHead();
  buildMenu();

  const tabStatus = state.tab && isArchivableUrl(state.tab.url)
    ? send({ type: "GET_TAB_STATUS", tabId: state.tab.id, url: state.tab.url })
    : Promise.resolve(null);

  await evaluateVerdict();
  state.tabStatus = await tabStatus;
  renderStatus();
  await loadStats();
}

init();
