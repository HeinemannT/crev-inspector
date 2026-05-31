import { describe, it, expect, beforeEach } from 'vitest';
import { mockChromeStorage } from './chrome-mock';

// Mock chrome before importing modules
beforeEach(() => {
  mockChromeStorage();
});

describe('HistoryManager', () => {
  async function createManager(profileId = '_default') {
    const { HistoryManager } = await import('../history');
    const mgr = new HistoryManager(profileId);
    await mgr.load();
    return mgr;
  }

  it('records and returns entries in reverse chronological order', async () => {
    const mgr = await createManager();
    mgr.record({ rid: '1', action: 'viewed', timestamp: 100 });
    mgr.record({ rid: '2', action: 'edited', timestamp: 200 });

    const all = mgr.getAll();
    expect(all).toHaveLength(2);
    expect(all[0].rid).toBe('2');
    expect(all[1].rid).toBe('1');
  });

  it('deduplicates by RID (newest wins)', async () => {
    const mgr = await createManager();
    mgr.record({ rid: '1', name: 'OldName', action: 'viewed', timestamp: 100 });
    mgr.record({ rid: '2', action: 'viewed', timestamp: 200 });
    mgr.record({ rid: '1', name: 'NewName', action: 'edited', timestamp: 300 });

    const all = mgr.getAll();
    expect(all).toHaveLength(2);
    expect(all[0].rid).toBe('1');
    expect(all[0].name).toBe('NewName');
    expect(all[0].action).toBe('edited');
    expect(all[1].rid).toBe('2');
  });

  it('caps at HISTORY_MAX (30) entries', async () => {
    const mgr = await createManager();
    for (let i = 0; i < 40; i++) {
      mgr.record({ rid: String(i), action: 'viewed', timestamp: i });
    }
    expect(mgr.getAll()).toHaveLength(30);
    // Most recent should be first
    expect(mgr.getAll()[0].rid).toBe('39');
  });

  it('clears all entries', async () => {
    const mgr = await createManager();
    mgr.record({ rid: '1', action: 'viewed', timestamp: 100 });
    mgr.record({ rid: '2', action: 'viewed', timestamp: 200 });
    mgr.clear();
    expect(mgr.getAll()).toHaveLength(0);
  });

  it('persist/load round-trip via chrome.storage', async () => {
    const { HistoryManager } = await import('../history');
    const mgr1 = new HistoryManager('test_profile');
    await mgr1.load();
    mgr1.record({ rid: '42', name: 'TestObj', action: 'viewed', timestamp: 1000 });

    // Force persist by switching profile (which calls persist)
    await mgr1.switchProfile('other');

    // Load from same key
    const mgr2 = new HistoryManager('test_profile');
    await mgr2.load();
    const all = mgr2.getAll();
    expect(all).toHaveLength(1);
    expect(all[0].rid).toBe('42');
    expect(all[0].name).toBe('TestObj');
  });

  it('switches profiles correctly', async () => {
    const { HistoryManager } = await import('../history');
    const mgr = new HistoryManager('profile_a');
    await mgr.load();
    mgr.record({ rid: '1', action: 'viewed', timestamp: 100 });

    await mgr.switchProfile('profile_b');
    expect(mgr.getAll()).toHaveLength(0);

    mgr.record({ rid: '2', action: 'edited', timestamp: 200 });

    await mgr.switchProfile('profile_a');
    const all = mgr.getAll();
    expect(all).toHaveLength(1);
    expect(all[0].rid).toBe('1');
  });
});

describe('FavoritesManager', () => {
  async function createManager(profileId = '_default') {
    const { FavoritesManager } = await import('../favorites');
    const mgr = new FavoritesManager(profileId);
    await mgr.load();
    return mgr;
  }

  it('toggles favorite on and off', async () => {
    const mgr = await createManager();
    const on = mgr.toggle('1', { name: 'Test' });
    expect(on).toBe(true);
    expect(mgr.isFavorite('1')).toBe(true);
    expect(mgr.getAll()).toHaveLength(1);

    const off = mgr.toggle('1');
    expect(off).toBe(false);
    expect(mgr.isFavorite('1')).toBe(false);
    expect(mgr.getAll()).toHaveLength(0);
  });

  it('caps at FAVORITES_MAX (20) entries', async () => {
    const mgr = await createManager();
    for (let i = 0; i < 20; i++) {
      mgr.toggle(String(i));
    }
    expect(mgr.getAll()).toHaveLength(20);

    // 21st should be rejected
    const result = mgr.toggle('21');
    expect(result).toBe(false);
    expect(mgr.getAll()).toHaveLength(20);
  });

  it('remove() works', async () => {
    const mgr = await createManager();
    mgr.toggle('1');
    mgr.toggle('2');
    mgr.remove('1');
    expect(mgr.getAll()).toHaveLength(1);
    expect(mgr.isFavorite('1')).toBe(false);
  });

  it('persist/load round-trip', async () => {
    const { FavoritesManager } = await import('../favorites');
    const mgr1 = new FavoritesManager('fav_test');
    await mgr1.load();
    mgr1.toggle('99', { name: 'FavObj', type: 'Scorecard' });

    await mgr1.switchProfile('other');

    const mgr2 = new FavoritesManager('fav_test');
    await mgr2.load();
    expect(mgr2.getAll()).toHaveLength(1);
    expect(mgr2.getAll()[0].rid).toBe('99');
    expect(mgr2.getAll()[0].name).toBe('FavObj');
  });

  it('switches profiles correctly', async () => {
    const { FavoritesManager } = await import('../favorites');
    const mgr = new FavoritesManager('p1');
    await mgr.load();
    mgr.toggle('1');

    await mgr.switchProfile('p2');
    expect(mgr.getAll()).toHaveLength(0);
    expect(mgr.isFavorite('1')).toBe(false);

    mgr.toggle('2');
    await mgr.switchProfile('p1');
    expect(mgr.getAll()).toHaveLength(1);
    expect(mgr.isFavorite('1')).toBe(true);
    expect(mgr.isFavorite('2')).toBe(false);
  });
});
