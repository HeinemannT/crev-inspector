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
      'Count or list structural descendants of the attached context; enterprise instances resolve through .template. The scope is already bound, so do not search for it first. Use a live-confirmed type, or templateQuery when the business noun\'s class is unknown. Returns total, class distribution, and up to 25 identified rows with optional confirmed fields/filter. Not for tabs/widgets/table rows (read_layout), new-widget row-type discovery (search_objects purpose=row-type), or relationship edges (read_type then preview_ec). After read_type establishes descendant fields/filter, call this once.',
    parameters: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          description: 'Optional live-confirmed PascalCase BMP descendant class.',
        },
        templateQuery: {
          type: 'string',
          description: 'Optional semantic/template-name substring when the class is unknown. One of type or templateQuery is required.',
        },
        fields: {
          type: 'array',
          items: { type: 'string' },
          description: 'Up to 5 confirmed extra accessors. Identity fields are already returned.',
        },
        filterField: {
          type: 'string',
          description: 'Optional confirmed filter accessor; pair with filterValue.',
        },
        filterValue: {
          type: 'string',
          description: 'Optional case-insensitive value substring; pair with filterField.',
        },
      },
      required: [],
      additionalProperties: false,
    },
    resultDescription: 'Returns query, total, classCounts, rows, capped/complete, warnings, and verified objects.',
    summarize: input => `query_context ${stringArgument(input, 'type') || stringArgument(input, 'templateQuery')}`.trim(),
  }),
  defineTool({
    name: 'read_object',
    description:
      'Read one BMP object by RID, business ID, or verified EC reference. Without properties it returns an intentionally incomplete overview and code-slot sizes; with properties it returns up to 8 exact effective values with instance/template source and verified referenced objects. Use for identity or requested current values, not relationship enumeration or aggregation. Prefer a returned rid= over bid=; numeric business IDs are not automatically RIDs.',
    parameters: {
      type: 'object',
      properties: {
        ref: {
          type: 'string',
          description: 'Exact RID, business ID, or verified t.*/o.*/r.* reference; prefer a returned rid=.',
        },
        refType: {
          type: 'string',
          enum: ['rid', 'businessId'],
          description: 'Optional kind; set businessId for a bid= value, especially numeric text.',
        },
        properties: {
          type: 'array',
          items: { type: 'string' },
          description: 'Up to 8 exact accessors for requested current values. Do not reconfirm a supplied accessor/value change.',
        },
      },
      required: ['ref'],
      additionalProperties: false,
    },
    resultDescription: 'Returns identity plus overview/code slots or selectedProperties with source and truncation state.',
    summarize: input => `read_object ${stringArgument(input, 'ref')}`.trim(),
  }),
  defineTool({
    name: 'read_code',
    description:
      'Read one raw code-bearing property without evaluating it. Use a widget RID/code slot from read_layout. ExtendedTable rows come from property="expression"; answer directly from complete source when it names the collection and table fields, without re-running it.',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Exact RID, business ID, or verified t.*/o.*/r.* reference; prefer a returned rid=.' },
        refType: { type: 'string', enum: ['rid', 'businessId'], description: 'Optional kind; set businessId for a numeric business ID.' },
        property: { type: 'string', description: 'Raw code property, e.g. "expression", "html", "javascript", "css", "text" or "longText".' },
      },
      required: ['ref', 'property'],
      additionalProperties: false,
    },
    resultDescription: 'Returns objectRid, property, language, character count, code, and complete.',
    summarize: input => `read_code ${stringArgument(input, 'ref')}.${stringArgument(input, 'property')}`.trim(),
  }),
  defineTool({
    name: 'read_type',
    description:
      'Introspect a BMP class (for example InputView, never t.widget). Use one narrow query when the user gives a property concept but not its exact accessor. Returns matching accessors/config classes, code slots, relationship edges, configured list/tag options, and verified data collections. Reuse returned t.* options and collections exactly; do not inspect exemplars or retry synonyms. For open/active rows, a returned terminal Retired/Closed option is excluded with !=; do not select one non-terminal option as the whole set. For connected data, inspect the relationship and requested fields, then traverse once with preview_ec. Pass a read_layout widget RID as exampleRid when global schema is sparse. Skip for a self-contained exact receiver/accessor/value change.',
    parameters: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          description: 'PascalCase BMP class, e.g. "CustomVisualization" or "ButtonInput".',
        },
        query: {
          type: 'string',
          description: 'Optional narrow accessor/label/description substring, e.g. "card" or "lifecycle".',
        },
        exampleRid: {
          type: 'string',
          description: 'Optional exact widget RID from read_layout for instance-backed schema help.',
        },
        propertyOnly: {
          type: 'boolean',
          description: 'True skips data-collection probing while retaining property and option evidence.',
        },
      },
      required: ['type'],
      additionalProperties: false,
    },
    resultDescription: 'Returns schema matches, edges, optionSets, collections, counts, complete, and possible typeSuggestions.',
    summarize: input => {
      const query = stringArgument(input, 'query');
      return `read_type ${stringArgument(input, 'type')}${query ? ` "${query}"` : ''}`.trim();
    },
  }),
  defineTool({
    name: 'search_objects',
    description:
      'Search workspace objects by name/text. Default results identify up to ~25 hits; use lookup("RID") with the returned 64-bit RID quoted when a hit becomes an EC value. For a new table/chart with unknown row class, call once with purpose="row-type" and the user\'s likely business term despite shorthand or spelling errors; choose the ranked live canonicalType, then use read_type if fields are needed. Do not repeat with casing/fragments or also use query_context.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Likely name or business term.' },
        type: { type: 'string', description: 'Optional BMP type name to filter the hits.' },
        purpose: {
          type: 'string',
          enum: ['objects', 'row-type'],
          description: 'row-type returns ranked live data-class candidates for a new table/chart.',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    resultDescription: 'Returns counts, optional ranked typeCandidates, capped/complete, and verified objects.',
    summarize: input => `search_objects "${stringArgument(input, 'query')}"`,
  }),
  defineTool({
    name: 'code_search',
    description:
      'Search code-bearing objects for a literal substring. Use to find where a token, business ID, or helper is referenced.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Literal substring to find (case-sensitive).' },
        type: { type: 'string', description: 'Optional BMP type name to limit the search.' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
    resultDescription: 'Returns object/property matches, lines, capped/complete, and verified objects.',
    summarize: input => `code_search "${stringArgument(input, 'pattern')}"`,
  }),
  defineTool({
    name: 'read_layout',
    description:
      'Read page ownership and a flat tab/container/widget hierarchy with exact RIDs, parents, types, names, BMP widths (0–6), storage, linked-template RIDs, code slots, omissions, and completeness. Use first for page structure, placement, widgets, tables, or displayed table rows. Do not call when verified-prefetched-evidence already completed read_layout. It does not return styling or widget-owned rows; follow an ExtendedTable with read_code(expression). Use focusRid only when a partial result omitted the needed subtree.',
    parameters: {
      type: 'object',
      properties: {
        pageRid: { type: 'string', description: 'Exact numeric RID of the page.' },
        focusRid: {
          type: 'string',
          description: 'Optional returned node RID when a capped outline omitted its subtree.',
        },
      },
      required: ['pageRid'],
      additionalProperties: false,
    },
    resultDescription: 'Returns page ownership, flat nodes, parentage/widths, tabsets, omissions, sourceTruncated, and complete.',
    summarize: input => `read_layout ${stringArgument(input, 'pageRid')}`.trim(),
  }),
  defineTool({
    name: 'preview_ec',
    description:
      'Run read-only Extended Code and return the live result/error. It never commits and must not call external resources. Use only when structured tools cannot answer an investigative query, or to check one uncertain joined/grouped/aggregated/calculated deferred expression. Do not preview an outer mutation (submit_change_ticket does that) or an ordinary descendant list (query_context). After one complete result, answer or submit immediately.',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Read-only Extended Code; never committed.' },
      },
      required: ['code'],
      additionalProperties: false,
    },
    resultDescription: 'Returns Preview log, warning flag, and complete.',
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
