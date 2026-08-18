import type { AiChatEvent } from './types';
import type { ExecuteTool, ToolCall, ToolResult } from './tools';
import { boundedToolResult } from './tools';
import { summarizeToolCall } from './tool-contracts';
import { isToolSuccess } from './tool-results';
import type { ToolDataMap } from './tool-results';

export interface PrefetchedToolExecution {
  call: ToolCall;
  result: ToolResult;
  durationMs: number;
}

export interface PageContextPrefetch {
  executions: PrefetchedToolExecution[];
  /** Verified provider evidence. Structural misses remain private; a relevant
   * match is represented by exactly one of the two evidence variants. */
  evidence?: PrefetchedContextEvidence;
  /** Provider-ready plan. It limits the prepared turn to tools that could fill
   * a remaining evidence gap; target selection stays with the model. */
  providerPlan?: PreparedSimpleChangePlan;
}

export type PrefetchedContextEvidence = WidgetPropertyContextEvidence | PrefetchedLayoutContextEvidence;

type LayoutNode = ToolDataMap['read_layout']['nodes'][number];
type PrefetchedLayoutTreeNode = Omit<LayoutNode, 'parentRid' | 'depth'> & {
  children?: PrefetchedLayoutTreeNode[];
};

export interface PrefetchedLayoutContextEvidence {
  kind: 'prefetched-layout-context';
  layout: {
    viewedRid: string;
    pageOwnerRid: string;
    pageTemplateRid?: string;
    selection: 'prompt-matched-widgets-and-ancestors';
    totalPageNodes: number;
    sourceComplete: boolean;
    roots: PrefetchedLayoutTreeNode[];
  };
}

export interface PreparedSimpleChangePlan {
  allowedModelTools: string[];
}

interface PrefetchedWidgetContext {
  rid: string;
  businessId: string;
  type: string;
  name: string;
  linkedTemplateRid?: string;
}

export interface WidgetPropertyContextEvidence {
  kind: 'prefetched-widget-property-context';
  widget: PrefetchedWidgetContext;
  properties: ToolDataMap['read_type']['schema']['properties'];
  optionSets?: ToolDataMap['read_type']['optionSets'];
  propertySearchComplete: boolean;
}

function planForEvidence(
  evidence: WidgetPropertyContextEvidence,
  currentValueRequested: boolean,
): PreparedSimpleChangePlan {
  const tools = new Set<string>();
  if (currentValueRequested) tools.add('read_object');
  if (evidence.properties.some(property => /ReferenceMethodConfig/i.test(property.configClass))) {
    tools.add('search_objects');
  }
  if (evidence.properties.some(property =>
    /(?:expression|html|javascript|css|code|longText)/i.test(`${property.accessor} ${property.configClass}`))) {
    tools.add('read_code');
  }

  return { allowedModelTools: [...tools] };
}

function preparedResult(
  executions: PrefetchedToolExecution[],
  evidence: WidgetPropertyContextEvidence,
  currentValueRequested: boolean,
): PageContextPrefetch {
  const providerPlan = evidence.properties.length === 1
    && evidence.propertySearchComplete
    ? planForEvidence(evidence, currentValueRequested)
    : undefined;
  return { executions, evidence, ...(providerPlan ? { providerPlan } : {}) };
}

function layoutResult(
  executions: PrefetchedToolExecution[],
  layout: ToolDataMap['read_layout'],
  matches: ToolDataMap['read_layout']['nodes'],
): PageContextPrefetch {
  const nodesByRid = new Map(layout.nodes.flatMap(node => node.rid ? [[node.rid, node] as const] : []));
  const includedRids = new Set<string>();
  for (const match of matches) {
    let current: typeof match | undefined = match;
    while (current?.rid && !includedRids.has(current.rid)) {
      includedRids.add(current.rid);
      current = current.parentRid ? nodesByRid.get(current.parentRid) : undefined;
    }
  }
  const selectedNodes = layout.nodes.filter(node => !!node.rid && includedRids.has(node.rid));
  const childrenByParent = new Map<string, LayoutNode[]>();
  for (const node of selectedNodes) {
    if (!node.parentRid || !includedRids.has(node.parentRid)) continue;
    const siblings = childrenByParent.get(node.parentRid) ?? [];
    siblings.push(node);
    childrenByParent.set(node.parentRid, siblings);
  }
  const treeNode = (node: LayoutNode): PrefetchedLayoutTreeNode => {
    const children = node.rid ? childrenByParent.get(node.rid)?.map(treeNode) ?? [] : [];
    return {
      ...(node.rid ? { rid: node.rid } : {}),
      businessId: node.businessId,
      kind: node.kind,
      type: node.type,
      name: node.name,
      columns: node.columns,
      storage: node.storage,
      ...(node.tabsetBusinessId ? { tabsetBusinessId: node.tabsetBusinessId } : {}),
      codeSlots: node.codeSlots,
      ...(node.linkedTemplateRid ? { linkedTemplateRid: node.linkedTemplateRid } : {}),
      ...(children.length ? { children } : {}),
    };
  };
  const roots = selectedNodes
    .filter(node => !node.parentRid || !includedRids.has(node.parentRid))
    .map(treeNode);
  return {
    executions,
    evidence: {
      kind: 'prefetched-layout-context',
      layout: {
        viewedRid: layout.viewedRid,
        pageOwnerRid: layout.pageOwnerRid,
        ...(layout.pageTemplateRid ? { pageTemplateRid: layout.pageTemplateRid } : {}),
        selection: 'prompt-matched-widgets-and-ancestors',
        totalPageNodes: layout.totalNodes,
        sourceComplete: layout.complete && !layout.sourceTruncated && layout.omittedNodes === 0,
        roots,
      },
    },
  };
}

interface PrefetchOptions {
  text: string;
  pageRid?: string;
  executeTool: ExecuteTool;
  onEvent: (event: AiChatEvent) => void;
  signal?: AbortSignal;
}

const QUERY_FILLER_WORDS = new Set([
  'a', 'about', 'add', 'an', 'build', 'can', 'change', 'could', 'create', 'current',
  'delete', 'do', 'does', 'explain',
  'for', 'how', 'i', 'in', 'is', 'make', 'me', 'on', 'please', 'property', 'set',
  'move', 'remove', 'setting', 'tell', 'the', 'this', 'to', 'turn', 'update', 'what', 'which', 'why',
  'widget', 'would', 'you',
]);

function words(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLocaleLowerCase()
    .match(/[a-z0-9_]+/g) ?? [];
}

/** Cheap shape check only. Retrieval may establish widget/property candidates,
 * but the model—not a keyword classifier—decides whether the request is an
 * answer, a change, or a more complex workflow. */
function canPrefetchPageContext(text: string): boolean {
  if (text.length > 260 || text.includes('\n') || /[:=;{}]/.test(text)) return false;
  if (hasExplicitMutationTarget(text)) return false;
  return words(text).length > 0;
}

/** An explicit mutation receiver is authoritative. Looking at the current page
 * in that case can only add unrelated evidence and tempt the model to retarget
 * the request. Value references such as “set it to t.xy” deliberately do not
 * match this shape. */
function hasExplicitMutationTarget(text: string): boolean {
  const symbolic = String.raw`[torgu]\.[A-Za-z_][A-Za-z0-9_]*`;
  const lookup = String.raw`lookup\s*\(\s*["']?-?\d+["']?\s*\)`;
  const receiver = `(?:${symbolic}|${lookup})`;
  return new RegExp(String.raw`\b(?:change|update|modify|rename|delete|remove)\s+(?:the\s+)?(?:target\s+)?${receiver}(?=\s|[.,;:]|$)`, 'i').test(text)
    || new RegExp(String.raw`${receiver}\s*\.\s*(?:change|add|delete|reset)\s*\(`, 'i').test(text);
}

/** Whether answering the request depends on the property's persisted value.
 * This only controls retrieval availability; the model still decides what the
 * request means and which final artifact is useful. */
function requestsCurrentValue(text: string): boolean {
  return /\b(?:current|currently|right now|at the moment|existing value|what value|which value)\b/i.test(text)
    || /\bwhat\b[^?.]{0,48}\bset to\b/i.test(text)
    || /\b(?:is|are|does)\b[^?.]{0,48}\b(?:visible|hidden|enabled|disabled|shown|set)\b/i.test(text);
}

function nodeMatches(
  text: string,
  nodes: ToolDataMap['read_layout']['nodes'],
): ToolDataMap['read_layout']['nodes'] {
  const promptTokens = new Set(words(text));
  const promptLower = text.toLocaleLowerCase();
  const candidates = nodes
    .filter(node => node.kind === 'widget' && node.rid)
    .map(node => {
      const nameTokens = words(node.name).filter(token => token.length > 1);
      const businessIdMentioned = !!node.businessId
        && promptLower.includes(node.businessId.toLocaleLowerCase());
      const nameMentioned = nameTokens.length > 0 && nameTokens.every(token => promptTokens.has(token));
      return {
        node,
        matched: businessIdMentioned || nameMentioned,
      };
    })
    .filter(candidate => candidate.matched);
  return candidates.map(candidate => candidate.node);
}

function propertyQuery(text: string, node: ToolDataMap['read_layout']['nodes'][number]): string {
  const targetWords = new Set([...words(node.name), ...words(node.businessId), ...words(node.type)]);
  return words(text)
    .filter(word => !targetWords.has(word) && !QUERY_FILLER_WORDS.has(word))
    .join(' ');
}

function widgetContext(
  node: ToolDataMap['read_layout']['nodes'][number],
): PrefetchedWidgetContext | undefined {
  if (!node.rid || node.kind !== 'widget') return undefined;
  return {
    rid: node.rid,
    businessId: node.businessId,
    type: node.type,
    name: node.name,
    ...(node.linkedTemplateRid ? { linkedTemplateRid: node.linkedTemplateRid } : {}),
  };
}

async function runPrefetchTool(
  call: ToolCall,
  options: PrefetchOptions,
): Promise<PrefetchedToolExecution> {
  const summary = summarizeToolCall(call);
  options.onEvent({ kind: 'tool-start', name: call.name, summary });
  const started = Date.now();
  const result = boundedToolResult(await options.executeTool(call, options.signal));
  const durationMs = Date.now() - started;
  options.onEvent({
    kind: 'tool-end',
    name: call.name,
    summary,
    ok: !result.isError,
    durationMs,
    duplicate: false,
    objects: result.objects,
  });
  return { call, result, durationMs };
}

/**
 * Preload compact current-page widget/property context before the provider is
 * called. This module retrieves facts but never decides intent, scope,
 * property, value, or EC. Ambiguity is returned to the model as ambiguity so
 * it can answer, choose among verified candidates, or continue with read tools.
 */
export async function prefetchPageContext(
  options: PrefetchOptions,
): Promise<PageContextPrefetch | null> {
  const pageRid = options.pageRid?.trim();
  if (!pageRid || !/^-?\d+$/.test(pageRid) || !canPrefetchPageContext(options.text)) return null;
  const currentValueRequested = requestsCurrentValue(options.text);

  const layout = await runPrefetchTool({
    id: 'crev-prefetch-layout',
    name: 'read_layout',
    input: { pageRid },
  }, options);
  const executions = [layout];
  if (layout.result.isError || !isToolSuccess(layout.result.structuredContent, 'read_layout')) {
    return { executions };
  }
  const layoutData = layout.result.structuredContent.data;
  const matches = nodeMatches(options.text, layoutData.nodes);
  if (!matches.length) return { executions };
  if (!layoutData.complete || layoutData.sourceTruncated || layoutData.omittedNodes > 0) {
    return layoutResult(
      executions,
      layoutData,
      matches,
    );
  }
  const widgets = matches
    .map(node => widgetContext(node))
    .filter((widget): widget is PrefetchedWidgetContext => !!widget);
  if (!widgets.length) return { executions };
  if (widgets.length > 1) {
    return layoutResult(
      executions,
      layoutData,
      matches,
    );
  }

  const node = matches[0];
  const query = propertyQuery(options.text, node);
  if (!query || words(query).length > 6) {
    return layoutResult(
      executions,
      layoutData,
      matches,
    );
  }
  const type = await runPrefetchTool({
    id: 'crev-prefetch-type',
    name: 'read_type',
    input: {
      type: node.type,
      query,
      exampleRid: node.rid,
      propertyOnly: true,
    },
  }, options);
  executions.push(type);
  if (type.result.isError || !isToolSuccess(type.result.structuredContent, 'read_type')) {
    return layoutResult(
      executions,
      layoutData,
      matches,
    );
  }
  const typeData = type.result.structuredContent.data;
  const propertyCandidates = typeData.schema.available
    ? typeData.schema.properties.slice(0, 8)
    : [];
  const optionSets = typeData.optionSets.filter(option =>
    propertyCandidates.some(property => property.accessor === option.accessor));
  return preparedResult(executions, {
    kind: 'prefetched-widget-property-context',
    widget: widgets[0],
    properties: propertyCandidates,
    ...(optionSets.length ? { optionSets } : {}),
    propertySearchComplete: typeData.complete,
  }, currentValueRequested);
}
