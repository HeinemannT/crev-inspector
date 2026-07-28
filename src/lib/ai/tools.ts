/**
 * Read-only tool catalog for the chat orchestrator. Schemas are defined ONCE
 * here and projected into each provider dialect (Anthropic `input_schema`,
 * OpenAI `function.parameters`). Execution lives in the service worker
 * (handlers/ai-tools.ts) — this module is pure data + shape helpers, so it is
 * safe to import from tests and either dialect.
 *
 * Every tool is READ-ONLY. No tool writes to BMP; mutation only ever happens
 * through code blocks the user chooses to apply.
 */
import type { ObjectReference } from '../types';

/** Two-dimensional budget: a model may execute a larger batch-oriented plan,
 * but serial one-call-at-a-time wandering still stops after six tool rounds.
 * The final turn always has tools disabled and must answer from gathered data. */
export const MAX_TOOL_CALLS = 10;
export const MAX_TOOL_ROUNDS = 6;

/** Appended (in the dialect's best role) on the forced final turn so the model
 *  knows WHY tools vanished and answers instead of re-emitting tool syntax as
 *  text. Kept out of the visible transcript. */
export const TOOL_BUDGET_EXHAUSTED_NOTE =
  'Tool budget for this turn is exhausted. Answer now with the information ' +
  'you already gathered. Do not attempt further tool calls.';

/** Hard character cap on any single tool result handed back to the model.
 *  Over the cap the result is sliced and marked so the model can SEE it was
 *  cut rather than silently reasoning over a partial payload. */
export const TOOL_RESULT_CAP = 9000;

/** Appended to a truncated tool result — visible to the model. */
export const TRUNCATION_MARKER = '\n… [truncated: result exceeded the size cap; narrow the query]';

/** A minimal JSON-Schema object shape — the subset both dialects accept. */
export interface ToolPropertySchema {
  type: 'string' | 'array';
  description: string;
  enum?: string[];
  items?: { type: 'string' };
}

export interface ToolParamSchema {
  type: 'object';
  properties: Record<string, ToolPropertySchema>;
  required: string[];
  additionalProperties: false;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: ToolParamSchema;
}

/** One provider-neutral tool call the model requested. `input` is the parsed
 *  JSON arguments (may be `{}` when the model sent none). */
export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** The result of running one tool. `isError` maps to Anthropic's
 *  `is_error` / an "[error] …" prefix for OpenAI — either way the model is
 *  told the call failed so it can adapt instead of the loop throwing. */
export interface ToolResult {
  content: string;
  isError: boolean;
  /** Verified BMP identities exposed by this result. Kept separate from prose
   *  so the UI never has to infer objects from model-generated text. */
  objects?: ObjectReference[];
}

/** Executes a tool by name. Never throws — a failed call resolves to an
 *  `isError` result carrying a readable message. Injected by the SW handler
 *  so the orchestrator (and its tests) stay free of BMP wiring. */
export type ExecuteTool = (call: ToolCall, signal?: AbortSignal) => Promise<ToolResult>;

export const TOOL_DEFS: ToolDef[] = [
  {
    name: 'query_context',
    description:
      'Count, filter and list descendants of the effective page behind the object already attached as chat context. Enterprise instances are resolved through .template automatically. ' +
      'Use this for questions containing “here”, “this”, “on this page” or “selected”; the tool binds the scope itself, so NEVER search for the context object by name, business id or rid first. ' +
      'EXCEPTION: do not use this to find or inspect tabs, containers, widgets, tables, or rows displayed by a table; those questions start with read_layout. ' +
      'Use type only when a prior live result or the user supplied the real BMP class. For any semantic noun whose class is unknown, use templateQuery instead; the result includes the discovered class distribution. ' +
      'For a question asking what object/class the semantic matches are, that first successful class distribution is the complete answer: do not query again or inspect an exemplar. ' +
      'It returns the total match count plus up to 25 rows with stable name, class, template, businessId and rid, and can include a few requested properties. ' +
      'For “which X are Y?” include a filter in the first call only when the live schema or user established the filter property; never invent a status field or encoding. ' +
      'Examples after the class/property is known: {"type":"ExtendedTable"}; {"type":"CustomVisualization","filterField":"name","filterValue":"Summary"}.',
    parameters: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          description: 'Optional known PascalCase BMP descendant class, e.g. "ExtendedTable" or "CustomVisualization". Supply it only after live output or the user established the class.',
        },
        templateQuery: {
          type: 'string',
          description: 'Optional user-supplied semantic/template-name substring. Use when the real descendant class is unknown. At least one of type or templateQuery is required.',
        },
        fields: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional additional property accessors confirmed by the user, live schema, or a prior tool result. Maximum 5. Never request name, type, businessId, id or rid because every row already includes them.',
        },
        filterField: {
          type: 'string',
          description: 'Optional live-confirmed property accessor to filter. Must be paired with filterValue; never infer a semantic status property.',
        },
        filterValue: {
          type: 'string',
          description: 'Optional case-insensitive substring required in filterField. Must be paired with filterField.',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'read_object',
    description:
      'Read one BMP object by business id or rid. Returns its identity ' +
      '(name, type, businessId, rid, template), its property values, and the ' +
      'names + sizes of its code slots (full code inlined only when small). ' +
      'When prior tool output contains both bid= and rid=, ALWAYS pass the rid= value. Numeric business ids are not rids. Prefer this over guessing what an object contains.',
    parameters: {
      type: 'object',
      properties: {
        ref: {
          type: 'string',
          description: 'Object reference. Prefer the exact rid= value returned by another tool, not its bid= value.',
        },
        refType: {
          type: 'string',
          enum: ['rid', 'businessId'],
          description: 'Optional explicit reference kind. Set businessId when ref came from bid=, especially when it contains only digits.',
        },
      },
      required: ['ref'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_code',
    description:
      'Read one raw code-bearing property from an object with output(), so BMP does not evaluate it. ' +
      'Use after read_layout exposes a widget and its code slots. ExtendedTable rows come from its expression property: call read_code with that table rid and property="expression" instead of inspecting descendants. ' +
      'If the returned expression directly names its SELECT class or table(...) properties, answer from the source; do not preview/re-run the stored code merely to verify it.',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Object reference. Prefer the exact rid= value returned by another tool, not its bid= value.' },
        refType: { type: 'string', enum: ['rid', 'businessId'], description: 'Optional explicit reference kind. Set businessId for a numeric business id.' },
        property: { type: 'string', description: 'Raw code property, e.g. "expression", "html", "javascript", "css", "text" or "longText".' },
      },
      required: ['ref', 'property'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_type',
    description:
      'Introspect a BMP object type / class. Returns the type\'s properties ' +
      '(EC accessor + label + config-class) from a live schema probe, plus its ' +
      'known code slots, reference edges and context fields. Use before writing ' +
      'code that reads or sets a property you are unsure exists.',
    parameters: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          description: 'PascalCase BMP class name, e.g. "CustomVisualization", "ButtonInput".',
        },
      },
      required: ['type'],
      additionalProperties: false,
    },
  },
  {
    name: 'search_objects',
    description:
      'Search the workspace for objects by name/text (BMP quick search). ' +
      'Returns up to ~25 hits with businessId, name, type and rid. Use to ' +
      'locate an object when you only know part of its name.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free-text search string.' },
        type: { type: 'string', description: 'Optional BMP type name to filter the hits.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'code_search',
    description:
      'Search across all code-bearing objects (Extended Code, HTML, JS) for a ' +
      'literal substring. Returns up to ~30 matches with object businessId, ' +
      'type, the matching property, and the line. Use to find where a token, ' +
      'businessId or helper is referenced.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Literal substring to find (case-sensitive).' },
        type: { type: 'string', description: 'Optional BMP type name to limit the search.' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_layout',
    description:
      'Read a page\'s layout tree by page rid — a trimmed structure of tabs, ' +
      'containers and widgets (types, names, column spans), NOT their styling. ' +
      'Widget-owned data rows are excluded. Large pages return a balanced outline across tabs; use focusRid from a returned node to inspect one subtree. A source safety cutoff is reported explicitly if reached. ' +
      'This is the FIRST tool for questions about a page, tab, container, widget, table, or rows displayed by a table. For an ExtendedTable, follow it with read_code on the returned table rid and expression slot; do not call query_context first.',
    parameters: {
      type: 'object',
      properties: {
        pageRid: { type: 'string', description: 'Numeric rid of the page whose layout to read.' },
        focusRid: {
          type: 'string',
          description: 'Optional rid of a returned tab/container/widget. Limits the answer to that subtree when the page outline was capped.',
        },
      },
      required: ['pageRid'],
      additionalProperties: false,
    },
  },
  {
    name: 'preview_ec',
    description:
      'Dry-run Extended Code against the live workspace and return its result ' +
      'or error verbatim. READ-ONLY: this NEVER commits. Preview EC with this ' +
      'tool before presenting it to the user.',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Extended Code to preview (not committed).' },
      },
      required: ['code'],
      additionalProperties: false,
    },
  },
];

/** Tool names as a set — used to reject an unknown tool call defensively. */
export const TOOL_NAMES: ReadonlySet<string> = new Set(TOOL_DEFS.map(t => t.name));

/** Anthropic `tools` param projection. */
export function toAnthropicTools(defs: ToolDef[] = TOOL_DEFS): Array<{ name: string; description: string; input_schema: ToolParamSchema }> {
  return defs.map(d => ({ name: d.name, description: d.description, input_schema: d.parameters }));
}

/** OpenAI-compatible `tools` array projection (function calling). */
export function toOpenAiTools(defs: ToolDef[] = TOOL_DEFS): Array<{ type: 'function'; function: { name: string; description: string; parameters: ToolParamSchema } }> {
  return defs.map(d => ({ type: 'function', function: { name: d.name, description: d.description, parameters: d.parameters } }));
}

/** Clamp a tool result to TOOL_RESULT_CAP, appending TRUNCATION_MARKER when
 *  cut. Idempotent for already-short strings. */
export function truncateToolResult(text: string): string {
  if (text.length <= TOOL_RESULT_CAP) return text;
  return text.slice(0, TOOL_RESULT_CAP - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
}

/** Stable inline citation syntax understood by the AI Markdown renderer. */
export function objectReferenceToken(rid: string): string {
  return `[[object:${rid}]]`;
}

/** Fresh regex per render — global RegExp state must never leak across calls. */
export function objectReferencePattern(): RegExp {
  return /\[\[object:(-?\d+)\]\]/g;
}

/** Dedupe by RID while preferring later non-empty enrichment fields. */
export function mergeObjectReferences(objects: readonly ObjectReference[]): ObjectReference[] {
  const byRid = new Map<string, ObjectReference>();
  for (const object of objects) {
    if (!/^-?\d+$/.test(object.rid)) continue;
    const prior = byRid.get(object.rid);
    byRid.set(object.rid, {
      rid: object.rid,
      businessId: object.businessId || prior?.businessId,
      type: object.type || prior?.type,
      name: object.name || prior?.name,
      templateBusinessId: object.templateBusinessId || prior?.templateBusinessId,
    });
  }
  return [...byRid.values()];
}

/** Add a provider-visible registry for the verified objects while preserving
 *  the total tool-result cap. The system prompt, not this untrusted result,
 *  defines the instruction to use these exact tokens. */
export function toolResultWithObjects(
  content: string,
  objects: readonly ObjectReference[],
): ToolResult {
  const merged = mergeObjectReferences(objects);
  if (!merged.length) return { content: truncateToolResult(content), isError: false };
  const oneLine = (value: string | undefined, fallback: string): string =>
    (value?.replace(/\s+/g, ' ').trim() || fallback).slice(0, 120);
  const registryCap = 3_600;
  let registry = '\nUI object references:';
  let shown = 0;
  for (const object of merged) {
    const line = `\n  ${objectReferenceToken(object.rid)} = `
      + `${oneLine(object.name, '(unnamed)')} (${oneLine(object.type, 'Object')})`
      + `${object.businessId ? ` bid=${oneLine(object.businessId, '')}` : ''}`;
    // Keep room for a useful portion of the actual tool result and an
    // omission note. Structured identities remain available to the UI.
    if (registry.length + line.length + 64 > registryCap) break;
    registry += line;
    shown += 1;
  }
  if (shown < merged.length) {
    registry += `\n  … ${merged.length - shown} more verified object references omitted`;
  }
  const bodyCap = Math.max(0, TOOL_RESULT_CAP - registry.length);
  const body = content.length <= bodyCap
    ? content
    : content.slice(0, Math.max(0, bodyCap - TRUNCATION_MARKER.length)) + TRUNCATION_MARKER;
  return { content: body + registry, isError: false, objects: merged };
}
