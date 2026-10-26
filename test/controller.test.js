import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createPinController } from "../lib/controller.js";
import { createBrowser } from "./chrome-mock.js";

const noop = () => {};

/** Browser with existing windows (pre-start), then controller started. */
async function setup({ saved, initialized = true, windows = [{}] } = {}) {
  const b = createBrowser();
  const data = b.chrome.storage.local.data;
  if (saved) data.pinnedUrls = saved;
  if (initialized) data.pinStateInitialized = true;
  const winIds = windows.map((w) => b.openWindow({ ...w, fireEvent: false }));
  const ctl = createPinController({
    chrome: b.chrome,
    setTimer: b.setTimer,
    clearTimer: b.clearTimer,
    log: noop,
    warn: noop,
  });
  ctl.start();
  await b.settle(ctl);
  return { b, ctl, winIds };
}

const tabIdByUrl = (b, windowId, url) =>
  [...b.tabs.values()].find((t) => t.windowId === windowId && t.url === url)?.id;

describe("serial storage queue (lost updates)", () => {
  it("multi-selecting and pinning several tabs at once keeps every pin", async () => {
    const { b, ctl, winIds } = await setup({
      windows: [{ urls: ["https://a.example/", "https://b.example/", "https://c.example/"] }],
    });
    const [w] = winIds;
    for (const u of ["https://a.example/", "https://b.example/", "https://c.example/"]) {
      b.pin(tabIdByUrl(b, w, u));
    }
    await b.settle(ctl);
    assert.deepEqual(b.saved, [
      "https://a.example/",
      "https://b.example/",
      "https://c.example/",
    ]);
  });

  it("queued read-modify-write tasks never interleave", async () => {
    const { b, ctl } = await setup();
    const area = b.chrome.storage.local;
    await area.set({ n: 0 });
    const bump = () =>
      ctl.enqueue("bump", async () => {
        const { n } = await area.get("n");
        await new Promise((r) => setImmediate(r));
        await area.set({ n: n + 1 });
      });
    await Promise.all(Array.from({ length: 10 }, bump));
    assert.equal(area.data.n, 10);
  });
});

describe("no global restore guard", () => {
  it("user pin right after a restore (overlapping startup passes) is recorded", async () => {
    const { b, ctl, winIds } = await setup({
      saved: ["https://a.example/"],
      windows: [{}, {}],
    });
    b.chrome.runtime.onStartup.fire();
    b.chrome.runtime.onStartup.fire();
    await b.settle(ctl);
    const id = b.openTab(winIds[1], "https://user.example/");
    b.pin(id);
    await b.settle(ctl);
    assert.deepEqual(b.saved, ["https://a.example/", "https://user.example/"]);
    assert.deepEqual(b.pinnedUrls(winIds[0]), [
      "https://a.example/",
      "https://user.example/",
    ]);
  });

  it("extension-created pins are not mistaken for user pins (no loop)", async () => {
    const { b, ctl, winIds } = await setup({
      saved: ["https://a.example/", "https://b.example/"],
      windows: [{}, {}, {}],
    });
    const count = b.tabs.size;
    await ctl.reconcile();
    await b.settle(ctl);
    assert.equal(b.tabs.size, count);
    for (const w of winIds) {
      assert.deepEqual(b.pinnedUrls(w), ["https://a.example/", "https://b.example/"]);
    }
    assert.deepEqual(b.saved, ["https://a.example/", "https://b.example/"]);
  });
});

describe("URL fidelity", () => {
  it("dev servers on different ports and http URLs are stored exactly", async () => {
    const { b, ctl, winIds } = await setup({
      windows: [{ urls: ["http://localhost:3000/", "http://localhost:5173/#/inbox"] }],
    });
    const [w] = winIds;
    b.pin(tabIdByUrl(b, w, "http://localhost:3000/"));
    b.pin(tabIdByUrl(b, w, "http://localhost:5173/#/inbox"));
    await b.settle(ctl);
    assert.deepEqual(b.saved, [
      "http://localhost:3000/",
      "http://localhost:5173/#/inbox",
    ]);
    const w2 = b.openWindow();
    await b.settle(ctl);
    assert.deepEqual(b.pinnedUrls(w2), [
      "http://localhost:3000/",
      "http://localhost:5173/#/inbox",
    ]);
  });
});

describe("live sync across windows", () => {
  it("pinning in one window pins in every other window", async () => {
    const { b, ctl, winIds } = await setup({ windows: [{}, {}, {}] });
    const id = b.openTab(winIds[0], "https://mail.example/");
    b.pin(id);
    await b.settle(ctl);
    for (const w of winIds) {
      assert.deepEqual(b.pinnedUrls(w), ["https://mail.example/"]);
    }
  });

  it("unpinning removes from storage and closes it in other windows only", async () => {
    const { b, ctl, winIds } = await setup({
      saved: ["https://a.example/", "https://b.example/"],
      windows: [{}, {}],
    });
    const [w1, w2] = winIds;
    const id = tabIdByUrl(b, w1, "https://a.example/");
    b.unpin(id);
    await b.settle(ctl);
    assert.deepEqual(b.saved, ["https://b.example/"]);
    assert.ok(b.tabs.has(id), "unpinned tab itself stays open");
    assert.deepEqual(b.pinnedUrls(w1), ["https://b.example/"]);
    assert.deepEqual(b.pinnedUrls(w2), ["https://b.example/"]);
  });

  it("closing a pinned tab closes it everywhere (also with late pinned→false)", async () => {
    const { b, ctl, winIds } = await setup({
      saved: ["https://a.example/", "https://b.example/"],
      windows: [{}, {}],
    });
    b.closeTab(tabIdByUrl(b, winIds[0], "https://a.example/"), { lateUnpin: true });
    await b.settle(ctl);
    assert.deepEqual(b.saved, ["https://b.example/"]);
    for (const w of winIds) assert.deepEqual(b.pinnedUrls(w), ["https://b.example/"]);
  });

  it("closed pins do not resurrect even if a reconcile is already queued", async () => {
    const { b, ctl, winIds } = await setup({
      saved: ["https://a.example/"],
      windows: [{}, {}],
    });
    b.chrome.runtime.onStartup.fire();
    const id = tabIdByUrl(b, winIds[0], "https://a.example/");
    // Close happens while a reconcile is queued ahead of the close handler.
    ctl.reconcile();
    b.closeTab(id);
    await b.settle(ctl);
    assert.deepEqual(b.saved, []);
    for (const w of winIds) assert.deepEqual(b.pinnedUrls(w), []);
  });

  it("a close delivered to a freshly woken worker still removes the pin", async () => {
    const { b, ctl, winIds } = await setup({
      saved: ["https://a.example/"],
      windows: [{}, {}],
    });
    await b.settle(ctl);
    // Worker is asleep when the user closes the pin; the close event is
    // delivered to a freshly started worker, racing its startup reconcile.
    b.killWorker();
    const id = tabIdByUrl(b, winIds[0], "https://a.example/");
    b.removeSilently(id);
    const ctl2 = createPinController({
      chrome: b.chrome,
      setTimer: b.setTimer,
      clearTimer: b.clearTimer,
      log: noop,
      warn: noop,
    });
    ctl2.start();
    ctl2.reconcile();
    setImmediate(() => b.chrome.tabs.onRemoved.fire(id, { isWindowClosing: false }));
    await b.settle(ctl2);
    assert.deepEqual(b.saved, []);
    for (const w of winIds) assert.deepEqual(b.pinnedUrls(w), []);
  });

  it("closing a window or the last window preserves pins; reopen restores", async () => {
    const { b, ctl, winIds } = await setup({
      saved: ["https://a.example/"],
      windows: [{}, {}],
    });
    b.closeWindow(winIds[0]);
    await b.settle(ctl);
    assert.deepEqual(b.saved, ["https://a.example/"]);
    assert.deepEqual(b.pinnedUrls(winIds[1]), ["https://a.example/"]);
    b.closeWindow(winIds[1]);
    await b.settle(ctl);
    assert.equal(ctl.sessionEnding, true);
    assert.deepEqual(b.saved, ["https://a.example/"]);
    const w = b.openWindow();
    await b.settle(ctl);
    assert.deepEqual(b.pinnedUrls(w), ["https://a.example/"]);
  });

  it("navigating inside a pin neither grows storage nor reloads/closes it", async () => {
    const { b, ctl, winIds } = await setup({
      saved: ["https://a.example/"],
      windows: [{}, {}],
    });
    const id = tabIdByUrl(b, winIds[0], "https://a.example/");
    b.navigate(id, "https://a.example/deep/page");
    b.navigate(id, "https://other.example/");
    await b.settle(ctl);
    await ctl.reconcile();
    await b.settle(ctl);
    assert.deepEqual(b.saved, ["https://a.example/"]);
    assert.equal(b.tabs.get(id).url, "https://other.example/");
    assert.deepEqual(b.pinnedUrls(winIds[1]), ["https://a.example/"]);
  });

  it("pinning a new tab (no URL yet) saves once it gets a URL", async () => {
    const { b, ctl, winIds } = await setup({ windows: [{}, {}] });
    const id = b.openTab(winIds[0], "chrome://newtab/");
    b.pin(id);
    await b.settle(ctl);
    assert.deepEqual(b.saved, []);
    b.navigate(id, "https://late.example/");
    await b.settle(ctl);
    assert.deepEqual(b.saved, ["https://late.example/"]);
    assert.deepEqual(b.pinnedUrls(winIds[1]), ["https://late.example/"]);
  });
});

describe("conservative restore", () => {
  it("does not pin an ordinary unpinned tab with a saved URL", async () => {
    const { b, winIds } = await setup({
      saved: ["https://a.example/"],
      windows: [{ urls: ["https://a.example/"] }],
    });
    const tabs = [...b.tabs.values()].filter((t) => t.windowId === winIds[0]);
    assert.equal(tabs.filter((t) => !t.pinned && t.url === "https://a.example/").length, 1);
    assert.deepEqual(b.pinnedUrls(winIds[0]), ["https://a.example/"]);
  });

  it("does not hijack an unrelated pinned tab; creates the saved pin", async () => {
    const { b, ctl, winIds } = await setup({
      saved: ["https://a.example/"],
      windows: [{ pinnedUrls: ["https://unrelated.example/"] }],
    });
    assert.deepEqual(b.pinnedUrls(winIds[0]).sort(), [
      "https://a.example/",
      "https://unrelated.example/",
    ]);
    // The unrelated pin is not bound, so closing it leaves storage alone.
    b.closeTab(tabIdByUrl(b, winIds[0], "https://unrelated.example/"));
    await b.settle(ctl);
    assert.deepEqual(b.saved, ["https://a.example/"]);
  });

  it("recognizes a navigated pin restored by the browser after restart", async () => {
    const { b, ctl, winIds } = await setup({
      saved: ["https://a.example/"],
      windows: [{}],
    });
    const id = tabIdByUrl(b, winIds[0], "https://a.example/");
    b.navigate(id, "https://elsewhere.example/work");
    await b.settle(ctl);

    // Restart: session bindings are lost, browser restores the navigated pin.
    const b2 = createBrowser();
    Object.assign(b2.chrome.storage.local.data, structuredClone(b.chrome.storage.local.data));
    const w = b2.openWindow({ pinnedUrls: ["https://elsewhere.example/work"], fireEvent: false });
    const ctl2 = createPinController({
      chrome: b2.chrome,
      setTimer: b2.setTimer,
      clearTimer: b2.clearTimer,
      log: noop,
      warn: noop,
    });
    ctl2.start();
    b2.chrome.runtime.onStartup.fire();
    await b2.settle(ctl2);
    assert.deepEqual(b2.pinnedUrls(w), ["https://elsewhere.example/work"]);
    assert.ok(Object.values(ctl2.bindings).includes("a.example/"));
    // The old entry was claimed and re-keyed to the restored tab: still one.
    const entries = Object.values(b2.chrome.storage.local.data.pinLocations);
    assert.deepEqual(entries, [{ key: "a.example/", url: "https://elsewhere.example/work" }]);
  });

  it("locations of pins that were not restored are pruned after startup", async () => {
    const b = createBrowser();
    Object.assign(b.chrome.storage.local.data, {
      pinStateInitialized: true,
      pinnedUrls: ["https://a.example/"],
      pinLocations: { "old:5": { key: "a.example/", url: "https://gone.example/" } },
    });
    const w = b.openWindow({ fireEvent: false });
    const ctl = createPinController({
      chrome: b.chrome,
      setTimer: b.setTimer,
      clearTimer: b.clearTimer,
      log: noop,
      warn: noop,
    });
    ctl.start();
    b.chrome.runtime.onStartup.fire();
    await b.settle(ctl);
    assert.deepEqual(b.pinnedUrls(w), ["https://a.example/"]);
    assert.deepEqual(b.chrome.storage.local.data.pinLocations, {});
  });

  it("stores only the current URL of navigated pins, never history", async () => {
    const { b, ctl, winIds } = await setup({
      saved: ["https://a.example/"],
      windows: [{}, {}],
    });
    const [w1, w2] = winIds;
    const t1 = tabIdByUrl(b, w1, "https://a.example/");
    const t2 = tabIdByUrl(b, w2, "https://a.example/");
    for (const u of ["https://x.example/1", "https://x.example/2", "https://x.example/3"]) {
      b.navigate(t1, u);
    }
    b.navigate(t2, "https://y.example/");
    await b.settle(ctl);
    const urls = () =>
      Object.values(b.chrome.storage.local.data.pinLocations || {}).map((e) => e.url).sort();
    assert.deepEqual(urls(), ["https://x.example/3", "https://y.example/"]);

    b.navigate(t2, "https://a.example/");
    await b.settle(ctl);
    assert.deepEqual(urls(), ["https://x.example/3"]);

    b.unpin(t1);
    await b.settle(ctl);
    assert.deepEqual(urls(), []);
  });

  it("extension update (session storage wiped) re-recognizes navigated pins", async () => {
    const { b, ctl, winIds } = await setup({
      saved: ["https://a.example/"],
      windows: [{}],
    });
    const id = tabIdByUrl(b, winIds[0], "https://a.example/");
    b.navigate(id, "https://elsewhere.example/");
    await b.settle(ctl);
    b.killWorker();
    for (const k of Object.keys(b.chrome.storage.session.data)) {
      delete b.chrome.storage.session.data[k];
    }
    const ctl2 = createPinController({
      chrome: b.chrome,
      setTimer: b.setTimer,
      clearTimer: b.clearTimer,
      log: noop,
      warn: noop,
    });
    ctl2.start();
    b.chrome.runtime.onInstalled.fire({ reason: "update" });
    await b.settle(ctl2);
    assert.deepEqual(b.pinnedUrls(winIds[0]), ["https://elsewhere.example/"]);
    assert.deepEqual(ctl2.bindings, { [id]: "a.example/" });
    assert.equal(Object.keys(b.chrome.storage.local.data.pinLocations).length, 1);
  });

  it("our early copy yields when the browser restores the real pin late", async () => {
    const { b, ctl, winIds } = await setup({
      saved: ["https://a.example/"],
      windows: [{}],
    });
    // A window reopened (e.g. Ctrl+Shift+T): we create a pin first...
    const w = b.openWindow();
    await b.settle(ctl);
    assert.deepEqual(b.pinnedUrls(w), ["https://a.example/"]);
    // ...then the browser restores the original, navigated-on-same-host pin.
    b.openTab(w, "https://a.example/inbox/42", { pinned: true });
    await b.settle(ctl);
    assert.deepEqual(b.pinnedUrls(w), ["https://a.example/inbox/42"]);
    assert.deepEqual(b.pinnedUrls(winIds[0]), ["https://a.example/"]);
    assert.deepEqual(b.saved, ["https://a.example/"]);
  });
});

describe("first run", () => {
  it("adopts existing pinned tabs once when nothing is saved", async () => {
    const { b, winIds } = await setup({
      initialized: false,
      windows: [{ pinnedUrls: ["https://x.example/"] }, {}],
    });
    assert.deepEqual(b.saved, ["https://x.example/"]);
    assert.deepEqual(b.pinnedUrls(winIds[1]), ["https://x.example/"]);
  });

  it("does not backfill again after the user removed every pin", async () => {
    const { b } = await setup({
      saved: [],
      windows: [{ pinnedUrls: ["https://x.example/"] }],
    });
    assert.deepEqual(b.saved, []);
  });
});
