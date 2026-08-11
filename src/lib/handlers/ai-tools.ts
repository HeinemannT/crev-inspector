/**
 * Read-only AI tool execution (service worker side). Each tool backs onto an
 * existing bmp-client / handler path — the same code the object pane, Browse
 * search, Code Search, Blueprint layout and editor Preview already use.
 *
 * DEFENSIVE BY CONTRACT: `executeAiTool` never throws. An unknown business id,
 * a permission error, a BMP timeout, or a malformed argument all resolve to a
 * readable `{ isError: true }` result so the chat loop can hand the model a
 * string it can adapt to — the loop must never blow up on a bad tool call.
 *
 * READ-ONLY: nothing here mutates BMP. preview_ec runs non-transactionally.
 */

import { getCtx } from '../sw-context';
import type { BmpClient } from '../bmp-client';
import type { ToolCall, ToolResult } from '../ai/tools';
import { TOOL_NAMES, toolResultWithObjects, truncateToolResult } from '../ai/tools';
import type { AiContextEnvelope, AiContextSource } from '../ai/types';
import type { ObjectReference } from '../types';
import { bmpTypeKnowledge } from '../bmp-type-knowledge';
import { collectCodeSearch } from '../code-search';
import { codeFieldsFor, referencesFor, contextFieldsFor, typeAffordances } from '../widget-metadata';
import { errorMessage, log } from '../logger';
import { formatEcLiteral, validateEcIdentifier, validateRid } from '../ec-guards';
import { loadPageStructure, type LoadPageStructureResult } from '../layout-service';
import type { LNode } from '../layout/types';

/** Inline a code slot body only when it's this small; otherwise report size. */
const SLOT_INLINE_LIMIT = 1200;
/** Cap on search / layout rows folded into one tool result. */
const SEARCH_CAP = 25;
/** Context queries stay compact enough for both BMP and the model. */
const CONTEXT_FIELD_CAP = 5;
/** Identity columns are unconditional in query_context output. Silently drop
 *  them from `fields` so a model cannot waste EC work asking for aliases such
 *  as businessId (the actual EC property is `id`). */
const CONTEXT_IDENTITY_FIELDS = new Set(['name', 'type', 'className', 'businessId', 'id', 'rid']);
const AI_LAYOUT_CACHE_MS = 15_000;
const AI_LAYOUT_CACHE_MAX = 20;
const AI_LAYOUT_NODE_CAP = 80;
const AI_LAYOUT_CHAR_BUDGET = 7_500;
const layoutCache = new WeakMap<BmpClient, Map<string, {
  expiresAt: number;
  promise: Promise<LoadPageStructureResult>;
}>>();

/** A tool result that always ends up truncated to the shared byte cap. */
function ok(content: string, objects: readonly ObjectReference[] = []): ToolResult {
  return objects.length
    ? toolResultWithObjects(content, objects)
    : { content: truncateToolResult(content), isError: false };
}
function err(message: string): ToolResult {
  return { content: message, isError: true };
}

/** Execute one read-only tool call. Returns a readable result; never throws. */
export async function executeAiTool(
  call: ToolCall,
  signal?: AbortSignal,
  envelope?: AiContextEnvelope,
): Promise<ToolResult> {
  const ctx = getCtx();
  if (!TOOL_NAMES.has(call.name)) return err(`Unknown tool: ${call.name}`);
  if (!ctx.client) return err('Not connected to a BMP server. Ask the user to connect first.');
  try {
    switch (call.name) {
      case 'query_context': return await queryContext(ctx.client, call.input, envelope, signal);
      case 'read_object': return await readObject(ctx.client, call.input, signal);
      case 'read_code': return await readCode(ctx.client, call.input);
      case 'read_type': return await readType(call.input);
      case 'search_objects': return await searchObjects(ctx.client, call.input, signal);
      case 'code_search': return await codeSearch(call.input);
      case 'read_layout': return await readLayout(ctx.client, call.input);
      case 'preview_ec': return await previewEc(ctx.client, call.input, signal);
      default: return err(`Unhandled tool: ${call.name}`);
    }
  } catch (e) {
    log.swallow(`ai-tool:${call.name}`, e);
    return err(`Tool ${call.name} failed: ${errorMessage(e)}`);
  }
}

// ── query_context ───────────────────────────────────────────────

/** “Here” follows the explicit Inspect selection when both a selection and an
 *  editor chip are attached; otherwise the first source is the only sensible
 *  scope. This rule mirrors the visible context rather than trusting a model to
 *  copy a RID back into its call. */
function contextSource(envelope?: AiContextEnvelope): AiContextSource | null {
  if (!envelope?.sources.length) return null;
  return envelope.sources.find(source => source.kind === 'selection') ?? envelope.sources[0];
}

function stringArray(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) return null;
  return value.map(item => item.trim()).filter(Boolean);
}

/** Pure EC builder exported for byte-level tests. Every identifier slot is
 *  validated and every value slot escaped before interpolation. */
export function buildContextQueryEc(
  contextRef: string,
  type: string | undefined,
  templateQuery: string | undefined,
  fields: string[],
  filterField?: string,
  filterValue?: string,
): string {
  const safeType = type ? validateEcIdentifier(type) : undefined;
  const safeFields = fields.map(validateEcIdentifier);
  const safeFilterField = filterField ? validateEcIdentifier(filterField) : undefined;
  const lines = [
    `_view := ${contextRef}`,
    '_context := _view',
    '_effective := _view.template',
    'IF _effective != MISSING THEN',
    '     _context := _effective',
    'ELSE',
    '     _context := _context',
    'ENDIF',
    `_all := _context.descendants(${safeType ?? ''})`,
  ];
  if (templateQuery) {
    const query = formatEcLiteral(templateQuery);
    lines.push(
      `_linked := _all.filter(linkedTo.name = "*${query}*")`,
      `_templated := _all.filter(template.name = "*${query}*")`,
      '_items := _linked.union(_templated).distinct()',
    );
  } else {
    lines.push('_items := _all');
  }
  if (safeFilterField && filterValue !== undefined) {
    lines.push(`_items := _items.filter(${safeFilterField} = "*${formatEcLiteral(filterValue)}*")`);
  }
  lines.push(
    '_count := _items.size()',
    '_byClass := _items.map(className)',
    '_classes := ""',
    '_items.as(className).distinct().forEach(_class:',
    '     _classes := _classes + _class + "=" + _byClass.get(_class).size() + ", "',
    ')',
    '_rows := ""',
    '_refs := ""',
    '_shown := 0',
    '_items.forEach(_item:',
    `     IF _shown < ${SEARCH_CAP} THEN`,
    '          _name := _item.name.whenMissing("(unnamed)")',
    '          _bid := _item.id.whenMissing("(missing)")',
    '          _template := _item.linkedTo',
    '          IF _template = MISSING THEN _template := _item.template ELSE _template := _template ENDIF',
    '          _templateName := "(none)"',
    '          IF _template != MISSING THEN _templateName := _template.name.whenMissing("(unnamed)") ELSE _templateName := _templateName ENDIF',
    '          _line := "  " + _name + " (" + _item.className + ") bid=" + _bid + " rid=" + _item.rid + " template=" + _templateName',
  );
  safeFields.forEach((field, index) => {
    lines.push(
      `          _field${index} := _item.${field}.whenMissing("(missing)")`,
      `          _line := _line + "\\t${field}=" + _field${index}`,
    );
  });
  lines.push(
    '          _rows := _rows + _line + "\\n"',
    '          _refs := _refs + "rid=" + _item.rid + ","',
    '          _shown := _shown + 1',
    '     ENDIF',
    ')',
    '_out := "Viewed: " + _view.name + " (" + _view.className + ") bid=" + _view.id + " rid=" + _view.rid + "\\nEffective owner: " + _context.name + " (" + _context.className + ") bid=" + _context.id + " rid=" + _context.rid + "\\nMatched: " + _count + "\\nClasses: " + _classes + "\\n" + _rows + "Refs: " + _refs + "\\n"',
    `IF _count > ${SEARCH_CAP} THEN`,
    `     _out := _out + "… rows capped at ${SEARCH_CAP}; narrow the filter"`,
    'ENDIF',
    '_out',
  );
  return lines.join('\n');
}

async function queryContext(
  client: BmpClient,
  input: Record<string, unknown>,
  envelope?: AiContextEnvelope,
  signal?: AbortSignal,
): Promise<ToolResult> {
  const source = contextSource(envelope);
  if (!source) return err('query_context needs an attached selection or editor context.');
  const type = typeof input.type === 'string' ? input.type.trim() : '';
  const templateQuery = typeof input.templateQuery === 'string' ? input.templateQuery.trim() : '';
  if (!type && !templateQuery) return err('query_context needs either a real BMP descendant "type" or a semantic "templateQuery".');
  const requestedFields = stringArray(input.fields);
  if (requestedFields === null) return err('query_context "fields" must be an array of property names.');
  const fields = [...new Set(requestedFields.filter(field => !CONTEXT_IDENTITY_FIELDS.has(field)))];
  if (fields.length > CONTEXT_FIELD_CAP) return err(`query_context accepts at most ${CONTEXT_FIELD_CAP} additional fields.`);
  const filterField = typeof input.filterField === 'string' ? input.filterField.trim() : '';
  const filterValue = typeof input.filterValue === 'string' ? input.filterValue.trim() : '';
  if (!!filterField !== !!filterValue) return err('query_context filterField and filterValue must be provided together.');

  try {
    const contextRef = await client.resolveRef(source.object.rid);
    const code = buildContextQueryEc(
      contextRef,
      type || undefined,
      templateQuery || undefined,
      fields,
      filterField || undefined,
      filterValue || undefined,
    );
    const res = await client.executeEc(code, undefined, false, signal);
    if (!res.ok) return err(`Context query failed:\n${res.error ?? res.log ?? 'unknown EC error'}`);
    const guidance = res.hasWarning
      ? 'Scope was resolved from the attached context. Missing-value warnings are expected when mixed linkedTo/template models are inspected; use the returned matches and class distribution. For an object/class question this result is final: answer now without another query or exemplar read. Retry only if a specifically requested field is absent, and do not rediscover these objects with search_objects.'
      : 'Scope was resolved from the attached context and the count/filter evaluation is complete; rows may be capped as stated. For an object/class question this result is final: answer now without another query or exemplar read. Do not call search_objects or read_object for them unless the user requested additional properties not shown here.';
    const objects: ObjectReference[] = [source.object];
    const refLine = (res.log ?? '').split('\n').filter(line => line.startsWith('Refs: ')).at(-1);
    const rids = [...(refLine ?? '').matchAll(/rid=(-?\d+),/g)].map(match => match[1]);
    if (rids.length) {
      try {
        const enriched = await client.batchEnrich(rids, signal);
        for (const rid of rids) objects.push({ rid, ...enriched.results[rid] });
      } catch (e) {
        // The EC result still verifies these RIDs. Keep sparse references so
        // the normal chip can resolve details lazily instead of losing links.
        log.swallow('ai-tool:query-context-enrich', e);
        objects.push(...rids.map(rid => ({ rid })));
      }
    }
    return ok(`${res.log ?? '(no output)'}\n${guidance}`, objects);
  } catch (e) {
    return err(`Invalid context query: ${errorMessage(e)}`);
  }
}

// ── read_object ──────────────────────────────────────────────────

const REF_ROW = '';
const identSafe = (s: string) => s.replace(/[^\w.-]/g, '');

/** Resolve a business id to a numeric rid through the two page/object id spaces. */
async function resolveBusinessIdToRid(client: BmpClient, ref: string): Promise<string | null> {
  const trimmed = ref.trim();
  if (!trimmed) return null;
  const emit = `_out := str(_o.rid) + "${REF_ROW}"`;
  const id = identSafe(trimmed);
  const resolve = [`_o := t.get("${id}")`, 'IF _o.isMissing() THEN', `     _o := o.get("${id}")`, 'ENDIF'];
  const code = [...resolve, 'IF _o.isMissing() THEN', '     _out := ""', 'ELSE', `     ${emit}`, 'ENDIF', '_out'].join('\n');
  const res = await client.executeEc(code, undefined, false);
  if (!res.ok || !res.log) return null;
  const first = res.log.split(REF_ROW)[0]?.trim() ?? '';
  const rid = first.replace(/^Result\s*:\s*/i, '').trim();
  return /^-?\d+$/.test(rid) ? rid : null;
}

type RefType = 'rid' | 'businessId';

/** Resolve the AI's ambiguous string reference. BMP RIDs are 64-bit values and
 *  normally exceed JS's safe-integer range; short numeric refs are therefore
 *  tried as business IDs first. refType remains the authoritative override. */
async function resolveToolRef(client: BmpClient, ref: string, refType?: RefType): Promise<string | null> {
  const trimmed = ref.trim();
  const numeric = /^-?\d+$/.test(trimmed);
  if (refType === 'rid') return numeric ? validateRid(trimmed) : null;
  if (refType === 'businessId' || !numeric) return resolveBusinessIdToRid(client, trimmed);

  const value = BigInt(trimmed);
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    return validateRid(trimmed);
  }
  return await resolveBusinessIdToRid(client, trimmed) ?? validateRid(trimmed);
}

async function readObject(client: BmpClient, input: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
  const ref = typeof input.ref === 'string' ? input.ref : '';
  if (!ref.trim()) return err('read_object needs a "ref" (business id or rid).');
  const trimmed = ref.trim();
  const refType = input.refType === 'rid' || input.refType === 'businessId' ? input.refType : undefined;
  const rid = await resolveToolRef(client, trimmed, refType);
  if (!rid) return err(`No object found for "${ref}". Check the business id / rid, or use search_objects.`);
  const pane = await client.fetchObjectPane(rid, signal);
  if (!pane) return err(`Could not read object ${rid}.`);

  const lines: string[] = [];
  const id = pane.instance;
  lines.push(`Object: ${id.name} (${id.type})  bid=${id.businessId}  rid=${id.rid}`);
  if (pane.template) lines.push(`Template: ${pane.template.name} (${pane.template.type}) bid=${pane.template.businessId}`);
  if (pane.parent) lines.push(`Parent: ${pane.parent.name} (${pane.parent.type}) bid=${pane.parent.businessId}`);

  const props = { ...pane.templateProps, ...pane.instanceProps };
  const propKeys = Object.keys(props).filter(k => props[k] !== '');
  if (propKeys.length) {
    lines.push('Properties:');
    for (const k of propKeys.sort()) lines.push(`  ${k} = ${props[k]}`);
  }
  const ctxKeys = Object.keys(pane.contextValues).filter(k => pane.contextValues[k] !== '');
  if (ctxKeys.length) {
    lines.push('Context values:');
    for (const k of ctxKeys.sort()) lines.push(`  ${k} = ${pane.contextValues[k]}`);
  }
  const refKeys = Object.keys(pane.references);
  if (refKeys.length) {
    lines.push('References:');
    for (const k of refKeys.sort()) {
      const t = pane.references[k];
      lines.push(`  ${k} -> ${t ? `${t.name} (${t.type}) bid=${t.businessId}` : '(unset)'}`);
    }
  }
  const codeEntries = Object.entries(pane.codeFields).filter(([, v]) => v);
  if (codeEntries.length) {
    lines.push('Code slots:');
    for (const [name, code] of codeEntries.sort((a, b) => a[0].localeCompare(b[0]))) {
      if (code.length <= SLOT_INLINE_LIMIT) {
        lines.push(`  ${name} (${code.length} chars):`);
        lines.push('```');
        lines.push(code);
        lines.push('```');
      } else {
        lines.push(`  ${name}: ${code.length} chars (large — not inlined)`);
      }
    }
  }
  return ok(lines.join('\n'), [
    pane.instance,
    ...(pane.template ? [pane.template] : []),
    ...(pane.parent ? [pane.parent] : []),
    ...Object.values(pane.references).filter((object): object is NonNullable<typeof object> => !!object),
  ]);
}

// ── read_code ───────────────────────────────────────────────────

async function readCode(client: BmpClient, input: Record<string, unknown>): Promise<ToolResult> {
  const ref = typeof input.ref === 'string' ? input.ref.trim() : '';
  const property = typeof input.property === 'string' ? input.property.trim() : '';
  if (!ref) return err('read_code needs a "ref" (prefer a numeric rid returned by another tool).');
  if (!property) return err('read_code needs a code "property", such as "expression", "html" or "javascript".');
  let safeProperty: string;
  try { safeProperty = validateEcIdentifier(property); }
  catch (e) { return err(errorMessage(e)); }
  const refType = input.refType === 'rid' || input.refType === 'businessId' ? input.refType : undefined;
  const rid = await resolveToolRef(client, ref, refType);
  if (!rid) return err(`No object found for "${ref}".`);
  const values = await client.fetchCodeViaEc(rid, [safeProperty]);
  const code = values[safeProperty] ?? '';
  const language = safeProperty === 'html' ? 'html' : safeProperty === 'css' ? 'css' : safeProperty === 'javascript' ? 'javascript' : 'extended';
  const guidance = safeProperty === 'expression'
    ? '\nRaw expression read is complete. If SELECT or table(...) directly names the requested class or properties, answer from this source now; do not call query_context, read_object or preview_ec merely to confirm those literals.'
    : '';
  return ok(`Code: rid=${rid} property=${safeProperty} (${code.length} chars)\n\`\`\`${language}\n${code}\n\`\`\`${guidance}`);
}

// ── read_type ────────────────────────────────────────────────────

async function readType(input: Record<string, unknown>): Promise<ToolResult> {
  const type = typeof input.type === 'string' ? input.type.trim() : '';
  if (!type) return err('read_type needs a "type" (PascalCase class name).');

  const lines: string[] = [`Type: ${type}`];
  const aff = typeAffordances(type);
  lines.push(`Affordances: code=${aff.code} references=${aff.references} flow=${aff.flow}`);

  // Static anatomy from the TYPE_META seam (what the tool models per type).
  const codeF = codeFieldsFor(type);
  if (codeF.length) lines.push(`Code slots (metadata): ${codeF.map(f => f.prop + (f.enabledBy ? ` [gated by ${f.enabledBy}]` : '')).join(', ')}`);
  const refF = referencesFor(type);
  if (refF.length) lines.push(`Reference edges (metadata): ${refF.map(r => r.prop).join(', ')}`);
  const ctxF = contextFieldsFor(type);
  if (ctxF.length) lines.push(`Context fields (metadata): ${ctxF.map(c => `${c.prop} (${c.kind})`).join(', ')}`);

  // Live schema probe — the exact path the Vars panel uses.
  const schema = await bmpTypeKnowledge.properties({ className: type });
  if (schema.ok) {
    const canonical = schema.canonical && schema.canonical !== type ? ` (canonical: ${schema.canonical})` : '';
    lines.push(`Live properties${canonical}:`);
    for (const p of schema.props) {
      lines.push(`  ${p.accessor}  "${p.label}"  [${p.configClass}]${p.systemobject ? ' (system)' : ''}`);
    }
  } else {
    lines.push(`Live schema unavailable: ${schema.error}`);
  }
  return ok(lines.join('\n'));
}

// ── search_objects ───────────────────────────────────────────────

async function searchObjects(client: BmpClient, input: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
  const query = typeof input.query === 'string' ? input.query.trim() : '';
  if (!query) return err('search_objects needs a "query".');
  const typeFilter = typeof input.type === 'string' ? input.type.trim() : '';
  const { totalHits, objects } = await client.quickSearch(query, { pageSize: 40, signal });
  let hits = objects;
  if (typeFilter) hits = hits.filter(o => (o.type ?? '') === typeFilter);
  const shown = hits.slice(0, SEARCH_CAP);
  if (shown.length === 0) return ok(`No matches for "${query}"${typeFilter ? ` of type ${typeFilter}` : ''}.`);
  // quickSearch returns rids only. Enrich with businessId + template bid in ONE
  // batched EC round trip (the battle-tested client.batchEnrich: version-aware
  // rid resolution, linkedTo then template fallback) so the model can reference
  // each hit directly as t.<bid> instead of dereferencing every hit with
  // read_object. That per-hit read_object storm is what used to burn the tool
  // budget and trigger the DSML text leak. Defensive: a failed probe just
  // leaves hits showing rid only.
  let enrich: Awaited<ReturnType<BmpClient['batchEnrich']>>['results'] = {};
  try {
    enrich = (await client.batchEnrich(shown.map(o => o.rid), signal)).results;
  } catch (e) {
    log.swallow('ai-tool:search:enrich', e);
  }
  const lines = [`${shown.length} of ${totalHits} hit(s) for "${query}"${typeFilter ? ` (type=${typeFilter})` : ''}:`];
  for (const o of shown) {
    const e = enrich[o.rid];
    const bid = e?.businessId ? `bid=${e.businessId} ` : '';
    const tpl = e?.templateBusinessId ? `  [tpl bid=${e.templateBusinessId}]` : '';
    lines.push(`  ${o.name ?? '(no name)'} (${o.type ?? '?'}) ${bid}rid=${o.rid}${tpl}`);
  }
  return ok(lines.join('\n'), shown.map(object => {
    const resolved = enrich[object.rid];
    return {
      rid: object.rid,
      name: object.name,
      type: object.type,
      businessId: resolved?.businessId,
      templateBusinessId: resolved?.templateBusinessId,
    };
  }));
}

// ── code_search ──────────────────────────────────────────────────

async function codeSearch(input: Record<string, unknown>): Promise<ToolResult> {
  const pattern = typeof input.pattern === 'string' ? input.pattern : '';
  if (!pattern.trim()) return err('code_search needs a "pattern".');
  const typeFilter = typeof input.type === 'string' && input.type.trim() ? [input.type.trim()] : undefined;
  const { results, capped, error } = await collectCodeSearch(pattern, { types: typeFilter, cap: 30 });
  if (error && results.length === 0) return err(`code_search failed: ${error}`);
  if (results.length === 0) return ok(`No code matches for "${pattern}".`);
  const lines = [
    ...(error ? [`WARNING — ${error}`] : []),
    `${results.length} match(es)${capped ? ' (capped)' : ''} for "${pattern}":`,
  ];
  for (const r of results) {
    const line = r.matchingLines[0];
    const where = line ? `L${line.lineNum}: ${line.text.trim()}` : '';
    lines.push(`  ${r.name || '(no name)'} (${r.type}) bid=${r.businessId} .${r.property}  ${where}`);
  }
  return ok(lines.join('\n'), results.map(result => ({
    rid: result.rid,
    name: result.name,
    type: result.type,
    businessId: result.businessId,
  })));
}

// ── read_layout ──────────────────────────────────────────────────

async function readLayout(client: BmpClient, input: Record<string, unknown>): Promise<ToolResult> {
  const pageRid = typeof input.pageRid === 'string' ? input.pageRid.trim() : '';
  if (!/^-?\d+$/.test(pageRid)) return err('read_layout needs a numeric "pageRid".');
  const focusRid = typeof input.focusRid === 'string' ? input.focusRid.trim() : '';
  if (focusRid && !/^-?\d+$/.test(focusRid)) return err('read_layout "focusRid" must be a numeric rid.');
  const page = await loadAiLayout(client, pageRid);
  if (!page) return err(`No web layout for viewed object ${pageRid} (not a supported page host?).`);
  const projection = projectAiLayout(pageRid, page, focusRid || undefined);
  return ok(projection.text, projection.objects);
}

function loadAiLayout(client: BmpClient, pageRid: string): Promise<LoadPageStructureResult> {
  let clientCache = layoutCache.get(client);
  if (!clientCache) {
    clientCache = new Map();
    layoutCache.set(client, clientCache);
  }
  const cached = clientCache.get(pageRid);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;
  if (cached) clientCache.delete(pageRid);
  while (clientCache.size >= AI_LAYOUT_CACHE_MAX) {
    const oldest = clientCache.keys().next().value;
    if (oldest === undefined) break;
    clientCache.delete(oldest);
  }
  const promise = loadPageStructure(client, pageRid);
  const entry = { expiresAt: Date.now() + AI_LAYOUT_CACHE_MS, promise };
  clientCache.set(pageRid, entry);
  void promise.catch(() => {
    if (clientCache?.get(pageRid) === entry) clientCache.delete(pageRid);
  });
  return promise;
}

/** Compact, bounded AI projection of the dual-model page structure. Portal
 * Tabs/Containers and page-owned widgets remain visibly distinct. */
export interface AiLayoutProjection {
  text: string;
  /** Exact identities represented in `text`, plus the effective page owner. */
  objects: ObjectReference[];
}

function findLayoutNode(nodes: LNode[], rid: string): LNode | undefined {
  for (const node of nodes) {
    if (node.rid === rid) return node;
    const nested = findLayoutNode(node.children, rid);
    if (nested) return nested;
  }
  return undefined;
}

export function projectAiLayout(
  viewedRid: string,
  page: NonNullable<LoadPageStructureResult>,
  focusRid?: string,
): AiLayoutProjection {
  const { ctx, load } = page;
  const model = load.model;
  const count = (nodes: LNode[]): number => nodes.reduce((n, node) => n + 1 + count(node.children), 0);
  const objects: ObjectReference[] = [{
    rid: ctx.pageRid,
    businessId: model.pageId,
    type: model.pageClass,
    name: model.pageName,
  }];
  const focus = focusRid ? findLayoutNode(model.tabs, focusRid) : undefined;
  if (focusRid && !focus) {
    return {
      text: `Layout focus rid=${focusRid} was not found on viewed page rid=${viewedRid}.`,
      objects,
    };
  }
  const roots = focus ? [focus] : model.tabs;
  const total = count(roots);
  const lines = [
    `Viewed rid=${viewedRid}`,
    `Effective page owner: ${model.pageName || model.pageId} (${model.pageClass}) bid=${model.pageId} rid=${ctx.pageRid}`,
    `Contributing TabSets: ${(model.tabsets?.length ? model.tabsets : [{ id: model.tabsetId, name: model.tabsetId }]).map(t => `${t.name} [${t.id}]`).join(', ')}`,
    `Layout: ${count(model.tabs)} total nodes${model.resultOnly ? ' (shared Result tab)' : ''}${focus ? `; focused subtree rid=${focus.rid} has ${total}` : ''}`,
  ];
  if (ctx.pageRid !== viewedRid) lines.push('Resolution: viewed enterprise instance → .template page owner');
  let emitted = 0;
  let chars = lines.join('\n').length;
  const walk = (node: LNode, depth: number, quota: number): number => {
    if (quota <= 0 || emitted >= AI_LAYOUT_NODE_CAP) return 0;
    const storage = node.kind === 'widget' ? 'page-child' : 'portal-shared';
    const slots = node.kind === 'widget' ? codeFieldsFor(node.className).map(field => field.prop) : [];
    const provenance = node.kind === 'tab' ? ` tabset=${node.tabsetId ?? model.tabsetId}` : '';
    const line = `${'  '.repeat(depth + 1)}${node.className} "${node.name}" bid=${node.id}${node.rid ? ` rid=${node.rid}` : ''} span=${node.cols.L} model=${storage}${provenance}${slots.length ? ` code=${slots.join(',')}` : ''}`;
    if (chars + line.length + 1 > AI_LAYOUT_CHAR_BUDGET) return 0;
    lines.push(line);
    chars += line.length + 1;
    emitted++;
    if (node.rid) {
      objects.push({
        rid: node.rid,
        businessId: node.id,
        type: node.className,
        name: node.name,
      });
    }
    let used = 1;
    for (const child of node.children) {
      if (used >= quota) break;
      used += walk(child, depth + 1, quota - used);
    }
    return used;
  };
  // Divide the initial outline budget across top-level tabs so one enormous
  // first tab cannot hide every later tab (and their focus rids). A focused
  // subtree has one root and therefore receives the full budget.
  roots.forEach((tab, index) => {
    const remainingRoots = roots.length - index;
    const quota = Math.max(1, Math.floor((AI_LAYOUT_NODE_CAP - emitted) / remainingRoots));
    walk(tab, 0, quota);
  });
  if (emitted < total) {
    lines.push(`Showing ${emitted} of ${total} node(s) in this scope; ${total - emitted} omitted. Call read_layout again with pageRid="${viewedRid}" and focusRid="<returned rid>" to inspect one subtree.`);
  }
  if (load.truncated) {
    lines.push('Safety limit reached while reading the page: the source projection is partial. No widget-owned rows or further page nodes were loaded.');
  }
  if (load.orphans.length) lines.push(`Orphan widgets without a container: ${load.orphans.length}`);
  return { text: lines.join('\n'), objects };
}

/** Text-only compatibility surface used by focused formatting tests. */
export function formatAiLayout(
  viewedRid: string,
  page: NonNullable<LoadPageStructureResult>,
  focusRid?: string,
): string {
  return projectAiLayout(viewedRid, page, focusRid).text;
}

// ── preview_ec ───────────────────────────────────────────────────

async function previewEc(client: BmpClient, input: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
  const code = typeof input.code === 'string' ? input.code : '';
  if (!code.trim()) return err('preview_ec needs "code".');
  const res = await client.executeEc(code, undefined, false, signal);
  if (!res.ok) return err(`EC error:\n${res.error ?? res.log ?? 'unknown error'}`);
  const body = res.log ?? '(no output)';
  const warn = res.hasWarning ? '\n(warnings present)' : '';
  return ok(`EC preview OK:\n${body}${warn}`);
}
