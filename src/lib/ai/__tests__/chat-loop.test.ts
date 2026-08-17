import { describe, it, expect, vi, afterEach } from 'vitest';
import { CHAT_MAX_OUTPUT_TOKENS, MAX_EMPTY_RESPONSE_RETRIES, MAX_MISSING_PREVIEW_RETRIES, streamChat } from '../client';
import type { AiChatEvent } from '../types';
import type { ToolCall, ToolResult } from '../tools';
import type { AiSettings } from '../types';
import { toolSuccess } from '../tool-results';

function layoutToolResult(options: {
  targetRid?: string;
  targetRef?: string;
  placementRid?: string;
  placementRef?: string;
  scope?: 'shared-template' | 'direct-page';
  includeSharedWidget?: boolean;
} = {}): ToolResult {
  const targetRid = options.targetRid ?? '111';
  const targetRef = options.targetRef ?? 't.landing_template';
  const pageTarget = {
    status: 'resolved' as const,
    target: { rid: targetRid, businessId: targetRef.split('.').at(-1)!, type: 'Scorecard', ecRef: targetRef },
    scope: options.scope ?? 'shared-template',
    impact: options.scope === 'direct-page' ? 'one-page' as const : 'all-linked-instances' as const,
    reason: options.scope === 'direct-page' ? 'direct-page-owner' as const : 'linked-page-default' as const,
  };
  const placementTarget = options.placementRef ? {
    status: 'resolved' as const,
    target: {
      rid: options.placementRid ?? '112',
      businessId: options.placementRef.split('.').at(-1)!,
      type: 'Container',
      ecRef: options.placementRef,
    },
    scope: 'shared-portal' as const,
    impact: 'all-portal-consumers' as const,
    reason: 'portal-structure-is-shared' as const,
  } : undefined;
  const objects = [
    { rid: targetRid, businessId: pageTarget.target.businessId, type: 'Scorecard' },
    ...(placementTarget ? [{ rid: placementTarget.target.rid, businessId: placementTarget.target.businessId, type: 'Container' }] : []),
    ...(options.includeSharedWidget ? [{ rid: '818', businessId: 'qa_shared_widget', type: 'ExtendedTable' }] : []),
  ];
  const sharedWidgetTarget = options.includeSharedWidget ? {
    status: 'resolved' as const,
    target: { rid: '818', businessId: 'qa_shared_widget', type: 'ExtendedTable', ecRef: 't.qa_shared_widget' },
    scope: 'shared-template' as const,
    impact: 'all-linked-instances' as const,
    reason: 'inherited-widget-default' as const,
  } : undefined;
  const nodes = [
    ...(placementTarget ? [{
      rid: placementTarget.target.rid,
      businessId: placementTarget.target.businessId,
      depth: 0,
      kind: 'container' as const,
      type: 'Container',
      name: 'Content',
      columns: { large: 6 },
      storage: 'portal-shared' as const,
      codeSlots: [],
      changeTarget: placementTarget,
    }] : []),
    ...(sharedWidgetTarget ? [{
      rid: sharedWidgetTarget.target.rid,
      businessId: sharedWidgetTarget.target.businessId,
      depth: 1,
      kind: 'widget' as const,
      type: 'ExtendedTable',
      name: 'Shared widget',
      columns: { large: 6 },
      storage: 'page-child' as const,
      codeSlots: ['expression'],
      changeTarget: sharedWidgetTarget,
    }] : []),
  ];
  const structuredContent = toolSuccess('read_layout', {
    viewedRid: '222',
    pageOwnerRid: targetRid,
    focusFound: true,
    requestedScope: 'default',
    resultOnly: false,
    tabsets: [],
    totalNodes: nodes.length,
    returnedNodes: nodes.length,
    omittedNodes: 0,
    sourceTruncated: false,
    orphanCount: 0,
    complete: true,
    pageTarget,
    nodes,
  }, objects);
  return { content: 'Layout resolved.', isError: false, structuredContent, objects };
}

function referenceTypeResult(): ToolResult {
  return {
    content: 'Type property resolved.',
    isError: false,
    structuredContent: toolSuccess('read_type', {
      requestedType: 'CeRiskAssessment',
      query: 'detail card',
      affordances: { code: false, references: true, flow: false },
      codeSlots: [],
      referenceEdges: ['card'],
      contextFields: [],
      collections: [],
      schema: {
        available: true,
        total: 1,
        returned: 1,
        truncated: false,
        properties: [{
          accessor: 'card',
          label: 'Detail Card',
          configClass: 'ReferenceMethodConfig',
          system: false,
        }],
      },
      optionSets: [],
      complete: true,
    }),
  };
}

function streamBody(parts: string[]) {
  let i = 0;
  const enc = new TextEncoder();
  return { getReader() { return { read: () => Promise.resolve(i < parts.length ? { value: enc.encode(parts[i++]), done: false } : { value: undefined, done: true }) }; } };
}
function okStream(parts: string[]): any { return { ok: true, status: 200, body: streamBody(parts) }; }

const TOOL_TURN = [
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t","name":"read_type"}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"type\\":\\"ButtonInput\\"}"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
];
function toolTurn(type: string, id: string): string[] {
  return TOOL_TURN.map(frame => frame
    .replace('"id":"t"', `"id":"${id}"`)
    .replace('ButtonInput', type));
}
function previewTurn(code: string, id = 'preview'): string[] {
  const encoded = JSON.stringify(JSON.stringify({ code }));
  return [
    `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"${id}","name":"preview_ec"}}\n\n`,
    `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":${encoded}}}\n\n`,
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ];
}
function multiToolTurn(count: number): string[] {
  const frames: string[] = [];
  for (let i = 0; i < count; i++) {
    frames.push(
      `event: content_block_start\ndata: {"type":"content_block_start","index":${i},"content_block":{"type":"tool_use","id":"t${i}","name":"read_type"}}\n\n`,
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":${i},"delta":{"type":"input_json_delta","partial_json":"{\\"type\\":\\"Type${i}\\"}"}}\n\n`,
      `event: content_block_stop\ndata: {"type":"content_block_stop","index":${i}}\n\n`,
    );
  }
  frames.push(
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  );
  return frames;
}
const TEXT_TURN = [
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Final"}}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
];
const OPENAI_TEXT_TURN = [
  'data: {"choices":[{"delta":{"content":"Final"}}]}\n\n',
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
  'data: [DONE]\n\n',
];
const CHANGE_TICKET = [
  '```crev-change',
  'summary: Rename the selected object',
  'target: [[object:1]]',
  'operation: update',
  'language: extended',
  '---',
  't.qa.change(name := "Open")',
  '```',
].join('\n');
const TABLE_CHANGE_TICKET = [
  '```crev-change',
  'summary: Use the live risk rows',
  'target: [[object:1]]',
  'operation: update',
  'language: extended',
  '---',
  `t.qa.change(expression := 'root.CeRiskAssessment.children.table(id, name)')`,
  '```',
].join('\n');
function openAiTextTurn(text: string): string[] {
  return [
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`,
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
  ];
}
function openAiTextTurnWithUsage(text: string): string[] {
  return [
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`,
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":123,"completion_tokens":45,"prompt_tokens_details":{"cached_tokens":20},"completion_tokens_details":{"reasoning_tokens":7}}}\n\n',
    'data: [DONE]\n\n',
  ];
}
function openAiSubmitTurn(input: Record<string, unknown>): string[] {
  return [
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'submit', type: 'function', function: { name: 'submit_change_ticket', arguments: JSON.stringify(input) } }] } }] })}\n\n`,
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
    'data: [DONE]\n\n',
  ];
}
function openAiToolTurn(name: string, input: Record<string, unknown>, id = 'tool'): string[] {
  return [
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(input) } }] } }] })}\n\n`,
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
    'data: [DONE]\n\n',
  ];
}
function anthropicTextTurn(text: string): string[] {
  return [
    `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}\n\n`,
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ];
}
const OPENAI_EMPTY_TURN = [
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
  'data: [DONE]\n\n',
];
const ANTHROPIC_EMPTY_TURN = [
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
];
const OPENAI_DSML_ONLY_TURN = [
  'data: {"choices":[{"delta":{"content":"<｜DSML｜tool_calls><｜DSML｜invoke name=\\"read_type\\"><｜DSML｜/invoke><｜DSML｜/tool_calls>"}}]}\n\n',
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
  'data: [DONE]\n\n',
];
const OPENAI_THINK_TURN = [
  'data: {"choices":[{"delta":{"content":"<think>private reasoning</think>Visible answer"}}]}\n\n',
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
  'data: [DONE]\n\n',
];
const ANTHROPIC_THINK_TURN = [
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"<think>private reasoning</think>Visible answer"}}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
];
const ANTHROPIC_NARRATED_TOOL_TURN = [
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"I will inspect before answering."}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  ...toolTurn('ButtonInput', 'narrated-tool').map(frame => frame.replace(/"index":0/g, '"index":1')),
];
const OPENAI_NARRATED_TOOL_TURN = [
  'data: {"choices":[{"delta":{"content":"I will inspect before answering.","tool_calls":[{"index":0,"id":"narrated-tool","type":"function","function":{"name":"read_type","arguments":"{\\"type\\":\\"ButtonInput\\"}"}}]}}]}\n\n',
  'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
  'data: [DONE]\n\n',
];

const settings: AiSettings = { provider: 'anthropic', model: 'claude-opus-4-8', apiKeyEnc: '' };

/** fetch mock: tool_use whenever tools are offered, text otherwise. */
function toolThenText() {
  let turn = 0;
  return vi.fn((_u: string, init: any) => {
    const body = JSON.parse(init.body);
    const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
    turn++;
    return Promise.resolve(okStream(hasTools ? toolTurn(`ButtonInput${turn}`, `t${turn}`) : TEXT_TURN));
  });
}

afterEach(() => { vi.restoreAllMocks(); });

import { CHANGE_PREVIEW_SATISFIED_NOTE, MAX_TOOL_CALLS, MAX_TOOL_ROUNDS, TOOL_BUDGET_EXHAUSTED_NOTE } from '../tools';

describe('streamChat tool loop', () => {
  it('applies the hard chat output cap to Anthropic', async () => {
    const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn((_u: string, init: any) => {
      bodies.push(JSON.parse(init.body));
      return Promise.resolve(okStream(TEXT_TURN));
    }));

    await streamChat({ settings, apiKey: 'k', system: 'S', history: [], text: 'go', onEvent: () => {}, executeTool: vi.fn() });

    expect(bodies[0].max_tokens).toBe(CHAT_MAX_OUTPUT_TOKENS);
  });

  it('applies the hard chat output cap with the provider-specific OpenAI field', async () => {
    const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn((_u: string, init: any) => {
      bodies.push(JSON.parse(init.body));
      return Promise.resolve(okStream(OPENAI_TEXT_TURN));
    }));
    const openAiSettings: AiSettings = { provider: 'openai', model: 'gpt-5.2', apiKeyEnc: '' };

    await streamChat({ settings: openAiSettings, apiKey: 'k', system: 'S', history: [], text: 'go', onEvent: () => {}, executeTool: vi.fn() });

    expect(bodies[0].max_completion_tokens).toBe(CHAT_MAX_OUTPUT_TOKENS);
    expect(bodies[0].max_tokens).toBeUndefined();
  });

  it('retries one empty OpenAI-compatible turn without rerunning tools', async () => {
    let turn = 0;
    const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn((_u: string, init: any) => {
      bodies.push(JSON.parse(init.body));
      turn++;
      return Promise.resolve(okStream(turn === 1 ? OPENAI_EMPTY_TURN : OPENAI_TEXT_TURN));
    }));
    const events: AiChatEvent[] = [];
    const openAiSettings: AiSettings = { provider: 'deepseek', model: 'deepseek-v4-flash', apiKeyEnc: '' };

    const metrics = await streamChat({
      settings: openAiSettings, apiKey: 'k', system: 'S', history: [], text: 'go',
      onEvent: event => events.push(event), executeTool: vi.fn(),
    });

    expect(bodies).toHaveLength(2);
    expect(JSON.stringify(bodies[1].messages)).toContain('previous response was malformed, truncated, or empty');
    expect(bodies[1].messages.filter((message: any) => message.role === 'assistant')).toHaveLength(0);
    expect(metrics?.modelRetries).toBe(1);
    expect(events).toContainEqual({ kind: 'text-delta', delta: 'Final' });
    expect(events.at(-1)).toEqual({ kind: 'done' });
  });

  it('recovers when two empty OpenAI-compatible turns are followed by an answer', async () => {
    let turn = 0;
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(okStream(turn++ < 2 ? OPENAI_EMPTY_TURN : OPENAI_TEXT_TURN))));
    const events: AiChatEvent[] = [];
    const openAiSettings: AiSettings = { provider: 'deepseek', model: 'deepseek-v4-flash', apiKeyEnc: '' };

    const metrics = await streamChat({
      settings: openAiSettings, apiKey: 'k', system: 'S', history: [], text: 'go',
      onEvent: event => events.push(event), executeTool: vi.fn(),
    });

    expect(metrics?.modelRetries).toBe(2);
    expect(events).toContainEqual({ kind: 'text-delta', delta: 'Final' });
  });

  it('applies the same bounded empty-response recovery to Anthropic', async () => {
    let turn = 0;
    const events: AiChatEvent[] = [];
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(okStream(
      turn++ === 0 ? ANTHROPIC_EMPTY_TURN : anthropicTextTurn('Recovered'),
    ))));

    const metrics = await streamChat({
      settings, apiKey: 'k', system: 'S', history: [], text: 'Explain this object.',
      onEvent: event => events.push(event), executeTool: vi.fn(),
    });

    expect(metrics?.modelRetries).toBe(1);
    expect(events).toContainEqual({ kind: 'text-delta', delta: 'Recovered' });
  });

  it('reports an error after the bounded empty-response retries', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(okStream(OPENAI_EMPTY_TURN))));
    const events: AiChatEvent[] = [];
    const openAiSettings: AiSettings = { provider: 'deepseek', model: 'deepseek-v4-flash', apiKeyEnc: '' };

    const metrics = await streamChat({
      settings: openAiSettings, apiKey: 'k', system: 'S', history: [], text: 'go',
      onEvent: event => events.push(event), executeTool: vi.fn(),
    });

    expect(metrics).toBeNull();
    expect(events.at(-1)).toEqual({
      kind: 'error',
      message: `The model returned no usable answer ${MAX_EMPTY_RESPONSE_RETRIES + 1} times. Try the request again.`,
    });
    expect(events.some(event => event.kind === 'done')).toBe(false);
  });

  it('automatically Previews the exact final Change Ticket without another model turn', async () => {
    const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn((_u: string, init: any) => {
      bodies.push(JSON.parse(init.body));
      return Promise.resolve(okStream(openAiTextTurn(CHANGE_TICKET)));
    }));
    const events: AiChatEvent[] = [];
    const openAiSettings: AiSettings = { provider: 'deepseek', model: 'deepseek-v4-flash', apiKeyEnc: '' };
    const executeTool = vi.fn(async (_call: ToolCall): Promise<ToolResult> => ({ content: 'EC preview OK', isError: false }));

    const metrics = await streamChat({
      settings: openAiSettings, apiKey: 'k', system: 'S', history: [], text: 'Change this object.',
      onEvent: event => events.push(event), executeTool,
    });

    expect(bodies).toHaveLength(1);
    expect(bodies[0].tools.map((tool: { function: { name: string } }) => tool.function.name)).toContain('submit_change_ticket');
    const submitTool = bodies[0].tools.find((tool: { function: { name: string } }) => tool.function.name === 'submit_change_ticket');
    expect(submitTool.function.parameters.properties.summary.description).toContain('under 140 characters');
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(executeTool).toHaveBeenCalledWith(expect.objectContaining({
      name: 'preview_ec', input: { code: 't.qa.change(name := "Open")' },
    }), undefined);
    expect(metrics).toMatchObject({ modelRetries: 0, automaticToolCalls: 1, toolCallsExecuted: 1 });
    expect(metrics?.tools).toEqual([expect.objectContaining({ name: 'preview_ec', origin: 'pipeline', ok: true })]);
    expect(events.filter(event => event.kind === 'text-delta')).toEqual([{ kind: 'text-delta', delta: CHANGE_TICKET }]);
  });

  it('recognizes and Previews a Change Ticket from a vague prompt without keyword classification', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(okStream(openAiTextTurn(CHANGE_TICKET)))));
    const events: AiChatEvent[] = [];
    const executeTool = vi.fn(async (): Promise<ToolResult> => ({ content: 'EC preview OK', isError: false }));

    const metrics = await streamChat({
      settings: { provider: 'deepseek', model: 'deepseek-v4-flash', apiKeyEnc: '' },
      apiKey: 'k', system: 'S', history: [], text: 'I want this different.',
      onEvent: event => events.push(event), executeTool,
    });

    expect(executeTool).toHaveBeenCalledWith(expect.objectContaining({ name: 'preview_ec' }), undefined);
    expect(metrics).toMatchObject({ automaticToolCalls: 1 });
    expect(events).toContainEqual({ kind: 'text-delta', delta: CHANGE_TICKET });
  });

  it('hands the production final Preview capability directly to the Change Ticket card', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(okStream(openAiTextTurn(CHANGE_TICKET)))));
    const events: AiChatEvent[] = [];
    const executeTool = vi.fn();
    const executeChangePreview = vi.fn(async (): Promise<ToolResult & { previewId: string }> => ({
      content: '1 change', isError: false, previewId: 'preview-1',
    }));
    const openAiSettings: AiSettings = { provider: 'deepseek', model: 'deepseek-v4-flash', apiKeyEnc: '' };

    await streamChat({
      settings: openAiSettings, apiKey: 'k', system: 'S', history: [], text: 'Change this object.',
      onEvent: event => events.push(event), executeTool, executeChangePreview,
    });

    expect(executeTool).not.toHaveBeenCalled();
    expect(executeChangePreview).toHaveBeenCalledWith({
      code: 't.qa.change(name := "Open")', targetRid: '1',
    }, undefined);
    expect(events).toContainEqual({
      kind: 'change-preview-ready',
      code: 't.qa.change(name := "Open")',
      resultText: '1 change',
      previewId: 'preview-1',
    });
  });

  it('accepts useful ordinary text without forcing a response-mode retry', async () => {
    const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn((_u: string, init: any) => {
      bodies.push(JSON.parse(init.body));
      if (bodies.length === 1) return Promise.resolve(okStream(openAiTextTurn('not a ticket')));
      return Promise.resolve(okStream(openAiSubmitTurn({
        summary: 'Rename the selected object', target: '[[object:1]]', operation: 'update',
        code: 't.qa.change(name := "Open")',
      })));
    }));
    const events: AiChatEvent[] = [];
    const executeTool = vi.fn(async (_call: ToolCall): Promise<ToolResult> => ({ content: 'Preview succeeded', isError: false }));
    const openAiSettings: AiSettings = { provider: 'deepseek', model: 'deepseek-v4-flash', apiKeyEnc: '' };

    await streamChat({
      settings: openAiSettings, apiKey: 'k', system: 'S', history: [], text: 'Rename this object.',
      onEvent: event => events.push(event), executeTool,
    });

    expect(bodies).toHaveLength(1);
    expect(Array.isArray(bodies[0].tools)).toBe(true);
    expect(executeTool).not.toHaveBeenCalled();
    expect(events).toContainEqual({ kind: 'text-delta', delta: 'not a ticket' });
  });

  it('performs one Preview repair then preserves the final failed Change Ticket card', async () => {
    const repaired = {
      summary: 'Rename the selected object with the repaired field', target: '[[object:1]]', operation: 'update',
      code: 't.qa.change(name := "Closed")',
    };
    const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn((_u: string, init: any) => {
      bodies.push(JSON.parse(init.body));
      return Promise.resolve(okStream(bodies.length === 1
        ? openAiSubmitTurn({
          summary: 'Rename the selected object', target: '[[object:1]]', operation: 'update',
          code: 't.qa.change(name := "Open")',
        })
        : openAiSubmitTurn(repaired)));
    }));
    const events: AiChatEvent[] = [];
    const openAiSettings: AiSettings = { provider: 'deepseek', model: 'deepseek-v4-flash', apiKeyEnc: '' };
    const executeTool = vi.fn(async (): Promise<ToolResult> => ({ content: 'line 1: unknown property name', isError: true }));

    const metrics = await streamChat({
      settings: openAiSettings, apiKey: 'k', system: 'S', history: [], text: 'Change this object.',
      onEvent: event => events.push(event), executeTool,
    });

    expect(metrics).toMatchObject({
      providerRequests: 2,
      modelRetries: 1,
      previewRepairRetries: 1,
      automaticToolCalls: 2,
      toolErrors: 2,
    });
    expect(bodies).toHaveLength(MAX_MISSING_PREVIEW_RETRIES + 1);
    expect(executeTool).toHaveBeenCalledTimes(MAX_MISSING_PREVIEW_RETRIES + 1);
    expect(JSON.stringify(bodies[1].messages)).toContain('unknown property name');
    expect(events).toContainEqual({
      kind: 'change-preview-failed',
      code: repaired.code,
      resultText: 'line 1: unknown property name',
    });
    expect(events).toContainEqual({ kind: 'text-delta', delta: expect.stringContaining(repaired.code) });
    expect(events.at(-1)).toEqual({ kind: 'done' });
  });

  it('treats a structured terminal submission as the final provider action', async () => {
    const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn((_u: string, init: any) => {
      bodies.push(JSON.parse(init.body));
      return Promise.resolve(okStream(openAiSubmitTurn({
        summary: 'Rename the selected object', target: '[[object:1]]', operation: 'update',
        code: 't.qa.change(name := "Open")',
      })));
    }));
    const events: AiChatEvent[] = [];
    const executeTool = vi.fn(async (): Promise<ToolResult> => ({ content: 'Preview succeeded', isError: false }));

    await streamChat({
      settings: { provider: 'deepseek', model: 'deepseek-v4-flash', apiKeyEnc: '' }, apiKey: 'k', system: 'S', history: [],
      text: 'Rename this object.', onEvent: event => events.push(event), executeTool,
    });

    expect(bodies).toHaveLength(1);
    expect(bodies[0].tools.map((tool: any) => tool.function.name)).toContain('submit_change_ticket');
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual({ kind: 'text-delta', delta: CHANGE_TICKET });
  });

  it('records provider token usage and timing on a completed chat turn', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(okStream(openAiTextTurnWithUsage('Final')))));

    const metrics = await streamChat({
      settings: { provider: 'openai', model: 'gpt-5.2', apiKeyEnc: '' }, apiKey: 'k', system: 'S', history: [],
      text: 'Explain this setting.', onEvent: () => {}, executeTool: vi.fn(),
    });

    expect(metrics).toMatchObject({
      providerRequests: 1,
      inputTokens: 123,
      cachedInputTokens: 20,
      outputTokens: 45,
      reasoningTokens: 7,
    });
    expect(metrics?.durationMs).toBeGreaterThanOrEqual(0);
    expect(metrics?.providerDurationMs).toBeGreaterThanOrEqual(0);
  });

  it('leaves table implementation quality to Preview and evaluation instead of a keyword gate', async () => {
    const wrong = CHANGE_TICKET
      .replace('Rename the selected object', 'Add a risk table')
      .replace('operation: update', 'operation: create')
      .replace('t.qa.change(name := "Open")', '_page.add(CustomVisualization, name := "Risk table")');
    const corrected = wrong.replace('CustomVisualization', 'ExtendedTable');
    let turn = 0;
    const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn((_u: string, init: any) => {
      bodies.push(JSON.parse(init.body));
      return Promise.resolve(okStream(openAiTextTurn(turn++ === 0 ? wrong : corrected)));
    }));
    const executeTool = vi.fn(async (_call: ToolCall): Promise<ToolResult> => ({ content: 'Preview succeeded', isError: false }));
    const openAiSettings: AiSettings = { provider: 'deepseek', model: 'deepseek-v4-flash', apiKeyEnc: '' };

    await streamChat({
      settings: openAiSettings, apiKey: 'k', system: 'S', history: [], text: 'Add a risk table here.',
      onEvent: () => {}, executeTool,
    });

    expect(bodies).toHaveLength(1);
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(executeTool.mock.calls[0]![0].input.code).toContain('CustomVisualization');
  });

  it('passes discovered collection guidance to the model without hard-rejecting a different expression', async () => {
    const wrong = TABLE_CHANGE_TICKET.replace('root.CeRiskAssessment.children', '_page.descendants()');
    const corrected = {
      summary: 'Use the live risk rows',
      target: '[[object:1]]',
      operation: 'update',
      code: 't.qa.change(expression := \'root.CeRiskAssessment.children.table(id, name)\')',
    };
    let turn = 0;
    const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn((_u: string, init: any) => {
      bodies.push(JSON.parse(init.body));
      return Promise.resolve(okStream(turn++ === 0 ? openAiTextTurn(wrong) : openAiSubmitTurn(corrected)));
    }));
    const executeTool = vi.fn(async (): Promise<ToolResult> => ({ content: 'Preview succeeded', isError: false }));
    const openAiSettings: AiSettings = { provider: 'deepseek', model: 'deepseek-v4-flash', apiKeyEnc: '' };

    await streamChat({
      settings: openAiSettings,
      apiKey: 'k',
      system: 'CeRiskAssessment live schema: collection root.CeRiskAssessment.children;',
      history: [],
      text: 'Change this table to show the live risks.',
      onEvent: () => {},
      executeTool,
    });

    expect(bodies).toHaveLength(1);
    expect(executeTool).toHaveBeenCalledTimes(1);
  });

  it('binds the final ticket to read_layout target evidence before Preview', async () => {
    const wrong = CHANGE_TICKET
      .replace('Rename the selected object', 'Add a reviewer note. This affects the shared template, not the viewed instance.')
      .replace('operation: update', 'operation: create')
      .replace('t.qa.change(name := "Open")', '_page.add(TextElement, id := "qa_note", text := "<p>Review.</p>")');
    const corrected = {
      summary: 'Add a reviewer note. This affects the shared template, not the viewed instance.',
      target: '[[object:111]]',
      operation: 'create',
      code: 't.landing_template.add(TextElement, id := "qa_note", text := "<p>Review.</p>", container := t.landing_content)',
    };
    const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn((_u: string, init: any) => {
      bodies.push(JSON.parse(init.body));
      const response = bodies.length === 1
        ? openAiToolTurn('read_layout', { pageRid: '222' }, 'layout')
        : bodies.length === 2
          ? openAiTextTurn(wrong.replace('[[object:1]]', '[[object:111]]'))
          : openAiSubmitTurn(corrected);
      return Promise.resolve(okStream(response));
    }));
    const executeTool = vi.fn(async (call: ToolCall): Promise<ToolResult> => {
      if (call.name === 'read_layout') return layoutToolResult({ placementRef: 't.landing_content' });
      if (String(call.input.code).startsWith('_page.')) {
        return { content: 'Use the verified mutation reference t.landing_template', isError: true };
      }
      return { content: 'Preview succeeded', isError: false };
    });
    const openAiSettings: AiSettings = { provider: 'deepseek', model: 'deepseek-v4-flash', apiKeyEnc: '' };

    await streamChat({
      settings: openAiSettings,
      apiKey: 'k',
      system: 'S',
      history: [],
      text: 'Add a reviewer note here.',
      onEvent: () => {},
      executeTool,
    });

    expect(bodies).toHaveLength(3);
    expect(JSON.stringify(bodies[2].tools)).toContain('[[object:111]] => t.landing_template');
    expect(JSON.stringify(bodies[2].tools)).toContain('container := t.landing_content');
    expect(JSON.stringify(bodies[2].tools)).not.toContain('t.landing_content..');
    expect(executeTool.mock.calls.filter(([call]) => call.name === 'preview_ec')).toHaveLength(2);
    expect(executeTool.mock.calls.at(-1)?.[0].input.code).toContain('t.landing_template.add');
  });

  it('replaces an unsolicited instance-override offer with a concise scope fact', async () => {
    const noisy = {
      summary: 'Add a reviewer note to the shared template. An instance-level override is available on request.',
      target: '[[object:111]]',
      operation: 'create',
      code: 't.landing_template.add(TextElement, id := "qa_note", text := "<p>Review.</p>", container := t.landing_content)',
    };
    const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn((_u: string, init: any) => {
      bodies.push(JSON.parse(init.body));
      const response = bodies.length === 1
        ? openAiToolTurn('read_layout', { pageRid: '222' }, 'layout')
        : openAiSubmitTurn(noisy);
      return Promise.resolve(okStream(response));
    }));
    const executeTool = vi.fn(async (call: ToolCall): Promise<ToolResult> => call.name === 'read_layout'
      ? layoutToolResult({ placementRef: 't.landing_content' })
      : { content: 'Preview succeeded', isError: false });

    await streamChat({
      settings: { provider: 'deepseek', model: 'deepseek-v4-flash', apiKeyEnc: '' },
      apiKey: 'k',
      system: 'S',
      history: [],
      text: 'Add a reviewer note here.',
      onEvent: () => {},
      executeTool,
    });

    expect(JSON.stringify(bodies.at(-1)?.tools)).toContain('offer an instance override unless the user asks');
    expect(executeTool.mock.calls.filter(([call]) => call.name === 'preview_ec')).toHaveLength(1);
  });

  it('keeps direct-page summary guidance tied to the selected target when the layout also contains shared widgets', async () => {
    const wrong = {
      summary: 'Add a reviewer note to the page-owner Scorecard.',
      target: '[[object:777]]',
      operation: 'create',
      code: 't.qa_direct_page.add(TextElement, id := "qa_note", text := "<p>Review.</p>", container := t.qa_content)',
    };
    const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn((_u: string, init: any) => {
      bodies.push(JSON.parse(init.body));
      const response = bodies.length === 1
        ? openAiToolTurn('read_layout', { pageRid: '777' }, 'layout')
        : openAiSubmitTurn(wrong);
      return Promise.resolve(okStream(response));
    }));
    const executeTool = vi.fn(async (call: ToolCall): Promise<ToolResult> => call.name === 'read_layout'
      ? layoutToolResult({
        targetRid: '777',
        targetRef: 't.qa_direct_page',
        placementRef: 't.qa_content',
        scope: 'direct-page',
        includeSharedWidget: true,
      })
      : { content: 'Preview succeeded', isError: false });

    await streamChat({
      settings: { provider: 'deepseek', model: 'deepseek-v4-flash', apiKeyEnc: '' },
      apiKey: 'k',
      system: 'S',
      history: [],
      text: 'Add a reviewer note here.',
      onEvent: () => {},
      executeTool,
    });

    const submitBody = bodies.at(-1);
    const submitSchema = JSON.stringify(submitBody?.tools);
    expect(submitSchema).toContain('[[object:777]] => scope=direct-page');
    expect(submitSchema).toContain('[[object:818]] => scope=shared-template');
    expect(submitSchema).toContain('If the selected target has scope=shared-template');
    expect(submitSchema).toContain('naturally mentions both the template and the viewed/specific instance');
    expect(submitSchema).toContain('Do not echo internal routing labels such as direct page owner, page-owner');
    expect(executeTool.mock.calls.filter(([call]) => call.name === 'preview_ec')).toHaveLength(1);
  });

  it('automatically Previews Anthropic Change Tickets too', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(okStream(anthropicTextTurn(CHANGE_TICKET)))));
    const events: AiChatEvent[] = [];
    const executeTool = vi.fn(async (): Promise<ToolResult> => ({ content: 'EC preview OK', isError: false }));

    const metrics = await streamChat({
      settings, apiKey: 'k', system: 'S', history: [], text: 'Change this object.',
      onEvent: event => events.push(event), executeTool,
    });

    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(metrics).toMatchObject({ automaticToolCalls: 1, toolCallsExecuted: 1 });
    expect(events.filter(event => event.kind === 'text-delta')).toEqual([{ kind: 'text-delta', delta: CHANGE_TICKET }]);
  });

  it('retries when OpenAI-compatible raw text contains only scrubbed tool markup', async () => {
    let turn = 0;
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(okStream(turn++ === 0 ? OPENAI_DSML_ONLY_TURN : OPENAI_TEXT_TURN))));
    const events: AiChatEvent[] = [];
    const openAiSettings: AiSettings = { provider: 'deepseek', model: 'deepseek-v4-flash', apiKeyEnc: '' };

    const metrics = await streamChat({
      settings: openAiSettings, apiKey: 'k', system: 'S', history: [], text: 'go',
      onEvent: event => events.push(event), executeTool: vi.fn(),
    });

    expect(metrics?.modelRetries).toBe(1);
    expect(events.filter(event => event.kind === 'text-delta')).toEqual([{ kind: 'text-delta', delta: 'Final' }]);
    expect(JSON.stringify(events)).not.toContain('DSML');
  });

  it('does not emit Anthropic narration from an intermediate tool turn', async () => {
    let round = 0;
    vi.stubGlobal('fetch', vi.fn((_u: string, init: any) => {
      const hasTools = Array.isArray(JSON.parse(init.body).tools) && JSON.parse(init.body).tools.length > 0;
      return Promise.resolve(okStream(hasTools && round++ === 0 ? ANTHROPIC_NARRATED_TOOL_TURN : TEXT_TURN));
    }));
    const events: AiChatEvent[] = [];

    await streamChat({ settings, apiKey: 'k', system: 'S', history: [], text: 'go', onEvent: event => events.push(event), executeTool: vi.fn(async () => ({ content: 'ok', isError: false })) });

    expect(events.filter(event => event.kind === 'text-delta')).toEqual([{ kind: 'text-delta', delta: 'Final' }]);
    expect(JSON.stringify(events)).not.toContain('I will inspect');
  });

  it('does not emit OpenAI-compatible narration from an intermediate tool turn', async () => {
    let round = 0;
    const bodies: any[] = [];
    const openAiSettings: AiSettings = { provider: 'deepseek', model: 'deepseek-v4-flash', apiKeyEnc: '' };
    vi.stubGlobal('fetch', vi.fn((_u: string, init: any) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
      return Promise.resolve(okStream(hasTools && round++ === 0 ? OPENAI_NARRATED_TOOL_TURN : OPENAI_TEXT_TURN));
    }));
    const events: AiChatEvent[] = [];

    await streamChat({ settings: openAiSettings, apiKey: 'k', system: 'S', history: [], text: 'go', onEvent: event => events.push(event), executeTool: vi.fn(async () => ({ content: 'ok', isError: false })) });

    expect(events.filter(event => event.kind === 'text-delta')).toEqual([{ kind: 'text-delta', delta: 'Final' }]);
    expect(JSON.stringify(events)).not.toContain('I will inspect');
    expect(bodies[0].parallel_tool_calls).toBe(false);
  });

  it.each([
    ['Anthropic', settings, ANTHROPIC_THINK_TURN],
    ['OpenAI-compatible', { provider: 'deepseek', model: 'deepseek-v4-flash', apiKeyEnc: '' } as AiSettings, OPENAI_THINK_TURN],
  ])('strips final %s reasoning while retaining the answer', async (_dialect, dialectSettings, finalTurn) => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(okStream(finalTurn))));
    const events: AiChatEvent[] = [];

    await streamChat({ settings: dialectSettings, apiKey: 'k', system: 'S', history: [], text: 'go', onEvent: event => events.push(event), executeTool: vi.fn() });

    expect(events).toContainEqual({ kind: 'text-delta', delta: 'Visible answer' });
    expect(JSON.stringify(events)).not.toContain('think');
    expect(JSON.stringify(events)).not.toContain('private reasoning');
  });

  it.each([
    ['Anthropic', settings, TEXT_TURN],
    ['OpenAI-compatible', { provider: 'deepseek', model: 'deepseek-v4-flash', apiKeyEnc: '' } as AiSettings, OPENAI_TEXT_TURN],
  ])('emits a clean final %s answer unchanged', async (_dialect, dialectSettings, finalTurn) => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(okStream(finalTurn))));
    const events: AiChatEvent[] = [];

    await streamChat({ settings: dialectSettings, apiKey: 'k', system: 'S', history: [], text: 'go', onEvent: event => events.push(event), executeTool: vi.fn() });

    expect(events).toContainEqual({ kind: 'text-delta', delta: 'Final' });
  });

  it('keeps a custom model limit when it is below the chat ceiling', async () => {
    const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn((_u: string, init: any) => {
      bodies.push(JSON.parse(init.body));
      return Promise.resolve(okStream(OPENAI_TEXT_TURN));
    }));
    const customSettings: AiSettings = {
      provider: 'custom', model: 'small', apiKeyEnc: '',
      customProvider: {
        name: 'Custom', vendor: 'Vendor', apiType: 'openai',
        models: [{ id: 'small', name: 'Small', url: 'https://ai.example.test/v1', toolCalling: true, maxOutputTokens: 768, maxTokensParam: 'max_tokens' }],
      },
    };

    await streamChat({ settings: customSettings, apiKey: 'k', system: 'S', history: [], text: 'go', onEvent: () => {}, executeTool: vi.fn() });

    expect(bodies[0].max_tokens).toBe(768);
  });

  it('caps serial plans at MAX_TOOL_ROUNDS, then forces a tools-off final answer', async () => {
    vi.stubGlobal('fetch', toolThenText());
    const events: AiChatEvent[] = [];
    let toolCount = 0;
    const executeTool = vi.fn(async (): Promise<ToolResult> => {
      toolCount++;
      return { content: `distinct evidence ${toolCount}`, isError: false };
    });

    await streamChat({ settings, apiKey: 'k', system: 'S', history: [], text: 'go', onEvent: e => events.push(e), executeTool });

    expect(toolCount).toBe(MAX_TOOL_ROUNDS);
    expect(events.filter(e => e.kind === 'tool-start')).toHaveLength(MAX_TOOL_ROUNDS);
    expect(events.filter(e => e.kind === 'tool-end')).toHaveLength(MAX_TOOL_ROUNDS);
    expect(events.at(-1)).toEqual({ kind: 'done' });
    // The forced final turn streamed text.
    expect(events.some(e => e.kind === 'text-delta' && e.delta === 'Final')).toBe(true);
  });

  it('appends the tool-budget note on the forced final turn (and only then)', async () => {
    let turn = 0;
    const bodies: any[] = [];
    const fetchMock = vi.fn((_u: string, init: any) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
      turn++;
      return Promise.resolve(okStream(hasTools ? toolTurn(`ButtonInput${turn}`, `t${turn}`) : TEXT_TURN));
    });
    vi.stubGlobal('fetch', fetchMock);
    const executeTool = vi.fn(async (): Promise<ToolResult> => ({ content: 'ok', isError: false }));
    await streamChat({ settings, apiKey: 'k', system: 'S', history: [], text: 'go', onEvent: () => {}, executeTool });

    // The last request is the forced tools-off turn: no tools, and the note is
    // present in its message array (folded into the last user turn for Anthropic).
    const final = bodies.at(-1);
    expect(final.tools).toBeUndefined();
    const flat = JSON.stringify(final.messages);
    expect(flat).toContain(TOOL_BUDGET_EXHAUSTED_NOTE);
    // Tool-bearing turns before the cap must NOT carry the note.
    const withTools = bodies.filter(b => Array.isArray(b.tools) && b.tools.length > 0);
    for (const b of withTools) expect(JSON.stringify(b.messages)).not.toContain(TOOL_BUDGET_EXHAUSTED_NOTE);
  });

  it('lets the model end a simple find while keeping the catalog available', async () => {
    const searchTurn = [
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"find","name":"search_objects"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"query\\":\\"Risk Register\\"}"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ];
    const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn((_u: string, init: any) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      return Promise.resolve(okStream(bodies.length === 1 ? searchTurn : TEXT_TURN));
    }));
    const executeTool = vi.fn(async (): Promise<ToolResult> => ({ content: '[[object:7011]]', isError: false }));

    const metrics = await streamChat({
      settings, apiKey: 'k', system: 'S', history: [], text: 'Find the Risk Register.',
      onEvent: () => {}, executeTool,
    });

    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(bodies).toHaveLength(2);
    expect(Array.isArray(bodies[1].tools)).toBe(true);
    expect(metrics).toMatchObject({ toolCallsExecuted: 1, budgetExhausted: false });
  });

  it('keeps read_layout and follow-up tools available after a complete result', async () => {
    const layoutTurn = [
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"layout","name":"read_layout"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"pageRid\\":1}"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ];
    const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn((_u: string, init: any) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      return Promise.resolve(okStream(bodies.length === 1 ? layoutTurn : TEXT_TURN));
    }));
    const executeTool = vi.fn(async (): Promise<ToolResult> => layoutToolResult());

    await streamChat({ settings, apiKey: 'k', system: 'S', history: [], text: 'Add an open-risks table here.', onEvent: () => {}, executeTool });

    expect(executeTool).toHaveBeenCalledWith(expect.objectContaining({ input: { pageRid: '1' } }), undefined);
    expect(bodies[1].tools.map((tool: any) => tool.name)).toEqual(expect.arrayContaining(['read_layout', 'read_type', 'read_code']));
  });

  it('lets the model finalize a placement change after layout resolves the target', async () => {
    const layoutTurn = [
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"layout","name":"read_layout"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"pageRid\\":\\"1\\"}"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ];
    const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn((_u: string, init: any) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      return Promise.resolve(okStream(bodies.length === 1 ? layoutTurn : anthropicTextTurn(CHANGE_TICKET)));
    }));
    const executeTool = vi.fn(async (): Promise<ToolResult> => layoutToolResult({
      targetRid: '1',
      targetRef: 't.qa',
      scope: 'direct-page',
      placementRef: 't.landing_content',
    }));

    await streamChat({
      settings, apiKey: 'k', system: 'S', history: [], text: 'Add a reviewer note here.',
      onEvent: () => {}, executeTool,
    });

    expect(bodies).toHaveLength(2);
    expect(Array.isArray(bodies[1].tools)).toBe(true);
    expect(JSON.stringify(bodies[1].messages)).not.toContain('enough verified layout evidence');
  });

  it('keeps property discovery and current-value tools available after a matched accessor', async () => {
    const propertyTurn = [
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"type","name":"read_type"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"type\\":\\"CeRiskAssessment\\",\\"query\\":\\"detail card\\"}"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ];
    const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn((_u: string, init: any) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      return Promise.resolve(okStream(bodies.length === 1 ? propertyTurn : TEXT_TURN));
    }));
    const executeTool = vi.fn(async (): Promise<ToolResult> => referenceTypeResult());

    await streamChat({
      settings, apiKey: 'k', system: 'S', history: [], text: 'Change the detail card back to Default card.',
      onEvent: () => {}, executeTool,
    });

    const remaining = bodies[1].tools.map((tool: any) => tool.name);
    expect(remaining).toEqual(expect.arrayContaining(['read_type', 'read_object', 'search_objects']));
    expect(bodies[1].tool_choice).toEqual({ type: 'auto', disable_parallel_tool_use: true });
  });

  it('ends discovery after a state-changing Preview but still Previews the final exact ticket', async () => {
    const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn((_u: string, init: any) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      const toolNames = Array.isArray(body.tools) ? body.tools.map((tool: any) => tool.name) : [];
      return Promise.resolve(okStream(toolNames.includes('preview_ec')
        ? previewTurn('t.qa_table.change(disableSearch := TRUE)')
        : anthropicTextTurn(CHANGE_TICKET)));
    }));
    const executeTool = vi.fn(async (): Promise<ToolResult> => ({ content: 'EC preview OK', isError: false }));

    const metrics = await streamChat({
      settings, apiKey: 'k', system: 'S', history: [], text: 'Change this table.',
      onEvent: () => {}, executeTool,
    });

    expect(executeTool).toHaveBeenCalledTimes(2);
    expect(bodies).toHaveLength(2);
    expect(bodies[1].tools).toBeUndefined();
    expect(JSON.stringify(bodies[1].messages)).toContain(CHANGE_PREVIEW_SATISFIED_NOTE);
    expect(metrics).toMatchObject({ toolCallsExecuted: 2, automaticToolCalls: 1, budgetExhausted: false });
  });

  it('keeps terminal submission available while the pipeline validates the final table ticket', async () => {
    const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn((_u: string, init: any) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      return Promise.resolve(okStream(anthropicTextTurn(TABLE_CHANGE_TICKET)));
    }));
    const executeTool = vi.fn(async (): Promise<ToolResult> => ({ content: 'EC preview OK', isError: false }));

    await streamChat({
      settings, apiKey: 'k', system: 'S', history: [], text: 'Change this table expression.',
      onEvent: () => {}, executeTool,
    });

    expect(bodies).toHaveLength(1);
    expect((bodies[0].tools ?? []).map((tool: { name: string }) => tool.name)).toContain('submit_change_ticket');
    expect(executeTool).toHaveBeenCalledTimes(1);
  });

  it('automatically Previews the exact final table ticket', async () => {
    const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn((_u: string, init: any) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      return Promise.resolve(okStream(anthropicTextTurn(TABLE_CHANGE_TICKET)));
    }));
    const executeTool = vi.fn(async (_call: ToolCall): Promise<ToolResult> => ({ content: 'EC preview OK', isError: false }));

    const metrics = await streamChat({
      settings, apiKey: 'k', system: 'S', history: [], text: 'Change this table expression.',
      onEvent: () => {}, executeTool,
    });

    expect(bodies).toHaveLength(1);
    expect((bodies[0].tools ?? []).map((tool: { name: string }) => tool.name)).toContain('submit_change_ticket');
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(executeTool.mock.calls[0][0].input.code).toContain(`t.qa.change(expression := 'root.CeRiskAssessment`);
    expect(metrics).toMatchObject({ modelRetries: 0, toolCallsExecuted: 1, automaticToolCalls: 1 });
  });

  it('never executes more than the budget when one provider turn requests a large batch', async () => {
    vi.stubGlobal('fetch', vi.fn((_u: string, init: any) => {
      const body = JSON.parse(init.body);
      const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
      return Promise.resolve(okStream(hasTools ? multiToolTurn(MAX_TOOL_CALLS + 3) : TEXT_TURN));
    }));
    const executeTool = vi.fn(async (): Promise<ToolResult> => ({ content: 'ok', isError: false }));

    await streamChat({ settings, apiKey: 'k', system: 'S', history: [], text: 'go', onEvent: () => {}, executeTool });

    expect(executeTool).toHaveBeenCalledTimes(MAX_TOOL_CALLS);
  });

  it('stops immediately when the model answers with no tools', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(okStream(TEXT_TURN))));
    const events: AiChatEvent[] = [];
    const executeTool = vi.fn(async (): Promise<ToolResult> => ({ content: 'ok', isError: false }));
    await streamChat({ settings, apiKey: 'k', system: 'S', history: [], text: 'go', onEvent: e => events.push(e), executeTool });
    expect(executeTool).not.toHaveBeenCalled();
    expect(events.at(-1)).toEqual({ kind: 'done' });
  });

  it('executes identical backend calls but stops a stagnant loop early', async () => {
    vi.stubGlobal('fetch', vi.fn((_u: string, init: any) => {
      const body = JSON.parse(init.body);
      const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
      return Promise.resolve(okStream(hasTools ? TOOL_TURN : TEXT_TURN));
    }));
    const events: AiChatEvent[] = [];
    const executeTool = vi.fn(async (): Promise<ToolResult> => ({ content: 'same result', isError: false }));

    const metrics = await streamChat({ settings, apiKey: 'k', system: 'S', history: [], text: 'go', onEvent: e => events.push(e), executeTool });

    expect(executeTool).toHaveBeenCalledTimes(3);
    expect(events.filter(e => e.kind === 'tool-start')).toHaveLength(3);
    expect(events.filter(e => e.kind === 'tool-end')).toHaveLength(3);
    expect(events.at(-1)).toEqual({ kind: 'done' });
    expect(metrics).toMatchObject({
      limitReason: 'stagnation',
      tools: [
        { name: 'read_type', ok: true, duplicate: false },
        { name: 'read_type', ok: true, duplicate: true },
        { name: 'read_type', ok: true, duplicate: true },
      ],
    });
  });

  it('resets stagnation after a new successful result, then cuts off only after two later duplicate rounds', async () => {
    let turn = 0;
    vi.stubGlobal('fetch', vi.fn((_u: string, init: any) => {
      const hasTools = Array.isArray(JSON.parse(init.body).tools) && JSON.parse(init.body).tools.length > 0;
      if (!hasTools) return Promise.resolve(okStream(TEXT_TURN));
      turn++;
      const type = turn < 3 ? 'ButtonInput' : 'Scorecard';
      return Promise.resolve(okStream(toolTurn(type, `t${turn}`)));
    }));
    const executeTool = vi.fn(async (call: { input: Record<string, unknown> }): Promise<ToolResult> => ({
      content: String(call.input.type),
      isError: false,
    }));

    const metrics = await streamChat({ settings, apiKey: 'k', system: 'S', history: [], text: 'go', onEvent: () => {}, executeTool });

    expect(executeTool).toHaveBeenCalledTimes(5);
    expect(metrics).toMatchObject({
      toolRounds: 5,
      toolCallsExecuted: 5,
      duplicateCalls: 3,
      limitReason: 'stagnation',
      tools: [
        { name: 'read_type', duplicate: false },
        { name: 'read_type', duplicate: true },
        { name: 'read_type', duplicate: false },
        { name: 'read_type', duplicate: true },
        { name: 'read_type', duplicate: true },
      ],
    });
  });

  it('records unchanged repeated calls and lets them consume the normal tool budget', async () => {
    let turn = 0;
    vi.stubGlobal('fetch', vi.fn((_u: string, init: any) => {
      const hasTools = Array.isArray(JSON.parse(init.body).tools);
      if (!hasTools) return Promise.resolve(okStream(TEXT_TURN));
      turn++;
      if (turn === 1) return Promise.resolve(okStream(
        multiToolTurn(MAX_TOOL_CALLS).map(frame => frame.replace(/Type\d+/g, 'ButtonInput')),
      ));
      if (turn === 2) return Promise.resolve(okStream(toolTurn('Scorecard', 'distinct')));
      return Promise.resolve(okStream(TEXT_TURN));
    }));
    const executeTool = vi.fn(async (): Promise<ToolResult> => ({ content: 'ok', isError: false }));

    const metrics = await streamChat({ settings, apiKey: 'k', system: 'S', history: [], text: 'go', onEvent: () => {}, executeTool });

    expect(executeTool).toHaveBeenCalledTimes(MAX_TOOL_CALLS);
    expect(metrics).toMatchObject({
      toolRounds: 1,
      toolCallsRequested: MAX_TOOL_CALLS,
      toolCallsExecuted: MAX_TOOL_CALLS,
      duplicateCalls: MAX_TOOL_CALLS - 1,
      toolErrors: 0,
      budgetExhausted: true,
      limitReason: 'calls',
    });
  });

  it('cancels mid-loop: aborting during a tool halts the loop with no done event', async () => {
    vi.stubGlobal('fetch', toolThenText());
    const controller = new AbortController();
    const events: AiChatEvent[] = [];
    let toolCount = 0;
    const executeTool = vi.fn(async (): Promise<ToolResult> => {
      toolCount++;
      controller.abort(); // cancel after the first tool runs
      return { content: 'ok', isError: false };
    });

    await streamChat({ settings, apiKey: 'k', system: 'S', history: [], text: 'go', onEvent: e => events.push(e), executeTool, signal: controller.signal });

    expect(toolCount).toBe(1);
    expect(events.some(e => e.kind === 'done')).toBe(false);
    expect(events.some(e => e.kind === 'error')).toBe(false);
  });

  it('surfaces a provider failure as an error event', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, status: 500, text: () => Promise.resolve('boom') })));
    const events: AiChatEvent[] = [];
    const executeTool = vi.fn(async (): Promise<ToolResult> => ({ content: 'ok', isError: false }));
    await streamChat({ settings, apiKey: 'k', system: 'S', history: [], text: 'go', onEvent: e => events.push(e), executeTool });
    expect(events.some(e => e.kind === 'error')).toBe(true);
    expect(events.some(e => e.kind === 'done')).toBe(false);
  });
});
