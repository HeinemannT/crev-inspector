/**
 * Blueprint layout-builder handlers. Thin: resolve context + load, or apply an edit. All the
 * logic lives in layout-service (shell) + layout/ (pure core). The SW is stateless per request —
 * the panel owns the editable model + history and passes baseline+desired back on apply.
 */
import { register } from '../handler-registry';
import { getCtx } from '../sw-context';
import type { SwContext } from '../sw-context';
import { loadPage, applyPage, loadBlastRadius, loadFlowRefs, loadFlowRefChildren, preflightPortableIds } from '../layout-service';
import { ensureContentScript, ensureBlueprintScript } from '../tab-awareness';
import { toggleInspect } from './inspect';
import { errorMessage, log } from '../logger';
import type { PlanNote } from '../layout/types';
import type { ApplyResult } from '../layout/sync';
import type { ActivityMeta } from '../types';

const BLUEPRINT_VERSION_ERROR = 'Blueprint requires BMP 5.6.3 or newer.';

function blueprintActivityMeta(
  page: { pageRid: string; pageId: string; pageClass?: string },
  action: string,
  durationMs?: number,
): ActivityMeta {
  return {
    category: 'blueprint',
    action,
    object: {
      rid: page.pageRid,
      businessId: page.pageId,
      type: page.pageClass ?? 'Page',
      name: page.pageId,
    },
    ...(durationMs == null ? {} : { durationMs }),
  };
}

function blueprintSupported(ctx: SwContext): boolean {
  return ctx.client?.supportsLookup !== false;
}

/** One plan note as a human-readable line for the LOG tab detail — mirrors what `planRow` shows in the
 *  overlay (action · type · object → where · detail) but in plain text, so the persistent record reads
 *  the same as the live panel without decoding the raw EC below it. */
function formatNotes(notes: PlanNote[]): string {
  return notes
    .map(n => {
      const act = n.action ?? n.verb;
      const obj = n.object ?? n.text ?? '';
      const type = n.objectType ? `${n.objectType} ` : '';
      const where = n.where ? ` → ${n.where}` : '';
      const det = n.detail ? `  (${n.detail})` : '';
      return `• ${act} ${type}${obj}${where}${det}`.replace(/\s+/g, ' ').trim();
    })
    .join('\n');
}

function verificationText(res: ApplyResult): string {
  if (res.unverified) return res.error || 'The write completed, but Blueprint could not verify the refreshed layout.';
  if (res.partial) return res.error || 'The refreshed layout shows that only part of the requested change landed.';
  if (!res.ok) return res.error || 'The refreshed layout did not match the requested change.';
  return 'Verified against a fresh layout read.';
}

/** Persistent Apply record. The server's write response comes first because it is the primary
 * execution evidence; Blueprint's interpretation and generated program remain available below it. */
function applyActivityDetail(res: ApplyResult, timings: string[]): string {
  const execution = res.executionLog || 'No execution log was returned by BMP.';
  const requested = formatNotes(res.notes) || 'No requested changes.';
  const script = res.script || 'No Extended Code was executed.';
  return [
    'BMP execution log',
    execution,
    '',
    'Verification',
    verificationText(res),
    '',
    'Requested changes',
    requested,
    '',
    'Generated Extended Code',
    script,
    '',
    'Diagnostics',
    `EC calls: ${timings.join(' | ') || 'none'}`,
  ].join('\n');
}

/** Set blueprint mode for a window + broadcast to its panel and content tab. Shared by the
 *  toggle handler and the inspect handler — blueprint and inspect are mutually exclusive (each runs
 *  its own document-wide overlay + observer, so only one should paint at a time). `tabId` pins the
 *  content tab explicitly (the post-apply resume targets the tab that reloaded, which may no longer
 *  be the window's active tab); default is the window's active tab. */
export async function setBlueprintActive(windowId: number, active: boolean, tabId?: number, force = false): Promise<void> {
  const ctx = getCtx();
  if (active && !blueprintSupported(ctx)) {
    ctx.toast(BLUEPRINT_VERSION_ERROR, 'info');
    return;
  }
  const unchanged = ctx.blueprintActiveByWindow.get(windowId) === active;
  if (unchanged && !force) return;
  // Capture the owner before changing either map. Turning Blueprint OFF must follow the session back
  // to the tab it was opened in — the window's currently-active tab may have changed since then.
  const pinnedTabId = ctx.blueprintTabByWindow.get(windowId);
  ctx.blueprintActiveByWindow.set(windowId, active);
  if (!unchanged) ctx.logActivity('info', active ? 'Blueprint mode ON' : 'Blueprint mode OFF');
  const state = { type: 'BLUEPRINT_STATE' as const, active };
  ctx.sendToPanelByWindow(windowId, state);
  try {
    const target = tabId ?? (!active ? pinnedTabId : undefined)
      ?? (await chrome.tabs.query({ active: true, windowId }))[0]?.id;
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

// The overlay X is tied to a concrete content tab, so derive the window from that sender and pin the
// OFF broadcast back to the same tab. `force` heals any stale worker map as well: even if the MV3
// worker restored "off" while an old overlay is visibly alive, the explicit close still tears it down.
register('BLUEPRINT_CLOSE', async (_msg, _respond, meta) => {
  if (meta.senderTabId != null) {
    try {
      const tab = await chrome.tabs.get(meta.senderTabId);
      await setBlueprintActive(tab.windowId, false, meta.senderTabId, true);
      return;
    } catch (e) { log.swallow('blueprint:closeTab', e); }
  }
  if (meta.panelWindowId != null) await setBlueprintActive(meta.panelWindowId, false, undefined, true);
});

// Content → SW: the tab is activating Blueprint for the first time and needs the editor's
// content-blueprint.js injected (it's not part of the always-on content bundle).
// Fire-and-forget; content.ts follows up by dispatching the `crev-bp-cmd` enable event once this
// resolves (or the newly-injected script picks up the pending-enable window flag on its own init).
register('INJECT_BLUEPRINT', async (_msg, _respond, meta) => {
  if (meta.senderTabId == null || !blueprintSupported(getCtx())) return;
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
  if (!blueprintSupported(ctx)) { respond({ type: 'LAYOUT_LOAD_RESULT', ok: false, error: BLUEPRINT_VERSION_ERROR }); return; }
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
  if (!blueprintSupported(ctx)) {
    respond({ type: 'LAYOUT_APPLY_RESULT', ok: false, noop: false, error: BLUEPRINT_VERSION_ERROR });
    return;
  }
  // Wrong-env guard: refuse a commit whose load happened against a different profile than the one
  // now active (the user switched environments between load and apply).
  if (msg.env !== envToken(ctx)) {
    respond({ type: 'LAYOUT_APPLY_RESULT', ok: false, noop: false,
      error: 'Environment changed since this layout was loaded. Reload the page before applying.' });
    ctx.logActivity('warn', `Blueprint apply blocked: env ${msg.env} != active ${envToken(ctx)}`);
    return;
  }
  if (msg.portableIds && Object.keys(msg.portableIds).length && msg.ctx.target !== 'template') {
    respond({
      type: 'LAYOUT_APPLY_RESULT',
      ok: false,
      noop: false,
      error: 'Automatic ID assignment is available only while editing a template.',
    });
    return;
  }
  const t0 = Date.now();
  const timings: string[] = []; // operation-local — see makeLayoutIO
  try {
    const res = await applyPage(ctx.client, msg.ctx, msg.baseline, msg.desired, timings, msg.portableIds);
    respond({
      type: 'LAYOUT_APPLY_RESULT', ok: res.ok, noop: res.noop, stale: res.stale, partial: res.partial,
      unverified: res.unverified,
      script: res.script, executionLog: res.executionLog, notes: res.notes,
      model: res.model, baseline: res.baseline, error: res.error,
    });
    // Audit trail: the applied EC is first-class — record it so a mis-apply is reconstructable.
    // The detail leads with BMP's actual commit response, followed by Blueprint's verification,
    // requested changes, generated EC, and internal timings. A partial apply is logged loudly at
    // 'error' even when ok:true because BMP EC is not atomic.
    const detail = () => applyActivityDetail(res, timings);
    const durationMs = Date.now() - t0;
    const meta = blueprintActivityMeta(msg.ctx, 'apply', durationMs);
    if (res.noop) {
      ctx.logActivity('success', 'Blueprint apply: no changes', undefined, meta);
    } else if (res.unverified) {
      // Commit ran but the reconcile re-fetch failed — warn (ok) / error (errored partway), never a bare
      // "apply failed": the write most likely landed and the page reloads to show the truth.
      ctx.logActivity(res.ok ? 'warn' : 'error', 'Blueprint apply unverified', detail(), meta);
    } else if (res.partial) {
      ctx.logActivity('error', 'Blueprint partially applied', detail(), meta);
    } else if (res.ok) {
      ctx.logActivity('success', `Blueprint applied ${res.plan.length} step(s) (${durationMs}ms)`, detail(), meta);
    } else {
      ctx.logActivity('error', 'Blueprint apply failed', detail(), meta);
    }
  } catch (e) {
    respond({ type: 'LAYOUT_APPLY_RESULT', ok: false, noop: false, error: errorMessage(e) });
    ctx.logActivity('error', 'Blueprint apply threw', e instanceof Error ? e.message : String(e), blueprintActivityMeta(msg.ctx, 'apply'));
  }
});

register('LAYOUT_PORTABLE_ID_PREFLIGHT', async (msg, respond) => {
  const ctx = getCtx();
  if (!ctx.client) {
    respond({ type: 'LAYOUT_PORTABLE_ID_PREFLIGHT_RESULT', ok: false, error: 'Not connected' });
    return;
  }
  try {
    const portableIds = await preflightPortableIds(ctx.client, msg.requests);
    respond({ type: 'LAYOUT_PORTABLE_ID_PREFLIGHT_RESULT', ok: true, portableIds });
  } catch (error) {
    respond({ type: 'LAYOUT_PORTABLE_ID_PREFLIGHT_RESULT', ok: false, error: errorMessage(error) });
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
