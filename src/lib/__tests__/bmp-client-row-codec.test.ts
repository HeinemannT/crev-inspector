/**
 * Characterization goldens for bmp-client.ts's row (de)serialization —
 * plan 014 (ec-row-codec consolidation). Each test locks the EXACT EC string
 * (or, where the codec provably regroups an equivalent literal concatenation,
 * the exact resulting parse behavior) these builders had before migrating to
 * ec-row-codec, so a regression in the codec swap fails loudly here.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  buildAccessSubjectsEc, parseAccessSubjectsLog,
  parseResolveTemplateLog,
  buildLayoutTreeEc,
} from '../bmp-client';
import { LAYOUT_SEP } from '../layout-wire';
import { EcQueryService } from '../ec-query-service';
import type { EcResult } from '../bmp-client';

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
  it('emits the lean structural row into a 32-node chunk', () => {
    const ec = buildLayoutTreeEc('lookup(123)');
    expect(ec).toContain(
      `_line := "${LAYOUT_SEP}" + _n.rid + "|" + _n.id.whenMissing("") + "|" + _type + "|" + _p.rid.whenMissing("") + "|" + "" + "|" + _n.columnsLargeScreen.whenMissing("") + "|" + _n.columnsMediumScreen.whenMissing("") + "|" + _n.columnsSmallScreen.whenMissing("") + "|" + "" + "|" + (IF _n.name.whenMissing("") = "*<<<CREV_*" THEN "[reserved CREV marker]" ELSE _n.name.whenMissing("") ENDIF) + "\\n"`,
    );
    expect(ec).toContain('IF _i > 31 THEN');
    expect(ec).not.toContain('_n.container');
    expect(ec).not.toContain('_n.chartHeight');
  });

  it('emits the root row with the same resulting field values as the pre-codec "|||"/"||" literal-compaction form (regrouped, not renumbered)', () => {
    const ec = buildLayoutTreeEc('lookup(123)');
    expect(ec).toContain(
      `_r := _r + "${LAYOUT_SEP}" + _root.rid + "|" + _root.id.whenMissing("") + "|" + _root.className.whenMissing("") + "|" + "" + "|" + "" + "|" + _root.columnsLargeScreen.whenMissing("") + "|" + _root.columnsMediumScreen.whenMissing("") + "|" + _root.columnsSmallScreen.whenMissing("") + "|" + "" + "|" + (IF _root.name.whenMissing("") = "*<<<CREV_*" THEN "[reserved CREV marker]" ELSE _root.name.whenMissing("") ENDIF) + "\\n"`,
    );
  });

  it('inlines the ref and enforces the structural source cap', () => {
    const ec = buildLayoutTreeEc('lookup(123)');
    expect(ec.split('\n')[0]).toBe('_root := lookup(123)');
    expect(ec.trim().split('\n').pop()).toBe('_r');
    expect(ec).toContain('IF _emitted < 600 THEN');
    expect(ec).toContain('<<<CREV_LAYOUT_TREE_LIMIT>>>600');
    expect(ec).toContain('IF _type = "Tab"');
    expect(ec).toContain('IF _type = "Container"');
  });
});

describe('EcQueryService.fetchLayoutTree (bounded portal structure)', () => {
  // rid|bid|type|parentRid|containerRid|L|M|S|chartHeight|name — the wire row parseLayoutNodes reads.
  const row = (rid: string, type: string, parentRid: string, name: string) =>
    `${LAYOUT_SEP}${rid}|${rid.toLowerCase()}|${type}|${parentRid}|||||| ${name}`;
  const log = [
    row('t1', 'Tab', 'r0', 'Cases'),
    row('c1', 'Container', 't1', 'Main'),
  ].join('\n');

  it('parses structural rows and reports the source-limit marker', async () => {
    const svc = new EcQueryService(
      async () => ({ ok: true, log: `${log}\n<<<CREV_LAYOUT_TREE_LIMIT>>>600` }) as unknown as EcResult,
      async (rid: string) => `lookup(${rid})`,
      [],
    );
    const result = await svc.fetchLayoutTree('123');
    expect(result.nodes.map(n => n.type)).toEqual(['Tab', 'Container']);
    expect(result.truncated).toBe(true);
  });

  it('uses a bounded timeout and throws instead of turning failure into an empty tree', async () => {
    const executeEc = vi.fn(async () => ({ ok: false, error: 'timed out' }) as unknown as EcResult);
    const svc = new EcQueryService(executeEc, async rid => `lookup(${rid})`, []);

    await expect(svc.fetchLayoutTree('123')).rejects.toThrow('timed out');
    expect(executeEc).toHaveBeenCalledWith(
      expect.any(String),
      undefined,
      false,
      undefined,
      10_000,
    );
  });
});
