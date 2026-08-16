import { afterEach, describe, expect, it, vi } from 'vitest';
import { prefetchSimpleWidgetChange } from '../simple-change-prefetch';
import { streamChat } from '../client';
import type { ToolCall, ToolResult } from '../tools';
import { toolSuccess } from '../tool-results';
import type { AiChatEvent, AiSettings } from '../types';

afterEach(() => vi.unstubAllGlobals());

function streamBody(parts: string[]) {
  let index = 0;
  const encoder = new TextEncoder();
  return {
    getReader: () => ({
      read: () => Promise.resolve(index < parts.length
        ? { value: encoder.encode(parts[index++]), done: false }
        : { value: undefined, done: true }),
    }),
  };
}

function openAiStream(parts: string[]): any {
  return { ok: true, status: 200, body: streamBody(parts) };
}

function submitTurn(input: Record<string, unknown>): string[] {
  return [
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'submit', type: 'function', function: { name: 'submit_change_ticket', arguments: JSON.stringify(input) } }] } }] })}\n\n`,
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
    'data: [DONE]\n\n',
  ];
}

function answerTurn(answer: string): string[] {
  return [
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'answer', type: 'function', function: { name: 'answer_user', arguments: JSON.stringify({ answer }) } }] } }] })}\n\n`,
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
    'data: [DONE]\n\n',
  ];
}

function toolTurn(name: string, input: Record<string, unknown>, id = 'tool'): string[] {
  return [
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(input) } }] } }] })}\n\n`,
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
    'data: [DONE]\n\n',
  ];
}

function textTurn(text: string): string[] {
  return [
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`,
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
  ];
}

function anthropicTerminalTurn(name: 'answer_user' | 'submit_change_ticket', input: Record<string, unknown>): string[] {
  const encoded = JSON.stringify(JSON.stringify(input));
  return [
    `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'terminal', name } })}\n\n`,
    `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":${encoded}}}\n\n`,
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ];
}

const DEEPSEEK: AiSettings = { provider: 'deepseek', model: 'deepseek-v4-flash', apiKeyEnc: '' };
const ANTHROPIC: AiSettings = { provider: 'anthropic', model: 'claude-opus-4-8', apiKeyEnc: '' };
const SUBMISSION = {
  summary: 'Hide search on Open Actions',
  target: '[[object:818]]',
  operation: 'update',
  code: 't.qa_open_actions.change(showSearch := FALSE)',
};

function layoutResult(twoMatches = false): ToolResult {
  const target = {
    status: 'resolved' as const,
    target: {
      rid: '818',
      businessId: 'qa_open_actions',
      type: 'ExtendedTable',
      name: 'Open Actions',
      ecRef: 't.qa_open_actions',
    },
    scope: 'shared-template' as const,
    impact: 'all-linked-instances' as const,
    reason: 'inherited-widget-default' as const,
  };
  const nodes = [{
    rid: '119',
    businessId: 'iv_open_actions',
    depth: 1,
    kind: 'widget' as const,
    type: 'InputView',
    name: 'Open Actions',
    columns: { large: 6 },
    storage: 'page-child' as const,
    codeSlots: [],
    changeTarget: target,
  }, ...(twoMatches ? [{
    rid: '120',
    businessId: 'iv_open_actions_2',
    depth: 1,
    kind: 'widget' as const,
    type: 'InputView',
    name: 'Open Actions',
    columns: { large: 6 },
    storage: 'page-child' as const,
    codeSlots: [],
    changeTarget: target,
  }] : [])];
  return {
    content: 'layout',
    isError: false,
    structuredContent: toolSuccess('read_layout', {
      viewedRid: '726',
      pageOwnerRid: '700',
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
      pageTarget: target,
      nodes,
    }),
  };
}

function typeResult(propertyCount = 1): ToolResult {
  const properties = [{
    accessor: 'showSearch',
    label: 'Show search',
    configClass: 'BooleanMethodConfig',
    system: false,
  }, ...(propertyCount > 1 ? [{
    accessor: 'searchPlaceholder',
    label: 'Search placeholder',
    configClass: 'StringMethodConfig',
    system: false,
  }] : [])];
  return {
    content: 'type',
    isError: false,
    structuredContent: toolSuccess('read_type', {
      requestedType: 'InputView',
      query: 'hide search',
      affordances: { code: false, references: false, flow: false },
      codeSlots: [],
      referenceEdges: [],
      contextFields: [],
      collections: [],
      schema: {
        available: true,
        total: properties.length,
        returned: properties.length,
        truncated: false,
        properties,
      },
      optionSets: [],
      complete: true,
    }),
  };
}

function textPropertyResult(): ToolResult {
  return {
    content: 'type',
    isError: false,
    structuredContent: toolSuccess('read_type', {
      requestedType: 'InputView',
      query: 'header text active work',
      affordances: { code: false, references: false, flow: false },
      codeSlots: [],
      referenceEdges: [],
      contextFields: [],
      collections: [],
      schema: {
        available: true,
        total: 1,
        returned: 1,
        truncated: false,
        properties: [{
          accessor: 'headerText',
          label: 'Header text',
          configClass: 'StringMethodConfig',
          system: false,
        }],
      },
      optionSets: [],
      complete: true,
    }),
  };
}

function referencePropertyResult(): ToolResult {
  return {
    content: 'type',
    isError: false,
    structuredContent: toolSuccess('read_type', {
      requestedType: 'InputView',
      query: 'detail card',
      affordances: { code: false, references: true, flow: false },
      codeSlots: [],
      referenceEdges: [],
      contextFields: [],
      collections: [],
      schema: {
        available: true,
        total: 1,
        returned: 1,
        truncated: false,
        properties: [{ accessor: 'card', label: 'Detail card', configClass: 'ReferenceMethodConfig', system: false }],
      },
      optionSets: [],
      complete: true,
    }),
  };
}

describe('simple widget change prefetch', () => {
  it('resolves one named widget and one live property without generating code', async () => {
    const executeTool = vi.fn(async (call: ToolCall) => call.name === 'read_layout'
      ? layoutResult()
      : typeResult());
    const result = await prefetchSimpleWidgetChange({
      text: 'Change Open Actions widget to hide search',
      pageRid: '726',
      executeTool,
      onEvent: vi.fn(),
    });

    expect(executeTool).toHaveBeenCalledTimes(2);
    expect(executeTool.mock.calls[1][0]).toMatchObject({
      name: 'read_type',
      input: { type: 'InputView', query: 'hide search', exampleRef: 't.qa_open_actions' },
    });
    expect(result!.evidence).toMatchObject({
      status: 'property-candidates',
      widgets: [{
        defaultTarget: {
          token: '[[object:818]]',
          mutationRef: 't.qa_open_actions',
          scope: 'shared-template',
        },
      }],
      propertyCandidates: [{ accessor: 'showSearch' }],
    });
  });

  it('falls through when the widget or property is ambiguous', async () => {
    const duplicateWidget = vi.fn(async () => layoutResult(true));
    const first = await prefetchSimpleWidgetChange({
      text: 'Change Open Actions widget to hide search', pageRid: '726', executeTool: duplicateWidget, onEvent: vi.fn(),
    });
    expect(first?.evidence).toMatchObject({ status: 'widget-ambiguous', complete: false });
    expect(duplicateWidget).toHaveBeenCalledTimes(1);

    const duplicateProperty = vi.fn(async (call: ToolCall) => call.name === 'read_layout'
      ? layoutResult()
      : typeResult(2));
    const second = await prefetchSimpleWidgetChange({
      text: 'Change Open Actions widget to hide search', pageRid: '726', executeTool: duplicateProperty, onEvent: vi.fn(),
    });
    expect(second?.evidence).toMatchObject({ status: 'property-candidates', complete: false });
    expect(duplicateProperty).toHaveBeenCalledTimes(2);
  });

  it('does not use keywords to hide context from structural requests', async () => {
    const executeTool = vi.fn(async (call: ToolCall) => call.name === 'read_layout'
      ? layoutResult()
      : typeResult(0));
    const result = await prefetchSimpleWidgetChange({
      text: 'Create an Open Actions widget', pageRid: '726', executeTool, onEvent: vi.fn(),
    });
    expect(result?.executions.map(item => item.call.name)).toEqual(['read_layout']);
    expect(result?.route).toBeUndefined();

    expect(await prefetchSimpleWidgetChange({
      text: `Change Open Actions ${'carefully '.repeat(40)}`,
      pageRid: '726', executeTool, onEvent: vi.fn(),
    })).toBeNull();
  });
});

describe('simple widget change pipeline', () => {
  it('offers only terminal outcomes after complete Boolean evidence and finishes in one provider call', async () => {
    const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return Promise.resolve(openAiStream(submitTurn(SUBMISSION)));
    }));
    const events: AiChatEvent[] = [];
    const executeTool = vi.fn(async (call: ToolCall): Promise<ToolResult> => {
      if (call.name === 'read_layout') return layoutResult();
      if (call.name === 'read_type') return typeResult();
      return { content: 'Preview succeeded', isError: false };
    });

    const metrics = await streamChat({
      settings: DEEPSEEK,
      apiKey: 'key',
      system: 'S',
      history: [],
      text: 'Change Open Actions widget to hide search',
      pageRid: '726',
      onEvent: event => events.push(event),
      executeTool,
    });

    expect(bodies).toHaveLength(1);
    expect(bodies[0].tools.map((tool: any) => tool.function.name)).toEqual([
      'answer_user', 'submit_change_ticket',
    ]);
    expect(bodies[0].tool_choice).toBe('required');
    expect(bodies[0].messages[0].content).toContain('Choose one useful artifact');
    expect(bodies[0].messages[0].content).toContain('uncommitted suggestion');
    const userText = bodies[0].messages.at(-1)?.content as string;
    expect(userText).toContain('"token":"[[object:818]]"');
    expect(userText).toContain('"mutationRef":"t.qa_open_actions"');
    expect(userText).toContain('"accessor":"showSearch"');
    expect(executeTool.mock.calls.map(([call]) => call.name)).toEqual(['read_layout', 'read_type', 'preview_ec']);
    expect(executeTool.mock.calls.at(-1)?.[0].input).toEqual({ code: SUBMISSION.code });
    expect(events).toContainEqual({ kind: 'text-delta', delta: expect.stringContaining(SUBMISSION.code) });
    expect(metrics).toMatchObject({
      providerRequests: 1,
      terminalOutcome: 'change',
      prefetchedToolCalls: 2,
      automaticToolCalls: 1,
      toolCallsExecuted: 3,
      tools: [
        { name: 'read_layout', origin: 'prefetch' },
        { name: 'read_type', origin: 'prefetch' },
        { name: 'preview_ec', origin: 'pipeline' },
      ],
    });
  });

  it('offers search_objects only when the unique prepared property is a reference, never redundant layout/type/code reads', async () => {
    const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return Promise.resolve(openAiStream(answerTurn('The verified Detail card property accepts a reference.')));
    }));
    const executeTool = vi.fn(async (call: ToolCall): Promise<ToolResult> => {
      if (call.name === 'read_layout') return layoutResult();
      if (call.name === 'read_type') return referencePropertyResult();
      throw new Error(`unexpected tool ${call.name}`);
    });

    await streamChat({
      settings: DEEPSEEK, apiKey: 'key', system: 'S', history: [],
      text: 'Set the Detail card on Open Actions widget', pageRid: '726', onEvent: () => {}, executeTool,
    });

    expect(bodies).toHaveLength(1);
    expect(bodies[0].tools.map((tool: any) => tool.function.name)).toEqual([
      'search_objects', 'answer_user', 'submit_change_ticket',
    ]);
    expect(bodies[0].messages[0].content).toContain('labels are not references');
  });

  it('passes one non-Boolean property as typed candidate metadata without forcing a TRUE/FALSE update form', async () => {
    const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return Promise.resolve(openAiStream(submitTurn({
        summary: 'Set the Open Actions header',
        target: '[[object:818]]',
        operation: 'update',
        authorization: 'direct-request',
        code: 't.qa_open_actions.change(headerText := "Active work")',
      })));
    }));
    const executeTool = vi.fn(async (call: ToolCall): Promise<ToolResult> => {
      if (call.name === 'read_layout') return layoutResult();
      if (call.name === 'read_type') return textPropertyResult();
      return { content: 'Preview succeeded', isError: false };
    });

    await streamChat({
      settings: DEEPSEEK, apiKey: 'key', system: 'S', history: [],
      text: 'Change Open Actions widget header text to Active work', pageRid: '726', onEvent: () => {}, executeTool,
    });

    const userText = bodies[0].messages.at(-1)?.content as string;
    expect(userText).toContain('"accessor":"headerText"');
    expect(userText).toContain('"configClass":"StringMethodConfig"');
    expect(bodies[0].messages[0].content).toMatch(/quote strings/i);
  });

  it('answers a how-to question in one terminal turn without Previewing a change', async () => {
    const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return Promise.resolve(openAiStream(answerTurn('The verified setting is Show search.')));
    }));
    const events: AiChatEvent[] = [];
    const executeTool = vi.fn(async (call: ToolCall): Promise<ToolResult> => call.name === 'read_layout'
      ? layoutResult()
      : typeResult());

    const metrics = await streamChat({
      settings: DEEPSEEK, apiKey: 'key', system: 'S', history: [],
      text: 'How can I hide search on Open Actions?', pageRid: '726',
      onEvent: event => events.push(event), executeTool,
    });

    expect(bodies).toHaveLength(1);
    expect(bodies[0].tool_choice).toBe('required');
    expect(executeTool.mock.calls.map(([call]) => call.name)).toEqual(['read_layout', 'read_type']);
    expect(events).toContainEqual({ kind: 'text-delta', delta: 'The verified setting is Show search.' });
    expect(metrics).toMatchObject({ providerRequests: 1, terminalOutcome: 'answer', prefetchedToolCalls: 2, automaticToolCalls: 0 });
  });

  it('offers read_object only when the persisted current value is requested', async () => {
    const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return Promise.resolve(openAiStream(answerTurn('Search is currently hidden.')));
    }));
    const executeTool = vi.fn(async (call: ToolCall): Promise<ToolResult> => call.name === 'read_layout'
      ? layoutResult()
      : typeResult());

    await streamChat({
      settings: DEEPSEEK, apiKey: 'key', system: 'S', history: [],
      text: 'Is search currently visible on Open Actions?', pageRid: '726', onEvent: () => {}, executeTool,
    });

    expect(bodies[0].tools.map((tool: any) => tool.function.name)).toEqual([
      'read_object', 'answer_user', 'submit_change_ticket',
    ]);
  });

  it.each([
    'Show me the search setting on Open Actions.',
    "Don't hide search on Open Actions.",
  ])('lets a prepared prompt choose answer_user with no Preview: %s', async text => {
    const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return Promise.resolve(openAiStream(answerTurn('Show search is the verified setting.')));
    }));
    const executeTool = vi.fn(async (call: ToolCall): Promise<ToolResult> => call.name === 'read_layout'
      ? layoutResult()
      : typeResult());

    const metrics = await streamChat({
      settings: DEEPSEEK, apiKey: 'key', system: 'S', history: [], text, pageRid: '726', onEvent: () => {}, executeTool,
    });

    expect(bodies).toHaveLength(1);
    expect(bodies[0].tools.map((tool: any) => tool.function.name)).toEqual([
      'answer_user', 'submit_change_ticket',
    ]);
    expect(bodies[0].tool_choice).toBe('required');
    expect(executeTool.mock.calls.map(([call]) => call.name)).toEqual(['read_layout', 'read_type']);
    expect(metrics).toMatchObject({ terminalOutcome: 'answer', prefetchedToolCalls: 2, automaticToolCalls: 0 });
  });

  it('uses Anthropic any-choice with only the two terminal artifacts after prepared evidence', async () => {
    const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return Promise.resolve(openAiStream(anthropicTerminalTurn('answer_user', {
        answer: 'Show search is the verified setting.',
      })));
    }));
    const executeTool = vi.fn(async (call: ToolCall): Promise<ToolResult> => call.name === 'read_layout'
      ? layoutResult()
      : typeResult());

    const metrics = await streamChat({
      settings: ANTHROPIC, apiKey: 'key', system: 'S', history: [],
      text: 'Show me the search setting on Open Actions.', pageRid: '726', onEvent: () => {}, executeTool,
    });

    expect(bodies).toHaveLength(1);
    expect(bodies[0].tools.map((tool: any) => tool.name)).toEqual([
      'answer_user', 'submit_change_ticket',
    ]);
    expect(bodies[0].tool_choice).toEqual({ type: 'any', disable_parallel_tool_use: true });
    expect(executeTool.mock.calls.map(([call]) => call.name)).toEqual(['read_layout', 'read_type']);
    expect(metrics).toMatchObject({ providerRequests: 1, terminalOutcome: 'answer', automaticToolCalls: 0 });
  });

  it('recognizes an indirect desired end state from the terminal artifact rather than the verb classifier', async () => {
    const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return Promise.resolve(openAiStream(submitTurn(SUBMISSION)));
    }));
    const executeTool = vi.fn(async (call: ToolCall): Promise<ToolResult> => {
      if (call.name === 'read_layout') return layoutResult();
      if (call.name === 'read_type') return typeResult();
      return { content: 'Preview succeeded', isError: false };
    });

    const metrics = await streamChat({
      settings: DEEPSEEK, apiKey: 'key', system: 'S', history: [],
      text: "Open Actions doesn't need search.", pageRid: '726', onEvent: () => {}, executeTool,
    });

    expect(bodies).toHaveLength(1);
    expect(bodies[0].tool_choice).toBe('required');
    expect(executeTool.mock.calls.map(([call]) => call.name)).toEqual(['read_layout', 'read_type', 'preview_ec']);
    expect(metrics).toMatchObject({ providerRequests: 1, terminalOutcome: 'change', prefetchedToolCalls: 2, automaticToolCalls: 1 });
  });

  it('keeps normal discovery tools available after an ambiguous widget match', async () => {
    const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return Promise.resolve(openAiStream(submitTurn(SUBMISSION)));
    }));
    const executeTool = vi.fn(async (call: ToolCall): Promise<ToolResult> => call.name === 'read_layout'
      ? layoutResult(true)
      : { content: 'Preview succeeded', isError: false });

    const metrics = await streamChat({
      settings: DEEPSEEK, apiKey: 'key', system: 'S', history: [],
      text: 'Change Open Actions widget to hide search', pageRid: '726', onEvent: () => {}, executeTool,
    });

    expect(bodies).toHaveLength(1);
    expect(bodies[0].tool_choice).toBeUndefined();
    expect(bodies[0].tools.map((tool: any) => tool.function.name)).toContain('read_layout');
    expect(bodies[0].tools.map((tool: any) => tool.function.name)).toContain('submit_change_ticket');
    expect(executeTool.mock.calls.map(([call]) => call.name)).toEqual(['read_layout', 'preview_ec']);
    expect(metrics).toMatchObject({ prefetchedToolCalls: 1, automaticToolCalls: 1 });
  });

  it('does not redundantly re-offer read_layout after prefetch has already resolved the named widget', async () => {
    const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      const response = bodies.length === 1
        ? toolTurn('read_layout', { pageRid: '726', changeScope: 'instance-only' }, 'local-layout')
        : submitTurn(SUBMISSION);
      return Promise.resolve(openAiStream(response));
    }));
    const executeTool = vi.fn(async (call: ToolCall): Promise<ToolResult> => {
      if (call.name === 'read_layout') return layoutResult();
      if (call.name === 'read_type') return typeResult();
      return { content: 'Preview succeeded', isError: false };
    });

    await streamChat({
      settings: DEEPSEEK, apiKey: 'key', system: 'S', history: [],
      text: 'Change only this copy of Open Actions widget to hide search', pageRid: '726', onEvent: () => {}, executeTool,
    });

    expect(bodies[0].tool_choice).toBe('required');
    expect(bodies[0].tools.map((tool: any) => tool.function.name)).not.toContain('read_layout');
    expect(bodies[0].tools.map((tool: any) => tool.function.name)).toEqual([
      'answer_user', 'submit_change_ticket',
    ]);
  });

  it('supplies partial property candidates to the model instead of discarding them after prefetch', async () => {
    const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return Promise.resolve(openAiStream(submitTurn(SUBMISSION)));
    }));
    const executeTool = vi.fn(async (call: ToolCall): Promise<ToolResult> => {
      if (call.name === 'read_layout') return layoutResult();
      if (call.name === 'read_type') return typeResult(2);
      return { content: 'Preview succeeded', isError: false };
    });

    await streamChat({
      settings: DEEPSEEK, apiKey: 'key', system: 'S', history: [],
      text: 'Change Open Actions widget to hide search', pageRid: '726', onEvent: () => {}, executeTool,
    });

    const userText = bodies[0].messages.at(-1)?.content as string;
    expect(userText).toContain('<prefetched-context>');
    expect(userText).toContain('"accessor":"showSearch"');
    expect(userText).toContain('"accessor":"searchPlaceholder"');
  });

  it('accepts a useful prepared-route text answer without forcing a terminal retry', async () => {
    const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return Promise.resolve(openAiStream(bodies.length === 1
        ? textTurn('I will look into that.')
        : answerTurn('Show search is the verified setting.')));
    }));
    const executeTool = vi.fn(async (call: ToolCall): Promise<ToolResult> => call.name === 'read_layout'
      ? layoutResult()
      : typeResult());

    await streamChat({
      settings: DEEPSEEK, apiKey: 'key', system: 'S', history: [],
      text: 'Show me the search setting on Open Actions.', pageRid: '726', onEvent: () => {}, executeTool,
    });

    expect(bodies).toHaveLength(1);
  });

  it('keeps normal discovery tools available after an ambiguous property or explicit instance scope', async () => {
    for (const [text, expectedPrefetchCalls] of [
      ['Change Open Actions widget to hide search', 2],
      ['Change this instance of Open Actions widget to hide search', 2],
    ] as const) {
      const bodies: any[] = [];
      vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return Promise.resolve(openAiStream(submitTurn(SUBMISSION)));
      }));
      const executeTool = vi.fn(async (call: ToolCall): Promise<ToolResult> => {
        if (call.name === 'read_layout') return layoutResult();
        if (call.name === 'read_type') return typeResult(2);
        return { content: 'Preview succeeded', isError: false };
      });

      const metrics = await streamChat({
        settings: DEEPSEEK, apiKey: 'key', system: 'S', history: [], text, pageRid: '726', onEvent: () => {}, executeTool,
      });

      expect(bodies).toHaveLength(1);
      expect(bodies[0].tool_choice).toBeUndefined();
      expect(bodies[0].tools.map((tool: any) => tool.function.name)).toContain('submit_change_ticket');
      expect(metrics?.prefetchedToolCalls ?? 0).toBe(expectedPrefetchCalls);
      expect(executeTool.mock.calls.filter(([call]) => call.name === 'preview_ec')).toHaveLength(1);
      vi.unstubAllGlobals();
    }
  });
});
