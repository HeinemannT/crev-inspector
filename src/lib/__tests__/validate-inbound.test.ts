/**
 * parseInterceptorMessage — the shape guard at the `crev-interceptor`
 * CustomEvent boundary (plan 016). `document` is shared between the MAIN-
 * world interceptor and the page's own scripts, so a compromised/XSS'd BMP
 * page can dispatch a forged event on the same channel. This guard is an
 * ALLOWLIST: only the known message shapes survive; anything else — an
 * unknown `type`, a non-object `detail`, malformed fields — is dropped.
 */
import { describe, it, expect } from 'vitest';
import { parseInterceptorMessage, isRidShaped } from '../validate-inbound';

const RID = '8639152947620';
const RID2 = '1234567890123';

function bmpObject(rid: string) {
  return { rid, source: 'fiber' as const, discoveredAt: 1, updatedAt: 1 };
}

describe('isRidShaped', () => {
  it('accepts long digit strings (BMP 64-bit longs)', () => {
    expect(isRidShaped(RID)).toBe(true);
    expect(isRidShaped('-1234567')).toBe(true);
  });

  it('rejects short numbers, non-strings, and non-numeric strings', () => {
    expect(isRidShaped('12345')).toBe(false); // 5 digits — below the 6-digit floor
    expect(isRidShaped(12345678)).toBe(false); // number, not string
    expect(isRidShaped('abc')).toBe(false);
    expect(isRidShaped(undefined)).toBe(false);
  });
});

describe('parseInterceptorMessage — OBJECTS_DISCOVERED', () => {
  it('accepts a well-formed message', () => {
    const msg = parseInterceptorMessage({ type: 'OBJECTS_DISCOVERED', objects: [bmpObject(RID), bmpObject(RID2)] });
    expect(msg).toEqual({ type: 'OBJECTS_DISCOVERED', objects: [bmpObject(RID), bmpObject(RID2)] });
  });

  it('strips entries whose rid is not rid-shaped, keeping the real ones', () => {
    const forged = { rid: '1', name: 'forged' };
    const real = bmpObject(RID);
    const msg = parseInterceptorMessage({ type: 'OBJECTS_DISCOVERED', objects: [forged, real] });
    expect(msg).toEqual({ type: 'OBJECTS_DISCOVERED', objects: [real] });
  });

  it('drops non-object entries in the array', () => {
    const msg = parseInterceptorMessage({ type: 'OBJECTS_DISCOVERED', objects: [null, 'x', 42, bmpObject(RID)] });
    expect(msg).toEqual({ type: 'OBJECTS_DISCOVERED', objects: [bmpObject(RID)] });
  });

  it('returns null when objects is not an array', () => {
    expect(parseInterceptorMessage({ type: 'OBJECTS_DISCOVERED', objects: 'not-an-array' })).toBeNull();
    expect(parseInterceptorMessage({ type: 'OBJECTS_DISCOVERED' })).toBeNull();
  });
});

describe('parseInterceptorMessage — PAGE_CONTEXT', () => {
  it('accepts a well-formed message with both fields', () => {
    const msg = parseInterceptorMessage({ type: 'PAGE_CONTEXT', rid: RID, tabRid: RID2 });
    expect(msg).toEqual({ type: 'PAGE_CONTEXT', rid: RID, tabRid: RID2 });
  });

  it('accepts rid/tabRid absent (page with no bound object)', () => {
    expect(parseInterceptorMessage({ type: 'PAGE_CONTEXT' })).toEqual({ type: 'PAGE_CONTEXT', rid: undefined, tabRid: undefined });
  });

  it('returns null for a non-rid-shaped rid', () => {
    expect(parseInterceptorMessage({ type: 'PAGE_CONTEXT', rid: 'not-a-rid' })).toBeNull();
    expect(parseInterceptorMessage({ type: 'PAGE_CONTEXT', rid: '123' })).toBeNull();
  });

  it('returns null for a non-rid-shaped tabRid even when rid is valid', () => {
    expect(parseInterceptorMessage({ type: 'PAGE_CONTEXT', rid: RID, tabRid: 'forged' })).toBeNull();
  });
});

describe('parseInterceptorMessage — EDIT_PAGE_CONTEXT', () => {
  it('accepts a validated edit context and an explicit clear', () => {
    expect(parseInterceptorMessage({
      type: 'EDIT_PAGE_CONTEXT',
      context: { editPageRid: RID, parentRid: RID2, objectType: 'CeProcedure' },
    })).toEqual({
      type: 'EDIT_PAGE_CONTEXT',
      context: {
        editPageRid: RID,
        initializerRid: undefined,
        templateRid: undefined,
        webParentRid: undefined,
        parentRid: RID2,
        objectRid: undefined,
        objectName: undefined,
        objectType: 'CeProcedure',
      },
    });
    expect(parseInterceptorMessage({ type: 'EDIT_PAGE_CONTEXT' })).toEqual({ type: 'EDIT_PAGE_CONTEXT' });
  });

  it('rejects forged edit-page RIDs', () => {
    expect(parseInterceptorMessage({
      type: 'EDIT_PAGE_CONTEXT',
      context: { editPageRid: RID, initializerRid: 'bad' },
    })).toBeNull();
  });

  it('validates rendered edit-field metadata without accepting arbitrary payloads', () => {
    expect(parseInterceptorMessage({
      type: 'EDIT_PAGE_CONTEXT',
      context: {
        editPageRid: RID,
        fields: [{
          kind: 'info',
          key: 4,
          objectRef: '7808624541928645082',
          displayName: 'Obligation Text',
          pageIndex: 0,
          columnIndex: 0,
        }],
      },
    })).toMatchObject({
      type: 'EDIT_PAGE_CONTEXT',
      context: {
        fields: [{
          kind: 'info',
          key: 4,
          objectRef: '7808624541928645082',
          displayName: 'Obligation Text',
        }],
      },
    });
    expect(parseInterceptorMessage({
      type: 'EDIT_PAGE_CONTEXT',
      context: { editPageRid: RID, fields: [{ key: -1 }] },
    })).toBeNull();
    expect(parseInterceptorMessage({
      type: 'EDIT_PAGE_CONTEXT',
      context: { editPageRid: RID, fields: [{ kind: 'info', objectRef: 'not-a-rid' }] },
    })).toBeNull();
  });
});

describe('parseInterceptorMessage — BMP_SIGNALS_RESULT', () => {
  it('accepts a well-formed message', () => {
    const msg = parseInterceptorMessage({ type: 'BMP_SIGNALS_RESULT', signals: ['window.Highcharts', '__CORPORATER__ global'] });
    expect(msg).toEqual({ type: 'BMP_SIGNALS_RESULT', signals: ['window.Highcharts', '__CORPORATER__ global'] });
  });

  it('accepts an empty signals array', () => {
    expect(parseInterceptorMessage({ type: 'BMP_SIGNALS_RESULT', signals: [] })).toEqual({ type: 'BMP_SIGNALS_RESULT', signals: [] });
  });

  it('returns null when signals is not an array of strings', () => {
    expect(parseInterceptorMessage({ type: 'BMP_SIGNALS_RESULT', signals: 'nope' })).toBeNull();
    expect(parseInterceptorMessage({ type: 'BMP_SIGNALS_RESULT', signals: [1, 2] })).toBeNull();
  });
});

describe('parseInterceptorMessage — allowlist boundary', () => {
  it('returns null for an unknown type', () => {
    expect(parseInterceptorMessage({ type: 'SOMETHING_FORGED', objects: [] })).toBeNull();
  });

  it('returns null for a non-object detail', () => {
    expect(parseInterceptorMessage(null)).toBeNull();
    expect(parseInterceptorMessage(undefined)).toBeNull();
    expect(parseInterceptorMessage('string')).toBeNull();
    expect(parseInterceptorMessage(42)).toBeNull();
  });

  it('returns null for an object with no type', () => {
    expect(parseInterceptorMessage({ objects: [] })).toBeNull();
  });
});
