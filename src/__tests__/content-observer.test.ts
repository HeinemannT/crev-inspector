// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContentState } from '../content-state';
import { startObserver } from '../content-observer';

const { sendToSW } = vi.hoisted(() => ({ sendToSW: vi.fn() }));
vi.mock('../lib/content-port', () => ({ sendToSW }));
vi.mock('../content-overlays', () => ({ syncOverlays: vi.fn() }));

describe('content observer BMP render refresh', () => {
  let state: ContentState;

  beforeEach(() => {
    vi.useFakeTimers();
    history.replaceState({}, '', '/');
    document.body.innerHTML = '';
    state = new ContentState();
    state.lastUrl = window.location.href;
    sendToSW.mockClear();
  });

  afterEach(() => {
    state.observer?.disconnect();
    vi.useRealTimers();
  });

  it('re-runs detection before notifying the panel when BMP widgets mount', async () => {
    const events: string[] = [];
    const detect = vi.fn(() => events.push('detect'));
    sendToSW.mockImplementation(() => events.push('notify'));
    startObserver(state, detect);

    const widget = document.createElement('div');
    widget.dataset.rid = '123';
    document.body.appendChild(widget);
    await Promise.resolve(); // deliver MutationObserver records
    await vi.advanceTimersByTimeAsync(250);

    expect(detect).toHaveBeenCalledOnce();
    expect(sendToSW).toHaveBeenCalledWith({ type: 'BMP_PAGE_RENDER_CHANGED' });
    expect(events).toEqual(['detect', 'notify']);
  });

  it('detects a BMP root mounting even when the page has no widgets', async () => {
    const detect = vi.fn();
    startObserver(state, detect);
    const root = document.createElement('div');
    root.id = 'epmapp';
    document.body.appendChild(root);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);
    expect(detect).toHaveBeenCalledOnce();
    expect(sendToSW).toHaveBeenCalledWith({ type: 'BMP_PAGE_RENDER_CHANGED' });
  });

  it('detects same-count widget replacement by RID identity', async () => {
    document.body.innerHTML = '<div data-rid="111"></div>';
    const detect = vi.fn();
    startObserver(state, detect);
    document.querySelector('[data-rid]')!.setAttribute('data-rid', '222');
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);
    expect(detect).toHaveBeenCalledOnce();
    expect(sendToSW).toHaveBeenCalledWith({ type: 'BMP_PAGE_RENDER_CHANGED' });
  });

  it('cannot starve while mutations continue', async () => {
    const detect = vi.fn();
    startObserver(state, detect);
    for (let i = 0; i < 6; i++) {
      const node = document.createElement('div');
      node.dataset.rid = String(1000 + i);
      document.body.appendChild(node);
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(50);
    }
    expect(detect).toHaveBeenCalledOnce();
  });

  it('cancels a pending render refresh when the content instance is reset', async () => {
    const detect = vi.fn();
    startObserver(state, detect);
    const node = document.createElement('div');
    node.dataset.rid = '123';
    document.body.appendChild(node);
    await Promise.resolve();

    state.resetAll();
    await vi.advanceTimersByTimeAsync(250);

    expect(detect).not.toHaveBeenCalled();
    expect(sendToSW).not.toHaveBeenCalledWith({ type: 'BMP_PAGE_RENDER_CHANGED' });
  });

  it('treats a tabrid-only URL update as rendering, not page navigation', async () => {
    history.replaceState({}, '', '/?rid=999999&tabrid=111111');
    state.lastUrl = window.location.href;
    startObserver(state, vi.fn());
    history.replaceState({}, '', '/?rid=999999&tabrid=222222');
    document.body.appendChild(document.createElement('div'));
    await Promise.resolve();
    expect(sendToSW).toHaveBeenCalledWith({ type: 'BMP_PAGE_RENDER_CHANGED' });
    expect(sendToSW).not.toHaveBeenCalledWith({ type: 'BMP_URL_CHANGED' });
  });

  it('treats a page-owner rid update as navigation', async () => {
    history.replaceState({}, '', '/?rid=111111');
    state.lastUrl = window.location.href;
    state.fiberPageContext = { rid: '111111' };
    startObserver(state, vi.fn());
    history.replaceState({}, '', '/?rid=222222');
    document.body.appendChild(document.createElement('div'));
    await Promise.resolve();
    expect(sendToSW).toHaveBeenCalledWith({ type: 'BMP_URL_CHANGED' });
    expect(state.fiberPageContext).toBeNull();
  });

  it('tears down the inspect surface before repainting after navigation', async () => {
    history.replaceState({}, '', '/?rid=111111');
    state.lastUrl = window.location.href;
    state.inspectActive = true;
    const resetInspect = vi.fn();
    const syncInspect = vi.fn();
    startObserver(state, vi.fn(), syncInspect, resetInspect);

    history.replaceState({}, '', '/?rid=222222');
    document.body.appendChild(document.createElement('div'));
    await Promise.resolve();

    expect(resetInspect).toHaveBeenCalledOnce();
    expect(syncInspect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);
    expect(syncInspect).toHaveBeenCalledOnce();
  });
});
