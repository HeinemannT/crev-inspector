import type { ObjectReference } from '../types';
import { TOOL_NAMES, type AiToolName } from './tool-contracts';

export type { AiToolName } from './tool-contracts';

/** Versioned, provider-neutral result contract for every production AI tool.
 * The model receives this object as serialized JSON. `ToolResult.content` is a
 * separate compatibility/presentation summary and is never scraped for facts. */
export const AI_TOOL_RESULT_SCHEMA_VERSION = 2 as const;

export interface ModelObjectReference extends ObjectReference {
  /** Exact renderer token the assistant can copy into its answer. */
  token: string;
}

export interface InspectedPropertyData {
  accessor: string;
  label?: string;
  configClass?: string;
  state: 'value' | 'missing';
  source: 'unset' | 'instance' | 'template';
  value?: string;
  valueLength?: number;
  valueTruncated?: boolean;
  referenceRid?: string;
}

export interface ToolDataMap {
  query_context: {
    query: {
      type?: string;
      templateQuery?: string;
      fields: string[];
      filter?: { field: string; value: string };
    };
    sourceRid: string;
    total: number | null;
    classCounts: Record<string, number>;
    rows: Array<{ objectRid: string; fields: Record<string, string> }>;
    returned: number;
    capped: boolean;
    complete: boolean;
    hasWarning: boolean;
  };
  read_object: {
    mode: 'overview' | 'selected-properties';
    objectRid: string;
    templateRid?: string;
    parentRid?: string;
    properties?: Record<string, string>;
    contextValues?: Record<string, string>;
    references?: Record<string, string | null>;
    codeSlots?: Array<{
      property: string;
      charCount: number;
      content?: string;
      contentIncluded: boolean;
    }>;
    selectedProperties?: InspectedPropertyData[];
    unknownProperties?: string[];
    schemaAvailable?: boolean;
    schemaError?: string;
    complete: boolean;
  };
  read_code: {
    objectRid: string;
    property: string;
    language: 'extended' | 'html' | 'css' | 'javascript';
    code: string;
    charCount: number;
    complete: boolean;
  };
  read_type: {
    requestedType: string;
    canonicalType?: string;
    /** Ranked live classes recovered from a misspelled/unknown requestedType. */
    typeSuggestions?: string[];
    query?: string;
    affordances: { code: boolean; references: boolean; flow: boolean };
    codeSlots: Array<{ property: string; enabledBy?: string }>;
    referenceEdges: string[];
    contextFields: Array<{ property: string; kind: string }>;
    /** Verified collection roots discovered by a source-specific schema probe.
     * Empty when ordinary type metadata cannot prove one. */
    collections: string[];
    schema: {
      available: boolean;
      total: number;
      returned: number;
      truncated: boolean;
      properties: Array<{
        accessor: string;
        label: string;
        configClass: string;
        description?: string;
        system: boolean;
      }>;
      error?: string;
    };
    /** Exact configured values for matching list/tag properties. These belong
     * to type introspection, so callers need not probe exemplar objects to
     * discover the property's value vocabulary. */
    optionSets: Array<{
      accessor: string;
      multi: boolean;
      items: Array<{ ref: string; name: string }>;
    }>;
    complete: boolean;
  };
  search_objects: {
    query: string;
    /** Bounded spelling-recovery query that produced the live rows. */
    resolvedQuery?: string;
    type?: string;
    purpose?: 'objects' | 'row-type';
    sourceTotalHits: number;
    returned: number;
    typeCounts: Record<string, number>;
    typeCandidates?: Array<{
      type: string;
      count: number;
      representativeRid: string;
    }>;
    purposeComplete?: boolean;
    capped: boolean;
    complete: boolean;
  };
  code_search: {
    pattern: string;
    type?: string;
    returned: number;
    capped: boolean;
    warning?: string;
    matches: Array<{
      objectRid: string;
      property: string;
      lines: Array<{ line: number; text: string }>;
    }>;
    complete: boolean;
  };
  read_layout: {
    viewedRid: string;
    pageOwnerRid: string;
    pageTemplateRid?: string;
    focusRid?: string;
    focusFound: boolean;
    resultOnly: boolean;
    tabsets: Array<{ businessId: string; name: string; rid?: string }>;
    totalNodes: number;
    returnedNodes: number;
    omittedNodes: number;
    sourceTruncated: boolean;
    orphanCount: number;
    complete: boolean;
    nodes: Array<{
      rid?: string;
      businessId: string;
      parentRid?: string;
      depth: number;
      kind: 'tab' | 'container' | 'widget';
      type: string;
      name: string;
      columns: { large: number; medium?: number; small?: number };
      storage: 'page-child' | 'portal-shared';
      tabsetBusinessId?: string;
      codeSlots: string[];
      linkedTemplateRid?: string;
    }>;
  };
  preview_ec: {
    ok: true;
    log: string;
    hasWarning: boolean;
    complete: boolean;
  };
}

type Assert<T extends true> = T;
export type ToolDataMapMatchesContracts = Assert<
  [Exclude<AiToolName, keyof ToolDataMap>, Exclude<keyof ToolDataMap, AiToolName>] extends [never, never]
    ? true
    : false
>;

type ToolSuccess<K extends AiToolName = AiToolName> = K extends AiToolName
  ? {
      schemaVersion: typeof AI_TOOL_RESULT_SCHEMA_VERSION;
      tool: K;
      status: 'ok';
      data: ToolDataMap[K];
      objects?: ModelObjectReference[];
    }
  : never;

export interface ToolFailure {
  schemaVersion: typeof AI_TOOL_RESULT_SCHEMA_VERSION;
  tool: AiToolName | 'unknown';
  status: 'error';
  error: { message: string };
}

export type ToolStructuredContent = ToolSuccess | ToolFailure;

function modelObjects(objects: readonly ObjectReference[]): ModelObjectReference[] {
  const byRid = new Map<string, ModelObjectReference>();
  for (const object of objects) {
    if (!/^-?\d+$/.test(object.rid)) continue;
    const prior = byRid.get(object.rid);
    byRid.set(object.rid, {
      rid: object.rid,
      token: `[[object:${object.rid}]]`,
      businessId: object.businessId || prior?.businessId,
      type: object.type || prior?.type,
      name: object.name || prior?.name,
      templateBusinessId: object.templateBusinessId || prior?.templateBusinessId,
    });
  }
  return [...byRid.values()];
}

export function toolSuccess<K extends AiToolName>(
  tool: K,
  data: ToolDataMap[K],
  objects: readonly ObjectReference[] = [],
): Extract<ToolStructuredContent, { tool: K; status: 'ok' }> {
  const references = modelObjects(objects);
  return {
    schemaVersion: AI_TOOL_RESULT_SCHEMA_VERSION,
    tool,
    status: 'ok',
    data,
    ...(references.length ? { objects: references } : {}),
  } as Extract<ToolStructuredContent, { tool: K; status: 'ok' }>;
}

export function toolFailure(tool: string, message: string): ToolFailure {
  return {
    schemaVersion: AI_TOOL_RESULT_SCHEMA_VERSION,
    tool: TOOL_NAMES.has(tool) ? tool as AiToolName : 'unknown',
    status: 'error',
    error: { message },
  };
}

export function isToolSuccess<K extends AiToolName>(
  content: ToolStructuredContent | undefined,
  tool: K,
): content is Extract<ToolStructuredContent, { tool: K; status: 'ok' }> {
  return content?.status === 'ok' && content.tool === tool;
}
