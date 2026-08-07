import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InspectorMessage } from '../../types';
import { mockChromeStorage } from '../../__tests__/chrome-mock';

describe('Browse search identity hydration', () => {
  let getHandler: (type: string) => any;
  let cache: import('../../object-cache').ObjectCache;
  let client: {
    serverUrl: string;
    quickSearch: ReturnType<typeof vi.fn>;
    batchEnrich: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    mockChromeStorage();
    const { ObjectCache } = await import('../../object-cache');
    cache = new ObjectCache('browse-template');
    client = {
      serverUrl: 'https://bmp.example.test/Workspace/',
      quickSearch: vi.fn(async () => ({
        totalHits: 1,
        objects: [{
          rid: '1',
          name: 'Requirement',
          type: 'CeRequirement',
          source: 'server',
          discoveredAt: 1,
          updatedAt: 1,
        }],
      })),
      batchEnrich: vi.fn(async () => ({
        results: {
          '1': {
            businessId: 'requirement_instance',
            templateBusinessId: 'requirement_template',
            name: 'Requirement',
            type: 'CeRequirement',
          },
        },
      })),
    };
    const { setSwContext } = await import('../../sw-context');
    setSwContext({
      client,
      cache,
      settings: { activeProfileId: 'profile-a' },
      settingsReady: Promise.resolve(),
    } as any);
    await import('../objects');
    ({ getHandler } = await import('../../handler-registry'));
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('paints live hits first, then updates the same generation with template identity', async () => {
    const responses: InspectorMessage[] = [];
    await getHandler('BROWSE_SEARCH')(
      { type: 'BROWSE_SEARCH', query: 'requirement', gen: 4, pageSize: 40 },
      (response: InspectorMessage) => responses.push(response),
      { panelWindowId: 7, isOneShot: false },
    );

    expect(responses).toHaveLength(2);
    expect(responses[0]).toMatchObject({
      type: 'BROWSE_SEARCH_RESULT',
      gen: 4,
      objects: [{ rid: '1' }],
    });
    if (responses[0].type === 'BROWSE_SEARCH_RESULT') {
      expect(responses[0].objects?.[0]).not.toHaveProperty('businessId');
      expect(responses[0].objects?.[0]).not.toHaveProperty('templateBusinessId');
    }
    expect(responses[1]).toMatchObject({
      type: 'BROWSE_SEARCH_RESULT',
      gen: 4,
      objects: [{
        rid: '1',
        businessId: 'requirement_instance',
        templateBusinessId: 'requirement_template',
        identityEnriched: true,
      }],
    });
    expect(client.quickSearch).toHaveBeenCalledWith(
      'requirement',
      expect.objectContaining({ pageSize: 40, signal: expect.any(AbortSignal) }),
    );
    expect(client.batchEnrich).toHaveBeenCalledWith(['1'], expect.any(AbortSignal));
    expect(cache.get('1')).toMatchObject({
      businessId: 'requirement_instance',
      templateBusinessId: 'requirement_template',
      identityEnriched: true,
    });
  });

  it('reuses a completed cached identity without another BMP command', async () => {
    cache.put({
      rid: '1',
      businessId: 'requirement_instance',
      templateBusinessId: 'requirement_template',
      identityEnriched: true,
      source: 'server',
      discoveredAt: 1,
      updatedAt: Date.now(),
    });
    const responses: InspectorMessage[] = [];

    await getHandler('BROWSE_SEARCH')(
      { type: 'BROWSE_SEARCH', query: 'requirement', gen: 5 },
      (response: InspectorMessage) => responses.push(response),
      { panelWindowId: 7, isOneShot: false },
    );

    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({
      objects: [{
        businessId: 'requirement_instance',
        templateBusinessId: 'requirement_template',
      }],
    });
    expect(client.batchEnrich).not.toHaveBeenCalled();
  });

  it('keeps valid quick-search hits when optional identity hydration fails', async () => {
    client.batchEnrich = vi.fn(async () => {
      throw new Error('EC unavailable');
    });
    const responses: InspectorMessage[] = [];

    await getHandler('BROWSE_SEARCH')(
      { type: 'BROWSE_SEARCH', query: 'requirement', gen: 6 },
      (response: InspectorMessage) => responses.push(response),
      { panelWindowId: 7, isOneShot: false },
    );

    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({
      type: 'BROWSE_SEARCH_RESULT',
      ok: true,
      objects: [{ rid: '1', name: 'Requirement' }],
    });
  });

  it('aborts identity hydration when the same panel clears its query', async () => {
    let hydrationSignal: AbortSignal | undefined;
    client.batchEnrich = vi.fn((_rids: string[], signal: AbortSignal) => {
      hydrationSignal = signal;
      return new Promise(resolve => {
        signal.addEventListener('abort', () => resolve({ results: {}, error: 'cancelled' }), { once: true });
      });
    });
    const firstResponses: InspectorMessage[] = [];
    const first = Promise.resolve(getHandler('BROWSE_SEARCH')(
      { type: 'BROWSE_SEARCH', query: 'requirement', gen: 6 },
      (response: InspectorMessage) => firstResponses.push(response),
      { panelWindowId: 7, isOneShot: false },
    ));
    await Promise.resolve();
    await Promise.resolve();

    const clearResponses: InspectorMessage[] = [];
    await getHandler('BROWSE_SEARCH')(
      { type: 'BROWSE_SEARCH', query: '', gen: 7 },
      (response: InspectorMessage) => clearResponses.push(response),
      { panelWindowId: 7, isOneShot: false },
    );
    await first;

    expect(hydrationSignal?.aborted).toBe(true);
    expect(firstResponses).toHaveLength(1);
    expect(clearResponses).toEqual([{
      type: 'BROWSE_SEARCH_RESULT',
      query: '',
      gen: 7,
      ok: true,
      objects: [],
      totalHits: 0,
    }]);
  });
});
