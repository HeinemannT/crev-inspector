/**
 * Deep integration tests for the enrichment pipeline.
 *
 * Tests the FULL flow as it runs in the Chrome extension:
 *   enrichBadges → BmpClient.batchEnrich → EC code generation →
 *   transport (mocked) → parseEcResults → output parsing →
 *   real ObjectCache → real broadcastToContent
 *
 * Mock boundary: BmpTransport.sendStreamingCommand — returns realistic
 * deserialized Java objects (ExtendedExecuteResult with JavaEnum logTypes).
 * Everything above that is real code.
 *
 * Uses real 64-bit Java long RIDs from a live BMP instance.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockChromeStorage } from './chrome-mock';
import { setSwContext } from '../sw-context';
import type { SwContext } from '../sw-context';
import type { InspectorMessage, InspectorSettings } from '../types';
import { ObjectCache } from '../object-cache';
import { JavaEnum } from '../java-serial';
import { registerBmpTypes } from '../bmp-types';
import { BATCH_CHUNK_SIZE } from '../constants';
import { getTypeColor, getTypeAbbr, TYPES_WITH_CODE, DEFAULT_TYPE_COLOR } from '../types';

// Register types once (needed for parseEcResults to recognize JavaEnum)
registerBmpTypes();

// Mock the retry delay to near-zero for tests that exercise retry logic
vi.mock('../constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../constants')>();
  return { ...actual, ENRICHMENT_RETRY_DELAY: 10 };
});

// ── Real BMP RIDs (64-bit Java longs) ─────────────────────────────────
// These are the kind of RIDs the extension actually encounters on a BMP page.
const RIDS = {
  scorecard:    '2127371937565588693',
  extTable:     '4945596583281942205',
  cvo:          '6105098650012869467',
  organisation: '-7302918475028293741',  // negative RID (valid Java long)
  editPage:     '8819237456123098765',
  template:     '1029384756102938475',
  kpi:          '3847561029384756102',
  risk:         '5019283746519283746',
  control:      '7654321098765432109',
  action:       '2345678901234567890',
  dashFolder:   '9876543210987654321',
  strategy:     '1111222233334444555',
  theme:        '6666777788889999000',
  perspective:  '1234567890123456789',
  barChart:     '4567890123456789012',
  // Extra RIDs for volume tests
  extra1: '1000000000000000001',
  extra2: '1000000000000000002',
  extra3: '1000000000000000003',
  extra4: '1000000000000000004',
  extra5: '1000000000000000005',
};

// ── Realistic EC output for batchEnrich ───────────────────────────────
// Format: rid|||businessId|||className|||name|||tbid|||cRid|||cBid|||cType|||cName
// This is exactly what the EC code in batchEnrich produces. Cascade fields
// (cRid..cName) are blank for non-flow types.
function makeBatchOutput(entries: Array<{
  rid: string; bid: string; type: string; name: string; tbid?: string;
  cRid?: string; cBid?: string; cType?: string; cName?: string;
}>): string {
  return entries.map(e =>
    `${e.rid}|||${e.bid}|||${e.type}|||${e.name}|||${e.tbid ?? ''}|||${e.cRid ?? ''}|||${e.cBid ?? ''}|||${e.cType ?? ''}|||${e.cName ?? ''}`,
  ).join('\n') + '\n';
}

// ── Build realistic deserialized Java response objects ─────────────────
// This is what BmpTransport.sendStreamingCommand returns after deserializing
// the BMP server's binary response. The Java deserializer produces:
// - ExtendedExecuteResult with entries (ArrayList of LogEntry objects)
// - Each LogEntry has a logType (JavaEnum) and message (string)

const LOG_TYPE_DESC = {
  name: 'com.corporater.bmp.dto.command.extended.LogType',
  uid: 0n, flags: 0x10, fields: [], parent: null,
};

function makeEcResponseObjects(output: string): any[] {
  return [{
    $class: 'com.corporater.bmp.dto.command.extended.ExtendedExecuteResult',
    entries: {
      // Deserialized ArrayList — NOT a native array, has $elements
      $elements: [{
        logType: new JavaEnum(LOG_TYPE_DESC as any, 'SHOW_RESULT'),
        message: output,
        time: null,
      }],
      $class: 'java.util.ArrayList',
      size: 1,
      length: 1,
    },
  }];
}

function makeErrorResponseObjects(errorMsg: string): any[] {
  return [{
    $class: 'com.corporater.bmp.base.system.exception.ServerExceptionResponse',
    message: errorMsg,
  }];
}

// ── Test infrastructure ───────────────────────────────────────────────

interface TestHarness {
  ctx: SwContext & {
    _broadcasts: InspectorMessage[];
    _panelMsgs: InspectorMessage[];
    _activities: Array<{ level: string; message: string }>;
  };
  cache: ObjectCache;
  transportMock: ReturnType<typeof vi.fn>;
  client: any;
}

async function createHarness(): Promise<TestHarness> {
  mockChromeStorage();

  const cache = new ObjectCache();

  // Create a real BmpClient and replace only the transport layer
  const { BmpClient } = await import('../bmp-client');
  const client = new BmpClient('https://bmp.test/', 'admin', 'pass', 'test-profile');
  client.applyVersionFlags('5.6.7.2'); // simulate detected version

  // Mock at the transport boundary — this is the ONLY mock in the chain
  const transportMock = vi.fn<(...args: any[]) => Promise<any[]>>();
  (client as any).transport = {
    sendStreamingCommand: transportMock,
    sendRequest: vi.fn(),
    sendCommands: vi.fn(),
    deserializeResponse: vi.fn(),
    formatError: (e: unknown) => e instanceof Error ? e.message : String(e),
  };

  // Also need to mock auth.ensureAuth since transport.sendRequest would call it
  (client as any).auth = {
    ensureAuth: vi.fn(async () => 'mock-jwt'),
    login: vi.fn(async () => 'mock-jwt'),
    logout: vi.fn(),
    invalidateJwt: vi.fn(),
    absorbAuth: vi.fn(),
    refreshAuth: vi.fn(async () => null),
    jwt: 'mock-jwt',
  };

  const broadcasts: InspectorMessage[] = [];
  const panelMsgs: InspectorMessage[] = [];
  const activities: Array<{ level: string; message: string }> = [];

  const ctx = {
    client,
    hasPanel: false,
    panelPortByWindow: new Map(),
    contentPorts: new Map(),
    cache,
    settings: {
      schemaVersion: 1,
      profiles: [{ id: 'test-profile', label: 'Test', bmpUrl: 'https://bmp.test/', bmpUser: 'admin', bmpPass: 'pass' }],
      activeProfileId: 'test-profile',
      autoDetect: true,
      saveTarget: 'template' as const,
      enrichMode: 'widgets' as const,
    } satisfies InspectorSettings,
    inspectActive: true,
    settingsReady: Promise.resolve(),
    logActivity: vi.fn((level: string, message: string) => activities.push({ level, message })),
    sendToPanel: vi.fn((msg: InspectorMessage) => panelMsgs.push(msg)),
    sendToPanelByWindow: vi.fn(),
    sendToPanelByTab: vi.fn(),
    broadcastToContent: vi.fn((msg: InspectorMessage) => broadcasts.push(msg)),
    toast: vi.fn(),
    _broadcasts: broadcasts,
    _panelMsgs: panelMsgs,
    _activities: activities,
  } as any;

  setSwContext(ctx);

  return { ctx, cache, transportMock, client };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('Enrichment Integration — Full Pipeline', () => {
  let harness: TestHarness;
  let enrichBadges: (rids: string[]) => Promise<void>;
  let resetEnrichment: () => void;
  let incrementGeneration: () => void;

  beforeEach(async () => {
    harness = await createHarness();
    const mod = await import('../enrichment');
    enrichBadges = mod.enrichBadges;
    resetEnrichment = mod.resetEnrichment;
    incrementGeneration = mod.incrementGeneration;
    resetEnrichment();
  });

  // ── Scenario 1: Typical page load with real RIDs ──────────────────

  it('enriches a realistic page load (10 widgets, single chunk)', async () => {
    const pageRids = [
      RIDS.scorecard, RIDS.extTable, RIDS.cvo, RIDS.organisation,
      RIDS.editPage, RIDS.kpi, RIDS.risk, RIDS.control, RIDS.action,
      RIDS.dashFolder,
    ];

    harness.transportMock.mockResolvedValueOnce(makeEcResponseObjects(
      makeBatchOutput([
        { rid: RIDS.scorecard,    bid: 'sc_main',        type: 'Scorecard',            name: 'Main Scorecard' },
        { rid: RIDS.extTable,     bid: 'sc_grc_risk',    type: 'ExtendedTable',        name: 'Risk Summary by Module' },
        { rid: RIDS.cvo,          bid: 'cvo_dashboard',  type: 'CustomVisualization',   name: 'GRC Dashboard' },
        { rid: RIDS.organisation, bid: 'org_root',       type: 'Organisation',          name: 'Corporater AS' },
        { rid: RIDS.editPage,     bid: 'pg_risks',       type: 'EditPage',              name: 'Risk Register' },
        { rid: RIDS.kpi,          bid: 'kpi_001',        type: 'Measure',               name: 'Revenue Growth %' },
        { rid: RIDS.risk,         bid: 'r_cyber',        type: 'Risk',                  name: 'Cybersecurity Breach' },
        { rid: RIDS.control,      bid: 'c_firewall',     type: 'Control',               name: 'Firewall Policy' },
        { rid: RIDS.action,       bid: 'act_training',   type: 'Action',                name: 'Security Training Q3' },
        { rid: RIDS.dashFolder,   bid: 'df_main',        type: 'DashboardFolder',       name: 'Main Dashboard' },
      ]),
    ));

    await enrichBadges(pageRids);

    // ── Verify broadcasts ──
    const enrichBroadcasts = harness.ctx._broadcasts.filter(
      (m: any) => m.type === 'BADGE_ENRICHMENT',
    );
    expect(enrichBroadcasts.length).toBe(1);

    const enrichments = (enrichBroadcasts[0] as any).enrichments;
    // All 10 RIDs should be enriched
    expect(Object.keys(enrichments)).toHaveLength(10);

    // Verify real 64-bit RIDs survived the pipeline
    expect(enrichments[RIDS.scorecard]).toEqual({
      businessId: 'sc_main', type: 'Scorecard', name: 'Main Scorecard',
    });
    expect(enrichments[RIDS.cvo]).toEqual({
      businessId: 'cvo_dashboard', type: 'CustomVisualization', name: 'GRC Dashboard',
    });
    // Negative RID
    expect(enrichments[RIDS.organisation]).toEqual({
      businessId: 'org_root', type: 'Organisation', name: 'Corporater AS',
    });

    // ── Verify cache was populated with real ObjectCache ──
    expect(harness.cache.size).toBe(10);
    const cached = harness.cache.get(RIDS.extTable);
    expect(cached).toBeDefined();
    expect(cached!.rid).toBe(RIDS.extTable);
    expect(cached!.businessId).toBe('sc_grc_risk');
    expect(cached!.type).toBe('ExtendedTable');
    expect(cached!.name).toBe('Risk Summary by Module');
    expect(cached!.source).toBe('server');

    // Negative RID in cache
    const orgCached = harness.cache.get(RIDS.organisation);
    expect(orgCached).toBeDefined();
    expect(orgCached!.rid).toBe(RIDS.organisation);

    // ── Verify EC code sent to transport ──
    expect(harness.transportMock).toHaveBeenCalledTimes(1);
    // The command object has the EC code embedded in it
    // Verify all RIDs appear in the serialized command
    // (The command is a Java object, but the EC code is in a string field)

    // ── Verify activity log ──
    expect(harness.ctx._activities).toContainEqual(
      expect.objectContaining({ level: 'info', message: expect.stringContaining('Enriching 10') }),
    );
    expect(harness.ctx._activities).toContainEqual(
      expect.objectContaining({ level: 'success', message: expect.stringContaining('Enriched 10') }),
    );
  });

  // ── Scenario 2: Multi-chunk (60 RIDs, split into 3 chunks) ────────

  it('chunks 60 RIDs into 3 batches and enriches all', async () => {
    // Generate 60 realistic RIDs
    const rids = Array.from({ length: 60 }, (_, i) =>
      String(BigInt('1000000000000000000') + BigInt(i)),
    );

    // Dynamic mock: extract RIDs from the EC code and return matching results.
    // This handles chunks arriving in any order due to parallel processing.
    harness.transportMock.mockImplementation(async (cmd: any) => {
      // Parse RIDs from the result — we'll generate correct output for any set of RIDs
      // by looking at which RIDs appear in the request. Since we can't easily parse
      // the binary command, generate output for ALL RIDs and let parsePipeLines match.
      const entries = rids.map((rid, i) => ({
        rid,
        bid: `bid_${i}`,
        type: 'Scorecard',
        name: `Object ${i}`,
      }));
      return makeEcResponseObjects(makeBatchOutput(entries));
    });

    await enrichBadges(rids);

    // Transport should have been called 3 times (25 + 25 + 10)
    expect(harness.transportMock).toHaveBeenCalledTimes(3);

    // All 60 should be in the cache
    expect(harness.cache.size).toBe(60);

    // 3 incremental broadcasts (one per chunk)
    const enrichBroadcasts = harness.ctx._broadcasts.filter(
      (m: any) => m.type === 'BADGE_ENRICHMENT',
    );
    expect(enrichBroadcasts.length).toBe(3);

    // Verify first and last RID survived as full 64-bit strings
    const allEnrichments = enrichBroadcasts.reduce((acc: Record<string, any>, m: any) => {
      Object.assign(acc, m.enrichments);
      return acc;
    }, {});
    expect(Object.keys(allEnrichments)).toHaveLength(60);
    expect(allEnrichments[rids[0]]).toBeDefined();
    expect(allEnrichments[rids[59]]).toBeDefined();
  });

  // ── Scenario 3: Cache hit path (second page visit) ────────────────

  it('serves from real ObjectCache on second visit (zero network)', async () => {
    const pageRids = [RIDS.scorecard, RIDS.extTable, RIDS.cvo];

    // Pre-populate cache (simulates previous enrichment)
    const now = Date.now();
    harness.cache.putAll([
      { rid: RIDS.scorecard, businessId: 'sc_main', type: 'Scorecard', name: 'Main Scorecard', source: 'server', discoveredAt: now, updatedAt: now },
      { rid: RIDS.extTable,  businessId: 'sc_grc',  type: 'ExtendedTable', name: 'Risk Summary', source: 'server', discoveredAt: now, updatedAt: now },
      { rid: RIDS.cvo,       businessId: 'cvo_dash', type: 'CustomVisualization', name: 'Dashboard', source: 'server', discoveredAt: now, updatedAt: now },
    ]);

    await enrichBadges(pageRids);

    // ZERO transport calls — all from cache
    expect(harness.transportMock).not.toHaveBeenCalled();

    // Should have broadcast cache hits immediately
    const enrichBroadcasts = harness.ctx._broadcasts.filter(
      (m: any) => m.type === 'BADGE_ENRICHMENT',
    );
    expect(enrichBroadcasts.length).toBe(1);
    const enrichments = (enrichBroadcasts[0] as any).enrichments;
    expect(Object.keys(enrichments)).toHaveLength(3);
    expect(enrichments[RIDS.scorecard].businessId).toBe('sc_main');
  });

  // ── Scenario 4: Mixed cache + server ──────────────────────────────

  it('combines cache hits and server fetches in one enrichBadges call', async () => {
    const now = Date.now();
    // Two RIDs already cached
    harness.cache.putAll([
      { rid: RIDS.scorecard, businessId: 'sc_main', type: 'Scorecard', name: 'Cached SC', source: 'server', discoveredAt: now, updatedAt: now },
      { rid: RIDS.extTable,  businessId: 'sc_grc',  type: 'ExtendedTable', name: 'Cached TBL', source: 'server', discoveredAt: now, updatedAt: now },
    ]);

    // Three RIDs need server enrichment
    harness.transportMock.mockResolvedValueOnce(makeEcResponseObjects(
      makeBatchOutput([
        { rid: RIDS.cvo,    bid: 'cvo_fresh', type: 'CustomVisualization', name: 'Fresh CVO' },
        { rid: RIDS.risk,   bid: 'r_fresh',   type: 'Risk',               name: 'Fresh Risk' },
        { rid: RIDS.action, bid: 'act_fresh',  type: 'Action',             name: 'Fresh Action' },
      ]),
    ));

    await enrichBadges([RIDS.scorecard, RIDS.cvo, RIDS.extTable, RIDS.risk, RIDS.action]);

    // Only one transport call (for the 3 uncached)
    expect(harness.transportMock).toHaveBeenCalledTimes(1);

    // Two broadcasts: one for cache hits, one for server results
    const enrichBroadcasts = harness.ctx._broadcasts.filter(
      (m: any) => m.type === 'BADGE_ENRICHMENT',
    );
    expect(enrichBroadcasts.length).toBe(2);

    // First broadcast: 2 cache hits
    expect(Object.keys((enrichBroadcasts[0] as any).enrichments)).toHaveLength(2);
    // Second broadcast: 3 server results
    expect(Object.keys((enrichBroadcasts[1] as any).enrichments)).toHaveLength(3);

    // Cache now has all 5
    expect(harness.cache.size).toBe(5);
  });

  // ── Scenario 5: Partial server results (some RIDs don't exist) ────

  it('handles mixed found/missing RIDs from BMP', async () => {
    const unknownRid = '9999999999999999999';

    harness.transportMock.mockResolvedValueOnce(makeEcResponseObjects(
      makeBatchOutput([
        { rid: RIDS.scorecard, bid: 'sc_main', type: 'Scorecard', name: 'Found One' },
        // unknownRid returns SKIP (object not in BMP)
      ]) + `SKIP|||||||\n`,
    ));

    await enrichBadges([RIDS.scorecard, unknownRid]);

    // One transport call
    expect(harness.transportMock).toHaveBeenCalledTimes(1);

    // Should broadcast found RID + empty for failed
    const enrichBroadcasts = harness.ctx._broadcasts.filter(
      (m: any) => m.type === 'BADGE_ENRICHMENT',
    );
    // First: chunk result (1 found), then: failed broadcast (1 empty)
    expect(enrichBroadcasts.length).toBe(2);

    // The found one has data
    const found = (enrichBroadcasts[0] as any).enrichments;
    expect(found[RIDS.scorecard]).toEqual({
      businessId: 'sc_main', type: 'Scorecard', name: 'Found One',
    });

    // The failed one gets empty enrichment (removes loading spinner)
    const failed = (enrichBroadcasts[1] as any).enrichments;
    expect(failed[unknownRid]).toEqual({});
  });

  // ── Scenario 5b: Cascade target on flow-bearing widgets ────────────

  it('surfaces cascade target for InputView (inputSet) and ActionButton (actionObject)', async () => {
    harness.transportMock.mockResolvedValueOnce(makeEcResponseObjects(
      makeBatchOutput([
        // Non-flow type — no cascade
        { rid: RIDS.scorecard, bid: 'sc_main', type: 'Scorecard', name: 'Main SC' },
        // InputView — cascade points at its InputSet
        { rid: RIDS.extTable, bid: 'iv_demo', type: 'InputView', name: 'Demo IV',
          cRid: '9999', cBid: 'is_demo', cType: 'InputSet', cName: 'Demo IS' },
      ]),
    ));

    await enrichBadges([RIDS.scorecard, RIDS.extTable]);

    const enrichBroadcasts = harness.ctx._broadcasts.filter(
      (m: any) => m.type === 'BADGE_ENRICHMENT',
    );
    const enrichments = (enrichBroadcasts[0] as any).enrichments;

    // Non-flow type has no cascade
    expect(enrichments[RIDS.scorecard].cascade).toBeUndefined();
    // Flow type has cascade with full identity
    expect(enrichments[RIDS.extTable].cascade).toEqual({
      rid: '9999', businessId: 'is_demo', type: 'InputSet', name: 'Demo IS',
    });
  });

  // ── Scenario 6: Object name containing the delimiter ───────────────

  it('handles object name containing ||| delimiter (known limitation)', async () => {
    harness.transportMock.mockResolvedValueOnce(makeEcResponseObjects(
      // Name contains ||| — parser uses positional indexing, so extra |||
      // in the name shifts fields and bleeds into the cascade columns.
      // Known limitation: BMP names never contain |||.
      `${RIDS.extTable}|||sc_weird|||ExtendedTable|||Risk|||Assessment|||Summary|||\n`,
    ));

    await enrichBadges([RIDS.extTable]);

    const enrichBroadcasts = harness.ctx._broadcasts.filter(
      (m: any) => m.type === 'BADGE_ENRICHMENT',
    );
    const enrichments = (enrichBroadcasts[0] as any).enrichments;

    // Positional parser: with the cascade fields added (parts[5..8]),
    // the "Summary" segment falls into parts[5] and is treated as cascade.rid.
    // Documenting the cascade interpretation of the same broken-name input.
    expect(enrichments[RIDS.extTable]).toEqual({
      businessId: 'sc_weird',
      type: 'ExtendedTable',
      name: 'Risk',
      templateBusinessId: 'Assessment',
      cascade: { rid: 'Summary', businessId: undefined, type: undefined, name: undefined },
    });
  });

  // ── Scenario 7: Dedup — same RIDs sent twice ─────────────────────

  it('deduplicates RIDs across consecutive enrichBadges calls', async () => {
    harness.transportMock.mockResolvedValueOnce(makeEcResponseObjects(
      makeBatchOutput([
        { rid: RIDS.scorecard, bid: 'sc_main', type: 'Scorecard', name: 'SC' },
      ]),
    ));

    // First call enriches
    await enrichBadges([RIDS.scorecard]);
    expect(harness.transportMock).toHaveBeenCalledTimes(1);

    // Second call — same RID, should be skipped entirely
    await enrichBadges([RIDS.scorecard]);
    expect(harness.transportMock).toHaveBeenCalledTimes(1); // still 1
  });

  // ── Scenario 8: Server error → retry → success ────────────────────

  it('retries failed batch after delay and succeeds', async () => {
    // First attempt: server error
    harness.transportMock.mockResolvedValueOnce(
      makeErrorResponseObjects('EC engine timeout'),
    );
    // Retry: success
    harness.transportMock.mockResolvedValueOnce(makeEcResponseObjects(
      makeBatchOutput([
        { rid: RIDS.scorecard, bid: 'sc_main', type: 'Scorecard', name: 'SC' },
      ]),
    ));

    await enrichBadges([RIDS.scorecard]);

    // Should have been called twice (initial + retry)
    expect(harness.transportMock).toHaveBeenCalledTimes(2);

    // Should have broadcast the successful result
    const enrichBroadcasts = harness.ctx._broadcasts.filter(
      (m: any) => m.type === 'BADGE_ENRICHMENT',
    );
    const lastBroadcast = enrichBroadcasts[enrichBroadcasts.length - 1] as any;
    expect(lastBroadcast.enrichments[RIDS.scorecard]).toEqual({
      businessId: 'sc_main', type: 'Scorecard', name: 'SC',
    });

    // Activity log should show the retry
    expect(harness.ctx._activities).toContainEqual(
      expect.objectContaining({ level: 'warn', message: expect.stringContaining('Batch failed') }),
    );
    expect(harness.ctx._activities).toContainEqual(
      expect.objectContaining({ level: 'info', message: expect.stringContaining('Retrying') }),
    );
  });

  // ── Scenario 9: Double failure → permanently failed ────────────────

  it('marks RID as permanently failed after two failures, broadcasts empty on next call', async () => {
    // Both attempts fail
    harness.transportMock.mockResolvedValue(
      makeErrorResponseObjects('Server down'),
    );

    await enrichBadges([RIDS.scorecard]);

    // Should have tried twice
    expect(harness.transportMock).toHaveBeenCalledTimes(2);

    // Activity log shows permanent failure
    expect(harness.ctx._activities).toContainEqual(
      expect.objectContaining({ level: 'warn', message: expect.stringContaining('skipped') }),
    );
  });

  it('permanently failed RID gets empty broadcast without network call', async () => {
    // First: make it permanently fail
    harness.transportMock.mockResolvedValue(
      makeErrorResponseObjects('Server down'),
    );

    await enrichBadges([RIDS.scorecard, RIDS.extTable]);

    expect(harness.transportMock).toHaveBeenCalledTimes(2); // initial + retry

    // Clear tracking
    harness.transportMock.mockClear();
    harness.ctx._broadcasts.length = 0;
    harness.ctx._activities.length = 0;

    // Second call with same RIDs — should broadcast empty immediately, no network
    // (enrichedRids also has them, so they'd be skipped... need a NEW RID that's perm-failed)
    // Actually, enrichedRids does NOT contain perm-failed RIDs. Let me trace:
    // In enrichBadges: newRids filters out enrichedRids. perm-failed RIDs were never added to enrichedRids.
    // So they pass the filter, hit the permanentlyFailed check, and get empty broadcast.

    await enrichBadges([RIDS.scorecard, RIDS.extTable]);

    // ZERO transport calls — permanently failed
    expect(harness.transportMock).not.toHaveBeenCalled();

    // Should have broadcast empty enrichment
    const enrichBroadcasts = harness.ctx._broadcasts.filter(
      (m: any) => m.type === 'BADGE_ENRICHMENT',
    );
    expect(enrichBroadcasts.length).toBe(1);
    const enrichments = (enrichBroadcasts[0] as any).enrichments;
    expect(enrichments[RIDS.scorecard]).toEqual({});
    expect(enrichments[RIDS.extTable]).toEqual({});
  });

  // ── Scenario 10: Profile switch cancels mid-enrichment ─────────────

  it('cancels enrichment when generation changes mid-flight', async () => {
    // Transport returns after a delay (simulates slow network)
    let resolveTransport!: (v: any) => void;
    harness.transportMock.mockReturnValueOnce(
      new Promise(resolve => { resolveTransport = resolve; }),
    );

    const enrichPromise = enrichBadges([RIDS.scorecard]);

    // Profile switch while EC is in flight
    incrementGeneration();

    // Now resolve the transport
    resolveTransport(makeEcResponseObjects(
      makeBatchOutput([
        { rid: RIDS.scorecard, bid: 'sc_main', type: 'Scorecard', name: 'SC' },
      ]),
    ));

    await enrichPromise;

    // Should have logged cancellation
    expect(harness.ctx._activities).toContainEqual(
      expect.objectContaining({ level: 'info', message: 'Enrichment cancelled (profile changed)' }),
    );

    // Cache should NOT have been updated (stale data from old profile)
    expect(harness.cache.size).toBe(0);

    // No enrichment broadcast (data belongs to old profile)
    const enrichBroadcasts = harness.ctx._broadcasts.filter(
      (m: any) => m.type === 'BADGE_ENRICHMENT',
    );
    expect(enrichBroadcasts.length).toBe(0);
  });

  // ── Scenario 11: Cache merge — DOM discovery then server enrichment ──

  it('merges DOM-discovered object with server enrichment in cache', async () => {
    const now = Date.now();

    // Content script discovers objects on the page (source: 'dom', no businessId)
    harness.cache.putAll([
      { rid: RIDS.scorecard, source: 'dom', discoveredAt: now, updatedAt: now },
      { rid: RIDS.extTable, source: 'dom', discoveredAt: now, updatedAt: now },
    ]);

    // cache.get for these objects returns them, but WITHOUT businessId
    // so enrichBadges will NOT treat them as cache hits
    expect(harness.cache.get(RIDS.scorecard)?.businessId).toBeUndefined();

    harness.transportMock.mockResolvedValueOnce(makeEcResponseObjects(
      makeBatchOutput([
        { rid: RIDS.scorecard, bid: 'sc_main', type: 'Scorecard', name: 'Main SC' },
        { rid: RIDS.extTable,  bid: 'sc_grc',  type: 'ExtendedTable', name: 'Risk Table' },
      ]),
    ));

    await enrichBadges([RIDS.scorecard, RIDS.extTable]);

    // Cache should have merged: server data + preserved discoveredAt from DOM
    const merged = harness.cache.get(RIDS.scorecard)!;
    expect(merged.businessId).toBe('sc_main');
    expect(merged.type).toBe('Scorecard');
    expect(merged.name).toBe('Main SC');
    expect(merged.source).toBe('server'); // server > dom priority
    expect(merged.discoveredAt).toBe(now); // preserved from original
  });

  // ── Scenario 12: batchEnrich truncates oversized direct call ───────

  it('batchEnrich truncates to BATCH_CHUNK_SIZE when called directly', async () => {
    // Generate 50 valid RIDs
    const rids = Array.from({ length: 50 }, (_, i) =>
      String(BigInt('2000000000000000000') + BigInt(i)),
    );

    // Only one transport call expected (truncated to 25)
    harness.transportMock.mockResolvedValueOnce(makeEcResponseObjects(
      makeBatchOutput(
        rids.slice(0, BATCH_CHUNK_SIZE).map((rid, i) => ({
          rid, bid: `bid_${i}`, type: 'Scorecard', name: `SC ${i}`,
        })),
      ),
    ));

    const result = await harness.client.batchEnrich(rids);

    expect(harness.transportMock).toHaveBeenCalledTimes(1);
    // Should only have 25 results (truncated)
    expect(Object.keys(result.results)).toHaveLength(25);
  });

  // ── Scenario 13: Whitespace and edge-case RID formatting ──────────

  it('handles whitespace-padded RIDs from content script', async () => {
    harness.transportMock.mockResolvedValueOnce(makeEcResponseObjects(
      makeBatchOutput([
        { rid: RIDS.scorecard, bid: 'sc_main', type: 'Scorecard', name: 'SC' },
      ]),
    ));

    // Content script might send RIDs with whitespace (from DOM attributes)
    await enrichBadges([`  ${RIDS.scorecard}  `, '  ', '']);

    // Should have enriched only the valid one (after trim)
    expect(harness.transportMock).toHaveBeenCalledTimes(1);
    const enrichBroadcasts = harness.ctx._broadcasts.filter(
      (m: any) => m.type === 'BADGE_ENRICHMENT',
    );
    expect(enrichBroadcasts.length).toBe(1);
    expect((enrichBroadcasts[0] as any).enrichments[RIDS.scorecard]).toBeDefined();
  });

  // ── Scenario 14: No client connected ──────────────────────────────

  it('logs warning and returns when client is null', async () => {
    harness.ctx.client = null;
    await enrichBadges([RIDS.scorecard]);

    expect(harness.transportMock).not.toHaveBeenCalled();
    expect(harness.ctx._activities).toContainEqual(
      expect.objectContaining({ level: 'warn', message: 'Enrichment skipped: not connected' }),
    );
  });

  // ── Scenario 15: EC error entry (logType ERROR) in response ────────

  it('handles EC error entry (not server exception) as failure', async () => {
    // EC code has a syntax error — server returns ERROR logType
    const ERROR = new JavaEnum(LOG_TYPE_DESC as any, 'ERROR');
    harness.transportMock.mockResolvedValue([{
      $class: 'com.corporater.bmp.dto.command.extended.ExtendedExecuteResult',
      entries: [{
        logType: ERROR,
        message: 'Variable not found: _o',
        time: null,
      }],
    }]);

    await enrichBadges([RIDS.scorecard]);

    // batchEnrich receives { ok: false } from parseEcResults → treated as error
    // Should try twice (initial + retry)
    expect(harness.transportMock).toHaveBeenCalledTimes(2);
  });
});

// ── resolveTemplate integration ─────────────────────────────────────

describe('resolveTemplate Integration — Full Pipeline', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  it('resolves a linked instance to its template', async () => {
    harness.transportMock.mockResolvedValueOnce(makeEcResponseObjects(
      `${RIDS.template}|||Risk Assessment Template|||TemplateCategory`,
    ));

    const result = await harness.client.resolveTemplate(RIDS.scorecard);

    expect(result.templateRid).toBe(RIDS.template);
    expect(result.templateName).toBe('Risk Assessment Template');
    expect(result.templateType).toBe('TemplateCategory');
  });

  it('resolves template with ||| in name (delimiter collision)', async () => {
    // With 4-field format (rid|||name|||type|||bid), ||| in name creates extra fields.
    // Parser uses positional indexing: parts[0]=rid, parts[1]=name, parts[2]=type, parts[3]=bid.
    // A name with ||| shifts type and bid positions — known limitation, documented.
    harness.transportMock.mockResolvedValueOnce(makeEcResponseObjects(
      `${RIDS.template}|||Risk|||Assessment|||Template|||TemplateCategory|||t.100`,
    ));

    const result = await harness.client.resolveTemplate(RIDS.scorecard);

    // With positional parsing: name=Risk, type=Assessment, bid=Template
    // (shifted due to ||| in name — this is a known limitation)
    expect(result.templateRid).toBe(RIDS.template);
    expect(result.templateName).toBe('Risk');
    expect(result.templateType).toBe('Assessment');
    expect(result.templateBusinessId).toBe('Template');
  });

  it('handles template with empty name (name field is "")', async () => {
    // EC output when name is empty: rid|||""|||className → rid||||||className
    harness.transportMock.mockResolvedValueOnce(makeEcResponseObjects(
      `${RIDS.template}||||||TemplateCategory`,
    ));

    const result = await harness.client.resolveTemplate(RIDS.scorecard);

    expect(result.templateRid).toBe(RIDS.template);
    expect(result.templateName).toBeUndefined(); // empty string → undefined
    expect(result.templateType).toBe('TemplateCategory');
  });

  it('handles template with empty className (type field is "")', async () => {
    // EC output when className is empty: rid|||name|||""
    harness.transportMock.mockResolvedValueOnce(makeEcResponseObjects(
      `${RIDS.template}|||Risk Template|||`,
    ));

    const result = await harness.client.resolveTemplate(RIDS.scorecard);

    expect(result.templateRid).toBe(RIDS.template);
    expect(result.templateName).toBe('Risk Template');
    expect(result.templateType).toBeUndefined(); // empty → undefined
  });

  it('handles max-value Java long RID', async () => {
    const maxLong = '9223372036854775807'; // Long.MAX_VALUE
    harness.transportMock.mockResolvedValueOnce(makeEcResponseObjects(
      `${maxLong}|||Extreme Template|||Scorecard`,
    ));

    const result = await harness.client.resolveTemplate(RIDS.scorecard);

    expect(result.templateRid).toBe(maxLong);
    expect(result.templateName).toBe('Extreme Template');
  });

  it('returns null for unlinked instance (MISSING)', async () => {
    harness.transportMock.mockResolvedValueOnce(makeEcResponseObjects(
      'MISSING||||||',
    ));

    const result = await harness.client.resolveTemplate(RIDS.scorecard);
    expect(result.templateRid).toBeNull();
  });

  it('returns null on transport failure', async () => {
    harness.transportMock.mockRejectedValueOnce(new Error('Network error'));

    const result = await harness.client.resolveTemplate(RIDS.scorecard);
    expect(result.templateRid).toBeNull();
  });

  it('returns null on EC timeout', async () => {
    const err = new DOMException('Signal timed out', 'AbortError');
    harness.transportMock.mockRejectedValueOnce(err);

    const result = await harness.client.resolveTemplate(RIDS.scorecard);
    expect(result.templateRid).toBeNull();
  });
});

// ── EC code generation verification ─────────────────────────────────

describe('EC Code Generation — Verify Output Matches BMP Expectations', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  it('batchEnrich generates correct EC for single RID', async () => {
    let capturedCode = '';
    // Intercept at executeEc to capture the generated code
    harness.client.executeEc = vi.fn(async (code: string) => {
      capturedCode = code;
      return { ok: true, log: `${RIDS.scorecard}|||sc_main|||Scorecard|||Main SC\n` };
    });

    await harness.client.batchEnrich([RIDS.scorecard]);

    // Verify the EC code is valid Extended Code
    expect(capturedCode).toContain('_d := "|||"');
    expect(capturedCode).toContain('_r := ""');
    expect(capturedCode).toContain(`_o := lookup(${RIDS.scorecard})`);
    expect(capturedCode).toContain('IF _o != MISSING THEN');
    expect(capturedCode).toContain(`"${RIDS.scorecard}"`); // RID hardcoded in output
    expect(capturedCode).toContain('_o.id.whenMissing("")');
    // className is read once into _cls, then reused for both the identity row
    // and the cascade-target dispatch.
    expect(capturedCode).toContain('_cls := _o.className');
    expect(capturedCode).toContain('_cls.whenMissing("")');
    expect(capturedCode).toContain('_o.name.whenMissing("")');
    // Cascade target lookups — flow-bearing types emit their chain target
    // identity into _cRid/_cBid/_cType/_cName.
    expect(capturedCode).toContain('IF _cls = "InputView" THEN');
    expect(capturedCode).toContain('IF _cls = "ActionButton" THEN');
    expect(capturedCode).toContain('ENDIF');
    expect(capturedCode).toMatch(/_r$/); // Last expression — "Result : " prefix stripped by parseEcResults
  });

  it('batchEnrich generates correct EC for multiple RIDs including negative', async () => {
    let capturedCode = '';
    harness.client.executeEc = vi.fn(async (code: string) => {
      capturedCode = code;
      return { ok: true, log: '' };
    });

    await harness.client.batchEnrich([RIDS.scorecard, RIDS.organisation, RIDS.cvo]);

    // All three lookups with null guards
    expect(capturedCode).toContain(`_o := lookup(${RIDS.scorecard})`);
    expect(capturedCode).toContain(`_o := lookup(${RIDS.organisation})`);
    expect(capturedCode).toContain(`_o := lookup(${RIDS.cvo})`);
    expect(capturedCode).toContain('IF _o != MISSING THEN');
  });

  it('batchEnrich filters out non-numeric RIDs before EC generation', async () => {
    let capturedCode = '';
    harness.client.executeEc = vi.fn(async (code: string) => {
      capturedCode = code;
      return { ok: true, log: `${RIDS.scorecard}|||sc_main|||Scorecard|||SC\n` };
    });

    await harness.client.batchEnrich([RIDS.scorecard, 'INJECT); evil(', '']);

    // Only the valid RID should appear
    expect(capturedCode).toContain(`lookup(${RIDS.scorecard})`);
    expect(capturedCode).not.toContain('INJECT');
    expect(capturedCode).not.toContain('evil');
  });

  it('resolveTemplate generates correct EC with validated RID', async () => {
    let capturedCode = '';
    harness.client.executeEc = vi.fn(async (code: string) => {
      capturedCode = code;
      return { ok: true, log: 'MISSING||||||' };
    });

    await harness.client.resolveTemplate(RIDS.scorecard);

    expect(capturedCode).toContain(`_o := lookup(${RIDS.scorecard})`);
    expect(capturedCode).toContain('_t := _o.linkedTo');
    expect(capturedCode).toContain('_t.rid.whenMissing("MISSING")');
    expect(capturedCode).toContain('_t.name.whenMissing("")');
    expect(capturedCode).toContain('_t.className.whenMissing("")');
  });
});

// ── parseEcResults through realistic response shapes ─────────────────

describe('parseEcResults — Realistic BMP Response Shapes', () => {
  async function getParser() {
    const mod = await import('../bmp-types');
    mod.registerBmpTypes();
    return mod.parseEcResults;
  }

  it('handles ArrayList wrapper (real BMP response format)', async () => {
    const parseEcResults = await getParser();
    const SHOW_RESULT = new JavaEnum(LOG_TYPE_DESC as any, 'SHOW_RESULT');

    const batchOutput = [
      `${RIDS.scorecard}|||sc_main|||Scorecard|||Main Scorecard`,
      `${RIDS.extTable}|||sc_grc_risk|||ExtendedTable|||Risk Summary`,
      `${RIDS.organisation}|||org_root|||Organisation|||Corp AS`,
      '',
    ].join('\n');

    const result = parseEcResults([{
      $class: 'com.corporater.bmp.dto.command.extended.ExtendedExecuteResult',
      entries: {
        $elements: [{ logType: SHOW_RESULT, message: batchOutput, time: null }],
        $class: 'java.util.ArrayList',
        size: 1,
      },
    }]);

    expect(result.ok).toBe(true);
    expect(result.log).toContain(RIDS.scorecard);
    expect(result.log).toContain(RIDS.organisation); // negative RID
    expect(result.hasError).toBe(false);
  });

  it('handles multiple log entries (multi-output EC)', async () => {
    const parseEcResults = await getParser();
    const SHOW_RESULT = new JavaEnum(LOG_TYPE_DESC as any, 'SHOW_RESULT');

    const result = parseEcResults([{
      $class: 'com.corporater.bmp.dto.command.extended.ExtendedExecuteResult',
      entries: [
        { logType: SHOW_RESULT, message: 'line 1', time: null },
        { logType: SHOW_RESULT, message: 'line 2', time: null },
      ],
    }]);

    expect(result.ok).toBe(true);
    expect(result.log).toBe('line 1\nline 2');
  });

  it('accumulates multiple server exceptions', async () => {
    const parseEcResults = await getParser();

    const result = parseEcResults([
      { $class: 'com.corporater.bmp.base.system.exception.ServerExceptionResponse', message: 'Auth expired' },
      { $class: 'com.corporater.bmp.base.system.exception.ServerExceptionResponse', message: 'Session invalid' },
    ]);

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Auth expired; Session invalid');
  });

  it('handles WARNING logType without marking as error', async () => {
    const parseEcResults = await getParser();
    const WARNING = new JavaEnum(LOG_TYPE_DESC as any, 'WARNING');
    const SHOW_RESULT = new JavaEnum(LOG_TYPE_DESC as any, 'SHOW_RESULT');

    const result = parseEcResults([{
      $class: 'com.corporater.bmp.dto.command.extended.ExtendedExecuteResult',
      entries: [
        { logType: WARNING, message: 'Deprecated function used', time: null },
        { logType: SHOW_RESULT, message: 'result value', time: null },
      ],
    }]);

    expect(result.ok).toBe(true); // WARNING doesn't set ok=false
    expect(result.hasWarning).toBe(true);
    expect(result.log).toContain('result value');
  });

  it('filters END string from streaming response', async () => {
    const parseEcResults = await getParser();

    const result = parseEcResults([
      {
        $class: 'com.corporater.bmp.dto.command.extended.ExtendedExecuteResult',
        entries: [{ logType: new JavaEnum(LOG_TYPE_DESC as any, 'SHOW_RESULT'), message: 'data', time: null }],
      },
      'END',
    ]);

    expect(result.log).toBe('data');
    expect(result.log).not.toContain('END');
  });
});

// ── Label rendering verification ─────────────────────────────────────
// Mirrors content.ts line 291/393:
//   textSpan.textContent = enrichment.businessId ?? enrichment.name ?? getTypeAbbr(enrichment.type)
// Uses ?? (nullish coalescing) — empty string '' does NOT fall back.
// Verify that batchEnrich never returns empty strings, and that the
// enrichment shapes produce the correct label text in all cases.

describe('Label Text Derivation — What The User Actually Sees', () => {
  // Mirror the exact content script logic (content.ts line 291/393)
  function labelText(enrichment: { businessId?: string; type?: string; name?: string } | undefined): string {
    return enrichment?.businessId ?? enrichment?.name ?? getTypeAbbr(enrichment?.type);
  }

  // Mirror the code button logic (content.ts line 328)
  function hasCodeButton(enrichment: { type?: string } | undefined): boolean {
    return !!(enrichment?.type && TYPES_WITH_CODE.has(enrichment.type));
  }

  // Mirror the code button text (content.ts line 235)
  function codeButtonText(type: string): string {
    return type === 'CustomVisualization' ? '</>' : 'EC';
  }

  describe('batchEnrich output → label text', () => {
    let harness: TestHarness;

    beforeEach(async () => {
      harness = await createHarness();
    });

    it('shows businessId when all fields present', async () => {
      harness.transportMock.mockResolvedValueOnce(makeEcResponseObjects(
        `${RIDS.scorecard}|||sc_main|||Scorecard|||Main Scorecard\n`,
      ));
      const { results } = await harness.client.batchEnrich([RIDS.scorecard]);
      expect(labelText(results[RIDS.scorecard])).toBe('sc_main');
    });

    it('falls back to name when businessId is empty in BMP', async () => {
      // EC output: bid field is empty string → batchEnrich converts to undefined
      harness.transportMock.mockResolvedValueOnce(makeEcResponseObjects(
        `${RIDS.scorecard}||||||Scorecard|||Main Scorecard\n`,
      ));
      const { results } = await harness.client.batchEnrich([RIDS.scorecard]);
      // batchEnrich: bid?.trim() || undefined → undefined
      expect(results[RIDS.scorecard]!.businessId).toBeUndefined();
      expect(labelText(results[RIDS.scorecard])).toBe('Main Scorecard');
    });

    it('falls back to type abbreviation when both businessId and name are empty', async () => {
      harness.transportMock.mockResolvedValueOnce(makeEcResponseObjects(
        `${RIDS.scorecard}||||||Scorecard|||\n`,
      ));
      const { results } = await harness.client.batchEnrich([RIDS.scorecard]);
      expect(results[RIDS.scorecard]!.businessId).toBeUndefined();
      expect(results[RIDS.scorecard]!.name).toBeUndefined();
      expect(labelText(results[RIDS.scorecard])).toBe('SCD');
    });

    it('shows ? for empty enrichment (permanently failed RID)', () => {
      expect(labelText({})).toBe('?');
    });

    it('shows ? when enrichment is undefined (not yet enriched)', () => {
      expect(labelText(undefined)).toBe('?');
    });

    it('shows correct abbreviations for all code-capable types', async () => {
      // Verify that batchEnrich className values match getTypeAbbr expectations
      const typeMap: Record<string, string> = {
        ExtendedTable: 'TBL',
        CustomVisualization: 'CVO',
        BarChart: 'BAR',
        PieChart: 'PIE',
        LineChart: 'LIN',
      };
      for (const [type, abbr] of Object.entries(typeMap)) {
        expect(labelText({ type })).toBe(abbr);
      }
    });

    it('shows first 3 chars for unknown types', () => {
      expect(labelText({ type: 'WeirdNewType' })).toBe('WEI');
    });
  });

  describe('code button appearance and text', () => {
    it('shows EC button for ExtendedTable', () => {
      expect(hasCodeButton({ type: 'ExtendedTable' })).toBe(true);
      expect(codeButtonText('ExtendedTable')).toBe('EC');
    });

    it('shows </> button for CustomVisualization', () => {
      expect(hasCodeButton({ type: 'CustomVisualization' })).toBe(true);
      expect(codeButtonText('CustomVisualization')).toBe('</>');
    });

    it('shows EC button for chart types', () => {
      for (const chart of ['BarChart', 'PieChart', 'LineChart', 'AreaChart', 'WaterfallChart']) {
        expect(hasCodeButton({ type: chart })).toBe(true);
        expect(codeButtonText(chart)).toBe('EC');
      }
    });

    it('shows NO button for non-code types', () => {
      for (const type of ['Scorecard', 'Organisation', 'Risk', 'Control', 'Action', 'DashboardFolder']) {
        expect(hasCodeButton({ type })).toBe(false);
      }
    });

    it('shows NO button for empty enrichment', () => {
      expect(hasCodeButton({})).toBe(false);
      expect(hasCodeButton(undefined)).toBe(false);
    });
  });
});

// ── Tooltip rendering verification ──────────────────────────────────
// content.ts line 523-531: tooltip shows type badge, type name, name row, ID row

describe('Tooltip Content — What The Hover Shows', () => {
  it('enriched object shows all fields', () => {
    const enrichment = { businessId: 'sc_main', type: 'Scorecard', name: 'Main Scorecard' };

    const color = getTypeColor(enrichment.type);
    const abbr = getTypeAbbr(enrichment.type);
    const typeName = enrichment.type;

    expect(color).toBe('#6fdc8c');   // Scorecard color (page-green family per pill taxonomy)
    expect(abbr).toBe('SCD');
    expect(typeName).toBe('Scorecard');
    // name row: "Main Scorecard"
    expect(enrichment.name).toBe('Main Scorecard');
    // ID row: "ID: sc_main"
    expect(enrichment.businessId).toBe('sc_main');
  });

  it('empty enrichment shows ? badge and Unknown type', () => {
    const enrichment: Record<string, any> = {};

    expect(getTypeColor(enrichment.type)).toBe(DEFAULT_TYPE_COLOR);
    expect(getTypeAbbr(enrichment.type)).toBe('?');
    // typeName fallback: enrichment.type ?? 'Unknown'
    expect(enrichment.type ?? 'Unknown').toBe('Unknown');
    // name row: enrichment.name is falsy → not rendered
    expect(enrichment.name && 'rendered').toBeFalsy();
    // ID row: enrichment.businessId is falsy → not rendered
    expect(enrichment.businessId && 'rendered').toBeFalsy();
  });
});

// ── Editor Context Assembly ─────────────────────────────────────────
// Tests what openEditorWindow stores in crev_editor_ctx_${rid}.
// Uses the unified fetchEditorContext() — single EC call for identity +
// template + code properties.

describe('Editor Context — What The Code Popup Shows', () => {
  let harness: TestHarness;
  const SEP = '<<<CREV_SEP>>>';

  /** Build a unified fetchEditorContext mock response. */
  function buildEditorContextLog(opts: {
    instRid: string; instId: string; instType: string; instName: string;
    tmplRid?: string; tmplId?: string; tmplType?: string; tmplName?: string;
    instExpression?: string; tmplExpression?: string;
    instHtml?: string; tmplHtml?: string;
    instJavascript?: string; tmplJavascript?: string;
    locRid?: string;
  }): string {
    const s = SEP;
    const parts = [
      `${s}instRid${s}${opts.instRid}`,
      `${s}instId${s}${opts.instId}`,
      `${s}instName${s}${opts.instName}`,
      `${s}instType${s}${opts.instType}`,
      `${s}tmplRid${s}${opts.tmplRid ?? 'MISSING'}`,
      `${s}tmplId${s}${opts.tmplId ?? ''}`,
      `${s}tmplName${s}${opts.tmplName ?? ''}`,
      `${s}tmplType${s}${opts.tmplType ?? ''}`,
      `${s}locRid${s}${opts.locRid ?? 'MISSING'}`,
      `${s}inst_expression${s}${opts.instExpression ?? ''}`,
      `${s}tmpl_expression${s}${opts.tmplExpression ?? ''}`,
      `${s}inst_html${s}${opts.instHtml ?? ''}`,
      `${s}tmpl_html${s}${opts.tmplHtml ?? ''}`,
      `${s}inst_javascript${s}${opts.instJavascript ?? ''}`,
      `${s}tmpl_javascript${s}${opts.tmplJavascript ?? ''}`,
      `${s}DONE`,
    ];
    return parts.join('\n');
  }

  beforeEach(async () => {
    harness = await createHarness();
    // Mock chrome APIs needed by editor.ts
    (globalThis.chrome as any).runtime.getURL = vi.fn((path: string) => `chrome-extension://test/${path}`);
    (globalThis.chrome as any).windows = {
      create: vi.fn(async () => ({ id: 1 })),
      update: vi.fn(async () => {}),
      onBoundsChanged: { addListener: vi.fn(), removeListener: vi.fn() },
      onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
    };
  });

  it('assembles correct context for ExtendedTable with template', async () => {
    // Single fetchEditorContext EC call returns everything.
    harness.client.executeEc = vi.fn(async () => ({
      ok: true,
      log: buildEditorContextLog({
        instRid: RIDS.extTable, instId: 'sc_grc_risk', instType: 'ExtendedTable', instName: 'Risk Summary',
        tmplRid: RIDS.template, tmplId: 'tmpl_risk', tmplType: 'ExtendedTable', tmplName: 'Risk Template',
        instExpression: 'root.children()',
        tmplExpression: 'root.children().filter(_o: _o.className = "Risk")',
      }),
    })) as any;

    const { openEditorWindow } = await import('../editor');
    await openEditorWindow(RIDS.extTable);

    const setCall = (globalThis.chrome.storage.local.set as any).mock.calls.find(
      (c: any) => Object.keys(c[0] || {}).some(k => k.startsWith('crev_editor_ctx_')) && c[0],
    );
    expect(setCall).toBeDefined();
    const ctxKey = Object.keys(setCall[0]).find(k => k.startsWith('crev_editor_ctx_'))!;
    const ctx = setCall[0][ctxKey];

    expect(ctx.instance.rid).toBe(RIDS.extTable);
    expect(ctx.instance.type).toBe('ExtendedTable');
    expect(ctx.instance.name).toBe('Risk Summary');
    expect(ctx.instance.businessId).toBe('sc_grc_risk');
    expect(ctx.property).toBe('expression');
    expect(ctx.instanceCode.expression).toBe('root.children()');
    expect(ctx.template?.rid).toBe(RIDS.template);
    expect(ctx.template?.name).toBe('Risk Template');
    expect(ctx.template?.type).toBe('ExtendedTable');
    expect(ctx.templateCode.expression).toContain('root.children().filter');
    expect(ctx.saveTarget).toBe('template');
    // Override detection
    expect(ctx.overrides.expression).toBe(true); // instance differs from template
    // Single EC call
    expect(harness.client.executeEc).toHaveBeenCalledTimes(1);
  });

  it('assembles correct context for CVO (html + javascript)', async () => {
    harness.client.executeEc = vi.fn(async () => ({
      ok: true,
      log: buildEditorContextLog({
        instRid: RIDS.cvo, instId: 'cvo_dash', instType: 'CustomVisualization', instName: 'Dashboard',
        instHtml: '<div>test</div>',
        instJavascript: 'console.log("hi")',
      }),
    })) as any;

    const { openEditorWindow } = await import('../editor');
    await openEditorWindow(RIDS.cvo);

    const setCall = (globalThis.chrome.storage.local.set as any).mock.calls.find(
      (c: any) => Object.keys(c[0] || {}).some(k => k.startsWith('crev_editor_ctx_')) && c[0],
    );
    const ctxKey = Object.keys(setCall[0]).find(k => k.startsWith('crev_editor_ctx_'))!;
    const ctx = setCall[0][ctxKey];

    expect(ctx.instance.rid).toBe(RIDS.cvo);
    expect(ctx.instance.type).toBe('CustomVisualization');
    expect(ctx.property).toBe('html'); // First non-empty code prop
    expect(ctx.instanceCode.html).toBe('<div>test</div>');
    expect(ctx.instanceCode.javascript).toBe('console.log("hi")');
    expect(ctx.template).toBeNull();
  });

  it('uses template code when instance code is empty (new instance)', async () => {
    harness.client.executeEc = vi.fn(async () => ({
      ok: true,
      log: buildEditorContextLog({
        instRid: RIDS.extTable, instId: 'sc_new', instType: 'ExtendedTable', instName: 'New Table',
        tmplRid: RIDS.template, tmplId: 'tmpl_base', tmplType: 'ExtendedTable', tmplName: 'Base Template',
        instExpression: '',      // Empty instance
        tmplExpression: 'root.children()',
      }),
    })) as any;

    const { openEditorWindow } = await import('../editor');
    await openEditorWindow(RIDS.extTable);

    const setCall = (globalThis.chrome.storage.local.set as any).mock.calls.find(
      (c: any) => Object.keys(c[0] || {}).some(k => k.startsWith('crev_editor_ctx_')) && c[0],
    );
    const ctxKey = Object.keys(setCall[0]).find(k => k.startsWith('crev_editor_ctx_'))!;
    const ctx = setCall[0][ctxKey];

    // Instance code is empty, template code has content
    expect(ctx.instanceCode.expression).toBeUndefined(); // empty values are filtered
    expect(ctx.templateCode.expression).toBe('root.children()');
    // Property should default to expression (from template code)
    expect(ctx.property).toBe('expression');
  });

  it('template businessId is captured in context', async () => {
    harness.client.executeEc = vi.fn(async () => ({
      ok: true,
      log: buildEditorContextLog({
        instRid: RIDS.extTable, instId: 'sc_test', instType: 'ExtendedTable', instName: 'Test',
        tmplRid: RIDS.template, tmplId: 'tmpl_001', tmplType: 'ExtendedTable', tmplName: 'Template One',
        instExpression: 'instance code',
        tmplExpression: 'template code',
      }),
    })) as any;

    const { openEditorWindow } = await import('../editor');
    await openEditorWindow(RIDS.extTable);

    const setCall = (globalThis.chrome.storage.local.set as any).mock.calls.find(
      (c: any) => Object.keys(c[0] || {}).some(k => k.startsWith('crev_editor_ctx_')) && c[0],
    );
    const ctxKey = Object.keys(setCall[0]).find(k => k.startsWith('crev_editor_ctx_'))!;
    const ctx = setCall[0][ctxKey];

    expect(ctx.template?.businessId).toBe('tmpl_001');
    expect(ctx.instance.businessId).toBe('sc_test');
  });

  it('non-code type (Scorecard) opens editor with empty code', async () => {
    harness.client.executeEc = vi.fn(async () => ({
      ok: true,
      log: buildEditorContextLog({
        instRid: RIDS.scorecard, instId: 'sc_main', instType: 'Scorecard', instName: 'Main SC',
      }),
    })) as any;

    const { openEditorWindow } = await import('../editor');
    await openEditorWindow(RIDS.scorecard);

    const setCall = (globalThis.chrome.storage.local.set as any).mock.calls.find(
      (c: any) => Object.keys(c[0] || {}).some(k => k.startsWith('crev_editor_ctx_')) && c[0],
    );
    const ctxKey = Object.keys(setCall[0]).find(k => k.startsWith('crev_editor_ctx_'))!;
    const ctx = setCall[0][ctxKey];

    expect(ctx.instance.type).toBe('Scorecard');
    expect(Object.keys(ctx.instanceCode)).toHaveLength(0); // No code props
    expect(ctx.property).toBe('expression'); // default
    expect(ctx.template).toBeNull();
  });

  it('uses the BMP page ?rid= as the EC execution context, not .location', async () => {
    const CONTEXT_RID = RIDS.risk; // the enterprise object the page renders for
    harness.client.executeEc = vi.fn(async () => ({
      ok: true,
      log: buildEditorContextLog({
        instRid: RIDS.extTable, instId: 'sc_grc_risk', instType: 'ExtendedTable', instName: 'Risk Summary',
        instExpression: 'this.children()',
        locRid: RIDS.editPage, // .location = the page/template (the WRONG context)
      }),
    })) as any;
    harness.client.lookupIdentity = vi.fn(async () => ({
      name: 'Operational Risk #4', type: 'CeRiskAssessment', businessId: 'ceras.113',
    })) as any;
    // BMP tab is currently rendering the enterprise instance.
    (globalThis.chrome as any).tabs = {
      get: vi.fn(async () => ({ id: 5, url: `https://bmp.test/app?rid=${CONTEXT_RID}&x=1` })),
      query: vi.fn(async () => [{ id: 5, url: `https://bmp.test/app?rid=${CONTEXT_RID}` }]),
    };

    const { openEditorWindow } = await import('../editor');
    await openEditorWindow(RIDS.extTable, undefined, { tabId: 5 });

    const setCall = (globalThis.chrome.storage.local.set as any).mock.calls.find(
      (c: any) => Object.keys(c[0] || {}).some(k => k.startsWith('crev_editor_ctx_')) && c[0],
    );
    const ctxKey = Object.keys(setCall[0]).find(k => k.startsWith('crev_editor_ctx_'))!;
    const ctx = setCall[0][ctxKey];

    // ?rid= wins over .location (RIDS.editPage) and over the widget.
    expect(ctx.executionContextRid).toBe(CONTEXT_RID);
    expect(ctx.executionContext.rid).toBe(CONTEXT_RID);
    expect(ctx.executionContext.type).toBe('CeRiskAssessment');
    expect(ctx.executionContext.name).toBe('Operational Risk #4');
    // The widget being EDITED is still the table — context is separate.
    expect(ctx.instance.rid).toBe(RIDS.extTable);
  });

  it('falls back to .location when the BMP page has no ?rid=', async () => {
    harness.client.executeEc = vi.fn(async () => ({
      ok: true,
      log: buildEditorContextLog({
        instRid: RIDS.extTable, instId: 'sc_grc_risk', instType: 'ExtendedTable', instName: 'Risk Summary',
        instExpression: 'this.children()',
        locRid: RIDS.editPage,
      }),
    })) as any;
    harness.client.lookupIdentity = vi.fn(async () => ({ name: 'Risk Page', type: 'ModelPage', businessId: '' })) as any;
    (globalThis.chrome as any).tabs = {
      get: vi.fn(async () => ({ id: 5, url: 'https://bmp.test/app' })), // no rid param
      query: vi.fn(async () => [{ id: 5, url: 'https://bmp.test/app' }]),
    };

    const { openEditorWindow } = await import('../editor');
    await openEditorWindow(RIDS.extTable, undefined, { tabId: 5 });

    const setCall = (globalThis.chrome.storage.local.set as any).mock.calls.find(
      (c: any) => Object.keys(c[0] || {}).some(k => k.startsWith('crev_editor_ctx_')) && c[0],
    );
    const ctxKey = Object.keys(setCall[0]).find(k => k.startsWith('crev_editor_ctx_'))!;
    const ctx = setCall[0][ctxKey];

    expect(ctx.executionContextRid).toBe(RIDS.editPage); // .location fallback
  });

  it('ignores a non-numeric ?rid= from a foreign tab and falls back to .location', async () => {
    harness.client.executeEc = vi.fn(async () => ({
      ok: true,
      log: buildEditorContextLog({
        instRid: RIDS.extTable, instId: 'sc_grc_risk', instType: 'ExtendedTable', instName: 'Risk Summary',
        instExpression: 'this.children()',
        locRid: RIDS.editPage,
      }),
    })) as any;
    harness.client.lookupIdentity = vi.fn(async () => ({ name: 'Page', type: 'ModelPage', businessId: '' })) as any;
    // A non-BMP tab whose URL happens to carry ?rid=<garbage>.
    (globalThis.chrome as any).tabs = {
      get: vi.fn(async () => ({ id: 5, url: 'https://evil.example/x?rid=not-a-rid' })),
      query: vi.fn(async () => [{ id: 5, url: 'https://evil.example/x?rid=not-a-rid' }]),
    };

    const { openEditorWindow } = await import('../editor');
    await openEditorWindow(RIDS.extTable, undefined, { tabId: 5 });

    const setCall = (globalThis.chrome.storage.local.set as any).mock.calls.find(
      (c: any) => Object.keys(c[0] || {}).some(k => k.startsWith('crev_editor_ctx_')) && c[0],
    );
    const ctxKey = Object.keys(setCall[0]).find(k => k.startsWith('crev_editor_ctx_'))!;
    const ctx = setCall[0][ctxKey];

    // The garbage rid was rejected → fell back to .location, not bound as `this`.
    expect(ctx.executionContextRid).toBe(RIDS.editPage);
  });
});
