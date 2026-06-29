import { describe, it, expect } from 'vitest';
import { ColorSetIndex } from '../color-index';
import type { ColorSetData } from '../types';

const sets: ColorSetData[] = [
  { id: 's1', name: 'Brand', colors: [{ bid: 'C_BLUE', name: 'Blue', rgb: 'rgb(0,0,255)' }] },
  { id: 's2', name: 'Status', colors: [{ bid: 'C_RED', name: 'Red', rgb: 'rgb(255,0,0)' }] },
];

describe('ColorSetIndex', () => {
  it('resolves a bid to {name, rgb} and to rgb', () => {
    const ix = new ColorSetIndex(sets);
    expect(ix.lookup('C_BLUE')).toEqual({ name: 'Blue', rgb: 'rgb(0,0,255)' });
    expect(ix.rgb('C_RED')).toBe('rgb(255,0,0)');
  });
  it('returns null for unknown / empty bids', () => {
    const ix = new ColorSetIndex(sets);
    expect(ix.lookup('nope')).toBeNull();
    expect(ix.lookup('')).toBeNull();
    expect(ix.rgb(undefined)).toBeNull();
  });
  it('load() replaces prior contents; clear() empties it', () => {
    const ix = new ColorSetIndex(sets);
    ix.load([{ id: 's3', name: 'New', colors: [{ bid: 'C_GREEN', name: 'Green', rgb: 'rgb(0,128,0)' }] }]);
    expect(ix.rgb('C_BLUE')).toBeNull();      // old colour gone
    expect(ix.rgb('C_GREEN')).toBe('rgb(0,128,0)');
    ix.clear();
    expect(ix.rgb('C_GREEN')).toBeNull();
  });
});
