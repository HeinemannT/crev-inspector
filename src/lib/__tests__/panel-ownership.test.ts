import { describe, expect, it } from 'vitest';
import { shouldAcceptPanelClaim } from '../panel-ownership';

describe('panel ownership', () => {
  it('rejects an older document even when its reconnect arrives last', () => {
    const newer = { panelIncarnation: 'new', panelCreatedAt: 200 };
    const older = { panelIncarnation: 'old', panelCreatedAt: 100 };
    expect(shouldAcceptPanelClaim(newer, older)).toBe(false);
    expect(shouldAcceptPanelClaim(older, newer)).toBe(true);
  });

  it('accepts reconnects from the current document', () => {
    const current = { panelIncarnation: 'same', panelCreatedAt: 100 };
    expect(shouldAcceptPanelClaim(current, { ...current })).toBe(true);
  });
});
