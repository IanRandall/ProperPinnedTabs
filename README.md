# Proper Pinned Tabs

Safari-style global pinned tabs for Brave and Chrome (Manifest V3).

Pinned tab URLs are saved in `chrome.storage.local` and kept in sync as pinned tabs in every normal browser window. Pin a tab in one window and it appears pinned in all of them; unpin or close it (while the browser is open) and it disappears from all of them. Closing a window, the last window, or quitting the browser does **not** clear the set.

Privacy: see [PRIVACY.md](PRIVACY.md).

## Install (recommended)

**Chrome Web Store** — works in Chrome and Brave:

1. Open [Proper Pinned Tabs on the Chrome Web Store](https://chromewebstore.google.com/detail/proper-pinned-tabs/ppoaagcjajlmahlocfkbcgjdoffhmpen).
2. Click **Add to Chrome** (in Brave the button may say **Add to Brave** / **Install**).
3. Confirm when prompted.

## Alternatives (developers / offline)

### GitHub release (load unpacked)

1. Download the latest `.zip` from [Releases](https://github.com/IanRandall/ProperPinnedTabs/releases/latest).
2. Unzip it (you should get a folder containing `manifest.json`).
3. Open `brave://extensions` or `chrome://extensions`.
4. Turn on **Developer mode** → **Load unpacked** → select the unzipped folder.

### From source

1. Clone or download this repository.
2. Open `brave://extensions` or `chrome://extensions` → **Developer mode** → **Load unpacked**.
3. Select this repository folder (the one that contains `manifest.json`).

## How it works

- **Pin a tab** → its URL is added to the ordered global list and the tab is pinned in **every other open window** too (live sync).
- **Unpin a tab** → the URL is removed from the list and that pin is closed in every other window. The tab you unpinned stays open.
- **Close a pinned tab** (browser still open) → the URL is removed and that pin is closed in every other window.
- **Close a window / the last window / quit the browser** → nothing is removed.
- **New window / browser restart** → saved pins are created in order in each normal window. Existing tabs are never reloaded, navigated, or closed to make this happen.
- **Navigating inside a pin** keeps it the same pin: storage does not grow and restore will not reset it. For each open pin that has navigated away from its saved URL, the extension remembers only the page it is on now (no history), so the browser-restored tab can still be recognized after a restart or extension update. That record is kept through startup. It is dropped once tab activity has been quiet for about 10 seconds, or when you pin, unpin, or close a pin — not on the startup timer.
- **Restore is conservative**: an ordinary (unpinned) tab is never pinned, and an unrelated pinned tab is never taken over. A pinned tab is matched to a saved pin only by URL, or by a remembered navigation of that pin (including a different path, when that record points at this tab). Being on the same site is not enough. Otherwise the missing pin is created and the other tab is left alone.
- **URL matching**: pins are stored exactly as pinned (scheme, port, path, query, hash). For matching, `http`/`https`, host case and a trailing slash are ignored; the port is significant (`localhost:3000` ≠ `localhost:5173`); hash routes like `#/inbox` or `#!/inbox` are significant, while plain anchors like `#section` are not. Re-pinning a URL replaces its stored entry, which also fixes entries that 1.0.x rewrote to `https`.
- Restricted URLs (`chrome://`, `brave://`, `file://`, etc.) are not saved.

## Files

| File | Role |
|------|------|
| `manifest.json` | MV3 manifest (`tabs`, `storage`, service worker) |
| `background.js` | Service worker entry point |
| `lib/controller.js` | Event handling: serial queue, tab bindings, live sync (tested with a `chrome.*` mock) |
| `lib/pin-logic.js` | Pure pin/storage/reconcile rules (unit-tested) |
| `icons/` | Extension icons |

No popup, options page, or cross-device sync.

## Tests

Requires Node 18+ (uses the built-in test runner; no install step).

```bash
npm test
```

Covers URL matching, the pin list, reconcile planning (no hijacking, no resurrection, no reload/close of navigated pins), and — via a small in-memory `chrome.*` mock in `test/chrome-mock.js` — the event handling: concurrent pins, live sync across windows, window/browser close, and worker restarts. CI runs the same command on pull requests and pushes to `main`.

## Debugging

On `brave://extensions` (or `chrome://extensions`), open **Service worker** for this extension. The console logs saved / removed pins and pins created / closed by sync, prefixed with `[Proper Pinned Tabs]`. After updating a load-unpacked build, click **Reload** on the extension card before retesting.
