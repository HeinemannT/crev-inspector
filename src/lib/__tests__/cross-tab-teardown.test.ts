/**
 * @vitest-environment happy-dom
 *
 * Tests for src/lib/cross-tab.ts teardownCrossTab() — added so a re-injected
 * content script's onSync subscriptions don't keep firing on the previous
 * instance's stale handlers.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { onSync, broadcast, teardownCrossTab } from '../cross-tab';

function fireStorage(key: string, data: unknown) {
  // The storage event only fires cross-tab in real browsers; dispatch it
  // manually to exercise the dispatch path.
  window.dispatchEvent(Object.assign(new Event('storage'), {
    key,
    newValue: JSON.stringify({ data, ts: 1 }),
  }));
}

describe('cross-tab teardownCrossTab()', () => {
  afterEach(() => { teardownCrossTab(); });

  it('dispatches to a registered handler before teardown', () => {
    const handler = vi.fn();
    onSync('crev_sync_inspect', handler);
    fireStorage('crev_sync_inspect', { active: true });
    expect(handler).toHaveBeenCalledWith({ active: true });
  });

  it('stops dispatching after teardown (listener detached + handlers cleared)', () => {
    const handler = vi.fn();
    onSync('crev_sync_inspect', handler);
    teardownCrossTab();
    fireStorage('crev_sync_inspect', { active: true });
    expect(handler).not.toHaveBeenCalled();
  });

  it('broadcast never throws when localStorage is present', () => {
    expect(() => broadcast('crev_sync_inspect', { active: false })).not.toThrow();
  });
});
