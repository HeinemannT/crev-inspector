/**
 * Characterization goldens for code-search.ts's row (de)serialization —
 * plan 014 (ec-row-codec consolidation). Locks the EXACT EC + parse
 * behavior these builders had before migrating to ec-row-codec, so a
 * regression in the codec swap fails loudly here.
 */
import { describe, it, expect } from 'vitest';
import { buildScopeResolveEc, parseScopeResolveLog, buildIdentityChunkRowLines } from '../code-search';

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
