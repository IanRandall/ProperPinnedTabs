/**
 * Minimal in-memory chrome.* mock for driving lib/controller.js in Node.
 * Events are dispatched asynchronously (like the browser), and timers are
 * virtual so tests run instantly.
 */

function makeEvent() {
  let fns = [];
  return {
    addListener: (fn) => fns.push(fn),
    fire: (...args) => fns.forEach((fn) => fn(...args)),
    clear: () => (fns = []),
  };
}

function makeArea() {
  const data = {};
  return {
    data,
    async get(keys) {
      await Promise.resolve();
      const list = keys == null ? Object.keys(data) : [].concat(keys);
      const out = {};
      for (const k of list) {
        if (k in data) out[k] = structuredClone(data[k]);
      }
      return out;
    },
    async set(obj) {
      await Promise.resolve();
      for (const [k, v] of Object.entries(obj)) data[k] = structuredClone(v);
    },
  };
}

const tick = () => new Promise((r) => setImmediate(r));

export function createBrowser() {
  let nextId = 1;
  const windows = new Map(); // id → { id, type }
  const tabs = new Map(); // id → tab
  const timers = [];
  let now = 0;

  const events = {
    tabs: {
      onUpdated: makeEvent(),
      onRemoved: makeEvent(),
      onCreated: makeEvent(),
    },
    windows: { onCreated: makeEvent(), onRemoved: makeEvent() },
    runtime: { onStartup: makeEvent(), onInstalled: makeEvent() },
  };

  const later = (fn) => setImmediate(fn);
  const snapshot = (t) => ({ ...t });

  function windowTabs(windowId) {
    return [...tabs.values()]
      .filter((t) => t.windowId === windowId)
      .sort((a, b) => a.index - b.index);
  }

  function reindex(windowId) {
    const list = windowTabs(windowId);
    const pinned = list.filter((t) => t.pinned);
    const rest = list.filter((t) => !t.pinned);
    [...pinned, ...rest].forEach((t, i) => (t.index = i));
  }

  function insertTab({ windowId, url, pinned = false, index }) {
    const list = windowTabs(windowId);
    const tab = {
      id: nextId++,
      windowId,
      url,
      pinned,
      index: index ?? list.length,
    };
    for (const t of list) if (t.index >= tab.index) t.index += 1;
    tabs.set(tab.id, tab);
    reindex(windowId);
    return tab;
  }

  function removeTab(id, isWindowClosing) {
    const tab = tabs.get(id);
    if (!tab) throw new Error(`No tab with id: ${id}`);
    tabs.delete(id);
    reindex(tab.windowId);
    later(() =>
      events.tabs.onRemoved.fire(id, { windowId: tab.windowId, isWindowClosing })
    );
  }

  const chrome = {
    storage: { local: makeArea(), session: makeArea() },
    tabs: {
      ...events.tabs,
      async get(id) {
        const t = tabs.get(id);
        if (!t) throw new Error(`No tab with id: ${id}`);
        return snapshot(t);
      },
      async query(q = {}) {
        return [...tabs.values()]
          .filter((t) => q.windowId == null || t.windowId === q.windowId)
          .filter((t) => q.pinned == null || t.pinned === q.pinned)
          .map(snapshot);
      },
      async create({ windowId, url, pinned, index }) {
        if (!windows.has(windowId)) throw new Error("No window");
        const tab = insertTab({ windowId, url, pinned, index });
        const snap = snapshot(tab);
        later(() => events.tabs.onCreated.fire(snap));
        return snap;
      },
      async remove(id) {
        removeTab(id, false);
      },
      async update(id, props) {
        const t = tabs.get(id);
        if (!t) throw new Error(`No tab with id: ${id}`);
        Object.assign(t, props);
        return snapshot(t);
      },
    },
    windows: {
      ...events.windows,
      async getAll() {
        return [...windows.values()].filter((w) => w.type === "normal");
      },
      async get(id) {
        const w = windows.get(id);
        if (!w) throw new Error("No window");
        return { ...w };
      },
    },
    runtime: { ...events.runtime },
  };

  const browser = {
    chrome,
    tabs,
    windows,
    timers,
    /** Service worker dies: drop its listeners and pending timers. */
    killWorker() {
      for (const group of Object.values(events)) {
        for (const ev of Object.values(group)) ev.clear();
      }
      for (const t of timers) t.cancelled = true;
    },
    /** Remove a tab without delivering onRemoved yet (worker asleep). */
    removeSilently(id) {
      const t = tabs.get(id);
      tabs.delete(id);
      reindex(t.windowId);
    },
    setTimer(fn, ms) {
      const t = { at: now + ms, fn, cancelled: false };
      timers.push(t);
      return t;
    },
    clearTimer(t) {
      if (t) t.cancelled = true;
    },

    /** Drain events, the controller queue and all virtual timers. */
    async settle(ctl) {
      for (let guard = 0; guard < 200; guard++) {
        for (let i = 0; i < 5; i++) await tick();
        if (ctl) await ctl.idle();
        for (let i = 0; i < 5; i++) await tick();
        const due = timers
          .filter((t) => !t.cancelled)
          .sort((a, b) => a.at - b.at)[0];
        if (!due) {
          if (ctl) await ctl.idle();
          return;
        }
        due.cancelled = true;
        now = Math.max(now, due.at);
        due.fn();
      }
      throw new Error("settle: did not converge");
    },

    // ---- user actions (fire events like the browser does) ----

    openWindow({ urls = ["https://newtab.example/"], pinnedUrls = [], fireEvent = true } = {}) {
      const win = { id: 1000 + nextId++, type: "normal" };
      windows.set(win.id, win);
      if (fireEvent) later(() => events.windows.onCreated.fire({ ...win }));
      for (const url of pinnedUrls) browser.openTab(win.id, url, { pinned: true });
      for (const url of urls) insertTab({ windowId: win.id, url });
      return win.id;
    },
    openTab(windowId, url, { pinned = false } = {}) {
      const tab = insertTab({ windowId, url, pinned });
      const snap = snapshot(tab);
      later(() => events.tabs.onCreated.fire(snap));
      return tab.id;
    },
    pin(id) {
      const t = tabs.get(id);
      t.pinned = true;
      reindex(t.windowId);
      const snap = snapshot(t);
      later(() => events.tabs.onUpdated.fire(id, { pinned: true }, snap));
    },
    unpin(id) {
      const t = tabs.get(id);
      t.pinned = false;
      reindex(t.windowId);
      const snap = snapshot(t);
      later(() => events.tabs.onUpdated.fire(id, { pinned: false }, snap));
    },
    navigate(id, url) {
      const t = tabs.get(id);
      t.url = url;
      const snap = snapshot(t);
      later(() => events.tabs.onUpdated.fire(id, { url }, snap));
    },
    /** Close a tab; optionally also fire the late pinned→false Chrome sends. */
    closeTab(id, { lateUnpin = false } = {}) {
      const t = tabs.get(id);
      const snap = { ...snapshot(t), pinned: false };
      removeTab(id, false);
      if (lateUnpin) {
        later(() => events.tabs.onUpdated.fire(id, { pinned: false }, snap));
      }
    },
    closeWindow(windowId) {
      for (const t of windowTabs(windowId)) removeTab(t.id, true);
      windows.delete(windowId);
      later(() => events.windows.onRemoved.fire(windowId));
    },
    /** Pinned tabs in a window as [url…] in index order. */
    pinnedUrls(windowId) {
      return windowTabs(windowId)
        .filter((t) => t.pinned)
        .map((t) => t.url);
    },
    get saved() {
      return chrome.storage.local.data.pinnedUrls || [];
    },
  };
  return browser;
}
