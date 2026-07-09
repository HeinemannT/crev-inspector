/**
 * EC execution, property save, and editor handlers.
 */

import { register } from '../handler-registry';
import { getCtx } from '../sw-context';
import { SCRIPT_PROPS } from '../types';
import { openEditorWindow, openExtendedWindow } from '../editor';
import { errorMessage, log } from '../logger';
import { invalidateRid } from '../enrichment';

// Props saved as EC string literals (saveCodeViaEc). SCRIPT_PROPS plus the
// TextElement HTML bodies — their typed binary save path rejects the value
// ("argument type mismatch"); `_o.change(text := "…")` is the verified route.
const SCRIPT_PROPS_SET = new Set<string>([...SCRIPT_PROPS, 'text', 'longText']);

register('EC_EXECUTE', async (msg, respond) => {
  const ctx = getCtx();
  if (!ctx.client) { respond({ type: 'EC_RESULT', ok: false, error: 'Not connected' }); return; }
  const startTime = Date.now();
  try {
    const result = await ctx.client.executeEc(msg.code, msg.objectRid, msg.transactional ?? false);
    const durationMs = Date.now() - startTime;
    respond({ type: 'EC_RESULT', ...result, durationMs });
    ctx.scriptHistory.record({
      code: msg.code, timestamp: Date.now(), ok: result.ok,
      mode: msg.transactional ? 'execute' : 'preview', durationMs,
    });
    if (msg.objectRid && result.ok) {
      const cached = ctx.cache.get(msg.objectRid);
      ctx.history.record({ rid: msg.objectRid, name: cached?.name, type: cached?.type, businessId: cached?.businessId, action: 'ec-executed', timestamp: Date.now() });
    }
    // Activity log: EC runs are first-class actions worth surfacing in the Log
    // tab — previously only enrichment / connection / detection touched it.
    const mode = msg.transactional ? 'execute' : 'preview';
    const lineCount = msg.code.split('\n').length;
    const target = msg.objectRid ? ` against ${msg.objectRid}` : '';
    if (result.ok) {
      ctx.logActivity('success', `EC ${mode}${target} (${lineCount} line${lineCount === 1 ? '' : 's'}, ${durationMs}ms)`);
    } else {
      ctx.logActivity('warn', `EC ${mode} failed${target}`, result.error);
    }
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    respond({ type: 'EC_RESULT', ok: false, error: errorMessage(e) });
    ctx.logActivity('error', 'EC threw', errMsg);
    // Thrown EC (vs result.ok=false) means BMP never even saw the
    // request — usually auth/network. Editor surfaces ok=false inline,
    // but a thrown error can race the SW unload and leave the editor
    // hanging. Toast guarantees user feedback regardless of which
    // surface initiated the run.
    ctx.toast(`EC threw: ${errMsg}`, 'error');
  }
});

register('SAVE_PROPERTY', async (msg, respond) => {
  const ctx = getCtx();
  if (!ctx.client) { respond({ type: 'SAVE_RESULT', ok: false, error: 'Not connected' }); return; }
  const isCodeProp = SCRIPT_PROPS_SET.has(msg.property);
  const startTime = Date.now();
  try {
    const result = isCodeProp
      ? await ctx.client.saveCodeViaEc(msg.rid, msg.property, msg.value)
      : await ctx.client.saveProperty(msg.rid, msg.objectType, msg.property, msg.value);
    const durationMs = Date.now() - startTime;
    // Log the save outcome — useful when the editor reports failure but BMP
    // actually saved. If you see ok=true here but the UI says "save failed",
    // the response was lost between SW and the editor (MV3 SW unload race).
    log.debug('handler:save', `SAVE_PROPERTY ${msg.property} on ${msg.rid}: ok=${result.ok}, ${durationMs}ms${result.error ? `, error=${result.error}` : ''}`);
    respond({ type: 'SAVE_RESULT', ...result });
    if (result.ok) {
      // Drop the cached enrichment + re-fetch so badges / side panel
      // pick up any name/type/businessId change immediately. Fire-and-
      // forget; this doesn't block the editor's "saved" UI.
      invalidateRid(msg.rid).catch(e => log.swallow('handler:save:invalidate', e));
    }
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    respond({ type: 'SAVE_RESULT', ok: false, error: errorMessage(e) });
    ctx.logActivity('error', `Save threw on ${msg.rid}`, errMsg);
    // Thrown save means SW lost track before BMP responded. Editor
    // window may already be torn down — surface via toast so the user
    // doesn't think the save silently succeeded.
    ctx.toast(`Save failed: ${errMsg}`, 'error');
  }
});

register('OPEN_EDITOR', (msg, _respond, meta) => {
  // Source-aware mount target: a content script that fired OPEN_EDITOR
  // mounts on its own tab; a side-panel-initiated OPEN_EDITOR mounts on
  // the panel's window's active tab. Without this, two-panel users could
  // click "Open Editor" in panel A and have the editor land on window B's
  // tab (whichever was most recently focused).
  void openEditorWindow(
    msg.rid,
    msg.property,
    { tabId: meta.senderTabId, windowId: meta.panelWindowId },
    { scrollToLine: msg.scrollToLine, scrollToText: msg.scrollToText },
  );
  const ctx = getCtx();
  const cached = ctx.cache.get(msg.rid);
  if (cached) {
    ctx.history.record({ rid: msg.rid, name: cached.name, type: cached.type, businessId: cached.businessId, action: 'edited', timestamp: Date.now() });
  }
});

register('OPEN_EXTENDED', (_msg, _respond, meta) => {
  // Standalone Extended Code window — same path as the Ctrl+Shift+E command,
  // exposed in the sidepanel header so users without a shortcut can still open it.
  openExtendedWindow(undefined, { tabId: meta.senderTabId, windowId: meta.panelWindowId })
    .catch(e => log.swallow('handler:openExtended', e));
});
