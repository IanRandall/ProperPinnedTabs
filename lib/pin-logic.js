/**
 * Pure pin storage / reconcile rules for Proper Pinned Tabs.
 * Used by the service worker controller and by Node unit tests (no chrome.*).
 */

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
 * Pin locations: { [entryId]: { key, url } } — the current URL of each open
 * pinned tab that has navigated away from its saved URL, so the pin can be
 * recognized when the browser restores that tab after a restart (when tab
 * bindings are gone). One entry per open tab; no history is kept.
 *
 * Set (or clear) the entry for one tab. A tab showing its saved URL needs no
 * entry. Returns { locations, changed } without mutating the input.
 */
export function setLocation(locations, id, key, url) {
  const current = locations?.[id];
  const urlKey = normalizeUrlKey(url);
  if (!key || !urlKey || urlKey === key) {
    if (!current) return { locations, changed: false };
    const { [id]: _drop, ...rest } = locations;
    return { locations: rest, changed: true };
  }
  if (current && current.key === key && current.url === url) {
    return { locations, changed: false };
  }
  return { locations: { ...locations, [id]: { key, url } }, changed: true };
}

/**
 * Drop entries whose pin is no longer saved and, when `keepIds` is given,
 * entries that do not belong to one of those (open, bound) tabs.
 */
export function pruneLocations(locations, { savedUrls, keepIds = null } = {}) {
  const keys = new Set(dedupeUrlList(savedUrls).map(normalizeUrlKey));
  const out = {};
  let changed = false;
  for (const [id, entry] of Object.entries(locations || {})) {
    const keep =
      entry &&
      keys.has(entry.key) &&
      typeof entry.url === "string" &&
      (!keepIds || keepIds.has(id));
    if (keep) out[id] = entry;
    else changed = true;
  }
  return { locations: out, changed };
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
 * - locations: { [entryId]: { key, url } } — last known URL of pinned tabs
 *   that navigated away from their saved URL (see setLocation); only entries
 *   not belonging to a currently bound tab should be passed
 * - pendingKeys: keys whose close/unpin event is still queued; never
 *   create these (prevents resurrecting a pin the user just closed)
 * - createdTabIds: tabs the extension created this session
 *
 * Actions (in order to execute):
 * - close { tabId, key }   bound pin whose key left storage (live sync), or
 *                          an untouched copy we created that lost a race
 *                          with the browser restoring the real pin
 * - bind  { tabId, key, locationId? }  locationId: the entry that matched
 * - create { url, key, index }
 *
 * Rules (conservative — never steal or alter unrelated tabs):
 * - Unpinned tabs are never touched.
 * - An unbound pinned tab is bound only for a sound reason, in priority
 *   order: exact URL key match, the last known URL of that pin, or — after
 *   a restart, when bindings are lost — it is the *only* unbound pinned tab
 *   on the same host as the *only* missing pin for that host.
 * - Anything else stays unbound and untouched; missing pins are created.
 *   Locations live in chrome.storage.local, so they survive browser
 *   restarts and extension updates (unlike tab bindings). Unbound pinned
 *   tabs are never bound by position: that used to hijack unrelated pins.
 *   Tradeoff: a pin navigated to another site before 1.1.0 (no location
 *   recorded) is not recognized after a restart, so it is left alone and a
 *   fresh copy of the saved URL is created next to it (no work is lost).
 * - Never navigates, reloads or moves existing tabs.
 */
export function planReconcile({
  savedUrls,
  tabs = [],
  bindings = {},
  locations = {},
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

  const claim = (tab, key, locationId) => {
    const holder = covered.get(key);
    if (holder) {
      if (!isDisposable(holder, key) || holder === tab) return false;
      actions.push({ type: "close", tabId: holder.id, key });
    }
    covered.set(key, tab);
    const bind = { type: "bind", tabId: tab.id, key };
    if (locationId != null) bind.locationId = locationId;
    actions.push(bind);
    return true;
  };

  const open = (key) =>
    !covered.has(key) || isDisposable(covered.get(key), key);

  let rest = [];
  for (const tab of unbound) {
    const k = tabMatchKey(tab);
    if (!(k && savedSet.has(k) && claim(tab, k))) rest.push(tab);
  }

  const leftover = [];
  const usedLocations = new Set();
  for (const tab of rest) {
    const k = tabMatchKey(tab);
    const match =
      k &&
      Object.entries(locations || {}).find(
        ([id, e]) =>
          !usedLocations.has(id) &&
          savedSet.has(e?.key) &&
          normalizeUrlKey(e.url) === k &&
          open(e.key)
      );
    if (match && claim(tab, match[1].key, match[0])) usedLocations.add(match[0]);
    else leftover.push(tab);
  }
  rest = leftover;

  // Same-host fallback: only when it is unambiguous on both sides.
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
