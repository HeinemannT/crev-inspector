/**
 * Inspect + paint toggle handlers.
 */

import { register } from '../handler-registry';
import { getCtx } from '../sw-context';
import { incrementGeneration } from '../enrichment';
import { ensureContentScript } from '../tab-awareness';
import { togglePaint } from '../paint';
import { log } from '../logger';
import type { InspectorMessage } from '../types';

/** Toggle inspect mode — used by both TOGGLE_INSPECT message and keyboard shortcut. */
export async function toggleInspect() {
  const ctx = getCtx();
  ctx.inspectActive = !ctx.inspectActive;
  if (!ctx.inspectActive) incrementGeneration();
  ctx.logActivity('info', ctx.inspectActive ? 'Inspect mode ON' : 'Inspect mode OFF');
  chrome.storage.local.set({ crev_inspect_active: ctx.inspectActive }).catch(e => log.swallow('handler:persistInspect', e));
  const state: InspectorMessage = { type: 'INSPECT_STATE', active: ctx.inspectActive };

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabId = tabs[0]?.id;
  if (tabId != null) await ensureContentScript(tabId);

  ctx.broadcastToContent(state);
  ctx.sendToPanel(state);

  if (tabId != null) chrome.tabs.sendMessage(tabId, state).catch(e => log.swallow('handler:toggleInspectTab', e));
}

register('TOGGLE_INSPECT', () => toggleInspect());

register('TOGGLE_PAINT', () => {
  togglePaint(ensureContentScript);
});
