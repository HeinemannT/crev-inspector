/**
 * Inspect + paint toggle handlers.
 */

import { register } from '../handler-registry';
import { getCtx } from '../sw-context';
import { incrementGeneration } from '../enrichment';
import { ensureContentScript } from '../tab-awareness';
import { togglePaint } from '../paint';
import { setBlueprintActive } from './layout';
import { loadPage } from '../layout-service';
import { bmpTypeKnowledge } from '../bmp-type-knowledge';
import { intersectTypeSchemas } from '../type-schema-utils';
import { errorMessage, log } from '../logger';
import type { InspectorMessage } from '../types';

/** Resolve "which window does this toggle apply to" for callers that
 *  don't already know. Panel-initiated → panel's window. Otherwise →
 *  lastFocused. Used by the keyboard shortcut + content-script paint
 *  flow which has no panel context. */
async function resolveTargetWindowId(panelWindowId?: number): Promise<number | undefined> {
  if (panelWindowId != null) return panelWindowId;
  try {
    const win = await chrome.windows.getLastFocused({ populate: false });
    return win?.id ?? undefined;
  } catch (e) {
    log.swallow('handler:resolveTargetWindow', e);
    return undefined;
  }
}

/** Toggle inspect mode for the given window. Per-window: inspecting
 *  in window A doesn't paint pills onto window B's BMP tabs. Updates
 *  the panel in that window AND every content tab in that window. */
export async function toggleInspect(windowId?: number) {
  const ctx = getCtx();
  const targetWindowId = windowId ?? await resolveTargetWindowId();
  if (targetWindowId == null) {
    log.warn('handler:toggleInspect', 'No target window resolved — skipping toggle');
    return;
  }
  const next = !ctx.isInspectActive(targetWindowId);
  if (next && ctx.blueprintActiveByWindow.get(targetWindowId)) await setBlueprintActive(targetWindowId, false); // inspect on ⇒ blueprint off
  ctx.setInspectActive(targetWindowId, next);
  if (!next) incrementGeneration();
  ctx.logActivity('info', next ? 'Inspect mode ON' : 'Inspect mode OFF');
  const state: InspectorMessage = { type: 'INSPECT_STATE', active: next };

  // Push only to the panel in the toggled window — other windows'
  // panels keep their own state.
  ctx.sendToPanelByWindow(targetWindowId, state);

  // Push to every content port whose tab lives in the toggled window.
  // Skip content scripts in other windows — they shouldn't paint pills
  // just because the user toggled in a different window. One
  // chrome.tabs.query is O(1) RPC; the prior implementation did one
  // chrome.tabs.get per content port (O(N)) which got slow on users
  // with many BMP tabs.
  try {
    const tabsInWindow = await chrome.tabs.query({ windowId: targetWindowId });
    const idsInWindow = new Set(
      tabsInWindow.map(t => t.id).filter((id): id is number => id != null),
    );
    for (const [tabId, port] of ctx.contentPorts) {
      if (!idsInWindow.has(tabId)) continue;
      try { port.postMessage(state); }
      catch (e) { log.swallow('handler:toggleInspectPort', e); }
    }
  } catch (e) { log.swallow('handler:toggleInspectQuery', e); }

  // Ensure the active tab of the target window has a content script —
  // it might not have connected yet when the user pressed the shortcut.
  const tabs = await chrome.tabs.query({ active: true, windowId: targetWindowId });
  const activeTabId = tabs[0]?.id;
  if (activeTabId != null) {
    await ensureContentScript(activeTabId);
    chrome.tabs.sendMessage(activeTabId, state).catch(e => log.swallow('handler:toggleInspectTab', e));
  }
}

register('TOGGLE_INSPECT', (_msg, _respond, meta) => toggleInspect(meta.panelWindowId));

/** Explicit set, used by the Page-tab context picker which needs to
 *  force inspect ON while armed regardless of current state, then
 *  restore the previous value. No-op when already at the requested
 *  state so we don't churn listeners.
 *
 *  Per-window lock: with multiple panels open, two SET_INSPECT_STATE
 *  for DIFFERENT windows should proceed concurrently — only same-window
 *  pairs interleave. The original global flag wasn't enough; if it took
 *  effect AFTER `resolveTargetWindowId`'s await, two same-window calls
 *  could both pass the in-flight check. Set the lock BEFORE awaiting
 *  anything that yields the event loop. */
const inspectInFlight = new Set<number>();
register('SET_INSPECT_STATE', async (msg, _respond, meta) => {
  // Pre-await lock key: prefer the panel's known windowId; fall back to
  // a sentinel so picker calls without panel context still serialise.
  const lockKey = meta.panelWindowId ?? -1;
  if (inspectInFlight.has(lockKey)) return;
  inspectInFlight.add(lockKey);
  try {
    const ctx = getCtx();
    const targetWindowId = await resolveTargetWindowId(meta.panelWindowId);
    if (targetWindowId == null) return;
    if (ctx.isInspectActive(targetWindowId) === msg.active) return;
    await toggleInspect(targetWindowId);
  } finally {
    inspectInFlight.delete(lockKey);
  }
});

register('INSPECT_EDIT_PAGE_FIELDS', async (msg, respond) => {
  const ctx = getCtx();
  if (!ctx.client) {
    respond({ type: 'INSPECT_EDIT_PAGE_FIELDS_RESULT', ok: false, error: 'Not connected' });
    return;
  }
  if (ctx.client.supportsLookup === false) {
    respond({
      type: 'INSPECT_EDIT_PAGE_FIELDS_RESULT',
      ok: false,
      error: 'Edit-page inspection requires BMP 5.6.3 or newer.',
    });
    return;
  }
  try {
    const loaded = await loadPage(ctx.client, msg.editPageRid, 'instance', []);
    const model = loaded?.load.model;
    const projection = Object.values(model?.flows ?? {}).find(flow =>
      flow.ownerClass === 'EditPage' && (
        flow.ownerRid === msg.editPageRid || flow.refRid === msg.editPageRid
      ),
    );
    if (!projection) {
      respond({
        type: 'INSPECT_EDIT_PAGE_FIELDS_RESULT',
        ok: false,
        error: 'The rendered form has no inspectable EditPage field projection.',
      });
      return;
    }
    const objectTypes = [...new Set(model?.editPageTypes ?? [])];
    const schemaResults = await bmpTypeKnowledge.propertiesFor(objectTypes);
    const schemas = schemaResults.results.flatMap(result => result.ok ? [result.props] : []);
    const properties = schemas.length === objectTypes.length
      ? intersectTypeSchemas(schemas)
      : [];
    const propertyByAccessor = new Map(properties.map(property => [property.accessor, property]));
    respond({
      type: 'INSPECT_EDIT_PAGE_FIELDS_RESULT',
      ok: true,
      fields: projection.children
        .map((field, streamIndex) => ({ field, streamIndex }))
        .filter(({ field }) =>
          (field.className === 'EditField' || field.className === 'EditPageInfo')
          && field.rid,
        )
        .map(({ field, streamIndex }) => {
          const property = field.prop ? propertyByAccessor.get(field.prop) : undefined;
          return {
            rid: field.rid!,
            businessId: field.id,
            name: field.name,
            className: field.className as 'EditField' | 'EditPageInfo',
            streamIndex,
            ...(field.prop ? { property: field.prop } : {}),
            ...(property?.propertyRid ? {
              propertyObject: {
                rid: property.propertyRid,
                ...(property.propertyId ? { businessId: property.propertyId } : {}),
                name: property.label || property.accessor,
                type: property.propertyConfigClass ?? property.configClass,
              },
            } : {}),
          };
        }),
    });
  } catch (error) {
    respond({
      type: 'INSPECT_EDIT_PAGE_FIELDS_RESULT',
      ok: false,
      error: errorMessage(error),
    });
  }
});

register('TOGGLE_PAINT', (_msg, _respond, meta) => {
  void togglePaint(ensureContentScript, meta.panelWindowId);
});

register('TOGGLE_TECHNICAL_OVERLAY', () => {
  const ctx = getCtx();
  ctx.technicalOverlay = !ctx.technicalOverlay;
  ctx.logActivity('info', ctx.technicalOverlay ? 'Technical overlay ON' : 'Technical overlay OFF');
  ctx.broadcastToContent({ type: 'TECHNICAL_OVERLAY_STATE', active: ctx.technicalOverlay });
});
