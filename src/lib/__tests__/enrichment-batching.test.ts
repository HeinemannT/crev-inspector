/**
 * Full enrichment pipeline tests with mock BmpClient.
 * Tests enrichBadges() from enrichment.ts with real RIDs and controlled mock behavior.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockChromeStorage } from './chrome-mock';
import { ALL_RIDS, ORG_RIDS } from './test-rids';
import { enrichBadges, resetEnrichment, incrementGeneration } from '../enrichment';
import type { SwContext } from '../sw-context';
import { setSwContext } from '../sw-context';
import type { BmpObject, InspectorMessage } from '../types';

// ── Mock factory ──

interface MockOpts {
  batchDelay?: number;
  failChunks?: number[];
  missingRids?: Set<string>;
}

function createMockContext(opts: MockOpts = {}) {
  const { batchDelay = 0, failChunks = [], missingRids = new Set() } = opts;

  let callCount = 0;
  let running = 0;
  let maxRunning = 0;
  const calledWith: string[][] = [];

  const mockClient = {
    supportsLookup: true,
    batchEnrich: vi.fn(async (rids: string[]) => {
      const chunkIndex = callCount++;
      calledWith.push([...rids]);
      running++;
      if (running > maxRunning) maxRunning = running;

      if (batchDelay > 0) await new Promise(r => setTimeout(r, batchDelay));

      running--;

      if (failChunks.includes(chunkIndex)) {
        return { results: {} as Record<string, any>, error: `Chunk ${chunkIndex} failed` };
      }

      const results: Record<string, { businessId?: string; type?: string; name?: string }> = {};
      for (const rid of rids) {
        if (!missingRids.has(rid)) {
          results[rid] = { businessId: `BID-${rid.slice(-4)}`, type: 'TestType', name: `Object ${rid.slice(-4)}` };
        }
      }
      return { results };
    }),
    getObjects: vi.fn(async (rids: string[]) => {
      const results: Record<string, BmpObject> = {};
      for (const rid of rids) {
        results[rid] = {
          rid, name: `Fallback ${rid.slice(-4)}`, type: 'Fallback', businessId: `FB-${rid.slice(-4)}`,
          source: 'server' as const, discoveredAt: Date.now(), updatedAt: Date.now(),
        };
      }
      return results;
    }),
    jwt: 'mock-jwt',
  };

  const cacheStore = new Map<string, BmpObject>();
  const mockCache = {
    get: vi.fn((rid: string) => cacheStore.get(rid)),
    put: vi.fn((obj: BmpObject) => cacheStore.set(obj.rid, obj)),
    putAll: vi.fn((objs: BmpObject[]) => { for (const obj of objs) cacheStore.set(obj.rid, obj); }),
    get size() { return cacheStore.size; },
    load: vi.fn(async () => {}),
    flush: vi.fn(async () => {}),
  };

  const logMessages: string[] = [];
  const panelMessages: InspectorMessage[] = [];

  const ctx: SwContext = {
    client: mockClient as any,
    panelPort: null,
    contentPorts: new Map(),
    cache: mockCache as any,
    history: { record: vi.fn(), getAll: vi.fn(() => []), clear: vi.fn(), load: vi.fn(), switchProfile: vi.fn() } as any,
    favorites: { toggle: vi.fn(), isFavorite: vi.fn(() => false), getAll: vi.fn(() => []), remove: vi.fn(), load: vi.fn(), switchProfile: vi.fn() } as any,
    scriptHistory: { record: vi.fn(), getAll: vi.fn(() => []), clear: vi.fn(), load: vi.fn(), switchProfile: vi.fn() } as any,
    settings: { schemaVersion: 1, profiles: [], activeProfileId: '', autoDetect: true, saveTarget: 'template' as const, enrichMode: 'widgets' as const },
    inspectActive: false,
    technicalOverlay: false,
    settingsReady: Promise.resolve(),
    logActivity: vi.fn((_level: string, msg: string) => logMessages.push(msg)),
    sendToPanel: vi.fn((msg: InspectorMessage) => panelMessages.push(msg)),
    broadcastToContent: vi.fn(),
  };

  return {
    ctx, mockClient, mockCache, cacheStore, logMessages, panelMessages,
    get callCount() { return callCount; },
    get maxRunning() { return maxRunning; },
    get calledWith() { return calledWith; },
    seedCache(rids: string[]) {
      for (const rid of rids) {
        cacheStore.set(rid, {
          rid, businessId: `CACHED-${rid.slice(-4)}`, type: 'Cached', name: `Cached ${rid.slice(-4)}`,
          source: 'server', discoveredAt: Date.now(), updatedAt: Date.now(),
        });
      }
    },
  };
}

// ── Tests (no fake timers — mock has zero delay) ──

describe('enrichBadges pipeline', () => {
  beforeEach(() => {
    mockChromeStorage();
  });

  afterEach(() => {
    resetEnrichment();
  });

  it('small batch — all 10 succeed', async () => {
    const mock = createMockContext();
    setSwContext(mock.ctx);
    await enrichBadges(ALL_RIDS.slice(0, 10));

    expect(mock.callCount).toBe(1);
    expect(mock.mockClient.batchEnrich).toHaveBeenCalledTimes(1);
    expect(mock.calledWith[0]).toHaveLength(10);
  });

  it('exact chunk boundary — 25 RIDs = 1 chunk', async () => {
    const mock = createMockContext();
    setSwContext(mock.ctx);
    await enrichBadges(ALL_RIDS.slice(0, 25));

    expect(mock.callCount).toBe(1);
    expect(mock.calledWith[0]).toHaveLength(25);
  });

  it('multi-chunk parallel — 100 RIDs = 4 chunks, max concurrency 4', async () => {
    const mock = createMockContext({ batchDelay: 10 });
    setSwContext(mock.ctx);
    await enrichBadges(ALL_RIDS.slice(0, 100));

    expect(mock.callCount).toBe(4);
    expect(mock.maxRunning).toBe(4);
    for (const chunk of mock.calledWith) {
      expect(chunk.length).toBeLessThanOrEqual(25);
    }
  });

  it('large batch — 196 RIDs = 8 chunks', async () => {
    const mock = createMockContext({ batchDelay: 5 });
    setSwContext(mock.ctx);
    await enrichBadges([...ALL_RIDS]);

    expect(mock.callCount).toBe(8);
    expect(mock.maxRunning).toBeLessThanOrEqual(4);
    const allRequested = mock.calledWith.flat();
    expect(allRequested).toHaveLength(196);
  });

  it('cache hits skip EC — 20 cached, 30 to server', async () => {
    const mock = createMockContext();
    const rids = ALL_RIDS.slice(0, 50);
    mock.seedCache(rids.slice(0, 20));

    setSwContext(mock.ctx);
    await enrichBadges([...rids]);

    const totalRequested = mock.calledWith.flat().length;
    expect(totalRequested).toBe(30);
    expect(mock.callCount).toBe(2); // ceil(30/25) = 2
  });

  it('dedup — already enriched RIDs are skipped', async () => {
    const mock = createMockContext();
    setSwContext(mock.ctx);

    await enrichBadges(ALL_RIDS.slice(0, 30));
    const firstCallCount = mock.callCount;

    await enrichBadges(ALL_RIDS.slice(0, 50));

    const secondBatchRids = mock.calledWith.slice(firstCallCount).flat();
    expect(secondBatchRids).toHaveLength(20);
    const firstRids = new Set(ALL_RIDS.slice(0, 30));
    for (const rid of secondBatchRids) {
      expect(firstRids.has(rid)).toBe(false);
    }
  });

  it('empty input is a no-op', async () => {
    const mock = createMockContext();
    setSwContext(mock.ctx);
    await enrichBadges([]);
    expect(mock.callCount).toBe(0);
  });

  it('whitespace-only RIDs are filtered', async () => {
    const mock = createMockContext();
    setSwContext(mock.ctx);
    await enrichBadges(['', ' ', '  ', ALL_RIDS[0]]);
    expect(mock.callCount).toBe(1);
    expect(mock.calledWith[0]).toHaveLength(1);
    expect(mock.calledWith[0][0]).toBe(ALL_RIDS[0]);
  });

  it('no client → returns immediately', async () => {
    const mock = createMockContext();
    mock.ctx.client = null;
    setSwContext(mock.ctx);
    await enrichBadges(ALL_RIDS.slice(0, 10));
    expect(mock.callCount).toBe(0);
  });
});

// ── Failure path tests (no timers — just verify initial behavior) ──

describe('enrichBadges failure handling', () => {
  beforeEach(() => {
    mockChromeStorage();
  });

  afterEach(() => {
    resetEnrichment();
  });

  it('batch failure is logged', async () => {
    // All chunks fail — enrichBadges enters 15s retry wait internally, but we
    // don't need to await the retry. The initial failure logging is synchronous.
    const mock = createMockContext({ failChunks: [0, 1] });
    setSwContext(mock.ctx);

    // Don't await — enrichBadges will hang on the 15s retry setTimeout
    // Just call it and let it start
    enrichBadges(ALL_RIDS.slice(0, 50));

    // Give microtasks a tick to process
    await new Promise(r => setTimeout(r, 50));

    // Initial 2 chunks should have been called and failed
    expect(mock.callCount).toBe(2);
    expect(mock.logMessages.some(m => m.includes('Batch failed'))).toBe(true);
  });

  it('missing RIDs go to individual retry queue', async () => {
    const rids = ALL_RIDS.slice(0, 10);
    const missingRids = new Set(rids.slice(5)); // last 5 are missing

    const mock = createMockContext({ missingRids });
    setSwContext(mock.ctx);
    await enrichBadges([...rids]);

    // All 10 were in 1 chunk, 5 succeeded, 5 missing
    expect(mock.callCount).toBe(1);
    // The 5 missing RIDs trigger phase 3 retry via setTimeout(5000)
    // We verify the success path completed
    expect(mock.logMessages.some(m => m.includes('Enriched 5'))).toBe(true);
  });

  it('mixed scenario — cache + server + missing', async () => {
    const rids = ALL_RIDS.slice(0, 50);
    const cachedRids = rids.slice(0, 20);
    const missingRids = new Set(rids.slice(45)); // last 5 missing

    const mock = createMockContext({ missingRids });
    mock.seedCache(cachedRids);
    setSwContext(mock.ctx);
    await enrichBadges([...rids]);

    // 20 cached → immediate, 30 to EC in 2 chunks, 25 succeed + 5 missing
    const totalRequested = mock.calledWith.flat().length;
    expect(totalRequested).toBe(30);
    // Log shows total enriched count (cache hits + server hits)
    expect(mock.logMessages.some(m => m.includes('Enriched'))).toBe(true);
  });
});
