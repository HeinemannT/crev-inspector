import { describe, it, expect } from 'vitest';
import { styleAssignRhs, INVALID_COLOR_BID } from '../style-ec';

// A stand-in for BmpClient.formatEcLiteral.
const fmt = (v: string | number | boolean): string =>
  typeof v === 'string' ? `"${v}"` : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : String(v);

describe('styleAssignRhs', () => {
  it('emits a colour LINK reference for a bid', () => {
    expect(styleAssignRhs('headerColor', 'df1', fmt)).toBe('t.df1');
    expect(styleAssignRhs('fontColor', 'C_INK Dark', fmt)).toBe('t.C_INK'); // takes the bid token
  });

  it('CLEARS a colour link with "" when the value is empty (the bug fix)', () => {
    expect(styleAssignRhs('headerColor', '', fmt)).toBe('""');
    expect(styleAssignRhs('fontColor', '', fmt)).toBe('""');
  });

  it('rejects a malformed colour bid', () => {
    expect(styleAssignRhs('headerColor', 'bad id!', fmt)).toBe('t.bad'); // first token is "bad" — valid
    expect(styleAssignRhs('headerColor', 'has space', fmt)).toBe('t.has');
    expect(styleAssignRhs('headerColor', '$$$', fmt)).toBe(INVALID_COLOR_BID);
  });

  it('formats scalar props via the supplied formatter', () => {
    expect(styleAssignRhs('transparency', 40, fmt)).toBe('40');
    expect(styleAssignRhs('shadow', true, fmt)).toBe('TRUE');
    expect(styleAssignRhs('headerStyle', 'INSIDE', fmt)).toBe('"INSIDE"');
  });
});
