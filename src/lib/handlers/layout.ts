/**
 * Blueprint layout-builder handlers. Thin: resolve context + load, or apply an edit. All the
 * logic lives in layout-service (shell) + layout/ (pure core). The SW is stateless per request —
 * the panel owns the editable model + history and passes baseline+desired back on apply.
 */
import { register } from '../handler-registry';
import { getCtx } from '../sw-context';
import { loadPage, applyPage } from '../layout-service';
import { errorMessage } from '../logger';

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
      type: 'LAYOUT_LOAD_RESULT', ok: true,
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
  const t0 = Date.now();
  try {
    const res = await applyPage(ctx.client, msg.ctx, msg.baseline, msg.desired);
    respond({
      type: 'LAYOUT_APPLY_RESULT', ok: res.ok, noop: res.noop,
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
