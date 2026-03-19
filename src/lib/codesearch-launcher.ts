/**
 * Code Search window lifecycle — open/focus search popup windows.
 */

import { log } from './logger';

let searchWindowId: number | null = null;

export async function openCodeSearchWindow() {
  // Focus existing window
  if (searchWindowId != null) {
    try {
      await chrome.windows.update(searchWindowId, { focused: true });
      return;
    } catch (e) {
      log.swallow('codesearch:focusExisting', e);
      searchWindowId = null;
    }
  }

  const stored = await chrome.storage.local.get('crev_codesearch_bounds');
  const bounds = (stored.crev_codesearch_bounds ?? {}) as Record<string, number | undefined>;

  const win = await chrome.windows.create({
    type: 'popup',
    url: chrome.runtime.getURL('codesearch/codesearch.html'),
    width: bounds.width ?? 800,
    height: bounds.height ?? 600,
    left: bounds.left,
    top: bounds.top,
  });

  if (win?.id != null) {
    searchWindowId = win.id;
    let boundsTimer: ReturnType<typeof setTimeout> | undefined;

    const onBoundsChanged = (window: chrome.windows.Window) => {
      if (window.id !== searchWindowId) return;
      if (boundsTimer) clearTimeout(boundsTimer);
      boundsTimer = setTimeout(() => {
        chrome.storage.local.set({
          crev_codesearch_bounds: { width: window.width, height: window.height, left: window.left, top: window.top },
        }).catch(e => log.swallow('codesearch:persistBounds', e));
      }, 500);
    };

    const onRemoved = (removedId: number) => {
      if (removedId !== searchWindowId) return;
      searchWindowId = null;
      chrome.windows.onBoundsChanged.removeListener(onBoundsChanged);
      chrome.windows.onRemoved.removeListener(onRemoved);
    };

    chrome.windows.onBoundsChanged.addListener(onBoundsChanged);
    chrome.windows.onRemoved.addListener(onRemoved);
  }
}
