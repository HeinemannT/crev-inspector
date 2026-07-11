/**
 * Phase 1 AI chat backend — handler routing + defensive tool execution.
 * The tool layer must never throw: bad refs / no connection / EC errors all
 * come back as readable isError results the model can adapt to.
 */
import { describe, it, expect, vi } from 'vitest';
import { mockChromeStorage } from '../../__tests__/chrome-mock';
import { setSwContext } from '../../sw-context';
import type { ToolCall } from '../../ai/tools';

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

describe('AI chat handler routing', () => {
  it('registers every Phase 1 chat message handler', async () => {
    mockChromeStorage();
    setSwContext(makeCtx());
    const { getHandler } = await import('../../handler-registry');
    await import('../ai');
    for (const t of ['AI_CHAT_SEND', 'AI_CHAT_CANCEL', 'AI_PREVIEW_CODE', 'AI_APPLY_PROPOSAL', 'AI_CHAT_HANDOFF', 'AI_OPEN_IN_EDITOR']) {
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
});
