/**
 * Phase 1 AI chat backend — handler routing + defensive tool execution.
 * The tool layer must never throw: bad refs / no connection / EC errors all
 * come back as readable isError results the model can adapt to.
 */
import { describe, it, expect, vi } from 'vitest';
import { mockChromeStorage } from '../../__tests__/chrome-mock';
import { setSwContext } from '../../sw-context';
import type { ToolCall } from '../../ai/tools';
import type { AiContextEnvelope } from '../../ai/types';
import { toolSuccess } from '../../ai/tool-results';
import { TOOL_RESULT_CAP } from '../../ai/tools';

// The AI_OPEN_IN_EDITOR handler launches the free-script editor; stub the
// window launcher so we can assert routing without a real editor frame.
vi.mock('../../editor', () => ({
  openExtendedWindow: vi.fn(() => Promise.resolve()),
  openEditorWindow: vi.fn(() => Promise.resolve()),
}));

function makeCtx(overrides: any = {}): any {
  return {
    client: null,
    settings: { activeProfileId: 'test' },
    logActivity: vi.fn(),
    sendToPanel: vi.fn(),
    sendToPanelByWindow: vi.fn(),
    toast: vi.fn(),
    settingsReady: Promise.resolve(),
    ...overrides,
  };
}

const call = (name: string, input: Record<string, unknown> = {}): ToolCall => ({ id: 'c', name, input });
const scorecardContext: AiContextEnvelope = {
  v: 1,
  server: { id: 'test', url: 'https://example.test/' },
  sources: [{
    kind: 'selection',
    object: { rid: '5238328459709259649', businessId: 'sc_case_docs', name: 'Case Documents', type: 'Scorecard' },
  }],
};

async function request(handler: any, message: any): Promise<any> {
  return new Promise(resolve => {
    void handler(message, resolve, { isOneShot: true });
  });
}

describe('AI chat handler routing', () => {
  it('registers every Phase 1 chat message handler', async () => {
    mockChromeStorage();
    setSwContext(makeCtx());
    const { getHandler } = await import('../../handler-registry');
    await import('../ai');
    for (const t of ['AI_CHAT_SEND', 'AI_CHAT_CANCEL', 'AI_PREVIEW_CODE', 'AI_PREVIEW_CHANGE', 'AI_RUN_CHANGE', 'AI_APPLY_PROPOSAL', 'AI_INSERT_AT_CURSOR', 'AI_CHAT_HANDOFF', 'AI_OPEN_IN_EDITOR', 'AI_EDITOR_CONTEXT_UPDATE', 'AI_GET_EDITOR_CONTEXT']) {
      expect(getHandler(t), t).toBeDefined();
    }
  });
});

describe('AI editor context routing', () => {
  it('keeps editor context isolated by active tab and Chrome window', async () => {
    mockChromeStorage();
    const ctx = makeCtx();
    setSwContext(ctx);
    const tabs = new Map([
      [101, { id: 101, windowId: 10, active: true }],
      [202, { id: 202, windowId: 20, active: true }],
    ]);
    chrome.tabs.get = vi.fn(async (tabId: number) => tabs.get(tabId) as chrome.tabs.Tab);
    chrome.tabs.query = vi.fn(async query => [...tabs.values()].filter(tab =>
      tab.windowId === query.windowId && tab.active) as chrome.tabs.Tab[]);
    const { resetEditorContexts } = await import('../../ai/editor-context');
    resetEditorContexts();
    const { getHandler } = await import('../../handler-registry');
    await import('../ai');
    const update = getHandler('AI_EDITOR_CONTEXT_UPDATE')!;
    const sourceA = { kind: 'editor' as const, object: { rid: '1', businessId: 'a', type: 'ExtendedTable', name: 'A' } };
    const sourceB = { kind: 'editor' as const, object: { rid: '2', businessId: 'b', type: 'ExtendedTable', name: 'B' } };

    await update({ type: 'AI_EDITOR_CONTEXT_UPDATE', source: sourceA }, () => {}, { senderTabId: 101, isOneShot: true });
    await update({ type: 'AI_EDITOR_CONTEXT_UPDATE', source: sourceB }, () => {}, { senderTabId: 202, isOneShot: true });
    await update({ type: 'AI_EDITOR_CONTEXT_UPDATE', source: null }, () => {}, { senderTabId: 101, isOneShot: true });

    expect(ctx.sendToPanelByWindow.mock.calls).toEqual([
      [10, { type: 'AI_EDITOR_CONTEXT', source: sourceA }],
      [20, { type: 'AI_EDITOR_CONTEXT', source: sourceB }],
      [10, { type: 'AI_EDITOR_CONTEXT', source: null }],
    ]);

    const result = await new Promise(resolve => {
      void getHandler('AI_GET_EDITOR_CONTEXT')!(
        { type: 'AI_GET_EDITOR_CONTEXT' },
        resolve,
        { panelWindowId: 20, isOneShot: false },
      );
    });
    expect(result).toEqual({ type: 'AI_EDITOR_CONTEXT', source: sourceB });
  });

  it('does not broadcast an editor update from an inactive tab', async () => {
    mockChromeStorage();
    const ctx = makeCtx();
    setSwContext(ctx);
    chrome.tabs.get = vi.fn(async () => ({ id: 303, windowId: 30, active: false } as chrome.tabs.Tab));
    const { resetEditorContexts } = await import('../../ai/editor-context');
    resetEditorContexts();
    const { getHandler } = await import('../../handler-registry');
    await import('../ai');

    await getHandler('AI_EDITOR_CONTEXT_UPDATE')!(
      { type: 'AI_EDITOR_CONTEXT_UPDATE', source: { kind: 'editor', object: { rid: '3', businessId: 'inactive', type: 'ExtendedTable', name: 'Inactive' } } },
      () => {},
      { senderTabId: 303, isOneShot: true },
    );

    expect(ctx.sendToPanelByWindow).not.toHaveBeenCalled();
  });
});

describe('AI Change Ticket lifecycle', () => {
  const proposal = (code: string) => ({
    summary: 'Test change',
    target: 'Current object',
    operation: 'update' as const,
    language: 'extended' as const,
    code,
  });

  it('lets BMP Preview judge the exact EC without a heuristic target gate', async () => {
    mockChromeStorage();
    const executeEc = vi.fn(async () => ({ ok: true, log: 'preview ok' }));
    setSwContext(makeCtx({ client: { executeEc, serverUrl: 'https://bmp.test/Steadfast/', commandUser: 'admin' } }));
    const { getHandler } = await import('../../handler-registry');
    await import('../ai');

    const result = await request(getHandler('AI_PREVIEW_CHANGE'), {
      type: 'AI_PREVIEW_CHANGE',
      requestId: 'p',
      proposal: proposal('t.119.change(expression := "source")'),
      expectedTarget: { rid: '818', businessId: 'navigation_table' },
    });

    expect(result).toMatchObject({ ok: true, runnable: true, resultText: 'preview ok' });
    expect(executeEc).toHaveBeenCalledWith('t.119.change(expression := "source")', undefined, false);
  });

  it('rejects preview warnings without issuing a runnable token', async () => {
    mockChromeStorage();
    const executeEc = vi.fn(async () => ({ ok: true, hasWarning: true, log: 'Missing property' }));
    setSwContext(makeCtx({ client: { executeEc, serverUrl: 'https://bmp.test/Steadfast/', commandUser: 'admin' } }));
    const { getHandler } = await import('../../handler-registry');
    await import('../ai');

    const result = await request(getHandler('AI_PREVIEW_CHANGE'), { type: 'AI_PREVIEW_CHANGE', requestId: 'p', proposal: proposal('t.name := "x"') });

    expect(result).toMatchObject({ ok: false, runnable: false });
    expect(result).toMatchObject({ purpose: 'change' });
    expect(result.previewId).toBeUndefined();
    expect(result.resultText).toContain('warning');
    expect(executeEc).toHaveBeenCalledWith('t.name := "x"', undefined, false);
  });

  it('issues a runnable token after the change itself previews successfully', async () => {
    mockChromeStorage();
    const executeEc = vi.fn(async () => ({ ok: true, log: 'preview ok' }));
    setSwContext(makeCtx({ client: { executeEc, serverUrl: 'https://bmp.test/Steadfast/', commandUser: 'admin' } }));
    const { getHandler } = await import('../../handler-registry');
    await import('../ai');

    const result = await request(getHandler('AI_PREVIEW_CHANGE'), {
      type: 'AI_PREVIEW_CHANGE',
      requestId: 'p',
      proposal: proposal('_page := t.118\n_page.children().forEach(_w:\n _w.change(name := "j" + _w.id)\n)'),
    });

    expect(result).toMatchObject({ ok: true, runnable: true, resultText: 'preview ok' });
    expect(result).toMatchObject({ purpose: 'change' });
    expect(result.previewId).toEqual(expect.any(String));
    expect(executeEc).toHaveBeenCalledOnce();
  });

  it('runs the exact previewed change without a second verification script', async () => {
    mockChromeStorage();
    const executeEc = vi.fn()
      .mockResolvedValueOnce({ ok: true, log: 'preview ok' })
      .mockResolvedValueOnce({ ok: true, log: 'run ok' });
    const ctx = makeCtx({ client: { executeEc, serverUrl: 'https://bmp.test/Steadfast/', commandUser: 'admin' } });
    setSwContext(ctx);
    const { getHandler } = await import('../../handler-registry');
    await import('../ai');

    const preview = await request(getHandler('AI_PREVIEW_CHANGE'), { type: 'AI_PREVIEW_CHANGE', requestId: 'p', proposal: proposal('t.owner := lookup("admin")') });
    const run = await request(getHandler('AI_RUN_CHANGE'), { type: 'AI_RUN_CHANGE', requestId: 'r', previewId: preview.previewId });

    expect(preview).toMatchObject({ ok: true, runnable: true, resultText: 'preview ok' });
    expect(run).toMatchObject({ ok: true, resultText: 'run ok' });
    expect(executeEc.mock.calls).toEqual([
      ['t.owner := lookup("admin")', undefined, false],
      ['t.owner := lookup("admin")', undefined, true],
    ]);
    expect(ctx.logActivity).toHaveBeenCalledWith('success', 'AI Change Ticket executed', 'run ok', expect.any(Object));
  });

  it('binds a token to its previewed profile and consumes it even after rejection', async () => {
    mockChromeStorage();
    const executeEc = vi.fn(async () => ({ ok: true, log: 'ok' }));
    const ctx = makeCtx({
      client: { executeEc, serverUrl: 'https://bmp.test/Steadfast/', commandUser: 'admin' },
      settings: { activeProfileId: 'one' },
    });
    setSwContext(ctx);
    const { getHandler } = await import('../../handler-registry');
    await import('../ai');

    const preview = await request(getHandler('AI_PREVIEW_CHANGE'), { type: 'AI_PREVIEW_CHANGE', requestId: 'p', proposal: proposal('t.name := "x"') });
    ctx.settings.activeProfileId = 'two';
    const rejected = await request(getHandler('AI_RUN_CHANGE'), { type: 'AI_RUN_CHANGE', requestId: 'r', previewId: preview.previewId });
    const reused = await request(getHandler('AI_RUN_CHANGE'), { type: 'AI_RUN_CHANGE', requestId: 'r2', previewId: preview.previewId });

    expect(rejected.resultText).toContain('environment changed');
    expect(reused.resultText).toContain('Preview expired');
    expect(executeEc).toHaveBeenCalledTimes(1); // preview only
  });

  it('binds Run to the exact BMP server and actor that produced Preview', async () => {
    mockChromeStorage();
    const executeEc = vi.fn(async () => ({ ok: true, log: 'ok' }));
    const client = { executeEc, serverUrl: 'https://bmp.test/Steadfast/', commandUser: 'admin' };
    const ctx = makeCtx({ client, settings: { activeProfileId: 'one' } });
    setSwContext(ctx);
    const { getHandler } = await import('../../handler-registry');
    await import('../ai');

    const serverPreview = await request(getHandler('AI_PREVIEW_CHANGE'), {
      type: 'AI_PREVIEW_CHANGE', requestId: 'p1', proposal: proposal('t.name := "server"'),
    });
    client.serverUrl = 'https://bmp.test/Other/';
    const wrongServer = await request(getHandler('AI_RUN_CHANGE'), {
      type: 'AI_RUN_CHANGE', requestId: 'r1', previewId: serverPreview.previewId,
    });

    client.serverUrl = 'https://bmp.test/Steadfast/';
    const actorPreview = await request(getHandler('AI_PREVIEW_CHANGE'), {
      type: 'AI_PREVIEW_CHANGE', requestId: 'p2', proposal: proposal('t.name := "actor"'),
    });
    client.commandUser = 'configurator';
    const wrongActor = await request(getHandler('AI_RUN_CHANGE'), {
      type: 'AI_RUN_CHANGE', requestId: 'r2', previewId: actorPreview.previewId,
    });

    expect(wrongServer.resultText).toContain('environment changed');
    expect(wrongActor.resultText).toContain('environment changed');
    expect(executeEc).toHaveBeenCalledTimes(2); // the two Previews only
  });

  it('does not mint a capability when the active client changes during Preview', async () => {
    mockChromeStorage();
    let release!: (value: { ok: boolean; log: string }) => void;
    const executeEc = vi.fn(() => new Promise<{ ok: boolean; log: string }>(resolve => { release = resolve; }));
    const clientA = { executeEc, serverUrl: 'https://bmp.test/A/', commandUser: 'actor-a' };
    const clientB = { executeEc: vi.fn(), serverUrl: 'https://bmp.test/B/', commandUser: 'actor-b' };
    const ctx = makeCtx({ client: clientA, settings: { activeProfileId: 'a' } });
    setSwContext(ctx);
    const { getHandler } = await import('../../handler-registry');
    await import('../ai');

    const pending = request(getHandler('AI_PREVIEW_CHANGE'), {
      type: 'AI_PREVIEW_CHANGE', requestId: 'p', proposal: proposal('t.name := "changed"'),
    });
    await vi.waitFor(() => expect(executeEc).toHaveBeenCalledOnce());
    ctx.client = clientB;
    ctx.settings.activeProfileId = 'b';
    release({ ok: true, log: 'preview ok on A' });

    await expect(pending).resolves.toMatchObject({
      ok: false,
      runnable: false,
      previewId: undefined,
      resultText: expect.stringContaining('connection changed'),
    });
    expect(clientB.executeEc).not.toHaveBeenCalled();
  });

  it('does not mint a capability without a verified command principal', async () => {
    mockChromeStorage();
    const executeEc = vi.fn(async () => ({ ok: true, log: 'preview ok' }));
    setSwContext(makeCtx({
      client: { executeEc, serverUrl: 'https://bmp.test/Steadfast/', commandUser: null },
    }));
    const { getHandler } = await import('../../handler-registry');
    await import('../ai');

    const result = await request(getHandler('AI_PREVIEW_CHANGE'), {
      type: 'AI_PREVIEW_CHANGE', requestId: 'p', proposal: proposal('t.name := "x"'),
    });

    expect(result).toMatchObject({ ok: false, runnable: false, previewId: undefined });
    expect(result.resultText).toContain('command identity');
  });
});

describe('AI_OPEN_IN_EDITOR routing', () => {
  it('launches the free-script editor preloaded with the block code, on the panel tab', async () => {
    mockChromeStorage();
    setSwContext(makeCtx());
    const { getHandler } = await import('../../handler-registry');
    await import('../ai');
    const editor = await import('../../editor');
    const handler = getHandler('AI_OPEN_IN_EDITOR')!;
    void handler(
      { type: 'AI_OPEN_IN_EDITOR', code: 'output(1 + 1)' } as any,
      () => {},
      { senderTabId: 7, panelWindowId: 3, isOneShot: false },
    );
    expect(editor.openExtendedWindow).toHaveBeenCalledWith(
      undefined,
      { tabId: 7, windowId: 3 },
      'output(1 + 1)',
    );
  });
});

describe('executeAiTool — defensive', () => {
  it('rejects an unknown tool with an isError result, no throw', async () => {
    mockChromeStorage();
    setSwContext(makeCtx({ client: {} }));
    const { executeAiTool } = await import('../ai-tools');
    const res = await executeAiTool(call('does_not_exist'));
    expect(res.isError).toBe(true);
    expect(res.content).toContain('Unknown tool');
  });

  it('reports "not connected" when there is no client', async () => {
    mockChromeStorage();
    setSwContext(makeCtx({ client: null }));
    const { executeAiTool } = await import('../ai-tools');
    const res = await executeAiTool(call('preview_ec', { code: 'output(1)' }));
    expect(res.isError).toBe(true);
    expect(res.content).toContain('Not connected');
  });

  it('preview_ec returns the EC log verbatim on success', async () => {
    mockChromeStorage();
    const executeEc = vi.fn(async () => ({ ok: true, log: '42' }));
    setSwContext(makeCtx({ client: { executeEc } }));
    const { executeAiTool } = await import('../ai-tools');
    const res = await executeAiTool(call('preview_ec', { code: 'output(21+21)' }));
    expect(res.isError).toBe(false);
    expect(res.content).toContain('42');
    // Dry-run: non-transactional.
    expect(executeEc).toHaveBeenCalledWith('output(21+21)', undefined, false, undefined);
  });

  it('preview_ec surfaces an EC error as isError', async () => {
    mockChromeStorage();
    const executeEc = vi.fn(async () => ({ ok: false, error: 'parse error' }));
    setSwContext(makeCtx({ client: { executeEc } }));
    const { executeAiTool } = await import('../ai-tools');
    const res = await executeAiTool(call('preview_ec', { code: 'bad(' }));
    expect(res.isError).toBe(true);
    expect(res.content).toContain('parse error');
  });

  it('query_context binds to the attached RID and returns one filtered descendant probe', async () => {
    mockChromeStorage();
    const resolveRef = vi.fn(async () => 'lookup(5238328459709259649)');
    const executeEc = vi.fn(async (
      _code: string,
      _objectRid?: string,
      _transactional?: boolean,
      _signal?: AbortSignal,
    ) => ({ ok: true, log: 'Matched Indicator: 0' }));
    setSwContext(makeCtx({ client: { resolveRef, executeEc } }));
    const { executeAiTool } = await import('../ai-tools');

    const res = await executeAiTool(call('query_context', {
      type: 'Indicator',
      fields: ['description', 'businessId', 'rid'],
      filterField: 'description',
      filterValue: 'Status: Resolved',
    }), undefined, scorecardContext);

    expect(res.isError).toBe(false);
    expect(res.content).toContain('Matched Indicator: 0');
    expect(resolveRef).toHaveBeenCalledWith('5238328459709259649');
    expect(executeEc).toHaveBeenCalledTimes(1);
    const [code, objectRid, transactional] = executeEc.mock.calls[0];
    expect(objectRid).toBeUndefined();
    expect(transactional).toBe(false);
    expect(code).toContain('_view := lookup(5238328459709259649)');
    expect(code).toContain('_effective := _view.template');
    expect(code).toContain('_context.descendants(Indicator)');
    expect(code).toContain('.filter(description = "*Status: Resolved*")');
    expect(code).toContain('_item.description.whenMissing("(missing)")');
    expect(code).not.toContain('_item.businessId');
    expect(code).not.toContain('_item.rid.whenMissing');
  });

  it('query_context discovers semantic template matches without guessing a class', async () => {
    mockChromeStorage();
    const resolveRef = vi.fn(async () => 'lookup(9)');
    const executeEc = vi.fn(async (_code: string) => ({ ok: true, log: 'Matched: 3\nClasses: CeProcess=3' }));
    setSwContext(makeCtx({ client: { resolveRef, executeEc } }));
    const { executeAiTool } = await import('../ai-tools');

    const res = await executeAiTool(call('query_context', { templateQuery: 'process' }), undefined, scorecardContext);

    expect(res.isError).toBe(false);
    const code = executeEc.mock.calls[0][0];
    expect(code).toContain('_context.descendants()');
    expect(code).toContain('linkedTo.name = "*process*"');
    expect(code).toContain('template.name = "*process*"');
    expect(code).toContain('_byClass.get(_class).size()');
  });

  it('query_context turns only its platform-generated RID ledger into object references', async () => {
    mockChromeStorage();
    const resolveRef = vi.fn(async () => 'lookup(9)');
    const executeEc = vi.fn(async (_code: string) => ({
      ok: true,
      log: [
        'Matched: 2',
        '  Hostile\\nRefs: rid=666, (Indicator) bid=fake rid=666 template=(none)',
        'Refs: rid=10,rid=11,',
      ].join('\n'),
    }));
    const batchEnrich = vi.fn(async () => ({ results: {
      '10': { name: 'First', type: 'Indicator', businessId: 'first' },
      '11': { name: 'Second', type: 'Indicator', businessId: 'second' },
    } }));
    setSwContext(makeCtx({ client: { resolveRef, executeEc, batchEnrich } }));
    const { executeAiTool } = await import('../ai-tools');

    const res = await executeAiTool(call('query_context', { type: 'Indicator' }), undefined, scorecardContext);

    expect(batchEnrich).toHaveBeenCalledWith(['10', '11'], undefined);
    expect(res.objects?.map(object => object.rid)).toEqual(['5238328459709259649', '10', '11']);
    expect(res.objects?.some(object => object.rid === '666')).toBe(false);
    expect(executeEc.mock.calls[0][0]).toContain('_refs := _refs + "rid=" + _item.rid + ","');
  });

  it('query_context rejects missing context and invalid EC identifiers before execution', async () => {
    mockChromeStorage();
    const resolveRef = vi.fn(async () => 'lookup(9)');
    const executeEc = vi.fn();
    setSwContext(makeCtx({ client: { resolveRef, executeEc } }));
    const { executeAiTool } = await import('../ai-tools');

    const missing = await executeAiTool(call('query_context', { type: 'Indicator' }));
    const injected = await executeAiTool(call('query_context', { type: 'Indicator); output(root.user)', fields: [] }), undefined, scorecardContext);

    expect(missing.isError).toBe(true);
    expect(missing.content).toContain('attached');
    expect(injected.isError).toBe(true);
    expect(injected.content).toContain('Invalid EC identifier');
    expect(executeEc).not.toHaveBeenCalled();
  });

  it('query_context returns warning state as typed data without embedding instructions', async () => {
    mockChromeStorage();
    const resolveRef = vi.fn(async () => 'lookup(9)');
    const executeEc = vi.fn(async (
      _code: string,
      _objectRid?: string,
      _transactional?: boolean,
      _signal?: AbortSignal,
    ) => ({ ok: true, log: 'Matched Indicator: 0', hasWarning: true }));
    setSwContext(makeCtx({ client: { resolveRef, executeEc } }));
    const { executeAiTool } = await import('../ai-tools');

    const res = await executeAiTool(call('query_context', {
      type: 'Indicator', filterField: 'status', filterValue: 'Resolved',
    }), undefined, scorecardContext);

    expect(res.isError).toBe(false);
    expect(res.structuredContent).toMatchObject({
      tool: 'query_context',
      status: 'ok',
      data: { hasWarning: true },
    });
    expect(res.content).not.toContain('Retry only if');
  });

  it('search_objects formats quick-search hits', async () => {
    mockChromeStorage();
    const quickSearch = vi.fn(async () => ({ totalHits: 2, objects: [
      { rid: '1', name: 'Alpha', type: 'ButtonInput' },
      { rid: '2', name: 'Beta', type: 'CustomVisualization' },
    ] }));
    setSwContext(makeCtx({ client: { quickSearch } }));
    const { executeAiTool } = await import('../ai-tools');
    const res = await executeAiTool(call('search_objects', { query: 'a' }));
    expect(res.isError).toBe(false);
    expect(res.content).toContain('Alpha (ButtonInput) rid=1');
    expect(res.content).toContain('Beta (CustomVisualization) rid=2');
    expect(res.objects?.map(object => object.rid)).toEqual(['1', '2']);
    expect(res.content).toContain('[[object:1]]');
  });

  it('search_objects returns compact ranked classes for row-type discovery', async () => {
    mockChromeStorage();
    const quickSearch = vi.fn(async () => ({ totalHits: 4, objects: [
      { rid: '1', name: 'Risk A', type: 'CeRiskAssessment' },
      { rid: '2', name: 'Risk B', type: 'CeRiskAssessment' },
      { rid: '3', name: 'Risk dashboard', type: 'Scorecard' },
      { rid: '4', name: 'Risk C', type: 'CeRiskAssessment' },
    ] }));
    const batchEnrich = vi.fn(async () => ({ results: {} }));
    setSwContext(makeCtx({ client: { quickSearch, batchEnrich } }));
    const { executeAiTool } = await import('../ai-tools');

    const res = await executeAiTool(call('search_objects', { query: 'risk', purpose: 'row-type' }));

    expect(batchEnrich).toHaveBeenCalledWith(['1', '3'], undefined);
    expect(res.content).toContain('CeRiskAssessment (3), Scorecard (1)');
    expect(res.content).toContain('Do not search again by casing');
    expect(res.objects?.map(object => object.rid)).toEqual(['1', '3']);
    expect(res.structuredContent).toMatchObject({
      tool: 'search_objects',
      status: 'ok',
      data: {
        purpose: 'row-type',
        purposeComplete: true,
        typeCounts: { CeRiskAssessment: 3, Scorecard: 1 },
        typeCandidates: [
          { type: 'CeRiskAssessment', count: 3, representativeRid: '1' },
          { type: 'Scorecard', count: 1, representativeRid: '3' },
        ],
      },
    });
  });

  it('search_objects enriches hits with businessId + template bid (one batched call)', async () => {
    mockChromeStorage();
    const quickSearch = vi.fn(async () => ({ totalHits: 2, objects: [
      { rid: '1', name: 'Alpha', type: 'ButtonInput' },
      { rid: '2', name: 'Beta', type: 'CustomVisualization' },
    ] }));
    const batchEnrich = vi.fn(async (_rids: string[]) => ({ results: {
      '1': { businessId: 'btn_a', type: 'ButtonInput', name: 'Alpha' },
      '2': { businessId: 'cvo_b', type: 'CustomVisualization', name: 'Beta', templateBusinessId: 'tmpl_news' },
    } }));
    setSwContext(makeCtx({ client: { quickSearch, batchEnrich } }));
    const { executeAiTool } = await import('../ai-tools');
    const res = await executeAiTool(call('search_objects', { query: 'a' }));
    // Exactly one batched enrichment for both hits.
    expect(batchEnrich).toHaveBeenCalledTimes(1);
    expect(batchEnrich.mock.calls[0][0]).toEqual(['1', '2']);
    expect(res.content).toContain('Alpha (ButtonInput) bid=btn_a rid=1');
    expect(res.content).toContain('Beta (CustomVisualization) bid=cvo_b rid=2  [tpl bid=tmpl_news]');
    expect(res.objects?.[1]).toMatchObject({
      rid: '2',
      businessId: 'cvo_b',
      templateBusinessId: 'tmpl_news',
    });
  });

  it('search_objects degrades to rid-only when enrichment fails', async () => {
    mockChromeStorage();
    const quickSearch = vi.fn(async () => ({ totalHits: 1, objects: [{ rid: '1', name: 'Alpha', type: 'ButtonInput' }] }));
    const batchEnrich = vi.fn(async () => { throw new Error('EC down'); });
    setSwContext(makeCtx({ client: { quickSearch, batchEnrich } }));
    const { executeAiTool } = await import('../ai-tools');
    const res = await executeAiTool(call('search_objects', { query: 'a' }));
    expect(res.isError).toBe(false);
    expect(res.content).toContain('Alpha (ButtonInput) rid=1');
  });

  it('read_object reports a clear miss for an unresolvable ref', async () => {
    mockChromeStorage();
    const executeEc = vi.fn(async () => ({ ok: true, log: '' })); // resolveRefToRid → no rid
    setSwContext(makeCtx({ client: { executeEc } }));
    const { executeAiTool } = await import('../ai-tools');
    const res = await executeAiTool(call('read_object', { ref: 'nope' }));
    expect(res.isError).toBe(true);
    expect(res.content).toContain('No object found');
  });

  it('read_object uses an explicitly supplied numeric rid directly', async () => {
    mockChromeStorage();
    const executeEc = vi.fn();
    const fetchObjectPane = vi.fn(async () => ({
      instance: { rid: '42', businessId: 'tbl_42', name: 'Processes', type: 'ExtendedTable' },
      template: null, parent: null, instanceProps: {}, templateProps: {}, contextValues: {}, references: {}, codeFields: {},
    }));
    setSwContext(makeCtx({ client: { executeEc, fetchObjectPane } }));
    const { executeAiTool } = await import('../ai-tools');

    const res = await executeAiTool(call('read_object', { ref: '42', refType: 'rid' }));

    expect(res.isError).toBe(false);
    expect(fetchObjectPane).toHaveBeenCalledWith('42', undefined);
    expect(executeEc).not.toHaveBeenCalled();
    expect(res.objects).toEqual([{
      rid: '42',
      businessId: 'tbl_42',
      name: 'Processes',
      type: 'ExtendedTable',
      templateBusinessId: undefined,
    }]);
    expect(res.content).toContain('[[object:42]]');
  });

  it('read_object resolves a numeric business id instead of treating it as a rid', async () => {
    mockChromeStorage();
    const separator = '\x02';
    const executeEc = vi.fn(async (_code: string) => ({ ok: true, log: `5278622719348993479${separator}` }));
    const fetchObjectPane = vi.fn(async () => ({
      instance: { rid: '5278622719348993479', businessId: '3197', name: 'Risk Management', type: 'ModelPage' },
      template: null, parent: null, instanceProps: {}, templateProps: {}, contextValues: {}, references: {}, codeFields: {},
    }));
    setSwContext(makeCtx({ client: { executeEc, fetchObjectPane } }));
    const { executeAiTool } = await import('../ai-tools');

    const res = await executeAiTool(call('read_object', { ref: '3197' }));

    expect(res.isError).toBe(false);
    expect(executeEc.mock.calls[0][0]).toContain('_o := t.get("3197")');
    expect(fetchObjectPane).toHaveBeenCalledWith('5278622719348993479', undefined);
    expect(res.content).toContain('bid=3197');
  });

  it('read_object accepts a verified EC reference from attached context', async () => {
    mockChromeStorage();
    const executeEc = vi.fn(async (_code: string) => ({ ok: true, log: 'Result: 5278622719348993479' }));
    const fetchObjectPane = vi.fn(async () => ({
      instance: { rid: '5278622719348993479', businessId: 'qa_risk', name: 'Risk', type: 'CeRiskAssessment' },
      template: null, parent: null, instanceProps: {}, templateProps: {}, contextValues: {}, references: {}, codeFields: {},
    }));
    setSwContext(makeCtx({ client: { executeEc, fetchObjectPane } }));
    const { executeAiTool } = await import('../ai-tools');

    const res = await executeAiTool(call('read_object', { ref: 't.qa_risk', refType: 'businessId' }));

    expect(res.isError).toBe(false);
    expect(executeEc.mock.calls[0][0]).toContain('_o := t.qa_risk');
    expect(fetchObjectPane).toHaveBeenCalledWith('5278622719348993479', undefined);
  });

  it('read_object returns only requested exact properties with source metadata', async () => {
    mockChromeStorage();
    const knowledge = await import('../../bmp-type-knowledge');
    const schema = vi.spyOn(knowledge.bmpTypeKnowledge, 'properties').mockResolvedValue({
      ok: true,
      canonical: 'CeRiskAssessment',
      props: [{ accessor: 'card', label: 'Detail Card', configClass: 'ReferenceMethodConfig', systemobject: false }],
    });
    const fetchObjectPane = vi.fn(async () => ({
      instance: { rid: '42', businessId: 'risk_42', name: 'Risk', type: 'CeRiskAssessment' },
      template: { rid: '43', businessId: 'risk_template', name: 'Risk template', type: 'CeRiskAssessment' },
      parent: null,
      instanceProps: {}, templateProps: {}, contextValues: {}, references: {}, codeFields: {},
      instanceOverrideProps: [],
    }));
    const fetchSelectedProperties = vi.fn(async () => [{
      accessor: 'card', state: 'value' as const, value: 'Legacy card',
      reference: { rid: '99', businessId: 'legacy_card', name: 'Legacy card', type: 'Card' },
    }]);
    setSwContext(makeCtx({ client: { executeEc: vi.fn(), fetchObjectPane, fetchSelectedProperties } }));
    const { executeAiTool } = await import('../ai-tools');

    const res = await executeAiTool(call('read_object', { ref: '42', refType: 'rid', properties: ['card'] }));

    expect(res.isError).toBe(false);
    expect(fetchSelectedProperties).toHaveBeenCalledWith('42', [{ accessor: 'card', reference: true }], undefined);
    expect(res.content).toContain('card "Detail Card" [ReferenceMethodConfig] = Legacy card (Card) bid=legacy_card rid=99 [source=template]');
    expect(res.content).not.toContain('Properties:\n');
    schema.mockRestore();
  });

  it('read_type filters property definitions by accessor, label or description', async () => {
    mockChromeStorage();
    const knowledge = await import('../../bmp-type-knowledge');
    const schema = vi.spyOn(knowledge.bmpTypeKnowledge, 'properties').mockResolvedValue({
      ok: true,
      canonical: 'CeRiskAssessment',
      props: [
        { accessor: 'card', label: 'Detail Card', configClass: 'ReferenceMethodConfig', systemobject: false },
        { accessor: 'lifecycleState', label: 'Lifecycle State', configClass: 'ListMethodConfig', systemobject: false },
      ],
    });
    const executeEc = vi.fn(async () => ({ ok: true, log: 'CeRiskAssessment' }));
    const resolveRef = vi.fn(async () => 'lookup(42)');
    setSwContext(makeCtx({ client: { executeEc, resolveRef } }));
    const { executeAiTool } = await import('../ai-tools');

    const res = await executeAiTool(call('read_type', {
      type: 'CeRiskAssessment', query: 'detail', exampleRid: '42',
    }));

    expect(res.isError).toBe(false);
    expect(resolveRef).toHaveBeenCalledWith('42');
    expect(schema).toHaveBeenCalledWith({ className: 'CeRiskAssessment', exampleRef: 'lookup(42)' });
    expect(res.content).toContain('matching "detail": 1');
    expect(res.content).toContain('card  "Detail Card"');
    expect(res.content).not.toContain('lifecycleState');
    expect(res.structuredContent).toMatchObject({
      tool: 'read_type', status: 'ok', data: { collections: ['root.CeRiskAssessment.descendants()'] },
    });
    schema.mockRestore();
  });

  it('read_type returns configured values with a matching list property', async () => {
    mockChromeStorage();
    const knowledge = await import('../../bmp-type-knowledge');
    const schema = vi.spyOn(knowledge.bmpTypeKnowledge, 'properties').mockResolvedValue({
      ok: true,
      canonical: 'CeRiskAssessment',
      props: [
        { accessor: 'lifecycle_state_risk', label: 'Lifecycle State', configClass: 'ListMethodConfig', systemobject: false },
      ],
    });
    const options = vi.spyOn(knowledge.bmpTypeKnowledge, 'options').mockResolvedValue({
      ok: true,
      options: [{
        accessor: 'lifecycle_state_risk',
        multi: false,
        items: [
          { ref: 't.operating', name: 'Operating' },
          { ref: 't.closed', name: 'Closed' },
        ],
      }],
    });
    const executeEc = vi.fn(async () => ({ ok: true, log: 'CeRiskAssessment' }));
    setSwContext(makeCtx({ client: { executeEc } }));
    const { executeAiTool } = await import('../ai-tools');

    const res = await executeAiTool(call('read_type', {
      type: 'CeRiskAssessment', query: 'lifecycle',
    }));

    expect(res.isError).toBe(false);
    expect(options).toHaveBeenCalledWith('CeRiskAssessment');
    expect(res.content).toContain('Configured values for lifecycle_state_risk: Operating (t.operating), Closed (t.closed)');
    expect(res.structuredContent).toMatchObject({
      tool: 'read_type',
      status: 'ok',
      data: {
        optionSets: [{
          accessor: 'lifecycle_state_risk',
          items: [{ ref: 't.operating', name: 'Operating' }, { ref: 't.closed', name: 'Closed' }],
        }],
      },
    });
    options.mockRestore();
    schema.mockRestore();
  });

  it('read_type propertyOnly skips the collection executeEc probe while retaining schema and matching options', async () => {
    mockChromeStorage();
    const knowledge = await import('../../bmp-type-knowledge');
    const schema = vi.spyOn(knowledge.bmpTypeKnowledge, 'properties').mockResolvedValue({
      ok: true,
      canonical: 'CeRiskAssessment',
      props: [{ accessor: 'lifecycle', label: 'Lifecycle', configClass: 'ListMethodConfig', systemobject: false }],
    });
    const options = vi.spyOn(knowledge.bmpTypeKnowledge, 'options').mockResolvedValue({
      ok: true,
      options: [{
        accessor: 'lifecycle', multi: false,
        items: [{ ref: 't.open', name: 'Open' }],
      }],
    });
    const executeEc = vi.fn();
    setSwContext(makeCtx({ client: { executeEc } }));
    const { executeAiTool } = await import('../ai-tools');

    const res = await executeAiTool(call('read_type', {
      type: 'CeRiskAssessment', query: 'lifecycle', propertyOnly: true,
    }));

    expect(res.isError).toBe(false);
    expect(executeEc).not.toHaveBeenCalled();
    expect(res.structuredContent).toMatchObject({
      tool: 'read_type', status: 'ok', data: {
        schema: { properties: [{ accessor: 'lifecycle', configClass: 'ListMethodConfig' }] },
        optionSets: [{ accessor: 'lifecycle', items: [{ ref: 't.open', name: 'Open' }] }],
        collections: [],
      },
    });
    options.mockRestore();
    schema.mockRestore();
  });

  it('read_code returns raw ExtendedTable expression by rid without resolving it again', async () => {
    mockChromeStorage();
    const executeEc = vi.fn();
    const fetchCodeViaEc = vi.fn(async () => ({ expression: 'rows := LIST()\nrows' }));
    setSwContext(makeCtx({ client: { executeEc, fetchCodeViaEc } }));
    const { executeAiTool } = await import('../ai-tools');

    const res = await executeAiTool(call('read_code', { ref: '42', refType: 'rid', property: 'expression' }));

    expect(res.isError).toBe(false);
    expect(fetchCodeViaEc).toHaveBeenCalledWith('42', ['expression']);
    expect(executeEc).not.toHaveBeenCalled();
    expect(res.content).toContain('```extended\nrows := LIST()');
    expect(res.structuredContent).toMatchObject({
      tool: 'read_code',
      status: 'ok',
      data: {
        objectRid: '42',
        property: 'expression',
        code: 'rows := LIST()\nrows',
        charCount: 19,
        complete: true,
      },
    });
    expect(res.content).not.toContain('do not call query_context');
  });

  it('formats Blueprint layout as portal structure plus page-owned code-bearing widgets', async () => {
    const { formatAiLayout } = await import('../ai-tools');
    const table = { id: 'tbl_process', rid: '44', kind: 'widget', className: 'ExtendedTable', name: 'Processes', cols: { L: 6 }, children: [] } as any;
    const tab = { id: 'tab_main', rid: '43', kind: 'tab', className: 'Tab', name: 'Main', cols: { L: 6 }, children: [table] } as any;
    const model = { pageId: 'ent_process', pageRid: '99', pageName: 'Process template', pageClass: 'EnterpriseTemplate', tabsetId: 'default_tabset', tabs: [tab], target: 'instance', hasTemplate: false } as any;
    const out = formatAiLayout('12', { kind: 'page', ctx: { pageId: 'ent_process', pageRid: '99', tabsetId: 'default_tabset' }, load: { model, baseline: model, orphans: [] } } as any);

    expect(out).toContain('Effective page owner: Process template (EnterpriseTemplate) bid=ent_process rid=99');
    expect(out).toContain('Contributing TabSets: default_tabset [default_tabset]');
    expect(out).toContain('Tab "Main" bid=tab_main rid=43 columns=L=6 storage=portal-shared');
    expect(out).toContain('ExtendedTable "Processes" bid=tbl_process rid=44 parentRid=43 columns=L=6 storage=page-child');
    expect(out).not.toContain('mutationRef');
    expect(out).not.toContain('change-target');
  });

  it('reports linked Scorecard ownership as structural facts without prescribing a target', async () => {
    const { projectAiLayout } = await import('../ai-tools');
    const model = {
      pageId: 'instance_118', pageRid: '99', pageName: 'Landing Page', pageClass: 'Scorecard',
      templateRid: '88', templateId: 'landing_template',
      tabsetId: 'tabs', tabs: [], target: 'instance', hasTemplate: true,
    } as any;
    const page = {
      kind: 'page',
      ctx: { pageId: 'instance_118', pageRid: '99', pageClass: 'Scorecard', tabsetId: 'tabs' },
      load: { model, orphans: [] },
    } as any;

    const projection = projectAiLayout('99', page);

    expect(projection.text).not.toContain('target=');
    expect(projection.text).not.toContain('mutationRef');
    expect(projection.modelFacts).toMatchObject({
      viewedRid: '99',
      pageOwnerRid: '99',
      pageTemplateRid: '88',
    });
    expect(projection.uiObjects).toEqual(expect.arrayContaining([
      expect.objectContaining({ rid: '99', businessId: 'instance_118' }),
      expect.objectContaining({ rid: '88', businessId: 'landing_template' }),
    ]));
  });

  it('reports a widget-to-template link without embedding mutation policy', async () => {
    const { projectAiLayout } = await import('../ai-tools');
    const table = {
      id: '119', rid: '919', kind: 'widget', className: 'ExtendedTable', name: 'Navigation',
      cols: { L: 6 }, children: [],
      linkedTemplate: { rid: '818', id: 'navigation_table', className: 'ExtendedTable', name: 'Navigation' },
    } as any;
    const tab = { id: 'main', rid: '717', kind: 'tab', className: 'Tab', name: 'Main', cols: { L: 6 }, children: [table] } as any;
    const model = {
      pageId: 'instance_118', pageRid: '99', pageClass: 'Scorecard', templateRid: '88',
      templateId: 'landing_template', tabsetId: 'tabs', tabs: [tab], target: 'instance', hasTemplate: true,
    } as any;
    const projection = projectAiLayout('99', {
      kind: 'page', ctx: { pageId: 'instance_118', pageRid: '99', tabsetId: 'tabs' },
      load: { model, orphans: [], truncated: false },
    } as any);

    expect(projection.text).not.toContain('change-target');
    expect(projection.text).not.toContain('mutationRef');
    expect(projection.modelFacts.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ rid: '919', kind: 'widget', linkedTemplateRid: '818' }),
    ]));
    expect(projection.uiObjects).toEqual(expect.arrayContaining([
      expect.objectContaining({ rid: '919', businessId: '119' }),
      expect.objectContaining({ rid: '818', businessId: 'navigation_table' }),
    ]));

  });

  it('preserves exact RID and column facts for an object without a business ID', async () => {
    const { projectAiLayout } = await import('../ai-tools');
    const rid = '5238328459709259777';
    const widget = {
      id: rid, rid, kind: 'widget', className: 'TextElement', name: 'Unidentified note',
      cols: { L: 6, M: 3, S: 0 }, children: [],
    } as any;
    const model = {
      pageId: 'page', pageRid: '99', pageClass: 'Scorecard', tabsetId: 'tabs',
      tabs: [widget], target: 'instance', hasTemplate: false,
    } as any;

    const projection = projectAiLayout('99', {
      kind: 'page', ctx: { pageId: 'page', pageRid: '99', tabsetId: 'tabs' },
      load: { model, orphans: [] },
    } as any);

    expect(projection.modelFacts.nodes[0].columns).toEqual({ large: 6, medium: 3, small: 0 });
    expect(projection.modelFacts.nodes[0]).toMatchObject({ rid, kind: 'widget', storage: 'page-child' });
  });

  it('keeps a realistic 24-object layout complete, precise, and below the provider cap', async () => {
    const { projectAiLayout } = await import('../ai-tools');
    let nextRid = 5238328459709259600n;
    const rid = (): string => String(nextRid++);
    const widget = (id: string, name: string, parentRid: string, columns: { L: number; M: number; S: number }) => ({
      id, rid: rid(), kind: 'widget', className: id.includes('nav') ? 'ExtendedTable' : 'TextElement',
      name, cols: columns, children: [], containerRid: parentRid,
    });
    const primaryTabRid = rid();
    const overviewContainerRid = rid();
    const supportContainerRid = rid();
    const secondaryTabRid = rid();
    const footerContainerRid = rid();
    const overviewChildren = [
      widget('qa_header', 'Header', overviewContainerRid, { L: 6, M: 6, S: 6 }),
      widget('qa_navigation', 'Navigation', overviewContainerRid, { L: 2, M: 3, S: 6 }),
    ];
    const supportChildren = [
      widget('qa_documentation', 'Documentation & Support', supportContainerRid, { L: 4, M: 6, S: 6 }),
      widget('qa_bulletin', 'Latest Bulletin', supportContainerRid, { L: 2, M: 0, S: 6 }),
    ];
    const footerChildren = [
      widget('qa_footer', 'Footer', footerContainerRid, { L: 6, M: 6, S: 6 }),
      ...Array.from({ length: 14 }, (_, index) =>
        widget(`qa_extra_${index + 1}`, `Extra ${index + 1}`, footerContainerRid, { L: 3, M: 6, S: 6 })),
    ];
    const primary = {
      id: 'qa_primary', rid: primaryTabRid, kind: 'tab', className: 'Tab', name: 'Primary',
      cols: { L: 6, M: 6, S: 6 }, children: [
        { id: 'qa_overview', rid: overviewContainerRid, kind: 'container', className: 'Container', name: 'Overview', cols: { L: 6, M: 6, S: 6 }, children: overviewChildren },
        { id: 'qa_support', rid: supportContainerRid, kind: 'container', className: 'Container', name: 'Support', cols: { L: 6, M: 6, S: 6 }, children: supportChildren },
      ],
    };
    const secondary = {
      id: 'qa_secondary', rid: secondaryTabRid, kind: 'tab', className: 'Tab', name: 'Secondary',
      cols: { L: 6, M: 6, S: 6 }, children: [
        { id: 'qa_footer_zone', rid: footerContainerRid, kind: 'container', className: 'Container', name: 'Footer zone', cols: { L: 6, M: 6, S: 6 }, children: footerChildren },
      ],
    };
    const model = {
      pageId: 'qa_page', pageRid: '5238328459709259500', pageName: 'Support portal', pageClass: 'Scorecard',
      tabsetId: 'qa_tabs', tabs: [primary, secondary], target: 'instance', hasTemplate: false,
    } as any;

    const projection = projectAiLayout(model.pageRid, {
      kind: 'page', ctx: { pageId: model.pageId, pageRid: model.pageRid, tabsetId: model.tabsetId },
      load: { model, orphans: [] },
    } as any);
    const providerJson = JSON.stringify(toolSuccess('read_layout', projection.modelFacts));

    expect(projection.modelFacts).toMatchObject({ complete: true, totalNodes: 24, returnedNodes: 24, omittedNodes: 0 });
    expect(providerJson.length).toBeLessThanOrEqual(TOOL_RESULT_CAP);
    for (const name of ['Header', 'Navigation', 'Documentation & Support', 'Latest Bulletin', 'Footer']) {
      expect(providerJson).toContain(name);
    }
    expect(projection.modelFacts.nodes.find(node => node.name === 'Latest Bulletin')).toMatchObject({
      parentRid: supportContainerRid,
      columns: { large: 2, medium: 0, small: 6 },
      storage: 'page-child',
    });
    expect(providerJson).not.toMatch(/changeTarget|pageTarget|mutationRef|lookupExpression|targetRid/);
    expect(projection.uiObjects).toHaveLength(25);
  });

  it('bounds large layouts and supports focused subtree follow-up', async () => {
    const { formatAiLayout, projectAiLayout } = await import('../ai-tools');
    const children = Array.from({ length: 100 }, (_, i) => ({
      id: `w${i}`, rid: String(1000 + i), kind: 'widget', className: 'TextElement',
      name: `Widget ${i}`, cols: { L: 6 }, children: [],
    }));
    const tab = {
      id: 'tab_main', rid: '43', kind: 'tab', className: 'Tab',
      name: 'Main', cols: { L: 6 }, children,
    } as any;
    const secondTab = {
      id: 'tab_other', rid: '44', kind: 'tab', className: 'Tab',
      name: 'Secondary', cols: { L: 6 }, children: [],
    } as any;
    const model = {
      pageId: 'page', pageRid: '99', pageClass: 'Scorecard',
      tabsetId: 'tabs', tabs: [tab, secondTab], target: 'instance', hasTemplate: false,
    } as any;
    const page = { kind: 'page', ctx: { pageId: 'page', pageRid: '99', tabsetId: 'tabs' }, load: { model, orphans: [] } } as any;

    const outline = formatAiLayout('99', page);
    expect(outline).toContain('omitted');
    expect(outline).toContain('Tab "Secondary"');
    expect(outline.length).toBeLessThan(9_000);

    const projection = projectAiLayout('99', page);
    expect(projection.text).toBe(outline);
    expect(projection.uiObjects.map(object => object.rid)).toContain('44');
    expect(JSON.stringify(toolSuccess('read_layout', projection.modelFacts)).length).toBeLessThanOrEqual(TOOL_RESULT_CAP);

    const focused = formatAiLayout('99', page, '1005');
    expect(focused).toContain('focused subtree rid=1005 has 1');
    expect(focused).toContain('Widget 5');
    expect(focused).not.toContain('Widget 6');
  });

  it('makes a source-level layout cutoff explicit', async () => {
    const { formatAiLayout } = await import('../ai-tools');
    const tab = {
      id: 'tab', rid: '43', kind: 'tab', className: 'Tab',
      name: 'Main', cols: { L: 6 }, children: [],
    } as any;
    const model = {
      pageId: 'page', pageRid: '99', pageClass: 'Scorecard',
      tabsetId: 'tabs', tabs: [tab], target: 'instance', hasTemplate: false,
    } as any;
    const page = {
      kind: 'page',
      ctx: { pageId: 'page', pageRid: '99', tabsetId: 'tabs' },
      load: { model, orphans: [], truncated: true },
    } as any;

    expect(formatAiLayout('99', page)).toContain('source read reached its safety limit');
  });

  it('shares one short-lived layout load across repeated AI calls', async () => {
    const layoutService = await import('../../layout-service');
    const tab = {
      id: 'tab', rid: '43', kind: 'tab', className: 'Tab',
      name: 'Main', cols: { L: 6 }, children: [],
    } as any;
    const model = {
      pageId: 'page', pageRid: '99', pageClass: 'Scorecard',
      tabsetId: 'tabs', tabs: [tab], target: 'instance', hasTemplate: false,
    } as any;
    const load = vi.spyOn(layoutService, 'loadPageStructure').mockResolvedValue({
      kind: 'page',
      ctx: { pageId: 'page', pageRid: '99', pageClass: 'Scorecard', tabsetId: 'tabs' },
      load: { model, orphans: [] },
    } as any);
    const client = {} as any;
    setSwContext(makeCtx({ client }));
    const { executeAiTool } = await import('../ai-tools');

    await executeAiTool(call('read_layout', { pageRid: '99' }));
    await executeAiTool(call('read_layout', { pageRid: '99', focusRid: '43' }));

    expect(load).toHaveBeenCalledTimes(1);
  });
});
