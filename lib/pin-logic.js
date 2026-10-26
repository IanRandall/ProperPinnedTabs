/**
 * Pure pin storage / reconcile rules for Proper Pinned Tabs.
 * Used by the service worker controller and by Node unit tests (no chrome.*).
 */

/** Max remembered "navigated to" URL keys per pin (see planReconcile). */
export const MAX_ALIASES_PER_PIN = 5;

/** Restricted schemes that extensions cannot open. */
export function isRestrictedUrl(url) {
  if (!url || typeof url !== "string") return true;
  try {
    const scheme = new URL(url).protocol.toLowerCase();
    return [
      "chrome:",
      "chrome-extension:",
      "chrome-search:",
      "chrome-untrusted:",
      "brave:",
      "edge:",
      "about:",
      "devtools:",
      "view-source:",
      "data:",
      "blob:",
      "file:",
      "javascript:",
    ].includes(scheme);
  } catch {
    return true;
  }
}

/**
 * Identity key used to dedupe and match pins. Stored URLs are kept exactly as
 * pinned; the key only answers "is this the same pin?":
 * - host is lowercased and a non-default port is kept (localhost:3000 ≠ :5173)
 * - http and https share a key (a site upgrading to https is the same pin)
 * - a trailing slash on the path is ignored; the query string is kept
 * - hash routes (`#/…` or `#!…`, used by SPAs) are kept; plain in-page
 *   anchors (`#section`) are ignored
 */
export function normalizeUrlKey(url) {
  if (isRestrictedUrl(url)) return null;
  try {
    const u = new URL(url);
    let path = u.pathname || "/";
    if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
    const scheme =
      u.protocol === "http:" || u.protocol === "https:" ? "" : `${u.protocol}//`;
    const hash = /^#[!/]/.test(u.hash) ? u.hash : "";
    return `${scheme}${u.host.toLowerCase()}${path}${u.search}${hash}`;
  } catch {
    return null;
  }
}

/** Lowercased host (incl. non-default port) of a usable URL, or null. */
export function urlHost(url) {
  if (isRestrictedUrl(url)) return null;
  try {
    return new URL(url).host.toLowerCase() || null;
  } catch {
    return null;
  }
}

export function pickUsableUrl(tab) {
  if (!tab) return null;
  for (const candidate of [tab.url, tab.pendingUrl]) {
    if (candidate && !isRestrictedUrl(candidate)) return candidate;
  }
  return null;
}

export function tabMatchKey(tab) {
  const url = pickUsableUrl(tab);
  return url ? normalizeUrlKey(url) : null;
}

/** Dedupe by key, preserving first-seen order and the exact stored URL. */
export function dedupeUrlList(urls) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(urls) ? urls : []) {
    const key = normalizeUrlKey(raw);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(raw);
  }
  return out;
}

/**
 * Add a pin URL. If the same key is already stored, its entry is replaced
 * in place by the URL just pinned (so re-pinning fixes e.g. a legacy
 * https-rewritten localhost URL). Returns { list, key, changed }.
 */
export function addPinToList(urls, url) {
  const list = dedupeUrlList(urls);
  const key = normalizeUrlKey(url);
  if (!key) return { list, key: null, changed: false };
  const at = list.findIndex((u) => normalizeUrlKey(u) === key);
  if (at === -1) return { list: [...list, url], key, changed: true };
  if (list[at] === url) return { list, key, changed: false };
  const next = [...list];
  next[at] = url;
  return { list: next, key, changed: true };
}

/** Remove the entry for a key. Returns { list, removed }. */
export function removeKeyFromList(urls, key) {
  const list = dedupeUrlList(urls);
  if (!key) return { list, removed: false };
  const next = list.filter((u) => normalizeUrlKey(u) !== key);
  return { list: next, removed: next.length !== list.length };
}

/**
 * Remember that the pin `key` is currently showing `url` so a navigated pin
 * can be recognized after a browser restart (when tab bindings are gone).
 * Returns { aliases, changed } without mutating the input.
 */
export function addAlias(aliases, key, url) {
  const aliasKey = normalizeUrlKey(url);
  const current = (aliases && aliases[key]) || [];
  if (!key || !aliasKey || aliasKey === key || current[current.length - 1] === aliasKey) {
    return { aliases, changed: false };
  }
  const list = [...current.filter((k) => k !== aliasKey), aliasKey].slice(
    -MAX_ALIASES_PER_PIN
  );
  return { aliases: { ...aliases, [key]: list }, changed: true };
}

/** Drop aliases for keys no longer stored. */
export function pruneAliases(aliases, savedUrls) {
  const keys = new Set(dedupeUrlList(savedUrls).map(normalizeUrlKey));
  const out = {};
  let changed = false;
  for (const [key, list] of Object.entries(aliases || {})) {
    if (keys.has(key) && Array.isArray(list)) out[key] = list;
    else changed = true;
  }
  return { aliases: out, changed };
}

/**
 * Whether closing a pinned tab should remove it from storage.
 * Window close / last window / browser shutdown must preserve storage.
 */
export function shouldRemoveOnTabClosed({
  sessionEnding = false,
  isWindowClosing = false,
  browserStillOpen = true,
} = {}) {
  return !sessionEnding && !isWindowClosing && browserStillOpen;
}

/**
 * Plan how to make one window's pinned tabs match storage. Pure — no chrome.
 *
 * Inputs:
 * - savedUrls: ordered stored pin URLs (the single source of truth)
 * - tabs: this window's tabs { id, pinned, url?, pendingUrl?, index }
 * - bindings: { [tabId]: key } — tabs the extension knows represent a pin
 * - aliases: { [key]: [urlKey…] } — URLs a pin was recently navigated to
 * - pendingKeys: keys whose close/unpin event is still queued; never
 *   create these (prevents resurrecting a pin the user just closed)
 * - createdTabIds: tabs the extension created this session
 *
 * Actions (in order to execute):
 * - close { tabId, key }   bound pin whose key left storage (live sync), or
 *                          an untouched copy we created that lost a race
 *                          with the browser restoring the real pin
 * - bind  { tabId, key }
 * - create { url, key, index }
 *
 * Rules (conservative — never steal or alter unrelated tabs):
 * - Unpinned tabs are never touched.
 * - An unbound pinned tab is bound only for a sound reason, in priority
 *   order: exact URL key match, a remembered alias of the pin, or — after
 *   a restart, when bindings are lost — it is the *only* unbound pinned tab
 *   on the same host as the *only* missing pin for that host.
 * - Anything else stays unbound and untouched; missing pins are created.
 *   Aliases live in chrome.storage.local, so they survive browser restarts
 *   and extension updates (unlike tab bindings). Unbound pinned tabs are
 *   never bound by position: that used to hijack unrelated pins.
 *   Tradeoff: a pin navigated to another site whose alias was not recorded
 *   (e.g. navigated before 1.1.0, or more than MAX_ALIASES_PER_PIN sites
 *   ago) is not recognized after a restart, so it is left alone and a fresh
 *   copy of the saved URL is created next to it (no work is ever lost).
 * - Never navigates, reloads or moves existing tabs.
 */
export function planReconcile({
  savedUrls,
  tabs = [],
  bindings = {},
  aliases = {},
  pendingKeys = [],
  createdTabIds = [],
} = {}) {
  const saved = dedupeUrlList(savedUrls);
  const keys = saved.map(normalizeUrlKey);
  const urlByKey = new Map(keys.map((k, i) => [k, saved[i]]));
  const savedSet = new Set(keys);
  const pending = new Set(pendingKeys);
  const created = new Set(createdTabIds);
  const actions = [];

  const pinned = tabs
    .filter((t) => t.pinned && t.id != null)
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

  /** key → tab representing it in this window */
  const covered = new Map();
  const unbound = [];
  for (const tab of pinned) {
    const key = bindings[String(tab.id)];
    if (!key) unbound.push(tab);
    else if (savedSet.has(key)) {
      if (!covered.has(key)) covered.set(key, tab);
    } else if (!pending.has(key)) {
      actions.push({ type: "close", tabId: tab.id, key });
    }
  }

  /** Our untouched copy of a pin can yield to a real (restored) tab. */
  const isDisposable = (tab, key) =>
    created.has(tab.id) && tabMatchKey(tab) === key;

  const claim = (tab, key) => {
    const holder = covered.get(key);
    if (holder) {
      if (!isDisposable(holder, key) || holder === tab) return false;
      actions.push({ type: "close", tabId: holder.id, key });
    }
    covered.set(key, tab);
    actions.push({ type: "bind", tabId: tab.id, key });
    return true;
  };

  let rest = [];
  for (const tab of unbound) {
    const k = tabMatchKey(tab);
    if (!(k && savedSet.has(k) && claim(tab, k))) rest.push(tab);
  }

  const leftover = [];
  for (const tab of rest) {
    const k = tabMatchKey(tab);
    const key = k && keys.find((sk) => (aliases[sk] || []).includes(k));
    if (!(key && claim(tab, key))) leftover.push(tab);
  }
  rest = leftover;

  // Same-host fallback: only when it is unambiguous on both sides.
  const open = (key) =>
    !covered.has(key) || isDisposable(covered.get(key), key);
  const byHost = (items, hostOf) => {
    const m = new Map();
    for (const item of items) {
      const h = hostOf(item);
      if (!h) continue;
      if (!m.has(h)) m.set(h, []);
      m.get(h).push(item);
    }
    return m;
  };
  const keysByHost = byHost(keys, (k) => urlHost(urlByKey.get(k)));
  const tabsByHost = byHost(rest, (t) => urlHost(pickUsableUrl(t)));
  for (const [host, hostTabs] of tabsByHost) {
    const hostKeys = (keysByHost.get(host) || []).filter(open);
    if (hostTabs.length === 1 && hostKeys.length === 1) {
      claim(hostTabs[0], hostKeys[0]);
    }
  }

  // Create what is still missing, in saved order, at a sensible index.
  let slot = 0;
  let inserted = 0;
  for (const key of keys) {
    const tab = covered.get(key);
    if (tab) {
      slot = Math.max(slot, (tab.index ?? 0) + inserted + 1);
      continue;
    }
    if (pending.has(key)) continue;
    actions.push({ type: "create", url: urlByKey.get(key), key, index: slot });
    slot += 1;
    inserted += 1;
  }

  return { actions, coveredKeys: [...covered.keys()] };
}
