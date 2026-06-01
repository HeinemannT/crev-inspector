import type { InspectorMessage, PaintPhase } from './types';
import { PAINT_STYLE_PROPS, COLOR_LINK_PROPS } from './types';
import { getCtx } from './sw-context';
import { log, errorMessage } from './logger';

let paintPhase: PaintPhase = 'off';
let paintSourceRid: string | null = null;
let paintSourceName: string | null = null;
let paintPendingTargetRid: string | null = null;
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
    paintPendingTargetRid = null;
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
  paintPendingTargetRid = null;
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

export async function handlePaintApply(rid: string) {
  const ctx = getCtx();
  if (!paintSourceRid || !ctx.client) {
    broadcastApplyResult(rid, false, !ctx.client
      ? 'Not connected. Configure in Connect tab'
      : 'No source selected');
    return;
  }

  await ctx.settingsReady;

  try {
    // Read style props from both source and target in a single EC call.
    // Each property read is isolated so one failure doesn't kill all reads.
    // Result is the last expression (not output() which silently crashes on Ref properties).
    const [srcRef, tgtRef] = await Promise.all([
      ctx.client.resolveRef(paintSourceRid!),
      ctx.client.resolveRef(rid),
    ]);
    const codeLines: string[] = [
      '_d := "|||"',
      `_s := ${srcRef}`,
      `_t := ${tgtRef}`,
      '_sr := ""',
      '_tr := ""',
    ];
    for (const p of PAINT_STYLE_PROPS) {
      codeLines.push(`_sr := _sr + _d + _s.${p}.whenMissing("")`);
      codeLines.push(`_tr := _tr + _d + _t.${p}.whenMissing("")`);
    }
    codeLines.push('"SRC" + _sr + "\\nTGT" + _tr');
    const code = codeLines.join('\n');

    const result = await ctx.client.executeEc(code, undefined, false);
    log.info('paint:compare', `EC result ok=${result.ok} log=${JSON.stringify((result.log ?? '').slice(0, 200))}`);
    if (!result.ok) {
      broadcastApplyResult(rid, false, result.error ?? 'Failed to read style properties');
      return;
    }

    // Parse result: last expression = "SRC|||v1|||v2...\nTGT|||v1|||v2..."
    // Each line in result.log is an EC entry; find the SRC/TGT lines.
    const lines = (result.log ?? '').trim().split('\n');
    const srcLine = lines.find(l => l.startsWith('SRC|||')) ?? '';
    const tgtLine = lines.find(l => l.startsWith('TGT|||')) ?? '';
    // Split on ||| and skip index 0 (the SRC/TGT label)
    const srcVals = srcLine.split('|||').slice(1);
    const tgtVals = tgtLine.split('|||').slice(1);
    log.info('paint:parsed', `src=[${srcVals.join(',')}] tgt=[${tgtVals.join(',')}]`);

    const diff: Array<{ prop: string; from: string; to: string }> = [];
    for (let i = 0; i < PAINT_STYLE_PROPS.length; i++) {
      const from = (tgtVals[i] ?? '').trim();
      const to = (srcVals[i] ?? '').trim();
      if (from !== to) {
        diff.push({ prop: PAINT_STYLE_PROPS[i], from: from || '(empty)', to: to || '(empty)' });
      }
    }

    if (diff.length === 0) {
      ctx.logActivity('info', `Paint: styles identical (src=${srcVals.join(',')}, tgt=${tgtVals.join(',')})`);
      ctx.broadcastToContent({ type: 'PAINT_PREVIEW', rid, diff: [] });
      return;
    }

    paintPendingTargetRid = rid;
    ctx.broadcastToContent({ type: 'PAINT_PREVIEW', rid, diff });
  } catch (e) {
    broadcastApplyResult(rid, false, errorMessage(e));
  }
}

async function executePaintApply(rid: string) {
  const ctx = getCtx();
  if (!paintSourceRid || !ctx.client) {
    broadcastApplyResult(rid, false, !ctx.client
      ? 'Not connected. Configure in Connect tab'
      : 'No source selected');
    return;
  }

  await ctx.settingsReady;

  // When saveTarget is 'template', resolve target's template first
  let targetRid = rid;
  if (ctx.settings.saveTarget === 'template') {
    try {
      const tmpl = await ctx.client.resolveTemplate(rid);
      if (tmpl.templateRid) targetRid = tmpl.templateRid;
    } catch (e) { log.swallow('paint:resolveTemplate', e); }
  }

  const [srcRef, tgtRef] = await Promise.all([
    ctx.client.resolveRef(paintSourceRid!),
    ctx.client.resolveRef(targetRid),
  ]);
  // Value props (enums/numbers/booleans) copy via whenMissing("").
  // Colour props are CorpoColor LINKS: assigning "" to a colour reference
  // errors, so copy the link only when the source actually has one (copying a
  // style adds the source's look — it shouldn't clear the target's colours).
  const valueProps = PAINT_STYLE_PROPS.filter(p => !COLOR_LINK_PROPS.has(p));
  const colorProps = PAINT_STYLE_PROPS.filter(p => COLOR_LINK_PROPS.has(p));
  const lines = [`_src := ${srcRef}`, `_tgt := ${tgtRef}`];
  if (valueProps.length > 0) {
    lines.push(`_tgt.change(${valueProps.map(p => `${p} := _src.${p}.whenMissing("")`).join(', ')})`);
  }
  for (const p of colorProps) {
    lines.push(`IF _src.${p} != MISSING THEN _tgt.change(${p} := _src.${p}) ENDIF`);
  }
  const code = lines.join('\n');

  try {
    const result = await ctx.client.executeEc(code, undefined, true);
    broadcastApplyResult(rid, result.ok, result.error ?? (result.hasError ? result.log : undefined));
  } catch (e) {
    broadcastApplyResult(rid, false, errorMessage(e));
  }
}

export async function handlePaintConfirm(rid: string) {
  const targetRid = paintPendingTargetRid ?? rid;
  paintPendingTargetRid = null;
  await executePaintApply(targetRid);
}
