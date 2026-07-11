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

/** Max tool calls the orchestrator will execute in one user turn. On the cap
 *  it makes one final turn with NO tools offered, forcing a text answer.
 *
 *  Raised 8 → 12: search_objects now returns each hit's businessId + template
 *  (see handlers/ai-tools.ts), so the model no longer burns a read_object per
 *  hit just to learn ids. Each search is materially cheaper, so a modestly
 *  higher budget buys multi-step exploration without the runaway dereferencing
 *  that used to hit the old cap and trigger the DSML-leak (see ai/scrub.ts). */
export const MAX_TOOL_CALLS = 12;

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
export interface ToolParamSchema {
  type: 'object';
  properties: Record<string, { type: string; description: string; enum?: string[] }>;
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
}

/** Executes a tool by name. Never throws — a failed call resolves to an
 *  `isError` result carrying a readable message. Injected by the SW handler
 *  so the orchestrator (and its tests) stay free of BMP wiring. */
export type ExecuteTool = (call: ToolCall, signal?: AbortSignal) => Promise<ToolResult>;

export const TOOL_DEFS: ToolDef[] = [
  {
    name: 'read_object',
    description:
      'Read one BMP object by business id or rid. Returns its identity ' +
      '(name, type, businessId, rid, template), its property values, and the ' +
      'names + sizes of its code slots (full code inlined only when small). ' +
      'Prefer this over guessing what an object contains.',
    parameters: {
      type: 'object',
      properties: {
        ref: {
          type: 'string',
          description: 'Business id (e.g. "cvo_demo") or numeric rid of the object to read.',
        },
      },
      required: ['ref'],
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
      'Use to understand how a page is composed.',
    parameters: {
      type: 'object',
      properties: {
        pageRid: { type: 'string', description: 'Numeric rid of the page whose layout to read.' },
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
  return text.slice(0, TOOL_RESULT_CAP) + TRUNCATION_MARKER;
}
