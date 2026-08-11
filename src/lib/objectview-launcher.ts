/**
 * Object View overlay launcher — mounts objectview/objectview.html as an
 * in-page frame on the active tab.
 */

import { getCtx } from './sw-context';
import { launchFrame } from './frame-launcher';
import { log } from './logger';

export async function openObjectViewWindow(rid: string, target?: { tabId?: number; windowId?: number }) {
  const ctx = getCtx();
  await ctx.settingsReady;

  const cached = ctx.cache.get(rid);
  const name = cached?.name ?? '';
  const type = cached?.type ?? '';
  const businessId = cached?.businessId ?? '';

  const contextWrite = chrome.storage.local.set({
      [`crev_objectview_ctx_${rid}`]: { rid, name, type, businessId },
    }).catch((e: unknown) => {
    log.swallow('objectview:ctxStore', e);
  });

  const label = name ? `${type || 'Object'} · ${name}` : `Object · ${businessId || rid}`;
  const frameLaunch = launchFrame({
    kind: 'objectview',
    path: `objectview/objectview.html#${rid}`,
    label,
    defaultWidth: 640,
    defaultHeight: 720,
    tabId: target?.tabId,
    windowId: target?.windowId,
  });
  // The stored context is only a title hint; it must not delay mounting the
  // frame. The authoritative pane response updates the title again.
  await Promise.all([contextWrite, frameLaunch]);
}
