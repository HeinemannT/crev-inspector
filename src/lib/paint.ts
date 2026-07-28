import type { InspectorMessage, PaintPhase } from './types';
import { PAINT_STYLE_PROPS, PAINT_PROP_RESET } from './types';
import { getCtx } from './sw-context';
import { log, errorMessage } from './logger';
import { activityObject, activityObjectLabel, boundedActivityDetail, ecActivityDetail } from './activity-format';

let paintPhase: PaintPhase = 'off';
let paintSourceRid: string | null = null;
let paintSourceName: string | null = null;
/** Tab paint is armed for. Lets us cancel precisely when THAT tab
 *  navigates/refreshes, instead of relying on the active-tab map (which is
 *  empty until the first tab switch — the cause of the "stuck brush after
 *  refresh" bug). */
let paintTabId: number | null = null;

/** The current paint state as a PAINT_STATE message. Single builder so every
 *  push (panel connect, content connect, broadcast) carries identical state —
 *  the SW is the one source of truth and every consumer re-syncs from it. */
export function paintStateMessage(): InspectorMessage {
  return {
    type: 'PAINT_STATE',
    phase: paintPhase,
    sourceRid: paintSourceRid ?? undefined,
    sourceName: paintSourceName ?? undefined,
  };
}

/** Push current paint state to the panel (called on panel connect/reconnect).
 *  Pushed ALWAYS — including 'off' — so a panel that reconnects after an MV3
 *  SW idle-reset (which wipes paintPhase back to 'off') corrects a stale
 *  "armed" indicator instead of keeping it. Symmetric with the content push. */
export function pushPaintState() {
  getCtx().sendToPanel(paintStateMessage());
}

function broadcastPaintState() {
  const ctx = getCtx();
  const msg = paintStateMessage();
  ctx.sendToPanel(msg);
  ctx.broadcastToContent(msg);
}

function broadcastApplyResult(rid: string, ok: boolean, error?: string) {
  const ctx = getCtx();
  const msg: InspectorMessage = { type: 'PAINT_APPLY_RESULT', rid, ok, error };
  ctx.sendToPanel(msg);
  ctx.broadcastToContent(msg);
}

export async function togglePaint(ensureContentScript: (tabId: number) => Promise<void>, panelWindowId?: number) {
  const ctx = getCtx();
  if (paintPhase === 'off') {
    paintPhase = 'picking';
    paintSourceRid = null;
    paintSourceName = null;
    // Auto-enable inspect mode (labels must be visible for picking).
    // Per-window: paint launched from panel A auto-enables inspect
    // only in window A — other windows' BMP tabs stay quiet.
    const query: chrome.tabs.QueryInfo = panelWindowId != null
      ? { active: true, windowId: panelWindowId }
      : { active: true, lastFocusedWindow: true };
    const tabs = await chrome.tabs.query(query);
    const tabId = tabs[0]?.id;
    paintTabId = tabId ?? null;
    const targetWindowId = panelWindowId ?? tabs[0]?.windowId;
    if (targetWindowId != null && !ctx.isInspectActive(targetWindowId)) {
      ctx.setInspectActive(targetWindowId, true);
      if (tabId != null) await ensureContentScript(tabId);
      const inspMsg: InspectorMessage = { type: 'INSPECT_STATE', active: true };
      ctx.sendToPanelByWindow(targetWindowId, inspMsg);
      if (tabId != null) {
        chrome.tabs.sendMessage(tabId, inspMsg).catch(e => log.swallow('paint:notifyTab', e));
      }
    }
  } else {
    paintPhase = 'off';
    paintSourceRid = null;
    paintSourceName = null;
    paintTabId = null;
  }
  broadcastPaintState();
}

/** Cancel paint mode (tab switch, navigation, refresh). */
export function cancelPaint() {
  if (paintPhase === 'off') return;
  paintPhase = 'off';
  paintSourceRid = null;
  paintSourceName = null;
  paintTabId = null;
  broadcastPaintState();
}

/** Cancel paint only if it's armed for `tabId` (or no tab was recorded).
 *  Used on navigation/refresh so refreshing the painted tab clears the
 *  brush, while a refresh in some OTHER tab leaves an active session alone. */
export function cancelPaintForTab(tabId: number) {
  if (paintPhase === 'off') return;
  if (paintTabId != null && paintTabId !== tabId) return;
  cancelPaint();
}

export function handlePaintPick(rid: string) {
  const cached = getCtx().cache.get(rid);
  paintSourceRid = rid;
  paintSourceName = cached?.name ?? cached?.businessId ?? rid;
  paintPhase = 'applying';
  broadcastPaintState();
}

/** Which style props this paint session writes — the user's right-click
 *  selection, intersected with the known prop list (order preserved) so a
 *  stale/garbage setting can never inject an unknown property name into EC. */
function activePaintProps(ctx: ReturnType<typeof getCtx>): string[] {
  const selected = new Set(ctx.settings.paintProps ?? PAINT_STYLE_PROPS);
  return PAINT_STYLE_PROPS.filter(p => selected.has(p));
}

/**
 * Apply the picked source's style to `rid` and IMMEDIATELY commit — no preview
 * step. Paint stays armed (`phase` unchanged) so the user keeps clicking
 * targets; the content script flashes each one + shows a Reload toast.
 */
export async function handlePaintApply(rid: string) {
  const ctx = getCtx();
  const startedAt = Date.now();
  const object = activityObject(rid, ctx.cache.get(rid));
  const targetName = activityObjectLabel(object, rid);
  const meta = {
    category: 'paint' as const,
    action: 'apply-style',
    object,
  };
  if (!paintSourceRid || !ctx.client) {
    const error = !ctx.client
      ? 'Not connected. Configure in Connect tab'
      : 'No source selected';
    broadcastApplyResult(rid, false, error);
    ctx.logActivity('error', `Paint failed on ${targetName}`, error, meta);
    return;
  }

  await ctx.settingsReady;

  const props = activePaintProps(ctx);
  if (props.length === 0) {
    const error = 'No styles selected. Right-click the paint button to choose which to copy.';
    broadcastApplyResult(rid, false, error);
    ctx.logActivity('error', `Paint failed on ${targetName}`, error, meta);
    return;
  }

  // When saveTarget is 'template', resolve target's template first.
  let targetRid = rid;
  if (ctx.settings.saveTarget === 'template') {
    try {
      const tmpl = await ctx.client.resolveTemplate(rid);
      if (tmpl.templateRid) targetRid = tmpl.templateRid;
    } catch (e) { log.swallow('paint:resolveTemplate', e); }
  }

  try {
    const [srcRef, tgtRef] = await Promise.all([
      ctx.client.resolveRef(paintSourceRid!),
      ctx.client.resolveRef(targetRid),
    ]);
    // One independent conditional per prop: copy the source's value when it has
    // one, otherwise RESET the target to "no styling" with a TYPE-CORRECT empty
    // (PAINT_PROP_RESET — colour:"" / number:0 / bool:FALSE / enum:"None").
    //
    // Per-prop (not a single batched change()) is deliberate: `prop := ""`
    // ERRORS on number/enum props, so one missing source prop must not abort
    // the whole paint — and `:= MISSING` is a no-op so it can't reset either.
    // All branches live-verified 2026-06-02. This is what lets painting a
    // header-less source onto a coloured widget actually clear the colour.
    const lines = [`_src := ${srcRef}`, `_tgt := ${tgtRef}`];
    for (const p of props) {
      const reset = PAINT_PROP_RESET[p] ?? '""';
      lines.push(`IF _src.${p} != MISSING THEN _tgt.change(${p} := _src.${p}) ELSE _tgt.change(${p} := ${reset}) ENDIF`);
    }
    const code = lines.join('\n');

    const result = await ctx.client.executeEc(code, undefined, true);
    broadcastApplyResult(rid, result.ok, result.error ?? (result.hasError ? result.log : undefined));
    const durationMs = Date.now() - startedAt;
    const summary = `Source: ${paintSourceName ?? paintSourceRid}\nProperties: ${props.length}`;
    const serverDetail = ecActivityDetail(result);
    const detail = boundedActivityDetail(serverDetail ? `${summary}\n\nBMP output\n${serverDetail}` : summary);
    ctx.logActivity(
      result.ok ? 'success' : 'error',
      result.ok
        ? `Painted ${props.length} style propert${props.length === 1 ? 'y' : 'ies'} onto ${targetName} (${durationMs}ms)`
        : `Paint failed on ${targetName} (${durationMs}ms)`,
      detail,
      { ...meta, durationMs },
    );
  } catch (e) {
    const error = errorMessage(e);
    const durationMs = Date.now() - startedAt;
    broadcastApplyResult(rid, false, error);
    ctx.logActivity('error', `Paint request failed on ${targetName} (${durationMs}ms)`, error, {
      ...meta,
      durationMs,
    });
  }
}
