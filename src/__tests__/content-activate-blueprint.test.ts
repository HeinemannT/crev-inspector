// @vitest-environment happy-dom
/**
 * Tests for the producer half of the Blueprint lazy-load bridge in src/content.ts:
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
const sendToSW = vi.fn();
const detectBmpPage = vi.fn(() => ({ confidence: 0, signals: [] as string[], isBmp: false }));
const extractUrlRids = vi.fn((): { rid?: string } => ({}));
vi.mock('../lib/messaging', () => ({
  sendFireForget: (...a: unknown[]) => sendFireForget(...a),
}));

// Heavy / irrelevant machinery — mocked out so importing content.ts doesn't need a live SW port,
// a real MutationObserver, or DOM overlay rendering. None of these are exercised by the Blueprint
// bridge under test.
vi.mock('../lib/content-port', () => ({
  connectPort: vi.fn(),
  disconnectPort: vi.fn(),
  sendToSW: (...a: unknown[]) => sendToSW(...a),
  onPortMessage: vi.fn(),
  onReconnect: vi.fn(),
}));
vi.mock('../lib/dom-scanner', () => ({
  extractUrlRids: () => extractUrlRids(),
  scanPageWidgets: vi.fn(() => []),
  detectBmpPage: () => detectBmpPage(),
  findTabButton: vi.fn(() => null),
  isTabActive: vi.fn(() => false),
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
  sendToSW.mockReset();
  detectBmpPage.mockReset();
  detectBmpPage.mockReturnValue({ confidence: 0, signals: [], isBmp: false });
  extractUrlRids.mockReset();
  extractUrlRids.mockReturnValue({});
  sessionStorage.clear();
  document.body.innerHTML = '';
  const w = window as unknown as Record<string, unknown>;
  delete w.__crev_content_loaded;
  delete w.__crev_teardown;
  delete w.__crevBpResolver;
  delete w.__crevBpEntryReady;
  delete w.__crevBpPendingCmds;
  delete w.__crevBpResumePrefer;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('activateBlueprint — first-activation race + injection-once guard', () => {
  it('first activation: fires INJECT_BLUEPRINT exactly once and BUFFERS enable (entry not listening yet)', async () => {
    await loadContent();
    expect(messageListener).toBeDefined();
    const bpCmdEvents = captureBpCmdEvents();

    messageListener!({ type: 'BLUEPRINT_STATE', active: true }, {}, () => {});

    expect(sendFireForget).toHaveBeenCalledTimes(1);
    expect(sendFireForget).toHaveBeenCalledWith({ type: 'INJECT_BLUEPRINT' });
    // The entry hasn't signalled ready, so nothing is dispatched live — enable is queued in order
    // for the entry to drain on its own init (the race content.ts:91-94 documents).
    expect(bpCmdEvents).toEqual([]);
    expect((window as any).__crevBpPendingCmds).toEqual([{ cmd: 'enable' }]);
  });

  it('B1 REGRESSION: on→off during the first-injection window buffers [enable, disable] in order — the disable is not dropped', async () => {
    await loadContent();
    const bpCmdEvents = captureBpCmdEvents();

    // User toggles Blueprint on, then off, before content-blueprint.js has attached its listener.
    messageListener!({ type: 'BLUEPRINT_STATE', active: true }, {}, () => {});
    messageListener!({ type: 'BLUEPRINT_STATE', active: false }, {}, () => {});

    // Both commands survive, in order — pre-fix the disable was a lost live CustomEvent and the
    // entry self-enabled from a hardcoded pending flag, leaving Blueprint stuck ON.
    expect(bpCmdEvents).toEqual([]);
    expect((window as any).__crevBpPendingCmds).toEqual([{ cmd: 'enable' }, { cmd: 'disable' }]);
    // The off toggle must not trigger a second injection.
    expect(sendFireForget).toHaveBeenCalledTimes(1);
    expect(sendFireForget).toHaveBeenCalledWith({ type: 'INJECT_BLUEPRINT' });
  });

  it('once the entry signals ready, commands dispatch live instead of buffering; INJECT fires only once', async () => {
    await loadContent();
    const bpCmdEvents = captureBpCmdEvents();
    (window as any).__crevBpEntryReady = true;

    messageListener!({ type: 'BLUEPRINT_STATE', active: true }, {}, () => {});
    messageListener!({ type: 'BLUEPRINT_STATE', active: true }, {}, () => {});
    messageListener!({ type: 'BLUEPRINT_STATE', active: true }, {}, () => {});

    // blueprintInjected guard holds — INJECT once; every enable dispatches live, nothing buffered.
    expect(sendFireForget).toHaveBeenCalledTimes(1);
    expect(bpCmdEvents).toEqual([{ cmd: 'enable' }, { cmd: 'enable' }, { cmd: 'enable' }]);
    expect((window as any).__crevBpPendingCmds).toBeUndefined();
  });

  it('BLUEPRINT_STATE active:false while the entry is not ready buffers disable and never injects', async () => {
    await loadContent();
    const bpCmdEvents = captureBpCmdEvents();

    messageListener!({ type: 'BLUEPRINT_STATE', active: false }, {}, () => {});

    expect(sendFireForget).not.toHaveBeenCalled();
    expect(bpCmdEvents).toEqual([]);
    expect((window as any).__crevBpPendingCmds).toEqual([{ cmd: 'disable' }]);
  });
});

describe('fresh page-info detection', () => {
  it('publishes a BMP transition discovered by GET_PAGE_INFO before observer refresh', async () => {
    detectBmpPage
      .mockReturnValueOnce({ confidence: 0, signals: [], isBmp: false })
      .mockReturnValueOnce({ confidence: 0.55, signals: ['#epmapp root'], isBmp: true });
    await loadContent();
    sendToSW.mockClear();

    messageListener!({ type: 'GET_PAGE_INFO' }, {}, () => {});

    expect(sendToSW).toHaveBeenCalledWith({
      type: 'DETECTION_RESULT', confidence: 0.55, signals: ['#epmapp root'], isBmp: true,
    });
  });
});

describe('Blueprint target resolution on standalone edit routes', () => {
  it('requests editionContext when a rendered edit form has a parent RID in the URL', async () => {
    extractUrlRids.mockReturnValue({ rid: '7862795079527071941' });
    document.body.innerHTML = '<div class="edit-page"></div>';
    await loadContent();

    let scans = 0;
    document.addEventListener('crev-content', ((event: CustomEvent) => {
      if (event.detail?.type !== 'EXTRACT_FIBERS') return;
      scans++;
      document.dispatchEvent(new CustomEvent('crev-interceptor', {
        detail: {
          type: 'EDIT_PAGE_CONTEXT',
          context: { editPageRid: '4081032302720082045' },
        },
      }));
    }) as EventListener, { once: true });

    expect((window as any).__crevBpResolver()).toBe('4081032302720082045');
    expect(scans).toBe(1);
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
