/**
 * Tests for template businessId in enrichment and resolve paths.
 *
 * Covers:
 * - batchEnrich parser with 5-field output (rid|||bid|||type|||name|||templateBid)
 * - Backward compat: 4-field output (no template businessId) still works
 * - resolveTemplate parser with 4-field output (rid|||name|||type|||bid)
 * - Edge cases: empty template bid, MISSING linkedTo, unicode, extra pipes
 */
import { describe, it, expect } from 'vitest';
import { ALL_RIDS, TEMPLATE_RIDS, ORG_RIDS } from './test-rids';

// ── batchEnrich parser (mirrors bmp-client.ts batchEnrich output parsing) ──

function parseBatchEnrichOutput(log: string | undefined | null, ok: boolean, error?: string) {
  if (!ok) return { results: {} as Record<string, any>, error: error ?? 'EC execution failed' };
  if (log == null) return { results: {} as Record<string, any>, error: 'EC returned null output' };
  if (log.trim() === '') return { results: {} as Record<string, any> };

  const out: Record<string, { businessId?: string; type?: string; name?: string; templateBusinessId?: string }> = {};
  for (const line of log.trim().split('\n')) {
    if (!line.includes('|||')) continue;
    const parts = line.split('|||').map(p => p.trim());
    if (parts.length < 4) continue;
    const rid = parts[0];
    if (!rid || rid === 'MISSING' || rid === 'SKIP') continue;

    const bid = parts[1] || undefined;
    const typ = parts[2] || undefined;
    // 5th field (index 4) is template businessId — may be absent on older format
    const tbid = parts.length >= 5 ? (parts[4] || undefined) : undefined;
    // Name is everything between type and templateBid (index 3, possibly more if name has |||)
    const nameEndIndex = parts.length >= 5 ? parts.length - 1 : parts.length;
    const name = parts.slice(3, nameEndIndex).join('|||').trim() || undefined;

    out[rid] = { businessId: bid, type: typ, name, templateBusinessId: tbid };
  }
  return { results: out };
}

function generateLine5(rid: string, bid: string, type: string, name: string, tbid: string): string {
  return `${rid}|||${bid}|||${type}|||${name}|||${tbid}`;
}

function generateLine4(rid: string, bid: string, type: string, name: string): string {
  return `${rid}|||${bid}|||${type}|||${name}`;
}

// ── resolveTemplate parser (mirrors bmp-client.ts resolveTemplate with 4-field output) ──

interface TemplateResolution {
  templateRid: string | null;
  templateName?: string;
  templateType?: string;
  templateBusinessId?: string;
}

function parseResolveTemplate(log: string | undefined | null, ok: boolean): TemplateResolution {
  if (!ok || !log) return { templateRid: null };

  const lines = log.trim().split('\n');
  const match = lines.find(l => l.includes('|||'))?.trim();
  if (!match || match.startsWith('MISSING')) return { templateRid: null };

  const parts = match.split('|||');
  const tRid = parts[0]?.trim();
  const tName = parts[1]?.trim();
  const tType = parts[2]?.trim();
  const tBid = parts[3]?.trim();
  if (!tRid || tRid === 'MISSING') return { templateRid: null };
  return {
    templateRid: tRid,
    templateName: tName || undefined,
    templateType: tType || undefined,
    templateBusinessId: tBid || undefined,
  };
}

// ── Tests: batchEnrich with template businessId ──

describe('batchEnrich parser: 5-field format (with template businessId)', () => {
  it('parses a single line with all 5 fields', () => {
    const log = generateLine5('12345', 't.122', 'ExtendedTable', 'Revenue Table', 't.100');
    const result = parseBatchEnrichOutput(log, true);
    expect(result.error).toBeUndefined();
    expect(result.results['12345']).toEqual({
      businessId: 't.122',
      type: 'ExtendedTable',
      name: 'Revenue Table',
      templateBusinessId: 't.100',
    });
  });

  it('parses multiple lines at scale (50 RIDs)', () => {
    const rids = ALL_RIDS.slice(0, 50);
    const log = rids.map((rid, i) =>
      generateLine5(rid, `BID-${i}`, 'Scorecard', `Object ${i}`, `TBID-${i}`),
    ).join('\n');
    const result = parseBatchEnrichOutput(log, true);
    expect(result.error).toBeUndefined();
    expect(Object.keys(result.results)).toHaveLength(50);
    for (let i = 0; i < rids.length; i++) {
      expect(result.results[rids[i]].templateBusinessId).toBe(`TBID-${i}`);
    }
  });

  it('handles empty template businessId (template objects have no linkedTo)', () => {
    const log = generateLine5(TEMPLATE_RIDS[0], 't.100', 'Scorecard', 'Template SC', '');
    const result = parseBatchEnrichOutput(log, true);
    expect(result.results[TEMPLATE_RIDS[0]].templateBusinessId).toBeUndefined();
    expect(result.results[TEMPLATE_RIDS[0]].businessId).toBe('t.100');
  });

  it('handles mixed: some with template, some without', () => {
    const log = [
      generateLine5(ORG_RIDS[0], 's.101', 'Scorecard', 'Instance SC', 's.100'),
      generateLine5(ORG_RIDS[1], 's.100', 'Scorecard', 'Template SC', ''),
      generateLine5(ORG_RIDS[2], 't.55', 'ExtendedTable', 'Table', 't.50'),
    ].join('\n');
    const result = parseBatchEnrichOutput(log, true);
    expect(result.results[ORG_RIDS[0]].templateBusinessId).toBe('s.100');
    expect(result.results[ORG_RIDS[1]].templateBusinessId).toBeUndefined();
    expect(result.results[ORG_RIDS[2]].templateBusinessId).toBe('t.50');
  });

  it('preserves unicode in template businessId', () => {
    const log = generateLine5(ORG_RIDS[0], 'bid-ü', 'Type', 'Name', 'tbid-ö');
    const result = parseBatchEnrichOutput(log, true);
    expect(result.results[ORG_RIDS[0]].templateBusinessId).toBe('tbid-ö');
  });
});

describe('batchEnrich parser: backward compat (4-field format)', () => {
  it('parses 4-field output without template businessId', () => {
    const log = generateLine4('12345', 't.122', 'ExtendedTable', 'Revenue Table');
    const result = parseBatchEnrichOutput(log, true);
    expect(result.results['12345']).toEqual({
      businessId: 't.122',
      type: 'ExtendedTable',
      name: 'Revenue Table',
      templateBusinessId: undefined,
    });
  });

  it('parses mixed 4-field and 5-field lines (cache migration scenario)', () => {
    const log = [
      generateLine4(ORG_RIDS[0], 'old-bid', 'Scorecard', 'Old Format'),
      generateLine5(ORG_RIDS[1], 'new-bid', 'Scorecard', 'New Format', 'tmpl-bid'),
    ].join('\n');
    const result = parseBatchEnrichOutput(log, true);
    expect(result.results[ORG_RIDS[0]].templateBusinessId).toBeUndefined();
    expect(result.results[ORG_RIDS[1]].templateBusinessId).toBe('tmpl-bid');
  });

  it('handles SKIP and MISSING lines in 5-field format', () => {
    const log = [
      'SKIP|||||||||||',
      'MISSING|||||||||||',
      generateLine5(ORG_RIDS[0], 'bid', 'Type', 'Name', 'tbid'),
    ].join('\n');
    const result = parseBatchEnrichOutput(log, true);
    expect(Object.keys(result.results)).toHaveLength(1);
    expect(result.results[ORG_RIDS[0]].templateBusinessId).toBe('tbid');
  });

  it('handles empty output', () => {
    const result = parseBatchEnrichOutput('', true);
    expect(result.error).toBeUndefined();
    expect(result.results).toEqual({});
  });

  it('handles null output', () => {
    const result = parseBatchEnrichOutput(null, true);
    expect(result.error).toBe('EC returned null output');
  });

  it('handles EC failure', () => {
    const result = parseBatchEnrichOutput('output', false, 'timeout');
    expect(result.error).toBe('timeout');
  });
});

// ── Tests: resolveTemplate with businessId ──

describe('resolveTemplate parser: 4-field format (with businessId)', () => {
  it('parses template with all 4 fields', () => {
    const result = parseResolveTemplate(
      '1234567890|||My Template|||Scorecard|||t.100',
      true,
    );
    expect(result.templateRid).toBe('1234567890');
    expect(result.templateName).toBe('My Template');
    expect(result.templateType).toBe('Scorecard');
    expect(result.templateBusinessId).toBe('t.100');
  });

  it('handles template with empty businessId', () => {
    const result = parseResolveTemplate(
      '1234567890|||My Template|||Scorecard|||',
      true,
    );
    expect(result.templateRid).toBe('1234567890');
    expect(result.templateBusinessId).toBeUndefined();
  });

  it('handles template with only 3 fields (old format)', () => {
    const result = parseResolveTemplate(
      '1234567890|||My Template|||Scorecard',
      true,
    );
    expect(result.templateRid).toBe('1234567890');
    expect(result.templateName).toBe('My Template');
    expect(result.templateType).toBe('Scorecard');
    expect(result.templateBusinessId).toBeUndefined();
  });

  it('returns null for MISSING (unlinked)', () => {
    const result = parseResolveTemplate('MISSING||||||||', true);
    expect(result.templateRid).toBeNull();
  });

  it('returns null on EC failure', () => {
    const result = parseResolveTemplate(null, false);
    expect(result.templateRid).toBeNull();
  });

  it('skips non-pipe lines (Duration, Result prefix)', () => {
    const log = 'Result : 0\n9876543210|||Template A|||ExtendedTable|||t.50\nDuration : 12ms';
    const result = parseResolveTemplate(log, true);
    expect(result.templateRid).toBe('9876543210');
    expect(result.templateBusinessId).toBe('t.50');
  });

  it('handles spaces around fields', () => {
    const result = parseResolveTemplate(
      '  9876543210  |||  Template B  |||  Scorecard  |||  t.200  ',
      true,
    );
    expect(result.templateRid).toBe('9876543210');
    expect(result.templateName).toBe('Template B');
    expect(result.templateType).toBe('Scorecard');
    expect(result.templateBusinessId).toBe('t.200');
  });
});
