/**
 * Object lookup, cache, and linked object handlers.
 */

import { register } from '../handler-registry';
import { getCtx } from '../sw-context';
import { activityObject, activityObjectLabel } from '../activity-format';
import { incrementGeneration, invalidateRid } from '../enrichment';
import { clearActivityLog } from '../activity';
import { clearAllContextRids } from '../context-rid';
import { errorMessage, log } from '../logger';
import { CODE_BEARING_TYPES } from '../namespace';
import { loadColorSets } from '../color-set-cache';
import type { BmpObject, ObjectPanePayload, TypeOptionSet } from '../types';
import * as schemaCache from '../type-schema-cache';
import { refFieldsFromSchema, buildConnectionsEc, parseConnections, buildJunctionEc, parseJunctions, pickFarSide, buildInboundEc, parseInbound, type SchemaProp } from '../connections';
import type { ConnGroup } from '../types';
import { buildRowEc } from '../ec-row-codec';
import { isRidShaped } from '../validate-inbound';
import { ID_SPACE_PREFIXES } from '../ec-grammar';
import { BATCH_CHUNK_SIZE } from '../constants';
import { ENVIRONMENT_CHANGED_ERROR, environmentMatches, environmentToken } from '../environment';
import { markHostAccessRequired } from '../connection';
import { HostAccessError } from '../site-access';

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
 *  builder — kept next to the sibling builders (`buildSchemaEc`, `buildOptionsEc`). */
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
    if (e instanceof HostAccessError) {
      markHostAccessRequired();
      respond({ type: 'BROWSE_SEARCH_RESULT', query, gen, ok: false, error: 'Grant site access to search this BMP workspace' });
      return;
    }
    respond({ type: 'BROWSE_SEARCH_RESULT', query, gen, ok: false, error: e instanceof Error ? e.message : 'Search failed' });
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

/**
 * EC that enumerates a class's property configs:
 * `accessor|||label|||configClass|||systemobject|||propertyRid|||propertyId|||propertyConfigClass`
 * per property, with a leading
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
    '     _out := _out + _k.linkedTo.id + "|||" + _k.name + "|||" + _k.className + "|||" + _k.systemobject + "|||" + _k.linkedTo.rid + "|||" + _k.linkedTo.id + "|||" + _k.linkedTo.className + "\\n"',
    ')',
    '_out',
  ].join('\n');
}

export function parseSchemaPropsLog(log: string): { props: SchemaProp[]; canonical?: string } {
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
    const [accessor, label, configClass, sysFlag, propertyRid, propertyId, propertyConfigClass] = parts;
    if (!accessor || !configClass) continue;
    props.push({
      accessor: accessor.trim(),
      label: label.trim(),
      configClass: configClass.trim(),
      systemobject: sysFlag.trim() === 'true',
      ...(propertyRid?.trim() ? { propertyRid: propertyRid.trim() } : {}),
      ...(propertyId?.trim() ? { propertyId: propertyId.trim() } : {}),
      ...(propertyConfigClass?.trim() ? { propertyConfigClass: propertyConfigClass.trim() } : {}),
    });
  }
  return { props, canonical };
}

const GENERIC_SYSTEM_PROPERTIES = new Set([
  'rid', 'id', 'name', 'description', 'parent', 'model', 'self', 'sortIndex',
  'className', 'available', 'showExpression', 'useShowExpression',
]);

/** Parse BMP's human-readable `help(reference)` property table. This fallback
 * cannot expose config-class metadata, so entries are intentionally typed as
 * generic Property and cannot be mistaken for reference fields downstream. */
export function parseReferenceHelp(log: string): SchemaProp[] {
  const props: SchemaProp[] = [];
  const seen = new Set<string>();
  for (const line of (log || '').split('\n')) {
    const match = /^\|\s*\.([A-Za-z_][A-Za-z0-9_]*)\s*\|\s*([^|]*)\|\s*([^|]*)\|?/.exec(line);
    if (!match || seen.has(match[1])) continue;
    seen.add(match[1]);
    props.push({
      accessor: match[1],
      label: match[2].trim(),
      description: match[3].trim() || undefined,
      configClass: 'Property',
      systemobject: GENERIC_SYSTEM_PROPERTIES.has(match[1]),
    });
  }
  return props;
}

function safeConcreteObjectRef(ref: string | undefined): string | null {
  if (!ref) return null;
  const match = /^([a-z]{1,6})\.([A-Za-z0-9_]+)$/.exec(ref);
  if (!match || match[1] === 'o' || !ID_SPACE_PREFIXES.has(match[1])) return null;
  return ref;
}

type SchemaLoadResult =
  | { ok: true; props: SchemaProp[]; canonical?: string }
  | { ok: false; error: string };

/** Same-type schema reads commonly arrive together from the picker, property
 * pane, connections, and editor completion. One authoritative BMP command is
 * enough; every caller can share its immutable result. */
const inFlightSchemaLoads = new Map<string, Promise<SchemaLoadResult>>();

/** Cache-or-fetch a type's schema props. `refresh` bypasses the cache.
 *  Exported for the AI read_type tool, which reuses this exact live path. */
export async function loadSchemaProps(className: string, refresh = false, exampleRef?: string): Promise<
  SchemaLoadResult
> {
  const ctx = getCtx();
  const serverId = environmentToken(ctx);
  if (!ctx.client) return { ok: false, error: 'Not connected' };
  if (!refresh) {
    await schemaCache.load();
    const cached = schemaCache.get(serverId, className);
    if (cached) return { ok: true, props: cached, canonical: schemaCache.getCanonical(serverId, className) };
  }
  // BMP class names are PascalCase — guard against shipping an arbitrary
  // string into EC.
  if (!/^[A-Z][A-Za-z0-9]{0,63}$/.test(className)) return { ok: false, error: `Invalid class name: ${className}` };
  const concreteRef = safeConcreteObjectRef(exampleRef);
  const requestKey = `${serverId}::${className}::${concreteRef ?? ''}`;
  const existing = inFlightSchemaLoads.get(requestKey);
  if (existing) return existing;

  const request = (async (): Promise<SchemaLoadResult> => {
    const result = await ctx.client!.executeEc(buildSchemaEc(className), undefined, false);
    const parsed = result.ok ? parseSchemaPropsLog(result.log ?? '') : { props: [] as SchemaProp[] };
    let { props } = parsed;
    const canonical = parsed.canonical ?? className;
    if (props.length === 0 && concreteRef) {
      const help = await ctx.client!.executeEc(`help(${concreteRef})`, undefined, false);
      if (help.ok) props = parseReferenceHelp(help.log ?? '');
    }
    if (props.length === 0) {
      return {
        ok: false,
        error: result.ok
          ? 'No properties returned (unknown class?)'
          : result.error || result.log || 'EC execution failed',
      };
    }
    schemaCache.set(serverId, className, props, canonical);
    return { ok: true, props, canonical };
  })();
  inFlightSchemaLoads.set(requestKey, request);
  try {
    return await request;
  } finally {
    if (inFlightSchemaLoads.get(requestKey) === request) {
      inFlightSchemaLoads.delete(requestKey);
    }
  }
}

register('FETCH_TYPE_SCHEMA', async (msg, respond) => {
  const environment = environmentToken(getCtx());
  try {
    const r = await loadSchemaProps(msg.className, msg.refresh, msg.exampleRef);
    if (r.ok) respond({ type: 'FETCH_TYPE_SCHEMA_RESULT', className: msg.className, ok: true, props: r.props, canonicalClassName: r.canonical, environment });
    else respond({ type: 'FETCH_TYPE_SCHEMA_RESULT', className: msg.className, ok: false, error: r.error, environment });
  } catch (e) {
    respond({ type: 'FETCH_TYPE_SCHEMA_RESULT', className: msg.className, ok: false, error: errorMessage(e), environment });
  }
});

register('FETCH_TYPE_SCHEMAS', async (msg, respond) => {
  const environment = environmentToken(getCtx());
  const classNames = [...new Set(msg.classNames.filter(Boolean))];
  const results = [];
  for (const className of classNames) {
    if (environmentToken(getCtx()) !== environment) {
      results.push({ className, ok: false as const, error: ENVIRONMENT_CHANGED_ERROR });
      continue;
    }
    try {
      const result = await loadSchemaProps(className);
      results.push(result.ok
        ? { className, ok: true as const, props: result.props, canonicalClassName: result.canonical }
        : { className, ok: false as const, error: result.error });
    } catch (error) {
      results.push({ className, ok: false as const, error: errorMessage(error) });
    }
  }
  respond({ type: 'FETCH_TYPE_SCHEMAS_RESULT', results, environment });
});

/**
 * Enumerate the allowed values of a class's list/tag properties. Branches on
 * the property-config class (ListMethodConfig/HistoricalListMethodConfig read
 * `.listPropertySet`; TagMethodConfig reads `.tagList` — reading the wrong one
 * THROWS, hence the strict branch). Emits `__prop__|||<accessor>|||list|tag`
 *
 * Coverage is COMPLETE for option-bearing (t.<businessId>) properties, verified
 * against the decompiled 5.6.10.0 MethodConfig taxonomy + live introspection:
 *   - ListMethodConfig + HistoricalListMethodConfig  → .listPropertySet
 *   - TagMethodConfig                                 → .tagList
 * There is NO HistoricalTagMethodConfig (tags aren't historized — Historical*
 * variants exist for Boolean/Date/List/Number/Progress/Reference/RichText/
 * Status/Text but not Tag), so "historical list/tag" = historical-LIST + tag.
 * Deliberately excluded: StatusMethodConfig (no ListPropertySet — its values are
 * a fixed runtime status type, not t.<id> objects), Boolean (TRUE/FALSE, not a
 * ref), and Reference/ReverseReference (target arbitrary objects, not a fixed
 * option set — navigation is handled by the .ref()/.rref() completion instead).
 * then `__opt__|||<id>|||<name>` per member. ELSE branches are filled because EC
 * rejects an empty ELSE. Live-verified against CeRiskAssessment (76ms, 11 sets).
 *
 * A member with no display name falls back to its id (`.name.whenMissing(_i.id)`)
 * so one nameless item can't throw and wipe the class's whole option fetch.
 *
 * Limitation: if a malformed prop has its listPropertySet/tagList unset, the
 * whole forEach throws and value autocomplete degrades to nothing for THAT class
 * (property-name completion is a separate fetch, so it's unaffected). A defensive
 * `.isMissing` guard was tried but spams missing-value warnings without being
 * verifiable against a real malformed prop, so it's omitted — well-formed BMP
 * configs always have the set, and the failure path is already graceful.
 */
export function buildOptionsEc(className: string): string {
  return [
    `_cls := c.get(${className}.name)`,
    '_out := ""',
    '_kids := _cls.children()',
    '_kids.forEach(_k:',
    '     _cn := _k.className',
    '     _kind := ""',
    '     IF _cn = "ListMethodConfig" OR _cn = "HistoricalListMethodConfig" THEN',
    '          _kind := "list"',
    '     ELSE',
    '          IF _cn = "TagMethodConfig" THEN',
    '               _kind := "tag"',
    '          ELSE',
    '               _kind := ""',
    '          ENDIF',
    '     ENDIF',
    '     IF _kind != "" THEN',
    '          IF _kind = "list" THEN',
    '               _set := _k.listPropertySet',
    '          ELSE',
    '               _set := _k.tagList',
    '          ENDIF',
    '          _out := _out + "__prop__|||" + _k.linkedTo.id + "|||" + _kind + "\\n"',
    '          _set.children().forEach(_i:',
    '               _out := _out + "__opt__|||" + _i.id + "|||" + _i.name.whenMissing(_i.id) + "\\n"',
    '          )',
    '     ELSE',
    '          _out := _out',
    '     ENDIF',
    ')',
    '_out',
  ].join('\n');
}

export function parseOptionsLog(log: string): TypeOptionSet[] {
  const sets: TypeOptionSet[] = [];
  let current: TypeOptionSet | null = null;
  for (const line of (log || '').split('\n')) {
    const parts = line.split('|||');
    if (parts[0] === '__prop__' && parts.length === 3) {
      current = { accessor: parts[1].trim(), multi: parts[2].trim() === 'tag', items: [] };
      sets.push(current);
    } else if (parts[0] === '__opt__' && parts.length >= 3 && current) {
      const id = parts[1].trim();
      // Rejoin the tail so a display name that itself contains `|||` isn't
      // dropped (ids never do). `>= 3` rather than `=== 3` for the same reason.
      if (id) current.items.push({ ref: `t.${id}`, name: parts.slice(2).join('|||').trim() });
    }
  }
  // Drop sets that resolved to zero members (defensive — nothing to suggest).
  return sets.filter(s => s.items.length > 0);
}

// In-memory per (server, class) cache. Options change rarely and are cheap to
// re-fetch (~76ms), so we don't persist them across SW restarts.
const optionsCache = new Map<string, TypeOptionSet[]>();

async function loadTypeOptions(className: string, refresh = false): Promise<
  { ok: true; options: TypeOptionSet[] } | { ok: false; error: string }
> {
  const ctx = getCtx();
  if (!ctx.client) return { ok: false, error: 'Not connected' };
  const key = `${environmentToken(ctx)}::${className.toLowerCase()}`;
  if (!refresh) {
    const cached = optionsCache.get(key);
    if (cached) return { ok: true, options: cached };
  }
  if (!/^[A-Z][A-Za-z0-9]{0,63}$/.test(className)) return { ok: false, error: `Invalid class name: ${className}` };
  const result = await ctx.client.executeEc(buildOptionsEc(className), undefined, false);
  if (!result.ok) return { ok: false, error: result.error || result.log || 'EC execution failed' };
  const options = parseOptionsLog(result.log ?? '');
  optionsCache.set(key, options);
  return { ok: true, options };
}

register('FETCH_TYPE_OPTIONS', async (msg, respond) => {
  try {
    const r = await loadTypeOptions(msg.className, msg.refresh);
    if (r.ok) respond({ type: 'FETCH_TYPE_OPTIONS_RESULT', className: msg.className, ok: true, options: r.options });
    else respond({ type: 'FETCH_TYPE_OPTIONS_RESULT', className: msg.className, ok: false, error: r.error });
  } catch (e) {
    respond({ type: 'FETCH_TYPE_OPTIONS_RESULT', className: msg.className, ok: false, error: errorMessage(e) });
  }
});

register('FETCH_CONNECTIONS', async (msg, respond) => {
  const ctx = getCtx();
  if (!ctx.client) { respond({ type: 'CONNECTIONS_RESULT', rid: msg.rid, ok: false, error: 'Not connected' }); return; }
  try {
    // 1. Discover the type's reference fields (cached schema).
    const schema = await loadSchemaProps(msg.className);
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
    const schema = await loadSchemaProps(msg.className);
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
