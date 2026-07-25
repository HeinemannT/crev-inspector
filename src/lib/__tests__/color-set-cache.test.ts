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

  it('joins concurrent cache misses into one fetch and caches the result', async () => {
    const c = await import('../color-set-cache');
    let release!: (sets: ColorSetData[]) => void;
    const fetcher = vi.fn(() => new Promise<ColorSetData[]>(resolve => { release = resolve; }));
    const first = c.loadColorSets('p1', fetcher);
    const second = c.loadColorSets('p1', fetcher);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    release(SETS);
    await expect(Promise.all([first, second])).resolves.toEqual([SETS, SETS]);
    await expect(c.loadColorSets('p1', fetcher)).resolves.toEqual(SETS);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('caches a successful empty workspace but not a failed fetch', async () => {
    const c = await import('../color-set-cache');
    const empty = vi.fn(async () => [] as ColorSetData[]);
    await expect(c.loadColorSets('empty', empty)).resolves.toEqual([]);
    await expect(c.loadColorSets('empty', empty)).resolves.toEqual([]);
    expect(empty).toHaveBeenCalledTimes(1);

    const failed = vi.fn(async () => { throw new Error('timeout'); });
    await expect(c.loadColorSets('failed', failed)).rejects.toThrow('timeout');
    await expect(c.loadColorSets('failed', failed)).rejects.toThrow('timeout');
    expect(failed).toHaveBeenCalledTimes(2);
  });
});
