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
import './handlers/studio';
import './handlers/access';
import './handlers/enrichment';
import './handlers/paint';
import './handlers/detection';
import './handlers/history';
import './handlers/windows';
import './handlers/bmp-goto';
import './handlers/layout';

// Re-export for external callers that referenced old names
export { getLinkedDefs } from './handlers/objects';

// ── Entry points ─────────────────────────────────────────────────

/**
 * All handlers are gated on settingsReady.  When the SW wakes from
 * suspension, chrome.storage.local.get runs before any handler fires.
 * This eliminates per-handler settingsReady.then() wrappers and
 * prevents stale DEFAULT_SETTINGS reads on wake.
 */

/** Handle a message from the panel port (persistent connection). The
 *  port reference lets us look up which window the panel is in, so
 *  handlers can target the right BMP tab without consulting
 *  lastFocusedWindow. respond replies to THIS panel only — broadcasts
 *  to all panels go via ctx.sendToPanel(r). */
export async function handlePanelMessage(msg: InspectorMessage, port?: chrome.runtime.Port) {
  const ctx = getCtx();
  await ctx.settingsReady;
  const handler = getHandler(msg.type);
  if (handler) {
    const panelWindowId = port ? findWindowIdForPort(ctx, port) : undefined;
    const respond = port
      ? (r: InspectorMessage) => { try { port.postMessage(r); } catch { /* port closed */ } }
      : (r: InspectorMessage) => ctx.sendToPanel(r);
    await handler(msg, respond, { isOneShot: false, panelWindowId });
  }
}

function findWindowIdForPort(ctx: ReturnType<typeof getCtx>, port: chrome.runtime.Port): number | undefined {
  for (const [windowId, p] of ctx.panelPortByWindow) {
    if (p === port) return windowId;
  }
  return undefined;
}

/** Handle a message from a content script port. */
export async function handleContentMessage(msg: InspectorMessage, senderTabId?: number) {
  const ctx = getCtx();
  await ctx.settingsReady;
  const handler = getHandler(msg.type);
  if (handler) {
    handler(msg, r => ctx.sendToPanel(r), { senderTabId, isOneShot: false });
  }
}

/** Handle a one-shot message (chrome.runtime.onMessage from editor/objectview/diff/content). */
export function handleOneShotMessage(
  msg: InspectorMessage,
  sender: chrome.runtime.MessageSender,
  sendResponse: (r: InspectorMessage) => void,
): boolean {
  const handler = getHandler(msg.type);
  if (!handler) return false;
  // Gate on settingsReady — handler calls sendResponse async after settings load.
  // We always return true to keep the message port open until then.
  const ctx = getCtx();
  ctx.settingsReady.then(() => {
    handler(msg, sendResponse, { senderTabId: sender.tab?.id, isOneShot: true });
  });
  return true;
}

// ── Legacy exports (used by service-worker.ts) ───────────────────

export { toggleInspect } from './handlers/inspect';
