/**
 * Tests for ObjectCache's TTL eviction. Phase-4 added a 1h TTL so
 * server-side renames (Config Studio) eventually propagate. The
 * surrounding LRU + persistence behaviour is covered elsewhere; here
 * we just lock down the timestamp arithmetic.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ObjectCache } from '../object-cache';

describe('ObjectCache TTL', () => {
  // chrome.storage.local mock — get always returns empty; set is a no-op.
  beforeEach(() => {
    (globalThis as any).chrome = {
      storage: {
        local: {
          get: vi.fn(async () => ({})),
          set: vi.fn(async () => undefined),
          remove: vi.fn(async () => undefined),
        },
      },
    };
  });

  it('returns cached object when within TTL', async () => {
    const cache = new ObjectCache('test');
    const now = Date.now();
    cache.put({
      rid: '1', businessId: 'foo', name: 'Foo', type: 'Scorecard',
      source: 'server', discoveredAt: now, updatedAt: now,
    });
    expect(cache.get('1')?.name).toBe('Foo');
  });

  it('evicts and returns undefined when entry is older than the TTL', () => {
    const cache = new ObjectCache('test');
    const longAgo = Date.now() - 2 * 60 * 60 * 1000; // 2 hours ago
    cache.put({
      rid: '1', businessId: 'foo', name: 'StaleName', type: 'Scorecard',
      source: 'server', discoveredAt: longAgo, updatedAt: longAgo,
    });
    expect(cache.get('1')).toBeUndefined();
    // The stale entry should also have been evicted from the cache,
    // so subsequent gets stay empty without us having to re-check
    // the timestamp every time.
    expect(cache.size).toBe(0);
  });

  it('treats updatedAt (not discoveredAt) as the TTL anchor', () => {
    const cache = new ObjectCache('test');
    const now = Date.now();
    cache.put({
      rid: '1', businessId: 'foo', name: 'Refreshed', type: 'Scorecard',
      source: 'server',
      discoveredAt: now - 5 * 60 * 60 * 1000, // discovered 5h ago
      updatedAt: now, // but just refreshed
    });
    // Refreshed → still within TTL despite old discovery.
    expect(cache.get('1')?.name).toBe('Refreshed');
  });

  it('TTL miss does not break subsequent puts', () => {
    const cache = new ObjectCache('test');
    const longAgo = Date.now() - 2 * 60 * 60 * 1000;
    cache.put({
      rid: '1', businessId: 'foo', name: 'Old', type: 'Scorecard',
      source: 'server', discoveredAt: longAgo, updatedAt: longAgo,
    });
    cache.get('1'); // triggers eviction
    const now = Date.now();
    cache.put({
      rid: '1', businessId: 'foo', name: 'Fresh', type: 'Scorecard',
      source: 'server', discoveredAt: now, updatedAt: now,
    });
    expect(cache.get('1')?.name).toBe('Fresh');
  });
});
