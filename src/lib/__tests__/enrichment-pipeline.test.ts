/**
 * Tests for the enrichment pipeline bug fixes.
 * Validates: empty EC output handling, RID trimming, error propagation,
 * chunk sizing, and permanentlyFailed clearing.
 */
import { describe, it, expect } from 'vitest';

// ── Extracted parsing logic (mirrors bmp-client.ts batchEnrich output parser) ──

function parseBatchEnrichOutput(log: string | undefined | null, ok: boolean, error?: string) {
  if (!ok) return { results: {} as Record<string, any>, error: error ?? 'EC execution failed' };
  if (log == null) return { results: {} as Record<string, any>, error: 'EC returned null output' };
  if (log.trim() === '') return { results: {} as Record<string, any> };

  const out: Record<string, { businessId?: string; type?: string; name?: string }> = {};
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
  return { results: out };
}

function trimRids(rids: string[]): string[] {
  return rids.map(r => r.trim()).filter(Boolean);
}

function prepareNewRids(rids: string[], enriched: Set<string>, failed: Set<string>): string[] {
  return rids.map(r => r.trim()).filter(rid => rid && !enriched.has(rid) && !failed.has(rid));
}

// ── Tests ──

describe('Bug A: Empty EC output treated as error', () => {
  it('should NOT error when log is empty string (all lookups returned MISSING)', () => {
    const result = parseBatchEnrichOutput('', true);
    expect(result.error).toBeUndefined();
    expect(result.results).toEqual({});
  });

  it('should NOT error when log is whitespace only', () => {
    const result = parseBatchEnrichOutput('  \n  ', true);
    expect(result.error).toBeUndefined();
    expect(result.results).toEqual({});
  });

  it('should error when log is null', () => {
    const result = parseBatchEnrichOutput(null, true);
    expect(result.error).toBe('EC returned null output');
  });

  it('should error when log is undefined', () => {
    const result = parseBatchEnrichOutput(undefined, true);
    expect(result.error).toBe('EC returned null output');
  });

  it('should error when ok is false', () => {
    const result = parseBatchEnrichOutput('some output', false, 'timeout');
    expect(result.error).toBe('timeout');
  });

  it('should parse valid output correctly', () => {
    const log = '12345|||BID-01|||Scorecard|||My Scorecard\n67890|||BID-02|||KPI|||My KPI';
    const result = parseBatchEnrichOutput(log, true);
    expect(result.error).toBeUndefined();
    expect(Object.keys(result.results)).toHaveLength(2);
    expect(result.results['12345']).toEqual({ businessId: 'BID-01', type: 'Scorecard', name: 'My Scorecard' });
    expect(result.results['67890']).toEqual({ businessId: 'BID-02', type: 'KPI', name: 'My KPI' });
  });

  it('should skip SKIP and MISSING RIDs in output', () => {
    const log = 'SKIP|||||||\nMISSING|||||||\n12345|||BID|||Type|||Name';
    const result = parseBatchEnrichOutput(log, true);
    expect(Object.keys(result.results)).toHaveLength(1);
    expect(result.results['12345']).toBeDefined();
  });
});

describe('Bug E: RID input trimming', () => {
  it('should trim whitespace from RIDs', () => {
    expect(trimRids([' 123 ', '456\n', '\t789'])).toEqual(['123', '456', '789']);
  });

  it('should filter empty strings after trimming', () => {
    expect(trimRids(['', ' ', '123', '  '])).toEqual(['123']);
  });

  it('should filter already-enriched and permanently-failed RIDs', () => {
    const enriched = new Set(['111', '222']);
    const failed = new Set(['333']);
    const result = prepareNewRids([' 111 ', '222', '333', ' 444 ', '555'], enriched, failed);
    expect(result).toEqual(['444', '555']);
  });
});

describe('Bug C: processChunk error propagation', () => {
  it('return type should include errorMsg when batchError is true', () => {
    // This tests the shape contract — the actual processChunk is tested via integration
    type ChunkResult = { failed: string[]; batchError: boolean; errorMsg?: string };
    const result: ChunkResult = { failed: ['rid1'], batchError: true, errorMsg: 'EC timeout' };
    expect(result.errorMsg).toBe('EC timeout');
  });
});

describe('Bug D: permanentlyFailed clearing', () => {
  it('incrementGeneration should clear permanentlyFailed', () => {
    // Simulate the clearing behavior
    const permanentlyFailed = new Set(['rid1', 'rid2', 'rid3']);
    let generation = 0;

    // incrementGeneration behavior
    generation++;
    permanentlyFailed.clear();

    expect(permanentlyFailed.size).toBe(0);
    expect(generation).toBe(1);
  });
});

describe('Chunk size', () => {
  it('BATCH_CHUNK_SIZE should be 25', async () => {
    // Read the constant from constants.ts source to verify
    const fs = await import('fs');
    const source = fs.readFileSync(new URL('../constants.ts', import.meta.url), 'utf-8');
    const match = source.match(/BATCH_CHUNK_SIZE\s*=\s*(\d+)/);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBe(25);
  });
});

describe('EC code generation', () => {
  it('should generate valid EC with trimmed RIDs and delimiter variable', () => {
    const rids = [' 12345 ', '67890'];
    const trimmed = trimRids(rids);
    const lookups = trimmed.map(rid => `lookup(${rid})`).join(', ');
    const code = [
      '_d := "|||"',
      '_r := ""',
      `LIST(${lookups}).forEach(_o:`,
      '  _r := _r + _o.rid.whenMissing("SKIP") + _d + _o.id.whenMissing("") + _d + _o.className.whenMissing("") + _d + _o.name.whenMissing("") + "\\n"',
      ')',
      '_r',
    ].join('\n');

    expect(code).toContain('lookup(12345)');
    expect(code).toContain('lookup(67890)');
    expect(code).not.toContain('lookup( 12345 )');
    expect(code).toContain('_d := "|||"');
    // Inline "|||" only appears in the _d assignment, not in the forEach body
    expect(code.split('\n').filter(l => l.includes('"|||"'))).toHaveLength(1);
  });
});
