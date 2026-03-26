/**
 * Object lookup, cache, and linked object handlers.
 */

import { register } from '../handler-registry';
import { getCtx } from '../sw-context';
import { CODE_PROPS_FOR_TYPE } from '../types';
import { resetEnrichment } from '../enrichment';
import { errorMessage, log } from '../logger';
import { CODE_BEARING_TYPES } from '../namespace';
import type { BmpObject } from '../types';

// ── Shared lookup utility ────────────────────────────────────────

async function lookupObject(rid: string): Promise<BmpObject> {
  const ctx = getCtx();
  if (!ctx.client) throw new Error('Not connected');

  const identity = await ctx.client.lookupIdentity(rid);
  if (!identity) throw new Error('Object not found');

  const now = Date.now();
  const properties: Record<string, unknown> = {};
  const type = identity.type ?? '';
  const propsToFetch = CODE_PROPS_FOR_TYPE[type];
  if (propsToFetch) {
    try {
      const codeProps = await ctx.client.fetchCodeViaEc(rid, [...propsToFetch]);
      Object.assign(properties, codeProps);
    } catch (e) {
      log.swallow('handler:fetchCodeProps', e);
    }
  }

  const obj: BmpObject = {
    rid,
    name: identity.name,
    type: identity.type,
    businessId: identity.businessId,
    templateBusinessId: identity.templateBusinessId,
    properties,
    source: 'server',
    discoveredAt: now,
    updatedAt: now,
  };

  ctx.cache.put(obj);
  return obj;
}

// ── Linked object definitions ────────────────────────────────────

interface LinkedObjectDef {
  key: string;
  label: string;
  ecProperty: string;
}

const LINKED_OBJECTS: Record<string, LinkedObjectDef[]> = {
  InputView: [
    { key: 'inputset', label: 'InputSet', ecProperty: 'inputset' },
  ],
  CreateObjectView: [
    { key: 'editpage', label: 'EditPage', ecProperty: 'editPage' },
  ],
};

export function getLinkedDefs(objectType: string): LinkedObjectDef[] {
  return LINKED_OBJECTS[objectType] ?? [];
}

// ── Handlers ─────────────────────────────────────────────────────

register('GET_CACHE', (msg, respond) => {
  const ctx = getCtx();
  const objects = msg.filter ? ctx.cache.search(msg.filter) : ctx.cache.getAll();
  respond({ type: 'CACHE_DATA', objects });
});

register('HOVER_LOOKUP', async (msg, respond) => {
  const ctx = getCtx();
  // Fast path: check cache (includes code preview if properties were fetched)
  const cached = ctx.cache.get(msg.rid);
  if (cached?.name || cached?.type) {
    const codePreview = extractCachedCode(cached);
    respond({ type: 'HOVER_LOOKUP_RESULT', rid: msg.rid, name: cached.name, objectType: cached.type, businessId: cached.businessId, codePreview });
    return;
  }
  // Slow path: EC lookup (identity only — no code fetch for RID lookups)
  if (!ctx.client) { respond({ type: 'HOVER_LOOKUP_RESULT', rid: msg.rid }); return; }
  try {
    const identity = await ctx.client.lookupIdentity(msg.rid);
    respond({
      type: 'HOVER_LOOKUP_RESULT', rid: msg.rid,
      name: identity?.name, objectType: identity?.type, businessId: identity?.businessId,
    });
  } catch {
    respond({ type: 'HOVER_LOOKUP_RESULT', rid: msg.rid });
  }
}, true);

/** Extract code preview from a cached object's properties (if code-bearing type). */
function extractCachedCode(obj: BmpObject): string | undefined {
  if (!obj.type || !obj.properties || !CODE_BEARING_TYPES.has(obj.type)) return undefined;
  const props = obj.properties as Record<string, unknown>;
  const code = (props.expression ?? props.html ?? props.javascript) as string | undefined;
  if (!code || typeof code !== 'string') return undefined;
  return code.length > 500 ? code.slice(0, 500) : code;
}

register('HOVER_RESOLVE', async (msg, respond) => {
  const ctx = getCtx();
  if (!ctx.client) { respond({ type: 'HOVER_RESOLVE_RESULT', ref: msg.ref }); return; }
    try {
      // EC: resolve namespace.bid reference to identity + code preview in one call.
      // output() returns raw text without evaluating the expression.
      // Code is only fetched for known code-bearing types (IF/ELSE guards).
      const codeBearingCheck = [...CODE_BEARING_TYPES].map(t => `_cls = "${t}"`).join(' OR ');
      const ec = [
        `_o := ${msg.ref}`,
        '_cls := _o.className.whenMissing("")',
        `_code := IF ${codeBearingCheck} THEN output(_o.expression.whenMissing("")) ELSE "" ENDIF`,
        '_o.name.whenMissing("") + "|||" + _cls + "|||" + _o.rid.whenMissing("") + "|||" + _o.id.whenMissing("") + "|||" + _code',
      ].join('\n');
      const result = await ctx.client.executeEc(ec, undefined, false);
      if (!result.ok || !result.log?.includes('|||')) {
        respond({ type: 'HOVER_RESOLVE_RESULT', ref: msg.ref });
        return;
      }
      const line = result.log.trim().split('\n').find(l => l.includes('|||'));
      if (!line) { respond({ type: 'HOVER_RESOLVE_RESULT', ref: msg.ref }); return; }
      const parts = line.split('|||').map(s => s.trim());
      const codeRaw = parts.slice(4).join('|||').trim(); // code may contain ||| inside
      const codePreview = codeRaw && codeRaw.length > 500 ? codeRaw.slice(0, 500) : (codeRaw || undefined);
      respond({
        type: 'HOVER_RESOLVE_RESULT', ref: msg.ref,
        name: parts[0] || undefined, objectType: parts[1] || undefined,
        rid: parts[2] || undefined, businessId: parts[3] || undefined,
        codePreview,
      });
    } catch {
      respond({ type: 'HOVER_RESOLVE_RESULT', ref: msg.ref });
    }
}, true);

register('CLEAR_CACHE', (msg, respond) => {
  const ctx = getCtx();
  ctx.cache.clear();
  resetEnrichment();
  respond({ type: 'CACHE_STATS', count: 0 });
});

register('OBJECTS_DISCOVERED', (msg) => {
  const ctx = getCtx();
  ctx.cache.putAll(msg.objects);
  ctx.logActivity('success', `Found ${msg.objects.length} object${msg.objects.length !== 1 ? 's' : ''}`);
  ctx.sendToPanel({ type: 'CACHE_STATS', count: ctx.cache.size });
});

register('SERVER_LOOKUP', async (msg) => {
  const ctx = getCtx();
  try {
    const obj = await lookupObject(msg.rid);
    ctx.history.record({ rid: msg.rid, name: obj.name, type: obj.type, businessId: obj.businessId, action: 'viewed', timestamp: Date.now() });
    ctx.sendToPanel({ type: 'SERVER_LOOKUP_RESULT', rid: msg.rid, object: obj });
  } catch (e) {
    ctx.sendToPanel({ type: 'SERVER_LOOKUP_RESULT', rid: msg.rid, object: null, error: errorMessage(e) });
  }
});

register('LINKED_LOOKUP', async (msg) => {
  const ctx = getCtx();
  const defs = getLinkedDefs(msg.objectType);
  if (defs.length === 0) return;

  if (!ctx.client) {
    for (const def of defs) {
      ctx.sendToPanel({ type: 'LINKED_LOOKUP_RESULT', rid: msg.rid, key: def.key, label: def.label, error: 'Not connected' });
    }
    return;
  }

  let ref: string;
  try {
    ref = await ctx.client.resolveRef(msg.rid);
  } catch (e) {
    for (const def of defs) {
      ctx.sendToPanel({ type: 'LINKED_LOOKUP_RESULT', rid: msg.rid, key: def.key, label: def.label, error: errorMessage(e) });
    }
    return;
  }

  for (const def of defs) {
    try {
      const code = [
        `_p := ${ref}`,
        `_l := _p.${def.ecProperty}`,
        'IF _l != MISSING THEN',
        '  _l.id.whenMissing("") + "|||" + _l.name.whenMissing("") + "|||" + _l.rid.whenMissing("")',
        'ELSE',
        '  ""',
        'ENDIF',
      ].join('\n');
      const result = await ctx.client.executeEc(code, undefined, false);
      if (!result.ok || !result.log?.includes('|||')) {
        ctx.sendToPanel({ type: 'LINKED_LOOKUP_RESULT', rid: msg.rid, key: def.key, label: def.label });
        continue;
      }
      const line = result.log.trim().split('\n').find(l => l.includes('|||'));
      if (!line) {
        ctx.sendToPanel({ type: 'LINKED_LOOKUP_RESULT', rid: msg.rid, key: def.key, label: def.label });
        continue;
      }
      const [lId, lName, lRid] = line.split('|||').map(s => s.trim());
      ctx.sendToPanel({
        type: 'LINKED_LOOKUP_RESULT', rid: msg.rid, key: def.key, label: def.label,
        linkedId: lId || undefined, linkedName: lName || undefined, linkedRid: lRid || undefined,
      });
    } catch (e) {
      ctx.sendToPanel({ type: 'LINKED_LOOKUP_RESULT', rid: msg.rid, key: def.key, label: def.label, error: errorMessage(e) });
    }
  }
});

register('FULL_LOOKUP', async (msg, respond) => {
  const ctx = getCtx();
  try {
    const obj = await lookupObject(msg.rid);
    let template: { rid: string; name: string; type: string; businessId?: string } | undefined;
    if (ctx.client) {
      const tmpl = await ctx.client.resolveTemplate(msg.rid);
      if (tmpl.templateRid) {
        template = { rid: tmpl.templateRid, name: tmpl.templateName ?? '', type: tmpl.templateType ?? '', businessId: tmpl.templateBusinessId };
      }
    }
    const children = ctx.client ? await ctx.client.fetchChildren(msg.rid) : [];
    respond({ type: 'FULL_LOOKUP_RESULT', rid: msg.rid, object: obj, template, children });
  } catch (e) {
    respond({ type: 'FULL_LOOKUP_RESULT', rid: msg.rid, object: null, error: errorMessage(e) });
  }
}, true);

register('GET_OVERLAY_PROPS', (msg, respond) => {
  const ctx = getCtx();
  const result: Record<string, Record<string, string>> = {};
  for (const rid of msg.rids) {
    const cached = ctx.cache.get(rid);
    if (cached?.properties) {
      const props: Record<string, string> = {};
      for (const [k, v] of Object.entries(cached.properties as Record<string, unknown>)) {
        if (v != null && v !== '' && typeof v === 'string') props[k] = v;
        else if (v != null && v !== '' && v !== false) props[k] = String(v);
      }
      result[rid] = props;
    }
  }
  respond({ type: 'OVERLAY_PROPS_DATA', props: result });
}, true);
