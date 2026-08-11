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
import type { FrameActivation, FrameKind } from './types';

export interface LaunchFrameOptions {
  kind: FrameKind;
  /** Path under chrome-extension://<id>/, e.g. 'editor/editor.html#123' */
  path: string;
  /** Used for aria-label and the overlay's titlebar text. */
  label: string;
  defaultWidth: number;
  defaultHeight: number;
  /** Stable content identity. Same-key launches activate the live frame;
   * different keys go through its unsaved-close handshake. */
  resourceKey?: string;
  replaceExisting?: boolean;
  activation?: FrameActivation;
  /** Mount directly on this tab. Highest-priority targeting — used when
   *  the source is a content script (the user just clicked on this tab,
   *  mount where they clicked). */
  tabId?: number;
  /** Mount on the active tab of this window. Used when the source is a
   *  side panel — panel knows its windowId, and "active tab in my
   *  window" is the right target regardless of focus history. */
  windowId?: number;
}

export interface FrameTarget {
  tabId?: number;
  windowId?: number;
}

/** Resolve a window-relative launch once so callers that also prepare
 * tab-specific context can freeze both operations to the same tab. */
export async function resolveFrameTargetTabId(target: FrameTarget = {}): Promise<number | undefined> {
  if (target.tabId != null) {
    try { return (await chrome.tabs.get(target.tabId))?.id; }
    catch (e) { log.swallow('frame-launcher:resolveTabById', e); return undefined; }
  }
  const query: chrome.tabs.QueryInfo = target.windowId != null
    ? { active: true, windowId: target.windowId }
    : { active: true, lastFocusedWindow: true };
  try {
    const tabs = await chrome.tabs.query(query);
    return tabs[0]?.id;
  } catch (e) {
    log.swallow('frame-launcher:queryTab', e);
    return undefined;
  }
}

/** Send MOUNT_FRAME to the target tab's content script. If no content script
 *  is present (chrome:// page, etc.) the failure is logged and dropped. */
export async function launchFrame(opts: LaunchFrameOptions): Promise<void> {
  const tabId = await resolveFrameTargetTabId(opts);
  if (tabId == null) {
    log.warn('frame-launcher:noActiveTab', 'No active tab to mount frame overlay');
    return;
  }
  const url = chrome.runtime.getURL(opts.path);
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: 'MOUNT_FRAME',
      kind: opts.kind,
      url,
      label: opts.label,
      defaultWidth: opts.defaultWidth,
      defaultHeight: opts.defaultHeight,
      resourceKey: opts.resourceKey,
      replaceExisting: opts.replaceExisting,
      activation: opts.activation,
    });
  } catch (e) {
    log.warn('frame-launcher:mountFailed', `Cannot mount frame overlay (kind=${opts.kind}): ${(e as Error).message}`);
  }
}
