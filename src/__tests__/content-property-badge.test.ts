// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { ContentState } from '../content-state';
import { createIdentityLabel, updateLabels } from '../content-overlays';
import { ICON_PROP_REFERENCE } from '../lib/icons';

describe('inspect overlay property badge presentation', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="host">
        <span class="crev-label crev-label-loading" data-crev-label="700">
          <span class="crev-label-text">?</span>
        </span>
      </div>
    `;
  });

  it('keeps the normal object overlay but applies the property capsule variant', () => {
    const state = new ContentState();
    state.enrichments.set('700', {
      type: 'HistoricalReferenceMethodConfig',
      businessId: 'linkedControls',
    });

    updateLabels(state);

    const stub = document.querySelector('.crev-stub')!;
    expect(stub.classList.contains('crev-stub--property')).toBe(true);
    expect(stub.classList.contains('crev-stub--historical')).toBe(true);
    expect(stub.querySelector('.crev-history-indicator svg')).toBeTruthy();
    expect(stub.querySelector('.crev-label-text')?.textContent).toBe('linkedControls');
    expect(document.querySelector<HTMLElement>('#host')?.style.getPropertyValue('--crev-color'))
      .toBe('#a56f43');
  });

  it('does not add property classes or history marks to a normal BMP object', () => {
    const state = new ContentState();
    state.enrichments.set('700', { type: 'Container', businessId: 'main' });

    updateLabels(state);

    const stub = document.querySelector('.crev-stub')!;
    expect(stub.classList.contains('crev-stub--property')).toBe(false);
    expect(stub.classList.contains('crev-stub--historical')).toBe(false);
    expect(stub.querySelector('.crev-history-indicator')).toBeNull();
  });

  it('uses the linked property kind and color on an EditField property action', () => {
    const state = new ContentState();
    state.enrichments.set('700', { type: 'EditField', businessId: 'riskOwnerField' });

    const label = createIdentityLabel(state, '700', undefined, {
      rid: '701',
      businessId: 'riskOwner',
      type: 'ReferenceMethodConfig',
    });
    const action = label.querySelector<HTMLElement>('.crev-sub--property')!;

    expect(action.style.getPropertyValue('--crev-property-color')).toBe('#a56f43');
    expect(action.querySelector('svg')?.outerHTML).toContain(
      ICON_PROP_REFERENCE.match(/<path d="([^"]+)"/)?.[1] ?? 'missing-reference-icon',
    );
  });
});
