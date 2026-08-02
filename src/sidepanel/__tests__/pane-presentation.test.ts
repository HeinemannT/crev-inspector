import { describe, expect, it } from 'vitest';
import { panePresentation } from '../pane-presentation';

describe('pane presentation policy', () => {
  it('keeps every master-Property capability in the custom view', () => {
    expect(panePresentation('HistoricalNumberMethodConfig', true)).toEqual({
      body: 'property',
      requestSchema: false,
      customRelationships: true,
      showTargetToggle: false,
    });
  });

  it('does not apply the master view to a linked MethodConfig application', () => {
    expect(panePresentation('HistoricalNumberMethodConfig', false)).toEqual({
      body: 'standard',
      requestSchema: true,
      customRelationships: false,
      showTargetToggle: true,
    });
  });
});
