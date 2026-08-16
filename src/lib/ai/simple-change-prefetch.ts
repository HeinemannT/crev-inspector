import type { AiChatEvent } from './types';
import type { ExecuteTool, ToolCall, ToolResult } from './tools';
import { boundedToolResult } from './tools';
import { summarizeToolCall } from './tool-contracts';
import { isToolSuccess } from './tool-results';
import type { ToolDataMap } from './tool-results';
import type { ChangeTargetRecord } from './change-target';

export interface PrefetchedToolExecution {
  call: ToolCall;
  result: ToolResult;
  durationMs: number;
}

export interface SimpleChangePrefetch {
  executions: PrefetchedToolExecution[];
  /** Compact verified context for the model. It deliberately contains
   * candidates rather than making the semantic choice on the model's behalf. */
  evidence?: WidgetPropertyContextEvidence;
  /** Provider-ready route. The orchestrator consumes this without interpreting
   * widget/property candidates or reproducing prefetch policy. */
  route?: PreparedSimpleChangeRoute;
}

export interface PreparedSimpleChangeRoute {
  promptAppendix: string;
  allowedModelTools: string[];
  changeTargets: Array<{ rid: string; mutationRef: string; scope: ChangeTargetRecord['scope'] }>;
}

interface PrefetchedChangeTarget {
  token: string;
  mutationRef: string;
  scope: string;
  impact: string;
  reason: string;
}

interface PrefetchedWidgetContext {
  rid: string;
  businessId: string;
  type: string;
  name: string;
  defaultTarget: PrefetchedChangeTarget;
  instanceAlternative?: PrefetchedChangeTarget;
}

export interface WidgetPropertyContextEvidence {
  kind: 'prefetched-widget-property-context';
  status: 'widget-ambiguous' | 'property-candidates' | 'property-unavailable';
  widgets: PrefetchedWidgetContext[];
  propertyQuery?: string;
  propertyCandidates: ToolDataMap['read_type']['schema']['properties'];
  optionSets: ToolDataMap['read_type']['optionSets'];
  complete: boolean;
  /** Retrieval need only—not an answer/change intent label. */
  currentValueRequested?: boolean;
  instruction: string;
}

function routeForEvidence(evidence: WidgetPropertyContextEvidence): PreparedSimpleChangeRoute {
  const tools = new Set<string>();
  if (evidence.currentValueRequested) tools.add('read_object');
  if (evidence.propertyCandidates.some(property => /ReferenceMethodConfig/i.test(property.configClass))) {
    tools.add('search_objects');
  }
  if (evidence.propertyCandidates.some(property =>
    /(?:expression|html|javascript|css|code|longText)/i.test(`${property.accessor} ${property.configClass}`))) {
    tools.add('read_code');
  }

  const changeTargets = evidence.widgets.flatMap(widget =>
    [widget.defaultTarget, widget.instanceAlternative].flatMap(target => {
      if (!target) return [];
      const rid = /^\[\[object:(-?\d+)\]\]$/.exec(target.token)?.[1];
      if (!rid) return [];
      return [{
        rid,
        mutationRef: target.mutationRef,
        scope: target.scope as ChangeTargetRecord['scope'],
      }];
    }),
  );
  return {
    promptAppendix: `<prefetched-context>${JSON.stringify(evidence)}</prefetched-context>`,
    allowedModelTools: [...tools],
    changeTargets,
  };
}

function preparedResult(
  executions: PrefetchedToolExecution[],
  evidence: WidgetPropertyContextEvidence,
  currentValueRequested: boolean,
): SimpleChangePrefetch {
  const enriched = { ...evidence, currentValueRequested };
  const route = enriched.widgets.length === 1
    && enriched.propertyCandidates.length === 1
    && enriched.complete
    ? routeForEvidence(enriched)
    : undefined;
  return { executions, evidence: enriched, ...(route ? { route } : {}) };
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
  return words(text).length > 0;
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
    .filter(node => node.kind === 'widget' && node.rid && node.changeTarget?.status === 'resolved')
    .map(node => {
      const nameTokens = words(node.name).filter(token => token.length > 1);
      const businessIdMentioned = !!node.businessId
        && promptLower.includes(node.businessId.toLocaleLowerCase());
      const nameMentioned = nameTokens.length > 0 && nameTokens.every(token => promptTokens.has(token));
      return {
        node,
        matched: businessIdMentioned || nameMentioned,
        score: (businessIdMentioned ? 1_000 : 0) + nameTokens.length,
      };
    })
    .filter(candidate => candidate.matched)
    .sort((a, b) => b.score - a.score);
  if (!candidates.length) return [];
  const topScore = candidates[0].score;
  return candidates.filter(candidate => candidate.score === topScore).map(candidate => candidate.node);
}

function propertyQuery(text: string, node: ToolDataMap['read_layout']['nodes'][number]): string {
  const targetWords = new Set([...words(node.name), ...words(node.businessId), ...words(node.type)]);
  return words(text)
    .filter(word => !targetWords.has(word) && !QUERY_FILLER_WORDS.has(word))
    .join(' ');
}

function targetContext(
  target: Extract<ToolDataMap['read_layout']['nodes'][number]['changeTarget'], { status: 'resolved' }>,
): PrefetchedChangeTarget {
  return {
    token: `[[object:${target.target.rid}]]`,
    mutationRef: target.target.ecRef,
    scope: target.scope,
    impact: target.impact,
    reason: target.reason,
  };
}

function widgetContext(node: ToolDataMap['read_layout']['nodes'][number]): PrefetchedWidgetContext | undefined {
  const target = node.changeTarget;
  if (!node.rid || !target || target.status !== 'resolved') return undefined;
  return {
    rid: node.rid,
    businessId: node.businessId,
    type: node.type,
    name: node.name,
    defaultTarget: targetContext(target),
    ...(target.alternative ? {
      instanceAlternative: {
        token: `[[object:${target.alternative.target.rid}]]`,
        mutationRef: target.alternative.target.ecRef,
        scope: target.alternative.scope,
        impact: target.alternative.impact,
        reason: target.alternative.reason,
      },
    } : {}),
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
export async function prefetchSimpleWidgetChange(
  options: PrefetchOptions,
): Promise<SimpleChangePrefetch | null> {
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
  if (!layoutData.complete || layoutData.sourceTruncated || layoutData.omittedNodes > 0) {
    return { executions };
  }
  const matches = nodeMatches(options.text, layoutData.nodes);
  const widgets = matches.map(widgetContext).filter((widget): widget is PrefetchedWidgetContext => !!widget);
  if (!widgets.length) return { executions };
  if (widgets.length > 1) {
    return preparedResult(executions, {
        kind: 'prefetched-widget-property-context',
        status: 'widget-ambiguous',
        widgets,
        propertyCandidates: [],
        optionSets: [],
        complete: false,
        instruction: 'Several equally strong widget matches were found. Do not guess. Ask a concise question or use read_layout to resolve the intended widget.',
    }, currentValueRequested);
  }

  const node = matches[0];
  const query = propertyQuery(options.text, node);
  if (!query) {
    return preparedResult(executions, {
        kind: 'prefetched-widget-property-context',
        status: 'property-unavailable',
        widgets,
        propertyCandidates: [],
        optionSets: [],
        complete: false,
        instruction: 'The widget is verified, but the request did not yield a useful property query. Answer if appropriate or use read_type/read_object to investigate.',
    }, currentValueRequested);
  }
  const type = await runPrefetchTool({
    id: 'crev-prefetch-type',
    name: 'read_type',
    input: {
      type: node.type,
      query,
      exampleRef: widgets[0].defaultTarget.mutationRef,
      propertyOnly: true,
    },
  }, options);
  executions.push(type);
  if (type.result.isError || !isToolSuccess(type.result.structuredContent, 'read_type')) {
    return preparedResult(executions, {
        kind: 'prefetched-widget-property-context',
        status: 'property-unavailable',
        widgets,
        propertyQuery: query,
        propertyCandidates: [],
        optionSets: [],
        complete: false,
        instruction: 'The widget is verified, but property lookup failed. Use the available read tools instead of guessing.',
    }, currentValueRequested);
  }
  const typeData = type.result.structuredContent.data;
  const propertyCandidates = typeData.schema.available
    ? typeData.schema.properties.slice(0, 8)
    : [];
  return preparedResult(executions, {
      kind: 'prefetched-widget-property-context',
      status: propertyCandidates.length ? 'property-candidates' : 'property-unavailable',
      widgets,
      propertyQuery: query,
      propertyCandidates,
      optionSets: typeData.optionSets.filter(option => propertyCandidates.some(property => property.accessor === option.accessor)),
      complete: typeData.complete && propertyCandidates.length <= 1,
      instruction: propertyCandidates.length
        ? 'These are verified live property candidates, not a predetermined choice. Select the candidate that semantically fits the request, or use read_type/read_object/read_code/search_objects if more evidence is needed.'
        : typeData.complete
          ? 'The complete live property search found no match. Do not repeat read_type with synonyms or invent an accessor; answer with that limitation or ask one concise clarification.'
          : 'No matching live property was returned from incomplete evidence. Use the available read tools instead of inventing an accessor.',
  }, currentValueRequested);
}
