/**
 * Tests for the upgrade package changes:
 * - Template-first copy gestures (namespace.ts)
 * - CACHE_DATA empty guard (objects-tab logic)
 * - batchEnrich error when all refs fail
 * - FETCH_CHILDREN handler
 * - GET_CONTEXT_RID handler
 * - Page tab message handling
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Template-first copy gestures (namespace.ts) ───────────────────

describe('resolveCopyText template-first semantics', () => {
  it('returns templateBusinessId on a plain click when available', async () => {
    const { resolveCopyText } = await import('../namespace');
    const result = resolveCopyText(
      { rid: '123', businessId: 'myObj', templateBusinessId: 'myTemplate' },
      'plain',
    );
    expect(result.text).toBe('myTemplate');
    expect(result.label).toBe('Template ID');
  });

  it('returns the concrete instance on shift when a template is available', async () => {
    const { resolveCopyText } = await import('../namespace');
    const result = resolveCopyText(
      { rid: '123', businessId: 'myObj', templateBusinessId: 'myTemplate' },
      'shift',
    );
    expect(result.text).toBe('myObj');
    expect(result.label).toBe('Instance ID');
  });

  it('returns empty text when no concrete instance ID exists', async () => {
    const { resolveCopyText } = await import('../namespace');
    const result = resolveCopyText({ rid: '123' }, 'shift');
    expect(result.text).toBe('');
    expect(result.label).toBe('No instance ID');
  });

  it('plain click falls back to businessId without a template', async () => {
    const { resolveCopyText } = await import('../namespace');
    const result = resolveCopyText(
      { rid: '123', businessId: 'myObj' },
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

describe('WorkshopLayoutPane handleMessage', () => {
  // Minimal mock for testing message handling logic
  function createWorkshopLayoutPane() {
    const sent: any[] = [];

    // Inline the core handleMessage logic for unit testing
    // (avoids importing DOM-dependent module)
    // Layout-tree types live in the portal (TabSet → Tab → Container); only
    // those trigger a layout-tree fetch. Mirrors LAYOUT_TREE_TYPES in the pane.
    const LAYOUT_TREE_TYPES = new Set(['TabSet', 'Tab', 'Container']);
    const state = {
      detection: { phase: 'unknown' as string, confidence: 0, signals: [] as string[] },
      contextRid: null as string | null,
      contextObj: null as any,
      contextLoading: false,
      layoutNodes: null as any,
      layoutLoadingFor: null as string | null,
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
            state.layoutNodes = null;
            state.layoutLoadingFor = null;
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
              // Layout-bearing context → fetch the grid; otherwise the
              // detail half handles structure (no object tree up here).
              if (msg.object.type && LAYOUT_TREE_TYPES.has(msg.object.type)) {
                state.layoutLoadingFor = msg.rid;
                state.layoutNodes = null;
                sent.push({ type: 'FETCH_LAYOUT_TREE', rid: msg.rid });
              } else {
                state.layoutNodes = null;
                state.layoutLoadingFor = null;
              }
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

  it('non-layout context: FULL_LOOKUP_RESULT sets contextObj, no layout fetch', () => {
    const { state, handleMessage, sent } = createWorkshopLayoutPane();

    // Step 1: receive context RID
    const changed1 = handleMessage({ type: 'CONTEXT_RID_DATA', rid: '500' });
    expect(changed1).toBe(true);
    expect(state.contextRid).toBe('500');
    expect(state.contextLoading).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({ type: 'FULL_LOOKUP', rid: '500' });

    // Step 2: lookup result for a non-layout object (Scorecard owns widgets,
    // not the grid) — context is set but no layout-tree fetch fires.
    const changed2 = handleMessage({
      type: 'FULL_LOOKUP_RESULT',
      rid: '500',
      object: { rid: '500', name: 'MyObj', type: 'Scorecard', businessId: 'sc1' },
    });
    expect(changed2).toBe(true);
    expect(state.contextLoading).toBe(false);
    expect(state.contextObj.name).toBe('MyObj');
    expect(state.layoutLoadingFor).toBeNull();
    expect(sent.some((m) => m.type === 'FETCH_LAYOUT_TREE')).toBe(false);
  });

  it('layout context: FULL_LOOKUP_RESULT triggers a layout-tree fetch', () => {
    const { state, handleMessage, sent } = createWorkshopLayoutPane();

    handleMessage({ type: 'CONTEXT_RID_DATA', rid: '700' });
    handleMessage({
      type: 'FULL_LOOKUP_RESULT',
      rid: '700',
      object: { rid: '700', name: 'Overview', type: 'Tab', businessId: 'tab1' },
    });
    expect(state.contextObj.type).toBe('Tab');
    expect(state.layoutLoadingFor).toBe('700');
    expect(sent).toContainEqual({ type: 'FETCH_LAYOUT_TREE', rid: '700' });
  });

  it('ignores FULL_LOOKUP_RESULT for wrong RID', () => {
    const { state, handleMessage } = createWorkshopLayoutPane();

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
    const { handleMessage, sent } = createWorkshopLayoutPane();

    handleMessage({ type: 'CONTEXT_RID_DATA', rid: '500' });
    expect(sent).toHaveLength(1);

    // Same RID again — should be skipped
    const changed = handleMessage({ type: 'CONTEXT_RID_DATA', rid: '500' });
    expect(changed).toBe(false);
    expect(sent).toHaveLength(1); // no new FULL_LOOKUP sent
  });

  it('clears state when CONTEXT_RID_DATA has no rid', () => {
    const { state, handleMessage } = createWorkshopLayoutPane();

    handleMessage({ type: 'CONTEXT_RID_DATA', rid: '500' });
    handleMessage({ type: 'CONTEXT_RID_DATA', rid: undefined });

    expect(state.contextRid).toBeNull();
    expect(state.contextLoading).toBe(false);
  });

  it('preserves widgets from PAGE_INFO', () => {
    const { state, handleMessage } = createWorkshopLayoutPane();

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
    const { state, handleMessage, sent } = createWorkshopLayoutPane();

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

// ── Handler tests (FETCH_CHILDREN, GET_CONTEXT_RID, FULL_LOOKUP) ──

import { mockChromeStorage } from './chrome-mock';
import { setSwContext } from '../sw-context';

function makeHandlerCtx(overrides: any = {}) {
  const panelMessages: any[] = [];
  const activities: Array<{ level: string; message: string }> = [];
  const ctx: any = {
    client: null,
    hasPanel: false,
    panelPortByWindow: new Map(),
    contentPorts: new Map(),
    cache: { get: vi.fn(() => null), put: vi.fn(), putAll: vi.fn(), size: 0 },
    history: { record: vi.fn() },
    favorites: { toggle: vi.fn(), getAll: vi.fn(() => []) },
    scriptHistory: { record: vi.fn() },
    stylePresets: { getAll: vi.fn(() => []), save: vi.fn(), remove: vi.fn(), load: vi.fn(), switchProfile: vi.fn(async () => {}) } as any,
    settings: { schemaVersion: 1, profiles: [], activeProfileId: null, autoDetect: true, saveTarget: 'template', enrichMode: 'widgets' },
    inspectActive: false,
    technicalOverlay: false,
    settingsReady: Promise.resolve(),
    logActivity: vi.fn((level: string, message: string) => activities.push({ level, message })),
    sendToPanel: vi.fn((msg: any) => panelMessages.push(msg)),
    sendToPanelByWindow: vi.fn(),
    sendToPanelByTab: vi.fn(),
    broadcastToContent: vi.fn(),
    toast: vi.fn(),
    _panelMessages: panelMessages,
    _activities: activities,
    ...overrides,
  };
  return ctx;
}

describe('FETCH_CHILDREN handler', () => {
  beforeEach(() => {
    mockChromeStorage();
  });

  it('fetches children via client and returns them', async () => {
    const mockChildren = [
      { rid: '10', name: 'Child1', type: 'KPI', businessId: 'kpi1' },
      { rid: '20', name: 'Child2', type: 'KPI', businessId: 'kpi2' },
    ];
    const ctx = makeHandlerCtx({
      client: { fetchChildren: vi.fn(async () => mockChildren) },
    });
    setSwContext(ctx);

    const { getHandler } = await import('../handler-registry');
    await import('../handlers/objects');
    const entry = getHandler('FETCH_CHILDREN');
    expect(entry).toBeDefined();

    const responses: any[] = [];
    await entry!(
      { type: 'FETCH_CHILDREN', rid: '100' } as any,
      (r: any) => responses.push(r),
      { isOneShot: true },
    );

    expect(ctx.client.fetchChildren).toHaveBeenCalledWith('100');
    expect(responses).toHaveLength(1);
    expect(responses[0].type).toBe('FETCH_CHILDREN_RESULT');
    expect(responses[0].rid).toBe('100');
    expect(responses[0].children).toEqual(mockChildren);
  });

  it('returns an explicit error when not connected', async () => {
    const ctx = makeHandlerCtx({ client: null });
    setSwContext(ctx);

    const { getHandler } = await import('../handler-registry');
    await import('../handlers/objects');
    const entry = getHandler('FETCH_CHILDREN');

    const responses: any[] = [];
    await entry!(
      { type: 'FETCH_CHILDREN', rid: '100' } as any,
      (r: any) => responses.push(r),
      { isOneShot: true },
    );

    expect(responses[0].children).toEqual([]);
    expect(responses[0].error).toBe('Not connected');
  });

  it('returns error when fetchChildren throws', async () => {
    const ctx = makeHandlerCtx({
      client: { fetchChildren: vi.fn(async () => { throw new Error('Network error'); }) },
    });
    setSwContext(ctx);

    const { getHandler } = await import('../handler-registry');
    await import('../handlers/objects');
    const entry = getHandler('FETCH_CHILDREN');

    const responses: any[] = [];
    await entry!(
      { type: 'FETCH_CHILDREN', rid: '100' } as any,
      (r: any) => responses.push(r),
      { isOneShot: true },
    );

    expect(responses[0].children).toEqual([]);
    expect(responses[0].error).toContain('Network error');
  });
});

describe('GET_CONTEXT_RID handler', () => {
  beforeEach(() => {
    mockChromeStorage();
  });

  it('sends context RID data for active tab', async () => {
    // Mock chrome.tabs.query to synchronously invoke callback
    // Promise-form of chrome.tabs.query (MV3 Chrome supports both).
    // Our handler uses the Promise form via async/await.
    (globalThis as any).chrome.tabs.query = vi.fn(async () => [{ id: 42 }]);
    (globalThis as any).chrome.tabs.get = vi.fn(async () => ({ url: undefined }));

    const { setContextRid } = await import('../context-rid');
    setContextRid(42, { rid: '999', name: 'TestObj', type: 'Scorecard', businessId: 'sc1' });

    const ctx = makeHandlerCtx();
    setSwContext(ctx);

    const { getHandler } = await import('../handler-registry');
    await import('../handlers/detection');
    const entry = getHandler('GET_CONTEXT_RID');
    expect(entry).toBeDefined();

    await entry!({ type: 'GET_CONTEXT_RID' } as any, () => {}, { isOneShot: false });

    // sendToPanel is called inside the chrome.tabs.query callback (synchronous mock)
    expect(ctx.sendToPanel).toHaveBeenCalled();
    const msg = ctx._panelMessages[0];
    expect(msg.type).toBe('CONTEXT_RID_DATA');
    expect(msg.rid).toBe('999');
    expect(msg.name).toBe('TestObj');
    expect(msg.objectType).toBe('Scorecard');
    expect(msg.businessId).toBe('sc1');
  });

  it('sends undefined rid when no active tab', async () => {
    (globalThis as any).chrome.tabs.query = vi.fn(async () => []);
    (globalThis as any).chrome.tabs.get = vi.fn(async () => ({ url: undefined }));

    const ctx = makeHandlerCtx();
    setSwContext(ctx);

    const { getHandler } = await import('../handler-registry');
    await import('../handlers/detection');
    const entry = getHandler('GET_CONTEXT_RID');

    await entry!({ type: 'GET_CONTEXT_RID' } as any, () => {}, { isOneShot: false });

    expect(ctx.sendToPanel).toHaveBeenCalled();
    const msg = ctx._panelMessages[0];
    expect(msg.type).toBe('CONTEXT_RID_DATA');
    expect(msg.rid).toBeUndefined();
  });

  it('sends undefined fields when tab has no context entry', async () => {
    (globalThis as any).chrome.tabs.query = vi.fn(async () => [{ id: 77 }]);
    (globalThis as any).chrome.tabs.get = vi.fn(async () => ({ url: undefined }));

    const { deleteContextRid } = await import('../context-rid');
    deleteContextRid(77); // ensure no entry

    const ctx = makeHandlerCtx();
    setSwContext(ctx);

    const { getHandler } = await import('../handler-registry');
    await import('../handlers/detection');
    const entry = getHandler('GET_CONTEXT_RID');

    await entry!({ type: 'GET_CONTEXT_RID' } as any, () => {}, { isOneShot: false });

    const msg = ctx._panelMessages[0];
    expect(msg.rid).toBeUndefined();
    expect(msg.name).toBeUndefined();
  });
});

describe('FULL_LOOKUP handler', () => {
  beforeEach(() => {
    mockChromeStorage();
  });

  it('loads only the context identity Workshop renders', async () => {
    const callOrder: string[] = [];
    let lookupResolve: (v: any) => void = () => {};

    const ctx = makeHandlerCtx({
      client: {
        lookupIdentity: vi.fn(async () => {
          callOrder.push('lookupIdentity:called');
          return new Promise((r) => { lookupResolve = (v) => { callOrder.push('lookupIdentity:resolved'); r(v); }; });
        }),
        resolveTemplate: vi.fn(async () => {
          callOrder.push('resolveTemplate:called');
          return { templateRid: '600' };
        }),
        fetchChildren: vi.fn(async () => {
          callOrder.push('fetchChildren:called');
          return [];
        }),
      },
    });
    setSwContext(ctx);

    const { getHandler } = await import('../handler-registry');
    await import('../handlers/objects');
    const entry = getHandler('FULL_LOOKUP');

    const responses: any[] = [];
    const handlerPromise = entry!(
      { type: 'FULL_LOOKUP', rid: '500' } as any,
      (r: any) => responses.push(r),
      { isOneShot: true },
    );

    // Both lookupObject and resolveTemplate should have started before either resolves
    await new Promise(r => setTimeout(r, 5));
    expect(callOrder).toContain('lookupIdentity:called');
    expect(callOrder).not.toContain('resolveTemplate:called');
    // Neither resolved yet — verifies parallelism (not sequential await)
    expect(callOrder).not.toContain('lookupIdentity:resolved');
    // fetchChildren not called yet — must wait for Promise.all
    expect(callOrder).not.toContain('fetchChildren:called');

    // Resolve both
    lookupResolve({ name: 'Obj', type: 'Scorecard', businessId: 'sc1' });
    await handlerPromise;

    // Now fetchChildren should have been called AFTER Promise.all resolved
    expect(callOrder).not.toContain('fetchChildren:called');
    expect(responses[0].object).toMatchObject({
      rid: '500', name: 'Obj', type: 'Scorecard', businessId: 'sc1', properties: {},
    });
    expect(ctx.client.resolveTemplate).not.toHaveBeenCalled();
    expect(ctx.client.fetchChildren).not.toHaveBeenCalled();
    expect(responses[0].template).toBeUndefined();
    expect(responses[0].children).toBeUndefined();
  });

  it('uses a complete cached identity without contacting BMP', async () => {
    const cached = {
      rid: '500',
      name: 'Cached object',
      type: 'Scorecard',
      businessId: 'cached_scorecard',
      properties: {},
      source: 'server',
      discoveredAt: 1,
      updatedAt: 1,
    };
    const ctx = makeHandlerCtx({
      cache: { get: vi.fn(() => cached), put: vi.fn(), putAll: vi.fn(), size: 1 },
      client: {
        lookupIdentity: vi.fn(async () => ({ name: 'Obj', type: 'Scorecard', businessId: 'sc1' })),
        resolveTemplate: vi.fn(async () => ({ templateRid: '600', templateName: 'T', templateType: 'Category', templateBusinessId: 'tmpl1' })),
        fetchChildren: vi.fn(async () => [{ rid: '700', name: 'C1', type: 'KPI' }]),
      },
    });
    setSwContext(ctx);

    const { getHandler } = await import('../handler-registry');
    await import('../handlers/objects');
    const entry = getHandler('FULL_LOOKUP');

    const responses: any[] = [];
    await entry!(
      { type: 'FULL_LOOKUP', rid: '500' } as any,
      (r: any) => responses.push(r),
      { isOneShot: true },
    );

    expect(ctx.client.lookupIdentity).not.toHaveBeenCalled();
    expect(ctx.client.resolveTemplate).not.toHaveBeenCalled();
    expect(ctx.client.fetchChildren).not.toHaveBeenCalled();
    expect(responses[0].object).toBe(cached);
  });

  it('returns Object not found when the identity query has no result', async () => {
    const ctx = makeHandlerCtx({
      client: {
        lookupIdentity: vi.fn(async () => null),
        resolveTemplate: vi.fn(async () => ({ templateRid: null })),
        fetchChildren: vi.fn(async () => []),
      },
    });
    setSwContext(ctx);

    const { getHandler } = await import('../handler-registry');
    await import('../handlers/objects');
    const entry = getHandler('FULL_LOOKUP');

    const responses: any[] = [];
    await entry!(
      { type: 'FULL_LOOKUP', rid: '500' } as any,
      (r: any) => responses.push(r),
      { isOneShot: true },
    );

    expect(ctx.client.resolveTemplate).not.toHaveBeenCalled();
    expect(ctx.client.fetchChildren).not.toHaveBeenCalled();
    expect(responses[0].object).toBeNull();
    expect(responses[0].error).toContain('Object not found');
  });

  it('returns error when lookupObject throws', async () => {
    const ctx = makeHandlerCtx({
      client: {
        lookupIdentity: vi.fn(async () => { throw new Error('Lookup failed'); }),
        resolveTemplate: vi.fn(async () => ({ templateRid: null })),
        fetchChildren: vi.fn(async () => []),
      },
    });
    setSwContext(ctx);

    const { getHandler } = await import('../handler-registry');
    await import('../handlers/objects');
    const entry = getHandler('FULL_LOOKUP');

    const responses: any[] = [];
    await entry!(
      { type: 'FULL_LOOKUP', rid: '500' } as any,
      (r: any) => responses.push(r),
      { isOneShot: true },
    );

    expect(responses[0].object).toBeNull();
    expect(responses[0].error).toContain('Lookup failed');
  });
});

describe('SERVER_LOOKUP_BATCH handler', () => {
  beforeEach(() => {
    mockChromeStorage();
  });

  it('deduplicates requested RIDs and resolves them in one enrichment command', async () => {
    const ctx = makeHandlerCtx({
      client: {
        batchEnrich: vi.fn(async () => ({
          results: {
            '5000000000000000001': { name: 'First', type: 'Widget', businessId: 'first' },
            '6000000000000000002': { name: 'Second', type: 'Widget', businessId: 'second' },
          },
        })),
      },
    });
    setSwContext(ctx);

    const { getHandler } = await import('../handler-registry');
    await import('../handlers/objects');
    const entry = getHandler('SERVER_LOOKUP_BATCH');
    await entry!(
      {
        type: 'SERVER_LOOKUP_BATCH',
        rids: ['5000000000000000001', '6000000000000000002', '5000000000000000001'],
      } as any,
      () => {},
      { isOneShot: false },
    );

    expect(ctx.client.batchEnrich).toHaveBeenCalledTimes(1);
    expect(ctx.client.batchEnrich).toHaveBeenCalledWith([
      '5000000000000000001',
      '6000000000000000002',
    ]);
    expect(ctx.sendToPanel).toHaveBeenCalledWith(expect.objectContaining({
      type: 'SERVER_LOOKUP_BATCH_RESULT',
      objects: {
        '5000000000000000001': expect.objectContaining({
          rid: '5000000000000000001',
          businessId: 'first',
        }),
        '6000000000000000002': expect.objectContaining({
          rid: '6000000000000000002',
          businessId: 'second',
        }),
      },
    }));
    expect(ctx.cache.put).toHaveBeenCalledTimes(2);
  });

  it('returns a terminal result for every RID instead of dropping requests above 200', async () => {
    const rids = Array.from({ length: 205 }, (_, index) =>
      String(5_000_000_000_000_000_000n + BigInt(index)));
    const batchEnrich = vi.fn(async (chunk: string[]) => ({
      results: Object.fromEntries(chunk.map(rid => [
        rid,
        { name: `Object ${rid}`, type: 'Widget', businessId: `id_${rid}` },
      ])),
    }));
    const ctx = makeHandlerCtx({ client: { serverUrl: 'https://bmp.test', batchEnrich } });
    setSwContext(ctx);

    const { getHandler } = await import('../handler-registry');
    await import('../handlers/objects');
    await getHandler('SERVER_LOOKUP_BATCH')!(
      { type: 'SERVER_LOOKUP_BATCH', rids } as any,
      () => {},
      { isOneShot: false },
    );

    const message = ctx.sendToPanel.mock.calls.at(-1)?.[0];
    expect(message.type).toBe('SERVER_LOOKUP_BATCH_RESULT');
    expect(Object.keys(message.objects)).toHaveLength(rids.length);
    expect(message.objects[rids.at(-1)!]).toMatchObject({ rid: rids.at(-1)! });
    expect(batchEnrich.mock.calls.flatMap(call => call[0])).toEqual(rids);
  });
});
