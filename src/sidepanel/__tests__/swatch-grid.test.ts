/**
 * @vitest-environment happy-dom
 *
 * Swatch-grid model + the shared draft→changes coercion.
 *
 * resolveSwatchGroups turns fetched colour sets into folders of swatches,
 * resolves the always-present Basics group to real CorpoColor objects by RGB
 * (so they can be linked, not just shown), and applies the name/bid filter.
 * buildChangesPayload coerces a string draft into the typed APPLY payload.
 */
import { describe, it, expect } from 'vitest';
import { resolveSwatchGroups, renderSwatchGrid, BASIC_COLORS } from '../swatch-grid';
import { buildChangesPayload } from '../pane-edit';
import type { ColorSetData } from '../../lib/types';

const sets: ColorSetData[] = [
  { id: 'set1', name: 'Brand', colors: [
    { bid: 'C_BLUE', name: 'Brand Blue', rgb: 'rgb(0,90,200)' },
    { bid: 'C_WHITE', name: 'Paper', rgb: 'rgb(255, 255, 255)' }, // spaced — must still match White
  ] },
  { id: 'set2', name: 'Status', colors: [
    { bid: 'C_RED', name: 'Alert Red', rgb: 'rgb(220,40,40)' },
  ] },
];

describe('resolveSwatchGroups', () => {
  it('maps each colour set to a folder of swatches', () => {
    const groups = resolveSwatchGroups(sets);
    expect(groups.map(g => g.label)).toEqual(['Brand', 'Status']);
    expect(groups[0].swatches.map(s => s.bid)).toEqual(['C_BLUE', 'C_WHITE']);
    expect(groups[0].swatches.every(s => s.applyable)).toBe(true);
  });

  it('prepends a Basics group, resolving entries to real CorpoColors by RGB', () => {
    const groups = resolveSwatchGroups(sets, { includeBasics: true });
    expect(groups[0].label).toBe('Basics');
    const white = groups[0].swatches.find(s => s.name === 'White');
    // White matches C_WHITE despite the spaced "rgb(255, 255, 255)".
    expect(white).toMatchObject({ bid: 'C_WHITE', applyable: true });
  });

  it('marks a Basics colour with no workspace match as display-only', () => {
    const groups = resolveSwatchGroups(sets, { includeBasics: true });
    const black = groups[0].swatches.find(s => s.name === 'Black');
    // No black CorpoColor in the sets → shown but not applyable.
    expect(black).toMatchObject({ bid: '', applyable: false });
  });

  it('filters by name or bid (case-insensitive) and drops empty groups', () => {
    const groups = resolveSwatchGroups(sets, { q: 'red' });
    expect(groups.map(g => g.label)).toEqual(['Status']);
    expect(groups[0].swatches).toHaveLength(1);

    const byBid = resolveSwatchGroups(sets, { q: 'c_blue' });
    expect(byBid.map(g => g.label)).toEqual(['Brand']);
  });

  it('exposes a non-empty Basics palette', () => {
    expect(BASIC_COLORS.length).toBeGreaterThan(0);
    expect(BASIC_COLORS.map(b => b.name)).toContain('White');
  });
});

describe('renderSwatchGrid folders', () => {
  const base = { sets, currentBid: null, includeBasics: true, onToggle: () => {}, onPick: () => {} };

  it('renders a folder per group and only opens expanded ones', () => {
    const el = renderSwatchGrid({ ...base, expanded: new Set(['Brand']) });
    const folders = el.querySelectorAll('.sw-folder');
    expect(folders.length).toBe(3); // Basics + Brand + Status
    const openHeads = el.querySelectorAll('.sw-folder-head.open');
    expect(openHeads.length).toBe(1); // only Brand
    // collapsed folders show no swatch cells, the open one does
    expect(el.querySelectorAll('.sw-cells').length).toBe(1);
  });

  it('force-opens every matching folder while searching', () => {
    const el = renderSwatchGrid({ ...base, q: 'r', expanded: new Set() });
    // every shown folder is open despite nothing being in `expanded`
    const folders = el.querySelectorAll('.sw-folder');
    const cellGroups = el.querySelectorAll('.sw-cells');
    expect(cellGroups.length).toBe(folders.length);
    expect(folders.length).toBeGreaterThan(0);
  });

  it('shows a loading state when sets are null', () => {
    const el = renderSwatchGrid({ ...base, sets: null, expanded: new Set() });
    expect(el.querySelector('.sw-loading')).toBeTruthy();
  });
});

describe('buildChangesPayload', () => {
  it('coerces number/slider props to numbers (non-finite → 0)', () => {
    expect(buildChangesPayload({ transparency: '40' })).toEqual({ transparency: 40 });
    expect(buildChangesPayload({ transparency: 'oops' })).toEqual({ transparency: 0 });
  });

  it('coerces boolean props to real booleans', () => {
    expect(buildChangesPayload({ shadow: 'true' })).toEqual({ shadow: true });
    expect(buildChangesPayload({ shadow: 'false' })).toEqual({ shadow: false });
  });

  it('leaves enums and colour links as strings', () => {
    expect(buildChangesPayload({ headerStyle: 'NONE', headerColor: 'C_BLUE Brand Blue' }))
      .toEqual({ headerStyle: 'NONE', headerColor: 'C_BLUE Brand Blue' });
  });
});
