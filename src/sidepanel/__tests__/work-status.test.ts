import { describe, expect, it } from 'vitest';
import type { ActivityEntry, InspectorMessage } from '../../lib/types';
import { compactActivityStatus, workStatusForMessage } from '../work-status';

describe('side-panel work status', () => {
  it('covers meaningful user waits without reporting background state sync', () => {
    expect(workStatusForMessage({ type: 'FETCH_OBJECT_PANE', rid: '9007199254740993' }))
      .toMatchObject({ text: 'Loading object…', working: true });
    expect(workStatusForMessage({ type: 'FETCH_CONNECTIONS', rid: '42', className: 'Widget' }))
      .toMatchObject({ text: 'Loading relations…', working: true });
    expect(workStatusForMessage({ type: 'GET_SETTINGS' })).toBeNull();
  });

  it('reports progress and concise outcomes', () => {
    expect(workStatusForMessage({
      type: 'CODE_SEARCH_PROGRESS',
      results: [],
      searched: 18,
      total: 40,
    })).toMatchObject({ text: 'Searching code 18/40', working: true });

    expect(workStatusForMessage({
      type: 'BROWSE_SEARCH_RESULT',
      query: 'risk',
      gen: 1,
      ok: true,
      totalHits: 7,
    })).toMatchObject({ text: '7 found', working: false });
  });

  it('shortens enrichment chatter but retains the full hover title', () => {
    const entry = {
      id: 1,
      time: 1,
      level: 'success',
      message: 'Enriched 4 objects from the server cache',
    } satisfies ActivityEntry;

    expect(compactActivityStatus(entry)).toEqual({
      text: '4 objects enriched',
      title: entry.message,
      working: false,
    });
  });

  it('keeps Java-long rids opaque while describing object requests', () => {
    const message = {
      type: 'SERVER_LOOKUP',
      rid: '9223372036854775807',
    } satisfies InspectorMessage;
    expect(workStatusForMessage(message)?.text).toBe('Loading object…');
  });
});
