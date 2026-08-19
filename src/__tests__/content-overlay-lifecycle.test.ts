// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ContentState } from '../content-state';
import { syncOverlays } from '../content-overlays';

const { sendToSW } = vi.hoisted(() => ({ sendToSW: vi.fn() }));
vi.mock('../lib/content-port', () => ({ sendToSW }));
vi.mock('../lib/messaging', () => ({ sendFireForget: vi.fn() }));

describe('inspect overlay DOM ownership', () => {
  let state: ContentState;
  let link: HTMLAnchorElement;

  beforeEach(() => {
    document.body.innerHTML = '<a id="target" href="/?rid=111">Target</a>';
    link = document.getElementById('target') as HTMLAnchorElement;
    state = new ContentState();
    state.enrichMode = 'all';
    sendToSW.mockClear();
  });

  it('reconciles a surviving host after tracking state is reset', () => {
    syncOverlays(state);
    state.resetOverlays();
    syncOverlays(state);

    expect(link.querySelectorAll(':scope > .crev-label')).toHaveLength(1);
    expect(link.querySelector('.crev-label')?.getAttribute('data-crev-label')).toBe('111');
  });

  it('replaces a stale label when BMP reuses a host for another RID', () => {
    syncOverlays(state);
    link.href = '/?rid=222';
    state.resetOverlays();
    syncOverlays(state);

    expect(link.querySelectorAll(':scope > .crev-label')).toHaveLength(1);
    expect(link.querySelector('.crev-label')?.getAttribute('data-crev-label')).toBe('222');
  });
});
