// ui/dom.js — small helpers shared by the popup and options page.

export const $  = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function escHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// ── chrome wrappers ─────────────────────────────────────────────────────────

export function getSetting(keys) {
  return new Promise(res => chrome.storage.local.get(keys, res));
}
export function setSetting(obj) {
  return new Promise(res => chrome.storage.local.set(obj, res));
}
export function send(message) {
  return new Promise(res => {
    try {
      chrome.runtime.sendMessage(message, r => {
        // Swallow "receiving end does not exist" etc. — callers handle undefined.
        void chrome.runtime.lastError;
        res(r);
      });
    } catch { res(undefined); }
  });
}
export function notifyBackground() {
  return send({ type: "SETTINGS_UPDATED" });
}

// ── Formatting ──────────────────────────────────────────────────────────────

const nf = new Intl.NumberFormat();
export const fmtNum = n => (typeof n === "number" ? nf.format(n) : "—");

export function fmtSize(mb) {
  if (typeof mb !== "number") return "—";
  if (mb < 1)    return `${Math.round(mb * 1024)} KB`;
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

export function timeAgo(value, { short = false } = {}) {
  const ts = typeof value === "number" ? value : new Date(value).getTime();
  if (!ts || Number.isNaN(ts)) return "";
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1)  return "just now";
  if (m < 60) return short ? `${m}m` : `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return short ? `${h}h` : `${h} hr ago`;
  const d = Math.floor(h / 24);
  if (d < 7)  return short ? `${d}d` : `${d} day${d === 1 ? "" : "s"} ago`;
  const date = new Date(ts);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(undefined, sameYear
    ? { month: "short", day: "numeric" }
    : { month: "short", day: "numeric", year: "numeric" });
}

export function fmtDateTime(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString();
}

export function fmtDuration(ms) {
  const m = Math.ceil(ms / 60000);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), rest = m % 60;
  return rest ? `${h} hr ${rest} min` : `${h} hr`;
}

export function parseUrl(url) {
  try { return new URL(url); } catch { return null; }
}

export function isArchivableUrl(url) {
  return !!url &&
    !url.startsWith("chrome://") &&
    !url.startsWith("chrome-extension://") &&
    !url.startsWith("about:");
}

// Hostname without a leading "www." for display.
export function displayHost(url) {
  const u = parseUrl(url);
  return u ? u.hostname.replace(/^www\./, "") : url;
}

// Path + query for display ("" for a bare root).
export function displayPath(url) {
  const u = parseUrl(url);
  if (!u) return "";
  const p = (u.pathname === "/" ? "" : u.pathname) + u.search;
  try { return decodeURI(p); } catch { return p; }
}

// Normalise user input ("Twitter.com", "https://x.com/a") to a hostname,
// exactly as the original popup did.
export function toHostname(input) {
  let val = String(input || "").trim().toLowerCase();
  if (!val) return "";
  try { val = new URL(val.includes("://") ? val : "https://" + val).hostname; } catch (_) {}
  return val;
}

// ── Favicons (MV3 _favicon API, needs the "favicon" permission) ───────────────

export function faviconHtml(pageUrl, label = "") {
  const letter = escHtml((displayHost(pageUrl || "") || label || "?").charAt(0));
  if (!pageUrl || !chrome.runtime?.id) return `<span class="favicon" aria-hidden="true">${letter}</span>`;
  const src = `chrome-extension://${chrome.runtime.id}/_favicon/?pageUrl=${encodeURIComponent(pageUrl)}&size=32`;
  return `<span class="favicon" aria-hidden="true" data-letter="${letter}"><img src="${escHtml(src)}" alt="" loading="lazy"></span>`;
}

// ── Behaviour helpers ───────────────────────────────────────────────────────

// Flash a "Saved" indicator element.
export function flashSaved(el) {
  if (!el) return;
  el.classList.add("show");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove("show"), 1500);
}

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch { return false; }
}

// Wire a role="switch" button to a boolean value.
export function setSwitch(el, on) {
  el.setAttribute("aria-checked", on ? "true" : "false");
}
export function switchValue(el) {
  return el.getAttribute("aria-checked") === "true";
}

// Arrow-key navigation inside a role="radiogroup" of role="radio" buttons.
export function wireRadioGroup(group, onSelect) {
  const radios = () => $$('[role="radio"]', group);
  const select = (btn, focus) => {
    radios().forEach(r => {
      const on = r === btn;
      r.setAttribute("aria-checked", on ? "true" : "false");
      r.tabIndex = on ? 0 : -1;
    });
    if (focus) btn.focus();
    onSelect(btn.dataset.value, btn);
  };
  group.addEventListener("click", e => {
    const btn = e.target.closest('[role="radio"]');
    if (btn && !btn.disabled) select(btn, false);
  });
  group.addEventListener("keydown", e => {
    const list = radios();
    const i = list.indexOf(document.activeElement);
    if (i < 0) return;
    let next = null;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = list[(i + 1) % list.length];
    if (e.key === "ArrowLeft"  || e.key === "ArrowUp")   next = list[(i - 1 + list.length) % list.length];
    if (e.key === "Home") next = list[0];
    if (e.key === "End")  next = list[list.length - 1];
    if (next) { e.preventDefault(); select(next, true); }
  });
}

export function setRadioGroup(group, value) {
  $$('[role="radio"]', group).forEach(r => {
    const on = r.dataset.value === String(value);
    r.setAttribute("aria-checked", on ? "true" : "false");
    r.tabIndex = on ? 0 : -1;
  });
}

// Replace broken favicon images with the letter fallback.
export function wireFaviconFallback(root) {
  root.addEventListener("error", e => {
    const img = e.target;
    if (img.tagName !== "IMG" || !img.parentElement?.classList.contains("favicon")) return;
    const span = img.parentElement;
    span.textContent = span.dataset.letter || "?";
  }, true);
}
