/**
 * Tests for the SW-side Blueprint orchestration in src/lib/handlers/layout.ts (plan 018):
 *
 *   - INJECT_BLUEPRINT: content.ts's first-activation request → ensureBlueprintScript(senderTabId),
 *     gated on senderTabId being present.
 *   - BLUEPRINT_RESUME: content.ts's post-apply resume request → resolves the tab's window, applies
 *     the inspect↔blueprint exclusivity (turns inspect off if it was on), then sets blueprint ON
 *     pinned to that tab.
 *   - toggleBlueprint / setBlueprintActive: the BLUEPRINT_TOGGLE / Ctrl+Shift+B path — same
 *     exclusivity when turning blueprint on, plus the blueprintActiveByWindow bookkeeping.
 *
 * ensureBlueprintScript and toggleInspect are exercised by their own test suites
 * (content-script-injection.test.ts; toggleInspect's own exclusivity in handlers/inspect.ts is out
 * of scope here) — this file only asserts layout.ts calls them correctly and applies the
 * mutual-exclusivity rule documented at layout.ts:14-18/36-38.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setSwContext } from '../sw-context';
import type { InspectorMessage } from '../types';

const ensureBlueprintScript = vi.fn();
const ensureContentScript = vi.fn();
vi.mock('../tab-awareness', () => ({
  ensureBlueprintScript: (...a: unknown[]) => ensureBlueprintScript(...a),
  ensureContentScript: (...a: unknown[]) => ensureContentScript(...a),
}));

const toggleInspect = vi.fn();
vi.mock('../handlers/inspect', () => ({
  toggleInspect: (...a: unknown[]) => toggleInspect(...a),
}));

interface Harness {
  ctx: any;
  panelMsgs: InspectorMessage[];
  tabMessagesSent: Array<{ tabId: number; msg: unknown }>;
}

function makeHarness(overrides: { inspectActiveWindows?: Set<number> } = {}): Harness {
  const panelMsgs: InspectorMessage[] = [];
  const tabMessagesSent: Array<{ tabId: number; msg: unknown }> = [];
  const inspectActiveWindows = overrides.inspectActiveWindows ?? new Set<number>();

  (globalThis as any).chrome = {
    tabs: {
      query: vi.fn(async () => [{ id: 100 }]),
      get: vi.fn(async (tabId: number) => ({ id: tabId, windowId: 1 })),
      sendMessage: vi.fn((_tabId: number, msg: unknown) => {
        tabMessagesSent.push({ tabId: _tabId, msg });
        return Promise.resolve();
      }),
    },
    windows: {
      getLastFocused: vi.fn(async () => ({ id: 1 })),
    },
  };

  const ctx: any = {
    client: null,
    blueprintActiveByWindow: new Map<number, boolean>(),
    blueprintTabByWindow: new Map<number, number>(),
    isInspectActive: vi.fn((windowId: number | undefined) => windowId != null && inspectActiveWindows.has(windowId)),
    logActivity: vi.fn(),
    sendToPanelByWindow: vi.fn((_w: number, m: InspectorMessage) => panelMsgs.push(m)),
    settings: { activeProfileId: 'p1' },
  };
  setSwContext(ctx);
  return { ctx, panelMsgs, tabMessagesSent };
}

beforeEach(() => {
  // NOTE: deliberately NOT calling vi.resetModules() — layout.ts's handlers read the shared
  // SwContext singleton (sw-context.ts) via getCtx(). Resetting the module registry per test would
  // re-evaluate sw-context.ts too, disconnecting the statically-imported setSwContext() above from
  // the fresh instance getCtx() would read inside a freshly re-imported handlers/layout. Dynamic
  // `import(...)` below is therefore just a cache hit after the first test — register() is
  // idempotent (overwrites by type), so re-"importing" is safe and matches the pattern in
  // objects-discovered.test.ts.
  ensureBlueprintScript.mockClear();
  ensureContentScript.mockClear();
  toggleInspect.mockClear();
});

describe('INJECT_BLUEPRINT handler', () => {
  it('injects content-blueprint.js into the sender tab when senderTabId is present', async () => {
    makeHarness();
    const { getHandler } = await import('../handler-registry');
    await import('../handlers/layout');
    const entry = getHandler('INJECT_BLUEPRINT');
    expect(entry).toBeDefined();

    await entry!({ type: 'INJECT_BLUEPRINT' } as any, () => {}, { senderTabId: 42, isOneShot: true });

    expect(ensureBlueprintScript).toHaveBeenCalledTimes(1);
    expect(ensureBlueprintScript).toHaveBeenCalledWith(42);
  });

  it('is a no-op when senderTabId is missing', async () => {
    makeHarness();
    const { getHandler } = await import('../handler-registry');
    await import('../handlers/layout');
    const entry = getHandler('INJECT_BLUEPRINT');

    await entry!({ type: 'INJECT_BLUEPRINT' } as any, () => {}, { isOneShot: true });

    expect(ensureBlueprintScript).not.toHaveBeenCalled();
  });
});

describe('BLUEPRINT_RESUME handler', () => {
  it('when inspect is active in the tab\'s window: turns inspect off (exclusivity) then sets blueprint ON pinned to the sender tab', async () => {
    const h = makeHarness({ inspectActiveWindows: new Set([1]) });
    const { getHandler } = await import('../handler-registry');
    await import('../handlers/layout');
    const entry = getHandler('BLUEPRINT_RESUME');
    expect(entry).toBeDefined();

    await entry!({ type: 'BLUEPRINT_RESUME' } as any, () => {}, { senderTabId: 55, isOneShot: true });

    // chrome.tabs.get(55) resolved windowId 1; inspect was active there → toggleInspect(1) called
    // BEFORE blueprint is switched on (exclusivity).
    expect(toggleInspect).toHaveBeenCalledWith(1);
    expect(h.ctx.blueprintActiveByWindow.get(1)).toBe(true);
    // Pinned to the tab that reloaded (senderTabId), not "the window's active tab" — setBlueprintActive
    // was given tabId=55 explicitly, so it never needed chrome.tabs.query to resolve one.
    expect(h.ctx.blueprintTabByWindow.get(1)).toBe(55);
    expect((globalThis as any).chrome.tabs.query).not.toHaveBeenCalled();
    const toggleOrder = toggleInspect.mock.invocationCallOrder[0];
    const sendOrder = ((globalThis as any).chrome.tabs.sendMessage as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    expect(toggleOrder).toBeLessThan(sendOrder);
  });

  it('when inspect is NOT active: skips toggleInspect and just sets blueprint on', async () => {
    const h = makeHarness({ inspectActiveWindows: new Set() });
    const { getHandler } = await import('../handler-registry');
    await import('../handlers/layout');
    const entry = getHandler('BLUEPRINT_RESUME');

    await entry!({ type: 'BLUEPRINT_RESUME' } as any, () => {}, { senderTabId: 55, isOneShot: true });

    expect(toggleInspect).not.toHaveBeenCalled();
    expect(h.ctx.blueprintActiveByWindow.get(1)).toBe(true);
  });

  it('is a no-op when senderTabId is missing', async () => {
    makeHarness();
    const { getHandler } = await import('../handler-registry');
    await import('../handlers/layout');
    const entry = getHandler('BLUEPRINT_RESUME');

    await entry!({ type: 'BLUEPRINT_RESUME' } as any, () => {}, { isOneShot: true });

    expect(toggleInspect).not.toHaveBeenCalled();
    expect((globalThis as any).chrome.tabs.get).not.toHaveBeenCalled();
  });
});

describe('toggleBlueprint', () => {
  it('turning blueprint ON in a window where inspect is active turns inspect off first, then marks blueprint on', async () => {
    const h = makeHarness({ inspectActiveWindows: new Set([1]) });
    const { toggleBlueprint } = await import('../handlers/layout');

    await toggleBlueprint(1);

    expect(toggleInspect).toHaveBeenCalledWith(1);
    expect(h.ctx.blueprintActiveByWindow.get(1)).toBe(true);
    const toggleOrder = toggleInspect.mock.invocationCallOrder[0];
    const sendOrder = ((globalThis as any).chrome.tabs.sendMessage as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    expect(toggleOrder).toBeLessThan(sendOrder);
  });

  it('turning blueprint ON in a window where inspect is inactive does not touch inspect', async () => {
    const h = makeHarness({ inspectActiveWindows: new Set() });
    const { toggleBlueprint } = await import('../handlers/layout');

    await toggleBlueprint(1);

    expect(toggleInspect).not.toHaveBeenCalled();
    expect(h.ctx.blueprintActiveByWindow.get(1)).toBe(true);
  });

  it('toggling again turns blueprint back off (no exclusivity check on the way off)', async () => {
    const h = makeHarness({ inspectActiveWindows: new Set([1]) });
    const { toggleBlueprint } = await import('../handlers/layout');

    await toggleBlueprint(1); // on
    toggleInspect.mockClear();
    await toggleBlueprint(1); // off

    expect(h.ctx.blueprintActiveByWindow.get(1)).toBe(false);
    expect(toggleInspect).not.toHaveBeenCalled();
  });

  it('with no windowId argument, resolves the last-focused window', async () => {
    const h = makeHarness();
    const { toggleBlueprint } = await import('../handlers/layout');

    await toggleBlueprint();

    expect((globalThis as any).chrome.windows.getLastFocused).toHaveBeenCalled();
    expect(h.ctx.blueprintActiveByWindow.get(1)).toBe(true); // getLastFocused mock resolves {id:1}
  });

  it('setBlueprintActive is idempotent — a no-op re-set to the same state does not re-broadcast', async () => {
    const h = makeHarness();
    const { setBlueprintActive } = await import('../handlers/layout');

    await setBlueprintActive(1, true); // map starts empty (undefined !== true) — real transition
    expect(h.ctx.sendToPanelByWindow).toHaveBeenCalledTimes(1);
    h.ctx.sendToPanelByWindow.mockClear();

    await setBlueprintActive(1, true); // already true — true no-op, no re-broadcast
    expect(h.ctx.sendToPanelByWindow).not.toHaveBeenCalled();
  });
});
