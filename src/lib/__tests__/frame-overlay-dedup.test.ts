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
    // `.crev-eo-host` is position:absolute in this sheet — its presence is what keeps the host out of
    // normal page flow. Before the fix it was injected only by Inspect, so a landing-page editor leaked.
    expect(document.getElementById('crev-inspector-styles')).not.toBeNull();
  });

  it('appends exactly one host for two concurrent same-kind mounts', async () => {
    const m = await freshModule();
    const p1 = m.mountFrameOverlay(OPTS);
    const p2 = m.mountFrameOverlay(OPTS); // guard: mounting.has(kind) → dropped
    resolveGet!();
    await Promise.all([p1, p2]);
    expect(hosts()).toHaveLength(1);
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
