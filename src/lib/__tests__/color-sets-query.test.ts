import { describe, expect, it, vi } from 'vitest';
import type { EcResult } from '../bmp-client';
import {
  buildColorSetsEc,
  EcQueryService,
  parseColorSetsLog,
} from '../ec-query-service';

const SEP = '<<<CREV_COL>>>';
const row = (
  setId: string,
  setName: string,
  folder: string,
  bid: string,
  name: string,
  rgb: string,
): string => `${SEP}R${SEP}${setId}${SEP}${setName}${SEP}${folder}${SEP}${bid}${SEP}${name}${SEP}java.awt.Color[r=${rgb}]`;

describe('workspace colour query', () => {
  it('selects colours directly and chunks output instead of walking every set child', () => {
    const ec = buildColorSetsEc();
    expect(ec).toContain('SELECT CorpoColor FROM root.portal');
    expect(ec).not.toContain('SELECT CorpoColorSet');
    expect(ec).not.toContain('_set.children()');
    expect(ec).toContain('IF _i > 31 THEN');
  });

  it('groups flat rows into sets, preserves swatch order, and leads with custom sets', () => {
    const sets = parseColorSetsLog([
      row('stock', 'Theme 1', 'ColorRoot', 'blue', 'Blue', '1,g=2,b=3'),
      row('custom', 'Brand', 'customer_palette', 'red', 'Red', '4,g=5,b=6'),
      row('custom', 'Brand', 'customer_palette', 'green', 'Green', '7,g=8,b=9'),
    ].join('\n'));

    expect(sets.map(set => set.id)).toEqual(['custom', 'stock']);
    expect(sets[0].colors).toEqual([
      { bid: 'red', name: 'Red', rgb: 'rgb(4,5,6)' },
      { bid: 'green', name: 'Green', rgb: 'rgb(7,8,9)' },
    ]);
  });

  it('uses the bounded timeout and surfaces EC failures instead of returning grey-only emptiness', async () => {
    const executeEc = vi.fn(async () => ({
      ok: false,
      error: 'timed out',
    }) as EcResult);
    const service = new EcQueryService(executeEc, async rid => `lookup(${rid})`, []);

    await expect(service.fetchColorSets()).rejects.toThrow('timed out');
    expect(executeEc).toHaveBeenCalledWith(
      expect.any(String),
      undefined,
      false,
      undefined,
      10_000,
    );
  });

  it('accepts a genuinely empty successful workspace', async () => {
    const service = new EcQueryService(
      async () => ({ ok: true, log: '' }) as EcResult,
      async rid => `lookup(${rid})`,
      [],
    );
    await expect(service.fetchColorSets()).resolves.toEqual([]);
  });
});
