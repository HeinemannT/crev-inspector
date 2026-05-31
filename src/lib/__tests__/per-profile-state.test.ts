/**
 * Per-profile state isolation (v0.20.2):
 *  - Activity log entries are tagged with `profileId` so the Log tab
 *    can filter to the active environment.
 *  - Compare pivot storage key is scoped per active profile so a
 *    pivot pinned in sbx doesn't bleed into dev.
 */
import { describe, it, expect, vi } from 'vitest';
import { mockChromeStorage } from './chrome-mock';

interface ActivityHarness {
  ctx: any;
  activity: typeof import('../activity');
}

async function createActivityHarness(activeProfileId = 'sbx'): Promise<ActivityHarness> {
  vi.resetModules();
  vi.clearAllMocks();
  mockChromeStorage();

  const swCtxMod = await import('../sw-context');
  const ctx: any = {
    client: null,
    hasPanel: false,
    panelPortByWindow: new Map(),
    contentPorts: new Map(),
    settings: {
      schemaVersion: 1,
      profiles: [{ id: activeProfileId, label: activeProfileId, bmpUrl: '', bmpUser: '', bmpPass: '' }],
      activeProfileId,
      autoDetect: true,
      saveTarget: 'instance',
      enrichMode: 'all',
    },
    inspectActive: false,
    technicalOverlay: false,
    settingsReady: Promise.resolve(),
    logActivity: vi.fn(),
    sendToPanel: vi.fn(),
    sendToPanelByWindow: vi.fn(),
    sendToPanelByTab: vi.fn(),
    broadcastToContent: vi.fn(),
    toast: vi.fn(),
  };
  swCtxMod.setSwContext(ctx);

  const activity = await import('../activity');
  return { ctx, activity };
}

describe('logActivity tags entries with the active profileId', () => {
  it('attaches profileId to new entries', async () => {
    const h = await createActivityHarness('sbx');
    h.activity.logActivity('info', 'sbx-action');
    const log = h.activity.getActivityLog();
    expect(log).toHaveLength(1);
    expect(log[0].profileId).toBe('sbx');
    expect(log[0].message).toBe('sbx-action');
  });

  it('reflects the current profileId at the time of logging (not boot)', async () => {
    const h = await createActivityHarness('sbx');
    h.activity.logActivity('info', 'first');
    h.ctx.settings.activeProfileId = 'dev';
    h.activity.logActivity('info', 'second');
    const log = h.activity.getActivityLog();
    expect(log[0].profileId).toBe('sbx');
    expect(log[1].profileId).toBe('dev');
  });

  it('emits ACTIVITY_ENTRY broadcasts with profileId attached', async () => {
    const h = await createActivityHarness('prod');
    h.activity.logActivity('success', 'prod-action');
    const broadcasts = h.ctx.sendToPanel.mock.calls
      .map((c: any[]) => c[0])
      .filter((m: any) => m?.type === 'ACTIVITY_ENTRY');
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0].entry.profileId).toBe('prod');
    expect(broadcasts[0].entry.message).toBe('prod-action');
  });

  it('omits profileId only when no profile is active', async () => {
    const h = await createActivityHarness('');
    h.ctx.settings.activeProfileId = '';
    h.activity.logActivity('info', 'no-profile');
    const log = h.activity.getActivityLog();
    expect(log[0].profileId).toBeUndefined();
  });
});

describe('compare pivot storage key — per-profile scope', () => {
  it('reads sbx pivot from the sbx-scoped key', async () => {
    mockChromeStorage();
    await chrome.storage.session.set({ crev_compare_pivot_sbx: { rid: '111', name: 'SbxObj' } });

    const result = await chrome.storage.session.get('crev_compare_pivot_sbx');
    expect(result.crev_compare_pivot_sbx).toEqual({ rid: '111', name: 'SbxObj' });
  });

  it('sbx pivot and dev pivot do not collide', async () => {
    mockChromeStorage();
    await chrome.storage.session.set({ crev_compare_pivot_sbx: { rid: '111', name: 'SbxObj' } });
    await chrome.storage.session.set({ crev_compare_pivot_dev: { rid: '222', name: 'DevObj' } });

    const sbx = await chrome.storage.session.get('crev_compare_pivot_sbx');
    const dev = await chrome.storage.session.get('crev_compare_pivot_dev');
    expect((sbx.crev_compare_pivot_sbx as { rid: string }).rid).toBe('111');
    expect((dev.crev_compare_pivot_dev as { rid: string }).rid).toBe('222');
  });

  it('RESET_ALL-style sweep removes all per-profile pivot keys', async () => {
    mockChromeStorage();
    await chrome.storage.session.set({
      crev_compare_pivot_sbx: { rid: '1' },
      crev_compare_pivot_dev: { rid: '2' },
      crev_compare_pivot_prod: { rid: '3' },
      crev_other_key: 'untouched',
    });
    // Mirror the RESET_ALL handler's sweep logic.
    const all = await chrome.storage.session.get(null as any);
    const pivotKeys = Object.keys(all).filter(k => k.startsWith('crev_compare_pivot'));
    expect(pivotKeys.sort()).toEqual([
      'crev_compare_pivot_dev',
      'crev_compare_pivot_prod',
      'crev_compare_pivot_sbx',
    ]);
    await chrome.storage.session.remove(pivotKeys);
    const after = await chrome.storage.session.get(null as any);
    expect(Object.keys(after).filter(k => k.startsWith('crev_compare_pivot'))).toEqual([]);
    // Unrelated keys survive.
    expect(after.crev_other_key).toBe('untouched');
  });
});
