# Privacy Policy — Proper Pinned Tabs

**Proper Pinned Tabs** is a browser extension that restores your pinned tabs across windows and sessions.

## What we store

- The **URLs** of tabs you pin, in the order you pinned them.
- For each pin, the **last few (at most 5) URLs** that pinned tab navigated to, so the extension can still recognize the pin after a browser restart. These are deleted when you remove the pin.

This data is saved in `chrome.storage.local` on **your browser profile** on this device. Which open tab belongs to which pin is kept in `chrome.storage.session` and cleared when the browser closes.

We do **not** store page content, browsing history outside pinned tabs, cookies, passwords, or personal account information.

## How we use it

The saved URLs are used **only** to keep your pinned tabs the same in every window and to re-create them when you open a new window or restart the browser.

## What we don’t do

- No servers or remote storage  
- No analytics or tracking  
- No ads  
- No user accounts  
- No selling or transferring your data to anyone  
- No cross-device sync (data does not leave this browser profile)

## Where data lives / how it’s cleared

Your pin list stays on your device. It is updated when you pin, unpin, or close a pinned tab (while the browser is still open). Uninstalling the extension removes its local storage.

## Contact

Questions or concerns: open an issue at  
https://github.com/IanRandall/ProperPinnedTabs/issues
