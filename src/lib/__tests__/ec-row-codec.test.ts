import { describe, it, expect } from 'vitest';
import { field, buildRowEc, parseDelimitedRow, parseDelimitedLines, identityRow } from '../ec-row-codec';

describe('buildRowEc', () => {
  it('joins field expressions with the delimiter as an EC concatenation', () => {
    const ec = buildRowEc([field('rid', '_o.rid'), field('name', '_o.name')], '|');
    expect(ec).toBe('_o.rid + "|" + _o.name');
  });

  it('supports a triple-pipe delimiter', () => {
    const ec = buildRowEc([field('a', '_x'), field('b', '_y'), field('c', '_z')], '|||');
    expect(ec).toBe('_x + "|||" + _y + "|||" + _z');
  });

  it('single field emits no delimiter', () => {
    expect(buildRowEc([field('a', '_x')], '|')).toBe('_x');
  });
});

describe('parseDelimitedRow', () => {
  it('round-trips a simple row', () => {
    const row = parseDelimitedRow('123|bid1|Name|Type', ['rid', 'id', 'name', 'className'], '|');
    expect(row).toEqual({ rid: '123', id: 'bid1', name: 'Name', className: 'Type' });
  });

  it('trims whitespace on every field', () => {
    const row = parseDelimitedRow(' 123 | bid1 | Name | Type ', ['rid', 'id', 'name', 'className'], '|');
    expect(row).toEqual({ rid: '123', id: 'bid1', name: 'Name', className: 'Type' });
  });

  it('handles empty fields', () => {
    const row = parseDelimitedRow('123|||Type', ['rid', 'id', 'name', 'className'], '|');
    expect(row).toEqual({ rid: '123', id: '', name: '', className: 'Type' });
  });

  it('returns null when the row has fewer columns than expected', () => {
    expect(parseDelimitedRow('123|bid1', ['rid', 'id', 'name', 'className'], '|')).toBeNull();
  });

  it('a delimiter inside a value corrupts the row WITHOUT trailingFreeText (documents why the option exists)', () => {
    // "A|B" as a name shifts every column after it — this is the exact failure
    // mode the plan calls out. trailingFreeText (below) is the fix.
    const row = parseDelimitedRow('123|bid1|A|B|Type', ['rid', 'id', 'name', 'className'], '|');
    expect(row).toEqual({ rid: '123', id: 'bid1', name: 'A', className: 'B' }); // "Type" silently dropped
  });

  it('trailingFreeText absorbs a delimiter inside the LAST field instead of shifting columns', () => {
    const row = parseDelimitedRow('123|bid1|Type|Revenue | 2024', ['rid', 'id', 'className', 'name'], '|', { trailingFreeText: true });
    expect(row).toEqual({ rid: '123', id: 'bid1', className: 'Type', name: 'Revenue | 2024' });
  });

  it('trailingFreeText on a triple-pipe delimiter', () => {
    const row = parseDelimitedRow('n1|||c1|||the code has ||| inside it', ['name', 'className', 'code'], '|||', { trailingFreeText: true });
    expect(row).toEqual({ name: 'n1', className: 'c1', code: 'the code has ||| inside it' });
  });
});

describe('parseDelimitedLines', () => {
  it('parses every matching line and skips noise', () => {
    const log = [
      'Result : 0',
      '1|a|Name1|Type1',
      '',
      '2|b|Name2|Type2',
      'Duration: 12ms',
    ].join('\n');
    const rows = parseDelimitedLines(log, ['rid', 'id', 'name', 'className'], '|');
    expect(rows).toEqual([
      { rid: '1', id: 'a', name: 'Name1', className: 'Type1' },
      { rid: '2', id: 'b', name: 'Name2', className: 'Type2' },
    ]);
  });

  it('returns an empty array for a log with no delimiter at all', () => {
    expect(parseDelimitedLines('Result : 0\nDuration: 5ms', ['rid'], '|||')).toEqual([]);
  });

  it('skips a short line that happens to contain the delimiter', () => {
    const rows = parseDelimitedLines('only|two', ['a', 'b', 'c'], '|');
    expect(rows).toEqual([]);
  });
});

describe('identityRow', () => {
  it('defaults to rid|id|name|className, each whenMissing("")', () => {
    const fields = identityRow('_o');
    expect(buildRowEc(fields, '|')).toBe(
      '_o.rid.whenMissing("") + "|" + _o.id.whenMissing("") + "|" + _o.name.whenMissing("") + "|" + _o.className.whenMissing("")',
    );
  });

  it('honors a custom ridDefault sentinel', () => {
    const fields = identityRow('_o', { ridDefault: '"MISSING"' });
    expect(buildRowEc(fields, '|||')).toBe(
      '_o.rid.whenMissing("MISSING") + "|||" + _o.id.whenMissing("") + "|||" + _o.name.whenMissing("") + "|||" + _o.className.whenMissing("")',
    );
  });

  it('appends a trailing key field when key:true', () => {
    const fields = identityRow('_c', { key: true });
    expect(buildRowEc(fields, '|')).toBe(
      '_c.rid.whenMissing("") + "|" + _c.id.whenMissing("") + "|" + _c.name.whenMissing("") + "|" + _c.className.whenMissing("") + "|" + _c.key.whenMissing("")',
    );
  });

  it('honors a custom field order/subset', () => {
    const fields = identityRow('_t', { order: ['rid', 'name', 'className', 'id'] });
    expect(buildRowEc(fields, '|||')).toBe(
      '_t.rid.whenMissing("") + "|||" + _t.name.whenMissing("") + "|||" + _t.className.whenMissing("") + "|||" + _t.id.whenMissing("")',
    );
  });
});
