/**
 * Side-panel consequence owner.
 *
 * Both inbound transports and every tab transition enter here.  The public
 * interface is deliberately small; the implementation owns the ordering
 * between claims, shared state, always-live tabs, the visible tab, panel
 * chrome, and broadcast subscribers.
 */

import type { InspectorMessage } from '../lib/types';
import { dispatchBroadcast } from '../lib/handler-registry';
import { routeAccessMessage } from './access-trace';
import {
  handleReferenceMessage,
  isReferenceActive,
  showReferenceView,
} from './reference-view';
import { onColorSetsData, resetColorSets } from './color-picker';
import { showToast } from '../lib/toast';
import { contextFromData } from './context-state';
import { workStatusForMessage, type WorkStatus } from './work-status';
import { S } from './state';
import type { Tab } from './tabs/tab-types';

export type PanelTabId = 'connect' | 'workshop' | 'objects' | 'ai' | 'log';

interface LiveLogTab extends Tab {
  showWorkStatus(status: WorkStatus): void;
}

interface LiveAiTab extends Tab {
  submitHandoff(
    text: Extract<InspectorMessage, { type: 'AI_CHAT_HANDOFF' }>['text'],
    quote: Extract<InspectorMessage, { type: 'AI_CHAT_HANDOFF' }>['quote'],
    envelope: Extract<InspectorMessage, { type: 'AI_CHAT_HANDOFF' }>['envelope'],
  ): void;
}

interface WorkshopTab extends Tab {
  resetContext(): void;
  isPickingContext?(): boolean;
  consumePick(
    rid: string,
    name?: string,
    type?: string,
    businessId?: string,
    panel?: HTMLElement,
  ): void;
  openLayoutFor(rid: string, highlightRid?: string): void;
}

interface DetailSurface {
  isActive(): boolean;
  refresh(panel: HTMLElement): void;
}

export interface PanelOrchestratorHost {
  readonly app: HTMLElement;
  readonly tabs: Record<PanelTabId, Tab>;
  readonly logTab: LiveLogTab;
  readonly aiTab: LiveAiTab;
  readonly workshopTab: WorkshopTab;
  readonly detailView: DetailSurface;

  getActivePanel(): HTMLElement | null;
  getTabPanel(tab: PanelTabId): HTMLElement | null;
  persistActiveTab(tab: PanelTabId): void;
  showSelectedTab(tab: PanelTabId): void;
  renderActiveTab(): void;

  ensureAiTab(): void;
  syncAiTab(): void;
  navigateToDetail(rid: string): void;

  updateToggle(): void;
  updateObjectsBadge(): void;
  updateContextPill(): void;
  updateLatencyPill(): void;
  updatePaintButton(): void;
  showPaintError(error: string): void;
  updateHeaderStatus(): void;
  refreshStatusStrip(): void;
  updateStatusBar(): void;
  refreshSiteAccessStrip(): void;
}

export interface PanelOrchestratorServices {
  routeAccessMessage(msg: InspectorMessage): boolean;
  isReferenceActive(): boolean;
  handleReferenceMessage(msg: InspectorMessage, panel: HTMLElement): boolean;
  showReferenceView(
    msg: Extract<InspectorMessage, { type: 'SEARCH_REFERENCES' }>,
    panel: HTMLElement,
  ): void;
  showToast(text: string, kind: Extract<InspectorMessage, { type: 'TOAST' }>['kind']): void;
  onColorSetsData(sets: Extract<InspectorMessage, { type: 'COLOR_SETS_DATA' }>['sets']): void;
  resetColorSets(): void;
  dispatchBroadcast(msg: InspectorMessage): number;
}

const defaultServices: PanelOrchestratorServices = {
  routeAccessMessage,
  isReferenceActive,
  handleReferenceMessage,
  showReferenceView,
  showToast,
  onColorSetsData,
  resetColorSets,
  dispatchBroadcast,
};

export interface PanelOrchestrator {
  accept(msg: InspectorMessage): void;
  selectTab(tab: PanelTabId): void;
}

interface SharedConsequences {
  headerChanged: boolean;
  forceActiveRender: boolean;
}

const AI_LIVE_MESSAGES = new Set<InspectorMessage['type']>([
  'AI_CHAT_EVENT',
  'AI_EDITOR_CONTEXT',
  'AI_CONFIG_CHANGED',
  'PROFILE_SWITCHED',
]);

export function createPanelOrchestrator(
  host: PanelOrchestratorHost,
  services: PanelOrchestratorServices = defaultServices,
): PanelOrchestrator {
  const selectTab = (tab: PanelTabId): void => {
    const previous = S.activeTab as PanelTabId;
    S.activeTab = tab;
    host.persistActiveTab(tab);

    host.tabs[previous]?.deactivate();
    host.tabs[tab]?.activate();
    host.showSelectedTab(tab);
    host.renderActiveTab();
  };

  const claimMessage = (msg: InspectorMessage): boolean => {
    if (
      (msg.type === 'ACCESS_SUBJECTS_DATA' || msg.type === 'ACCESS_TRACE_RESULT')
      && services.routeAccessMessage(msg)
    ) {
      return true;
    }

    if (services.isReferenceActive()) {
      const panel = host.getActivePanel();
      if (panel && services.handleReferenceMessage(msg, panel)) return true;
    }

    if (msg.type === 'SEARCH_REFERENCES') {
      const panel = host.getActivePanel();
      if (panel) services.showReferenceView(msg, panel);
      return true;
    }

    if (msg.type === 'TOAST') {
      services.showToast(msg.text, msg.kind);
      return true;
    }

    if (msg.type === 'AI_CHAT_HANDOFF') {
      host.ensureAiTab();
      selectTab('ai');
      host.aiTab.submitHandoff(msg.text, msg.quote, msg.envelope);
      return true;
    }

    return false;
  };

  const reduceSharedState = (msg: InspectorMessage): SharedConsequences => {
    let headerChanged = false;
    let forceActiveRender = false;

    switch (msg.type) {
      case 'INSPECT_STATE':
        S.inspectActive = msg.active;
        host.updateToggle();
        break;
      case 'BLUEPRINT_STATE':
        S.blueprintActive = msg.active;
        host.updateToggle();
        break;
      case 'CACHE_STATS':
        S.cacheCount = msg.count;
        host.updateObjectsBadge();
        break;
      case 'SETTINGS_DATA':
        S.settings = msg.settings;
        headerChanged = true;
        if (!S.settings.ai && S.activeTab === 'ai') selectTab('connect');
        host.syncAiTab();
        host.refreshSiteAccessStrip();
        break;
      case 'CONNECTION_STATE':
        S.connState = msg.state;
        headerChanged = true;
        host.updateToggle();
        host.updateLatencyPill();
        break;
      case 'DETECTION_STATE':
        S.bmpDetected = msg.phase === 'detected' ? true : msg.phase === 'not-detected' ? false : null;
        headerChanged = true;
        break;
      case 'PAGE_INFO':
        if (msg.detection) {
          S.bmpDetected = msg.detection.isBmp;
          headerChanged = true;
        }
        S.page = msg.rid
          ? {
              rid: msg.rid,
              ...(msg.tabRid ? { tabRid: msg.tabRid } : {}),
              ...(msg.tabName ? { tabName: msg.tabName } : {}),
            }
          : null;
        break;
      case 'CONTEXT_RID_DATA':
        S.context = contextFromData(S.context, msg);
        host.updateContextPill();
        break;
      case 'OBJECT_PANE_DATA':
        if ('instance' in msg && msg.instance?.rid) {
          const instance = msg.instance;
          S.context = {
            rid: instance.rid,
            name: instance.name,
            type: instance.type,
            businessId: instance.businessId,
          };
          host.updateContextPill();
        }
        break;
      case 'COLOR_SETS_DATA':
        services.onColorSetsData(msg.sets);
        break;
      case 'EC_RESULT':
        if ('durationMs' in msg && typeof msg.durationMs === 'number') {
          S.lastEcMs = msg.durationMs;
          host.updateLatencyPill();
        }
        break;
      case 'PROFILE_SWITCHED':
        headerChanged = true;
        S.context = null;
        S.page = null;
        S.detailRid = null;
        host.workshopTab.resetContext();
        services.resetColorSets();
        host.updateContextPill();
        forceActiveRender = true;
        break;
      case 'FAVORITES_DATA':
        S.favoriteEntries = msg.entries;
        if (host.detailView.isActive()) {
          const panel = host.getTabPanel('workshop');
          const detailContainer = panel?.querySelector<HTMLElement>('.workshop-detail');
          if (detailContainer) host.detailView.refresh(detailContainer);
        }
        break;
      case 'PAINT_STATE':
        S.paintPhase = msg.phase;
        S.paintSourceName = msg.sourceName ?? null;
        host.updatePaintButton();
        break;
      case 'PAINT_APPLY_RESULT':
        host.updatePaintButton();
        if (!msg.ok && msg.error) host.showPaintError(msg.error);
        break;
      case 'SELECT_OBJECT':
        if ('rid' in msg) {
          if (host.workshopTab.isPickingContext?.() && S.activeTab === 'workshop') {
            host.workshopTab.consumePick(
              msg.rid,
              undefined,
              undefined,
              undefined,
              host.getActivePanel() ?? undefined,
            );
          } else {
            host.navigateToDetail(msg.rid);
          }
        }
        break;
      case 'OPEN_LAYOUT_FOR':
        if ('rid' in msg) {
          host.workshopTab.openLayoutFor(msg.rid, msg.highlightRid);
          selectTab('workshop');
        }
        break;
      case 'AI_CONFIG_CHANGED':
        S.settings = {
          ...S.settings,
          ai: msg.configured
            ? {
                provider: msg.provider ?? S.settings.ai?.provider ?? 'anthropic',
                model: msg.model ?? '',
                apiKeyEnc: 'set',
                ...(msg.customProvider
                  ? { customProvider: msg.customProvider }
                  : S.settings.ai?.customProvider
                    ? { customProvider: S.settings.ai.customProvider }
                    : {}),
              }
            : undefined,
        };
        if (!msg.configured && S.activeTab === 'ai') selectTab('connect');
        host.syncAiTab();
        break;
    }

    return { headerChanged, forceActiveRender };
  };

  const deliver = (tabId: PanelTabId, msg: InspectorMessage): boolean => {
    const tab = host.tabs[tabId];
    const changed = tab.handleMessage(msg);
    if (!changed || S.activeTab !== tabId) return false;
    const panel = host.getActivePanel();
    if (panel && host.app.contains(panel)) tab.render(panel);
    return changed;
  };

  const accept = (msg: InspectorMessage): void => {
    const workStatus = workStatusForMessage(msg);
    if (workStatus) host.logTab.showWorkStatus(workStatus);

    if (claimMessage(msg)) return;

    const consequences = reduceSharedState(msg);
    const delivered = new Set<PanelTabId>();
    let liveOnly = false;

    if (msg.type === 'ACTIVITY_LOG' || msg.type === 'ACTIVITY_ENTRY') {
      deliver('log', msg);
      delivered.add('log');
      liveOnly = true;
    }
    if (AI_LIVE_MESSAGES.has(msg.type)) {
      deliver('ai', msg);
      delivered.add('ai');
      if (msg.type !== 'PROFILE_SWITCHED') liveOnly = true;
    }

    const activeTab = S.activeTab as PanelTabId;
    if (!liveOnly && !delivered.has(activeTab)) deliver(activeTab, msg);
    if (consequences.forceActiveRender) host.renderActiveTab();

    if (consequences.headerChanged) {
      host.updateHeaderStatus();
      host.refreshStatusStrip();
      host.updateStatusBar();
    }
    if (msg.type === 'ACTIVITY_ENTRY' || msg.type === 'CACHE_STATS') {
      host.updateStatusBar();
    }

    services.dispatchBroadcast(msg);
  };

  return { accept, selectTab };
}
