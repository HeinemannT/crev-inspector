/**
 * Characterization goldens for bmp-client.ts's row (de)serialization —
 * plan 014 (ec-row-codec consolidation). Each test locks the EXACT EC string
 * (or, where the codec provably regroups an equivalent literal concatenation,
 * the exact resulting parse behavior) these builders had before migrating to
 * ec-row-codec, so a regression in the codec swap fails loudly here.
 */
import { describe, it, expect } from 'vitest';
import {
  buildAccessSubjectsEc, parseAccessSubjectsLog,
  parseResolveTemplateLog,
  buildLayoutTreeEc,
} from '../bmp-client';
import { LAYOUT_SEP } from '../layout-wire';

describe('buildAccessSubjectsEc (golden)', () => {
  it('emits the exact user+role EC as before the codec migration', () => {
    expect(buildAccessSubjectsEc()).toBe([
      '_out := ""',
      'root.user.children().forEach(_u:',
      '     _out := _out + "user" + "|||" + _u.rid + "|||" + _u.id.whenMissing("") + "|||" + _u.name.whenMissing("") + "\\n"',
      ')',
      'root.role.children().forEach(_r:',
      '     _out := _out + "role" + "|||" + _r.rid + "|||" + _r.id.whenMissing("") + "|||" + _r.name.whenMissing("") + "\\n"',
      ')',
      '_out',
    ].join('\n'));
  });
});

describe('parseAccessSubjectsLog (golden)', () => {
  it('parses users and roles, sorted by name', () => {
    const log = [
      'user|||111|||u1|||Zed User',
      'role|||222|||r1|||Admins',
      'user|||333|||u2|||Ann User',
    ].join('\n');
    expect(parseAccessSubjectsLog(log)).toEqual([
      { rid: '222', name: 'Admins', kind: 'role', businessId: 'r1' },
      { rid: '333', name: 'Ann User', kind: 'user', businessId: 'u2' },
      { rid: '111', name: 'Zed User', kind: 'user', businessId: 'u1' },
    ]);
  });

  it('falls back to businessId then rid when name is empty', () => {
    expect(parseAccessSubjectsLog('user|||111|||u1|||')).toEqual([
      { rid: '111', name: 'u1', kind: 'user', businessId: 'u1' },
    ]);
    expect(parseAccessSubjectsLog('user|||111||||||')).toEqual([
      { rid: '111', name: '111', kind: 'user', businessId: undefined },
    ]);
  });

  it('skips a MISSING-rid row and non user/role kinds', () => {
    expect(parseAccessSubjectsLog('user|||MISSING|||u1|||Name')).toEqual([]);
    expect(parseAccessSubjectsLog('other|||111|||u1|||Name')).toEqual([]);
  });
});

describe('parseResolveTemplateLog (golden)', () => {
  it('parses a resolved template row (rid|name|className|id order)', () => {
    const log = 'Result : 0\n8765432109876543210|||Enterprise Template|||EnterpriseTemplate|||et_1\nDuration: 4ms';
    expect(parseResolveTemplateLog(log)).toEqual({
      templateRid: '8765432109876543210',
      templateName: 'Enterprise Template',
      templateType: 'EnterpriseTemplate',
      templateBusinessId: 'et_1',
    });
  });

  it('returns templateRid: null when the row starts with MISSING', () => {
    expect(parseResolveTemplateLog('MISSING||||||')).toEqual({ templateRid: null });
  });

  it('returns templateRid: null when the log has no ||| line', () => {
    expect(parseResolveTemplateLog('Result : 0\nDuration: 2ms')).toEqual({ templateRid: null });
  });

  it('treats empty name/className/id as undefined', () => {
    expect(parseResolveTemplateLog(['123', '', '', ''].join('|||'))).toEqual({
      templateRid: '123', templateName: undefined, templateType: undefined, templateBusinessId: undefined,
    });
  });

  it('tolerates a SHORT row (fewer than 4 fields) — trailing fields are optional, not a parse failure', () => {
    // Regression: enrichment-integration.test.ts sends 3-field rows
    // (rid|||name|||className, no trailing id) and expects them to parse.
    expect(parseResolveTemplateLog('123|||Risk Assessment Template|||TemplateCategory')).toEqual({
      templateRid: '123', templateName: 'Risk Assessment Template', templateType: 'TemplateCategory', templateBusinessId: undefined,
    });
  });
});

describe('buildLayoutTreeEc (golden)', () => {
  it('emits the per-node row exactly as before the codec migration', () => {
    const ec = buildLayoutTreeEc('lookup(123)');
    expect(ec).toContain(
      `_r := _r + "${LAYOUT_SEP}" + _n.rid + "|" + _n.id.whenMissing("") + "|" + _n.className.whenMissing("") + "|" + _p.rid.whenMissing("") + "|" + _c.rid.whenMissing("") + "|" + _n.columnsLargeScreen.whenMissing("") + "|" + _n.columnsMediumScreen.whenMissing("") + "|" + _n.columnsSmallScreen.whenMissing("") + "|" + _n.chartHeight.whenMissing("") + "|" + _n.name.whenMissing("") + "\\n"`,
    );
  });

  it('emits the root row with the same resulting field values as the pre-codec "|||"/"||" literal-compaction form (regrouped, not renumbered)', () => {
    const ec = buildLayoutTreeEc('lookup(123)');
    expect(ec).toContain(
      `_r := _r + "${LAYOUT_SEP}" + _root.rid + "|" + _root.id.whenMissing("") + "|" + _root.className.whenMissing("") + "|" + "" + "|" + "" + "|" + _root.columnsLargeScreen.whenMissing("") + "|" + _root.columnsMediumScreen.whenMissing("") + "|" + _root.columnsSmallScreen.whenMissing("") + "|" + "" + "|" + _root.name.whenMissing("") + "\\n"`,
    );
  });

  it('inlines the ref and preamble/footer verbatim', () => {
    const ec = buildLayoutTreeEc('lookup(123)');
    expect(ec.split('\n')[0]).toBe('_root := lookup(123)');
    expect(ec.trim().split('\n').pop()).toBe('_r');
  });
});
