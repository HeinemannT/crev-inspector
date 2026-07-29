import { describe, expect, it } from 'vitest';
import { clearCommittedDraft, reconcileInstanceOverrides } from '../saved-state';

describe('expanded object view saved state', () => {
  it('adds changed instance properties and removes reset properties', () => {
    expect(reconcileInstanceOverrides(
      ['showToolMenu', 'disableSearch'],
      ['shadow', 'disableSearch'],
      ['showToolMenu'],
    )).toEqual(['disableSearch', 'shadow']);
  });

  it('does not mutate the server-provided override list', () => {
    const current = ['disableSearch'];
    reconcileInstanceOverrides(current, ['shadow'], []);
    expect(current).toEqual(['disableSearch']);
  });

  it('clears only values that still match the submitted transaction', () => {
    const draft = {
      disableSearch: 'true',
      shadow: 'newer-programmatic-value',
    };
    const resets = new Set(['showToolMenu', 'visible']);

    clearCommittedDraft(
      draft,
      resets,
      { disableSearch: 'true', shadow: 'false' },
      ['showToolMenu'],
    );

    expect(draft).toEqual({ shadow: 'newer-programmatic-value' });
    expect([...resets]).toEqual(['visible']);
  });
});
