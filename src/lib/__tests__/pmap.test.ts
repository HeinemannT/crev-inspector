import { describe, it, expect } from 'vitest';
import { pMap } from '../util';

function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

describe('pMap', () => {
  it('preserves result order with varying delays', async () => {
    const items = [50, 10, 40, 20, 30]; // delay in ms
    const results = await pMap(items, async (ms) => {
      await delay(ms);
      return ms;
    }, 5);
    expect(results).toEqual([50, 10, 40, 20, 30]);
  });

  it('respects concurrency limit', async () => {
    let running = 0;
    let maxRunning = 0;
    const items = [1, 2, 3, 4];

    await pMap(items, async (item) => {
      running++;
      if (running > maxRunning) maxRunning = running;
      await delay(20);
      running--;
      return item;
    }, 2);

    expect(maxRunning).toBe(2);
  });

  it('handles empty array', async () => {
    const results = await pMap([], async (x: number) => x * 2, 4);
    expect(results).toEqual([]);
  });

  it('handles concurrency greater than items', async () => {
    const results = await pMap([1, 2, 3], async (x) => x * 10, 10);
    expect(results).toEqual([10, 20, 30]);
  });

  it('propagates errors', async () => {
    await expect(
      pMap([1, 2, 3], async (x) => {
        if (x === 2) throw new Error('boom');
        return x;
      }, 2),
    ).rejects.toThrow('boom');
  });

  it('processes all items with concurrency=1 (sequential)', async () => {
    const order: number[] = [];
    await pMap([1, 2, 3, 4], async (x) => {
      order.push(x);
      await delay(5);
      return x;
    }, 1);
    expect(order).toEqual([1, 2, 3, 4]);
  });
});
