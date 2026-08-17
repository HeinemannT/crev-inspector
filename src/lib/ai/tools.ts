/** Provider-neutral tool-loop types, budgets, and result transport helpers. */

import type { ObjectReference } from '../types';
import type { ToolStructuredContent } from './tool-results';
import { toolFailure } from './tool-results';

/** Two-dimensional budget: a model may execute a larger batch-oriented plan,
 * but serial one-call-at-a-time wandering still stops after six tool rounds. */
export const MAX_TOOL_CALLS = 10;
export const MAX_TOOL_ROUNDS = 6;
export const MAX_UNPRODUCTIVE_TOOL_ROUNDS = 2;
/** Leave time inside the handler's 45 s request deadline for the final provider
 * answer and automatic Change Ticket Preview. Checked between provider turns;
 * the handler AbortSignal remains the hard deadline during an in-flight call. */
export const MAX_TOOL_LOOP_MS = 35_000;

export const TOOL_BUDGET_EXHAUSTED_NOTE =
  'Tool budget for this turn is exhausted. Answer now with the information ' +
  'you already gathered. Do not attempt further tool calls.';

export const CHANGE_PREVIEW_SATISFIED_NOTE =
  'The complete state-changing Extended Code Preview succeeded. The requested ' +
  'change is ready: return exactly one complete crev-change ticket now, with no ' +
  'surrounding prose. Do not call another tool or restart discovery.';

export const TOOL_RESULT_CAP = 9000;
export const TRUNCATION_MARKER = '\n… [truncated: result exceeded the size cap; narrow the query]';

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  content: string;
  isError: boolean;
  /** Typed facts returned by production tools. Optional only so stored legacy
   * fixtures can fail soft; production execution always supplies it. */
  structuredContent?: ToolStructuredContent;
  objects?: ObjectReference[];
}

export function toolResultForModel(result: ToolResult): string {
  const bounded = boundedToolResult(result);
  const structured = bounded.structuredContent
    ?? toolFailure('unknown', result.content || (result.isError ? 'Tool failed.' : 'Legacy tool result.'));
  return JSON.stringify(structured);
}

/** Companion tools intentionally return bounded structures. Crossing the transport
 * cap is therefore a typed error—not a third undocumented status and not a
 * prose fallback that the model must scrape. */
export function boundedToolResult(result: ToolResult): ToolResult {
  if (!result.structuredContent) return result;
  const characters = JSON.stringify(result.structuredContent).length;
  if (characters <= TOOL_RESULT_CAP) return result;
  const failure = toolFailure(
    result.structuredContent.tool,
    `Result is too large (${characters} characters; maximum ${TOOL_RESULT_CAP}). Narrow the query.`,
  );
  return { content: failure.error.message, isError: true, structuredContent: failure };
}

export function toolResultEvidenceKey(result: ToolResult): string {
  return result.structuredContent ? JSON.stringify(result.structuredContent) : result.content;
}

export type ExecuteTool = (call: ToolCall, signal?: AbortSignal) => Promise<ToolResult>;

export function truncateToolResult(text: string): string {
  if (text.length <= TOOL_RESULT_CAP) return text;
  return text.slice(0, TOOL_RESULT_CAP - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
}

export function objectReferenceToken(rid: string): string {
  return `[[object:${rid}]]`;
}

export function objectReferencePattern(): RegExp {
  return /\[\[object:(-?\d+)\]\]/g;
}

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

/** Legacy presentation summary used by focused formatting tests and debug
 * surfaces. Providers receive structuredContent through toolResultForModel. */
export function toolResultWithObjects(
  content: string,
  objects: readonly ObjectReference[],
): ToolResult {
  const merged = mergeObjectReferences(objects);
  if (!merged.length) return { content: truncateToolResult(content), isError: false };
  const oneLine = (value: string | undefined, fallback: string): string =>
    (value?.replace(/\s+/g, ' ').trim() || fallback).slice(0, 120);
  const ecReference = (object: ObjectReference): string => {
    const bid = object.businessId?.trim();
    if (!bid || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(bid)) return '';
    const namespace = object.type === 'Organisation' ? 'o'
      : object.type === 'User' ? 'u'
        : object.type === 'Group' ? 'g'
          : object.type === 'FileResource' || object.type === 'ExternalResource' ? 'r'
            : 't';
    return `${namespace}.${bid}`;
  };
  const registryCap = 3_600;
  let registry = '\nUI object references:';
  let shown = 0;
  for (const object of merged) {
    const line = `\n  ${objectReferenceToken(object.rid)} = `
      + `${oneLine(object.name, '(unnamed)')} (${oneLine(object.type, 'Object')})`
      + `${object.businessId ? ` bid=${oneLine(object.businessId, '')}` : ''}`
      + `${ecReference(object) ? ` ecRef=${ecReference(object)}` : ''}`;
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
