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
import { toolResultWithObjects, truncateToolResult } from '../ai/tools';
import { TOOL_NAMES, validateToolInput } from '../ai/tool-contracts';
import type { AiToolName, ToolDataMap, ToolStructuredContent } from '../ai/tool-results';
import { toolFailure, toolSuccess } from '../ai/tool-results';
import type { AiContextEnvelope, AiContextSource } from '../ai/types';
import type { ObjectReference } from '../types';
import { bmpTypeKnowledge } from '../bmp-type-knowledge';
import { collectCodeSearch } from '../code-search';
import { codeFieldsFor, referencesFor, contextFieldsFor, typeAffordances } from '../widget-metadata';
import { errorMessage, log } from '../logger';
import { formatEcLiteral, validateEcIdentifier, validateRid } from '../ec-guards';
import { loadPageStructure, type LoadPageStructureResult } from '../layout-service';
import type { LNode } from '../layout/types';
import {
  inspectObjectProperties,
  MAX_AI_SELECTED_PROPERTIES,
  searchTypeProperties,
} from '../ai/property-inspection';
import {
  formatChangeTarget,
  resolveChangeTarget,
  type ChangeTargetIdentity,
  type ChangeTargetPageFacts,
  type ChangeTargetResolution,
  type RequestedChangeScope,
} from '../ai/change-target';

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
// Typed target records make each node wider than the old identity-only line.
// Fifty preserves a balanced first-pass outline across tabs within 7.5k chars;
// callers can focus one returned subtree for depth.
const AI_LAYOUT_NODE_CAP = 50;
const AI_LAYOUT_CHAR_BUDGET = 7_500;
const layoutCache = new WeakMap<BmpClient, Map<string, {
  expiresAt: number;
  promise: Promise<LoadPageStructureResult>;
}>>();

/** A tool result that always ends up truncated to the shared byte cap. */
function ok<K extends AiToolName>(
  content: string,
  structuredContent: Extract<ToolStructuredContent, { tool: K; status: 'ok' }>,
  objects: readonly ObjectReference[] = [],
): ToolResult {
  const result = objects.length
    ? toolResultWithObjects(content, objects)
    : { content: truncateToolResult(content), isError: false };
  return { ...result, structuredContent };
}
function err(message: string): ToolResult {
  return { content: message, isError: true };
}

function ensureStructuredResult(tool: string, result: ToolResult): ToolResult {
  if (result.structuredContent) return result;
  return { ...result, structuredContent: toolFailure(tool, result.content) };
}

type AiToolHandler = (
  client: BmpClient,
  input: Record<string, unknown>,
  signal?: AbortSignal,
  envelope?: AiContextEnvelope,
) => Promise<ToolResult>;

/** Production BMP adapter for the complete tool contract. */
const AI_TOOL_HANDLERS: Record<AiToolName, AiToolHandler> = {
  query_context: (client, input, signal, envelope) => queryContext(client, input, envelope, signal),
  read_object: (client, input, signal) => readObject(client, input, signal),
  read_code: (client, input) => readCode(client, input),
  read_type: (client, input, signal) => readType(client, input, signal),
  search_objects: (client, input, signal) => searchObjects(client, input, signal),
  code_search: (_client, input) => codeSearch(input),
  read_layout: (client, input) => readLayout(client, input),
  preview_ec: (client, input, signal) => previewEc(client, input, signal),
};

/** Execute one read-only tool call. Returns a readable result; never throws. */
export async function executeAiTool(
  call: ToolCall,
  signal?: AbortSignal,
  envelope?: AiContextEnvelope,
): Promise<ToolResult> {
  const ctx = getCtx();
  if (!TOOL_NAMES.has(call.name)) return ensureStructuredResult(call.name, err(`Unknown tool: ${call.name}`));
  if (!ctx.client) return ensureStructuredResult(call.name, err('Not connected to a BMP server. Ask the user to connect first.'));
  const inputError = validateToolInput(call.name, call.input);
  if (inputError) return ensureStructuredResult(call.name, err(`Invalid tool arguments: ${inputError}`));
  try {
    const handler = AI_TOOL_HANDLERS[call.name as AiToolName];
    const result = await handler(ctx.client, call.input, signal, envelope);
    return ensureStructuredResult(call.name, result);
  } catch (e) {
    log.swallow(`ai-tool:${call.name}`, e);
    return ensureStructuredResult(call.name, err(`Tool ${call.name} failed: ${errorMessage(e)}`));
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
    const output = res.log ?? '';
    const outputLines = output.split('\n');
    const objects: ObjectReference[] = [source.object];
    const refLine = outputLines.filter(line => line.startsWith('Refs: ')).at(-1) ?? '';
    const rids = refLine.slice('Refs: '.length).split(',')
      .map(value => value.trim())
      .filter(value => value.startsWith('rid='))
      .map(value => value.slice('rid='.length))
      .filter(value => /^-?\d+$/.test(value));
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
    const matchedLine = outputLines.find(line => line.startsWith('Matched: '));
    const matched = matchedLine ? Number(matchedLine.slice('Matched: '.length).trim()) : Number.NaN;
    const classesLine = outputLines.find(line => line.startsWith('Classes: '));
    const classCounts: Record<string, number> = {};
    for (const item of (classesLine?.slice('Classes: '.length) ?? '').split(',')) {
      const separator = item.lastIndexOf('=');
      if (separator < 1) continue;
      const className = item.slice(0, separator).trim();
      const count = Number(item.slice(separator + 1).trim());
      if (className && Number.isFinite(count)) classCounts[className] = count;
    }
    const displayedRows = outputLines.filter(line => line.startsWith('  '));
    const rows = rids.map((rid, index) => {
      const rowFields: Record<string, string> = {};
      const chunks = (displayedRows[index] ?? '').split('\t').slice(1);
      for (const chunk of chunks) {
        const separator = chunk.indexOf('=');
        if (separator > 0) rowFields[chunk.slice(0, separator)] = chunk.slice(separator + 1);
      }
      return { objectRid: rid, fields: rowFields };
    });
    const total = Number.isFinite(matched) ? matched : null;
    const capped = total !== null && total > rids.length;
    const structured = toolSuccess('query_context', {
      query: {
        ...(type ? { type } : {}),
        ...(templateQuery ? { templateQuery } : {}),
        fields,
        ...(filterField && filterValue ? { filter: { field: filterField, value: filterValue } } : {}),
      },
      sourceRid: source.object.rid,
      total,
      classCounts,
      rows,
      returned: rids.length,
      capped,
      complete: !capped,
      hasWarning: !!res.hasWarning,
    }, objects);
    return ok(output || '(no output)', structured, objects);
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

/** Resolve a validated EC reference such as t.widget, o.team or r.asset. This
 * keeps read tools tolerant of the exact verified reference already present in
 * attached context while still resolving to the RID-only client seam. */
async function resolveEcReferenceToRid(client: BmpClient, ref: string): Promise<string | null> {
  const match = /^([tor])\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(ref);
  if (!match) return null;
  const namespace = match[1];
  const id = validateEcIdentifier(match[2] ?? '');
  const code = [
    `_o := ${namespace}.${id}`,
    'IF _o.isMissing() THEN',
    '     _out := ""',
    'ELSE',
    '     _out := str(_o.rid)',
    'ENDIF',
    '_out',
  ].join('\n');
  const res = await client.executeEc(code, undefined, false);
  if (!res.ok || !res.log) return null;
  const rid = res.log.replace(/^Result\s*:\s*/i, '').trim();
  return /^-?\d+$/.test(rid) ? validateRid(rid) : null;
}

/** Resolve the AI's ambiguous string reference. BMP RIDs are 64-bit values and
 *  normally exceed JS's safe-integer range; short numeric refs are therefore
 *  tried as business IDs first. refType remains the authoritative override. */
async function resolveToolRef(client: BmpClient, ref: string, refType?: RefType): Promise<string | null> {
  let trimmed = ref.trim();
  const labeled = /^(rid|bid)\s*=\s*(.+)$/i.exec(trimmed);
  if (labeled) {
    refType = labeled[1]?.toLowerCase() === 'rid' ? 'rid' : 'businessId';
    trimmed = labeled[2]?.trim() ?? '';
  }
  if (/^[tor]\./.test(trimmed)) return resolveEcReferenceToRid(client, trimmed);
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
  const properties = Array.isArray(input.properties)
    ? [...new Set(input.properties
        .filter((property): property is string => typeof property === 'string')
        .map(property => property.trim())
        .filter(Boolean))]
    : [];
  if (properties.length > MAX_AI_SELECTED_PROPERTIES) {
    return err(`read_object accepts at most ${MAX_AI_SELECTED_PROPERTIES} exact properties; narrow the request.`);
  }
  try { properties.forEach(validateEcIdentifier); }
  catch (e) { return err(errorMessage(e)); }
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

  if (properties.length) {
    const inspected = await inspectObjectProperties({
      rid,
      type: pane.instance.type,
      hasTemplate: !!pane.template,
      instanceOverrideProps: pane.instanceOverrideProps ?? [],
    }, properties, {
      schema: className => bmpTypeKnowledge.properties({ className }),
      values: (objectRid, requested, requestSignal) =>
        client.fetchSelectedProperties(objectRid, requested, requestSignal),
    }, signal);
    lines.push(inspected.content);
    const resultObjects = [
      pane.instance,
      ...(pane.template ? [pane.template] : []),
      ...(pane.parent ? [pane.parent] : []),
      ...inspected.objects,
    ];
    return ok(lines.join('\n'), toolSuccess('read_object', {
      mode: 'selected-properties',
      objectRid: pane.instance.rid,
      ...(pane.template ? { templateRid: pane.template.rid } : {}),
      ...(pane.parent ? { parentRid: pane.parent.rid } : {}),
      selectedProperties: inspected.properties,
      unknownProperties: inspected.unknown,
      schemaAvailable: inspected.schemaAvailable,
      ...(inspected.schemaError ? { schemaError: inspected.schemaError } : {}),
      complete: inspected.unknown.length === 0
        && inspected.properties.every(property => !property.valueTruncated),
    }, resultObjects), resultObjects);
  }

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

  lines.push('Compact overview only. If the user named an exact property that is not shown, call read_object again with properties; absence here does not mean the property is unavailable.');

  const resultObjects = [
    pane.instance,
    ...(pane.template ? [pane.template] : []),
    ...(pane.parent ? [pane.parent] : []),
    ...Object.values(pane.references).filter((object): object is NonNullable<typeof object> => !!object),
  ];
  return ok(lines.join('\n'), toolSuccess('read_object', {
    mode: 'overview',
    objectRid: pane.instance.rid,
    ...(pane.template ? { templateRid: pane.template.rid } : {}),
    ...(pane.parent ? { parentRid: pane.parent.rid } : {}),
    properties: props,
    contextValues: pane.contextValues,
    references: Object.fromEntries(Object.entries(pane.references)
      .map(([property, object]) => [property, object?.rid ?? null])),
    codeSlots: codeEntries.map(([property, code]) => ({
      property,
      charCount: code.length,
      ...(code.length <= SLOT_INLINE_LIMIT ? { content: code } : {}),
      contentIncluded: code.length <= SLOT_INLINE_LIMIT,
    })),
    complete: false,
  }, resultObjects), resultObjects);
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
  const modelCodeLimit = 7_000;
  const modelCode = code.slice(0, modelCodeLimit);
  const objects: ObjectReference[] = [{ rid }];
  return ok(
    `Code: rid=${rid} property=${safeProperty} (${code.length} chars)\n\`\`\`${language}\n${code}\n\`\`\``,
    toolSuccess('read_code', {
      objectRid: rid,
      property: safeProperty,
      language,
      code: modelCode,
      charCount: code.length,
      complete: modelCode.length === code.length,
    }, objects),
    objects,
  );
}

// ── read_type ────────────────────────────────────────────────────

async function readType(client: BmpClient, input: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
  const type = typeof input.type === 'string' ? input.type.trim() : '';
  if (!type) return err('read_type needs a "type" (PascalCase class name).');
  const query = typeof input.query === 'string' ? input.query.trim() : '';
  const exampleRef = typeof input.exampleRef === 'string' ? input.exampleRef.trim() : '';
  const propertyOnly = input.propertyOnly === true;
  if (input.propertyOnly !== undefined && typeof input.propertyOnly !== 'boolean') {
    return err('read_type "propertyOnly" must be true or false.');
  }

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
  const schema = await bmpTypeKnowledge.properties({
    className: type,
    ...(exampleRef ? { exampleRef } : {}),
  });
  let canonicalType: string | undefined;
  let structuredSchema: ToolDataMap['read_type']['schema'];
  let optionSets: ToolDataMap['read_type']['optionSets'] = [];
  const collections: string[] = [];
  if (schema.ok) {
    // BMP's config-class id may be all-caps (for example
    // CERISKASSESSMENT); that is metadata, not the EC class spelling. Only
    // expose a canonicalType when it has a usable PascalCase shape.
    canonicalType = schema.canonical !== type && /^[A-Z][a-z][A-Za-z0-9]+$/.test(schema.canonical)
      ? schema.canonical
      : undefined;
    const canonical = schema.canonical && schema.canonical !== type ? ` (canonical: ${schema.canonical})` : '';
    const filtered = searchTypeProperties(schema.props, query);
    lines.push(`Live properties${canonical}${query ? ` matching "${query}"` : ''}: ${filtered.total}`);
    for (const p of filtered.shown) {
      lines.push(`  ${p.accessor}  "${p.label}"  [${p.configClass}]${p.systemobject ? ' (system)' : ''}`);
    }
    if (query && filtered.shown.length) {
      lines.push('Matched accessors above are authoritative. Use one of those exact strings for a selected-property read or change; do not guess aliases.');
    }
    if (!filtered.total) lines.push('  (no matching property accessor, label or description)');
    if (filtered.total > filtered.shown.length) {
      lines.push(`  … ${filtered.total - filtered.shown.length} more; pass query to narrow the schema.`);
    }
    structuredSchema = {
      available: true,
      total: filtered.total,
      returned: filtered.shown.length,
      truncated: filtered.total > filtered.shown.length,
      properties: filtered.shown.map(property => ({
        accessor: property.accessor,
        label: property.label,
        configClass: property.propertyConfigClass || property.configClass,
        ...(property.description ? { description: property.description } : {}),
        system: property.systemobject,
      })),
    };
    const matchingOptionAccessors = new Set(filtered.shown
      .filter(property => /(?:Historical)?ListMethodConfig|TagMethodConfig/i.test(
        property.propertyConfigClass || property.configClass,
      ))
      .map(property => property.accessor));
    if (query && matchingOptionAccessors.size > 0) {
      const options = await bmpTypeKnowledge.options(schema.canonical || type);
      if (options.ok) {
        optionSets = options.options
          .filter(option => matchingOptionAccessors.has(option.accessor))
          .map(option => ({
            accessor: option.accessor,
            multi: option.multi,
            items: option.items.map(item => ({ ref: item.ref, name: item.name })),
          }));
        for (const option of optionSets) {
          lines.push(`Configured values for ${option.accessor}: ${option.items.map(item => `${item.name} (${item.ref})`).join(', ')}`);
        }
      }
    }
  } else {
    lines.push(`Live schema unavailable: ${schema.error}`);
    structuredSchema = {
      available: false,
      total: 0,
      returned: 0,
      truncated: false,
      properties: [],
      error: schema.error,
    };
  }
  // A class name does not prove where its instances live. Confirm the standard
  // class root with one bounded read before exposing it; this prevents models
  // from guessing root.organisation.descendants(Type), which can Preview as a
  // valid but empty table.
  if (!propertyOnly && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(type)) {
    const collection = `root.${type}.descendants()`;
    const probe = await client.executeEc(`${collection}.first().className`, undefined, false, signal);
    if (probe.ok && !probe.hasError && probe.log?.toLowerCase().includes(type.toLowerCase())) {
      collections.push(collection);
      lines.push(`Verified collection: ${collection}`);
    }
  }
  return ok(lines.join('\n'), toolSuccess('read_type', {
    requestedType: type,
    ...(canonicalType ? { canonicalType } : {}),
    ...(query ? { query } : {}),
    affordances: aff,
    codeSlots: codeF.map(field => ({
      property: field.prop,
      ...(field.enabledBy ? { enabledBy: field.enabledBy } : {}),
    })),
    referenceEdges: refF.map(reference => reference.prop),
    contextFields: ctxF.map(field => ({ property: field.prop, kind: field.kind })),
    collections,
    schema: structuredSchema,
    optionSets,
    complete: structuredSchema.available && !structuredSchema.truncated,
  }));
}

// ── search_objects ───────────────────────────────────────────────

async function searchObjects(client: BmpClient, input: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
  const query = typeof input.query === 'string' ? input.query.trim() : '';
  if (!query) return err('search_objects needs a "query".');
  const typeFilter = typeof input.type === 'string' ? input.type.trim() : '';
  const purpose = input.purpose === 'row-type' ? 'row-type' : 'objects';
  if (input.purpose !== undefined && input.purpose !== 'objects' && input.purpose !== 'row-type') {
    return err('search_objects "purpose" must be "objects" or "row-type".');
  }
  const { totalHits, objects } = await client.quickSearch(query, { pageSize: 40, signal });
  let hits = objects;
  if (typeFilter) hits = hits.filter(o => (o.type ?? '') === typeFilter);
  const allTypeCounts = hits.reduce<Record<string, number>>((counts, object) => {
    const objectType = object.type?.trim();
    if (objectType) counts[objectType] = (counts[objectType] ?? 0) + 1;
    return counts;
  }, {});
  const typeCandidates = Object.entries(allTypeCounts)
    .map(([type, count]) => ({
      type,
      count,
      representativeRid: hits.find(object => object.type?.trim() === type)!.rid,
    }))
    .sort((left, right) => right.count - left.count || left.type.localeCompare(right.type));
  const shown = purpose === 'row-type'
    ? typeCandidates.slice(0, 8).map(candidate => hits.find(object => object.rid === candidate.representativeRid)!)
    : hits.slice(0, SEARCH_CAP);
  if (shown.length === 0) return ok(
    `No matches for "${query}"${typeFilter ? ` of type ${typeFilter}` : ''}.`,
    toolSuccess('search_objects', {
      query,
      ...(typeFilter ? { type: typeFilter } : {}),
      purpose,
      sourceTotalHits: totalHits,
      returned: 0,
      typeCounts: {},
      ...(purpose === 'row-type' ? { typeCandidates: [], purposeComplete: true } : {}),
      capped: totalHits > objects.length,
      hitRids: [],
      complete: totalHits <= objects.length,
    }),
  );
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
  const lines = purpose === 'row-type'
    ? [`Live row-type candidates for "${query}": ${typeCandidates.map(candidate => `${candidate.type} (${candidate.count})`).join(', ')}`, 'Choose the matching live data class and continue to read_type. Do not search again by casing, class fragments, or synonyms.']
    : [`${shown.length} of ${totalHits} hit(s) for "${query}"${typeFilter ? ` (type=${typeFilter})` : ''}:`];
  for (const o of shown) {
    const e = enrich[o.rid];
    const bid = e?.businessId ? `bid=${e.businessId} ` : '';
    const tpl = e?.templateBusinessId ? `  [tpl bid=${e.templateBusinessId}]` : '';
    lines.push(`  ${o.name ?? '(no name)'} (${o.type ?? '?'}) ${bid}rid=${o.rid}${tpl}`);
  }
  const resultObjects = shown.map(object => {
    const resolved = enrich[object.rid];
    return {
      rid: object.rid,
      name: object.name,
      type: object.type,
      businessId: resolved?.businessId,
      templateBusinessId: resolved?.templateBusinessId,
    };
  });
  const capped = shown.length < hits.length || totalHits > objects.length;
  return ok(lines.join('\n'), toolSuccess('search_objects', {
    query,
    ...(typeFilter ? { type: typeFilter } : {}),
    purpose,
    sourceTotalHits: totalHits,
    returned: shown.length,
    typeCounts: allTypeCounts,
    ...(purpose === 'row-type' ? {
      typeCandidates: typeCandidates.slice(0, 8),
      purposeComplete: typeCandidates.length > 0,
    } : {}),
    capped,
    hitRids: shown.map(object => object.rid),
    complete: !capped,
  }, resultObjects), resultObjects);
}

// ── code_search ──────────────────────────────────────────────────

async function codeSearch(input: Record<string, unknown>): Promise<ToolResult> {
  const pattern = typeof input.pattern === 'string' ? input.pattern : '';
  if (!pattern.trim()) return err('code_search needs a "pattern".');
  const typeFilter = typeof input.type === 'string' && input.type.trim() ? [input.type.trim()] : undefined;
  const { results, capped, error } = await collectCodeSearch(pattern, { types: typeFilter, cap: 30 });
  if (error && results.length === 0) return err(`code_search failed: ${error}`);
  if (results.length === 0) return ok(`No code matches for "${pattern}".`, toolSuccess('code_search', {
    pattern,
    ...(typeFilter?.[0] ? { type: typeFilter[0] } : {}),
    returned: 0,
    capped: false,
    matches: [],
    complete: true,
  }));
  const lines = [
    ...(error ? [`WARNING — ${error}`] : []),
    `${results.length} match(es)${capped ? ' (capped)' : ''} for "${pattern}":`,
  ];
  for (const r of results) {
    const line = r.matchingLines[0];
    const where = line ? `L${line.lineNum}: ${line.text.trim()}` : '';
    lines.push(`  ${r.name || '(no name)'} (${r.type}) bid=${r.businessId} .${r.property}  ${where}`);
  }
  const resultObjects = results.map(result => ({
    rid: result.rid,
    name: result.name,
    type: result.type,
    businessId: result.businessId,
  }));
  return ok(lines.join('\n'), toolSuccess('code_search', {
    pattern,
    ...(typeFilter?.[0] ? { type: typeFilter[0] } : {}),
    returned: results.length,
    capped,
    ...(error ? { warning: error } : {}),
    matches: results.map(result => ({
      objectRid: result.rid,
      property: result.property,
      lines: result.matchingLines.slice(0, 3).map(line => ({ line: line.lineNum, text: line.text })),
    })),
    complete: !capped && !error,
  }, resultObjects), resultObjects);
}

// ── read_layout ──────────────────────────────────────────────────

async function readLayout(client: BmpClient, input: Record<string, unknown>): Promise<ToolResult> {
  const pageRid = typeof input.pageRid === 'string' ? input.pageRid.trim() : '';
  if (!/^-?\d+$/.test(pageRid)) return err('read_layout needs a numeric "pageRid".');
  const focusRid = typeof input.focusRid === 'string' ? input.focusRid.trim() : '';
  if (focusRid && !/^-?\d+$/.test(focusRid)) return err('read_layout "focusRid" must be a numeric rid.');
  const changeScope = input.changeScope === 'instance-only' ? 'instance-only' : 'default';
  if (input.changeScope !== undefined && input.changeScope !== 'default' && input.changeScope !== 'instance-only') {
    return err('read_layout "changeScope" must be "default" or "instance-only".');
  }
  const page = await loadAiLayout(client, pageRid);
  if (!page) return err(`No web layout for viewed object ${pageRid} (not a supported page host?).`);
  const projection = projectAiLayout(pageRid, page, focusRid || undefined, changeScope);
  return ok(
    projection.text,
    toolSuccess('read_layout', projection.data, projection.objects),
    projection.objects,
  );
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
  /** Typed routing decisions used to produce the text. */
  targets: ChangeTargetResolution[];
  /** Provider-facing facts; the orchestrator also consumes completeness and
   * targets directly instead of scraping the formatted outline. */
  data: ToolDataMap['read_layout'];
}

function aiTargetIdentity(
  rid: string,
  businessId: string,
  type: string,
  name?: string,
): ChangeTargetIdentity {
  return { rid, businessId, type, ...(name ? { name } : {}), ecRef: `t.${businessId}` };
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
  requestedScope: RequestedChangeScope = 'default',
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
  const owner = aiTargetIdentity(ctx.pageRid, model.pageId, model.pageClass, model.pageName);
  const viewed = ctx.pageRid === viewedRid
    ? owner
    : aiTargetIdentity(viewedRid, viewedRid, 'EnterpriseInstance', undefined);
  const linkedTemplate = model.templateRid && model.templateId
    ? aiTargetIdentity(model.templateRid, model.templateId, model.pageClass)
    : undefined;
  const pageFacts: ChangeTargetPageFacts = {
    viewed,
    owner,
    ...(linkedTemplate ? { linkedTemplate } : {}),
  };
  const pageTarget = resolveChangeTarget({ kind: 'page', page: pageFacts }, requestedScope);
  const targets: ChangeTargetResolution[] = [pageTarget];
  const tabsets = (model.tabsets?.length
    ? model.tabsets
    : [{ id: model.tabsetId, name: model.tabsetId }])
    .map(tabset => ({
      businessId: tabset.id,
      name: tabset.name,
      ...(tabset.rid ? { rid: tabset.rid } : {}),
    }));
  if (model.templateRid) {
    objects.push({
      rid: model.templateRid,
      businessId: model.templateId,
      type: model.pageClass,
    });
  }
  const focus = focusRid ? findLayoutNode(model.tabs, focusRid) : undefined;
  if (focusRid && !focus) {
    return {
      text: `Layout focus rid=${focusRid} was not found on viewed page rid=${viewedRid}.`,
      objects,
      targets,
      data: {
        viewedRid,
        pageOwnerRid: ctx.pageRid,
        focusRid,
        focusFound: false,
        requestedScope,
        resultOnly: !!model.resultOnly,
        tabsets,
        totalNodes: count(model.tabs),
        returnedNodes: 0,
        omittedNodes: count(model.tabs),
        sourceTruncated: !!load.truncated,
        orphanCount: load.orphans.length,
        complete: false,
        pageTarget,
        nodes: [],
      },
    };
  }
  const roots = focus ? [focus] : model.tabs;
  const total = count(roots);
  const lines = [
    `Viewed rid=${viewedRid}`,
    `Effective page owner: ${model.pageName || model.pageId} (${model.pageClass}) bid=${model.pageId} rid=${ctx.pageRid}`,
    `Contributing TabSets: ${tabsets.map(tabset => `${tabset.name} [${tabset.businessId}]`).join(', ')}`,
    `Layout: ${count(model.tabs)} total nodes${model.resultOnly ? ' (shared Result tab)' : ''}${focus ? `; focused subtree rid=${focus.rid} has ${total}` : ''}`,
  ];
  lines.push(formatChangeTarget(pageTarget, requestedScope === 'instance-only' ? 'Requested page-owner target' : 'Default page-owner target'));
  if (pageTarget.status === 'resolved' && pageTarget.scope === 'shared-template') {
    lines.push('Required ticket summary: briefly note that the change affects the template rather than only the viewed instance; do not offer an override unless asked.');
  }
  let emitted = 0;
  let chars = lines.join('\n').length;
  const projectedNodes: ToolDataMap['read_layout']['nodes'] = [];
  const walk = (node: LNode, depth: number, quota: number, parentRid?: string): number => {
    if (quota <= 0 || emitted >= AI_LAYOUT_NODE_CAP) return 0;
    const storage = node.kind === 'widget' ? 'page-child' : 'portal-shared';
    const slots = node.kind === 'widget' ? codeFieldsFor(node.className).map(field => field.prop) : [];
    const provenance = node.kind === 'tab' ? ` tabset=${node.tabsetId ?? model.tabsetId}` : '';
    let routing = ` bid=${node.id}${node.rid ? ` rid=${node.rid}` : ''}`;
    let changeTarget: ChangeTargetResolution | undefined;
    if (node.rid) {
      const instance = aiTargetIdentity(node.rid, node.id, node.className, node.name);
      changeTarget = node.kind === 'widget'
        ? resolveChangeTarget({
            kind: 'widget',
            page: pageFacts,
            instance,
            ...(node.linkedTemplate ? {
              linkedTemplate: aiTargetIdentity(
                node.linkedTemplate.rid,
                node.linkedTemplate.id,
                node.linkedTemplate.className,
                node.linkedTemplate.name,
              ),
            } : {}),
          }, requestedScope)
        : resolveChangeTarget({ kind: 'portal-structure', page: pageFacts, object: instance }, requestedScope);
      targets.push(changeTarget);
      routing = ` ${formatChangeTarget(changeTarget, 'change-target')}`;
    }
    const line = `${'  '.repeat(depth + 1)}${node.className} "${node.name}"${routing} span=${node.cols.L} model=${storage}${provenance}${slots.length ? ` code=${slots.join(',')}` : ''}`;
    if (chars + line.length + 1 > AI_LAYOUT_CHAR_BUDGET) return 0;
    lines.push(line);
    chars += line.length + 1;
    emitted++;
    projectedNodes.push({
      ...(node.rid ? { rid: node.rid } : {}),
      businessId: node.id,
      ...(parentRid ? { parentRid } : {}),
      depth,
      kind: node.kind,
      type: node.className,
      name: node.name,
      columns: {
        large: node.cols.L,
        ...(node.cols.M !== undefined ? { medium: node.cols.M } : {}),
        ...(node.cols.S !== undefined ? { small: node.cols.S } : {}),
      },
      storage,
      ...(node.tabsetId ? { tabsetBusinessId: node.tabsetId } : {}),
      codeSlots: slots,
      ...(node.linkedTemplate ? { linkedTemplateRid: node.linkedTemplate.rid } : {}),
      ...(changeTarget ? { changeTarget } : {}),
    });
    if (node.rid) {
      objects.push({
        rid: node.rid,
        businessId: node.id,
        type: node.className,
        name: node.name,
      });
    }
    if (node.linkedTemplate) {
      objects.push({
        rid: node.linkedTemplate.rid,
        businessId: node.linkedTemplate.id,
        type: node.linkedTemplate.className,
        name: node.linkedTemplate.name,
      });
    }
    let used = 1;
    for (const child of node.children) {
      if (used >= quota) break;
      used += walk(child, depth + 1, quota - used, node.rid ?? parentRid);
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
  lines.push('Scope resolution is complete. Use the returned change-target; do not call read_layout again unless an omitted subtree is required.');
  return {
    text: lines.join('\n'),
    objects,
    targets,
    data: {
      viewedRid,
      pageOwnerRid: ctx.pageRid,
      ...(focusRid ? { focusRid } : {}),
      focusFound: true,
      requestedScope,
      resultOnly: !!model.resultOnly,
      tabsets,
      totalNodes: total,
      returnedNodes: emitted,
      omittedNodes: Math.max(0, total - emitted),
      sourceTruncated: !!load.truncated,
      orphanCount: load.orphans.length,
      complete: emitted >= total && !load.truncated,
      pageTarget,
      nodes: projectedNodes,
    },
  };
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
  const modelLog = body.slice(0, 7_000);
  return ok(`EC preview OK:\n${body}${warn}`, toolSuccess('preview_ec', {
    ok: true,
    log: modelLog,
    hasWarning: !!res.hasWarning,
    complete: modelLog.length === body.length,
  }));
}
