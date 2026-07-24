// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ContentState } from '../content-state';
import { removePageHeaderIdentity, syncPageHeaderIdentity } from '../content-page-header';

const { sendToSW } = vi.hoisted(() => ({ sendToSW: vi.fn() }));
vi.mock('../lib/content-port', () => ({ sendToSW }));

function visibleHeading(text: string): HTMLHeadingElement {
  const element = document.createElement('h1');
  element.textContent = text;
  element.getBoundingClientRect = () => ({
    x: 20,
    y: 60,
    top: 60,
    right: 340,
    bottom: 96,
    left: 20,
    width: 320,
    height: 36,
    toJSON: () => ({}),
  });
  return element;
}

describe('page header identity lifecycle', () => {
  let state: ContentState;
  let title: HTMLHeadingElement;

  beforeEach(() => {
    document.body.innerHTML = '';
    const root = document.createElement('div');
    root.id = 'epmapp';
    title = visibleHeading('Process Register');
    root.appendChild(title);
    document.body.appendChild(root);
    state = new ContentState();
    sendToSW.mockClear();
  });

  it('mounts one shared identity label and requests missing enrichment', () => {
    syncPageHeaderIdentity(state, '4461927418075734575');
    syncPageHeaderIdentity(state, '4461927418075734575');

    const labels = title.querySelectorAll('.crev-page-label');
    expect(labels).toHaveLength(1);
    expect(labels[0].getAttribute('data-crev-label')).toBe('4461927418075734575');
    expect(sendToSW).toHaveBeenCalledTimes(1);
    expect(sendToSW).toHaveBeenCalledWith({
      type: 'ENRICH_BADGES',
      rids: ['4461927418075734575'],
    });
  });

  it('replaces the identity when the resolved page changes', () => {
    syncPageHeaderIdentity(state, '111');
    state.enrichments.set('222', { name: 'Process Register', businessId: 'PR', type: 'Scorecard' });

    syncPageHeaderIdentity(state, '222');

    expect(title.querySelectorAll('.crev-page-label')).toHaveLength(1);
    expect(title.querySelector('.crev-page-label')?.getAttribute('data-crev-label')).toBe('222');
    expect(state.pageHeaderRid).toBe('222');
  });

  it('reattaches once when BMP replaces the heading during a render', () => {
    syncPageHeaderIdentity(state, '111');
    const replacement = visibleHeading('Process Register');
    title.replaceWith(replacement);

    syncPageHeaderIdentity(state, '111');
    syncPageHeaderIdentity(state, '111');

    expect(replacement.querySelectorAll('.crev-page-label')).toHaveLength(1);
    expect(state.pageHeaderElement).toBe(replacement);
  });

  it('removes the identity cleanly when Inspect turns off', () => {
    syncPageHeaderIdentity(state, '111');

    removePageHeaderIdentity(state);

    expect(title.querySelector('.crev-page-label')).toBeNull();
    expect(state.pageHeaderElement).toBeNull();
    expect(state.pageHeaderRid).toBeNull();
  });
});
