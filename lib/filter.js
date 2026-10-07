// lib/filter.js — capture filter rules, shared by the background worker and UI.
//
// Pure functions only: callers supply the settings and bookmark state, so the
// popup can explain a decision using exactly the logic the background applies.

// Normalise filter site entries (legacy entries are plain hostname strings).
export function normaliseSites(filterSites = []) {
  return filterSites.map(e =>
    typeof e === "string"
      ? { host: e.toLowerCase(), stemOnly: false }
      : { host: e.host.toLowerCase(), stemOnly: !!e.stemOnly }
  );
}

// Find the list entry covering this hostname, if any.
export function findListedEntry(hostname, filterSites = []) {
  return normaliseSites(filterSites).find(({ host }) =>
    hostname === host || hostname.endsWith("." + host)
  );
}

// Returns { allowed: bool, reason?: string }
export function evaluateFilter(url, settings, bookmarked) {
  const {
    filterMode      = "none",
    filterSites     = [],
    onlyBookmarks   = false,
    ignoreRootPages = false,
  } = settings;

  let hostname, pathname;
  try {
    const parsed = new URL(url);
    hostname = parsed.hostname.toLowerCase();
    pathname = parsed.pathname;
  } catch { return { allowed: true }; }

  const isRoot = pathname === "/" || pathname === "";

  // If onlyBookmarks toggle is on and page is NOT bookmarked, skip
  if (onlyBookmarks && !bookmarked) return { allowed: false, reason: "only-bookmarks" };

  // Find if this hostname is explicitly listed
  const listed = findListedEntry(hostname, filterSites);

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

export const FILTER_SETTING_KEYS = ["filterMode", "filterSites", "onlyBookmarks", "ignoreRootPages"];
