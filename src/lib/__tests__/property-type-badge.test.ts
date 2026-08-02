/**
 * @vitest-environment happy-dom
 *
 * Property configs are BMP objects and therefore use the shared typeBadge()
 * primitive. This suite locks the one intentional presentation variant:
 * split capsule + value-kind color + ClockCountdown for Historical*.
 */
import { describe, expect, it } from 'vitest';
import {
  ICON_PROP_HISTORY,
  ICON_PROP_REFERENCE,
  ICON_PROP_REVERSE_REFERENCE,
  ICON_PROP_RICH_TEXT,
} from '../icons';
import { typeBadge, typeIcon } from '../type-badge';
import { getTypeAbbr, getTypeColor } from '../types';

const PROPERTY_TYPES: [string, string, string, boolean][] = [
  ['SystemMethodConfig', 'SYS', '#707983', false],
  ['TextMethodConfig', 'TXT', '#4f86a8', false],
  ['RichTextMethodConfig', 'RTX', '#596f9a', false],
  ['BooleanMethodConfig', 'BLN', '#4f8e89', false],
  ['NumberMethodConfig', 'NUM', '#2f92a5', false],
  ['DateMethodConfig', 'DAT', '#587fb0', false],
  ['UrlMethodConfig', 'URL', '#65728f', false],
  ['ListMethodConfig', 'LST', '#3f8e98', false],
  ['TagMethodConfig', 'TAG', '#8a6d8d', false],
  ['ReferenceMethodConfig', 'REF', '#a56f43', false],
  ['ReverseReferenceMethodConfig', 'RRF', '#3a8c9b', false],
  ['ExtendedMethodConfig', 'EXT', '#795d92', false],
  ['FileMethodConfig', 'FIL', '#6f934b', false],
  ['TokenMethodConfig', 'TOK', '#9a8245', false],
  ['FunctionMethodConfig', 'FUN', '#766b98', false],
  ['NodeTypeFunctionMethodConfig', 'NTF', '#5d8174', false],
  ['HistoricalTextMethodConfig', 'TXT', '#4f86a8', true],
  ['HistoricalRichTextMethodConfig', 'RTX', '#596f9a', true],
  ['HistoricalBooleanMethodConfig', 'BLN', '#4f8e89', true],
  ['HistoricalNumberMethodConfig', 'NUM', '#2f92a5', true],
  ['HistoricalDateMethodConfig', 'DAT', '#587fb0', true],
  ['HistoricalListMethodConfig', 'LST', '#3f8e98', true],
  ['HistoricalReferenceMethodConfig', 'REF', '#a56f43', true],
  ['HistoricalProgressMethodConfig', 'PRG', '#338f9e', true],
  ['HistoricalStatusMethodConfig', 'STS', '#a65e58', true],
];

describe('property object type badges', () => {
  it.each(PROPERTY_TYPES)('%s → %s / %s', (type, code, color, historical) => {
    expect(getTypeAbbr(type)).toBe(code);
    expect(getTypeColor(type)).toBe(color);

    const badge = typeBadge(type);
    expect(badge.classList.contains('bdg-property')).toBe(true);
    expect(badge.classList.contains('bdg-historical')).toBe(historical);
    expect(badge.querySelector('.lbl')?.textContent).toBe(code);
    expect(badge.querySelector('.bdg-history') !== null).toBe(historical);
  });

  it('uses the approved filled glyphs for rich text and reference direction', () => {
    expect(typeIcon('RichTextMethodConfig')).toBe(ICON_PROP_RICH_TEXT);
    expect(typeIcon('ReferenceMethodConfig')).toBe(ICON_PROP_REFERENCE);
    expect(typeIcon('HistoricalReferenceMethodConfig')).toBe(ICON_PROP_REFERENCE);
    expect(typeIcon('ReverseReferenceMethodConfig')).toBe(ICON_PROP_REVERSE_REFERENCE);
  });

  it('puts the filled ClockCountdown only on historical property badges', () => {
    const historical = typeBadge('HistoricalNumberMethodConfig');
    const normal = typeBadge('NumberMethodConfig');
    expect(ICON_PROP_HISTORY).toContain('M208,96');
    expect(historical.querySelector('.bdg-history svg path')?.getAttribute('d')).toContain('M208,96');
    expect(normal.querySelector('.bdg-history')).toBeNull();
  });

  it('does not change the normal object badge contract', () => {
    const badge = typeBadge('Container');
    expect(badge.classList.contains('bdg-property')).toBe(false);
    expect(badge.classList.contains('bdg-historical')).toBe(false);
    expect(badge.querySelector('.bdg-history')).toBeNull();
  });
});
