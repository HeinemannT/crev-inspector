/**
 * Object View window lifecycle — open/focus popup windows showing full object details.
 * Same pattern as editor.ts: per-RID context storage, window tracking, bounds persistence.
 */

import { getCtx } from './sw-context';
import { log } from './logger';

/** Track open Object View windows by RID to prevent duplicates */
const openWindows = new Map<string, number>();

export async function openObjectViewWindow(rid: string) {
  const ctx = getCtx();
  await ctx.settingsReady;

  // Gather basic identity from cache
  const cached = ctx.cache.get(rid);
  const name = cached?.name ?? '';
  const type = cached?.type ?? '';
  const businessId = cached?.businessId ?? '';

  // Focus existing window for this RID
  const existingWinId = openWindows.get(rid);
  if (existingWinId != null) {
    try {
      await chrome.windows.update(existingWinId, { focused: true });
      return;
    } catch (e) {
      log.swallow('objectview:focusExisting', e);
      openWindows.delete(rid);
    }
  }

  // Store context for the page to read
  await chrome.storage.local.set({
    [`crev_objectview_ctx_${rid}`]: { rid, name, type, businessId },
  });

  // Open with remembered bounds
  const stored = await chrome.storage.local.get('crev_objectview_bounds');
  const bounds = (stored.crev_objectview_bounds ?? {}) as Record<string, number | undefined>;

  const win = await chrome.windows.create({
    type: 'popup',
    url: chrome.runtime.getURL(`objectview/objectview.html#${rid}`),
    width: bounds.width ?? 560,
    height: bounds.height ?? 640,
    left: bounds.left,
    top: bounds.top,
  }).catch(e => { log.swallow('objectview:create', e); return null; });

  if (win?.id != null) {
    const winId = win.id;
    openWindows.set(rid, winId);
    let boundsTimer: ReturnType<typeof setTimeout> | undefined;

    const onBoundsChanged = (window: chrome.windows.Window) => {
      if (window.id !== winId) return;
      if (boundsTimer) clearTimeout(boundsTimer);
      boundsTimer = setTimeout(() => {
        chrome.storage.local.set({
          crev_objectview_bounds: { width: window.width, height: window.height, left: window.left, top: window.top },
        }).catch(e => log.swallow('objectview:persistBounds', e));
      }, 500);
    };

    const onRemoved = (removedId: number) => {
      if (removedId !== winId) return;
      openWindows.delete(rid);
      chrome.storage.local.remove(`crev_objectview_ctx_${rid}`).catch(e => log.swallow('objectview:cleanupCtx', e));
      chrome.windows.onBoundsChanged.removeListener(onBoundsChanged);
      chrome.windows.onRemoved.removeListener(onRemoved);
    };

    chrome.windows.onBoundsChanged.addListener(onBoundsChanged);
    chrome.windows.onRemoved.addListener(onRemoved);
  }
}
