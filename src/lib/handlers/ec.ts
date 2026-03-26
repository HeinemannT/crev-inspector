/**
 * EC execution, property save, and editor handlers.
 */

import { register } from '../handler-registry';
import { getCtx } from '../sw-context';
import { SCRIPT_PROPS } from '../types';
import { openEditorWindow } from '../editor';
import { errorMessage } from '../logger';

const SCRIPT_PROPS_SET = new Set<string>(SCRIPT_PROPS);

register('EC_EXECUTE', async (msg, respond) => {
  const ctx = getCtx();
  if (!ctx.client) { respond({ type: 'EC_RESULT', ok: false, error: 'Not connected' }); return; }
  const startTime = Date.now();
  try {
    const result = await ctx.client.executeEc(msg.code, msg.objectRid, msg.transactional ?? false);
    const durationMs = Date.now() - startTime;
    respond({ type: 'EC_RESULT', ...result });
    ctx.scriptHistory.record({
      code: msg.code, timestamp: Date.now(), ok: result.ok,
      mode: msg.transactional ? 'execute' : 'preview', durationMs,
    });
    if (msg.objectRid && result.ok) {
      const cached = ctx.cache.get(msg.objectRid);
      ctx.history.record({ rid: msg.objectRid, name: cached?.name, type: cached?.type, businessId: cached?.businessId, action: 'ec-executed', timestamp: Date.now() });
    }
  } catch (e) {
    respond({ type: 'EC_RESULT', ok: false, error: errorMessage(e) });
  }
}, true);

register('SAVE_PROPERTY', async (msg, respond) => {
  const ctx = getCtx();
  if (!ctx.client) { respond({ ok: false, error: 'Not connected' }); return; }
  const isCodeProp = SCRIPT_PROPS_SET.has(msg.property);
  try {
    const result = isCodeProp
      ? await ctx.client.saveCodeViaEc(msg.rid, msg.property, msg.value)
      : await ctx.client.saveProperty(msg.rid, msg.objectType, msg.property, msg.value);
    respond(result);
  } catch (e) {
    respond({ ok: false, error: errorMessage(e) });
  }
}, true);

register('OPEN_EDITOR', (msg) => {
  openEditorWindow(msg.rid);
  const ctx = getCtx();
  const cached = ctx.cache.get(msg.rid);
  if (cached) {
    ctx.history.record({ rid: msg.rid, name: cached.name, type: cached.type, businessId: cached.businessId, action: 'edited', timestamp: Date.now() });
  }
});
