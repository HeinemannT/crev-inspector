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

describe('AI chat handler routing', () => {
  it('registers every Phase 1 chat message handler', async () => {
    mockChromeStorage();
    setSwContext(makeCtx());
    const { getHandler } = await import('../../handler-registry');
    await import('../ai');
    for (const t of ['AI_CHAT_SEND', 'AI_CHAT_CANCEL', 'AI_PREVIEW_CODE', 'AI_APPLY_PROPOSAL', 'AI_INSERT_AT_CURSOR', 'AI_CHAT_HANDOFF', 'AI_OPEN_IN_EDITOR']) {
      expect(getHandler(t), t).toBeDefined();
    }
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

  it('query_context makes missing-property warnings visible to the model', async () => {
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
    expect(res.content).toContain('Missing-value warnings are expected');
    expect(res.content).toContain('Retry only if a specifically requested field is absent');
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

  it('read_object uses a supplied numeric rid directly', async () => {
    mockChromeStorage();
    const executeEc = vi.fn();
    const fetchObjectPane = vi.fn(async () => ({
      instance: { rid: '42', businessId: 'tbl_42', name: 'Processes', type: 'ExtendedTable' },
      template: null, parent: null, instanceProps: {}, templateProps: {}, contextValues: {}, references: {}, codeFields: {},
    }));
    setSwContext(makeCtx({ client: { executeEc, fetchObjectPane } }));
    const { executeAiTool } = await import('../ai-tools');

    const res = await executeAiTool(call('read_object', { ref: '42' }));

    expect(res.isError).toBe(false);
    expect(fetchObjectPane).toHaveBeenCalledWith('42', undefined);
    expect(executeEc).not.toHaveBeenCalled();
  });

  it('read_code returns raw ExtendedTable expression by rid without resolving it again', async () => {
    mockChromeStorage();
    const executeEc = vi.fn();
    const fetchCodeViaEc = vi.fn(async () => ({ expression: 'rows := LIST()\nrows' }));
    setSwContext(makeCtx({ client: { executeEc, fetchCodeViaEc } }));
    const { executeAiTool } = await import('../ai-tools');

    const res = await executeAiTool(call('read_code', { ref: '42', property: 'expression' }));

    expect(res.isError).toBe(false);
    expect(fetchCodeViaEc).toHaveBeenCalledWith('42', ['expression']);
    expect(executeEc).not.toHaveBeenCalled();
    expect(res.content).toContain('```extended\nrows := LIST()');
    expect(res.content).toContain('answer from this source now');
    expect(res.content).toContain('do not call query_context');
  });

  it('formats Blueprint layout as portal structure plus page-owned code-bearing widgets', async () => {
    const { formatAiLayout } = await import('../ai-tools');
    const table = { id: 'tbl_process', rid: '44', kind: 'widget', className: 'ExtendedTable', name: 'Processes', cols: { L: 6 }, children: [] } as any;
    const tab = { id: 'tab_main', rid: '43', kind: 'tab', className: 'Tab', name: 'Main', cols: { L: 6 }, children: [table] } as any;
    const model = { pageId: 'ent_process', pageRid: '99', pageName: 'Process template', pageClass: 'EnterpriseTemplate', tabsetId: 'default_tabset', tabs: [tab], target: 'instance', hasTemplate: false } as any;
    const out = formatAiLayout('12', { kind: 'page', ctx: { pageId: 'ent_process', pageRid: '99', tabsetId: 'default_tabset' }, load: { model, baseline: model, orphans: [] } } as any);

    expect(out).toContain('viewed enterprise instance → .template page owner');
    expect(out).toContain('Tab "Main" bid=tab_main rid=43 span=6 model=portal-shared');
    expect(out).toContain('ExtendedTable "Processes" bid=tbl_process rid=44 span=6 model=page-child code=expression,html,javascript');
  });
});
