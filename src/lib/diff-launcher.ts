/**
 * Diff window lifecycle — open/focus diff popup windows.
 * Same pattern as objectview-launcher.ts.
 */

import { log } from './logger';

const openWindows = new Map<string, number>();

export async function openDiffWindow(leftRid: string, rightRid?: string, mode?: 'template') {
  const key = `${leftRid}_${rightRid ?? ''}`;

  // Focus existing window
  const existingWinId = openWindows.get(key);
  if (existingWinId != null) {
    try {
      await chrome.windows.update(existingWinId, { focused: true });
      return;
    } catch (e) {
      log.swallow('diff:focusExisting', e);
      openWindows.delete(key);
    }
  }

  // Store context
  await chrome.storage.local.set({
    crev_diff_ctx: { leftRid, rightRid, mode },
  });

  // Open with remembered bounds
  const stored = await chrome.storage.local.get('crev_diff_bounds');
  const bounds = (stored.crev_diff_bounds ?? {}) as Record<string, number | undefined>;

  const hash = rightRid ? `${leftRid},${rightRid}` : leftRid;
  const win = await chrome.windows.create({
    type: 'popup',
    url: chrome.runtime.getURL(`diff/diff.html#${hash}`),
    width: bounds.width ?? 900,
    height: bounds.height ?? 640,
    left: bounds.left,
    top: bounds.top,
  }).catch(e => { log.swallow('diff:create', e); return null; });

  if (win?.id != null) {
    const winId = win.id;
    openWindows.set(key, winId);
    let boundsTimer: ReturnType<typeof setTimeout> | undefined;

    const onBoundsChanged = (window: chrome.windows.Window) => {
      if (window.id !== winId) return;
      if (boundsTimer) clearTimeout(boundsTimer);
      boundsTimer = setTimeout(() => {
        chrome.storage.local.set({
          crev_diff_bounds: { width: window.width, height: window.height, left: window.left, top: window.top },
        }).catch(e => log.swallow('diff:persistBounds', e));
      }, 500);
    };

    const onRemoved = (removedId: number) => {
      if (removedId !== winId) return;
      openWindows.delete(key);
      chrome.windows.onBoundsChanged.removeListener(onBoundsChanged);
      chrome.windows.onRemoved.removeListener(onRemoved);
    };

    chrome.windows.onBoundsChanged.addListener(onBoundsChanged);
    chrome.windows.onRemoved.addListener(onRemoved);
  }
}
