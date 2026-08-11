// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActivityEntry, InspectorMessage } from '../../lib/types';
import { S } from '../state';
import {
  createPanelOrchestrator,
  type PanelOrchestratorHost,
  type PanelOrchestratorServices,
  type PanelTabId,
} from '../panel-orchestrator';
import type { Tab } from '../tabs/tab-types';

interface Harness {
  trace: string[];
  host: PanelOrchestratorHost;
  services: PanelOrchestratorServices;
  panels: Record<PanelTabId, HTMLElement>;
}

function tab(id: PanelTabId, trace: string[], changed = true): Tab {
  return {
    handleMessage: vi.fn(() => {
      trace.push(`handle:${id}:${S.cacheCount}`);
      return changed;
    }),
    render: vi.fn(() => { trace.push(`render:${id}`); }),
    activate: vi.fn(() => { trace.push(`activate:${id}`); }),
    deactivate: vi.fn(() => { trace.push(`deactivate:${id}`); }),
  };
}

function harness(): Harness {
  const trace: string[] = [];
  const app = document.createElement('main');
  document.body.replaceChildren(app);
  const ids: PanelTabId[] = ['connect', 'workshop', 'objects', 'ai', 'log'];
  const panels = Object.fromEntries(ids.map(id => {
    const panel = document.createElement('section');
    panel.dataset.tab = id;
    app.appendChild(panel);
    return [id, panel];
  })) as Record<PanelTabId, HTMLElement>;

  const tabs = Object.fromEntries(ids.map(id => [id, tab(id, trace)])) as Record<PanelTabId, Tab>;
  const logTab = Object.assign(tabs.log, {
    showWorkStatus: vi.fn(() => { trace.push('work-status'); }),
  });
  const aiTab = Object.assign(tabs.ai, {
    submitHandoff: vi.fn(() => { trace.push('ai-handoff'); }),
  });
  const workshopTab = Object.assign(tabs.workshop, {
    resetContext: vi.fn(() => { trace.push('reset:workshop'); }),
    isPickingContext: vi.fn(() => false),
    consumePick: vi.fn(),
    openLayoutFor: vi.fn(),
  });

  const host: PanelOrchestratorHost = {
    app,
    tabs,
    logTab,
    aiTab,
    workshopTab,
    detailView: { isActive: () => false, refresh: vi.fn() },
    getActivePanel: () => panels[S.activeTab as PanelTabId] ?? null,
    getTabPanel: id => panels[id],
    persistActiveTab: id => { trace.push(`persist:${id}`); },
    showSelectedTab: id => { trace.push(`show:${id}`); },
    renderActiveTab: () => { trace.push(`render-active:${S.activeTab}`); },
    ensureAiTab: () => { trace.push('ensure-ai'); },
    syncAiTab: () => { trace.push('sync-ai'); },
    navigateToDetail: rid => { trace.push(`detail:${rid}`); },
    updateToggle: () => { trace.push('chrome:toggle'); },
    updateObjectsBadge: () => { trace.push(`chrome:badge:${S.cacheCount}`); },
    updateContextPill: () => { trace.push('chrome:context'); },
    updateLatencyPill: () => { trace.push('chrome:latency'); },
    updatePaintButton: () => { trace.push('chrome:paint'); },
    showPaintError: error => { trace.push(`paint-error:${error}`); },
    updateHeaderStatus: () => { trace.push('chrome:header'); },
    refreshStatusStrip: () => { trace.push('chrome:strip'); },
    updateStatusBar: () => { trace.push('chrome:status'); },
    refreshSiteAccessStrip: () => { trace.push('chrome:access'); },
  };

  const services: PanelOrchestratorServices = {
    routeAccessMessage: vi.fn(() => false),
    isReferenceActive: vi.fn(() => false),
    handleReferenceMessage: vi.fn(() => false),
    showReferenceView: vi.fn(),
    showToast: vi.fn(() => { trace.push('toast'); }),
    onColorSetsData: vi.fn(),
    resetColorSets: vi.fn(() => { trace.push('reset:colors'); }),
    dispatchBroadcast: vi.fn(() => { trace.push(`broadcast:${S.cacheCount}`); return 0; }),
  };

  return { trace, host, services, panels };
}

describe('PanelOrchestrator', () => {
  beforeEach(() => {
    S.activeTab = 'connect';
    S.cacheCount = 0;
    S.context = null;
    S.page = null;
    S.detailRid = null;
    S.settings = { ...S.settings, activeProfileId: 'current' };
  });

  it('reduces shared state before the active tab and publishes last', () => {
    const h = harness();
    const panel = createPanelOrchestrator(h.host, h.services);

    panel.accept({ type: 'CACHE_STATS', count: 7 });

    expect(h.trace).toEqual([
      'chrome:badge:7',
      'handle:connect:7',
      'render:connect',
      'chrome:status',
      'broadcast:7',
    ]);
  });

  it('keeps claims terminal and ahead of tab delivery and subscribers', () => {
    const h = harness();
    vi.mocked(h.services.isReferenceActive).mockReturnValue(true);
    vi.mocked(h.services.handleReferenceMessage).mockImplementation(() => {
      h.trace.push('reference-claim');
      return true;
    });
    const panel = createPanelOrchestrator(h.host, h.services);

    panel.accept({ type: 'TOAST', text: 'claimed', kind: 'info' });

    expect(h.trace).toEqual(['reference-claim']);
    expect(h.services.showToast).not.toHaveBeenCalled();
    expect(h.services.dispatchBroadcast).not.toHaveBeenCalled();
  });

  it('gives Access Trace first claim precedence', () => {
    const h = harness();
    vi.mocked(h.services.routeAccessMessage).mockImplementation(() => {
      h.trace.push('access-claim');
      return true;
    });
    vi.mocked(h.services.isReferenceActive).mockReturnValue(true);
    const panel = createPanelOrchestrator(h.host, h.services);

    panel.accept({ type: 'ACCESS_SUBJECTS_DATA', subjects: [], canTrace: true });

    expect(h.trace).toEqual(['work-status', 'access-claim']);
    expect(h.services.handleReferenceMessage).not.toHaveBeenCalled();
  });

  it('observes work before a message is claimed', () => {
    const h = harness();
    vi.mocked(h.services.isReferenceActive).mockReturnValue(true);
    vi.mocked(h.services.handleReferenceMessage).mockImplementation(() => {
      h.trace.push('reference-claim');
      return true;
    });
    const panel = createPanelOrchestrator(h.host, h.services);

    panel.accept({ type: 'FETCH_OBJECT_PANE', rid: '9223372036854775807' });

    expect(h.trace).toEqual(['work-status', 'reference-claim']);
  });

  it('refreshes an ordinary tab only when it becomes active', () => {
    const h = harness();
    const panel = createPanelOrchestrator(h.host, h.services);

    panel.accept({ type: 'INSPECT_STATE', active: true });
    expect(h.host.tabs.objects.handleMessage).not.toHaveBeenCalled();

    h.trace.length = 0;
    panel.selectTab('objects');
    expect(h.trace).toEqual([
      'persist:objects',
      'deactivate:connect',
      'activate:objects',
      'show:objects',
      'render-active:objects',
    ]);
  });

  it('keeps Log live while hidden and renders it only while selected', () => {
    const h = harness();
    const panel = createPanelOrchestrator(h.host, h.services);
    const entry: ActivityEntry = {
      id: 1,
      time: 1,
      level: 'success',
      message: 'Saved',
    };

    panel.accept({ type: 'ACTIVITY_ENTRY', entry });
    expect(h.host.tabs.log.handleMessage).toHaveBeenCalledTimes(1);
    expect(h.host.tabs.log.render).not.toHaveBeenCalled();
    expect(h.host.tabs.connect.handleMessage).not.toHaveBeenCalled();

    panel.selectTab('log');
    h.trace.length = 0;
    panel.accept({ type: 'ACTIVITY_ENTRY', entry });
    expect(h.host.tabs.log.handleMessage).toHaveBeenCalledTimes(2);
    expect(h.trace.filter(item => item === 'render:log')).toHaveLength(1);
  });

  it('keeps AI live without double-delivery when AI is selected', () => {
    const h = harness();
    const panel = createPanelOrchestrator(h.host, h.services);
    const msg: InspectorMessage = { type: 'AI_EDITOR_CONTEXT', source: null };

    panel.accept(msg);
    expect(h.host.tabs.ai.handleMessage).toHaveBeenCalledTimes(1);
    expect(h.host.tabs.ai.render).not.toHaveBeenCalled();

    panel.selectTab('ai');
    panel.accept(msg);
    expect(h.host.tabs.ai.handleMessage).toHaveBeenCalledTimes(2);
    expect(h.host.tabs.ai.render).toHaveBeenCalledTimes(1);
  });

  it('delivers owner-critical results while their tab is hidden without rendering it', () => {
    const h = harness();
    const panel = createPanelOrchestrator(h.host, h.services);

    panel.accept({ type: 'APPLY_CHANGES_RESULT', rid: '9223372036854775807', ok: true });
    panel.accept({ type: 'AI_TEST_RESULT', ok: true, ms: 12 });

    expect(h.host.tabs.workshop.handleMessage).toHaveBeenCalledTimes(1);
    expect(h.host.tabs.workshop.render).not.toHaveBeenCalled();
    expect(h.host.tabs.connect.handleMessage).toHaveBeenCalledTimes(1);
    expect(h.host.tabs.connect.render).toHaveBeenCalledTimes(1);
  });

  it('invalidates shared profile state before live and active surfaces', () => {
    const h = harness();
    S.context = { rid: '9223372036854775807' };
    S.page = { rid: '9007199254740993' };
    S.detailRid = '9223372036854775807';
    vi.mocked(h.host.tabs.ai.handleMessage).mockImplementation(() => {
      h.trace.push(`handle:ai:context=${String(S.context)}`);
      return true;
    });
    vi.mocked(h.host.tabs.connect.handleMessage).mockImplementation(() => {
      h.trace.push(`handle:connect:context=${String(S.context)}`);
      return true;
    });
    const panel = createPanelOrchestrator(h.host, h.services);

    panel.accept({ type: 'PROFILE_SWITCHED', profileId: 'next', label: 'Next' });

    expect(S.context).toBeNull();
    expect(S.page).toBeNull();
    expect(S.detailRid).toBeNull();
    expect(h.trace).toContain('handle:ai:context=null');
    expect(h.trace).toContain('handle:connect:context=null');
    expect(h.host.tabs.workshop.handleMessage).toHaveBeenCalledTimes(1);
    expect(h.host.tabs.objects.handleMessage).toHaveBeenCalledTimes(1);
    expect(h.host.tabs.log.handleMessage).toHaveBeenCalledTimes(1);
    expect(h.trace.at(-1)).toBe('broadcast:0');
  });

  it('rejects a late environment-bound result from the previous profile', () => {
    const h = harness();
    const panel = createPanelOrchestrator(h.host, h.services);
    panel.accept({ type: 'PROFILE_SWITCHED', profileId: 'next', label: 'Next' });
    vi.clearAllMocks();

    panel.accept({
      type: 'PROPERTY_APPLICATIONS_RESULT',
      rid: '42',
      ok: true,
      environment: 'current@https://old.example',
    });

    expect(h.host.tabs.workshop.handleMessage).not.toHaveBeenCalled();
    expect(h.services.dispatchBroadcast).not.toHaveBeenCalled();
  });
});
