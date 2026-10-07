// options.js — full settings page. Reads and writes the same chrome.storage.local
// keys as the original popup, with the same defaults and clamps.

import {
  $, $$, escHtml, getSetting, setSetting, send, notifyBackground,
  fmtNum, fmtSize, flashSaved, copyText, setSwitch, switchValue,
  wireRadioGroup, setRadioGroup, toHostname, faviconHtml, wireFaviconFallback,
} from "./ui/dom.js";
import { icon, hydrateIcons } from "./ui/icons.js";

hydrateIcons();
wireFaviconFallback(document.body);
$("#version").textContent = `Version ${chrome.runtime.getManifest().version}`;

const saved = name => flashSaved(document.querySelector(`[data-saved="${name}"]`));
$$(".saved").forEach(el => { el.innerHTML = `${icon("check")}Saved`; });

// ── Section routing ─────────────────────────────────────────────────────────

let settingsLoaded = false;
const SECTIONS = ["capture", "filters", "storage", "integrations", "about"];

function showSection(name, focus = false) {
  if (!SECTIONS.includes(name)) name = "capture";
  $$(".panel").forEach(p => { p.hidden = p.dataset.section !== name; });
  $$("nav a").forEach(a => {
    if (a.dataset.section === name) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  document.title = `${$(`#panel-${name} h1`).textContent} · Page Archiver`;
  if (focus) $("#main").focus();
  if (settingsLoaded && (name === "storage" || name === "integrations")) refreshHost();
}

window.addEventListener("hashchange", () => showSection(location.hash.slice(1), true));
showSection(location.hash.slice(1));

// ── Number steppers (same clamps as the original popup) ─────────────────────

function wireNumber({ input, errEl, key, min, max, fallback, savedName, onSaved }) {
  const validate = () => {
    const raw = input.value.trim();
    const n = Number(raw);
    let msg = "";
    if (raw === "" || !Number.isFinite(n)) msg = `Enter a number from ${min} to ${max}.`;
    else if (n < min || n > max) msg = `Must be between ${min} and ${max}.`;
    errEl.hidden = !msg;
    errEl.textContent = msg;
    input.setAttribute("aria-invalid", msg ? "true" : "false");
  };
  const commit = async () => {
    const parsed = parseInt(input.value, 10);
    const v = Math.max(min, Math.min(max, Number.isNaN(parsed) ? fallback : parsed));
    input.value = v;
    errEl.hidden = true;
    input.setAttribute("aria-invalid", "false");
    await setSetting({ [key]: v });
    notifyBackground();
    saved(savedName);
    onSaved?.(v);
  };
  input.addEventListener("input", validate);
  input.addEventListener("change", commit);
  input.addEventListener("keydown", e => { if (e.key === "Enter") input.blur(); });
  input.closest(".stepper").querySelectorAll("button[data-step]").forEach(btn => {
    btn.addEventListener("click", () => {
      const cur = parseInt(input.value, 10);
      input.value = (Number.isNaN(cur) ? fallback : cur) + Number(btn.dataset.step);
      commit();
    });
  });
}

// ── Capture ─────────────────────────────────────────────────────────────────

const PRESETS = ["1", "5", "15", "30", "60"];
const intervalGroup  = $("#interval-presets");
const intervalInput  = $("#input-interval");
const customInterval = $("#custom-interval");

function showInterval(v) {
  const isPreset = PRESETS.includes(String(v));
  setRadioGroup(intervalGroup, isPreset ? String(v) : "custom");
  customInterval.hidden = isPreset;
  intervalInput.value = v;
}

wireRadioGroup(intervalGroup, async value => {
  if (value === "custom") {
    customInterval.hidden = false;
    intervalInput.focus();
    return;
  }
  customInterval.hidden = true;
  intervalInput.value = value;
  await setSetting({ captureInterval: Number(value) });
  notifyBackground();
  saved("interval");
});

wireNumber({
  input: intervalInput, errEl: $("#err-interval"), key: "captureInterval",
  min: 1, max: 1440, fallback: 5, savedName: "interval",
});

wireNumber({
  input: $("#input-delay"), errEl: $("#err-delay"), key: "initialDelay",
  min: 0, max: 120, fallback: 10, savedName: "delay",
});

function wireSwitch(el, key, savedName, onChange) {
  el.addEventListener("click", async () => {
    if (el.disabled) return;
    const v = !switchValue(el);
    setSwitch(el, v);
    await setSetting({ [key]: v });
    notifyBackground();
    saved(savedName);
    onChange?.(v);
  });
}

wireSwitch($("#sw-silent"), "silentDownload", "silent");
$("#btn-browser-downloads").addEventListener("click", () => {
  chrome.tabs.create({ url: "chrome://settings/downloads" });
});

// ── What to archive ─────────────────────────────────────────────────────────

wireSwitch($("#sw-bookmarks"), "onlyBookmarks", "bookmarks");
wireSwitch($("#sw-root"), "ignoreRootPages", "root");

let filterMode  = "none";
let filterSites = [];
let undo = null; // { entry, index, timer }

const MODE_HELP = {
  none:  "Archive all sites. Your list is kept but not used.",
  block: "Archive everything except the sites below.",
  allow: "Archive only the sites below (and their subdomains).",
};

async function saveFilter() {
  await setSetting({ filterMode, filterSites });
  notifyBackground();
}

wireRadioGroup($("#filter-mode"), async value => {
  filterMode = value;
  await saveFilter();
  saved("mode");
  renderSites();
});

function renderSites() {
  setRadioGroup($("#filter-mode"), filterMode);
  $("#mode-help").textContent = MODE_HELP[filterMode];

  const list = $("#site-list");
  list.classList.toggle("inactive", filterMode === "none");
  if (!filterSites.length) {
    list.innerHTML = `<li class="empty-row">No sites yet. Add one above.</li>`;
    return;
  }
  const isBlock = filterMode === "block";
  list.innerHTML = filterSites.map((entry, i) => `
    <li>
      ${faviconHtml("https://" + entry.host + "/", entry.host)}
      <span class="host" title="${escHtml(entry.host)}">${escHtml(entry.host)}</span>
      ${isBlock ? `
        <span class="stem" title="Block ${escHtml(entry.host)}/ but still archive its other pages">
          <span id="stem-lbl-${i}">Home page only</span>
          <button type="button" class="switch" role="switch" data-stem="${i}"
                  aria-checked="${entry.stemOnly ? "true" : "false"}" aria-labelledby="stem-lbl-${i}"></button>
        </span>` : ""}
      <button type="button" class="icon-btn danger" data-remove="${i}" aria-label="Remove ${escHtml(entry.host)}" title="Remove">
        ${icon("x")}
      </button>
    </li>`).join("");
}

$("#site-list").addEventListener("click", async e => {
  const stem = e.target.closest("[data-stem]");
  if (stem) {
    const i = Number(stem.dataset.stem);
    filterSites[i].stemOnly = !filterSites[i].stemOnly;
    await saveFilter();
    renderSites();
    $(`[data-stem="${i}"]`)?.focus();
    return;
  }
  const rm = e.target.closest("[data-remove]");
  if (rm) {
    const i = Number(rm.dataset.remove);
    const [entry] = filterSites.splice(i, 1);
    await saveFilter();
    renderSites();
    showUndo(entry, i);
    const next = $$("[data-remove]")[Math.min(i, filterSites.length - 1)];
    (next || $("#site-input")).focus();
  }
});

function showUndo(entry, index) {
  if (undo) clearTimeout(undo.timer);
  const slot = $("#undo-slot");
  slot.innerHTML = `
    <div class="banner">
      ${icon("trash")}
      <div>Removed <strong>${escHtml(entry.host)}</strong></div>
      <button type="button" class="btn-link" id="btn-undo">Undo</button>
    </div>`;
  undo = { entry, index, timer: setTimeout(() => { slot.innerHTML = ""; undo = null; }, 5000) };
  $("#btn-undo").addEventListener("click", async () => {
    if (!undo) return;
    clearTimeout(undo.timer);
    filterSites.splice(Math.min(undo.index, filterSites.length), 0, undo.entry);
    undo = null;
    slot.innerHTML = "";
    await saveFilter();
    renderSites();
    $("#site-input").focus();
  });
}

$("#add-site").addEventListener("submit", async e => {
  e.preventDefault();
  const input = $("#site-input");
  const err   = $("#err-site");
  const host  = toHostname(input.value);
  const fail  = msg => {
    err.textContent = msg; err.hidden = false;
    input.setAttribute("aria-invalid", "true");
  };
  if (!host) return fail("Enter a site like example.com.");
  if (filterSites.some(s => s.host === host)) return fail(`${host} is already in your list.`);
  err.hidden = true;
  input.setAttribute("aria-invalid", "false");
  filterSites.push({ host, stemOnly: false });
  input.value = "";
  await saveFilter();
  renderSites();
  saved("mode");
});
$("#site-input").addEventListener("input", () => {
  $("#err-site").hidden = true;
  $("#site-input").setAttribute("aria-invalid", "false");
});

// ── Storage ─────────────────────────────────────────────────────────────────

let useNativeHost = false;
let hostState = { checked: false, ok: false, db: null }; // last PING_HOST result
let hostCheck = null;

$("#ext-id").textContent = chrome.runtime.id;
$$("[data-copy]").forEach(btn => {
  btn.addEventListener("click", async () => {
    const ok = await copyText($(btn.dataset.copy).textContent);
    const original = btn.innerHTML;
    btn.innerHTML = `${icon(ok ? "check" : "x")}${ok ? "Copied" : "Copy failed"}`;
    setTimeout(() => { btn.innerHTML = original; }, 1500);
  });
});

function renderStorage(stats) {
  setRadioGroup($("#storage-mode"), useNativeHost ? "native" : "local");

  const status = $("#host-status");
  const setup  = $("#setup-panel");
  if (useNativeHost && hostState.ok) {
    const blob = stats && stats.blob_mb > 0 ? ` · ${fmtSize(stats.blob_mb)} of page copies stored` : "";
    status.innerHTML = `
      <div class="banner success">
        ${icon("checkCircle")}
        <div><strong>Connected to the helper app</strong>${escHtml(blob)}
          <div class="db-path"><code id="db-path">${escHtml(hostState.db || "")}</code>
            <button type="button" class="btn-link" id="btn-copy-db">Copy path</button></div>
        </div>
      </div>`;
    $("#btn-copy-db").addEventListener("click", async e => {
      const ok = await copyText(hostState.db || "");
      e.target.textContent = ok ? "Copied" : "Copy failed";
      setTimeout(() => { e.target.textContent = "Copy path"; }, 1500);
    });
    setup.hidden = true;
  } else if (status.dataset.reverted === "true") {
    status.innerHTML = `
      <div class="banner warning" role="alert">
        ${icon("alert")}
        <div><strong>Couldn't reach the helper app.</strong> Switched back to browser storage so captures keep being logged. Follow the steps below, then choose SQLite again.</div>
      </div>`;
    setup.hidden = false;
  } else {
    status.innerHTML = "";
    setup.hidden = true;
  }

  $("#clear-help").innerHTML = useNativeHost
    ? "Removes every capture record <strong>and the full page copies</strong> stored in the SQLite database. Saved <code>.mhtml</code> files in your Downloads folder are not deleted."
    : "Removes the list of captures kept in browser storage. Saved <code>.mhtml</code> files in your Downloads folder are not deleted.";
}

// Ping the helper app; while SQLite is selected, an unreachable host switches
// back to browser storage — the same behaviour the original popup had.
function refreshHost() {
  if (hostCheck) return hostCheck;
  hostCheck = (async () => {
    if (useNativeHost) $("#host-status").innerHTML =
      `<div class="banner"><span class="spinner" aria-hidden="true"></span><div>Checking the helper app…</div></div>`;
    const res = await send({ type: "PING_HOST" });
    hostState = { checked: true, ok: !!(res && res.ok), db: res?.db || null };
    let stats = null;
    if (useNativeHost) {
      if (hostState.ok) {
        stats = await send({ type: "GET_STATS" });
      } else {
        useNativeHost = false;
        await setSetting({ useNativeHost: false });
        $("#host-status").dataset.reverted = "true";
      }
    }
    renderStorage(stats);
    renderGithub();
    hostCheck = null;
  })();
  return hostCheck;
}

wireRadioGroup($("#storage-mode"), async value => {
  const v = value === "native";
  if (v === useNativeHost) return;
  useNativeHost = v;
  $("#host-status").dataset.reverted = "false";
  await setSetting({ useNativeHost: v });
  notifyBackground();
  if (v) await refreshHost();
  else renderStorage(null);
  if (useNativeHost === v) saved("storage");
});

$("#btn-check-host").addEventListener("click", async () => {
  const btn = $("#btn-check-host");
  btn.disabled = true;
  await refreshHost();
  btn.disabled = false;
  if (hostState.ok) {
    $("#host-status").dataset.reverted = "false";
    $("#host-status").innerHTML = `
      <div class="banner success">${icon("checkCircle")}
        <div><strong>The helper app is installed.</strong> Choose <strong>SQLite database</strong> above to start using it.</div></div>`;
    $("#setup-panel").hidden = true;
  }
});

// Clear dialog
const dialog = $("#clear-dialog");
$("#btn-clear").addEventListener("click", async () => {
  const stats = await send({ type: "GET_STATS" });
  const n = stats?.ok ? stats.snapshots : null;
  $("#clear-body").innerHTML = `
    <p>${n != null
      ? `This deletes <strong>${fmtNum(n)} capture record${n === 1 ? "" : "s"}</strong> across ${fmtNum(stats.pages)} page${stats.pages === 1 ? "" : "s"}.`
      : "This deletes every capture record."}</p>
    <p>Saved <code>.mhtml</code> files in your Downloads folder are kept.</p>
    ${useNativeHost ? `<div class="banner danger">${icon("alert")}<div>The full page copies stored in the SQLite database will be <strong>permanently deleted</strong>.</div></div>` : ""}`;
  const empty = n === 0;
  $("#btn-clear-confirm").hidden = empty;
  $("#btn-clear-cancel").textContent = empty ? "Close" : "Cancel";
  if (empty) $("#clear-body").innerHTML = "<p>The archive log is already empty.</p>";
  dialog.showModal();
  $("#btn-clear-cancel").focus();
});
$("#btn-clear-cancel").addEventListener("click", () => dialog.close());
$("#btn-clear-confirm").addEventListener("click", async () => {
  const btn = $("#btn-clear-confirm");
  btn.disabled = true;
  const res = await send({ type: "CLEAR_DB" });
  btn.disabled = false;
  dialog.close();
  $("#host-status").innerHTML = res?.ok
    ? `<div class="banner success" role="status">${icon("checkCircle")}<div>Archive log cleared.</div></div>`
    : `<div class="banner danger" role="alert">${icon("alertCircle")}<div>Couldn't clear the log: ${escHtml(res?.error || "no response")}</div></div>`;
});

// ── Integrations ────────────────────────────────────────────────────────────

let cloneGithubRepos = false;
const githubSwitch = $("#sw-github");

function renderGithub() {
  setSwitch(githubSwitch, cloneGithubRepos);
  const note = $("#github-note");
  if (!hostState.checked) {
    githubSwitch.disabled = !cloneGithubRepos;
    note.innerHTML = "";
    return;
  }
  if (hostState.ok) {
    githubSwitch.disabled = false;
    note.innerHTML = "";
  } else if (cloneGithubRepos) {
    // Leave it switchable so it can be turned off; never rewrite it silently.
    githubSwitch.disabled = false;
    note.innerHTML = `<div class="banner warning">${icon("alert")}<div><strong>Not working:</strong> the helper app isn't reachable. <a href="#storage">Set it up in Storage</a>.</div></div>`;
  } else {
    githubSwitch.disabled = true;
    note.innerHTML = `<div class="banner info">${icon("info")}<div>Requires the helper app. <a href="#storage">Set it up in Storage</a>.</div></div>`;
  }
}

wireSwitch(githubSwitch, "cloneGithubRepos", "github", v => {
  cloneGithubRepos = v;
  renderGithub();
});

// ── Init ────────────────────────────────────────────────────────────────────

getSetting([
  "captureInterval", "initialDelay", "silentDownload", "onlyBookmarks", "ignoreRootPages",
  "filterMode", "filterSites", "useNativeHost", "cloneGithubRepos",
]).then(s => {
  showInterval(s.captureInterval ?? 5);
  $("#input-delay").value = s.initialDelay ?? 10;
  setSwitch($("#sw-silent"), s.silentDownload ?? true);
  setSwitch($("#sw-bookmarks"), s.onlyBookmarks ?? false);
  setSwitch($("#sw-root"), s.ignoreRootPages ?? false);

  filterMode  = s.filterMode || "none";
  filterSites = (s.filterSites || []).map(e => typeof e === "string" ? { host: e, stemOnly: false } : e);
  renderSites();

  useNativeHost    = s.useNativeHost ?? false;
  cloneGithubRepos = s.cloneGithubRepos ?? false;
  renderStorage(null);
  renderGithub();
  settingsLoaded = true;
  refreshHost();
});
