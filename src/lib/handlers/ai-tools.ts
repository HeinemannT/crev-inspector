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
import { TOOL_NAMES, truncateToolResult } from '../ai/tools';
import type { AiContextEnvelope, AiContextSource } from '../ai/types';
import { loadSchemaProps } from './objects';
import { collectCodeSearch } from '../code-search';
import { codeFieldsFor, referencesFor, contextFieldsFor, typeAffordances } from '../widget-metadata';
import { errorMessage, log } from '../logger';
import { formatEcLiteral, validateEcIdentifier } from '../ec-guards';

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

/** A tool result that always ends up truncated to the shared byte cap. */
function ok(content: string): ToolResult {
  return { content: truncateToolResult(content), isError: false };
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
  type: string,
  fields: string[],
  filterField?: string,
  filterValue?: string,
): string {
  const safeType = validateEcIdentifier(type);
  const safeFields = fields.map(validateEcIdentifier);
  const safeFilterField = filterField ? validateEcIdentifier(filterField) : undefined;
  const lines = [
    `_context := ${contextRef}`,
    `_items := _context.descendants(${safeType})`,
  ];
  if (safeFilterField && filterValue !== undefined) {
    lines.push(`_items := _items.filter(${safeFilterField} = "*${formatEcLiteral(filterValue)}*")`);
  }
  lines.push(
    '_count := _items.size()',
    '_rows := ""',
    '_shown := 0',
    '_items.forEach(_item:',
    `     IF _shown < ${SEARCH_CAP} THEN`,
    '          _name := _item.name.whenMissing("(unnamed)")',
    '          _bid := _item.id.whenMissing("(missing)")',
    '          _line := "  " + _name + " (" + _item.className + ") bid=" + _bid + " rid=" + _item.rid',
  );
  safeFields.forEach((field, index) => {
    lines.push(
      `          _field${index} := _item.${field}.whenMissing("(missing)")`,
      `          _line := _line + "\\t${field}=" + _field${index}`,
    );
  });
  lines.push(
    '          _rows := _rows + _line + "\\n"',
    '          _shown := _shown + 1',
    '     ENDIF',
    ')',
    `_out := "Context: " + _context.name + " (" + _context.className + ") bid=" + _context.id + " rid=" + _context.rid + "\\nMatched ${safeType}: " + _count + "\\n" + _rows`,
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
  if (!type) return err('query_context needs a descendant "type" such as "Indicator".');
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
      type,
      fields,
      filterField || undefined,
      filterValue || undefined,
    );
    const res = await client.executeEc(code, undefined, false, signal);
    if (!res.ok) return err(`Context query failed:\n${res.error ?? res.log ?? 'unknown EC error'}`);
    const guidance = res.hasWarning
      ? 'Scope was resolved from the attached context, but warnings mean the requested property may be missing on some descendants. Retry query_context with the correct field; do not rediscover these objects with search_objects.'
      : 'Scope was resolved from the attached context and the count/filter evaluation is complete; rows may be capped as stated. Do not call search_objects or read_object for them unless the user requested additional properties not shown here.';
    return ok(
      `${res.log ?? '(no output)'}\n${guidance}`,
    );
  } catch (e) {
    return err(`Invalid context query: ${errorMessage(e)}`);
  }
}

// ── read_object ──────────────────────────────────────────────────

const REF_ROW = '';
const identSafe = (s: string) => s.replace(/[^\w.-]/g, '');

/** Resolve a business id OR numeric rid to a numeric rid. Mirrors the studio
 *  STUDIO_RESOLVE_REF path: lookup() for a rid; t.get()/o.get() for a bid. */
async function resolveRefToRid(client: BmpClient, ref: string): Promise<string | null> {
  const trimmed = ref.trim();
  if (!trimmed) return null;
  const emit = `_out := str(_o.rid) + "${REF_ROW}"`;
  const resolve = /^-?\d+$/.test(trimmed)
    ? [`_o := lookup(${trimmed})`]
    : [`_o := t.get("${identSafe(trimmed)}")`, 'IF _o.isMissing() THEN', `     _o := o.get("${identSafe(trimmed)}")`, 'ENDIF'];
  const code = [...resolve, 'IF _o.isMissing() THEN', '     _out := ""', 'ELSE', `     ${emit}`, 'ENDIF', '_out'].join('\n');
  const res = await client.executeEc(code, undefined, false);
  if (!res.ok || !res.log) return null;
  const first = res.log.split(REF_ROW)[0]?.trim() ?? '';
  const rid = first.replace(/^Result\s*:\s*/i, '').trim();
  return /^-?\d+$/.test(rid) ? rid : null;
}

async function readObject(client: BmpClient, input: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
  const ref = typeof input.ref === 'string' ? input.ref : '';
  if (!ref.trim()) return err('read_object needs a "ref" (business id or rid).');
  const rid = await resolveRefToRid(client, ref);
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
  return ok(lines.join('\n'));
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
  const schema = await loadSchemaProps(type);
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
  return ok(lines.join('\n'));
}

// ── code_search ──────────────────────────────────────────────────

async function codeSearch(input: Record<string, unknown>): Promise<ToolResult> {
  const pattern = typeof input.pattern === 'string' ? input.pattern : '';
  if (!pattern.trim()) return err('code_search needs a "pattern".');
  const typeFilter = typeof input.type === 'string' && input.type.trim() ? [input.type.trim()] : undefined;
  const { results, capped, error } = await collectCodeSearch(pattern, { types: typeFilter, cap: 30 });
  if (error) return err(`code_search failed: ${error}`);
  if (results.length === 0) return ok(`No code matches for "${pattern}".`);
  const lines = [`${results.length} match(es)${capped ? ' (capped)' : ''} for "${pattern}":`];
  for (const r of results) {
    const line = r.matchingLines[0];
    const where = line ? `L${line.lineNum}: ${line.text.trim()}` : '';
    lines.push(`  ${r.name || '(no name)'} (${r.type}) bid=${r.businessId} .${r.property}  ${where}`);
  }
  return ok(lines.join('\n'));
}

// ── read_layout ──────────────────────────────────────────────────

async function readLayout(client: BmpClient, input: Record<string, unknown>): Promise<ToolResult> {
  const pageRid = typeof input.pageRid === 'string' ? input.pageRid.trim() : '';
  if (!/^-?\d+$/.test(pageRid)) return err('read_layout needs a numeric "pageRid".');
  const nodes = await client.fetchLayoutTree(pageRid);
  if (!nodes.length) return err(`No layout tree for page ${pageRid} (not an editable page?).`);
  // Build a parent->children index and print a trimmed tree (types/names/spans),
  // not style channels.
  const byParent = new Map<string, typeof nodes>();
  const roots: typeof nodes = [];
  for (const n of nodes) {
    const p = n.parentRid;
    if (p && nodes.some(x => x.rid === p)) {
      const list = byParent.get(p) ?? [];
      list.push(n); byParent.set(p, list);
    } else {
      roots.push(n);
    }
  }
  const lines: string[] = [`Layout of page ${pageRid} (${nodes.length} nodes):`];
  const span = (n: typeof nodes[number]) => n.columnsLargeScreen != null ? ` span=${n.columnsLargeScreen}` : '';
  const walk = (n: typeof nodes[number], depth: number) => {
    lines.push(`${'  '.repeat(depth + 1)}${n.type}${n.name ? ` "${n.name}"` : ''}${n.businessId ? ` bid=${n.businessId}` : ''}${span(n)}`);
    for (const c of byParent.get(n.rid) ?? []) walk(c, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  return ok(lines.join('\n'));
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
