import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  addPinToList,
  dedupeUrlList,
  isRestrictedUrl,
  normalizeUrlKey,
  planReconcile,
  pruneLocations,
  removeKeyFromList,
  setLocation,
  shouldRemoveOnTabClosed,
} from "../lib/pin-logic.js";

const types = (plan, type) => plan.actions.filter((a) => a.type === type);

describe("normalizeUrlKey", () => {
  it("keeps the port so dev servers do not collide", () => {
    assert.notEqual(
      normalizeUrlKey("http://localhost:3000/"),
      normalizeUrlKey("http://localhost:5173/")
    );
  });

  it("treats http/https, host case and trailing slash as the same pin", () => {
    assert.equal(
      normalizeUrlKey("https://Example.com/foo/"),
      normalizeUrlKey("http://example.com/foo")
    );
  });

  it("keeps SPA hash routes but ignores plain anchors", () => {
    assert.notEqual(
      normalizeUrlKey("https://app.example/#/inbox"),
      normalizeUrlKey("https://app.example/#/calendar")
    );
    assert.notEqual(
      normalizeUrlKey("https://app.example/#!/a"),
      normalizeUrlKey("https://app.example/")
    );
    assert.equal(
      normalizeUrlKey("https://docs.example/page#section"),
      normalizeUrlKey("https://docs.example/page")
    );
  });

  it("keeps the query string", () => {
    assert.notEqual(
      normalizeUrlKey("https://x.example/?a=1"),
      normalizeUrlKey("https://x.example/?a=2")
    );
  });

  it("rejects restricted URLs", () => {
    for (const u of ["chrome://settings", "brave://extensions", "about:blank", "file:///x"]) {
      assert.equal(isRestrictedUrl(u), true);
      assert.equal(normalizeUrlKey(u), null);
    }
    assert.equal(isRestrictedUrl("https://example.com"), false);
  });
});

describe("stored pin list", () => {
  it("stores the exact URL (no https rewrite, port and hash kept)", () => {
    const { list } = addPinToList([], "http://router.local:8080/#/status");
    assert.deepEqual(list, ["http://router.local:8080/#/status"]);
  });

  it("re-pinning the same pin does not grow the list", () => {
    let { list } = addPinToList([], "https://a.example/");
    ({ list } = addPinToList(list, "https://a.example"));
    assert.equal(list.length, 1);
  });

  it("re-pinning replaces a legacy https-rewritten entry in place", () => {
    const out = addPinToList(
      ["https://first.example/", "https://localhost:3000", "https://z.example/"],
      "http://localhost:3000/"
    );
    assert.equal(out.changed, true);
    assert.deepEqual(out.list, [
      "https://first.example/",
      "http://localhost:3000/",
      "https://z.example/",
    ]);
  });

  it("legacy entries keep matching their sites", () => {
    // 1.0.x stored "https://mlh.com/" for a pin of "http://mlh.com".
    assert.equal(normalizeUrlKey("https://mlh.com/"), normalizeUrlKey("http://mlh.com"));
  });

  it("dedupe keeps first entry verbatim and drops restricted ones", () => {
    assert.deepEqual(
      dedupeUrlList(["http://mlh.com/", "https://mlh.com", "chrome://newtab", "https://b.example/x"]),
      ["http://mlh.com/", "https://b.example/x"]
    );
  });

  it("removeKeyFromList removes by key", () => {
    const out = removeKeyFromList(["https://a.example/", "https://b.example/"], "a.example/");
    assert.equal(out.removed, true);
    assert.deepEqual(out.list, ["https://b.example/"]);
  });

  it("locations keep one current URL per tab and nothing for unmoved pins", () => {
    let { locations } = setLocation({}, "s:1", "a.example/", "https://other.example/x");
    ({ locations } = setLocation(locations, "s:1", "a.example/", "https://other.example/y"));
    assert.deepEqual(locations, {
      "s:1": { key: "a.example/", url: "https://other.example/y" },
    });
    // Back on the saved URL (or a restricted page): entry is dropped.
    assert.deepEqual(setLocation(locations, "s:1", "a.example/", "https://a.example").locations, {});
    assert.deepEqual(setLocation(locations, "s:1", "a.example/", "chrome://newtab").locations, {});
    assert.equal(setLocation({}, "s:1", "a.example/", "https://a.example/").changed, false);
  });

  it("pruneLocations drops removed pins and, if asked, tabs not kept", () => {
    const locations = {
      "s:1": { key: "a.example/", url: "https://x.example/" },
      "s:2": { key: "gone.example/", url: "https://y.example/" },
      "old:7": { key: "a.example/", url: "https://z.example/" },
    };
    const saved = ["https://a.example/"];
    assert.deepEqual(Object.keys(pruneLocations(locations, { savedUrls: saved }).locations), [
      "s:1",
      "old:7",
    ]);
    assert.deepEqual(
      Object.keys(pruneLocations(locations, { savedUrls: saved, keepIds: new Set(["s:1"]) }).locations),
      ["s:1"]
    );
  });
});

describe("shouldRemoveOnTabClosed", () => {
  it("removes only for a plain close while the browser is open", () => {
    assert.equal(shouldRemoveOnTabClosed({ browserStillOpen: true }), true);
    assert.equal(shouldRemoveOnTabClosed({ isWindowClosing: true }), false);
    assert.equal(shouldRemoveOnTabClosed({ sessionEnding: true }), false);
    assert.equal(shouldRemoveOnTabClosed({ browserStillOpen: false }), false);
  });
});

describe("planReconcile", () => {
  it("creates missing pins in saved order in an empty window", () => {
    const plan = planReconcile({
      savedUrls: ["https://a.example/", "http://localhost:3000/", "https://c.example/"],
      tabs: [{ id: 1, pinned: false, url: "https://new.example/", index: 0 }],
    });
    assert.deepEqual(
      types(plan, "create").map((a) => [a.url, a.index]),
      [
        ["https://a.example/", 0],
        ["http://localhost:3000/", 1],
        ["https://c.example/", 2],
      ]
    );
  });

  it("is idempotent when bound pins cover storage (even if navigated)", () => {
    const plan = planReconcile({
      savedUrls: ["https://a.example/", "https://b.example/"],
      bindings: { 1: "a.example/", 2: "b.example/" },
      tabs: [
        { id: 1, pinned: true, url: "https://elsewhere.example/", index: 0 },
        { id: 2, pinned: true, url: "https://b.example/deep", index: 1 },
      ],
    });
    assert.deepEqual(plan.actions, []);
  });

  it("closes bound pins whose key left storage (live sync)", () => {
    const plan = planReconcile({
      savedUrls: ["https://b.example/"],
      bindings: { 1: "a.example/", 2: "b.example/" },
      tabs: [
        { id: 1, pinned: true, url: "https://a.example/", index: 0 },
        { id: 2, pinned: true, url: "https://b.example/", index: 1 },
      ],
    });
    assert.deepEqual(plan.actions, [{ type: "close", tabId: 1, key: "a.example/" }]);
  });

  it("never creates or closes keys whose close/unpin is still pending", () => {
    const plan = planReconcile({
      savedUrls: ["https://a.example/"],
      bindings: { 1: "gone.example/" },
      tabs: [{ id: 1, pinned: true, url: "https://gone.example/", index: 0 }],
      pendingKeys: ["a.example/", "gone.example/"],
    });
    assert.deepEqual(plan.actions, []);
  });

  it("never touches unpinned tabs, even if their URL is saved", () => {
    const plan = planReconcile({
      savedUrls: ["https://a.example/"],
      tabs: [{ id: 5, pinned: false, url: "https://a.example/", index: 0 }],
    });
    assert.deepEqual(plan.actions.map((a) => a.type), ["create"]);
  });

  it("binds unbound pinned tabs by exact URL", () => {
    const plan = planReconcile({
      savedUrls: ["https://a.example/"],
      tabs: [{ id: 3, pinned: true, url: "http://a.example", index: 0 }],
    });
    assert.deepEqual(plan.actions, [{ type: "bind", tabId: 3, key: "a.example/" }]);
  });

  it("does not steal an unrelated pinned tab when counts match", () => {
    const plan = planReconcile({
      savedUrls: ["https://a.example/"],
      tabs: [{ id: 3, pinned: true, url: "https://unrelated.example/", index: 0 }],
    });
    assert.deepEqual(plan.actions.map((a) => a.type), ["create"]);
  });

  it("binds a navigated pin by its last known location", () => {
    const plan = planReconcile({
      savedUrls: ["https://a.example/"],
      locations: { "old:4": { key: "a.example/", url: "https://other.example/work" } },
      tabs: [{ id: 3, pinned: true, url: "https://other.example/work", index: 0 }],
    });
    assert.deepEqual(plan.actions, [
      { type: "bind", tabId: 3, key: "a.example/", locationId: "old:4" },
    ]);
  });

  it("each location is claimed by at least one tab, never a covered pin", () => {
    const plan = planReconcile({
      savedUrls: ["https://a.example/"],
      bindings: { 1: "a.example/" },
      locations: { "old:4": { key: "a.example/", url: "https://other.example/" } },
      tabs: [
        { id: 1, pinned: true, url: "https://a.example/", index: 0 },
        { id: 3, pinned: true, url: "https://other.example/", index: 1 },
      ],
    });
    assert.deepEqual(plan.actions, []);
  });

  it("binds by host only when unambiguous on both sides", () => {
    const one = planReconcile({
      savedUrls: ["https://a.example/"],
      tabs: [{ id: 3, pinned: true, url: "https://a.example/deep", index: 0 }],
    });
    assert.deepEqual(one.actions, [{ type: "bind", tabId: 3, key: "a.example/" }]);

    const twoKeys = planReconcile({
      savedUrls: ["https://a.example/x", "https://a.example/y"],
      tabs: [{ id: 3, pinned: true, url: "https://a.example/deep", index: 0 }],
    });
    assert.equal(types(twoKeys, "bind").length, 0);
    assert.equal(types(twoKeys, "create").length, 2);

    const twoTabs = planReconcile({
      savedUrls: ["https://a.example/"],
      tabs: [
        { id: 3, pinned: true, url: "https://a.example/1", index: 0 },
        { id: 4, pinned: true, url: "https://a.example/2", index: 1 },
      ],
    });
    assert.equal(types(twoTabs, "bind").length, 0);
  });

  it("an untouched copy we created yields to a restored real pin", () => {
    const plan = planReconcile({
      savedUrls: ["https://a.example/"],
      bindings: { 9: "a.example/" },
      createdTabIds: [9],
      tabs: [
        { id: 9, pinned: true, url: "https://a.example/", index: 0 },
        { id: 3, pinned: true, url: "https://a.example/inbox", index: 1 },
      ],
    });
    assert.deepEqual(plan.actions, [
      { type: "close", tabId: 9, key: "a.example/" },
      { type: "bind", tabId: 3, key: "a.example/" },
    ]);
  });

  it("a created copy the user navigated is never closed as a duplicate", () => {
    const plan = planReconcile({
      savedUrls: ["https://a.example/"],
      bindings: { 9: "a.example/" },
      createdTabIds: [9],
      tabs: [
        { id: 9, pinned: true, url: "https://a.example/working", index: 0 },
        { id: 3, pinned: true, url: "https://a.example/", index: 1 },
      ],
    });
    assert.deepEqual(plan.actions, []);
  });

  it("skips restricted saved entries", () => {
    const plan = planReconcile({
      savedUrls: ["chrome://settings", "https://ok.example/"],
      tabs: [],
    });
    assert.deepEqual(types(plan, "create").map((a) => a.url), ["https://ok.example/"]);
  });
});
