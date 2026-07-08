/**
 * @vitest-environment happy-dom
 *
 * The toast container must carry position:fixed INLINE. toast.ts is shared
 * between the content script and the side panel; in the content script a
 * connection toast can fire before any overlay stylesheet is injected
 * (pre-Inspect). Without inline position the container would fall into normal
 * page flow at the bottom — the same "bottom-left leak" class as the overlays.
 * Only `position` is inlined (the coords differ per context and stay in CSS).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { showToast } from '../toast';

describe('toast container positioning', () => {
  afterEach(() => {
    document.getElementById('crev-toast-container')?.remove();
    vi.restoreAllMocks();
  });

  it('sets position:fixed inline, so it floats with no stylesheet present', () => {
    expect(document.getElementById('crev-toast-container')).toBeNull();
    showToast('probe', 'info');
    const container = document.getElementById('crev-toast-container') as HTMLElement;
    expect(container).not.toBeNull();
    expect(container.style.position).toBe('fixed');
  });
});
