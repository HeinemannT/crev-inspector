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
import { PAINT_STYLE_PROPS, COLOR_LINK_PROPS } from '../types';
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

  it('with source picked, reads style props from both source + target via EC', async () => {
    // Pick source first
    const { handlePaintPick, handlePaintApply } = await import('../paint');
    handlePaintPick('111');
    h.broadcasts.length = 0;
    h.panelMsgs.length = 0;

    // EC returns "SRC|||sv1|||sv2|||...\nTGT|||tv1|||tv2|||..."
    // 6 source values, 6 target values (only headerColor differs)
    h.executeEcMock.mockResolvedValueOnce({
      ok: true,
      log: 'SRC|||#ff0000|||#000|||0|||true|||SOLID|||SOLID\nTGT|||#00ff00|||#000|||0|||true|||SOLID|||SOLID',
    });

    await handlePaintApply('222');

    // EC was called exactly once for comparison
    expect(h.executeEcMock).toHaveBeenCalledTimes(1);
    const ecCode = h.executeEcMock.mock.calls[0][0] as string;

    // EC code references all PAINT_STYLE_PROPS
    for (const prop of PAINT_STYLE_PROPS) {
      expect(ecCode).toContain(`.${prop}`);
    }

    // PAINT_PREVIEW broadcast contains only the changed prop
    const preview = h.broadcasts.find((m: any) => m.type === 'PAINT_PREVIEW') as any;
    expect(preview).toBeDefined();
    expect(preview.rid).toBe('222');
    expect(preview.diff).toHaveLength(1);
    expect(preview.diff[0].prop).toBe('headerColor');
    expect(preview.diff[0].from).toBe('#00ff00');
    expect(preview.diff[0].to).toBe('#ff0000');
  });

  it('apply with all identical props emits an empty-diff preview (no changes)', async () => {
    const { handlePaintPick, handlePaintApply } = await import('../paint');
    handlePaintPick('111');
    h.broadcasts.length = 0;

    // Identical SRC + TGT
    h.executeEcMock.mockResolvedValueOnce({
      ok: true,
      log: 'SRC|||a|||b|||c|||d|||e|||f\nTGT|||a|||b|||c|||d|||e|||f',
    });

    await handlePaintApply('222');

    const preview = h.broadcasts.find((m: any) => m.type === 'PAINT_PREVIEW') as any;
    expect(preview).toBeDefined();
    expect(preview.diff).toHaveLength(0);
  });

  it('apply when EC read fails broadcasts apply failure', async () => {
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
    // The documented list (paint.ts comment + types.ts export):
    //   headerColor, fontColor, transparency, shadow, headerStyle, borderStyle
    expect([...PAINT_STYLE_PROPS]).toEqual([
      'headerColor', 'fontColor', 'transparency', 'shadow', 'headerStyle', 'borderStyle',
    ]);
  });

  it('paint apply executes one assignment per style prop', async () => {
    const h = await createPaintHarness();
    const { cancelPaint, handlePaintPick, handlePaintConfirm } = await import('../paint');
    cancelPaint();
    handlePaintPick('111');
    h.broadcasts.length = 0;

    // Stub the EC call done by executePaintApply — return success
    h.executeEcMock.mockResolvedValue({ ok: true });

    await handlePaintConfirm('222');

    const lastCallCode = h.executeEcMock.mock.calls.at(-1)?.[0] as string;
    expect(lastCallCode).toBeDefined();
    // Value props copy via whenMissing(""); colour props (CorpoColor LINKS)
    // copy the link conditionally so "" is never assigned to a colour ref.
    for (const prop of PAINT_STYLE_PROPS) {
      if (COLOR_LINK_PROPS.has(prop)) {
        expect(lastCallCode).toContain(`IF _src.${prop} != MISSING THEN _tgt.change(${prop} := _src.${prop}) ENDIF`);
      } else {
        expect(lastCallCode).toContain(`${prop} := _src.${prop}.whenMissing("")`);
      }
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
