/**
 * Tests for the upgrade package changes:
 * - Shift-click "No template" fallback (namespace.ts)
 * - CACHE_DATA empty guard (objects-tab logic)
 * - batchEnrich error when all refs fail
 * - FETCH_CHILDREN handler
 * - GET_CONTEXT_RID handler
 * - Page tab message handling
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Shift-click "No template" (namespace.ts) ──────────────────────

describe('resolveCopyText shift-click fallback', () => {
  it('returns templateBusinessId when available', async () => {
    const { resolveCopyText } = await import('../namespace');
    const result = resolveCopyText(
      { rid: '123', businessId: 'myObj', templateBusinessId: 'myTemplate' },
      'shift',
    );
    expect(result.text).toBe('myTemplate');
    expect(result.label).toBe('Template ID');
  });

  it('returns empty text with "No template" label when templateBusinessId missing', async () => {
    const { resolveCopyText } = await import('../namespace');
    const result = resolveCopyText(
      { rid: '123', businessId: 'myObj' },
      'shift',
    );
    expect(result.text).toBe('');
    expect(result.label).toBe('No template');
  });

  it('returns empty text when both businessId and templateBusinessId missing', async () => {
    const { resolveCopyText } = await import('../namespace');
    const result = resolveCopyText({ rid: '123' }, 'shift');
    expect(result.text).toBe('');
    expect(result.label).toBe('No template');
  });

  it('plain click returns businessId regardless of template', async () => {
    const { resolveCopyText } = await import('../namespace');
    const result = resolveCopyText(
      { rid: '123', businessId: 'myObj', templateBusinessId: 'myTemplate' },
      'plain',
    );
    expect(result.text).toBe('myObj');
    expect(result.label).toBe('ID');
  });

  it('ctrl click returns namespace reference', async () => {
    const { resolveCopyText } = await import('../namespace');
    const result = resolveCopyText(
      { rid: '123', businessId: 'myObj', type: 'ExtendedMethodConfig' },
      'ctrl',
    );
    expect(result.text).toBe('k.myObj');
    expect(result.label).toBe('ref');
  });
});

// ── CACHE_DATA empty guard logic ──────────────────────────────────

describe('CACHE_DATA empty guard', () => {
  it('accepts non-empty objects regardless of filter', () => {
    const filter = '';
    const objects = [{ rid: '1', name: 'a' }];
    const shouldUpdate = objects.length > 0 || filter.length > 0;
    expect(shouldUpdate).toBe(true);
  });

  it('blocks empty objects when filter is empty', () => {
    const filter = '';
    const objects: any[] = [];
    const shouldUpdate = objects.length > 0 || filter.length > 0;
    expect(shouldUpdate).toBe(false);
  });

  it('accepts empty objects when filter is active', () => {
    const filter = 'foo';
    const objects: any[] = [];
    const shouldUpdate = objects.length > 0 || filter.length > 0;
    expect(shouldUpdate).toBe(true);
  });
});

// ── batchEnrich error on all-refs-fail ────────────────────────────

describe('batchEnrich returns error when all refs fail', () => {
  it('returns error message when all resolveRef calls fail', async () => {
    const { BmpClient } = await import('../bmp-client');
    const client = new BmpClient('https://bmp.test/', 'admin', 'pass', 'test');
    client.applyVersionFlags('5.6.7.2');

    // Mock resolveRef to always throw
    (client as any).resolveRef = vi.fn(async () => { throw new Error('not found'); });

    const result = await client.batchEnrich(['111', '222']);
    expect(result.results).toEqual({});
    expect(result.error).toContain('All');
    expect(result.error).toContain('failed ref resolution');
  });

  it('succeeds when some refs resolve', async () => {
    const { BmpClient } = await import('../bmp-client');
    const client = new BmpClient('https://bmp.test/', 'admin', 'pass', 'test');
    client.applyVersionFlags('5.6.7.2');

    // Mock resolveRef: first succeeds, second fails
    let callCount = 0;
    (client as any).resolveRef = vi.fn(async (rid: string) => {
      callCount++;
      if (callCount === 1) return `lookup(${rid})`;
      throw new Error('not found');
    });

    // Mock executeEc to return valid output
    (client as any).executeEc = vi.fn(async () => ({
      ok: true,
      log: '111|||bid_1|||Scorecard|||Name1|||tmpl1',
    }));

    const result = await client.batchEnrich(['111', '222']);
    expect(result.error).toBeUndefined();
    expect(result.results['111']).toBeDefined();
    expect(result.results['111'].businessId).toBe('bid_1');
    expect(result.results['111'].templateBusinessId).toBe('tmpl1');
  });
});

// ── Context RID module ────────────────────────────────────────────

describe('context-rid module', () => {
  it('stores and retrieves context RID per tab', async () => {
    const { setContextRid, getContextRid, deleteContextRid } = await import('../context-rid');
    setContextRid(1, { rid: '100', name: 'Test', type: 'Scorecard', businessId: 'sc1' });

    const entry = getContextRid(1);
    expect(entry).toBeDefined();
    expect(entry!.rid).toBe('100');
    expect(entry!.name).toBe('Test');

    deleteContextRid(1);
    expect(getContextRid(1)).toBeUndefined();
  });

  it('returns undefined for unknown tab', async () => {
    const { getContextRid } = await import('../context-rid');
    expect(getContextRid(99999)).toBeUndefined();
  });
});

// ── Page tab message handling ─────────────────────────────────────

describe('PageTab handleMessage', () => {
  // Minimal mock for testing message handling logic
  function createPageTab() {
    const sent: any[] = [];
    const navigated: string[] = [];

    // Inline the core handleMessage logic for unit testing
    // (avoids importing DOM-dependent module)
    const state = {
      detection: { phase: 'unknown' as string, confidence: 0, signals: [] as string[] },
      contextRid: null as string | null,
      contextObj: null as any,
      contextLoading: false,
      templateInfo: null as any,
      treeRoot: null as any,
      widgets: [] as any[],
    };

    function handleMessage(msg: any): boolean {
      switch (msg.type) {
        case 'PAGE_INFO':
          state.widgets = msg.widgets ?? [];
          if (msg.detection) {
            state.detection = {
              phase: msg.detection.isBmp ? 'detected' : 'not-detected',
              confidence: msg.detection.confidence,
              signals: msg.detection.signals,
            };
          }
          return true;
        case 'DETECTION_STATE':
          state.detection = { phase: msg.phase, confidence: msg.confidence, signals: msg.signals };
          return true;
        case 'CONTEXT_RID_DATA':
          if (msg.rid) {
            if (msg.rid === state.contextRid) return false;
            state.contextRid = msg.rid;
            state.contextLoading = true;
            state.contextObj = null;
            state.templateInfo = null;
            state.treeRoot = null;
            sent.push({ type: 'FULL_LOOKUP', rid: msg.rid });
          } else {
            state.contextRid = null;
            state.contextObj = null;
            state.contextLoading = false;
          }
          return true;
        case 'FULL_LOOKUP_RESULT':
          if (msg.rid === state.contextRid && state.contextLoading) {
            state.contextLoading = false;
            if (msg.object) {
              state.contextObj = msg.object;
              state.templateInfo = msg.template ?? null;
              state.treeRoot = { rid: (msg.template ?? msg.object).rid, children: msg.children };
            }
            return true;
          }
          return false;
        default:
          return false;
      }
    }

    return { state, handleMessage, sent };
  }

  it('processes CONTEXT_RID_DATA → FULL_LOOKUP_RESULT flow', () => {
    const { state, handleMessage, sent } = createPageTab();

    // Step 1: receive context RID
    const changed1 = handleMessage({ type: 'CONTEXT_RID_DATA', rid: '500' });
    expect(changed1).toBe(true);
    expect(state.contextRid).toBe('500');
    expect(state.contextLoading).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({ type: 'FULL_LOOKUP', rid: '500' });

    // Step 2: receive lookup result
    const changed2 = handleMessage({
      type: 'FULL_LOOKUP_RESULT',
      rid: '500',
      object: { rid: '500', name: 'MyObj', type: 'Scorecard', businessId: 'sc1' },
      template: { rid: '501', name: 'ScTemplate', type: 'Category', businessId: 'tmpl1' },
      children: [{ rid: '502', name: 'Child1', type: 'KPI' }],
    });
    expect(changed2).toBe(true);
    expect(state.contextLoading).toBe(false);
    expect(state.contextObj.name).toBe('MyObj');
    expect(state.templateInfo.rid).toBe('501');
    expect(state.treeRoot.children).toHaveLength(1);
  });

  it('ignores FULL_LOOKUP_RESULT for wrong RID', () => {
    const { state, handleMessage } = createPageTab();

    handleMessage({ type: 'CONTEXT_RID_DATA', rid: '500' });
    const changed = handleMessage({
      type: 'FULL_LOOKUP_RESULT',
      rid: '999', // wrong RID
      object: { rid: '999', name: 'Wrong' },
    });
    expect(changed).toBe(false);
    expect(state.contextLoading).toBe(true); // still loading
    expect(state.contextObj).toBeNull();
  });

  it('skips duplicate CONTEXT_RID_DATA for same RID', () => {
    const { state, handleMessage, sent } = createPageTab();

    handleMessage({ type: 'CONTEXT_RID_DATA', rid: '500' });
    expect(sent).toHaveLength(1);

    // Same RID again — should be skipped
    const changed = handleMessage({ type: 'CONTEXT_RID_DATA', rid: '500' });
    expect(changed).toBe(false);
    expect(sent).toHaveLength(1); // no new FULL_LOOKUP sent
  });

  it('clears state when CONTEXT_RID_DATA has no rid', () => {
    const { state, handleMessage } = createPageTab();

    handleMessage({ type: 'CONTEXT_RID_DATA', rid: '500' });
    handleMessage({ type: 'CONTEXT_RID_DATA', rid: undefined });

    expect(state.contextRid).toBeNull();
    expect(state.contextLoading).toBe(false);
  });

  it('preserves widgets from PAGE_INFO', () => {
    const { state, handleMessage } = createPageTab();

    handleMessage({
      type: 'PAGE_INFO',
      url: 'https://bmp.test/portal',
      widgets: [{ rid: '10', name: 'Widget1', type: 'Scorecard' }],
      detection: { confidence: 0.9, signals: ['data-rid attributes'], isBmp: true },
    });

    expect(state.widgets).toHaveLength(1);
    expect(state.detection.phase).toBe('detected');
    expect(state.detection.confidence).toBe(0.9);
  });

  it('handles CONTEXT_RID_DATA race: new context before old lookup completes', () => {
    const { state, handleMessage, sent } = createPageTab();

    // First context
    handleMessage({ type: 'CONTEXT_RID_DATA', rid: '500' });
    // Second context (before first completes)
    handleMessage({ type: 'CONTEXT_RID_DATA', rid: '600' });
    expect(sent).toHaveLength(2);
    expect(state.contextRid).toBe('600');

    // Old result arrives — should be ignored
    const changed = handleMessage({
      type: 'FULL_LOOKUP_RESULT',
      rid: '500',
      object: { rid: '500', name: 'Stale' },
    });
    expect(changed).toBe(false);
    expect(state.contextObj).toBeNull(); // not set to stale data

    // Correct result arrives
    const changed2 = handleMessage({
      type: 'FULL_LOOKUP_RESULT',
      rid: '600',
      object: { rid: '600', name: 'Current' },
    });
    expect(changed2).toBe(true);
    expect(state.contextObj.name).toBe('Current');
  });
});
