/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it } from 'vitest';
import { AiTab } from '../ai-tab';
import { S } from '../../state';

describe('AI context chip', () => {
  afterEach(() => { S.context = null; document.body.textContent = ''; });

  it('shows the object identity without the redundant Selection label', () => {
    S.context = {
      rid: '726548820039520945',
      businessId: 'bmw_sharepoint_sc',
      name: 'Sharepoint Integration',
      type: 'Scorecard',
    };
    const container = document.createElement('div');
    document.body.appendChild(container);
    new AiTab(() => {}).render(container);

    expect(container.querySelector('.ai-cchip-name')?.textContent).toBe('bmw_sharepoint_sc');
    expect(container.querySelector('.ai-cchip-src')).toBeNull();
    expect(container.textContent?.toLowerCase()).not.toContain('selection');
  });
});
