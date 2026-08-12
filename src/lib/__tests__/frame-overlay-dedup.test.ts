/**
 * @vitest-environment happy-dom
 *
 * Tests for src/content-frame-overlay.ts — the dedup guard and module
 * teardown added for the duplicate-editor-window / re-injection-leak fix.
 *
 * Coverage:
 * - two concurrent same-kind mounts append exactly ONE host (mounting guard
 *   closes the await-readBounds TOCTOU window)
 * - teardownFrameOverlayModule() unmounts every host AND clears the
 *   crev-task-open body flag
 * - a mount whose readBounds resolves AFTER teardown does not append a host
 *
 * Each test re-imports the module via vi.resetModules() so module-level state
 * (the `frames` Map, the one-way `moduleTorn` latch) starts fresh — mirroring
 * production, where every content-script injection re-runs the bundle anew.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

type FrameOverlayModule = typeof import('../../content-frame-overlay');

function hosts() {
  return document.querySelectorAll('.crev-eo-host');
}

function respondFrom(iframe: HTMLIFrameElement, ok: boolean): void {
  const event = new MessageEvent('message', {
    data: { type: 'CREV_OVERLAY_CLOSE_RESPONSE', ok },
  });
  Object.defineProperty(event, 'source', { value: iframe.contentWindow });
  window.dispatchEvent(event);
}

function readyFrom(iframe: HTMLIFrameElement): void {
  const event = new MessageEvent('message', {
    data: { type: 'CREV_FRAME_READY' },
  });
  Object.defineProperty(event, 'source', { value: iframe.contentWindow });
  window.dispatchEvent(event);
}

// about:blank so happy-dom doesn't try to fetch/navigate the overlay iframe
// (a chrome-extension:// src triggers a noisy unhandled rejection). These
// tests assert on the host element, not iframe content.
const OPTS = { kind: 'editor' as const, url: 'about:blank', label: 'Editor', defaultWidth: 960, defaultHeight: 640 };

let resolveGet: (() => void) | null;

async function freshModule(): Promise<FrameOverlayModule> {
  vi.resetModules();
  resolveGet = null;
  (globalThis as any).chrome = {
    storage: {
      local: {
        // Deferred so the test can interleave a second mount / teardown
        // before readBounds resolves.
        get: vi.fn(() => new Promise<Record<string, unknown>>((res) => { resolveGet = () => res({}); })),
        set: vi.fn(async () => {}),
      },
    },
  };
  return import('../../content-frame-overlay');
}

describe('content-frame-overlay dedup + teardown', () => {
  beforeEach(() => { resolveGet = null; });

  afterEach(() => {
    document.documentElement.querySelectorAll('.crev-eo-host').forEach(h => h.remove());
    document.getElementById('crev-inspector-styles')?.remove();
    document.body.classList.remove('crev-task-open');
    delete (globalThis as any).chrome;
  });

  it('injects the overlay stylesheet on mount even when Inspect never ran (no bottom-left leak)', async () => {
    expect(document.getElementById('crev-inspector-styles')).toBeNull(); // no Inspect, no sheet yet
    const m = await freshModule();
    const p = m.mountFrameOverlay(OPTS);
    resolveGet!();
    await p;
    expect(hosts()).toHaveLength(1);
    // `.crev-eo-host` is position:fixed in this sheet — its presence is what keeps the host out of
    // normal page flow. Before the fix it was injected only by Inspect, so a landing-page editor leaked.
    expect(document.getElementById('crev-inspector-styles')).not.toBeNull();
  });

  it('the host carries position:fixed INLINE, so it floats even if the stylesheet is missing', async () => {
    const m = await freshModule();
    const p = m.mountFrameOverlay(OPTS);
    resolveGet!();
    await p;
    const host = hosts()[0] as HTMLElement;
    // The floor against the bottom-left leak: positioning must not depend on the injectable/removable
    // stylesheet. Even with no <style> present, inline position:fixed keeps the host floating.
    expect(host.style.position).toBe('fixed');
    expect(host.style.zIndex).not.toBe('');
  });

  it('appends exactly one host for two concurrent same-kind mounts', async () => {
    const m = await freshModule();
    const p1 = m.mountFrameOverlay(OPTS);
    const p2 = m.mountFrameOverlay(OPTS);
    resolveGet!();
    await expect(Promise.all([p1, p2])).resolves.toEqual(['mounted', 'activated']);
    expect(hosts()).toHaveLength(1);
  });

  it('queues same-resource activation until the iframe reports ready', async () => {
    const m = await freshModule();
    const p = m.mountFrameOverlay({
      ...OPTS,
      resourceKey: 'editor:42',
      activation: { type: 'editor', rid: '42', property: 'expression' },
    });
    resolveGet!();
    await p;
    const host = hosts()[0] as HTMLElement;
    const iframe = host.querySelector('iframe')!;
    const postMessage = vi.spyOn(iframe.contentWindow!, 'postMessage');

    const disposition = await m.mountFrameOverlay({
      ...OPTS,
      resourceKey: 'editor:42',
      label: 'ExtendedTable · Results',
      activation: { type: 'editor', rid: '42', property: 'afterExpression' },
    });

    expect(disposition).toBe('activated');
    expect(host.querySelector('iframe')).toBe(iframe);
    expect(host.getAttribute('aria-label')).toBe('ExtendedTable · Results');
    expect(host.querySelector('.crev-eo-titlebar-label')?.textContent).toBe('ExtendedTable · Results');
    expect(postMessage).not.toHaveBeenCalled();

    readyFrom(iframe);

    expect(postMessage).toHaveBeenCalledWith({
      type: 'CREV_FRAME_ACTIVATE',
      activation: { type: 'editor', rid: '42', property: 'afterExpression' },
    }, '*');
  });

  it('waits for close approval before replacing a different resource', async () => {
    const m = await freshModule();
    const p = m.mountFrameOverlay({ ...OPTS, resourceKey: 'editor:42', label: 'First' });
    resolveGet!();
    await p;
    const host = hosts()[0] as HTMLElement;
    const firstIframe = host.querySelector('iframe')!;
    const postMessage = vi.spyOn(firstIframe.contentWindow!, 'postMessage');

    await m.mountFrameOverlay({ ...OPTS, resourceKey: 'editor:84', label: 'Second' });

    expect(host.querySelector('iframe')).toBe(firstIframe);
    expect(host.querySelector('.crev-eo-titlebar-label')?.textContent).toBe('First');
    expect(postMessage).toHaveBeenCalledWith({ type: 'CREV_OVERLAY_CLOSE_REQUEST' }, '*');

    respondFrom(firstIframe, true);

    expect(host.querySelector('iframe')).not.toBe(firstIframe);
    expect(host.querySelector('.crev-eo-titlebar-label')?.textContent).toBe('Second');
    expect(host.getAttribute('aria-label')).toBe('Second');
  });

  it('keeps the current resource when replacement is declined', async () => {
    const m = await freshModule();
    const p = m.mountFrameOverlay({ ...OPTS, resourceKey: 'editor:42', label: 'First' });
    resolveGet!();
    await p;
    const host = hosts()[0] as HTMLElement;
    const firstIframe = host.querySelector('iframe')!;

    await m.mountFrameOverlay({ ...OPTS, resourceKey: 'editor:84', label: 'Second' });
    respondFrom(firstIframe, false);

    expect(host.querySelector('iframe')).toBe(firstIframe);
    expect(host.querySelector('.crev-eo-titlebar-label')?.textContent).toBe('First');
  });

  it('guards a forced refresh of the same scratch resource', async () => {
    const m = await freshModule();
    const p = m.mountFrameOverlay({ ...OPTS, resourceKey: 'editor:extended' });
    resolveGet!();
    await p;
    const host = hosts()[0] as HTMLElement;
    const firstIframe = host.querySelector('iframe')!;
    const postMessage = vi.spyOn(firstIframe.contentWindow!, 'postMessage');

    await m.mountFrameOverlay({
      ...OPTS,
      resourceKey: 'editor:extended',
      replaceExisting: true,
    });

    expect(postMessage).toHaveBeenCalledWith({ type: 'CREV_OVERLAY_CLOSE_REQUEST' }, '*');
    respondFrom(firstIframe, true);
    expect(host.querySelector('iframe')).not.toBe(firstIframe);
  });

  it('replays the latest request received while initial bounds are loading', async () => {
    const m = await freshModule();
    const p1 = m.mountFrameOverlay({ ...OPTS, resourceKey: 'editor:42', label: 'First' });
    const p2 = m.mountFrameOverlay({ ...OPTS, resourceKey: 'editor:84', label: 'Second' });
    resolveGet!();
    await Promise.all([p1, p2]);
    const host = hosts()[0] as HTMLElement;
    const firstIframe = host.querySelector('iframe')!;

    respondFrom(firstIframe, true);

    expect(host.querySelector('.crev-eo-titlebar-label')?.textContent).toBe('Second');
  });

  it('keeps the existing close button on the same approval path', async () => {
    const m = await freshModule();
    const p = m.mountFrameOverlay(OPTS);
    resolveGet!();
    await p;
    const host = hosts()[0] as HTMLElement;
    const iframe = host.querySelector('iframe')!;
    const close = host.querySelector<HTMLButtonElement>('.crev-eo-close')!;

    close.click();
    respondFrom(iframe, false);
    expect(hosts()).toHaveLength(1);

    close.click();
    respondFrom(iframe, true);
    expect(hosts()).toHaveLength(0);
  });

  it('teardown removes the host and the crev-task-open body flag', async () => {
    const m = await freshModule();
    const p = m.mountFrameOverlay(OPTS);
    resolveGet!();
    await p;
    expect(hosts()).toHaveLength(1);
    expect(document.body.classList.contains('crev-task-open')).toBe(true);

    m.teardownFrameOverlayModule();
    expect(hosts()).toHaveLength(0);
    expect(document.body.classList.contains('crev-task-open')).toBe(false);
  });

  it('a mount that resolves after teardown does not append a host', async () => {
    const m = await freshModule();
    const p = m.mountFrameOverlay(OPTS); // parks on readBounds
    m.teardownFrameOverlayModule();      // module torn while mount in flight
    resolveGet!();
    await p;
    expect(hosts()).toHaveLength(0);
  });
});
