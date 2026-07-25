/**
 * Characterization goldens for code-search.ts's row (de)serialization —
 * plan 014 (ec-row-codec consolidation). Locks the EXACT EC + parse
 * behavior these builders had before migrating to ec-row-codec, so a
 * regression in the codec swap fails loudly here.
 */
import { describe, it, expect } from 'vitest';
import {
  buildScopeResolveEc,
  parseScopeResolveLog,
  buildIdentityChunkRowLines,
  buildRidScanEc,
  parseRidScanLog,
  summarizeIssues,
} from '../code-search';
import { EcQueryService } from '../ec-query-service';
import type { EcResult } from '../bmp-client';

describe('buildScopeResolveEc (golden)', () => {
  it('emits the identity row exactly as before the codec migration', () => {
    const ec = buildScopeResolveEc('t.118');
    expect(ec).toBe(
      '_o := t.118\n' +
      '_o.rid.whenMissing("MISSING") + "|||" + _o.id.whenMissing("") + "|||" + _o.name.whenMissing("") + "|||" + _o.className.whenMissing("")',
    );
  });

  it('inlines an arbitrary ref verbatim', () => {
    expect(buildScopeResolveEc('ceiss.bar')).toContain('_o := ceiss.bar');
  });
});

describe('parseScopeResolveLog (golden)', () => {
  it('parses a resolved identity row', () => {
    expect(parseScopeResolveLog('8765432109876543210|||118|||Risk Register|||Scorecard')).toEqual({
      rid: '8765432109876543210', businessId: '118', name: 'Risk Register', type: 'Scorecard',
    });
  });

  it('returns null for an unresolved (MISSING rid) row', () => {
    expect(parseScopeResolveLog(['MISSING', '', '', ''].join('|||'))).toBeNull();
  });

  it('returns null when the log carries no ||| line', () => {
    expect(parseScopeResolveLog('Result : 0\nDuration: 3ms')).toBeNull();
  });

  it('finds the identity line among BMP result/duration noise', () => {
    const log = 'Result : 0\n8765432109876543210|||118|||Risk Register|||Scorecard\nDuration: 3ms';
    expect(parseScopeResolveLog(log)?.rid).toBe('8765432109876543210');
  });

  it('tolerates empty id/name/className fields', () => {
    expect(parseScopeResolveLog(['123', '', '', ''].join('|||'))).toEqual({ rid: '123', businessId: '', name: '', type: '' });
  });
});

describe('buildIdentityChunkRowLines (golden)', () => {
  it('emits the same four lines (rid literal + bid/name reads + row append) as before the codec migration', () => {
    const lines = buildIdentityChunkRowLines('8765432109876543210', 'lookup(8765432109876543210)');
    expect(lines).toEqual([
      '_o := lookup(8765432109876543210)',
      '_bid := _o.id.whenMissing("")',
      '_name := _o.name.whenMissing("")',
      // Re-grouped literal concatenation ("rid" as its own quoted segment
      // instead of fused into the leading literal) — provably the same
      // runtime string/EC-output bytes as the pre-codec
      // `_r := _r + "<rid>|||" + _bid + "|||" + _name + "\\n"`.
      '_r := _r + "8765432109876543210" + "|||" + _bid + "|||" + _name + "\\n"',
    ]);
  });
});

describe('bounded RID scans', () => {
  it('builds a chunked, capped scan with explicit completion metadata', () => {
    const ec = buildRidScanEc('ExtendedExpression', null, 'needle');
    expect(ec).toContain('_list := SELECT ExtendedExpression FROM root');
    expect(ec).toContain('_total := _list.size()');
    expect(ec).toContain('_q := "needle"');
    expect(ec).toContain('IF _emitted < 500 THEN');
    expect(ec).toContain('IF _chunkCount >= 32 THEN');
    expect(ec).toContain('<<<CREV_CODE_SEARCH>>>STATS|');
    expect(ec).toContain('<<<CREV_CODE_SEARCH>>>DONE');
  });

  it('builds enumeration mode without a server-side string predicate', () => {
    const ec = buildRidScanEc('ExtendedExpression', 't.scope');
    expect(ec).toContain('SELECT ExtendedExpression FROM t.scope');
    expect(ec).not.toContain('_q :=');
    expect(ec).toContain('_hit := TRUE');
  });

  it('parses a complete empty scan as a real zero-result', () => {
    expect(parseRidScanLog([
      '<<<CREV_CODE_SEARCH>>>START',
      '<<<CREV_CODE_SEARCH>>>STATS|132|0|0',
      '<<<CREV_CODE_SEARCH>>>DONE',
    ].join('\n'))).toEqual({ rids: [], total: 132, truncated: false });
  });

  it('makes a capped scan explicit', () => {
    expect(parseRidScanLog([
      '<<<CREV_CODE_SEARCH>>>START',
      '101',
      '102',
      '<<<CREV_CODE_SEARCH>>>STATS|900|700|2',
      '<<<CREV_CODE_SEARCH>>>DONE',
    ].join('\n'))).toEqual({ rids: ['101', '102'], total: 900, truncated: true });
  });

  it('rejects overflow/truncation that lost the completion marker', () => {
    expect(() => parseRidScanLog('101\n102')).toThrow(/completion marker/i);
  });

  it('rejects a row-count mismatch instead of accepting partial data', () => {
    expect(() => parseRidScanLog([
      '101',
      '<<<CREV_CODE_SEARCH>>>STATS|10|2|2',
      '<<<CREV_CODE_SEARCH>>>DONE',
    ].join('\n'))).toThrow(/expected 2 row/i);
  });
});

describe('strict code-body batches', () => {
  function service(result: EcResult): EcQueryService {
    return new EcQueryService(async () => result, async rid => `lookup(${rid})`, []);
  }

  it('rejects a failed EC result', async () => {
    await expect(service({ ok: false, error: 'offline' }).batchFetchCode(['101'], ['expression']))
      .rejects.toThrow('offline');
  });

  it('rejects warning-bearing and incomplete output', async () => {
    await expect(service({ ok: true, log: 'partial', hasWarning: true }).batchFetchCode(['101'], ['expression']))
      .rejects.toThrow(/warnings/i);
    await expect(service({ ok: true, log: 'partial' }).batchFetchCode(['101'], ['expression']))
      .rejects.toThrow(/completion marker/i);
  });

  it('accepts a complete empty-code object', async () => {
    const sep = '<<<CREV_SEP>>>';
    const log = `${sep}OBJ${sep}101\n${sep}expression${sep}\n${sep}DONE`;
    const rows = await service({ ok: true, log }).batchFetchCode(['101'], ['expression']);
    expect(rows.get('101')).toEqual({});
  });
});

describe('search issue summaries', () => {
  it('collapses a workspace-wide connection failure', () => {
    expect(summarizeIssues([
      'ExtendedTable: Authorization failed',
      'PieChart: Authorization failed',
      'Label: Authorization failed',
    ], 3)).toBe('All 3 types: Authorization failed');
  });

  it('keeps distinct failures and abbreviates long type lists', () => {
    expect(summarizeIssues([
      'A: incomplete',
      'B: incomplete',
      'C: incomplete',
      'D: incomplete',
      'E: warning',
    ], 6)).toBe('4 types (A, B, C, …): incomplete; E: warning');
  });
});
