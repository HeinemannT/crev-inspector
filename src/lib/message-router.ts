/**
 * Message router — thin dispatcher over the handler registry.
 *
 * Three entry points map Chrome's messaging architecture to a single
 * handler registry. Domain modules in handlers/ register their own types.
 *
 * To add a new message type:
 *   1. Add the type to types.ts
 *   2. Create or edit a handler file in handlers/
 *   3. Call register('MY_TYPE', handler) — done
 */

import type { InspectorMessage } from './types';
import { getCtx } from './sw-context';
import { getHandler } from './handler-registry';

// Import handler modules — registration happens at import time
import './handlers/inspect';
import './handlers/profiles';
import './handlers/objects';
import './handlers/ec';
import './handlers/enrichment';
import './handlers/paint';
import './handlers/detection';
import './handlers/history';
import './handlers/windows';

// Re-export for external callers that referenced old names
export { getLinkedDefs } from './handlers/objects';

// ── Entry points ─────────────────────────────────────────────────

/**
 * All handlers are gated on settingsReady.  When the SW wakes from
 * suspension, chrome.storage.local.get runs before any handler fires.
 * This eliminates per-handler settingsReady.then() wrappers and
 * prevents stale DEFAULT_SETTINGS reads on wake.
 */

/** Handle a message from the panel port (persistent connection). */
export async function handlePanelMessage(msg: InspectorMessage) {
  const ctx = getCtx();
  await ctx.settingsReady;
  const entry = getHandler(msg.type);
  if (entry) {
    await entry.handler(msg, r => ctx.sendToPanel(r), { isOneShot: false });
  }
}

/** Handle a message from a content script port. */
export async function handleContentMessage(msg: InspectorMessage, senderTabId?: number) {
  const ctx = getCtx();
  await ctx.settingsReady;
  const entry = getHandler(msg.type);
  if (entry) {
    entry.handler(msg, r => ctx.sendToPanel(r), { senderTabId, isOneShot: false });
  }
}

/** Handle a one-shot message (chrome.runtime.onMessage from editor/objectview/diff/content). */
export function handleOneShotMessage(
  msg: InspectorMessage,
  sender: chrome.runtime.MessageSender,
  sendResponse: (r: any) => void,
): boolean {
  const entry = getHandler(msg.type);
  if (!entry) return false;
  // Gate on settingsReady — handler calls sendResponse async after settings load
  const ctx = getCtx();
  ctx.settingsReady.then(() => {
    entry.handler(msg, sendResponse, { senderTabId: sender.tab?.id, isOneShot: true });
  });
  return true; // always async — settingsReady may not be resolved yet
}

// ── Legacy exports (used by service-worker.ts) ───────────────────

export { toggleInspect } from './handlers/inspect';
