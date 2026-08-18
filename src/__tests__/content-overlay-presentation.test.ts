// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { ContentState } from '../content-state';
import { createIdentityLabel, updateLabels } from '../content-overlays';
import { ICON_BROWSER } from '../lib/icons';
import { PAGE_NAV_PRESENTATION } from '../lib/overlay-presentation';
import { getTypeColor } from '../lib/types';

describe('inspect overlay role presentation', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('keeps page navigation compact and semantic after backing-type enrichment', () => {
    const state = new ContentState();
    state.enrichments.set('119', {
      type: 'ExtendedTable',
      businessId: 'risk_register',
      name: 'Risk Register',
    });
    const host = document.createElement('a');
    const label = createIdentityLabel(state, '119', PAGE_NAV_PRESENTATION);
    host.prepend(label);
    document.body.appendChild(host);

    updateLabels(state);

    expect(label.classList.contains('crev-label--inline-start')).toBe(true);
    expect(label.classList.contains('crev-label--compact')).toBe(true);
    expect(label.querySelector('.crev-label-text')?.textContent).toBe('risk_register');
    expect(label.querySelector('svg')?.outerHTML).toContain(
      ICON_BROWSER.match(/<path d="([^"]+)"/)?.[1] ?? 'missing-browser-icon',
    );
    expect(host.style.getPropertyValue('--crev-color')).toBe(getTypeColor('Page'));
    expect(host.style.getPropertyValue('--crev-color')).not.toBe(getTypeColor('ExtendedTable'));
  });
});
