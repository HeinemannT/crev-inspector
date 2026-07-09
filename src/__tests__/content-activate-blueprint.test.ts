// @vitest-environment happy-dom
/**
 * Tests for the PRODUCER half of the Blueprint lazy-load bridge in src/content.ts (plan 018,
 * see plans/009 for the bridge design):
 *
 *   - activateBlueprint() (content.ts:95-102) — reachable only through the real one-shot message
 *     path (BLUEPRINT_STATE via chrome.runtime.onMessage), since the function itself is not
 *     exported. We capture the listener content.ts registers with
 *     chrome.runtime.onMessage.addListener and drive it directly — the same seam
 *     oneShotMessageListener uses in production.
 *   - the post-apply resume block (content.ts:620-639) that reads sessionStorage[BP_RESUME_KEY]
 *     on boot and asks the SW to resume Blueprint once the page has painted.
 *
 * content.ts is a heavy always-on bootstrap module (persistent port, MutationObserver, one-shot
 * listener, cross-tab sync, frame overlays, …). None of that machinery is relevant to the
 * Blueprint bridge, so every heavy/side-effecting dependency is mocked out — the same "mock the
 * irrelevant, drive the real seam" style as content-blueprint-entry.test.ts. Nothing about
 * content.ts's SOURCE was changed to make this possible: activateBlueprint stays reachable only
 * via the real BLUEPRINT_STATE message, matching production exactly.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BP_RESUME_KEY } from '../lib/blueprint-resume';

type OneShotListener = (msg: any, sender: any, sendResponse: (r?: unknown) => void) => boolean;

const sendFireForget = vi.fn();
vi.mock('../lib/messaging', () => ({
  sendFireForget: (...a: unknown[]) => sendFireForget(...a),
}));

// Heavy / irrelevant machinery — mocked out so importing content.ts doesn't need a live SW port,
// a real MutationObserver, or DOM overlay rendering. None of these are exercised by the Blueprint
// bridge under test.
vi.mock('../lib/content-port', () => ({
  connectPort: vi.fn(),
  disconnectPort: vi.fn(),
  sendToSW: vi.fn(),
  onPortMessage: vi.fn(),
  onReconnect: vi.fn(),
}));
vi.mock('../content-overlays', () => ({
  syncOverlays: vi.fn(),
  removeOverlays: vi.fn(),
  updateLabels: vi.fn(),
}));
vi.mock('../content-paint', () => ({
  updatePaintCursors: vi.fn(),
  flashApplyResult: vi.fn(),
}));
vi.mock('../content-tooltip', () => ({
  showTooltipForElement: vi.fn(),
  hideTooltip: vi.fn(),
  applyTechnicalOverlay: vi.fn(),
  renderOverlayCards: vi.fn(),
}));
vi.mock('../content-observer', () => ({
  startObserver: vi.fn(),
}));
vi.mock('../content-frame-overlay', () => ({
  mountFrameOverlay: vi.fn(async () => undefined),
  teardownFrameOverlayModule: vi.fn(),
}));
vi.mock('../lib/toast', () => ({
  showToast: vi.fn(),
}));

let messageListener: OneShotListener | undefined;

/** Fresh chrome.runtime.onMessage mock per import — captures the listener content.ts registers
 *  at module top-level (content.ts:505), which is the only reachable seam to activateBlueprint(). */
function setupChrome(): void {
  messageListener = undefined;
  (globalThis as any).chrome = {
    runtime: {
      onMessage: {
        addListener: vi.fn((fn: OneShotListener) => { messageListener = fn; }),
        removeListener: vi.fn(),
      },
    },
  };
}

async function loadContent(): Promise<void> {
  vi.resetModules();
  setupChrome();
  await import('../content');
}

function captureBpCmdEvents(): unknown[] {
  const events: unknown[] = [];
  document.addEventListener('crev-bp-cmd', ((e: CustomEvent) => { events.push(e.detail); }) as EventListener);
  return events;
}

beforeEach(() => {
  sendFireForget.mockReset();
  sessionStorage.clear();
  document.body.innerHTML = '';
  const w = window as unknown as Record<string, unknown>;
  delete w.__crev_content_loaded;
  delete w.__crev_teardown;
  delete w.__crevBpResolver;
  delete w.__crevBpPendingEnable;
  delete w.__crevBpResumePrefer;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('activateBlueprint — first-activation race + injection-once guard', () => {
  it('first call: fires INJECT_BLUEPRINT exactly once, sets __crevBpPendingEnable BEFORE the message, and dispatches enable', async () => {
    await loadContent();
    expect(messageListener).toBeDefined();
    const bpCmdEvents = captureBpCmdEvents();

    // Capture the pending-enable flag's value AT THE MOMENT sendFireForget is invoked — proves the
    // flag is set before the injection request goes out, not after (the race the comment at
    // content.ts:91-94 documents).
    let pendingWhenSent: unknown;
    sendFireForget.mockImplementationOnce(() => {
      pendingWhenSent = (window as any).__crevBpPendingEnable;
    });

    messageListener!({ type: 'BLUEPRINT_STATE', active: true }, {}, () => {});

    expect(sendFireForget).toHaveBeenCalledTimes(1);
    expect(sendFireForget).toHaveBeenCalledWith({ type: 'INJECT_BLUEPRINT' });
    expect(pendingWhenSent).toBe(true);
    expect(bpCmdEvents).toEqual([{ cmd: 'enable' }]);
  });

  it('second and third calls do not re-fire INJECT_BLUEPRINT (blueprintInjected guard holds), but still dispatch enable every time', async () => {
    await loadContent();
    const bpCmdEvents = captureBpCmdEvents();

    messageListener!({ type: 'BLUEPRINT_STATE', active: true }, {}, () => {});
    messageListener!({ type: 'BLUEPRINT_STATE', active: true }, {}, () => {});
    messageListener!({ type: 'BLUEPRINT_STATE', active: true }, {}, () => {});

    expect(sendFireForget).toHaveBeenCalledTimes(1);
    expect(bpCmdEvents).toEqual([{ cmd: 'enable' }, { cmd: 'enable' }, { cmd: 'enable' }]);
  });

  it('BLUEPRINT_STATE with active:false dispatches disable, not enable, and never touches injection', async () => {
    await loadContent();
    const bpCmdEvents = captureBpCmdEvents();

    messageListener!({ type: 'BLUEPRINT_STATE', active: false }, {}, () => {});

    expect(sendFireForget).not.toHaveBeenCalled();
    expect(bpCmdEvents).toEqual([{ cmd: 'disable' }]);
  });
});

describe('post-apply Blueprint resume (content.ts:620-639)', () => {
  it('fresh resume payload + a painted [data-rid]: sets __crevBpResumePrefer and fires BLUEPRINT_RESUME, then consumes the one-shot key', async () => {
    sessionStorage.setItem(BP_RESUME_KEY, JSON.stringify({ prefer: 'instance', t: Date.now() }));
    const el = document.createElement('div');
    el.setAttribute('data-rid', '8639152947620');
    document.body.appendChild(el);

    await loadContent();

    expect((window as any).__crevBpResumePrefer).toBe('instance');
    expect(sendFireForget).toHaveBeenCalledWith({ type: 'BLUEPRINT_RESUME' });
    expect(sessionStorage.getItem(BP_RESUME_KEY)).toBeNull(); // one-shot — consumed
  });

  it('defaults prefer to "template" when the stashed payload omits it', async () => {
    sessionStorage.setItem(BP_RESUME_KEY, JSON.stringify({ t: Date.now() }));
    const el = document.createElement('div');
    el.setAttribute('data-rid', '1');
    document.body.appendChild(el);

    await loadContent();

    expect((window as any).__crevBpResumePrefer).toBe('template');
  });

  it('stale payload (>30s old): does NOT set resume-prefer or fire BLUEPRINT_RESUME, even with a painted page', async () => {
    sessionStorage.setItem(BP_RESUME_KEY, JSON.stringify({ prefer: 'template', t: Date.now() - 31_000 }));
    const el = document.createElement('div');
    el.setAttribute('data-rid', '1');
    document.body.appendChild(el);

    await loadContent();

    expect((window as any).__crevBpResumePrefer).toBeUndefined();
    expect(sendFireForget).not.toHaveBeenCalledWith({ type: 'BLUEPRINT_RESUME' });
    // Still one-shot consumed even when stale — a later manual reload must not re-trigger it.
    expect(sessionStorage.getItem(BP_RESUME_KEY)).toBeNull();
  });

  it('no [data-rid] painted yet: does not fire immediately — polls until the page paints', async () => {
    vi.useFakeTimers();
    sessionStorage.setItem(BP_RESUME_KEY, JSON.stringify({ prefer: 'template', t: Date.now() }));
    // No [data-rid] element in the document — the page hasn't painted BMP content yet.

    await loadContent();

    expect(sendFireForget).not.toHaveBeenCalled();

    // BMP finishes its first paint — the bounded poll (500ms tick) should now find it and fire.
    const el = document.createElement('div');
    el.setAttribute('data-rid', '1');
    document.body.appendChild(el);
    await vi.advanceTimersByTimeAsync(500);

    expect(sendFireForget).toHaveBeenCalledWith({ type: 'BLUEPRINT_RESUME' });
  });

  it('no stashed resume key: the resume block is a no-op', async () => {
    // sessionStorage left empty by beforeEach.
    await loadContent();

    expect(sendFireForget).not.toHaveBeenCalled();
    expect((window as any).__crevBpResumePrefer).toBeUndefined();
  });
});
