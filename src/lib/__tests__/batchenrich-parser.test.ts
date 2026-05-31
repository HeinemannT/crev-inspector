/**
 * Parser edge cases at scale — tests the batchEnrich output parser
 * extracted from bmp-client.ts (same logic as enrichment-pipeline.test.ts).
 */
import { describe, it, expect } from 'vitest';
import { ALL_RIDS } from './test-rids';

// ── Parser (mirrors bmp-client.ts:434-447) ──

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

function generateLine(rid: string, bid: string, type: string, name: string): string {
  return `${rid}|||${bid}|||${type}|||${name}`;
}

describe('Parser at scale', () => {
  it('parses 50-line output using real RIDs', () => {
    const rids = ALL_RIDS.slice(0, 50);
    const log = rids.map((rid, i) => generateLine(rid, `BID-${i}`, 'Scorecard', `Object ${i}`)).join('\n');
    const result = parseBatchEnrichOutput(log, true);
    expect(result.error).toBeUndefined();
    expect(Object.keys(result.results)).toHaveLength(50);
    for (const rid of rids) {
      expect(result.results[rid]).toBeDefined();
    }
  });

  it('parses 196-line output (full RID pool)', () => {
    const log = ALL_RIDS.map((rid, i) => generateLine(rid, `BID-${i}`, 'Organisation', `Obj ${i}`)).join('\n');
    const result = parseBatchEnrichOutput(log, true);
    expect(result.error).toBeUndefined();
    expect(Object.keys(result.results)).toHaveLength(196);
  });

  it('handles extra ||| in name field (known limitation: truncates)', () => {
    const log = '12345|||BID|||Type|||Name with ||| inside';
    const result = parseBatchEnrichOutput(log, true);
    // Parser splits on ||| — name becomes "Name with " (4th part only)
    expect(result.results['12345']).toBeDefined();
    expect(result.results['12345'].name).toBe('Name with');
  });

  it('preserves unicode in name fields', () => {
    const log = [
      `${ALL_RIDS[0]}|||BID-1|||Type|||日本語テスト`,
      `${ALL_RIDS[1]}|||BID-2|||Type|||Ünîcödé Tëst`,
      `${ALL_RIDS[2]}|||BID-3|||Type|||测试名称`,
    ].join('\n');
    const result = parseBatchEnrichOutput(log, true);
    expect(result.results[ALL_RIDS[0]].name).toBe('日本語テスト');
    expect(result.results[ALL_RIDS[1]].name).toBe('Ünîcödé Tëst');
    expect(result.results[ALL_RIDS[2]].name).toBe('测试名称');
  });

  it('handles very long name (1000 chars)', () => {
    const longName = 'A'.repeat(1000);
    const log = generateLine(ALL_RIDS[0], 'BID', 'Type', longName);
    const result = parseBatchEnrichOutput(log, true);
    expect(result.results[ALL_RIDS[0]].name).toBe(longName);
  });

  it('filters mixed SKIP/MISSING/valid at scale', () => {
    const lines: string[] = [];
    // 30 valid
    for (let i = 0; i < 30; i++) {
      lines.push(generateLine(ALL_RIDS[i], `BID-${i}`, 'Type', `Name ${i}`));
    }
    // 10 SKIP
    for (let i = 0; i < 10; i++) lines.push('SKIP||||||');
    // 10 MISSING
    for (let i = 0; i < 10; i++) lines.push('MISSING||||||');
    const result = parseBatchEnrichOutput(lines.join('\n'), true);
    expect(Object.keys(result.results)).toHaveLength(30);
  });

  it('handles trailing newline without phantom result', () => {
    const log = generateLine(ALL_RIDS[0], 'BID', 'Type', 'Name') + '\n';
    const result = parseBatchEnrichOutput(log, true);
    expect(Object.keys(result.results)).toHaveLength(1);
  });

  it('handles Windows line endings', () => {
    const log = [
      generateLine(ALL_RIDS[0], 'BID-1', 'Type', 'Name 1'),
      generateLine(ALL_RIDS[1], 'BID-2', 'Type', 'Name 2'),
    ].join('\r\n');
    const result = parseBatchEnrichOutput(log, true);
    // \r\n split by \n leaves \r on RID of second line after trim — but trim() in parser handles it
    expect(Object.keys(result.results)).toHaveLength(2);
  });

  it('handles empty fields gracefully', () => {
    // 3 delimiters = 4 parts: RID, empty bid, empty type, empty name
    const log = `${ALL_RIDS[0]}|||||||||`;
    const result = parseBatchEnrichOutput(log, true);
    expect(Object.keys(result.results)).toHaveLength(1);
    expect(result.results[ALL_RIDS[0]].businessId).toBeUndefined();
    expect(result.results[ALL_RIDS[0]].type).toBeUndefined();
    expect(result.results[ALL_RIDS[0]].name).toBeUndefined();
  });

  it('skips "Result : 0" and "Duration" lines from output()+0 pattern', () => {
    const log = [
      generateLine(ALL_RIDS[0], 'BID-1', 'Type', 'Name 1'),
      generateLine(ALL_RIDS[1], 'BID-2', 'Type', 'Name 2'),
      'Result : 0',
      'Duration : 12ms',
    ].join('\n');
    const result = parseBatchEnrichOutput(log, true);
    // "Result : 0" and "Duration : 12ms" have < 4 parts when split by |||
    expect(Object.keys(result.results)).toHaveLength(2);
    expect(result.results[ALL_RIDS[0]]).toBeDefined();
    expect(result.results[ALL_RIDS[1]]).toBeDefined();
  });

  it('skips warning lines mixed into batch output', () => {
    const log = [
      generateLine(ALL_RIDS[0], 'BID-1', 'Scorecard', 'SC 1'),
      'WARNING: Property xyz not found on object',
      generateLine(ALL_RIDS[1], 'BID-2', 'Organisation', 'Org 1'),
    ].join('\n');
    const result = parseBatchEnrichOutput(log, true);
    // Warning line has no ||| delimiters → < 4 parts → skipped
    expect(Object.keys(result.results)).toHaveLength(2);
  });
});
