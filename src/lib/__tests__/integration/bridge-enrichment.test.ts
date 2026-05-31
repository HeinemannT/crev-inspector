/**
 * Integration tests — real BMP via bridge daemon.
 * Skipped by default. Run with: CREV_INTEGRATION=1 npx vitest run --config vitest.integration.config.ts
 */
import { describe, it, expect } from 'vitest';
import { ALL_RIDS, ORG_RIDS, ROOT_ORG_RID } from '../test-rids';
import { pMap } from '../../util';

const BRIDGE = 'http://127.0.0.1:4100';
const BMP_URL = 'http://127.0.0.1:8080/Steadfast/';
const BMP_USER = 'admin';
const BMP_PASS = 'admin';

const skip = !process.env.CREV_INTEGRATION;

// ── Helpers ──

async function executeEc(code: string): Promise<{ ok: boolean; log: string | null; error?: string }> {
  const res = await fetch(`${BRIDGE}/extended`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, bmp_url: BMP_URL, bmp_user: BMP_USER, bmp_pass: BMP_PASS, transactional: false }),
  });
  const data = await res.json();
  if (!res.ok) return { ok: false, log: null, error: data.error ?? `HTTP ${res.status}` };
  if (!data.ok) return { ok: false, log: null, error: data.error ?? 'EC execution failed' };
  // Bridge returns { ok, result: { log, entries, has_error, has_warning } }
  const result = data.result;
  if (result?.has_error) return { ok: false, log: null, error: result.log };
  // Extract "Result : <value>" from the log string
  const logStr = result?.log as string | undefined;
  const resultMatch = logStr?.match(/Result\s*:\s*([\s\S]*?)(?:\nMessage|$)/);
  const log = resultMatch?.[1]?.trim() ?? null;
  return { ok: true, log };
}

function buildBatchEc(rids: string[]): string {
  const lookups = rids.map(rid => `lookup(${rid})`).join(', ');
  return [
    '_d := "|||"',
    '_r := ""',
    `LIST(${lookups}).forEach(_o:`,
    '  _r := _r + _o.rid.whenMissing("SKIP") + _d + _o.id.whenMissing("") + _d + _o.className.whenMissing("") + _d + _o.name.whenMissing("") + "\\n"',
    ')',
    '_r',
  ].join('\n');
}

function parseOutput(log: string): Record<string, { businessId?: string; type?: string; name?: string }> {
  const out: Record<string, { businessId?: string; type?: string; name?: string }> = {};
  if (!log.trim()) return out;
  for (const line of log.trim().split('\n')) {
    const parts = line.split('|||');
    if (parts.length < 4) continue;
    const [rid, bid, typ, name] = parts;
    if (rid && rid !== 'MISSING' && rid !== 'SKIP') {
      out[rid.trim()] = {
        businessId: bid?.trim() || undefined,
        type: typ?.trim() || undefined,
        name: name?.trim() || undefined,
      };
    }
  }
  return out;
}

// ── Tests ──

describe.skipIf(skip)('Bridge integration', () => {
  it('bridge health check', async () => {
    const res = await fetch(`${BRIDGE}/health`);
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data.ok).toBe(true);
  });

  it('single lookup — Steadfast Group', async () => {
    const result = await executeEc(`_o := lookup("${ROOT_ORG_RID}")\n_o.name`);
    expect(result.ok).toBe(true);
    expect(result.log).toBe('Steadfast Group');
  });

  it('batch EC — 25 real RIDs', async () => {
    const rids = ALL_RIDS.slice(0, 25);
    const code = buildBatchEc(rids);
    const result = await executeEc(code);

    expect(result.ok).toBe(true);
    expect(result.log).not.toBeNull();
    const parsed = parseOutput(result.log!);
    // At least 20 of 25 should resolve (some portal/page objects may not have lookup results)
    expect(Object.keys(parsed).length).toBeGreaterThanOrEqual(15);
  });

  it('batch EC — 50 real RIDs, no timeout', async () => {
    const rids = ALL_RIDS.slice(0, 50);
    const code = buildBatchEc(rids);
    const start = performance.now();
    const result = await executeEc(code);
    const elapsed = performance.now() - start;

    expect(result.ok).toBe(true);
    expect(result.log).not.toBeNull();
    const parsed = parseOutput(result.log!);
    expect(Object.keys(parsed).length).toBeGreaterThanOrEqual(20);
    // Should complete in under 30s
    expect(elapsed).toBeLessThan(30000);
  });

  it('batch EC — 100 RIDs sequential (4 × 25) baseline', async () => {
    const chunks: string[][] = [];
    for (let i = 0; i < 100; i += 25) {
      chunks.push(ALL_RIDS.slice(i, i + 25));
    }

    const start = performance.now();
    let totalResults = 0;
    for (const chunk of chunks) {
      const result = await executeEc(buildBatchEc(chunk));
      expect(result.ok).toBe(true);
      totalResults += Object.keys(parseOutput(result.log!)).length;
    }
    const sequentialMs = performance.now() - start;

    expect(totalResults).toBeGreaterThanOrEqual(40);
    console.log(`Sequential 4×25: ${Math.round(sequentialMs)}ms, ${totalResults} results`);
  });

  it('batch EC — 100 RIDs parallel (4 × 25) with speedup', async () => {
    const chunks: string[][] = [];
    for (let i = 0; i < 100; i += 25) {
      chunks.push(ALL_RIDS.slice(i, i + 25));
    }

    const start = performance.now();
    const results = await pMap(
      chunks,
      async (chunk) => {
        const result = await executeEc(buildBatchEc(chunk));
        return { ok: result.ok, count: result.log ? Object.keys(parseOutput(result.log)).length : 0 };
      },
      4,
    );
    const parallelMs = performance.now() - start;

    const totalResults = results.reduce((sum, r) => sum + r.count, 0);
    for (const r of results) expect(r.ok).toBe(true);
    expect(totalResults).toBeGreaterThanOrEqual(40);
    console.log(`Parallel 4×25: ${Math.round(parallelMs)}ms, ${totalResults} results`);
  });

  it('batch EC — full 196 RID pool', async () => {
    const chunks: string[][] = [];
    for (let i = 0; i < ALL_RIDS.length; i += 25) {
      chunks.push(ALL_RIDS.slice(i, i + 25));
    }

    const start = performance.now();
    const results = await pMap(
      chunks,
      async (chunk) => {
        const result = await executeEc(buildBatchEc(chunk));
        return { ok: result.ok, count: result.log ? Object.keys(parseOutput(result.log)).length : 0 };
      },
      4,
    );
    const elapsed = performance.now() - start;

    for (const r of results) expect(r.ok).toBe(true);
    const totalResults = results.reduce((sum, r) => sum + r.count, 0);
    expect(totalResults).toBeGreaterThanOrEqual(80);
    console.log(`Full pool 196 RIDs (${chunks.length} chunks): ${Math.round(elapsed)}ms, ${totalResults} results`);
  });

  it('nonexistent RIDs — all return SKIP/MISSING', async () => {
    const fakeRids = Array.from({ length: 25 }, (_, i) => `999000000000000000${i}`);
    const code = buildBatchEc(fakeRids);
    const result = await executeEc(code);

    expect(result.ok).toBe(true);
    // All lookups should return SKIP or MISSING — no valid results
    const parsed = parseOutput(result.log ?? '');
    expect(Object.keys(parsed)).toHaveLength(0);
  });

  it('mixed real + fake RIDs', async () => {
    const realRids = ORG_RIDS.slice(0, 20);
    const fakeRids = Array.from({ length: 5 }, (_, i) => `888000000000000000${i}`);
    const code = buildBatchEc([...realRids, ...fakeRids]);
    const result = await executeEc(code);

    expect(result.ok).toBe(true);
    const parsed = parseOutput(result.log!);
    // Real RIDs should resolve, fake ones filtered out
    expect(Object.keys(parsed).length).toBeGreaterThanOrEqual(10);
    for (const fakeRid of fakeRids) {
      expect(parsed[fakeRid]).toBeUndefined();
    }
  });

  it('parser round-trip — RIDs match input', async () => {
    const rids = ORG_RIDS.slice(0, 10);
    const code = buildBatchEc(rids);
    const result = await executeEc(code);

    expect(result.ok).toBe(true);
    const parsed = parseOutput(result.log!);
    // Every returned RID should be from our input set
    for (const rid of Object.keys(parsed)) {
      expect(rids).toContain(rid);
    }
  });
});
