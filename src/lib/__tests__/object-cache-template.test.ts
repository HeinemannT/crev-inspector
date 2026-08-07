import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mergeBmpObject } from '../merge';
import { ObjectCache } from '../object-cache';
import type { BmpObject } from '../types';
import { mockChromeStorage } from './chrome-mock';

function object(rid: string, fields: Partial<BmpObject> = {}): BmpObject {
  return {
    rid,
    source: 'server',
    discoveredAt: 1,
    updatedAt: Date.now(),
    ...fields,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  mockChromeStorage();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('template-aware object cache', () => {
  it('retains identity and Browse location metadata across partial merges', () => {
    const merged = mergeBmpObject(
      object('1', {
        name: 'Risk',
        webParentName: 'Requirements',
        pageRid: '10',
        pageName: 'Risk register',
        tabRid: '11',
      }),
      object('1', {
        businessId: 'risk_instance',
        templateBusinessId: 'risk_template',
        identityEnriched: true,
        cascade: { rid: '2', businessId: 'risk_input', type: 'InputSet' },
      }),
    );

    expect(merged).toMatchObject({
      businessId: 'risk_instance',
      templateBusinessId: 'risk_template',
      identityEnriched: true,
      webParentName: 'Requirements',
      pageRid: '10',
      pageName: 'Risk register',
      tabRid: '11',
      cascade: { rid: '2', businessId: 'risk_input', type: 'InputSet' },
    });
  });

  it('finds cached objects by template ID as well as instance ID', () => {
    const cache = new ObjectCache('template-search');
    cache.put(object('1', {
      businessId: 'risk_instance',
      templateBusinessId: 'risk_template',
      identityEnriched: true,
    }));

    expect(cache.search('risk_template').map(item => item.rid)).toEqual(['1']);
    expect(cache.search('risk_instance').map(item => item.rid)).toEqual(['1']);
  });
});
