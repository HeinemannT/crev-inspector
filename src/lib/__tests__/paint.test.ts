/**
 * Tests for src/lib/paint.ts — paint format pick/apply, prop diff.
 *
 * Covers:
 * - handlePaintPick stores source RID + name → broadcasts 'applying' state
 * - handlePaintApply with no source → broadcasts apply-failure
 * - handlePaintApply with source → reads both objects via EC, computes diff,
 *   broadcasts PAINT_PREVIEW with only changed props
 * - cancelPaint resets phase + source
 * - The exact set of style props painted (PAINT_STYLE_PROPS)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockChromeStorage } from './chrome-mock';
import { setSwContext } from '../sw-context';
import { ObjectCache } from '../object-cache';
import { PAINT_STYLE_PROPS, PAINT_PROP_RESET } from '../types';
import type { InspectorMessage, InspectorSettings } from '../types';

interface PaintHarness {
  ctx: any;
  cache: ObjectCache;
  panelMsgs: InspectorMessage[];
  broadcasts: InspectorMessage[];
  executeEcMock: ReturnType<typeof vi.fn>;
  resolveRefMock: ReturnType<typeof vi.fn>;
  resolveTemplateMock: ReturnType<typeof vi.fn>;
}

async function createPaintHarness(opts?: { withClient?: boolean }): Promise<PaintHarness> {
  mockChromeStorage();
  const cache = new ObjectCache();
  const panelMsgs: InspectorMessage[] = [];
  const broadcasts: InspectorMessage[] = [];

  const executeEcMock = vi.fn();
  const resolveRefMock = vi.fn(async (rid: string) => `lookup(${rid})`);
  const resolveTemplateMock = vi.fn(async () => ({ templateRid: null }));

  const client = opts?.withClient === false ? null : {
    executeEc: executeEcMock,
    resolveRef: resolveRefMock,
    resolveTemplate: resolveTemplateMock,
  };

  const ctx = {
    client,
    hasPanel: false,
    panelPortByWindow: new Map(),
    contentPorts: new Map(),
    cache,
    settings: {
      schemaVersion: 1,
      profiles: [{ id: 'p1', label: 'P1', bmpUrl: 'https://bmp.test/', bmpUser: 'a', bmpPass: 'b' }],
      activeProfileId: 'p1',
      autoDetect: true,
      saveTarget: 'instance' as const,
      enrichMode: 'all' as const,
      paintProps: ['headerColor', 'fontColor', 'transparency', 'shadow', 'headerStyle', 'borderStyle', 'showToolMenu', 'disableSearch'],
    } satisfies InspectorSettings,
    inspectActive: true,
    technicalOverlay: false,
    settingsReady: Promise.resolve(),
    logActivity: vi.fn(),
    sendToPanel: vi.fn((m: InspectorMessage) => panelMsgs.push(m)),
    sendToPanelByWindow: vi.fn(),
    sendToPanelByTab: vi.fn(),
    broadcastToContent: vi.fn((m: InspectorMessage) => broadcasts.push(m)),
    toast: vi.fn(),
  };
  setSwContext(ctx as any);

  return { ctx, cache, panelMsgs, broadcasts, executeEcMock, resolveRefMock, resolveTemplateMock };
}

describe('paint — pick', () => {
  let h: PaintHarness;

  beforeEach(async () => {
    h = await createPaintHarness();
    // Reset module state — paint.ts holds module-level state
    const { cancelPaint } = await import('../paint');
    cancelPaint();
    // Clear broadcasts captured during cancelPaint
    h.panelMsgs.length = 0;
    h.broadcasts.length = 0;
  });

  it('stores source RID + name from cache and broadcasts applying state', async () => {
    const now = Date.now();
    h.cache.putAll([
      { rid: '111', source: 'server', businessId: 'sc_main', type: 'Scorecard', name: 'Main SC', discoveredAt: now, updatedAt: now },
    ]);

    const { handlePaintPick } = await import('../paint');
    handlePaintPick('111');

    // Broadcasts PAINT_STATE with phase=applying, sourceRid=111, sourceName=Main SC (name preferred)
    const paintStateMsgs = [
      ...h.panelMsgs.filter((m: any) => m.type === 'PAINT_STATE'),
      ...h.broadcasts.filter((m: any) => m.type === 'PAINT_STATE'),
    ];
    expect(paintStateMsgs.length).toBeGreaterThan(0);
    const last = paintStateMsgs[paintStateMsgs.length - 1] as any;
    expect(last.phase).toBe('applying');
    expect(last.sourceRid).toBe('111');
    expect(last.sourceName).toBe('Main SC');
  });

  it('falls back to businessId when cached name is missing', async () => {
    const now = Date.now();
    h.cache.putAll([
      { rid: '222', source: 'server', businessId: 'sc_fallback', type: 'Scorecard', discoveredAt: now, updatedAt: now },
    ]);

    const { handlePaintPick } = await import('../paint');
    handlePaintPick('222');

    const last = h.panelMsgs.filter((m: any) => m.type === 'PAINT_STATE').pop() as any;
    expect(last.sourceName).toBe('sc_fallback');
  });

  it('falls back to RID when cache has nothing useful', async () => {
    const { handlePaintPick } = await import('../paint');
    handlePaintPick('333');

    const last = h.panelMsgs.filter((m: any) => m.type === 'PAINT_STATE').pop() as any;
    expect(last.sourceRid).toBe('333');
    expect(last.sourceName).toBe('333');
  });
});

describe('paint — apply', () => {
  let h: PaintHarness;

  beforeEach(async () => {
    h = await createPaintHarness();
    const { cancelPaint } = await import('../paint');
    cancelPaint();
    h.panelMsgs.length = 0;
    h.broadcasts.length = 0;
  });

  it('with no source picked, broadcasts apply failure with clear error', async () => {
    const { handlePaintApply } = await import('../paint');
    await handlePaintApply('999');

    const errs = h.broadcasts.filter((m: any) => m.type === 'PAINT_APPLY_RESULT');
    expect(errs.length).toBe(1);
    const err = errs[0] as any;
    expect(err.ok).toBe(false);
    expect(err.error).toBe('No source selected');
    // Should NOT have called EC
    expect(h.executeEcMock).not.toHaveBeenCalled();
  });

  it('with no client connected, broadcasts apply failure with connect hint', async () => {
    const h2 = await createPaintHarness({ withClient: false });
    const { handlePaintApply } = await import('../paint');
    await handlePaintApply('999');

    const errs = h2.broadcasts.filter((m: any) => m.type === 'PAINT_APPLY_RESULT');
    expect(errs.length).toBe(1);
    expect((errs[0] as any).ok).toBe(false);
    expect((errs[0] as any).error).toMatch(/Not connected/);
  });

  it('with source picked, applies styles to the target via a committed EC write and broadcasts success', async () => {
    // Pick source first
    const { handlePaintPick, handlePaintApply } = await import('../paint');
    handlePaintPick('111');
    h.broadcasts.length = 0;
    h.panelMsgs.length = 0;

    h.executeEcMock.mockResolvedValueOnce({ ok: true });

    await handlePaintApply('222');

    // Instant apply: a single committed EC write (no preview round-trip).
    expect(h.executeEcMock).toHaveBeenCalledTimes(1);
    const [ecCode, , commit] = h.executeEcMock.mock.calls[0] as [string, unknown, boolean];
    expect(commit, 'apply must commit (executeEc commit flag)').toBe(true);

    // References every painted prop.
    for (const prop of PAINT_STYLE_PROPS) {
      expect(ecCode).toContain(prop);
    }

    // Broadcasts a success result — no PAINT_PREVIEW any more.
    const results = h.broadcasts.filter((m: any) => m.type === 'PAINT_APPLY_RESULT') as any[];
    expect(results.length).toBe(1);
    expect(results[0].ok).toBe(true);
    expect(h.broadcasts.some((m: any) => m.type === 'PAINT_PREVIEW')).toBe(false);
  });

  it('only writes the props selected in settings.paintProps', async () => {
    const { handlePaintPick, handlePaintApply } = await import('../paint');
    // Narrow the selection to just headerColor (right-click menu behaviour).
    h.ctx.settings.paintProps = ['headerColor'];
    handlePaintPick('111');
    h.broadcasts.length = 0;

    h.executeEcMock.mockResolvedValueOnce({ ok: true });
    await handlePaintApply('222');

    const ecCode = h.executeEcMock.mock.calls.at(-1)?.[0] as string;
    expect(ecCode).toContain('headerColor');
    // Deselected props must not appear.
    expect(ecCode).not.toContain('fontColor');
    expect(ecCode).not.toContain('headerStyle');
    expect(ecCode).not.toContain('borderStyle');
  });

  it('with no styles selected, broadcasts a failure and writes nothing', async () => {
    const { handlePaintPick, handlePaintApply } = await import('../paint');
    h.ctx.settings.paintProps = [];
    handlePaintPick('111');
    h.broadcasts.length = 0;

    await handlePaintApply('222');

    expect(h.executeEcMock).not.toHaveBeenCalled();
    const errs = h.broadcasts.filter((m: any) => m.type === 'PAINT_APPLY_RESULT') as any[];
    expect(errs.length).toBe(1);
    expect(errs[0].ok).toBe(false);
    expect(errs[0].error).toMatch(/No styles selected/);
  });

  it('apply when the EC write fails broadcasts apply failure', async () => {
    const { handlePaintPick, handlePaintApply } = await import('../paint');
    handlePaintPick('111');
    h.broadcasts.length = 0;

    h.executeEcMock.mockResolvedValueOnce({
      ok: false,
      error: 'EC failed',
    });

    await handlePaintApply('222');

    const errs = h.broadcasts.filter((m: any) => m.type === 'PAINT_APPLY_RESULT');
    expect(errs.length).toBe(1);
    expect((errs[0] as any).ok).toBe(false);
  });
});

describe('paint — PAINT_STYLE_PROPS contract', () => {
  it('contains exactly the documented style props', () => {
    // The documented paintable set: appearance props + the two portal-chrome FLAGS (tools menu /
    // search). Visibility + the shownOn* trio stay non-paintable (painting "hidden" is a footgun).
    expect([...PAINT_STYLE_PROPS]).toEqual([
      'headerColor', 'fontColor', 'transparency', 'shadow', 'headerStyle', 'borderStyle',
      'showToolMenu', 'disableSearch',
    ]);
  });

  it('paint apply emits one assignment per style prop (colours clear when source has none)', async () => {
    const h = await createPaintHarness();
    const { cancelPaint, handlePaintPick, handlePaintApply } = await import('../paint');
    cancelPaint();
    handlePaintPick('111');
    h.broadcasts.length = 0;

    // Stub the committed EC apply — return success
    h.executeEcMock.mockResolvedValue({ ok: true });

    await handlePaintApply('222');

    const lastCallCode = h.executeEcMock.mock.calls.at(-1)?.[0] as string;
    expect(lastCallCode).toBeDefined();
    // Each prop: copy the source value when present, else reset with the
    // TYPE-CORRECT empty (PAINT_PROP_RESET — colour:"" / number:0 / bool:FALSE
    // / enum:"None"). All branches live-verified; `:= ""` errors on number/enum
    // props so the reset must be type-aware.
    for (const prop of PAINT_STYLE_PROPS) {
      const reset = PAINT_PROP_RESET[prop];
      expect(lastCallCode).toContain(`IF _src.${prop} != MISSING THEN _tgt.change(${prop} := _src.${prop}) ELSE _tgt.change(${prop} := ${reset}) ENDIF`);
    }
  });
});

describe('paint — cancelPaint', () => {
  it('clears paint state when active and broadcasts off state', async () => {
    const h = await createPaintHarness();
    const { handlePaintPick, cancelPaint } = await import('../paint');

    handlePaintPick('111');
    h.broadcasts.length = 0;
    h.panelMsgs.length = 0;

    cancelPaint();

    // Should broadcast PAINT_STATE with phase=off
    const offStateMsgs = h.panelMsgs.filter((m: any) => m.type === 'PAINT_STATE' && m.phase === 'off');
    expect(offStateMsgs.length).toBeGreaterThan(0);
    expect((offStateMsgs[0] as any).sourceRid).toBeUndefined();
  });

  it('is a no-op when paint phase is already off', async () => {
    const h = await createPaintHarness();
    const { cancelPaint } = await import('../paint');
    // Initial state is 'off' (or set to off by previous cancel)
    cancelPaint();
    h.broadcasts.length = 0;
    h.panelMsgs.length = 0;

    cancelPaint();
    // No broadcasts when already off
    expect(h.broadcasts.filter((m: any) => m.type === 'PAINT_STATE')).toHaveLength(0);
    expect(h.panelMsgs.filter((m: any) => m.type === 'PAINT_STATE')).toHaveLength(0);
  });

  // The SW wires `onProfileSwitch(cancelPaint)` so a workspace change (manual
  // SET_ACTIVE_PROFILE or auto-detect) cancels an armed brush — a source RID
  // from the old workspace can't resolve in the new one. This locks the
  // contract that cancelPaint is a valid profile-switch listener: firing the
  // listener chain resets an armed brush. (A plain tab switch does NOT cancel
  // — that path no longer calls cancelPaint, enabling cross-page paint.)
  it('an armed brush is reset when a profile-switch listener fires (workspace change)', async () => {
    const h = await createPaintHarness();
    const { handlePaintPick, cancelPaint, paintStateMessage } = await import('../paint');
    const { onProfileSwitch, fireProfileSwitch } = await import('../settings');

    onProfileSwitch(() => cancelPaint()); // mirror the SW wiring
    handlePaintPick('111');
    expect(paintStateMessage()).toMatchObject({ phase: 'applying', sourceRid: '111' });

    h.panelMsgs.length = 0;
    fireProfileSwitch('some-other-workspace');

    expect(paintStateMessage()).toMatchObject({ phase: 'off', sourceRid: undefined });
    expect(h.panelMsgs.some((m: any) => m.type === 'PAINT_STATE' && m.phase === 'off')).toBe(true);
  });
});

describe('paint — connect re-sync (paintStateMessage / pushPaintState)', () => {
  it('paintStateMessage reflects the live phase + source (for pushing on (re)connect)', async () => {
    await createPaintHarness(); // sets the SW context (side-effect)
    const { cancelPaint, handlePaintPick, paintStateMessage } = await import('../paint');
    cancelPaint();
    expect(paintStateMessage()).toEqual({ type: 'PAINT_STATE', phase: 'off', sourceRid: undefined, sourceName: undefined });
    handlePaintPick('111');
    expect(paintStateMessage()).toMatchObject({ type: 'PAINT_STATE', phase: 'applying', sourceRid: '111' });
  });

  it('pushPaintState sends the state to the panel even when off (corrects a stale "armed" panel after SW reset)', async () => {
    const h = await createPaintHarness();
    const { cancelPaint, pushPaintState } = await import('../paint');
    cancelPaint();
    h.panelMsgs.length = 0;
    pushPaintState();
    const off = h.panelMsgs.filter((m: any) => m.type === 'PAINT_STATE' && m.phase === 'off');
    expect(off.length).toBe(1);
  });
});

describe('paint — cancelPaintForTab (navigation / refresh)', () => {
  it('cancels when armed but no tab was recorded — the stuck-after-refresh case', async () => {
    const h = await createPaintHarness();
    const { cancelPaint, handlePaintPick, cancelPaintForTab } = await import('../paint');
    cancelPaint();
    // Arm via pick (handlePaintPick does not record a tab, mirroring the
    // real bug: paint active but no active-tab association yet).
    handlePaintPick('111');
    h.broadcasts.length = 0;
    h.panelMsgs.length = 0;

    cancelPaintForTab(42);

    const off = [...h.panelMsgs, ...h.broadcasts]
      .filter((m: any) => m.type === 'PAINT_STATE' && m.phase === 'off');
    expect(off.length).toBeGreaterThan(0);
  });

  it('is a no-op when paint is off', async () => {
    const h = await createPaintHarness();
    const { cancelPaint, cancelPaintForTab } = await import('../paint');
    cancelPaint();
    h.broadcasts.length = 0;
    h.panelMsgs.length = 0;

    cancelPaintForTab(7);
    expect(h.broadcasts.filter((m: any) => m.type === 'PAINT_STATE')).toHaveLength(0);
    expect(h.panelMsgs.filter((m: any) => m.type === 'PAINT_STATE')).toHaveLength(0);
  });
});
