/**
 * Blueprint layout-builder handlers. Thin: resolve context + load, or apply an edit. All the
 * logic lives in layout-service (shell) + layout/ (pure core). The SW is stateless per request —
 * the panel owns the editable model + history and passes baseline+desired back on apply.
 */
import { register } from '../handler-registry';
import { getCtx } from '../sw-context';
import type { SwContext } from '../sw-context';
import { loadPage, applyPage } from '../layout-service';
import { ensureContentScript } from '../tab-awareness';
import { errorMessage, log } from '../logger';

/** Per-window blueprint-mode state (self-contained — blueprint is a single-active-tab overlay, so
 *  it doesn't need the broader per-tab machinery inspect uses). */
const blueprintActiveByWindow = new Map<number, boolean>();

register('BLUEPRINT_TOGGLE', async (_msg, _respond, meta) => {
  const ctx = getCtx();
  const windowId = meta.panelWindowId ?? (await chrome.windows.getLastFocused().catch(() => null))?.id;
  if (windowId == null) return;
  const next = !blueprintActiveByWindow.get(windowId);
  blueprintActiveByWindow.set(windowId, next);
  ctx.logActivity('info', next ? 'Blueprint mode ON' : 'Blueprint mode OFF');
  const state = { type: 'BLUEPRINT_STATE' as const, active: next };
  ctx.sendToPanelByWindow(windowId, state);
  // Drive the active BMP tab's content overlay (blueprint edits one page at a time).
  try {
    const [tab] = await chrome.tabs.query({ active: true, windowId });
    if (tab?.id != null) {
      await ensureContentScript(tab.id);
      chrome.tabs.sendMessage(tab.id, state).catch(e => log.swallow('blueprint:toggleTab', e));
    }
  } catch (e) { log.swallow('blueprint:toggleQuery', e); }
});

/** Environment fingerprint stamped at load and re-checked at apply. Combines the active profile id
 *  with the live server URL, so a profile reconfigured to a different workspace under the same id
 *  can't silently receive a commit meant for the old one. */
const envToken = (ctx: SwContext): string => `${ctx.settings.activeProfileId}@${ctx.client?.serverUrl ?? ''}`;

register('LAYOUT_LOAD', async (msg, respond) => {
  const ctx = getCtx();
  if (!ctx.client) { respond({ type: 'LAYOUT_LOAD_RESULT', ok: false, error: 'Not connected' }); return; }
  const t0 = Date.now();
  try {
    const res = await loadPage(ctx.client, msg.rid);
    if (!res) {
      respond({ type: 'LAYOUT_LOAD_RESULT', ok: false, error: 'Not an editable page (no tabset resolved)' });
      ctx.logActivity('warn', `Blueprint load: ${msg.rid} is not an editable page`);
      return;
    }
    respond({
      type: 'LAYOUT_LOAD_RESULT', ok: true, env: envToken(ctx),
      ctx: res.ctx, model: res.load.model, baseline: res.load.baseline, orphans: res.load.orphans,
    });
    ctx.logActivity('success', `Blueprint loaded ${res.ctx.pageClass} ${res.ctx.pageId} (${Date.now() - t0}ms)`);
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
      error: 'Environment changed since this layout was loaded — reload the page before applying.' });
    ctx.logActivity('warn', `Blueprint apply blocked: env ${msg.env} != active ${envToken(ctx)}`);
    return;
  }
  const t0 = Date.now();
  try {
    const res = await applyPage(ctx.client, msg.ctx, msg.baseline, msg.desired);
    respond({
      type: 'LAYOUT_APPLY_RESULT', ok: res.ok, noop: res.noop, stale: res.stale,
      script: res.script, notes: res.notes, model: res.model, baseline: res.baseline, error: res.error,
    });
    // Audit trail: the applied EC is first-class — record it so a mis-apply is reconstructable.
    if (res.noop) {
      ctx.logActivity('success', 'Blueprint apply: no changes');
    } else if (res.ok) {
      ctx.logActivity('success', `Blueprint applied ${res.plan.length} step(s) (${Date.now() - t0}ms)`, res.script);
    } else {
      ctx.logActivity('error', 'Blueprint apply failed', res.error);
    }
  } catch (e) {
    respond({ type: 'LAYOUT_APPLY_RESULT', ok: false, noop: false, error: errorMessage(e) });
    ctx.logActivity('error', 'Blueprint apply threw', e instanceof Error ? e.message : String(e));
  }
});
