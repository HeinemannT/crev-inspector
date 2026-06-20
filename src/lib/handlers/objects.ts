/**
 * Object lookup, cache, and linked object handlers.
 */

import { register } from '../handler-registry';
import { getCtx } from '../sw-context';
import { CODE_PROPS_FOR_TYPE } from '../types';
import { incrementGeneration, invalidateRid } from '../enrichment';
import { clearActivityLog } from '../activity';
import { clearAllContextRids, setContextRid } from '../context-rid';
import { errorMessage, log } from '../logger';
import { CODE_BEARING_TYPES } from '../namespace';
import { getColorSets, setColorSets } from '../color-set-cache';
import type { BmpObject } from '../types';
import type { TemplateResolution } from '../bmp-client';
import * as schemaCache from '../type-schema-cache';
import { refFieldsFromSchema, buildConnectionsEc, parseConnections, buildJunctionEc, parseJunctions, pickFarSide, buildInboundEc, parseInbound, type SchemaProp } from '../connections';
import type { ConnGroup } from '../types';

// ── EC builders (exported for tests) ─────────────────────────────

/** Build the EC that resolves a `namespace.bid` ref to identity + code preview.
 *
 *  CRITICAL: the inline IF after `:=` MUST be parenthesised — bare
 *  `_x := IF ... ENDIF` is a parse error in EC and silently breaks the
 *  whole hover. See `ec-codegen.test.ts` for the validator that codifies
 *  this rule; this builder is exported so a regression test can re-assert
 *  it for the hover path. */
export function buildHoverResolveEc(ref: string): string {
  const codeBearingCheck = [...CODE_BEARING_TYPES].map(t => `_cls = "${t}"`).join(' OR ');
  return [
    `_o := ${ref}`,
    '_cls := _o.className.whenMissing("")',
    `_code := (IF ${codeBearingCheck} THEN output(_o.expression.whenMissing("")) ELSE "" ENDIF)`,
    '_o.name.whenMissing("") + "|||" + _cls + "|||" + _o.rid.whenMissing("") + "|||" + _o.id.whenMissing("") + "|||" + _code',
  ].join('\n');
}

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
  respond({ type: 'CACHE_DATA', objects, filter: msg.filter ?? '' });
});

// Live workspace search via BMP's GraphQL quickSearch. Results are also folded
// into the cache so a hit the user then opens is enriched like any other object.
register('BROWSE_SEARCH', async (msg, respond) => {
  const ctx = getCtx();
  const { query, gen } = msg;
  if (!query.trim()) {
    respond({ type: 'BROWSE_SEARCH_RESULT', query, gen, ok: true, objects: [], totalHits: 0 });
    return;
  }
  if (!ctx.client) {
    respond({ type: 'BROWSE_SEARCH_RESULT', query, gen, ok: false, error: 'Not connected to BMP' });
    return;
  }
  try {
    const { totalHits, objects } = await ctx.client.quickSearch(query, { page: msg.page, pageSize: msg.pageSize });
    for (const o of objects) ctx.cache.put(o);
    respond({ type: 'BROWSE_SEARCH_RESULT', query, gen, ok: true, objects, totalHits });
  } catch (e) {
    respond({ type: 'BROWSE_SEARCH_RESULT', query, gen, ok: false, error: e instanceof Error ? e.message : 'Search failed' });
  }
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
});

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
      const ec = buildHoverResolveEc(msg.ref);
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
});

// ── Type-schema fetch ───────────────────────────────────────────
//
// Powers the editor's Vars + Properties panel. One EC round-trip per
// className enumerates all properties (system + custom) with their EC
// accessor (via the two-step `.as(linkedTo).as(id)` trick — NOT the
// one-step `.as(linkedTo.id)` which returns display names).
//
// Cache lives in type-schema-cache.ts. We re-export the active
// serverId from settings.activeProfileId so two profiles never share
// schema state.

register('FETCH_COLOR_SETS', async (msg) => {
  const ctx = getCtx();
  const serverId = ctx.settings.activeProfileId || '';
  // Serve from the persistent cache unless a manual refresh forced a reload.
  // This is the speed win: a panel reopen or SW idle-reset no longer re-runs
  // the BMP round-trip — the colours come straight from storage.session.
  if (!msg.force) {
    const cached = await getColorSets(serverId);
    if (cached) { ctx.sendToPanel({ type: 'COLOR_SETS_DATA', sets: cached }); return; }
  }
  if (!ctx.client) { ctx.sendToPanel({ type: 'COLOR_SETS_DATA', sets: [] }); return; }
  try {
    const sets = await ctx.client.fetchColorSets();
    if (sets.length > 0) await setColorSets(serverId, sets);
    ctx.sendToPanel({ type: 'COLOR_SETS_DATA', sets });
  } catch (e) {
    log.swallow('handler:fetchColorSets', e);
    ctx.sendToPanel({ type: 'COLOR_SETS_DATA', sets: [] });
  }
});

/**
 * EC that enumerates a class's property configs:
 * `accessor|||label|||configClass|||systemobject` per property, with a leading
 * `__canon__|||<fq>` line carrying the canonical class name. `c.get(X.name)`
 * resolves the ClassConfig case-insensitively; the two-step `.linkedTo.id`
 * yields the accessor (the one-step form returns display names). Triple-pipe
 * so user labels containing `|` don't shift columns. Live-verified.
 * Shared by FETCH_TYPE_SCHEMA and FETCH_CONNECTIONS so the EC can't drift.
 */
function buildSchemaEc(className: string): string {
  return [
    `_cls := c.get(${className}.name)`,
    '_out := "__canon__|||" + _cls.id.whenMissing("") + "\\n"',
    '_kids := _cls.children()',
    '_kids.forEach(_k:',
    '     _out := _out + _k.linkedTo.id + "|||" + _k.name + "|||" + _k.className + "|||" + _k.systemobject + "\\n"',
    ')',
    '_out',
  ].join('\n');
}

function parseSchemaPropsLog(log: string): { props: SchemaProp[]; canonical?: string } {
  const props: SchemaProp[] = [];
  let canonical: string | undefined;
  for (const line of (log || '').split('\n')) {
    const parts = line.split('|||');
    // Canonical-name marker — require exactly 2 fields so a real `__canon__`
    // accessor can't be swallowed.
    if (parts.length === 2 && parts[0] === '__canon__') {
      const seg = parts[1].trim().split('.').pop();
      if (seg) canonical = seg;
      continue;
    }
    if (parts.length < 4) continue;
    const [accessor, label, configClass, sysFlag] = parts;
    if (!accessor || !configClass) continue;
    props.push({ accessor: accessor.trim(), label: label.trim(), configClass: configClass.trim(), systemobject: sysFlag.trim() === 'true' });
  }
  return { props, canonical };
}

/** Cache-or-fetch a type's schema props. `refresh` bypasses the cache. */
async function loadSchemaProps(className: string, refresh = false): Promise<
  { ok: true; props: SchemaProp[]; canonical?: string } | { ok: false; error: string }
> {
  const ctx = getCtx();
  const serverId = ctx.settings.activeProfileId || '';
  if (!ctx.client) return { ok: false, error: 'Not connected' };
  if (!refresh) {
    await schemaCache.load();
    const cached = schemaCache.get(serverId, className);
    if (cached) return { ok: true, props: cached, canonical: schemaCache.getCanonical(serverId, className) };
  }
  // BMP class names are PascalCase — guard against shipping an arbitrary
  // string into EC.
  if (!/^[A-Z][A-Za-z0-9]{0,63}$/.test(className)) return { ok: false, error: `Invalid class name: ${className}` };
  const result = await ctx.client.executeEc(buildSchemaEc(className), undefined, false);
  if (!result.ok) return { ok: false, error: result.error || result.log || 'EC execution failed' };
  const { props, canonical } = parseSchemaPropsLog(result.log ?? '');
  if (props.length === 0) return { ok: false, error: 'No properties returned (unknown class?)' };
  schemaCache.set(serverId, className, props, canonical);
  return { ok: true, props, canonical };
}

register('FETCH_TYPE_SCHEMA', async (msg, respond) => {
  try {
    const r = await loadSchemaProps(msg.className, msg.refresh);
    if (r.ok) respond({ type: 'FETCH_TYPE_SCHEMA_RESULT', className: msg.className, ok: true, props: r.props, canonicalClassName: r.canonical });
    else respond({ type: 'FETCH_TYPE_SCHEMA_RESULT', className: msg.className, ok: false, error: r.error });
  } catch (e) {
    respond({ type: 'FETCH_TYPE_SCHEMA_RESULT', className: msg.className, ok: false, error: errorMessage(e) });
  }
});

register('FETCH_CONNECTIONS', async (msg, respond) => {
  const ctx = getCtx();
  if (!ctx.client) { respond({ type: 'CONNECTIONS_RESULT', rid: msg.rid, ok: false, error: 'Not connected' }); return; }
  try {
    // 1. Discover the type's reference fields (cached schema).
    const schema = await loadSchemaProps(msg.className);
    if (!schema.ok) { respond({ type: 'CONNECTIONS_RESULT', rid: msg.rid, ok: false, error: schema.error }); return; }
    const fields = refFieldsFromSchema(schema.props);
    if (fields.length === 0) { respond({ type: 'CONNECTIONS_RESULT', rid: msg.rid, ok: true, groups: [] }); return; }
    // 2. Read the current endpoints for this object.
    const ref = await ctx.client.resolveRef(msg.rid);
    const result = await ctx.client.executeEc(buildConnectionsEc(ref, fields), undefined, false);
    if (!result.ok) { respond({ type: 'CONNECTIONS_RESULT', rid: msg.rid, ok: false, error: result.error || result.log || 'EC execution failed' }); return; }
    const groups = parseConnections(result.log ?? '', fields);
    // 3. Inline junction far-sides (e.g. risk → [workflow] → control).
    await inlineJunctions(msg.rid, groups);
    respond({ type: 'CONNECTIONS_RESULT', rid: msg.rid, ok: true, groups });
  } catch (e) {
    respond({ type: 'CONNECTIONS_RESULT', rid: msg.rid, ok: false, error: errorMessage(e) });
  }
});

register('FETCH_INBOUND', async (msg, respond) => {
  const ctx = getCtx();
  if (!ctx.client) { respond({ type: 'INBOUND_RESULT', rid: msg.rid, ok: false, error: 'Not connected' }); return; }
  try {
    const ref = await ctx.client.resolveRef(msg.rid);
    const result = await ctx.client.executeEc(buildInboundEc(ref), undefined, false);
    if (!result.ok) { respond({ type: 'INBOUND_RESULT', rid: msg.rid, ok: false, error: result.error || result.log || 'EC execution failed' }); return; }
    const { targets, capped } = parseInbound(result.log ?? '');
    respond({ type: 'INBOUND_RESULT', rid: msg.rid, ok: true, targets, capped });
  } catch (e) {
    respond({ type: 'INBOUND_RESULT', rid: msg.rid, ok: false, error: errorMessage(e) });
  }
});

/**
 * For reverse-ref targets that are join objects (CeWorkflow mitigations, etc.),
 * read each one's far side and attach it inline so risk → control reads in one
 * hop. Generic: groups junction targets by type, reads that type's forward
 * refs, and picks the endpoint that isn't the back-edge. Best-effort + capped;
 * a failure here never fails the whole Connections fetch.
 */
async function inlineJunctions(sourceRid: string, groups: ConnGroup[]): Promise<void> {
  const ctx = getCtx();
  if (!ctx.client) return;
  const JUNCTION_CAP = 24;
  const byType = new Map<string, { rid: string; target: import('../types').ConnTarget }[]>();
  let count = 0;
  for (const g of groups) {
    if (g.direction !== 'in') continue; // junctions arrive as reverse-ref targets
    for (const t of g.targets) {
      if (t.broken || !t.type || !t.rid || count >= JUNCTION_CAP) continue;
      const arr = byType.get(t.type) ?? [];
      arr.push({ rid: t.rid, target: t });
      byType.set(t.type, arr);
      count++;
    }
  }
  for (const [type, entries] of byType) {
    try {
      const schema = await loadSchemaProps(type);
      if (!schema.ok) continue;
      const fwd = refFieldsFromSchema(schema.props).filter(f => f.direction === 'out');
      if (fwd.length === 0) continue;
      const result = await ctx.client.executeEc(buildJunctionEc(entries.map(e => e.rid), fwd), undefined, false);
      if (!result.ok) continue;
      const farByRid = parseJunctions(result.log ?? '');
      for (const e of entries) {
        const far = pickFarSide(sourceRid, e.rid, farByRid.get(e.rid) ?? []);
        if (far) e.target.via = far;
      }
    } catch { /* best-effort — leave these targets without a via */ }
  }
}

register('RESOLVE_ROOT_CATEGORY', async (msg, respond) => {
  const ctx = getCtx();
  const serverId = ctx.settings.activeProfileId || '';
  if (!ctx.client) {
    respond({ type: 'RESOLVE_ROOT_CATEGORY_RESULT', category: msg.category, ok: false });
    return;
  }
  await schemaCache.loadRootCache();
  const cached = schemaCache.getRoot(serverId, msg.category);
  // undefined = never asked; null = asked and BMP said empty (don't re-ask)
  if (cached !== undefined) {
    respond({ type: 'RESOLVE_ROOT_CATEGORY_RESULT', category: msg.category, ok: true, className: cached ?? undefined });
    return;
  }
  if (!/^[a-z][A-Za-z0-9]{0,63}$/.test(msg.category)) {
    respond({ type: 'RESOLVE_ROOT_CATEGORY_RESULT', category: msg.category, ok: false });
    return;
  }
  try {
    const ec = `root.${msg.category}.children().first().className.whenMissing("")`;
    const result = await ctx.client.executeEc(ec, undefined, false);
    if (!result.ok) {
      // Discriminate: did BMP run the EC and reject it (definitive —
      // `hasError` set by parseEcResults from an ERROR log entry), or
      // did the transport fail / time out (transient)? The current
      // user-visible case ("root.X.children is unrecognized" while
      // typing) is the definitive branch; without negative caching
      // here, every doc scan re-fires the BMP roundtrip for the
      // same misspelling. Transient failures stay uncached so
      // recovery after BMP comes back doesn't require a manual refresh.
      if (result.hasError) {
        schemaCache.setRoot(serverId, msg.category, null);
        respond({ type: 'RESOLVE_ROOT_CATEGORY_RESULT', category: msg.category, ok: true, className: undefined });
      } else {
        respond({ type: 'RESOLVE_ROOT_CATEGORY_RESULT', category: msg.category, ok: false });
      }
      return;
    }
    // `result.log` is parseEcResults-clean: "Result : " prefix already
    // stripped, multi-line value joined with the Duration line.
    // The single value we want is on the first line.
    const body = (result.log || '').trim().split('\n')[0]?.trim() || '';
    const className = body && /^[A-Z][A-Za-z0-9]+$/.test(body) ? body : null;
    // Only cache the negative result (`null`) when BMP definitively
    // answered with no className — i.e. the category exists but is
    // empty. Genuine "no such category" answers are stable enough to
    // cache and avoid re-asking on every doc scan.
    schemaCache.setRoot(serverId, msg.category, className);
    respond({ type: 'RESOLVE_ROOT_CATEGORY_RESULT', category: msg.category, ok: true, className: className ?? undefined });
  } catch {
    respond({ type: 'RESOLVE_ROOT_CATEGORY_RESULT', category: msg.category, ok: false });
  }
});

register('GET_CACHE_BYTES', (msg, respond) => {
  // Approximate size in bytes of the persisted cache (lean form). Used by
  // the Connect tab to surface "X MB used". Cheap to compute (one JSON
  // stringify per cached object) but not free — only fired on tab activate.
  respond({ type: 'CACHE_BYTES', bytes: getCtx().cache.getApproxBytes() });
});

register('CLEAR_CACHE', (msg, respond) => {
  const ctx = getCtx();
  ctx.cache.clear();
  incrementGeneration(); // resets enrichedRids + permanentlyFailed + aborts in-flight
  respond({ type: 'CACHE_STATS', count: 0 });
  ctx.broadcastToContent({ type: 'RE_ENRICH' });
});

// Full reset — clears state CLEAR_CACHE leaves behind. Use when the extension
// gets into a bad state and the user wants a clean slate without losing their
// server profiles. We deliberately leave favorites + settings untouched so the
// reset doesn't punish the user for using it.
register('RESET_ALL', (msg, respond) => {
  const ctx = getCtx();
  // Object cache + enrichment (same as CLEAR_CACHE)
  ctx.cache.clear();
  incrementGeneration();
  // Activity log
  clearActivityLog();
  // Compare pivot (lives in chrome.storage.session, scoped per-profile —
  // wipe all of them so RESET_ALL doesn't leave per-env pivots behind).
  chrome.storage.session.get(null).then((all) => {
    const keys = Object.keys(all).filter(k => k.startsWith('crev_compare_pivot'));
    if (keys.length) chrome.storage.session.remove(keys).catch(() => {});
  }).catch(() => {});
  // Per-tab context rids
  clearAllContextRids();
  // History (recent objects)
  ctx.history.clear();
  // Script history
  ctx.scriptHistory.clear();
  ctx.logActivity('warn', 'State reset (object cache, enrichment, activity, context)');
  respond({ type: 'CACHE_STATS', count: 0 });
  ctx.broadcastToContent({ type: 'RE_ENRICH' });

  // Snap the panel to a clean slate. Without these, the user clicks Reset
  // and the status-bar chips + Page tab + Log tab still show stale state
  // until they navigate. Each broadcast hits the corresponding handler in
  // the panel orchestrator and clears its piece of in-memory state.
  ctx.sendToPanel({ type: 'CONTEXT_RID_DATA' });                           // clears context chip
  ctx.sendToPanel({ type: 'ACTIVITY_LOG', entries: [] });                  // empties Log tab
  ctx.sendToPanel({ type: 'HISTORY_DATA', entries: [] });                  // empties Recent list
  ctx.sendToPanel({ type: 'DETECTION_STATE', phase: 'checking', confidence: 0, signals: [] });
  // Refresh the Workshop layout pane's widget enrichment against the active BMP tab — async
  // and best-effort; chrome.tabs.sendMessage is gated on injection so we
  // don't block the reset on it.
  chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
    const tabId = tabs[0]?.id;
    if (tabId != null) {
      import('../content-script-injection').then(m => m.sendPageInfoToPanel(tabId)).catch(() => {});
    }
  });
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
    // Parallelize: object lookup + template resolution
    const [obj, tmplResult] = await Promise.all([
      lookupObject(msg.rid),
      ctx.client ? ctx.client.resolveTemplate(msg.rid) : Promise.resolve<TemplateResolution>({ templateRid: null }),
    ]);
    let template: { rid: string; name: string; type: string; businessId?: string } | undefined;
    if (tmplResult.templateRid) {
      template = { rid: tmplResult.templateRid, name: tmplResult.templateName ?? '', type: tmplResult.templateType ?? '', businessId: tmplResult.templateBusinessId };
    }
    // Fetch children of the template (config hierarchy), falling back to the object itself
    const childrenRid = template?.rid ?? msg.rid;
    const children = ctx.client ? await ctx.client.fetchChildren(childrenRid) : [];
    respond({ type: 'FULL_LOOKUP_RESULT', rid: msg.rid, object: obj, template, children });
  } catch (e) {
    respond({ type: 'FULL_LOOKUP_RESULT', rid: msg.rid, object: null, error: errorMessage(e) });
  }
});

register('FETCH_CHILDREN', async (msg, respond) => {
  const ctx = getCtx();
  try {
    const children = ctx.client ? await ctx.client.fetchChildren(msg.rid) : [];
    respond({ type: 'FETCH_CHILDREN_RESULT', rid: msg.rid, children });
  } catch (e) {
    respond({ type: 'FETCH_CHILDREN_RESULT', rid: msg.rid, children: [], error: errorMessage(e) });
  }
});

register('FETCH_LAYOUT_TREE', async (msg, respond) => {
  const ctx = getCtx();
  try {
    const nodes = ctx.client ? await ctx.client.fetchLayoutTree(msg.rid) : [];
    respond({ type: 'LAYOUT_TREE_RESULT', rid: msg.rid, nodes });
  } catch (e) {
    respond({ type: 'LAYOUT_TREE_RESULT', rid: msg.rid, nodes: [], error: errorMessage(e) });
  }
});

register('MOVE_OBJECT', async (msg, respond) => {
  const ctx = getCtx();
  if (!ctx.client) {
    respond({ type: 'MOVE_OBJECT_RESULT', rid: msg.rid, ok: false, error: 'Not connected' });
    return;
  }
  try {
    const result = await ctx.client.moveObject(msg.rid, msg.relTo, msg.position);
    respond({ type: 'MOVE_OBJECT_RESULT', rid: msg.rid, ok: result.ok, error: result.error });
    if (result.ok) {
      // Cache invalidation: order-of-children changed for the parent.
      // Cheap to nuke both entries — the layout tree re-fetch below
      // will repopulate.
      ctx.logActivity('success', `Moved ${msg.rid} ${msg.position} ${msg.relTo}`);
    } else {
      ctx.logActivity('warn', `Move failed: ${msg.rid} ${msg.position} ${msg.relTo}`, result.error);
      ctx.toast(`Move failed: ${result.error ?? 'unknown error'}`, 'error');
    }
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    respond({ type: 'MOVE_OBJECT_RESULT', rid: msg.rid, ok: false, error: errorMessage(e) });
    ctx.logActivity('error', `Move threw on ${msg.rid}`, errMsg);
    ctx.toast(`Move threw: ${errMsg}`, 'error');
  }
});

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
});

function emptyPaneResponse(rid: string, error?: string) {
  return {
    type: 'OBJECT_PANE_DATA' as const,
    rid,
    instance: { rid, businessId: '', type: '', name: '' },
    parent: null, template: null, card: null,
    instanceProps: {}, templateProps: {}, siblings: [], siblingTotal: 0,
    codeFields: {}, references: {},
    indirectCode: {}, indirectCodeRids: {}, contextValues: {}, gateValues: {}, lists: {},
    ...(error ? { error } : {}),
  };
}

/** In-flight pane/flow fetches keyed by rid. When the sidepanel watchdog
 *  fires (15s) we send a CANCEL_FETCH_OBJECT_PANE so the SW can abort the
 *  EC (which otherwise keeps the bridge busy for the full 30s EC timeout).
 *  Without this the late response is harmless (sidepanel ignores stale
 *  rids) but we burn CPU + a bridge slot we don't need. */
const inFlightPaneFetches = new Map<string, AbortController>();
const inFlightFlowFetches = new Map<string, AbortController>();

register('FETCH_OBJECT_PANE', async (msg, respond) => {
  const ctx = getCtx();
  if (!ctx.client) { respond(emptyPaneResponse(msg.rid, 'Not connected')); return; }
  // Replace any prior in-flight fetch for this rid — the new one supersedes.
  inFlightPaneFetches.get(msg.rid)?.abort();
  const controller = new AbortController();
  inFlightPaneFetches.set(msg.rid, controller);
  try {
    const data = await ctx.client.fetchObjectPane(msg.rid, controller.signal);
    if (!data) { respond(emptyPaneResponse(msg.rid, 'Object not found')); return; }
    respond({
      type: 'OBJECT_PANE_DATA',
      rid: msg.rid,
      instance: data.instance,
      parent: data.parent,
      template: data.template,
      card: data.card,
      instanceProps: data.instanceProps,
      templateProps: data.templateProps,
      siblings: data.siblings,
      siblingTotal: data.siblingTotal,
      codeFields: data.codeFields,
      references: data.references,
      indirectCode: data.indirectCode,
      indirectCodeRids: data.indirectCodeRids,
      contextValues: data.contextValues,
      gateValues: data.gateValues,
      lists: data.lists,
    });
  } catch (e) {
    if (controller.signal.aborted) return; // caller cancelled — sidepanel already moved on
    respond(emptyPaneResponse(msg.rid, errorMessage(e)));
  } finally {
    // Only delete if this controller is still the active one for the rid.
    if (inFlightPaneFetches.get(msg.rid) === controller) inFlightPaneFetches.delete(msg.rid);
  }
});

register('CANCEL_FETCH_OBJECT_PANE', (msg) => {
  inFlightPaneFetches.get(msg.rid)?.abort();
  inFlightPaneFetches.delete(msg.rid);
  inFlightFlowFetches.get(msg.rid)?.abort();
  inFlightFlowFetches.delete(msg.rid);
});

register('FETCH_FLOW_CHAIN', async (msg, respond) => {
  const ctx = getCtx();
  if (!ctx.client) {
    respond({ type: 'FLOW_CHAIN_DATA', rid: msg.rid, chain: null, error: 'Not connected' });
    return;
  }
  inFlightFlowFetches.get(msg.rid)?.abort();
  const controller = new AbortController();
  inFlightFlowFetches.set(msg.rid, controller);
  try {
    const chain = await ctx.client.fetchFlowChain(msg.rid, msg.objectType, controller.signal);
    respond({ type: 'FLOW_CHAIN_DATA', rid: msg.rid, chain });
  } catch (e) {
    if (controller.signal.aborted) return;
    respond({ type: 'FLOW_CHAIN_DATA', rid: msg.rid, chain: null, error: errorMessage(e) });
  } finally {
    if (inFlightFlowFetches.get(msg.rid) === controller) inFlightFlowFetches.delete(msg.rid);
  }
});

register('APPLY_OBJECT_CHANGES', async (msg, respond) => {
  const ctx = getCtx();
  if (!ctx.client) {
    respond({ type: 'APPLY_CHANGES_RESULT', rid: msg.rid, ok: false, error: 'Not connected' });
    return;
  }
  try {
    const result = await ctx.client.applyObjectChanges(msg.rid, msg.target, msg.changes);
    respond({ type: 'APPLY_CHANGES_RESULT', rid: msg.rid, ok: result.ok, error: result.error });
    // Activity log: edits are the most-clicked surface; the Log tab was
    // otherwise blind to them. Surface prop-by-prop summary so the user
    // can audit what they actually changed.
    const propList = Object.keys(msg.changes);
    const propSummary = propList.length === 1
      ? propList[0]
      : `${propList.length} props (${propList.slice(0, 3).join(', ')}${propList.length > 3 ? '…' : ''})`;
    if (result.ok) {
      ctx.logActivity('success', `Edited ${msg.target} ${msg.rid}: ${propSummary}`);
      // Drop cached enrichment so badges + detail view refresh on the
      // next read. Fire-and-forget; the panel "saved" UI doesn't need
      // to wait for the re-fetch.
      invalidateRid(msg.rid).catch(e => log.swallow('handler:applyChanges:invalidate', e));
    } else {
      // Log AND toast: the user clicked Save and the detail-view inline
      // banner is easy to miss if focus moved or the detail view
      // closed.
      ctx.logActivity('error', `Edit failed: ${propSummary}`, result.error);
      ctx.toast(`Save failed: ${result.error ?? 'unknown error'}`, 'error');
    }
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    respond({ type: 'APPLY_CHANGES_RESULT', rid: msg.rid, ok: false, error: errorMessage(e) });
    ctx.logActivity('error', `Edit threw on ${msg.rid}`, errMsg);
    ctx.toast(`Save threw: ${errMsg}`, 'error');
  }
});

// Click-to-pane relay: the content script and side panel forward
// SELECT_OBJECT when the user wants to open an object in the side panel.
// We respond to the caller (for the content-script flow that does
// sendRequest) AND mirror to the panel (for fire-forget callers). The
// panel's onPortMessage already calls navigateToDetail() on receipt.
//
// Audit (v0.20.1): SELECT_OBJECT used to JUST open the detail view —
// the Page-tab "Context" section stayed on whatever was set before,
// decoupling "what I'm looking at" from "what's my current
// context". Now SELECT_OBJECT ALSO updates context via the
// CONTEXT_RID_DATA broadcast. Right-click + cascade-pill-click +
// search-jump all converge on the same context shape.
register('SELECT_OBJECT', async (msg, respond, meta) => {
  if (!('rid' in msg)) return;
  respond({ type: 'SELECT_OBJECT', rid: msg.rid });
  const ctx = getCtx();
  ctx.sendToPanel({ type: 'SELECT_OBJECT', rid: msg.rid });
  // Resolve the BMP tab to associate context with. Sources, in order of
  // reliability:
  //   1. meta.senderTabId — content-script senders
  //   2. lastFocused active tab — sidepanel-originated clicks
  let bmpTabId: number | undefined = meta.senderTabId;
  if (bmpTabId == null) {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    bmpTabId = tabs[0]?.id;
  }
  if (bmpTabId != null) {
    // Resolve identity for the context entry. The enrichment cache
    // usually has it; if not, fall through with rid-only — the
    // CONTEXT_RID_DATA broadcast still fires.
    const cached = ctx.cache?.get(msg.rid);
    setContextRid(bmpTabId, {
      rid: msg.rid,
      name: cached?.name,
      type: cached?.type,
      businessId: cached?.businessId,
    });
  }
  ctx.sendToPanel({
    type: 'CONTEXT_RID_DATA',
    rid: msg.rid,
    name: ctx.cache?.get(msg.rid)?.name,
    objectType: ctx.cache?.get(msg.rid)?.type,
    businessId: ctx.cache?.get(msg.rid)?.businessId,
  });
  // If no side panel is currently connected (closed everywhere), try
  // to open it for this tab.
  if (!ctx.hasPanel) openSidePanelForActiveTab();
});

let openAttemptedThisSession = false;
async function openSidePanelForActiveTab(): Promise<void> {
  // Try once per SW lifetime — if the user closes the panel after
  // we auto-opened it, that's a deliberate choice and we shouldn't
  // re-open on every click.
  if (openAttemptedThisSession) return;
  openAttemptedThisSession = true;
  try {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const windowId = tabs[0]?.windowId;
    if (windowId == null) return;
    await chrome.sidePanel.open({ windowId });
  } catch (e) {
    // open() requires a user gesture; if Chrome refuses, fail quietly
    // — the next user gesture (badge click in BMP) can retry.
    openAttemptedThisSession = false;
    void e;
  }
}
