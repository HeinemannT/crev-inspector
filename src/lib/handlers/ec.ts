/**
 * EC execution, property save, and editor handlers.
 */

import { register } from '../handler-registry';
import { getCtx } from '../sw-context';
import { SCRIPT_PROPS } from '../types';
import { buildEditorContext, openEditorWindow, openExtendedWindow } from '../editor';
import { errorMessage, log } from '../logger';
import { invalidateRid } from '../enrichment';
import type { ActivityMeta } from '../types';
import { activityObject, activityObjectLabel, ecActivityDetail } from '../activity-format';
import { normalizeAndValidateIdentity, type IdentityChangeSet } from '../object-identity';
import { ENVIRONMENT_CHANGED_ERROR, environmentMatches, environmentToken } from '../environment';

// Props saved as EC string literals (saveCodeViaEc). SCRIPT_PROPS plus the
// TextElement HTML bodies — their typed binary save path rejects the value
// ("argument type mismatch"); `_o.change(text := "…")` is the verified route.
const SCRIPT_PROPS_SET = new Set<string>([...SCRIPT_PROPS, 'text', 'longText']);

register('EC_EXECUTE', async (msg, respond) => {
  const ctx = getCtx();
  if (!ctx.client) { respond({ type: 'EC_RESULT', ok: false, error: 'Not connected' }); return; }
  if (!environmentMatches(ctx, msg.environment)) {
    respond({ type: 'EC_RESULT', ok: false, error: ENVIRONMENT_CHANGED_ERROR });
    return;
  }
  const client = ctx.client;
  const startTime = Date.now();
  try {
    const result = await client.executeEc(msg.code, msg.objectRid, msg.transactional ?? false);
    const durationMs = Date.now() - startTime;
    respond({ type: 'EC_RESULT', ...result, durationMs });
    ctx.scriptHistory.record({
      code: msg.code, timestamp: Date.now(), ok: result.ok,
      mode: msg.transactional ? 'execute' : 'preview', durationMs,
    });
    if (msg.objectRid && result.ok) {
      const cached = ctx.cache.get(msg.objectRid);
      ctx.history.record({
        rid: msg.objectRid,
        name: cached?.name,
        type: cached?.type,
        businessId: cached?.businessId,
        templateBusinessId: cached?.templateBusinessId,
        action: 'ec-executed',
        timestamp: Date.now(),
      });
    }
    // Activity log: EC runs are first-class actions worth surfacing in the Log
    // tab — previously only enrichment / connection / detection touched it.
    const mode = msg.transactional ? 'execute' : 'preview';
    const object = msg.objectRid ? activityObject(msg.objectRid, ctx.cache.get(msg.objectRid)) : undefined;
    const target = object ? activityObjectLabel(object, msg.objectRid!) : 'standalone code';
    const property = msg.property ? ` · ${msg.property}` : '';
    const verb = msg.transactional ? 'Executed' : 'Previewed';
    const meta: ActivityMeta = {
      category: 'execution',
      action: mode,
      ...(object ? { object } : {}),
      durationMs,
    };
    const detail = ecActivityDetail(result);
    if (result.ok) {
      ctx.logActivity('success', `${verb} EC on ${target}${property} (${durationMs}ms)`, detail, meta);
    } else {
      ctx.logActivity('error', `EC ${mode} failed on ${target}${property} (${durationMs}ms)`, detail, meta);
    }
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    respond({ type: 'EC_RESULT', ok: false, error: errorMessage(e) });
    const object = msg.objectRid ? activityObject(msg.objectRid, ctx.cache.get(msg.objectRid)) : undefined;
    ctx.logActivity('error', `EC request failed on ${activityObjectLabel(object, msg.objectRid ?? 'standalone code')}`, errMsg, {
      category: 'execution',
      action: msg.transactional ? 'execute' : 'preview',
      ...(object ? { object } : {}),
    });
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
  if (!environmentMatches(ctx, msg.environment)) {
    respond({ type: 'SAVE_RESULT', ok: false, error: ENVIRONMENT_CHANGED_ERROR });
    return;
  }
  const client = ctx.client;
  const isCodeProp = SCRIPT_PROPS_SET.has(msg.property);
  const startTime = Date.now();
  try {
    const result = isCodeProp
      ? await client.saveCodeViaEc(msg.rid, msg.property, msg.value)
      : await client.saveProperty(msg.rid, msg.objectType, msg.property, msg.value);
    const durationMs = Date.now() - startTime;
    // Log the save outcome — useful when the editor reports failure but BMP
    // actually saved. If you see ok=true here but the UI says "save failed",
    // the response was lost between SW and the editor (MV3 SW unload race).
    log.debug('handler:save', `SAVE_PROPERTY ${msg.property} on ${msg.rid}: ok=${result.ok}, ${durationMs}ms${result.error ? `, error=${result.error}` : ''}`);
    respond({ type: 'SAVE_RESULT', ...result });
    const object = activityObject(msg.rid, ctx.cache.get(msg.rid));
    const label = activityObjectLabel(object, msg.rid);
    const meta: ActivityMeta = {
      category: 'change',
      action: 'save-property',
      object,
      durationMs,
    };
    if (result.ok) {
      ctx.logActivity('success', `Saved ${msg.property} on ${label} (${durationMs}ms)`, undefined, meta);
      // Drop the cached enrichment + re-fetch so badges / side panel
      // pick up any name/type/businessId change immediately. Fire-and-
      // forget; this doesn't block the editor's "saved" UI.
      invalidateRid(msg.rid).catch(e => log.swallow('handler:save:invalidate', e));
    } else {
      ctx.logActivity('error', `Save failed for ${msg.property} on ${label} (${durationMs}ms)`, result.error, meta);
    }
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    respond({ type: 'SAVE_RESULT', ok: false, error: errorMessage(e) });
    const object = activityObject(msg.rid, ctx.cache.get(msg.rid));
    ctx.logActivity('error', `Save request failed for ${msg.property} on ${activityObjectLabel(object, msg.rid)}`, errMsg, {
      category: 'change',
      action: 'save-property',
      object,
    });
    // Thrown save means SW lost track before BMP responded. Editor
    // window may already be torn down — surface via toast so the user
    // doesn't think the save silently succeeded.
    ctx.toast(`Save failed: ${errMsg}`, 'error');
  }
});

register('SAVE_IDENTITY', async (msg, respond) => {
  const ctx = getCtx();
  if (!ctx.client) {
    respond({ type: 'SAVE_IDENTITY_RESULT', ok: false, error: 'Not connected' });
    return;
  }
  if (!environmentMatches(ctx, msg.environment)) {
    respond({ type: 'SAVE_IDENTITY_RESULT', ok: false, error: ENVIRONMENT_CHANGED_ERROR });
    return;
  }
  const client = ctx.client;

  const validation = normalizeAndValidateIdentity(msg);
  if (!validation.ok) {
    respond({
      type: 'SAVE_IDENTITY_RESULT',
      ok: false,
      field: validation.field,
      error: validation.error,
    });
    return;
  }
  const { businessId, name, templateBusinessId } = validation.value;

  const startTime = Date.now();
  try {
    const before = await client.lookupIdentity(msg.rid);
    if (!before) {
      respond({ type: 'SAVE_IDENTITY_RESULT', ok: false, error: 'Could not read the current identity.' });
      return;
    }

    const changes: IdentityChangeSet = {};
    if (before.businessId !== businessId) changes.businessId = businessId;
    if (before.name !== name) changes.name = name;
    if (templateBusinessId !== undefined && before.templateBusinessId !== templateBusinessId) {
      changes.templateBusinessId = templateBusinessId;
    }

    const saved = await client.applyIdentityChanges(msg.rid, changes);
    if (!saved.ok && !saved.writeAttempted) {
      respond({ type: 'SAVE_IDENTITY_RESULT', ok: false, error: saved.error ?? 'Identity save failed' });
      return;
    }

    const stored = await client.lookupIdentity(msg.rid);
    if (!stored) {
      respond({
        type: 'SAVE_IDENTITY_RESULT',
        ok: false,
        error: saved.writeAttempted
          ? 'BMP may have saved some identity values, but the verification read failed. Reload the object before retrying.'
          : 'Could not verify the current identity.',
      });
      return;
    }
    const verified = stored?.businessId === businessId
      && stored.name === name
      && (templateBusinessId === undefined || stored.templateBusinessId === templateBusinessId);
    if (!verified) {
      const requestedValues = [
        ...(changes.businessId !== undefined
          ? [{ actual: stored.businessId, expected: changes.businessId }]
          : []),
        ...(changes.name !== undefined
          ? [{ actual: stored.name, expected: changes.name }]
          : []),
        ...(changes.templateBusinessId !== undefined
          ? [{ actual: stored.templateBusinessId, expected: changes.templateBusinessId }]
          : []),
      ];
      const anyRequestedValueLanded = requestedValues.some(value => value.actual === value.expected);
      const verificationError = anyRequestedValueLanded
        ? 'BMP applied only part of the identity change. The current values were refreshed; review them before retrying.'
        : 'BMP did not persist the requested identity values. The current values were refreshed for review.';
      respond({
        type: 'SAVE_IDENTITY_RESULT',
        ok: false,
        businessId: stored.businessId,
        name: stored?.name,
        templateBusinessId: stored?.templateBusinessId,
        error: saved.error ? `${saved.error} ${verificationError}` : verificationError,
      });
      return;
    }

    const durationMs = Date.now() - startTime;
    const object = activityObject(msg.rid, ctx.cache.get(msg.rid));
    ctx.logActivity('success', `Saved identity on ${activityObjectLabel(object, msg.rid)} (${durationMs}ms)`, undefined, {
      category: 'change',
      action: 'save-property',
      object,
      durationMs,
    });
    respond({ type: 'SAVE_IDENTITY_RESULT', ok: true, businessId, name, templateBusinessId });
    // The explicit lookup above already verified the write. Refreshing the
    // shared cache/badges is best-effort and must not turn a verified save
    // into a UI error if a later enrichment broadcast happens to fail.
    invalidateRid(msg.rid).catch(e => log.swallow('handler:saveIdentity:invalidate', e));
  } catch (e) {
    const error = errorMessage(e);
    respond({ type: 'SAVE_IDENTITY_RESULT', ok: false, error });
    ctx.logActivity('error', `Identity save failed on ${msg.rid}`, error, {
      category: 'change',
      action: 'save-property',
      object: activityObject(msg.rid, ctx.cache.get(msg.rid)),
    });
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
    ctx.history.record({
      rid: msg.rid,
      name: cached.name,
      type: cached.type,
      businessId: cached.businessId,
      templateBusinessId: cached.templateBusinessId,
      action: 'edited',
      timestamp: Date.now(),
    });
  }
});

register('FETCH_EDITOR_CONTEXT', (msg, respond, meta) => {
  void buildEditorContext(
    msg.rid,
    msg.property,
    { tabId: meta.senderTabId, windowId: meta.panelWindowId },
  ).then(
    context => respond({ type: 'EDITOR_CONTEXT_DATA', rid: msg.rid, context }),
    e => respond({
      type: 'EDITOR_CONTEXT_DATA',
      rid: msg.rid,
      context: {
        environment: environmentToken(getCtx()),
        instance: { rid: msg.rid, businessId: '', type: '', name: '' },
        template: null,
        instanceCode: {},
        templateCode: {},
        overrides: {},
        saveTarget: 'instance',
        property: msg.property ?? 'expression',
        loadError: e instanceof Error ? e.message : 'Failed to load editor context',
      },
    }),
  );
});

register('OPEN_EXTENDED', (_msg, _respond, meta) => {
  // Standalone Extended Code window — same path as the Ctrl+Shift+E command,
  // exposed in the sidepanel header so users without a shortcut can still open it.
  openExtendedWindow(undefined, { tabId: meta.senderTabId, windowId: meta.panelWindowId })
    .catch(e => log.swallow('handler:openExtended', e));
});
