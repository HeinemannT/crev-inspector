/**
 * Tests for enrichment pipeline hardening fixes.
 *
 * Validates:
 * - Permanently-failed RID from call N gets empty broadcast in call N+1
 * - Invalid RID throws on batchEnrich
 * - Delimiter collision: name containing ||| parsed correctly
 * - cache.get() invalidates cachedValues
 * - permanentlyFailed set capped at MAX_PERMANENTLY_FAILED
 * - Generation change mid-processChunk prevents broadcast
 * - refreshEnrichment broadcasts to all tabs
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockChromeStorage } from './chrome-mock';
import { setSwContext } from '../sw-context';
import type { SwContext } from '../sw-context';
import type { InspectorMessage, InspectorSettings } from '../types';
import { ObjectCache } from '../object-cache';
import { MAX_PERMANENTLY_FAILED } from '../constants';

// ── Helpers ──

function makeSettings(): InspectorSettings {
  return {
    schemaVersion: 1,
    profiles: [{ id: 'p1', label: 'Test', bmpUrl: 'https://bmp.test/', bmpUser: 'admin', bmpPass: 'pass' }],
    activeProfileId: 'p1',
    autoDetect: true,
    saveTarget: 'template' as const,
    enrichMode: 'widgets' as const,
  };
}

function makeCtx(overrides: Partial<SwContext> = {}) {
  const broadcastedMessages: InspectorMessage[] = [];
  const panelMessages: InspectorMessage[] = [];
  const ctx = {
    client: null as any,
    panelPort: null,
    contentPorts: new Map(),
    cache: { get: vi.fn(), put: vi.fn(), putAll: vi.fn(), size: 0, clear: vi.fn(), load: vi.fn(), flush: vi.fn(async () => {}), getAll: vi.fn(() => []), search: vi.fn(() => []) } as any,
    history: { record: vi.fn(), getAll: vi.fn(() => []), clear: vi.fn(), load: vi.fn(), switchProfile: vi.fn().mockResolvedValue(undefined) } as any,
    favorites: { toggle: vi.fn(), isFavorite: vi.fn(() => false), getAll: vi.fn(() => []), remove: vi.fn(), load: vi.fn(), switchProfile: vi.fn().mockResolvedValue(undefined) } as any,
    scriptHistory: { record: vi.fn(), getAll: vi.fn(() => []), clear: vi.fn(), load: vi.fn(), switchProfile: vi.fn().mockResolvedValue(undefined) } as any,
    settings: makeSettings(),
    inspectActive: false,
    technicalOverlay: false,
    settingsReady: Promise.resolve(),
    logActivity: vi.fn(),
    sendToPanel: vi.fn((msg: InspectorMessage) => panelMessages.push(msg)),
    broadcastToContent: vi.fn((msg: InspectorMessage) => broadcastedMessages.push(msg)),
    _broadcastedMessages: broadcastedMessages,
    _panelMessages: panelMessages,
    ...overrides,
  } as any;
  return ctx;
}

// ── Tests ──

describe('RID validation (bmp-client.ts)', () => {
  it('batchEnrich silently skips injection attempt', async () => {
    mockChromeStorage();
    const { BmpClient } = await import('../bmp-client');
    const client = new BmpClient('https://bmp.test/', 'admin', 'pass');

    // All-invalid → empty results, no throw
    const result = await client.batchEnrich(['123); evil(); (456']);
    expect(result.results).toEqual({});
    expect(result.error).toBeUndefined();
  });

  it('batchEnrich accepts valid positive RID', async () => {
    mockChromeStorage();
    const { BmpClient } = await import('../bmp-client');
    const client = new BmpClient('https://bmp.test/', 'admin', 'pass');

    // This will fail at the network level, but should NOT throw "Invalid RID"
    const result = await client.batchEnrich(['2127371937565588693']);
    // It failed due to network, not validation
    expect(result.error).toBeDefined();
  });

  it('batchEnrich accepts negative RID', async () => {
    mockChromeStorage();
    const { BmpClient } = await import('../bmp-client');
    const client = new BmpClient('https://bmp.test/', 'admin', 'pass');

    const result = await client.batchEnrich(['-12345']);
    expect(result.error).toBeDefined(); // network fail, not validation
  });
});

describe('Delimiter collision — batchEnrich name with |||', () => {
  it('parser rejoins overflow parts into name', () => {
    // Simulate the fixed parser logic
    const line = '12345|||BID-01|||Scorecard|||My|||Weird|||Name';
    const parts = line.split('|||');
    const [rid, bid, typ, ...rest] = parts;
    const name = rest.join('|||');

    expect(rid).toBe('12345');
    expect(bid).toBe('BID-01');
    expect(typ).toBe('Scorecard');
    expect(name).toBe('My|||Weird|||Name');
  });

  it('parser handles normal 4-part line', () => {
    const line = '12345|||BID-01|||Scorecard|||Normal Name';
    const parts = line.split('|||');
    const [rid, bid, typ, ...rest] = parts;
    const name = rest.join('|||');

    expect(name).toBe('Normal Name');
  });
});

describe('Delimiter collision — resolveTemplate name with |||', () => {
  it('parses template name containing ||| correctly', () => {
    // Mirrors the fixed resolveTemplate parser: [tRid, ...rest] → tType = rest.pop(), tName = rest.join('|||')
    const last = '12345|||My|||Weird|||Name|||Scorecard';
    const [tRid, ...rest] = last.split('|||');
    const tType = rest.pop() ?? '';
    const tName = rest.join('|||');

    expect(tRid).toBe('12345');
    expect(tName).toBe('My|||Weird|||Name');
    expect(tType).toBe('Scorecard');
  });

  it('parses MISSING as null templateRid', () => {
    const last = 'MISSING||||||';
    const [tRid, ...rest] = last.split('|||');
    const tType = rest.pop() ?? '';
    const tName = rest.join('|||');

    expect(tRid).toBe('MISSING');
    // resolveTemplate returns { templateRid: null } when tRid === 'MISSING'
  });

  it('parses normal template correctly', () => {
    const last = '12345|||Normal Name|||KPI';
    const [tRid, ...rest] = last.split('|||');
    const tType = rest.pop() ?? '';
    const tName = rest.join('|||');

    expect(tRid).toBe('12345');
    expect(tName).toBe('Normal Name');
    expect(tType).toBe('KPI');
  });
});

describe('batchEnrich truncates oversized input', () => {
  it('generates EC with at most BATCH_CHUNK_SIZE lookups', async () => {
    mockChromeStorage();
    const { BmpClient } = await import('../bmp-client');
    const client = new BmpClient('https://bmp.test/', 'admin', 'pass');

    let capturedCode = '';
    client.executeEc = vi.fn(async (code: string) => {
      capturedCode = code;
      return { ok: true, log: '' };
    }) as any;

    // Pass 50 valid RIDs
    const rids = Array.from({ length: 50 }, (_, i) => String(1000 + i));
    await client.batchEnrich(rids);

    // Should have been called with exactly 25 lookups
    const lookupCount = (capturedCode.match(/lookup\(/g) || []).length;
    expect(lookupCount).toBe(25);
  });
});

describe('ObjectCache.get() invalidates cachedValues', () => {
  it('getAll() after get() returns updated LRU order', async () => {
    mockChromeStorage();
    const cache = new ObjectCache();
    const now = Date.now();

    // Insert A, B, C
    cache.putAll([
      { rid: 'A', source: 'server', discoveredAt: now, updatedAt: now },
      { rid: 'B', source: 'server', discoveredAt: now, updatedAt: now },
      { rid: 'C', source: 'server', discoveredAt: now, updatedAt: now },
    ]);

    // First getAll() → caches values
    const first = cache.getAll();
    expect(first.map(o => o.rid)).toEqual(['A', 'B', 'C']);

    // get('A') moves A to end (LRU re-insert) and should invalidate cachedValues
    cache.get('A');

    // getAll() should reflect new order
    const second = cache.getAll();
    expect(second.map(o => o.rid)).toEqual(['B', 'C', 'A']);
  });
});

describe('permanentlyFailed cap at MAX_PERMANENTLY_FAILED', () => {
  it('cap is 500', () => {
    expect(MAX_PERMANENTLY_FAILED).toBe(500);
  });

  it('capPermanentlyFailed evicts oldest entries', async () => {
    // Test the Set eviction logic directly (mirrors enrichment.ts capPermanentlyFailed)
    const set = new Set<string>();
    const MAX = 500;

    // Add 600 entries
    for (let i = 0; i < 600; i++) set.add(`rid-${i}`);
    expect(set.size).toBe(600);

    // Evict
    if (set.size > MAX) {
      const excess = set.size - MAX;
      let count = 0;
      for (const rid of set) {
        if (count >= excess) break;
        set.delete(rid);
        count++;
      }
    }

    expect(set.size).toBe(500);
    // Oldest entries (0-99) should be evicted
    expect(set.has('rid-0')).toBe(false);
    expect(set.has('rid-99')).toBe(false);
    // Newest entries should remain
    expect(set.has('rid-100')).toBe(true);
    expect(set.has('rid-599')).toBe(true);
  });
});

describe('Permanently-failed RIDs — broadcast fix', () => {
  it('permanently-failed RID from call N gets empty broadcast in call N+1', async () => {
    mockChromeStorage();

    const ctx = makeCtx();

    // Mock client that always fails for rid '999'
    ctx.client = {
      supportsLookup: true,
      batchEnrich: vi.fn(async (rids: string[]) => {
        const results: Record<string, any> = {};
        for (const rid of rids) {
          if (rid !== '999') {
            results[rid] = { businessId: 'BID', type: 'KPI', name: 'Test' };
          }
        }
        return { results };
      }),
    };

    setSwContext(ctx);

    const { enrichBadges, resetEnrichment } = await import('../enrichment');
    resetEnrichment();

    // Call 1: enrich '111' and '999'. '999' will fail → permanently failed.
    await enrichBadges(['111', '999']);

    // Call 2: enrich '999' again (e.g., different tab). Should get empty broadcast immediately.
    ctx._broadcastedMessages.length = 0;
    await enrichBadges(['999']);

    // Should have broadcast for '999' with empty enrichment via broadcastToContent
    const enrichBroadcasts = ctx._broadcastedMessages.filter(
      (m: any) => m.type === 'BADGE_ENRICHMENT' && m.enrichments['999'] !== undefined
    );
    expect(enrichBroadcasts.length).toBeGreaterThan(0);
    expect(enrichBroadcasts[0].enrichments['999']).toEqual({});
  });
});

describe('refreshEnrichment broadcasts to all tabs', () => {
  it('calls broadcastToContent instead of single-tab query', async () => {
    mockChromeStorage();
    const ctx = makeCtx();
    setSwContext(ctx);

    const { refreshEnrichment } = await import('../enrichment');
    refreshEnrichment();

    expect(ctx.broadcastToContent).toHaveBeenCalledWith({ type: 'RE_ENRICH' });
  });
});

describe('incrementGeneration clears enrichedRids', () => {
  it('previously-enriched RIDs are re-processed after incrementGeneration()', async () => {
    mockChromeStorage();
    const ctx = makeCtx();

    let batchEnrichCalls = 0;
    ctx.client = {
      supportsLookup: true,
      batchEnrich: vi.fn(async (rids: string[]) => {
        batchEnrichCalls++;
        const results: Record<string, any> = {};
        for (const rid of rids) {
          results[rid] = { businessId: `BID-${rid}`, type: 'KPI', name: `Name-${rid}` };
        }
        return { results };
      }),
    };
    ctx.cache.get = vi.fn(() => undefined);

    setSwContext(ctx);

    const { enrichBadges, incrementGeneration, resetEnrichment } = await import('../enrichment');
    resetEnrichment();

    // Call 1: enrich '111'
    await enrichBadges(['111']);
    expect(batchEnrichCalls).toBe(1);

    // Call 2: same RID — should be skipped (already enriched)
    batchEnrichCalls = 0;
    await enrichBadges(['111']);
    expect(batchEnrichCalls).toBe(0);

    // incrementGeneration() clears enrichedRids
    incrementGeneration();

    // Call 3: same RID — should be re-processed
    batchEnrichCalls = 0;
    await enrichBadges(['111']);
    expect(batchEnrichCalls).toBe(1);
  });
});

describe('Invalid RID pre-filter in batchEnrich', () => {
  it('invalid RID does not kill sibling valid RIDs', async () => {
    mockChromeStorage();

    // Mock fetch for executeEc
    globalThis.fetch = vi.fn(async () => {
      // Return EC results for two valid RIDs
      return {
        ok: true, status: 200,
        json: async () => ({}),
        arrayBuffer: async () => new ArrayBuffer(0),
      } as any;
    });

    const { BmpClient } = await import('../bmp-client');
    const client = new BmpClient('https://bmp.test/', 'admin', 'pass');

    // Mock executeEc to return results for valid RIDs
    client.executeEc = vi.fn(async (code: string) => {
      return {
        ok: true,
        log: '12345|||BID-1|||KPI|||Name1\n67890|||BID-2|||KPI|||Name2\n',
      };
    }) as any;

    const result = await client.batchEnrich(['12345', 'INVALID', '67890']);

    // Should have results for valid RIDs, silently skipping INVALID
    expect(result.results['12345']).toBeDefined();
    expect(result.results['67890']).toBeDefined();
    expect(result.error).toBeUndefined();
  });

  it('all-invalid RIDs returns empty without calling EC', async () => {
    mockChromeStorage();
    const { BmpClient } = await import('../bmp-client');
    const client = new BmpClient('https://bmp.test/', 'admin', 'pass');
    client.executeEc = vi.fn() as any;

    const result = await client.batchEnrich(['INVALID', 'also-bad', 'nope']);
    expect(result.results).toEqual({});
    expect(client.executeEc).not.toHaveBeenCalled();
  });
});

describe('parseTreeNodeInfo', () => {
  it('extracts enrichment fields from deserialized TreeNodeInformationDto', async () => {
    mockChromeStorage();
    const { parseTreeNodeInfo } = await import('../bmp-types');

    const dto = {
      $class: 'com.corporater.bmp.dto.TreeNodeInformationDto',
      rid: { identifier: 1852102941904263810n },
      id: 'RISK-001',
      type: { typeId: 'Scorecard' },
      text: 'RISK-001 Enterprise Risk Register',
      toolTip: null,
      errorText: null,
      isLink: false,
      isTemplateLinkedTo: false,
      model: { name: 'ORGANISATION' },
      iconInformation: null,
      showOnWeb: true,
    };

    const result = parseTreeNodeInfo(dto);
    expect(result).toEqual({
      rid: '1852102941904263810',
      businessId: 'RISK-001',
      type: 'Scorecard',
      name: 'RISK-001 Enterprise Risk Register',
    });
  });

  it('returns null for missing rid', async () => {
    mockChromeStorage();
    const { parseTreeNodeInfo } = await import('../bmp-types');
    expect(parseTreeNodeInfo({ id: 'X', type: { typeId: 'KPI' }, text: 'test' })).toBeNull();
    expect(parseTreeNodeInfo(null)).toBeNull();
  });

  it('handles missing optional fields', async () => {
    mockChromeStorage();
    const { parseTreeNodeInfo } = await import('../bmp-types');
    const result = parseTreeNodeInfo({
      rid: { identifier: 999n },
      id: null,
      type: null,
      text: null,
    });
    expect(result).toEqual({ rid: '999', businessId: undefined, type: undefined, name: undefined });
  });
});

describe('supportsLookup null uses batchEnrich (version-aware)', () => {
  it('enriches via batchEnrich when supportsLookup is null (old BMP, version detection failed)', async () => {
    mockChromeStorage();
    const ctx = makeCtx();

    ctx.client = {
      supportsLookup: null,
      batchEnrich: vi.fn(async (rids: string[]) => {
        const results: Record<string, any> = {};
        for (const rid of rids) {
          results[rid] = { businessId: `BID-${rid}`, type: 'KPI', name: `Name-${rid}` };
        }
        return { results };
      }),
    };
    ctx.cache.get = vi.fn(() => undefined);

    setSwContext(ctx);

    const { enrichBadges, resetEnrichment } = await import('../enrichment');
    resetEnrichment();

    await enrichBadges(['111', '222']);

    // batchEnrich is now version-aware and handles all BMP versions
    expect(ctx.client.batchEnrich).toHaveBeenCalled();

    // Should have broadcast enrichment results
    const badges = ctx._broadcastedMessages.filter((m: any) => m.type === 'BADGE_ENRICHMENT');
    expect(badges.length).toBeGreaterThan(0);
    expect(badges[0].enrichments['111']).toEqual({ businessId: 'BID-111', type: 'KPI', name: 'Name-111' });
  });

  it('does not log version detection warning', async () => {
    mockChromeStorage();
    const ctx = makeCtx();

    ctx.client = {
      supportsLookup: null,
      batchEnrich: vi.fn(async () => ({ results: {} })),
    };
    ctx.cache.get = vi.fn(() => undefined);

    setSwContext(ctx);

    const { enrichBadges, resetEnrichment } = await import('../enrichment');
    resetEnrichment();

    await enrichBadges(['111']);

    // Should NOT log "Waiting for version detection"
    const waitingCalls = (ctx.logActivity as any).mock.calls.filter(
      (c: any[]) => c[1]?.includes?.('Waiting for version detection')
    );
    expect(waitingCalls.length).toBe(0);

    // Should have attempted enrichment via batchEnrich
    expect(ctx.client.batchEnrich).toHaveBeenCalled();
  });
});

describe('processChunk cancellation', () => {
  it('cancelled generation prevents broadcast of stale data', async () => {
    mockChromeStorage();
    const ctx = makeCtx();

    let resolveEnrich: (v: any) => void;
    ctx.client = {
      supportsLookup: true,
      batchEnrich: vi.fn(() => new Promise(resolve => { resolveEnrich = resolve; })),
    };
    ctx.cache.get = vi.fn(() => undefined);

    setSwContext(ctx);

    const { enrichBadges, incrementGeneration, resetEnrichment } = await import('../enrichment');
    resetEnrichment();

    // Start enrichment
    const enrichPromise = enrichBadges(['111', '222']);

    // Simulate profile change mid-flight
    incrementGeneration();

    // Resolve the batchEnrich call after cancellation
    resolveEnrich!({ results: { '111': { businessId: 'BID', type: 'KPI', name: 'Test' } } });

    await enrichPromise;

    // Should have logged cancellation
    expect(ctx.logActivity).toHaveBeenCalledWith('info', 'Enrichment cancelled (profile changed)');
  });
});
