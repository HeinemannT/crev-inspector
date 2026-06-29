import { describe, it, expect } from 'vitest';
import { parseRgbTriple, rgbKey, contrastInk, enumMember } from '../color-util';

describe('parseRgbTriple', () => {
  it('parses rgb() and tolerates spacing', () => {
    expect(parseRgbTriple('rgb(255,0,128)')).toEqual([255, 0, 128]);
    expect(parseRgbTriple('rgb(255, 0, 128)')).toEqual([255, 0, 128]);
  });
  it('returns null when there are fewer than three integers', () => {
    expect(parseRgbTriple('')).toBeNull();
    expect(parseRgbTriple('none')).toBeNull();
    expect(parseRgbTriple('rgb(1,2)')).toBeNull();
  });
});

describe('rgbKey', () => {
  it('normalises spacing so equivalent colours share a key', () => {
    expect(rgbKey('rgb(255, 0,0)')).toBe('255,0,0');
    expect(rgbKey('rgb(255,0,0)')).toBe(rgbKey('rgb(255, 0, 0)'));
  });
  it('is empty for an unparseable value', () => {
    expect(rgbKey('transparent')).toBe('');
  });
});

describe('contrastInk', () => {
  it('uses dark ink on light backgrounds, white on dark', () => {
    expect(contrastInk('rgb(255,255,255)')).toBe('#1a1a1a');
    expect(contrastInk('rgb(0,0,0)')).toBe('#fff');
    expect(contrastInk('rgb(57,96,142)')).toBe('#fff'); // dark blue → white ink
  });
  it('defaults to white when unparseable', () => {
    expect(contrastInk('')).toBe('#fff');
  });
});

describe('enumMember', () => {
  it('strips the BMP enum-class prefix and uppercases the member', () => {
    expect(enumMember('HeaderStyle.inside')).toBe('INSIDE');
    expect(enumMember('BorderStyle.LINE')).toBe('LINE');
  });
  it('passes a bare value through (uppercased, trimmed)', () => {
    expect(enumMember(' none ')).toBe('NONE');
    expect(enumMember('INSIDE')).toBe('INSIDE');
  });
});
