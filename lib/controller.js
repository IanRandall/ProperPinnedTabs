/**
 * Event handling for Proper Pinned Tabs. Takes a `chrome` object so it can be
 * driven by a small mock in Node tests.
 *
 * Design:
 * - chrome.storage.local `pinnedUrls` is the single source of truth.
 * - Every event handler and every storage mutation runs on ONE serial queue,
 *   so read-modify-write of storage/bindings can never interleave.
 * - Bindings (tabId → pin key, in chrome.storage.session) record which tabs
 *   represent a stored pin. Tabs the extension creates are bound before their
 *   events are handled (the queue guarantees this), and tabs it closes are
 *   unbound first — so the extension's own actions are never mistaken for
 *   user pin/unpin/close, without any global "restoring" guard or timers.
 * - After any user pin/unpin/close, every normal window is reconciled with
 *   storage: missing pins are created and bound pins whose key was removed
 *   are closed (live sync).
 * - Close/unpin events are noted synchronously when they fire; until their
 *   queued handler runs, reconcile will not recreate those pins.
 */

import {
  addPinToList,
  dedupeUrlList,
  pickUsableUrl,
  planReconcile,
  pruneLocations,
  removeKeyFromList,
  setLocation,
  shouldRemoveOnTabClosed,
} from "./pin-logic.js";

export const STORAGE_KEY = "pinnedUrls";
/** Current URL of open pins that navigated away from their saved URL. */
export const LOCATIONS_KEY = "pinLocations";
/** Random id per browser session (chrome.storage.session) for location ids. */
export const SESSION_ID_KEY = "pinSessionId";
export const INITIALIZED_KEY = "pinStateInitialized";
/** v2: key format changed in 1.1.0 (port/hash kept), so old bindings are ignored. */
export const BINDINGS_KEY = "pinBindingsV2";
/** How long a vanished bound tab blocks recreating its pin (see reconcile). */
export const VANISHED_GRACE_MS = 30000;
export const DEFAULT_DELAYS = {
  /** Let the browser finish restoring its own session before filling gaps. */
  startup: [1000, 3000],
  workerStart: 1000,
  windowCreated: 400,
  pinnedTabCreated: 300,
};

export function createPinController({
  chrome,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
  log = (...args) => console.log("[Proper Pinned Tabs]", ...args),
  warn = (...args) => console.warn("[Proper Pinned Tabs]", ...args),
  delays = DEFAULT_DELAYS,
  now = () => Date.now(),
} = {}) {
  /** tabId(string) → pin key. Loaded by init(); mutated only inside tasks. */
  let bindings = {};
  let sessionId = "s";
  /** tabId(string) → when reconcile first saw its bound tab missing. */
  const vanishedAt = new Map();
  let sessionEnding = false;
  let chain = Promise.resolve();
  /** Tabs whose close / unpin event is queued but not yet handled. */
  const pendingRemoved = new Set();
  const pendingUnpinned = new Set();
  /** Tabs the extension created (may yield to a browser-restored copy). */
  const createdTabIds = new Set();
  /** User pinned a tab before it had a usable URL; save on first URL. */
  const awaitingPinUrl = new Set();
  const timers = new Map();

  function enqueue(label, fn) {
    const run = chain.then(fn).catch((err) => warn(label, "failed:", err));
    chain = run;
    return run;
  }

  /** Resolves once the queue is drained (including work queued meanwhile). */
  async function idle() {
    let seen;
    do {
      seen = chain;
      await seen;
    } while (seen !== chain);
  }

  // ---- storage (call only from inside queued tasks) ----

  async function getSaved() {
    const r = await chrome.storage.local.get(STORAGE_KEY);
    return dedupeUrlList(r[STORAGE_KEY]);
  }

  async function setSaved(list) {
    await chrome.storage.local.set({ [STORAGE_KEY]: list });
  }

  async function getLocations() {
    const r = await chrome.storage.local.get(LOCATIONS_KEY);
    const l = r[LOCATIONS_KEY];
    return l && typeof l === "object" ? l : {};
  }

  async function setLocations(locations) {
    await chrome.storage.local.set({ [LOCATIONS_KEY]: locations });
  }

  /** Tab ids restart after a browser restart, so qualify them per session. */
  function locId(tabId) {
    return `${sessionId}:${tabId}`;
  }

  async function loadSessionId() {
    try {
      const r = await chrome.storage.session.get(SESSION_ID_KEY);
      if (r[SESSION_ID_KEY]) {
        sessionId = r[SESSION_ID_KEY];
        return;
      }
      sessionId = Math.random().toString(36).slice(2, 10);
      await chrome.storage.session.set({ [SESSION_ID_KEY]: sessionId });
    } catch {
      sessionId = Math.random().toString(36).slice(2, 10);
    }
  }

  async function persistBindings() {
    try {
      await chrome.storage.session.set({ [BINDINGS_KEY]: bindings });
    } catch (err) {
      warn("session bindings write failed", err);
    }
  }

  async function loadBindings() {
    try {
      const r = await chrome.storage.session.get(BINDINGS_KEY);
      const map = r[BINDINGS_KEY];
      bindings = map && typeof map === "object" ? { ...map } : {};
    } catch {
      bindings = {};
    }
  }

  function keyOf(tabId) {
    return bindings[String(tabId)] || null;
  }

  function pendingKeys() {
    const out = [];
    for (const id of [...pendingRemoved, ...pendingUnpinned]) {
      const k = keyOf(id);
      if (k) out.push(k);
    }
    return out;
  }

  async function normalWindows() {
    try {
      return await chrome.windows.getAll({ windowTypes: ["normal"] });
    } catch {
      return [];
    }
  }

  async function browserStillOpen() {
    return !sessionEnding && (await normalWindows()).length > 0;
  }

  // ---- reconcile ----

  /**
   * Make each normal window's pinned tabs match storage. Idempotent.
   * `onlyWindowId` limits the pass to one window. With `prune`, locations
   * not belonging to an open bound pin are dropped (used once the browser
   * session is settled — after a user action or the last startup pass —
   * so restored tabs get a chance to match them first).
   */
  async function reconcile(onlyWindowId = null, { prune = false } = {}) {
    const windows = (await normalWindows()).filter(
      (w) => onlyWindowId == null || w.id === onlyWindowId
    );
    if (windows.length === 0) return;
    const saved = await getSaved();
    let locations = await getLocations();
    let locationsDirty = false;
    const allTabs = await chrome.tabs.query({});
    const live = new Set(allTabs.map((t) => String(t.id)));
    let dirty = false;
    // A bound tab that vanished usually has its onRemoved still queued (or
    // about to be delivered to a waking worker): treat its pin as pending so
    // it is not recreated, and only drop the binding after a grace period.
    const vanishedKeys = [];
    for (const [id, key] of Object.entries(bindings)) {
      if (live.has(id)) {
        vanishedAt.delete(id);
        continue;
      }
      if (!vanishedAt.has(id)) vanishedAt.set(id, now());
      if (now() - vanishedAt.get(id) > VANISHED_GRACE_MS) {
        delete bindings[id];
        vanishedAt.delete(id);
        dirty = true;
      } else {
        vanishedKeys.push(key);
      }
    }
    const blocked = () => [...pendingKeys(), ...vanishedKeys];

    const tabById = new Map(allTabs.map((t) => [t.id, t]));
    const updateLocation = (tabId, key, url) => {
      const next = setLocation(locations, locId(tabId), key, url);
      locations = next.locations;
      locationsDirty ||= next.changed;
    };

    for (const win of windows) {
      // Entries of open bound pins describe those tabs, not restorable ones.
      const ownIds = new Set(
        Object.keys(bindings).filter((id) => live.has(id)).map(locId)
      );
      const claimable = Object.fromEntries(
        Object.entries(locations).filter(([id]) => !ownIds.has(id))
      );
      const plan = planReconcile({
        savedUrls: saved,
        tabs: allTabs.filter((t) => t.windowId === win.id),
        bindings,
        locations: claimable,
        pendingKeys: blocked(),
        createdTabIds: [...createdTabIds],
      });
      for (const action of plan.actions) {
        try {
          if (action.type === "bind") {
            bindings[String(action.tabId)] = action.key;
            dirty = true;
            if (action.locationId != null) {
              const { [action.locationId]: _used, ...rest } = locations;
              locations = rest;
              locationsDirty = true;
            }
            updateLocation(
              action.tabId,
              action.key,
              pickUsableUrl(tabById.get(action.tabId))
            );
          } else if (action.type === "close") {
            updateLocation(action.tabId, null, null);
            delete bindings[String(action.tabId)];
            createdTabIds.delete(action.tabId);
            dirty = true;
            await chrome.tabs.remove(action.tabId);
            log("closed pin in window", win.id, action.key);
          } else if (action.type === "create") {
            // The user may have closed this pin elsewhere while we awaited.
            if (blocked().includes(action.key)) continue;
            const tab = await chrome.tabs.create({
              windowId: win.id,
              url: action.url,
              pinned: true,
              active: false,
              index: action.index,
            });
            if (tab?.id != null) {
              bindings[String(tab.id)] = action.key;
              createdTabIds.add(tab.id);
              dirty = true;
            }
            log("created pin in window", win.id, action.url);
          }
        } catch (err) {
          warn("reconcile action failed", action, err);
        }
      }
    }
    if (dirty) await persistBindings();

    const keepIds = prune
      ? new Set(Object.keys(bindings).filter((id) => live.has(id)).map(locId))
      : null;
    const pruned = pruneLocations(locations, { savedUrls: saved, keepIds });
    if (locationsDirty || pruned.changed) await setLocations(pruned.locations);
  }

  function scheduleReconcile(tag, windowId, ms, opts) {
    const id = `${tag}:${windowId ?? "all"}`;
    if (timers.has(id)) clearTimer(timers.get(id));
    timers.set(
      id,
      setTimer(() => {
        timers.delete(id);
        enqueue("reconcile", () => reconcile(windowId, opts));
      }, ms)
    );
  }

  // ---- user actions ----

  async function savePin(tabId, url) {
    const { list, key, changed } = addPinToList(await getSaved(), url);
    if (!key) return;
    if (changed) await setSaved(list);
    bindings[String(tabId)] = key;
    awaitingPinUrl.delete(tabId);
    await persistBindings();
    log("saved pin", url);
    await reconcile(null, { prune: true });
  }

  async function removePin(key, reason) {
    const { list, removed } = removeKeyFromList(await getSaved(), key);
    if (removed) {
      await setSaved(list);
      log("removed pin", key, `(${reason})`);
    }
    await reconcile(null, { prune: true });
  }

  async function resolveUrl(tabId, tab) {
    const url = pickUsableUrl(tab);
    if (url) return url;
    try {
      return pickUsableUrl(await chrome.tabs.get(tabId));
    } catch {
      return null;
    }
  }

  async function handlePinned(tabId, tab) {
    // Bound already: a tab we created/bound, or a pin we already know.
    if (keyOf(tabId) || sessionEnding) return;
    const url = await resolveUrl(tabId, tab);
    if (url) await savePin(tabId, url);
    else awaitingPinUrl.add(tabId);
  }

  async function handleUnpinned(tabId) {
    awaitingPinUrl.delete(tabId);
    const key = keyOf(tabId);
    if (!key) return;
    try {
      await chrome.tabs.get(tabId);
    } catch {
      // Closing a pinned tab can fire pinned→false after it is gone;
      // onRemoved decides (it knows whether the window is closing).
      return;
    }
    if (!(await browserStillOpen())) return;
    delete bindings[String(tabId)];
    await persistBindings();
    await removePin(key, "user unpin");
  }

  async function handleNavigated(tabId, changeInfo, tab) {
    if (awaitingPinUrl.has(tabId)) {
      if (!tab?.pinned) {
        awaitingPinUrl.delete(tabId);
        return;
      }
      const url = await resolveUrl(tabId, tab);
      if (url) await savePin(tabId, url);
      return;
    }
    // Navigating inside a pin never changes the saved URL; only remember
    // where this tab is now so it can be recognized after a restart.
    const key = keyOf(tabId);
    if (!key || !tab?.pinned || !changeInfo.url) return;
    const next = setLocation(await getLocations(), locId(tabId), key, changeInfo.url);
    if (next.changed) await setLocations(next.locations);
  }

  async function handleRemoved(tabId, removeInfo) {
    awaitingPinUrl.delete(tabId);
    createdTabIds.delete(tabId);
    const key = keyOf(tabId);
    if (!key) return;
    delete bindings[String(tabId)];
    await persistBindings();
    const remove = shouldRemoveOnTabClosed({
      sessionEnding,
      isWindowClosing: !!removeInfo?.isWindowClosing,
      browserStillOpen: await browserStillOpen(),
    });
    if (remove) await removePin(key, "pinned tab closed");
  }

  // ---- init ----

  async function init() {
    await loadSessionId();
    await loadBindings();
    const r = await chrome.storage.local.get([STORAGE_KEY, INITIALIZED_KEY]);
    const raw = Array.isArray(r[STORAGE_KEY]) ? r[STORAGE_KEY] : [];
    let saved = dedupeUrlList(raw);
    if (saved.length !== raw.length) await setSaved(saved);
    if (!r[INITIALIZED_KEY]) {
      // First run: adopt the user's existing pinned tabs if nothing is saved.
      if (saved.length === 0) {
        const pinned = await chrome.tabs.query({ pinned: true });
        for (const tab of pinned) {
          const url = pickUsableUrl(tab);
          const out = addPinToList(saved, url);
          if (!out.key) continue;
          saved = out.list;
          bindings[String(tab.id)] = out.key;
        }
        await setSaved(saved);
        await persistBindings();
      }
      await chrome.storage.local.set({ [INITIALIZED_KEY]: true });
    }
  }

  // ---- listeners ----

  const listeners = {
    onTabUpdated(tabId, changeInfo, tab) {
      if (changeInfo.pinned === false) pendingUnpinned.add(tabId);
      enqueue("tabs.onUpdated", async () => {
        try {
          if (changeInfo.pinned === true) await handlePinned(tabId, tab);
          else if (changeInfo.pinned === false) await handleUnpinned(tabId);
          else if (changeInfo.url || changeInfo.status === "complete") {
            await handleNavigated(tabId, changeInfo, tab);
          }
        } finally {
          if (changeInfo.pinned === false) pendingUnpinned.delete(tabId);
        }
      });
    },
    onTabRemoved(tabId, removeInfo) {
      pendingRemoved.add(tabId);
      enqueue("tabs.onRemoved", async () => {
        try {
          await handleRemoved(tabId, removeInfo);
        } finally {
          pendingRemoved.delete(tabId);
        }
      });
    },
    onTabCreated(tab) {
      if (!tab?.pinned) return;
      enqueue("tabs.onCreated", async () => {
        // A pinned tab we did not create (e.g. browser restoring a window):
        // reconcile soon so it is bound / our duplicate yields to it.
        if (!keyOf(tab.id)) {
          scheduleReconcile("tab", tab.windowId, delays.pinnedTabCreated);
        }
      });
    },
    onWindowCreated(win) {
      sessionEnding = false;
      if (win?.type && win.type !== "normal") return;
      scheduleReconcile("window", win.id, delays.windowCreated);
    },
    onWindowRemoved(windowId) {
      for (const [id, t] of timers) {
        if (id.endsWith(`:${windowId}`)) {
          clearTimer(t);
          timers.delete(id);
        }
      }
      enqueue("windows.onRemoved", async () => {
        if ((await normalWindows()).length === 0) {
          sessionEnding = true;
          log("last normal window closed; pins preserved");
        }
      });
    },
    onStartup() {
      sessionEnding = false;
      delays.startup.forEach((ms, i) =>
        scheduleReconcile(`startup${i}`, null, ms, {
          prune: i === delays.startup.length - 1,
        })
      );
    },
    onInstalled() {
      enqueue("onInstalled", () => reconcile());
    },
  };

  function start() {
    chrome.tabs.onUpdated.addListener(listeners.onTabUpdated);
    chrome.tabs.onRemoved.addListener(listeners.onTabRemoved);
    chrome.tabs.onCreated.addListener(listeners.onTabCreated);
    chrome.windows.onCreated.addListener(listeners.onWindowCreated);
    chrome.windows.onRemoved.addListener(listeners.onWindowRemoved);
    chrome.runtime.onStartup.addListener(listeners.onStartup);
    chrome.runtime.onInstalled.addListener(listeners.onInstalled);
    enqueue("init", init);
    scheduleReconcile("worker", null, delays.workerStart);
  }

  return {
    start,
    idle,
    listeners,
    /** Run reconcile on the queue (tests / manual). */
    reconcile: (windowId = null) => enqueue("reconcile", () => reconcile(windowId)),
    /** Test helper: queue a raw storage read-modify-write. */
    enqueue,
    get bindings() {
      return { ...bindings };
    },
    get sessionEnding() {
      return sessionEnding;
    },
  };
}
