/**
 * Tests for the versioned, persistent per-environment workspace-colour cache.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockChromeStorage } from './chrome-mock';
import type { ColorSetData } from '../types';

const SETS: ColorSetData[] = [
  { id: 's1', name: 'Theme', colors: [{ bid: 'c1', name: 'Red', rgb: 'rgb(255,0,0)' }] },
];

describe('color-set-cache', () => {
  beforeEach(() => {
    vi.resetModules();
    mockChromeStorage();
  });

  it('misses for an unknown environment, hits after a set, and isolates environments', async () => {
    const c = await import('../color-set-cache');
    expect(await c.getColorSets('p1', 101)).toBeNull();
    await c.setColorSets('p1', SETS, 100);
    expect(await c.getColorSets('p1', 101)).toEqual({ sets: SETS, fetchedAt: 100, stale: false });
    expect(await c.getColorSets('p2', 101)).toBeNull();
  });

  it('persists to storage.local across an MV3 service-worker module reset', async () => {
    const a = await import('../color-set-cache');
    await a.setColorSets('p1', SETS, 100);

    vi.resetModules();
    const b = await import('../color-set-cache');
    expect(await b.getColorSets('p1', 101)).toEqual({ sets: SETS, fetchedAt: 100, stale: false });
  });

  it('marks entries stale only after the TTL boundary', async () => {
    const c = await import('../color-set-cache');
    await c.setColorSets('p1', SETS, 100);
    expect((await c.getColorSets('p1', 100 + c.COLOR_SET_TTL_MS))?.stale).toBe(false);
    expect((await c.getColorSets('p1', 101 + c.COLOR_SET_TTL_MS))?.stale).toBe(true);
  });

  it('invalidates a persisted environment and prevents it returning after reload', async () => {
    const c = await import('../color-set-cache');
    await c.setColorSets('p1', SETS, 100);
    c.invalidateColorSets('p1');
    await vi.waitFor(async () => expect(await c.getColorSets('p1', 101)).toBeNull());

    vi.resetModules();
    const reloaded = await import('../color-set-cache');
    expect(await reloaded.getColorSets('p1', 101)).toBeNull();
  });

  it('coalesces concurrent misses into one fetch and returns a fresh cache hit afterwards', async () => {
    const c = await import('../color-set-cache');
    let release!: (sets: ColorSetData[]) => void;
    const fetcher = vi.fn(() => new Promise<ColorSetData[]>(resolve => { release = resolve; }));
    const first = c.loadColorSets('p1', fetcher, false, Date.now());
    const second = c.loadColorSets('p1', fetcher, false, Date.now());
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    release(SETS);

    const [one, two] = await Promise.all([first, second]);
    expect(one).toMatchObject({ sets: SETS, stale: false, source: 'network' });
    expect(two).toEqual(one);
    await expect(c.loadColorSets('p1', fetcher)).resolves.toMatchObject({
      sets: SETS,
      stale: false,
      source: 'cache',
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('caches a successful empty workspace but not a failed first load', async () => {
    const c = await import('../color-set-cache');
    const empty = vi.fn(async () => [] as ColorSetData[]);
    await expect(c.loadColorSets('empty', empty)).resolves.toMatchObject({ sets: [], source: 'network' });
    await expect(c.loadColorSets('empty', empty)).resolves.toMatchObject({ sets: [], source: 'cache' });
    expect(empty).toHaveBeenCalledTimes(1);

    const failed = vi.fn(async () => { throw new Error('timeout'); });
    await expect(c.loadColorSets('failed', failed)).rejects.toThrow('timeout');
    await expect(c.loadColorSets('failed', failed)).rejects.toThrow('timeout');
    expect(failed).toHaveBeenCalledTimes(2);
  });

  it('returns an expired last-known-good entry as explicitly stale when refresh fails', async () => {
    const c = await import('../color-set-cache');
    await c.setColorSets('p1', SETS, 100);
    const failed = vi.fn(async () => { throw new Error('BMP timed out'); });

    await expect(c.loadColorSets('p1', failed, false, 101 + c.COLOR_SET_TTL_MS)).resolves.toEqual({
      sets: SETS,
      fetchedAt: 100,
      stale: true,
      source: 'stale-fallback',
      error: 'BMP timed out',
    });
  });

  it('does not let an in-flight response repopulate an invalidated environment', async () => {
    const c = await import('../color-set-cache');
    let release!: (sets: ColorSetData[]) => void;
    const fetcher = vi.fn(() => new Promise<ColorSetData[]>(resolve => { release = resolve; }));
    const request = c.loadColorSets('p1', fetcher);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    c.invalidateColorSets('p1');
    release(SETS);

    await expect(request).rejects.toThrow('invalidated');
    expect(await c.getColorSets('p1')).toBeNull();
  });
});
