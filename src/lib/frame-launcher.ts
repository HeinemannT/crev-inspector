/**
 * SW-side helper for mounting an in-page frame overlay on the active tab.
 * Used by every code-bearing surface (editor / diff / objectview / codesearch)
 * to replace the legacy chrome.windows.create popup launchers.
 *
 * Multi-window aware: callers can pin the mount to a specific tab, or to
 * a specific window's active tab. Without targeting, falls back to the
 * user's most-recently-focused window — wrong-window risk when two
 * panels are open, but only for callers that don't carry source info.
 */

import { log } from './logger';
import type { FrameKind } from './types';

export interface LaunchFrameOptions {
  kind: FrameKind;
  /** Path under chrome-extension://<id>/, e.g. 'editor/editor.html#123' */
  path: string;
  /** Used for aria-label and the overlay's titlebar text. */
  label: string;
  defaultWidth: number;
  defaultHeight: number;
  /** Mount directly on this tab. Highest-priority targeting — used when
   *  the source is a content script (the user just clicked on this tab,
   *  mount where they clicked). */
  tabId?: number;
  /** Mount on the active tab of this window. Used when the source is a
   *  side panel — panel knows its windowId, and "active tab in my
   *  window" is the right target regardless of focus history. */
  windowId?: number;
}

async function resolveTargetTab(opts: LaunchFrameOptions): Promise<chrome.tabs.Tab | undefined> {
  if (opts.tabId != null) {
    try { return await chrome.tabs.get(opts.tabId); }
    catch (e) { log.swallow('frame-launcher:resolveTabById', e); return undefined; }
  }
  const query: chrome.tabs.QueryInfo = opts.windowId != null
    ? { active: true, windowId: opts.windowId }
    : { active: true, lastFocusedWindow: true };
  try {
    const tabs = await chrome.tabs.query(query);
    return tabs[0];
  } catch (e) {
    log.swallow('frame-launcher:queryTab', e);
    return undefined;
  }
}

/** Send MOUNT_FRAME to the target tab's content script. If no content script
 *  is present (chrome:// page, etc.) the failure is logged and dropped. */
export async function launchFrame(opts: LaunchFrameOptions): Promise<void> {
  const tab = await resolveTargetTab(opts);
  if (!tab?.id) {
    log.warn('frame-launcher:noActiveTab', 'No active tab to mount frame overlay');
    return;
  }
  const url = chrome.runtime.getURL(opts.path);
  try {
    await chrome.tabs.sendMessage(tab.id, {
      type: 'MOUNT_FRAME',
      kind: opts.kind,
      url,
      label: opts.label,
      defaultWidth: opts.defaultWidth,
      defaultHeight: opts.defaultHeight,
    });
  } catch (e) {
    log.warn('frame-launcher:mountFailed', `Cannot mount frame overlay (kind=${opts.kind}): ${(e as Error).message}`);
  }
}
