/**
 * Object lookup, cache, and linked object handlers.
 */

import { register, type HandlerMeta } from '../handler-registry';
import { getCtx } from '../sw-context';
import { activityObject, activityObjectLabel } from '../activity-format';
import { incrementGeneration, invalidateRid } from '../enrichment';
import { clearActivityLog } from '../activity';
import { clearAllContextRids } from '../context-rid';
import { errorMessage, log } from '../logger';
import { CODE_BEARING_TYPES } from '../namespace';
import { loadColorSets } from '../color-set-cache';
import type { BmpObject, ObjectPanePayload } from '../types';
import * as schemaCache from '../type-schema-cache';
import { refFieldsFromSchema, buildConnectionsEc, parseConnections, buildJunctionEc, parseJunctions, pickFarSide, buildInboundEc, parseInbound } from '../connections';
import type { ConnGroup } from '../types';
import { buildRowEc } from '../ec-row-codec';
import { isRidShaped } from '../validate-inbound';
import { BATCH_CHUNK_SIZE } from '../constants';
import { ENVIRONMENT_CHANGED_ERROR, environmentMatches, environmentToken } from '../environment';
import { markHostAccessRequired } from '../connection';
import { HostAccessError } from '../site-access';
import { bmpTypeKnowledge } from '../bmp-type-knowledge';

const browseSearchControllers = new Map<string, AbortController>();

function browseSearchKey(meta: HandlerMeta): string {
  if (meta.panelWindowId != null) return `panel:${meta.panelWindowId}`;
  if (meta.senderTabId != null) return `tab:${meta.senderTabId}`;
  return meta.isOneShot ? 'oneshot' : 'panel:unknown';
}

function hydrateBrowseObject(cacheObject: BmpObject | undefined, hit: BmpObject): BmpObject {
  if (!cacheObject) return hit;
  return {
    ...hit,
    businessId: cacheObject.businessId ?? hit.businessId,
    templateBusinessId: cacheObject.templateBusinessId ?? hit.templateBusinessId,
    identityEnriched: cacheObject.identityEnriched ?? hit.identityEnriched,
    cascade: cacheObject.cascade ?? hit.cascade,
  };
}

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
  const row = buildRowEc([
    { name: 'name', expr: '_o.name.whenMissing("")' },
    { name: 'className', expr: '_cls' },
    { name: 'rid', expr: '_o.rid.whenMissing("")' },
    { name: 'id', expr: '_o.id.whenMissing("")' },
    { name: 'code', expr: '_code' },
  ], '|||');
  return [
    `_o := ${ref}`,
    '_cls := _o.className.whenMissing("")',
    `_code := (IF ${codeBearingCheck} THEN output(_o.expression.whenMissing("")) ELSE "" ENDIF)`,
    row,
  ].join('\n');
}

// ── Shared lookup utility ────────────────────────────────────────

async function lookupObject(rid: string): Promise<BmpObject> {
  const ctx = getCtx();
  if (!ctx.client) throw new Error('Not connected');

  const cached = ctx.cache.get(rid);
  if (cached?.type && (cached.name || cached.businessId)) return cached;

  const identity = await ctx.client.lookupIdentity(rid);
  if (!identity) throw new Error('Object not found');

  const now = Date.now();
  const obj: BmpObject = {
    rid,
    name: identity.name,
    type: identity.type,
    businessId: identity.businessId,
    templateBusinessId: identity.templateBusinessId,
    properties: {},
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

export const LINKED_OBJECTS: Record<string, LinkedObjectDef[]> = {
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

/** Build the EC that reads a linked object off `ref.<ecProperty>`, emitting
 *  `id|||name|||rid` (or "" when the link is MISSING). The mandatory ELSE is an
 *  EC requirement. Exported so a regression test asserts against the shipped
 *  builder — type schema/options knowledge lives in bmp-type-knowledge.ts. */
export function buildLinkedEc(ref: string, ecProperty: string): string {
  return [
    `_p := ${ref}`,
    `_l := _p.${ecProperty}`,
    'IF _l != MISSING THEN',
    '  _l.id.whenMissing("") + "|||" + _l.name.whenMissing("") + "|||" + _l.rid.whenMissing("")',
    'ELSE',
    '  ""',
    'ENDIF',
  ].join('\n');
}

/** Parse the pipe-delimited log emitted by `buildLinkedEc` into linked
 *  id/name/rid. Empty fields collapse to undefined; a log without `|||`
 *  (the ELSE "" branch, or noise) yields `{}`. */
export function parseLinkedLog(log: string | undefined): { linkedId?: string; linkedName?: string; linkedRid?: string } {
  if (!log?.includes('|||')) return {};
  const line = log.trim().split('\n').find(l => l.includes('|||'));
  if (!line) return {};
  const [lId, lName, lRid] = line.split('|||').map(s => s.trim());
  return { linkedId: lId || undefined, linkedName: lName || undefined, linkedRid: lRid || undefined };
}

// ── Handlers ─────────────────────────────────────────────────────

register('GET_CACHE', (msg, respond) => {
  const ctx = getCtx();
  const objects = msg.filter ? ctx.cache.search(msg.filter) : ctx.cache.getAll();
  respond({ type: 'CACHE_DATA', objects, filter: msg.filter ?? '' });
});

// Live workspace search via BMP's GraphQL quickSearch. The fast GraphQL result
// paints first; a cancellable identity pass then hydrates template + instance
// ids and updates the same generation. Superseded searches abort their work so
// typing cannot fill BMP's serialized command queue with stale enrichments.
register('BROWSE_SEARCH', async (msg, respond, meta) => {
  const ctx = getCtx();
  const { query, gen } = msg;
  const key = browseSearchKey(meta);
  browseSearchControllers.get(key)?.abort();
  if (!query.trim()) {
    respond({ type: 'BROWSE_SEARCH_RESULT', query, gen, ok: true, objects: [], totalHits: 0 });
    return;
  }
  if (!ctx.client) {
    respond({ type: 'BROWSE_SEARCH_RESULT', query, gen, ok: false, error: 'Not connected to BMP' });
    return;
  }
  const controller = new AbortController();
  browseSearchControllers.set(key, controller);
  const client = ctx.client;
  const environment = environmentToken(ctx);
  try {
    const { totalHits, objects } = await client.quickSearch(query, {
      page: msg.page,
      pageSize: msg.pageSize,
      signal: controller.signal,
    });
    if (controller.signal.aborted || !environmentMatches(getCtx(), environment)) return;

    ctx.cache.putAll(objects);
    const immediate = objects.map(hit => hydrateBrowseObject(ctx.cache.get(hit.rid), hit));
    if (!meta.isOneShot) {
      respond({ type: 'BROWSE_SEARCH_RESULT', query, gen, ok: true, objects: immediate, totalHits });
    }

    const missing = immediate.filter(object => !object.identityEnriched);
    const identities: Record<string, {
      businessId?: string;
      type?: string;
      name?: string;
      templateBusinessId?: string;
      cascade?: { rid: string; businessId?: string; type?: string; name?: string };
    }> = {};
    try {
      for (let i = 0; i < missing.length; i += BATCH_CHUNK_SIZE) {
        const chunk = missing.slice(i, i + BATCH_CHUNK_SIZE).map(object => object.rid);
        const result = await client.batchEnrich(chunk, controller.signal);
        if (controller.signal.aborted || !environmentMatches(getCtx(), environment)) return;
        Object.assign(identities, result.results);
        if (result.error) break;
      }
    } catch (e) {
      if (controller.signal.aborted || !environmentMatches(getCtx(), environment)) return;
      // Identity is progressive decoration. A failed EC pass must not erase
      // quickSearch results that were already valid and visible.
      log.swallow('handler:browseSearch:enrich', e);
      if (meta.isOneShot) {
        respond({ type: 'BROWSE_SEARCH_RESULT', query, gen, ok: true, objects: immediate, totalHits });
      }
      return;
    }

    const now = Date.now();
    const hydrated = immediate.map((hit): BmpObject => {
      const identity = identities[hit.rid];
      if (!identity) return hit;
      return {
        ...hit,
        businessId: identity.businessId,
        type: identity.type ?? hit.type,
        name: identity.name ?? hit.name,
        templateBusinessId: identity.templateBusinessId,
        identityEnriched: true,
        cascade: identity.cascade,
        source: 'server',
        discoveredAt: hit.discoveredAt,
        updatedAt: now,
      };
    });
    ctx.cache.putAll(hydrated.filter(object => object.identityEnriched));
    if (meta.isOneShot || Object.keys(identities).length > 0) {
      respond({ type: 'BROWSE_SEARCH_RESULT', query, gen, ok: true, objects: hydrated, totalHits });
    }
  } catch (e) {
    if (controller.signal.aborted) return;
    if (e instanceof HostAccessError) {
      markHostAccessRequired();
      respond({ type: 'BROWSE_SEARCH_RESULT', query, gen, ok: false, error: 'Grant site access to search this BMP workspace' });
      return;
    }
    respond({ type: 'BROWSE_SEARCH_RESULT', query, gen, ok: false, error: e instanceof Error ? e.message : 'Search failed' });
  } finally {
    if (browseSearchControllers.get(key) === controller) browseSearchControllers.delete(key);
  }
});

register('HOVER_LOOKUP', async (msg, respond) => {
  const ctx = getCtx();
  // Fast path: check cache (includes code preview if properties were fetched)
  const cached = ctx.cache.get(msg.rid);
  if (cached?.name || cached?.type) {
    const codePreview = extractCachedCode(cached);
    respond({
      type: 'HOVER_LOOKUP_RESULT',
      rid: msg.rid,
      name: cached.name,
      objectType: cached.type,
      businessId: cached.businessId,
      templateBusinessId: cached.templateBusinessId,
      codePreview,
    });
    return;
  }
  // Slow path: EC lookup (identity only — no code fetch for RID lookups)
  if (!ctx.client) { respond({ type: 'HOVER_LOOKUP_RESULT', rid: msg.rid }); return; }
  try {
    const identity = await ctx.client.lookupIdentity(msg.rid);
    respond({
      type: 'HOVER_LOOKUP_RESULT', rid: msg.rid,
      name: identity?.name, objectType: identity?.type, businessId: identity?.businessId,
      templateBusinessId: identity?.templateBusinessId,
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

/** A `namespace.businessId` reference, optionally followed by accessor hops
 *  (`ceras.foo.parent.owning_org`). This is interpolated raw into `_o := <ref>`,
 *  so it is an EC-injection surface: lock it to a lowercase-prefixed dotted
 *  navigation path — no spaces, parens, operators, quotes, or statement
 *  separators can pass. The client validates first; this is the server backstop.
 *  Hop count is generous (the client enforces the real policy cap). */
const HOVER_REF_RE = /^[a-z]{1,6}\.[A-Za-z0-9_]+(?:\.[A-Za-z_]\w*){0,6}$/;

register('HOVER_RESOLVE', async (msg, respond) => {
  const ctx = getCtx();
  if (!ctx.client || typeof msg.ref !== 'string' || !HOVER_REF_RE.test(msg.ref)) {
    respond({ type: 'HOVER_RESOLVE_RESULT', ref: msg.ref });
    return;
  }
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
// environment token so neither distinct profiles nor a reconfigured profile
// can share schema state.

register('FETCH_COLOR_SETS', async (msg, respond) => {
  const ctx = getCtx();
  const serverId = environmentToken(ctx);
  // Serve from the persistent cache unless a manual refresh forced a reload.
  // This is the speed win: a panel reopen or SW idle-reset no longer re-runs
  // the BMP round-trip — the colours come straight from storage.session.
  let sets: import('../types').ColorSetData[] = [];
  let fetchError: string | undefined;
  if (ctx.client) {
    try {
      sets = await loadColorSets(serverId, () => ctx.client!.fetchColorSets(), msg.force);
    } catch (e) {
      log.swallow('handler:fetchColorSets', e);
      fetchError = errorMessage(e);
    }
  } else {
    fetchError = 'Not connected';
  }
  // Broadcast to the panel (its colour picker listens for the broadcast) AND respond to the sender, so
  // the blueprint overlay can `sendRequest` the same data over the one-shot channel (style-mode tinting).
  const result = { type: 'COLOR_SETS_DATA' as const, sets, ...(fetchError ? { error: fetchError } : {}) };
  ctx.sendToPanel(result);
  respond(result);
});

register('FETCH_TYPE_SCHEMA', async (msg, respond) => {
  const environment = environmentToken(getCtx());
  const result = await bmpTypeKnowledge.properties({
    className: msg.className,
    refresh: msg.refresh,
    exampleRef: msg.exampleRef,
  });
  respond(result.ok
    ? {
        type: 'FETCH_TYPE_SCHEMA_RESULT',
        className: msg.className,
        ok: true,
        props: result.props,
        canonicalClassName: result.canonical,
        environment,
      }
    : {
        type: 'FETCH_TYPE_SCHEMA_RESULT',
        className: msg.className,
        ok: false,
        error: result.error,
        environment,
      });
});

register('FETCH_TYPE_SCHEMAS', async (msg, respond) => {
  const batch = await bmpTypeKnowledge.propertiesFor(msg.classNames);
  respond({
    type: 'FETCH_TYPE_SCHEMAS_RESULT',
    environment: batch.environment,
    results: batch.results.map(result => result.ok
      ? {
          className: result.className,
          ok: true as const,
          props: result.props,
          canonicalClassName: result.canonical,
        }
      : {
          className: result.className,
          ok: false as const,
          error: result.error,
        }),
  });
});

register('FETCH_TYPE_OPTIONS', async (msg, respond) => {
  const result = await bmpTypeKnowledge.options(msg.className, msg.refresh);
  respond(result.ok
    ? {
        type: 'FETCH_TYPE_OPTIONS_RESULT',
        className: msg.className,
        ok: true,
        options: result.options,
      }
    : {
        type: 'FETCH_TYPE_OPTIONS_RESULT',
        className: msg.className,
        ok: false,
        error: result.error,
      });
});

register('FETCH_CONNECTIONS', async (msg, respond) => {
  const ctx = getCtx();
  if (!ctx.client) { respond({ type: 'CONNECTIONS_RESULT', rid: msg.rid, ok: false, error: 'Not connected' }); return; }
  try {
    // 1. Discover the type's reference fields (cached schema).
    const schema = await bmpTypeKnowledge.properties({ className: msg.className });
    if (!schema.ok) { respond({ type: 'CONNECTIONS_RESULT', rid: msg.rid, ok: false, error: schema.error }); return; }
    const fields = refFieldsFromSchema(schema.props)
      .filter(field => field.direction === 'out');
    if (fields.length === 0) { respond({ type: 'CONNECTIONS_RESULT', rid: msg.rid, ok: true, groups: [] }); return; }
    // 2. Read the current endpoints for this object.
    const ref = await ctx.client.resolveRef(msg.rid);
    const result = await ctx.client.executeEc(buildConnectionsEc(ref, fields), undefined, false);
    if (!result.ok) { respond({ type: 'CONNECTIONS_RESULT', rid: msg.rid, ok: false, error: result.error || result.log || 'EC execution failed' }); return; }
    const groups = parseConnections(result.log ?? '', fields);
    // 3. Inline junction far-sides (e.g. risk → [workflow] → control).
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
    const schema = await bmpTypeKnowledge.properties({ className: msg.className });
    if (!schema.ok) {
      respond({ type: 'INBOUND_RESULT', rid: msg.rid, ok: false, error: schema.error });
      return;
    }
    const reverseFields = refFieldsFromSchema(schema.props)
      .filter(field => field.direction === 'in');
    let groups: ConnGroup[] = [];
    if (reverseFields.length > 0) {
      const declared = await ctx.client.executeEc(
        buildConnectionsEc(ref, reverseFields),
        undefined,
        false,
      );
      if (!declared.ok) {
        respond({
          type: 'INBOUND_RESULT',
          rid: msg.rid,
          ok: false,
          error: declared.error || declared.log || 'Declared reverse-reference fetch failed',
        });
        return;
      }
      groups = parseConnections(declared.log ?? '', reverseFields);
      await inlineJunctions(msg.rid, groups);
    }
    const result = await ctx.client.executeEc(buildInboundEc(ref), undefined, false);
    if (!result.ok) { respond({ type: 'INBOUND_RESULT', rid: msg.rid, ok: false, error: result.error || result.log || 'EC execution failed' }); return; }
    const inbound = parseInbound(result.log ?? '');
    respond({
      type: 'INBOUND_RESULT',
      rid: msg.rid,
      ok: true,
      groups,
      targets: inbound.targets,
      capped: inbound.capped || groups.some(group => group.capped),
    });
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
      const schema = await bmpTypeKnowledge.properties({ className: type });
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
  const serverId = environmentToken(ctx);
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
  ctx.broadcastToContent({ type: 'RESET_OVERLAY_CACHES' }); // also drop the blueprint overlay's colour + InputSet caches

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
  // Defence in depth: content.ts's crev-interceptor listener already shape-
  // validates (lib/validate-inbound.ts), but this handler is also reachable
  // from other message paths — never trust rid shape verbatim at the cache
  // write site.
  const objects = msg.objects.filter(o => isRidShaped(o.rid));
  ctx.cache.putAll(objects);
  ctx.logActivity('success', `Found ${objects.length} object${objects.length !== 1 ? 's' : ''}`);
  ctx.sendToPanel({ type: 'CACHE_STATS', count: ctx.cache.size });
});

register('SERVER_LOOKUP', async (msg) => {
  const ctx = getCtx();
  try {
    const obj = await lookupObject(msg.rid);
    ctx.history.record({
      rid: msg.rid,
      name: obj.name,
      type: obj.type,
      businessId: obj.businessId,
      templateBusinessId: obj.templateBusinessId,
      action: 'viewed',
      timestamp: Date.now(),
    });
    ctx.sendToPanel({ type: 'SERVER_LOOKUP_RESULT', rid: msg.rid, object: obj });
  } catch (e) {
    ctx.sendToPanel({ type: 'SERVER_LOOKUP_RESULT', rid: msg.rid, object: null, error: errorMessage(e) });
  }
});

register('SERVER_LOOKUP_BATCH', async (msg) => {
  const ctx = getCtx();
  const requested = [...new Set(msg.rids)];
  const rids = requested.filter(isRidShaped);
  const objects: Record<string, BmpObject | null> = {};
  for (const rid of requested) objects[rid] = null;
  if (!ctx.client) {
    ctx.sendToPanel({ type: 'SERVER_LOOKUP_BATCH_RESULT', objects, error: 'Not connected' });
    return;
  }
  const environment = environmentToken(ctx);
  const client = ctx.client;

  const missing: string[] = [];
  for (const rid of rids) {
    const cached = ctx.cache.get(rid);
    if (cached?.type && (cached.name || cached.businessId)) objects[rid] = cached;
    else missing.push(rid);
  }

  const errors: string[] = [];
  for (let i = 0; i < missing.length; i += BATCH_CHUNK_SIZE) {
    const chunk = missing.slice(i, i + BATCH_CHUNK_SIZE);
    if (!environmentMatches(getCtx(), environment)) {
      errors.push(ENVIRONMENT_CHANGED_ERROR);
      break;
    }
    try {
      const enriched = await client.batchEnrich(chunk);
      if (!environmentMatches(getCtx(), environment)) {
        errors.push(ENVIRONMENT_CHANGED_ERROR);
        break;
      }
      if (enriched.error) errors.push(enriched.error);
      for (const rid of chunk) {
        const identity = enriched.results[rid];
        if (!identity) {
          objects[rid] = null;
          continue;
        }
        const now = Date.now();
        const object: BmpObject = {
          rid,
          name: identity.name,
          type: identity.type,
          businessId: identity.businessId,
          templateBusinessId: identity.templateBusinessId,
          properties: {},
          source: 'server',
          discoveredAt: now,
          updatedAt: now,
        };
        objects[rid] = object;
        ctx.cache.put(object);
      }
    } catch (error) {
      errors.push(errorMessage(error));
      for (const rid of chunk) objects[rid] = null;
    }
  }

  ctx.sendToPanel({
    type: 'SERVER_LOOKUP_BATCH_RESULT',
    objects,
    ...(errors.length > 0 ? { error: [...new Set(errors)].join('; ') } : {}),
  });
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
      const result = await ctx.client.executeEc(buildLinkedEc(ref, def.ecProperty), undefined, false);
      if (!result.ok) {
        ctx.sendToPanel({ type: 'LINKED_LOOKUP_RESULT', rid: msg.rid, key: def.key, label: def.label });
        continue;
      }
      const parsed = parseLinkedLog(result.log);
      ctx.sendToPanel({ type: 'LINKED_LOOKUP_RESULT', rid: msg.rid, key: def.key, label: def.label, ...parsed });
    } catch (e) {
      ctx.sendToPanel({ type: 'LINKED_LOOKUP_RESULT', rid: msg.rid, key: def.key, label: def.label, error: errorMessage(e) });
    }
  }
});

register('FULL_LOOKUP', async (msg, respond) => {
  try {
    // Workshop consumes identity only. The former implementation also fetched
    // code, template identity and template children (three or four commands)
    // even though none of those fields are rendered by the current pane.
    const obj = await lookupObject(msg.rid);
    respond({ type: 'FULL_LOOKUP_RESULT', rid: msg.rid, object: obj });
  } catch (e) {
    respond({ type: 'FULL_LOOKUP_RESULT', rid: msg.rid, object: null, error: errorMessage(e) });
  }
});

register('FETCH_CHILDREN', async (msg, respond) => {
  const ctx = getCtx();
  try {
    if (!ctx.client) {
      respond({ type: 'FETCH_CHILDREN_RESULT', rid: msg.rid, children: [], error: 'Not connected' });
      return;
    }
    const children = await ctx.client.fetchChildren(msg.rid);
    respond({ type: 'FETCH_CHILDREN_RESULT', rid: msg.rid, children });
  } catch (e) {
    respond({ type: 'FETCH_CHILDREN_RESULT', rid: msg.rid, children: [], error: errorMessage(e) });
  }
});

register('FETCH_LAYOUT_TREE', async (msg, respond) => {
  const ctx = getCtx();
  try {
    if (!ctx.client) {
      respond({ type: 'LAYOUT_TREE_RESULT', rid: msg.rid, nodes: [], error: 'Not connected' });
      return;
    }
    const result = await ctx.client.fetchLayoutTree(msg.rid);
    respond({ type: 'LAYOUT_TREE_RESULT', rid: msg.rid, nodes: result.nodes, truncated: result.truncated });
  } catch (e) {
    respond({ type: 'LAYOUT_TREE_RESULT', rid: msg.rid, nodes: [], error: errorMessage(e) });
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

function emptyPaneResponse(rid: string, error?: string, environment = environmentToken(getCtx())) {
  return {
    type: 'OBJECT_PANE_DATA' as const,
    rid,
    environment,
    instance: { rid, businessId: '', type: '', name: '' },
    parent: null, template: null, card: null,
    instanceProps: {}, templateProps: {}, instanceOverrideProps: [], siblings: [], siblingTotal: 0,
    codeFields: {}, references: {},
    isPropertyDefinition: false,
    indirectCode: {}, indirectCodeRids: {}, contextValues: {}, gateValues: {}, lists: {},
    ...(error ? { error } : {}),
  };
}

/** Coalesce duplicate pane reads by RID. Aborting a browser fetch only
 * detaches the client; BMP may continue executing the EC server-side. Sharing
 * the existing promise prevents a retry from launching a duplicate command
 * while the original request is still alive. */
const inFlightPaneFetches = new Map<string, Promise<ObjectPanePayload | null>>();
const inFlightFlowFetches = new Map<string, AbortController>();

register('FETCH_OBJECT_PANE', async (msg, respond) => {
  const ctx = getCtx();
  if (!ctx.client) { respond(emptyPaneResponse(msg.rid, 'Not connected')); return; }
  const environment = environmentToken(ctx);
  const client = ctx.client;
  // A second consumer of the same RID shares the authoritative request.
  const requestKey = `${environment}::${msg.rid}`;
  let request = inFlightPaneFetches.get(requestKey);
  const ownsRequest = !request;
  if (!request) {
    request = client.fetchObjectPane(msg.rid);
    inFlightPaneFetches.set(requestKey, request);
  }
  try {
    const data = await request;
    if (!environmentMatches(getCtx(), environment)) {
      respond(emptyPaneResponse(msg.rid, ENVIRONMENT_CHANGED_ERROR, environment));
      return;
    }
    if (!data) { respond(emptyPaneResponse(msg.rid, 'Object not found', environment)); return; }
    respond({
      type: 'OBJECT_PANE_DATA',
      rid: msg.rid,
      environment,
      ...data,
    });
  } catch (e) {
    respond(emptyPaneResponse(msg.rid, errorMessage(e), environment));
  } finally {
    // Only the creator removes the shared request.
    if (ownsRequest && inFlightPaneFetches.get(requestKey) === request) {
      inFlightPaneFetches.delete(requestKey);
    }
  }
});

register('FETCH_PROPERTY_APPLICATIONS', async (msg, respond) => {
  const ctx = getCtx();
  const environment = environmentToken(ctx);
  if (!ctx.client) {
    respond({ type: 'PROPERTY_APPLICATIONS_RESULT', rid: msg.rid, ok: false, error: 'Not connected', environment });
    return;
  }
  if (!environmentMatches(ctx, msg.environment)) {
    respond({ type: 'PROPERTY_APPLICATIONS_RESULT', rid: msg.rid, ok: false, error: ENVIRONMENT_CHANGED_ERROR, environment });
    return;
  }
  const client = ctx.client;
  try {
    const result = await client.fetchPropertyApplications(msg.rid);
    if (!environmentMatches(getCtx(), environment)) {
      respond({ type: 'PROPERTY_APPLICATIONS_RESULT', rid: msg.rid, ok: false, error: ENVIRONMENT_CHANGED_ERROR, environment });
      return;
    }
    respond({ type: 'PROPERTY_APPLICATIONS_RESULT', rid: msg.rid, ok: true, ...result, environment });
  } catch (error) {
    respond({ type: 'PROPERTY_APPLICATIONS_RESULT', rid: msg.rid, ok: false, error: errorMessage(error), environment });
  }
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
  if (!environmentMatches(ctx, msg.environment)) {
    respond({ type: 'APPLY_CHANGES_RESULT', rid: msg.rid, ok: false, error: ENVIRONMENT_CHANGED_ERROR });
    return;
  }
  const client = ctx.client;
  const startedAt = Date.now();
  const object = activityObject(msg.rid, ctx.cache.get(msg.rid));
  const label = activityObjectLabel(object, msg.rid);
  try {
    const result = await client.applyObjectChanges(msg.rid, msg.target, msg.changes, msg.resetProps ?? []);
    const durationMs = Date.now() - startedAt;
    respond({ type: 'APPLY_CHANGES_RESULT', rid: msg.rid, ok: result.ok, error: result.error });
    // Activity log: edits are the most-clicked surface; the Log tab was
    // otherwise blind to them. Surface prop-by-prop summary so the user
    // can audit what they actually changed.
    const propList = [
      ...Object.keys(msg.changes),
      ...(msg.resetProps ?? []).map(prop => `${prop}↩`),
    ];
    const propSummary = propList.length === 1
      ? propList[0]
      : `${propList.length} props (${propList.slice(0, 3).join(', ')}${propList.length > 3 ? '…' : ''})`;
    if (result.ok) {
      ctx.logActivity('success', `Edited ${msg.target} ${label}: ${propSummary} (${durationMs}ms)`, undefined, {
        category: 'change', action: 'edit-object', object, durationMs,
      });
      // Drop cached enrichment so badges + detail view refresh on the
      // next read. Fire-and-forget; the panel "saved" UI doesn't need
      // to wait for the re-fetch.
      invalidateRid(msg.rid).catch(e => log.swallow('handler:applyChanges:invalidate', e));
    } else {
      // Log AND toast: the user clicked Save and the detail-view inline
      // banner is easy to miss if focus moved or the detail view
      // closed.
      ctx.logActivity('error', `Edit failed on ${label}: ${propSummary} (${durationMs}ms)`, result.error, {
        category: 'change', action: 'edit-object', object, durationMs,
      });
      ctx.toast(`Save failed: ${result.error ?? 'unknown error'}`, 'error');
    }
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    respond({ type: 'APPLY_CHANGES_RESULT', rid: msg.rid, ok: false, error: errorMessage(e) });
    ctx.logActivity('error', `Edit request failed on ${label}`, errMsg, {
      category: 'change', action: 'edit-object', object,
    });
    ctx.toast(`Save threw: ${errMsg}`, 'error');
  }
});

// Click-to-pane relay: the content script and side panel forward
// SELECT_OBJECT when the user wants to open an object in the side panel.
// We respond to the caller (for the content-script flow that does
// sendRequest) AND mirror to the panel (for fire-forget callers). The
// panel's onPortMessage already calls navigateToDetail() on receipt.
//
// Object selection and layout context are intentionally separate:
// - SELECT_OBJECT opens the detail pane.
// - SET_CONTEXT_RID (right-click / explicit context picker) retargets Workshop's layout half.
//
// Coupling these used to launch FETCH_OBJECT_PANE plus FULL_LOOKUP's identity/template/children
// commands at once. BMP can return an incomplete identity under that burst, making a valid property
// report "Object not found". Keeping selection detail-only leaves one authoritative pane request.
register('SELECT_OBJECT', (msg, respond, meta) => {
  if (!('rid' in msg)) return;
  respond({ type: 'SELECT_OBJECT', rid: msg.rid });
  const ctx = getCtx();
  ctx.sendToPanel({ type: 'SELECT_OBJECT', rid: msg.rid });
  // openPanel (flow sub-badge): surface the side panel if it isn't open.
  // No-op when already open; the queued panel message above survives the
  // panel's startup via pendingPanelMessages, so the selection isn't lost.
  if ('openPanel' in msg && msg.openPanel && meta.senderTabId != null) {
    chrome.sidePanel.open({ tabId: meta.senderTabId }).catch(e => log.swallow('sw:openPanel', e));
  }
  // If no side panel is currently connected (closed everywhere), try
  // to open it for this tab.
  if (!ctx.hasPanel) void openSidePanelForActiveTab();
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
