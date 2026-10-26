/**
 * Proper Pinned Tabs — Safari-style global pinned tabs for Chromium/Brave.
 * Pins live in chrome.storage.local and are kept in sync across every normal
 * window. See lib/controller.js for the event handling and lib/pin-logic.js
 * for the pure rules.
 */

import { createPinController } from "./lib/controller.js";

// Listeners must be registered synchronously at service-worker start.
createPinController({ chrome }).start();
