import type { InspectorMessage, PaintPhase } from './types';
import { PAINT_STYLE_PROPS } from './types';
import { getCtx } from './sw-context';
import { log, errorMessage } from './logger';

/** Validate RID is numeric (prevents EC injection). */
function validateRid(rid: string): string {
  if (!/^-?\d+$/.test(rid)) throw new Error(`Invalid RID: ${rid}`);
  return rid;
}

let paintPhase: PaintPhase = 'off';
let paintSourceRid: string | null = null;
let paintSourceName: string | null = null;
let paintPendingTargetRid: string | null = null;

/** Push current paint state to the panel (called on panel connect). */
export function pushPaintState() {
  if (paintPhase === 'off') return; // no need to push default state
  const ctx = getCtx();
  ctx.sendToPanel({
    type: 'PAINT_STATE',
    phase: paintPhase,
    sourceRid: paintSourceRid ?? undefined,
    sourceName: paintSourceName ?? undefined,
  });
}

function broadcastPaintState() {
  const ctx = getCtx();
  const msg: InspectorMessage = {
    type: 'PAINT_STATE',
    phase: paintPhase,
    sourceRid: paintSourceRid ?? undefined,
    sourceName: paintSourceName ?? undefined,
  };
  ctx.sendToPanel(msg);
  ctx.broadcastToContent(msg);
}

function broadcastApplyResult(rid: string, ok: boolean, error?: string) {
  const ctx = getCtx();
  const msg: InspectorMessage = { type: 'PAINT_APPLY_RESULT', rid, ok, error };
  ctx.sendToPanel(msg);
  ctx.broadcastToContent(msg);
}

export async function togglePaint(ensureContentScript: (tabId: number) => Promise<void>) {
  const ctx = getCtx();
  if (paintPhase === 'off') {
    paintPhase = 'picking';
    paintSourceRid = null;
    paintSourceName = null;
    // Auto-enable inspect mode (labels must be visible for picking)
    if (!ctx.inspectActive) {
      ctx.inspectActive = true;
      chrome.storage.local.set({ crev_inspect_active: true }).catch(e => log.swallow('paint:persistInspect', e));
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tabId = tabs[0]?.id;
      if (tabId != null) await ensureContentScript(tabId);
      const inspMsg: InspectorMessage = { type: 'INSPECT_STATE', active: true };
      ctx.broadcastToContent(inspMsg);
      ctx.sendToPanel(inspMsg);
    }
  } else {
    paintPhase = 'off';
    paintSourceRid = null;
    paintSourceName = null;
    paintPendingTargetRid = null;
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
  broadcastPaintState();
}

/** Set paint source directly (from context menu). Transitions to applying phase. */
export function setPaintSource(rid: string, name?: string | null) {
  const cached = getCtx().cache.get(rid);
  paintSourceRid = rid;
  paintSourceName = name ?? cached?.name ?? cached?.businessId ?? rid;
  paintPhase = 'applying';
  broadcastPaintState();
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
      ? 'Not connected — configure in Connect tab'
      : 'No source selected');
    return;
  }

  await ctx.settingsReady;

  try {
    // Read style props from both source and target in a single EC call.
    // Each property read is isolated so one failure doesn't kill all reads.
    // Result is the last expression (not output() which silently crashes on Ref properties).
    const codeLines: string[] = [
      '_d := "|||"',
      `_s := lookup(${validateRid(paintSourceRid!)})`,
      `_t := lookup(${validateRid(rid)})`,
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
      ? 'Not connected — configure in Connect tab'
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

  const propAssignments = PAINT_STYLE_PROPS.map(p => `${p} := _src.${p}.whenMissing("")`).join(', ');
  const code = [
    `_src := lookup(${validateRid(paintSourceRid!)})`,
    `_tgt := lookup(${validateRid(targetRid)})`,
    `_tgt.change(${propAssignments})`,
  ].join('\n');

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
