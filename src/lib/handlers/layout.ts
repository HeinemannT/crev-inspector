/**
 * Blueprint layout-builder handlers. Thin: resolve context + load, or apply an edit. All the
 * logic lives in layout-service (shell) + layout/ (pure core). The SW is stateless per request —
 * the panel owns the editable model + history and passes baseline+desired back on apply.
 */
import { register } from '../handler-registry';
import { getCtx } from '../sw-context';
import type { SwContext } from '../sw-context';
import { loadPage, applyPage, loadBlastRadius, loadFlowRefs, loadFlowRefChildren } from '../layout-service';
import { ensureContentScript, ensureBlueprintScript } from '../tab-awareness';
import { toggleInspect } from './inspect';
import { errorMessage, log } from '../logger';

/** Set blueprint mode for a window + broadcast to its panel and content tab. Shared by the
 *  toggle handler and the inspect handler — blueprint and inspect are mutually exclusive (each runs
 *  its own document-wide overlay + observer, so only one should paint at a time). `tabId` pins the
 *  content tab explicitly (the post-apply resume targets the tab that reloaded, which may no longer
 *  be the window's active tab); default is the window's active tab. */
export async function setBlueprintActive(windowId: number, active: boolean, tabId?: number): Promise<void> {
  const ctx = getCtx();
  if (ctx.blueprintActiveByWindow.get(windowId) === active) return;
  ctx.blueprintActiveByWindow.set(windowId, active);
  ctx.logActivity('info', active ? 'Blueprint mode ON' : 'Blueprint mode OFF');
  const state = { type: 'BLUEPRINT_STATE' as const, active };
  ctx.sendToPanelByWindow(windowId, state);
  try {
    const target = tabId ?? (await chrome.tabs.query({ active: true, windowId }))[0]?.id;
    if (target != null) {
      if (active) ctx.blueprintTabByWindow.set(windowId, target); else ctx.blueprintTabByWindow.delete(windowId);
      await ensureContentScript(target);
      chrome.tabs.sendMessage(target, state).catch(e => log.swallow('blueprint:toggleTab', e));
    } else if (!active) { ctx.blueprintTabByWindow.delete(windowId); }
  } catch (e) { log.swallow('blueprint:toggleQuery', e); }
  // Persist so the toggle survives an MV3 SW idle-suspend (mirrors setInspectActive). After a restart
  // the boot restore repopulates this, so BLUEPRINT_TOGGLE / Ctrl+Shift+B / the side-panel toggle read
  // the true state instead of an empty map — the fix for "Exit does nothing after the SW slept".
  ctx.persistBlueprintState();
}

/** Flip blueprint on/off for a window (defaulting to the last-focused one — used by both the
 *  BLUEPRINT_TOGGLE message and the Ctrl+Shift+B keyboard command). Blueprint and inspect are mutually
 *  exclusive, so turning blueprint on turns inspect off. */
export async function toggleBlueprint(windowId?: number): Promise<void> {
  const ctx = getCtx();
  const wid = windowId ?? (await chrome.windows.getLastFocused().catch(() => null))?.id;
  if (wid == null) return;
  const next = !ctx.blueprintActiveByWindow.get(wid);
  if (next && ctx.isInspectActive(wid)) await toggleInspect(wid); // blueprint on ⇒ inspect off
  await setBlueprintActive(wid, next);
}

register('BLUEPRINT_TOGGLE', async (_msg, _respond, meta) => {
  await toggleBlueprint(meta.panelWindowId ?? undefined);
});

// Content → SW: the tab is activating Blueprint for the first time and needs the editor's
// content-blueprint.js injected (it's not part of the always-on content bundle — see plans/009).
// Fire-and-forget; content.ts follows up by dispatching the `crev-bp-cmd` enable event once this
// resolves (or the newly-injected script picks up the pending-enable window flag on its own init).
register('INJECT_BLUEPRINT', async (_msg, _respond, meta) => {
  if (meta.senderTabId == null) return;
  await ensureBlueprintScript(meta.senderTabId);
});

// Post-apply resume: apply toggles blueprint OFF and reloads the page (the live grid only reflows on
// a real load); the fresh content script then asks to turn it back ON so the editing session
// continues on the fresh model. Deterministic set (not a toggle) — an already-on window is a no-op.
register('BLUEPRINT_RESUME', async (_msg, _respond, meta) => {
  if (meta.senderTabId == null) return;
  try {
    const tab = await chrome.tabs.get(meta.senderTabId);
    if (tab?.windowId == null) return;
    if (getCtx().isInspectActive(tab.windowId)) await toggleInspect(tab.windowId); // same exclusivity as toggle
    await setBlueprintActive(tab.windowId, true, meta.senderTabId);
  } catch (e) { log.swallow('blueprint:resume', e); }
});

/** Environment fingerprint stamped at load and re-checked at apply. Combines the active profile id
 *  with the live server URL, so a profile reconfigured to a different workspace under the same id
 *  can't silently receive a commit meant for the old one. */
const envToken = (ctx: SwContext): string => `${ctx.settings.activeProfileId}@${ctx.client?.serverUrl ?? ''}`;

// LAYOUT_LOAD/APPLY are request/response: the content overlay sends them via `sendRequest`
// (one-shot), so the handler's `respond` IS sendResponse and goes straight back to the sender.

register('LAYOUT_LOAD', async (msg, respond) => {
  const ctx = getCtx();
  if (!ctx.client) { respond({ type: 'LAYOUT_LOAD_RESULT', ok: false, error: 'Not connected' }); return; }
  const t0 = Date.now();
  const timings: string[] = []; // operation-local — see makeLayoutIO
  try {
    const res = await loadPage(ctx.client, msg.rid, msg.prefer, timings);
    if (!res) {
      respond({ type: 'LAYOUT_LOAD_RESULT', ok: false, error: 'Not an editable page (no tabset resolved)' });
      ctx.logActivity('warn', `Blueprint load: ${msg.rid} is not an editable page`);
      return;
    }
    respond({
      type: 'LAYOUT_LOAD_RESULT', ok: true, env: envToken(ctx),
      ctx: res.ctx, model: res.load.model, baseline: res.load.baseline, orphans: res.load.orphans,
    });
    ctx.logActivity('success', `Blueprint loaded ${res.ctx.pageClass} ${res.ctx.pageId}${res.ctx.resultOnly ? ' (result-only, no tabset)' : ''} (${Date.now() - t0}ms)`, `EC calls: ${timings.join(' | ')}`);
  } catch (e) {
    respond({ type: 'LAYOUT_LOAD_RESULT', ok: false, error: errorMessage(e) });
    ctx.logActivity('error', 'Blueprint load threw', e instanceof Error ? e.message : String(e));
  }
});

register('LAYOUT_APPLY', async (msg, respond) => {
  const ctx = getCtx();
  if (!ctx.client) { respond({ type: 'LAYOUT_APPLY_RESULT', ok: false, noop: false, error: 'Not connected' }); return; }
  // Wrong-env guard: refuse a commit whose load happened against a different profile than the one
  // now active (the user switched environments between load and apply).
  if (msg.env !== envToken(ctx)) {
    respond({ type: 'LAYOUT_APPLY_RESULT', ok: false, noop: false,
      error: 'Environment changed since this layout was loaded. Reload the page before applying.' });
    ctx.logActivity('warn', `Blueprint apply blocked: env ${msg.env} != active ${envToken(ctx)}`);
    return;
  }
  const t0 = Date.now();
  const timings: string[] = []; // operation-local — see makeLayoutIO
  try {
    const res = await applyPage(ctx.client, msg.ctx, msg.baseline, msg.desired, timings);
    respond({
      type: 'LAYOUT_APPLY_RESULT', ok: res.ok, noop: res.noop, stale: res.stale,
      script: res.script, notes: res.notes, model: res.model, baseline: res.baseline, error: res.error,
    });
    // Audit trail: the applied EC is first-class — record it so a mis-apply is reconstructable.
    if (res.noop) {
      ctx.logActivity('success', 'Blueprint apply: no changes');
    } else if (res.ok) {
      ctx.logActivity('success', `Blueprint applied ${res.plan.length} step(s) (${Date.now() - t0}ms)`, `EC calls: ${timings.join(' | ')}\n\n${res.script}`);
    } else {
      ctx.logActivity('error', 'Blueprint apply failed', res.error);
    }
  } catch (e) {
    respond({ type: 'LAYOUT_APPLY_RESULT', ok: false, noop: false, error: errorMessage(e) });
    ctx.logActivity('error', 'Blueprint apply threw', e instanceof Error ? e.message : String(e));
  }
});

// Apply-preview blast radius. Best-effort and fire-and-respond: loadBlastRadius never throws (it
// fails silently to nulls), so the preview shows warnings only when the rref walk came back in time.
register('LAYOUT_BLAST', async (msg, respond) => {
  const ctx = getCtx();
  if (!ctx.client) { respond({ type: 'LAYOUT_BLAST_RESULT', fanout: null, blast: null }); return; }
  const res = await loadBlastRadius(ctx.client, msg.pageId, msg.containers);
  respond({ type: 'LAYOUT_BLAST_RESULT', fanout: res.fanout, blast: res.blast });
});

// Flow "wire to existing" picker: the workspace's InputSets / EditPages, fetched lean at picker-open
// (never part of the main layout fetch). Stateless like every other layout handler.
register('LAYOUT_FLOW_REFS', async (msg, respond) => {
  const ctx = getCtx();
  if (!ctx.client) { respond({ type: 'LAYOUT_FLOW_REFS_RESULT', ok: false, error: 'Not connected' }); return; }
  try {
    const refs = await loadFlowRefs(ctx.client, msg.refClass);
    respond({ type: 'LAYOUT_FLOW_REFS_RESULT', ok: true, refs });
  } catch (e) {
    respond({ type: 'LAYOUT_FLOW_REFS_RESULT', ok: false, error: errorMessage(e) });
  }
});

// Wire-to-existing follow-up: the on-demand children of ONE existing off-page InputSet/EditPage, so the
// cell shows its real current contents (staged adds layer on top). Fails soft — the UI keeps its note.
register('LAYOUT_FLOW_REF_CHILDREN', async (msg, respond) => {
  const ctx = getCtx();
  if (!ctx.client) { respond({ type: 'LAYOUT_FLOW_REF_CHILDREN_RESULT', ok: false, error: 'Not connected' }); return; }
  try {
    const children = await loadFlowRefChildren(ctx.client, msg.refId);
    respond({ type: 'LAYOUT_FLOW_REF_CHILDREN_RESULT', ok: true, children });
  } catch (e) {
    respond({ type: 'LAYOUT_FLOW_REF_CHILDREN_RESULT', ok: false, error: errorMessage(e) });
  }
});
