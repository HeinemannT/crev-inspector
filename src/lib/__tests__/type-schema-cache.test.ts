import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockChromeStorage } from './chrome-mock';
import type { TypeSchemaProp } from '../types';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('persistent type-schema cache lifecycle', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    mockChromeStorage();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it('expires positive and negative root-category knowledge after seven days', async () => {
    const cache = await import('../type-schema-cache');
    cache.setRoot('server-a', 'ceRisks', 'CeRisk');
    cache.setRoot('server-a', 'missingThings', null);

    expect(cache.getRoot('server-a', 'ceRisks')).toBe('CeRisk');
    expect(cache.getRoot('server-a', 'missingThings')).toBeNull();

    vi.setSystemTime(new Date(Date.now() + 8 * DAY_MS));

    expect(cache.getRoot('server-a', 'ceRisks')).toBeUndefined();
    expect(cache.getRoot('server-a', 'missingThings')).toBeUndefined();
  });

  it('clears schema and root-category memory plus both persisted stores', async () => {
    const cache = await import('../type-schema-cache');
    const props: TypeSchemaProp[] = [{
      accessor: 'name',
      label: 'Name',
      configClass: 'TextPropertyConfig',
      systemobject: true,
    }];
    cache.set('server-a', 'CeRisk', props, 'CeRisk');
    cache.setRoot('server-a', 'ceRisks', 'CeRisk');

    await cache.clear();

    expect(cache.get('server-a', 'CeRisk')).toBeNull();
    expect(cache.getRoot('server-a', 'ceRisks')).toBeUndefined();
    expect(chrome.storage.local.remove).toHaveBeenCalledWith([
      'crev_schema_cache_v2',
      'crev_root_category_cache_v1',
    ]);
  });
});
