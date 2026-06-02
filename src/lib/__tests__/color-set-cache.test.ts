/**
 * Tests for color-set-cache.ts — the persistent per-profile colour cache that
 * makes the colour picker fast after the first open.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockChromeStorage } from './chrome-mock';
import type { ColorSetData } from '../types';

const SETS: ColorSetData[] = [
  { id: 's1', name: 'Theme', colors: [{ bid: 'c1', name: 'Red', rgb: '#ff0000' }] },
];

describe('color-set-cache', () => {
  beforeEach(() => {
    vi.resetModules();
    mockChromeStorage();
  });

  it('misses for an unknown profile, hits after a set, and isolates by serverId', async () => {
    const c = await import('../color-set-cache');
    expect(await c.getColorSets('p1')).toBeNull();
    await c.setColorSets('p1', SETS);
    expect(await c.getColorSets('p1')).toEqual(SETS);
    expect(await c.getColorSets('p2')).toBeNull(); // other profile untouched
  });

  it('persists to storage.session so a re-imported module (SW idle-reset) still hits', async () => {
    const a = await import('../color-set-cache');
    await a.setColorSets('p1', SETS);

    // Simulate the MV3 service-worker dropping module state while
    // chrome.storage.session survives — the cache must rehydrate.
    vi.resetModules();
    const b = await import('../color-set-cache');
    expect(await b.getColorSets('p1')).toEqual(SETS);
  });

  it('invalidate drops a profile so the next read forces a refetch', async () => {
    const c = await import('../color-set-cache');
    await c.setColorSets('p1', SETS);
    c.invalidateColorSets('p1');
    expect(await c.getColorSets('p1')).toBeNull();
  });
});
