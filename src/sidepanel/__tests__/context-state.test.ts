import { describe, expect, it } from 'vitest';
import { contextFromData } from '../context-state';

describe('side-panel context state', () => {
  it('adopts the current page context even when no detail pane is open', () => {
    expect(contextFromData(null, {
      type: 'CONTEXT_RID_DATA',
      rid: '726548820039520945',
      name: 'Sharepoint Integration',
      objectType: 'Scorecard',
      businessId: 'bmw_sharepoint_sc',
    })).toEqual({
      rid: '726548820039520945',
      name: 'Sharepoint Integration',
      type: 'Scorecard',
      businessId: 'bmw_sharepoint_sc',
    });
  });

  it('replaces an old selection when navigation publishes a different page', () => {
    const old = { rid: '111', name: 'Old widget', type: 'TextElement', businessId: 'old_widget' };
    expect(contextFromData(old, {
      type: 'CONTEXT_RID_DATA', rid: '222', businessId: 'bmw_sharepoint_sc',
    })).toEqual({ rid: '222', name: undefined, type: undefined, businessId: 'bmw_sharepoint_sc' });
  });

  it('retains richer identity when a same-RID refresh is sparse', () => {
    const current = { rid: '222', name: 'Sharepoint Integration', type: 'Scorecard', businessId: 'bmw_sharepoint_sc' };
    expect(contextFromData(current, { type: 'CONTEXT_RID_DATA', rid: '222' })).toEqual(current);
  });

  it('clears stale context when the active tab has no BMP context', () => {
    const current = { rid: '222', businessId: 'bmw_sharepoint_sc' };
    expect(contextFromData(current, { type: 'CONTEXT_RID_DATA' })).toBeNull();
  });
});
