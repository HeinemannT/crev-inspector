/** Canonical, provider-neutral contracts for the read-only AI tools. */

/** A minimal JSON-Schema object shape — the subset both dialects accept. */
export interface ToolPropertySchema {
  type: 'string' | 'array' | 'boolean';
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

export interface ToolDef<Name extends string = string> {
  name: Name;
  description: string;
  parameters: ToolParamSchema;
}
type ToolSummary = (input: Record<string, unknown>) => string;

export interface AiToolContract<Name extends string = string> extends ToolDef<Name> {
  resultDescription: string;
  summarize: ToolSummary;
}

const defineTool = <const Name extends string>(contract: AiToolContract<Name>): AiToolContract<Name> => contract;

const stringArgument = (input: Record<string, unknown>, key: string): string =>
  typeof input[key] === 'string' ? input[key] : '';

const TOOL_CONTRACT_LIST = [
  defineTool({
    name: 'query_context',
    description:
      'Count, filter and list descendants of the effective page behind the object already attached as chat context. Enterprise instances are resolved through .template automatically. ' +
      'Use this for questions containing “here”, “this”, “on this page” or “selected”; the tool binds the scope itself, so NEVER search for the context object by name, business id or rid first. ' +
      'It queries structural descendants only; it does not follow arbitrary reference/reverse-reference edges such as the risks connected to a control. ' +
      'EXCEPTION: do not use this to find or inspect tabs, containers, widgets, tables, or rows displayed by a table; those questions start with read_layout. ' +
      'Do not use this to discover the workspace data class for a new table or chart; search_objects once with the user\'s business noun instead. ' +
      'Use type only when a prior live result or the user supplied the real BMP class. For any semantic noun whose class is unknown, use templateQuery instead; the result includes the discovered class distribution. ' +
      'For a question asking what object/class the semantic matches are, that first successful class distribution is the complete answer: do not query again or inspect an exemplar. ' +
      'It returns the total match count plus up to 25 rows with stable name, class, template, businessId and rid, and can include a few requested properties. ' +
      'For “which X are Y?” include a filter in the first call only when the live schema or user established the filter property; never invent a status field or encoding. ' +
      'When read_type has established the exact fields/filter for descendants of the attached context, call query_context next; do not switch to preview_ec for an ordinary descendant list. ' +
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
    resultDescription: 'Returns JSON data with query, total, classCounts, rows, capped/complete, warnings, and verified objects.',
    summarize: input => `query_context ${stringArgument(input, 'type') || stringArgument(input, 'templateQuery')}`.trim(),
  }),
  defineTool({
    name: 'read_object',
    description:
      'Read one BMP object by business id or rid. Returns its identity ' +
      '(name, type, businessId, rid, template) plus a compact overview with selected common values and names + sizes of code slots. ' +
      'The overview is deliberately incomplete. Pass properties to read up to 8 exact accessors with effective value and instance/template source; large values are summarized and reference values return verified object identity. ' +
      'This is a one-object property read, not a relationship query: do not use it to enumerate a multi-reference collection or calculate across connected objects. ' +
      'When prior tool output contains both bid= and rid=, prefer the rid= value. A verified EC reference from attached context such as t.widget, o.team or r.asset is also accepted. Numeric business ids are not rids. Prefer this over guessing what an object contains.',
    parameters: {
      type: 'object',
      properties: {
        ref: {
          type: 'string',
          description: 'Object reference. Prefer an exact rid= value; verified attached-context references such as t.widget, o.team or r.asset are also accepted.',
        },
        refType: {
          type: 'string',
          enum: ['rid', 'businessId'],
          description: 'Optional explicit reference kind. Set businessId when ref came from bid=, especially when it contains only digits.',
        },
        properties: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional exact EC property accessors to read, maximum 8. Use for a current value such as ["card"]. Do not use merely to reconfirm a self-contained change whose exact accessor and new value the user supplied.',
        },
      },
      required: ['ref'],
      additionalProperties: false,
    },
    resultDescription: 'Returns JSON data with identity links and either overview fields/code slots or exact selectedProperties with source and truncation state.',
    summarize: input => `read_object ${stringArgument(input, 'ref')}`.trim(),
  }),
  defineTool({
    name: 'read_code',
    description:
      'Read one raw code-bearing property from an object with output(), so BMP does not evaluate it. ' +
      'Use after read_layout exposes a widget and its code slots. ExtendedTable rows come from its expression property: call read_code with that table rid and property="expression" instead of inspecting descendants. ' +
      'If the returned expression directly names its SELECT class or table(...) properties, answer from the source; do not preview/re-run the stored code merely to verify it.',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Object reference. Prefer an exact rid= value; verified attached-context references such as t.widget, o.team or r.asset are also accepted.' },
        refType: { type: 'string', enum: ['rid', 'businessId'], description: 'Optional explicit reference kind. Set businessId for a numeric business id.' },
        property: { type: 'string', description: 'Raw code property, e.g. "expression", "html", "javascript", "css", "text" or "longText".' },
      },
      required: ['ref', 'property'],
      additionalProperties: false,
    },
    resultDescription: 'Returns JSON data with objectRid, property, language, exact character count, code, and complete.',
    summarize: input => `read_code ${stringArgument(input, 'ref')}.${stringArgument(input, 'property')}`.trim(),
  }),
  defineTool({
    name: 'read_type',
    description:
      'Introspect a BMP object type / class. Do not call this for a self-contained change that already supplies an exact receiver, property accessor, and value. The type argument must be a BMP class such as InputView, never a receiver such as t.xy. Returns the type\'s properties ' +
      '(EC accessor + label + config-class) from a live schema probe, plus its ' +
      'known code slots, reference edges and context fields. Pass query to search ' +
      'accessors, labels and descriptions instead of downloading a broad schema. Use this when the user described a property concept but did not supply its exact accessor. ' +
      'For a matching list or tag property, the same result includes its exact configured option names and t.* value references; use those values instead of reading exemplars or probing status synonyms. ' +
      'For semantic words such as open, active, closed or retired, query "lifecycle" once; do not try status synonyms or inspect exemplars after optionSets returns configured values. ' +
      'For a question about objects connected/linked/related to the attached object, inspect the attached type for the relationship accessor, inspect the related type for requested fields, then use one read-only preview_ec traversal for the rows or aggregate. Do not substitute read_object or query_context for that relationship traversal. ' +
      'The same result also probes and returns a verified data collection in collections. When that array is non-empty, use it directly and do not call read_type again for a root or collection. ' +
      'When read_layout supplied a concrete widget RID, pass it as exampleRid so BMP help can recover system properties for classes whose global schema catalogue is empty.',
    parameters: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          description: 'PascalCase BMP class name, e.g. "CustomVisualization", "ButtonInput".',
        },
        query: {
          type: 'string',
          description: 'Optional case-insensitive accessor, label or description substring, e.g. "card" or "lifecycle".',
        },
        exampleRid: {
          type: 'string',
          description: 'Optional exact decimal-string RID for a concrete object of this type, normally a widget RID returned by read_layout. Companion resolves the safe EC reference internally.',
        },
        propertyOnly: {
          type: 'boolean',
          description: 'Set true when only property/schema evidence is needed. This skips the extra data-collection probe while retaining matching properties and configured option values.',
        },
      },
      required: ['type'],
      additionalProperties: false,
    },
    resultDescription: 'Returns JSON data with affordances, metadata slots/edges, live schema matches, exact list/tag option sets, verified collections, counts, and complete.',
    summarize: input => {
      const query = stringArgument(input, 'query');
      return `read_type ${stringArgument(input, 'type')}${query ? ` "${query}"` : ''}`.trim();
    },
  }),
  defineTool({
    name: 'search_objects',
    description:
      'Search the workspace for objects by name/text (BMP quick search). ' +
      'Returns up to ~25 hits with businessId, name, type, rid, and an exact [[object:RID]] token. Use lookup("RID") when the exact hit must be an EC value; keep the 64-bit RID quoted. Use to ' +
      'locate an object when you only know part of its name. For a new data widget whose row class is unknown, set purpose="row-type" and call this once with the user\'s business noun. That compact result returns ranked live typeCandidates; choose the matching data class and continue to read_type. Do not also query_context or repeat the search with casing or fragments.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free-text search string.' },
        type: { type: 'string', description: 'Optional BMP type name to filter the hits.' },
        purpose: {
          type: 'string',
          enum: ['objects', 'row-type'],
          description: 'Use row-type only to discover the live data class for a new table/chart. It returns ranked type candidates instead of a long object list.',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    resultDescription: 'Returns JSON data with hit counts, typeCounts, optional ranked typeCandidates for row-type discovery, capped/complete, and verified objects.',
    summarize: input => `search_objects "${stringArgument(input, 'query')}"`,
  }),
  defineTool({
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
    resultDescription: 'Returns JSON data with matches grouped by object/property, matching lines, capped/complete, and verified objects.',
    summarize: input => `code_search "${stringArgument(input, 'pattern')}"`,
  }),
  defineTool({
    name: 'read_layout',
    description:
      'Read a BMP page layout. Returns the page owner, contributing TabSets, and a flat tab/container/widget hierarchy with exact string RIDs, parent RIDs, object types, names, responsive column spans (BMP 0–6; 0 is class-dependent), storage, linked-template RIDs, code slots, counts, omissions, and completeness. ' +
      'It does not return styling, widget-owned rows, or Change Ticket routing. Large pages return a balanced outline across tabs; use focusRid only to inspect an omitted subtree from a partial result. ' +
      'Use this first for questions about a page, tab, container, widget, table, or rows displayed by a table. For an ExtendedTable, follow it with read_code on the returned table RID and expression slot; do not call query_context first.',
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
    resultDescription: 'Returns structural JSON data with page ownership, flat layout nodes, exact parentage and widths, tabsets, omissions, sourceTruncated, and complete.',
    summarize: input => `read_layout ${stringArgument(input, 'pageRid')}`.trim(),
  }),
  defineTool({
    name: 'preview_ec',
    description:
      'Run read-only Extended Code against the live workspace and return its result ' +
      'or error verbatim. This NEVER commits and must never call external resources. In sidebar chat, use it for either a genuinely investigative ' +
      'read-only EC question whose answer is not already available from another tool, or one check of a joined/grouped/aggregated/calculated stored ExtendedTable expression against representative rows. ' +
      'Do not use it for an ordinary structural-descendant list after read_type; query_context performs that live data read. Do not Preview a proposed outer change: submit_change_ticket triggers that exact Preview automatically. ' +
      'After one complete result, answer or submit immediately; never repeat the Preview or do ordinary arithmetic in EC.',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Extended Code to preview (not committed).' },
      },
      required: ['code'],
      additionalProperties: false,
    },
    resultDescription: 'Returns JSON data with the Preview log, warning flag, and complete.',
    summarize: input => {
      const code = stringArgument(input, 'code');
      const lines = code ? code.split('\n').length : 0;
      return `preview_ec (${lines} line${lines === 1 ? '' : 's'})`;
    },
  }),
];

export type AiToolName = typeof TOOL_CONTRACT_LIST[number]['name'];

/** One owner for schema, provider result contract, and transcript summary.
 * BMP execution and deterministic fixtures remain exhaustive adapters. */
export const TOOL_CONTRACTS: ReadonlyMap<string, AiToolContract> = new Map(
  TOOL_CONTRACT_LIST.map(contract => [contract.name, contract]),
);

export const TOOL_NAMES: ReadonlySet<string> = new Set(TOOL_CONTRACTS.keys());

/** Stable provider definitions are projected from the canonical contracts. */
export const TOOL_DEFS: ToolDef[] = TOOL_CONTRACT_LIST.map(contract => ({
  name: contract.name,
  description: contract.description,
  parameters: contract.parameters,
}));

/** Validate the provider-facing JSON-schema subset before production or
 * fixture execution. Semantic checks remain in their respective adapters. */
export function validateToolInput(name: string, input: Record<string, unknown>): string | null {
  const schema = TOOL_CONTRACTS.get(name)?.parameters;
  if (!schema) return `Unknown tool: ${name}`;
  for (const required of schema.required) {
    if (!(required in input)) return `${name} requires "${required}".`;
  }
  if (!schema.additionalProperties) {
    const unexpected = Object.keys(input).find(key => !(key in schema.properties));
    if (unexpected) return `${name} does not accept "${unexpected}".`;
  }
  for (const [key, value] of Object.entries(input)) {
    const property = schema.properties[key];
    if (!property) continue;
    if (property.type === 'string') {
      if (typeof value !== 'string') return `${name}."${key}" must be a string.`;
      if (property.enum && !property.enum.includes(value)) {
        return `${name}."${key}" must be one of: ${property.enum.join(', ')}.`;
      }
    } else if (property.type === 'boolean') {
      if (typeof value !== 'boolean') return `${name}."${key}" must be a boolean.`;
    } else if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
      return `${name}."${key}" must be an array of strings.`;
    }
  }
  return null;
}

export function summarizeToolCall(call: { name: string; input: Record<string, unknown> }): string {
  return TOOL_CONTRACTS.get(call.name)?.summarize(call.input) ?? call.name;
}

function providerToolDescription(definition: ToolDef): string {
  const result = TOOL_CONTRACTS.get(definition.name)?.resultDescription;
  return result ? `${definition.description} ${result}` : definition.description;
}

/** Anthropic `tools` param projection. */
export function toAnthropicTools(defs: ToolDef[] = TOOL_DEFS): Array<{ name: string; description: string; input_schema: ToolParamSchema }> {
  return defs.map(d => ({ name: d.name, description: providerToolDescription(d), input_schema: d.parameters }));
}

/** OpenAI-compatible `tools` array projection (function calling). */
export function toOpenAiTools(defs: ToolDef[] = TOOL_DEFS): Array<{ type: 'function'; function: { name: string; description: string; parameters: ToolParamSchema } }> {
  return defs.map(d => ({ type: 'function', function: { name: d.name, description: providerToolDescription(d), parameters: d.parameters } }));
}
