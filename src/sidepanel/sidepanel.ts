/**
 * Side panel orchestrator — boot, tab routing, header/status rendering.
 * Tabs are self-contained components (Tab interface). This module:
 * - Updates shared state (S.connState, S.settings, etc.)
 * - Routes messages to active tab's handleMessage()
 * - Manages header, status strip, status bar, paint button
 */

import type { InspectorMessage } from '../lib/types';
import { PAINT_STYLE_PROPS } from '../lib/types';
import { h, render, svg } from '../lib/dom';
import { delegate } from './delegate';
import { log } from '../lib/logger';
import { ICON_REFRESH, ICON_APERTURE, ICON_SEARCH, ICON_CROSSHAIR, ICON_BLUEPRINT } from './utils';
import { ICON_TERMINAL_WINDOW, ICON_PAINT_BROAD, ICON_PULSE } from '../lib/icons';
import { DetailView } from './detail-view';
import { onColorSetsData, resetColorSets } from './color-picker';
import { initReferenceView, showReferenceView, handleReferenceMessage, isReferenceActive } from './reference-view';
import { S, sendMessage, getActivePanel, getTabPanel, tabPanelId, onPortMessage, onReconnect, connectPanel } from './state';
import { dispatchBroadcast } from '../lib/handler-registry';
import { routeAccessMessage, initAccessTrace } from './access-trace';
import { showProfileSwitcher } from './profile-switcher';
import { renderSiteAccessStrip, refreshSiteAccessStrip } from './site-access-strip';
import type { Tab } from './tabs/tab-types';
import { ConnectTab } from './tabs/connect-tab';
import { ObjectsTab } from './tabs/objects-tab';
import { LogTab } from './tabs/log-tab';
import { WorkshopTab } from './tabs/workshop-tab';
import { AiTab } from './tabs/ai-tab';
import { showToast } from '../lib/toast';
import { contextFromData } from './context-state';

// ── Tab instances ────────────────────────────────────────────────

const app = document.getElementById('app')!;

// Function declaration — hoisted so the tab constructors below can capture it.
// The closure reaches `tabs` / `detailView`, which are declared below; safe
// because the function is never invoked during module init, only from later
// user interactions (tab clicks, etc.).
function navigateToDetail(rid: string) {
  // Resolve a cached object so DetailView's first render has identity
  // info; falls back to a DOM-source placeholder if no tab has it.
  let obj = null;
  for (const tab of Object.values(tabs)) {
    obj = tab.findObject?.(rid) ?? null;
    if (obj) break;
  }
  if (!obj) {
    obj = { rid, source: 'dom' as const, discoveredAt: Date.now(), updatedAt: Date.now() };
  }
  S.detailRid = rid;
  // Footer context = the object being inspected. Set from the cached hint
  // now; OBJECT_PANE_DATA upgrades it with the authoritative identity once
  // the fetch lands.
  S.context = { rid, name: obj.name, type: obj.type, businessId: obj.businessId };
  updateContextPill();

  // Workshop hosts the detail view in its bottom half. If the user
  // is elsewhere, switch first; either way load the object. Drilling
  // when DetailView is already populated preserves the back-history.
  const switching = S.activeTab !== 'workshop';
  if (switching) switchTab('workshop');
  const panel = getActivePanel();
  if (!panel) return;
  const asDrillDown = !switching && detailView.isActive();
  (tabs.workshop as WorkshopTab).loadObject(obj, panel, asDrillDown);
}

const detailView = new DetailView(
  () => {
    // Back-out-of-history collapses to "ready for next selection" —
    // render Workshop's empty-state in the bottom half, top half
    // stays as-is.
    S.detailRid = null;
    // Footer mirrors the inspected object — nothing open ⇒ no context.
    S.context = null;
    updateContextPill();
    const panel = getActivePanel();
    if (panel && S.activeTab === 'workshop') {
      (tabs.workshop as WorkshopTab).clear(panel);
    }
  },
  sendMessage,
  // "Layout ↗" — primes Workshop's layout half with the given rid
  // (with optional highlight) and ensures Workshop is the active tab.
  (rid: string, highlightRid?: string) => {
    (tabs.workshop as WorkshopTab).openLayoutFor(rid, highlightRid);
    switchTab('workshop');
  },
);

const tabs: Record<string, Tab> = {
  connect: new ConnectTab(sendMessage),
  workshop: new WorkshopTab(sendMessage, navigateToDetail, detailView),
  objects: new ObjectsTab(sendMessage, navigateToDetail),
  ai: new AiTab(sendMessage),
  log: new LogTab(sendMessage),
};
const aiTab = tabs.ai as AiTab;

/** The AI tab is present ONLY when a provider key is configured (zero-footprint).
 *  `S.settings.ai` exists iff a key was saved (the session snapshot keeps the
 *  provider even with the key stripped). Kept in sync via AI_CONFIG_CHANGED. */
let aiEnabled = false;
function computeAiEnabled(): boolean { return !!S.settings.ai; }

const logTab = tabs.log as LogTab;
logTab.onActivityChange(() => updateStatusBar());

initReferenceView(
  () => renderActiveTab(),
  navigateToDetail,
  sendMessage,
);

// ── Message routing ──────────────────────────────────────────────

// The Access Trace overlay reaches the SW through the panel's port send.
initAccessTrace(sendMessage);

onPortMessage((msg: InspectorMessage) => {
  // Access-trace overlay claims its own responses regardless of active tab.
  if ((msg.type === 'ACCESS_SUBJECTS_DATA' || msg.type === 'ACCESS_TRACE_RESULT') && routeAccessMessage(msg)) return;

  // Reference view gets first crack (code search results)
  if (isReferenceActive()) {
    const panel = getActivePanel();
    if (panel && handleReferenceMessage(msg, panel)) return;
  }

  // Open reference view on SEARCH_REFERENCES
  if (msg.type === 'SEARCH_REFERENCES') {
    const panel = getActivePanel();
    if (panel) showReferenceView(msg, panel);
    return;
  }

  // Ephemeral toast: short-lived top-right notification, independent of
  // any tab. We render here (rather than per-tab) so the user sees the
  // toast regardless of where focus is. The activity log still gets a
  // permanent entry — SW.toast() mirrors both.
  if (msg.type === 'TOAST') {
    showToast(msg.text, msg.kind);
    return;
  }

  // Ctrl+Shift+Y close half: the SW has no API to close the side panel,
  // so when the shortcut fires while the panel is already open it
  // sends CLOSE_PANEL — we close ourselves via window.close().
  if (msg.type === 'CLOSE_PANEL') {
    window.close();
    return;
  }

  // Command-strip handoff (arrives on the port via ctx.sendToPanel, surviving
  // panel startup via pendingPanelMessages — same path as SELECT_OBJECT). Make
  // sure the AI tab exists, switch to it, and submit the strip's message as a
  // turn (with its via-strip eyebrow + quoted code).
  if (msg.type === 'AI_CHAT_HANDOFF') {
    if (!aiEnabled) {
      aiEnabled = true;
      app.querySelector('.tab-bar')?.replaceWith(buildTabBar());
      app.querySelector('.tab-content')?.replaceWith(buildTabContent());
    }
    switchTab('ai');
    aiTab.submitHandoff(msg.text, msg.quote, msg.envelope);
    return;
  }

  // Shared state updates
  let headerChanged = false;
  switch (msg.type) {
    case 'INSPECT_STATE':
      S.inspectActive = msg.active;
      updateToggle();
      break;
    case 'BLUEPRINT_STATE':
      S.blueprintActive = msg.active;
      updateToggle();
      break;
    case 'CACHE_STATS':
      S.cacheCount = msg.count;
      updateObjectsBadge();
      break;
    case 'SETTINGS_DATA':
      S.settings = msg.settings;
      headerChanged = true;
      syncAiTab(); // full settings may add/remove the AI tab (key configured?)
      void refreshSiteAccessStrip(); // profile (server origin) may have changed
      break;
    case 'CONNECTION_STATE':
      S.connState = msg.state;
      headerChanged = true;
      updateLatencyPill();
      break;
    case 'DETECTION_STATE':
      // Track whether the ACTIVE tab is BMP so the header reflects the page, not just the profile
      // session. 'checking'/'unknown' leave it null (don't flip the header mid-navigation). Breaks
      // through to the per-tab forwarding below, so the Workshop pane still gets it.
      S.bmpDetected = msg.phase === 'detected' ? true : msg.phase === 'not-detected' ? false : null;
      headerChanged = true;
      break;
    case 'PAGE_INFO':
      // PAGE_INFO carries the same detection verdict; keep the header's page-state in sync on every refresh.
      if (msg.detection) { S.bmpDetected = msg.detection.isBmp; headerChanged = true; }
      break;
    case 'CONTEXT_RID_DATA':
      // Canonical page/selection context from the SW. This is global panel
      // state, not a Workshop-only concern: the status chip and AI envelope
      // must update even when the AI or Connect tab is currently active.
      S.context = contextFromData(S.context, msg);
      updateContextPill();
      break;
    case 'OBJECT_PANE_DATA':
      // The footer context chip tracks the object currently open in the
      // Workshop detail editor — so "footer context" and "object detail"
      // are always the same thing. (Page context — scorecard/tab — lives in
      // the Workshop context strip, not the footer.) This fires for the
      // initial load AND every drill-down/parent hop.
      if ('instance' in msg && msg.instance?.rid) {
        const i = msg.instance;
        S.context = { rid: i.rid, name: i.name, type: i.type, businessId: i.businessId };
        updateContextPill();
      }
      break;
    case 'COLOR_SETS_DATA':
      onColorSetsData(msg.sets);
      break;
    case 'EC_RESULT':
      // Surface user-action latency in the status bar — feels more honest
      // than the health-poll ping, which is just an HTTP roundtrip.
      if ('durationMs' in msg && typeof msg.durationMs === 'number') {
        S.lastEcMs = msg.durationMs;
        updateLatencyPill();
      }
      break;
    case 'PROFILE_SWITCHED':
      headerChanged = true;
      // Workspace changed — everything keyed by the old workspace's RIDs is
      // now stale. Clear the footer context + the inspected object, and reset
      // the Workshop's layout context (which re-detects in the new workspace).
      S.context = null;
      S.detailRid = null;
      (tabs.workshop as WorkshopTab).resetContext();
      // AI chat grounding is per-workspace — reset the transcript even when
      // the AI tab isn't active (the per-tab routing below only reaches the
      // active tab, which would leave a stale cross-workspace conversation).
      if (S.activeTab !== 'ai') aiTab.handleMessage(msg);
      // Colours are per-workspace — drop the panel's cached swatches so profile B
      // never shows profile A's colours (the linked-colour picker cache).
      resetColorSets();
      updateContextPill();
      renderActiveTab();
      break;
    case 'FAVORITES_DATA':
      S.favoriteEntries = msg.entries;
      // Re-render the detail view (specifically the header star) when
      // it's loaded — even if the user isn't currently looking at the
      // Inspect tab. When they switch back, the star should be in
      // sync without a fresh fetch. The Objects tab also picks up
      // favorites via its own handleMessage return-true below.
      if (detailView.isActive()) {
        const panel = getTabPanel('workshop');
        if (panel) {
          const detailContainer = panel.querySelector<HTMLElement>('.workshop-detail');
          if (detailContainer) detailView.refresh(detailContainer);
        }
      }
      break;
    case 'PAINT_STATE':
      S.paintPhase = msg.phase;
      S.paintSourceName = msg.sourceName ?? null;
      updatePaintButton();
      break;
    case 'PAINT_APPLY_RESULT':
      updatePaintButton();
      if (!msg.ok && msg.error) showPaintError(msg.error);
      break;
    case 'SELECT_OBJECT':
      if ('rid' in msg) {
        // Picker mode: Workshop's layout half has a crosshair that
        // arms a one-shot "pick context" mode. When armed AND the
        // user is on Workshop, the next SELECT_OBJECT becomes
        // "set context for the layout half" instead of "load in
        // detail half". Keeps both behaviours discoverable in one
        // tab without a separate Page surface.
        const workshopTab = tabs.workshop as WorkshopTab;
        if (workshopTab?.isPickingContext?.() && S.activeTab === 'workshop') {
          const panel = getActivePanel();
          workshopTab.consumePick(msg.rid, undefined, undefined, undefined, panel ?? undefined);
        } else {
          navigateToDetail(msg.rid);
        }
      }
      break;
    case 'OPEN_LAYOUT_FOR':
      // Cross-window jump from the popout's "Layout ↗" button.
      // Workshop already shows both layout + detail, so this just
      // primes the layout half's context + ensures Workshop is the
      // active tab.
      if ('rid' in msg) {
        (tabs.workshop as WorkshopTab).openLayoutFor(msg.rid, msg.highlightRid);
        switchTab('workshop');
      }
      break;
  }

  // The activity log is an independent surface — its in-memory state needs
  // to accumulate regardless of which panel tab is currently visible or
  // whether the detail view is open. Without this, GET_ACTIVITY responses
  // get dropped if the detail view is open at the moment the log tab
  // activates, and per-entry ACTIVITY_ENTRY broadcasts that arrive while
  // the user is on a different tab vanish into the void. Re-render only
  // when the log tab is actually visible.
  if (msg.type === 'ACTIVITY_LOG' || msg.type === 'ACTIVITY_ENTRY') {
    const logTabInstance = tabs.log;
    const changed = logTabInstance?.handleMessage(msg) ?? false;
    if (changed && S.activeTab === 'log') {
      const panel = getActivePanel();
      if (panel && document.body.contains(panel)) logTabInstance!.render(panel);
    }
  } else {
    // Other messages route to the active tab only. The Inspect tab
    // forwards to detailView.handleMessage internally.
    const activeTab = tabs[S.activeTab];
    if (activeTab) {
      const changed = activeTab.handleMessage(msg);
      if (changed) {
        const panel = getActivePanel();
        if (panel && document.body.contains(panel)) activeTab.render(panel);
      }
    }
  }

  if (headerChanged) {
    updateHeaderStatus();
    refreshStatusStrip();
    updateStatusBar();
  }

  // Status bar: activity text + cache count (updated after tab processes the message)
  if (msg.type === 'ACTIVITY_ENTRY' || msg.type === 'CACHE_STATS') {
    updateStatusBar();
  }

  // Broadcast subscribers run last — they're for feature modules that want
  // to listen to a message without owning routing precedence. Tabs and the
  // detail view still use the raw switch above (their routing depends on
  // the active surface); new features should prefer subscribe() in their
  // own module so the consumer is visible to grep.
  dispatchBroadcast(msg);
});

// On reconnect: re-request shared state, activate active tab
onReconnect(() => {
  sendMessage({ type: 'GET_CONNECTION_STATE' });
  sendMessage({ type: 'GET_SETTINGS' });
  sendMessage({ type: 'GET_DETECTION' }); // header's page-state (BMP vs not) for the active tab
  tabs[S.activeTab]?.activate();
});

connectPanel();

// ── Runtime broadcasts (NOT on the panel port) ───────────────────
// AI chat streams (AI_CHAT_EVENT), the AI config toggle (AI_CONFIG_CHANGED),
// and the editor-context signal (AI_EDITOR_CONTEXT) are broadcast by the SW /
// editor via chrome.runtime.sendMessage, which the panel port does NOT carry.
// This is the panel's only consumer of those broadcasts.
chrome.runtime.onMessage.addListener((msg: InspectorMessage) => {
  switch (msg.type) {
    case 'AI_CHAT_EVENT':
      aiTab.onChatEvent(msg);
      break;
    case 'AI_EDITOR_CONTEXT':
      aiTab.setEditorSource(msg.source);
      break;
    case 'AI_CONFIG_CHANGED': {
      // Mirror the change into shared settings so tab visibility + the chat
      // footer model reflect it, then add / remove the AI tab.
      S.settings = {
        ...S.settings,
        ai: msg.configured
          ? { provider: msg.provider ?? S.settings.ai?.provider ?? 'anthropic', model: msg.model ?? '', apiKeyEnc: 'set' }
          : undefined,
      };
      syncAiTab();
      if (aiEnabled && S.activeTab === 'ai') renderActiveTab();
      break;
    }
  }
  return undefined;
});

// ── Render ───────────────────────────────────────────────────────

/** Every tab that can exist, in bar order. Used for id/label lookups + the
 *  stored-active-tab validity check. The AI slot is only rendered when
 *  configured — see tabOrder(). */
const ALL_TABS = ['connect', 'workshop', 'objects', 'ai', 'log'] as const;

/** The tabs actually rendered right now: base four, plus AI (before Log) when
 *  a provider key is configured. */
function tabOrder(): string[] {
  return aiEnabled
    ? ['connect', 'workshop', 'objects', 'ai', 'log']
    : ['connect', 'workshop', 'objects', 'log'];
}

const TAB_LABELS: Record<string, string> = {
  connect: 'Connect', workshop: 'Inspect', objects: 'Browse', ai: 'AI', log: 'Log',
};
const TAB_TITLES: Record<string, string> = {
  connect: 'Server profiles',
  workshop: 'Layout + selected object detail: the configurator workspace',
  objects: 'Browse cached objects: search by RID, BID, or name',
  ai: 'Ask about your workspace: a tool-using AI chat grounded in your context',
  log: 'Activity feed',
};

function buildTabBar(): HTMLElement {
  return h('div', { class: 'tab-bar', role: 'tablist' },
    ...tabOrder().map(t => {
      const label = TAB_LABELS[t] ?? (t.charAt(0).toUpperCase() + t.slice(1));
      const badges: (HTMLElement | string | false | null)[] = [label];
      if (t === 'objects') {
        badges.push(h('span', { class: 'badge', id: 'objects-badge' }, String(S.cacheCount)));
      }
      if (t === 'workshop') {
        badges.push(h('span', {
          class: `inspect-dirty-dot${detailView.isDirty() ? ' active' : ''}`,
          id: 'inspect-dirty-dot',
          'aria-hidden': 'true',
          title: detailView.isDirty() ? 'You have unsaved changes on this object' : '',
        }));
      }
      return h('button', {
        class: `tab ${S.activeTab === t ? 'active' : ''}`,
        role: 'tab',
        'aria-selected': S.activeTab === t ? 'true' : 'false',
        'data-action': 'tab',
        'data-tab': t,
        title: TAB_TITLES[t] ?? '',
      }, ...badges);
    }),
  );
}

function buildTabContent(): HTMLElement {
  return h('div', { class: 'tab-content' },
    ...tabOrder().map(t =>
      h('div', { class: `tab-panel ${S.activeTab === t ? 'active' : ''}`, id: tabPanelId(t), role: 'tabpanel' }),
    ),
  );
}

/** Add / remove the AI tab live when the provider key is configured / cleared.
 *  Rebuilds the tab bar + content panels in place (cheap; the tab instances
 *  persist, so the chat transcript survives). */
function syncAiTab(): void {
  const wasEnabled = aiEnabled;
  aiEnabled = computeAiEnabled();
  if (aiEnabled === wasEnabled) return;
  // If the AI tab just vanished while it was active, fall back to Connect.
  if (!aiEnabled && S.activeTab === 'ai') S.activeTab = 'connect';
  const bar = app.querySelector('.tab-bar');
  const content = app.querySelector('.tab-content');
  if (bar) bar.replaceWith(buildTabBar());
  if (content) content.replaceWith(buildTabContent());
  renderActiveTab();
}

function buildApp(): void {
  const header = h('div', { class: 'header' },
    h('button', {
      class: 'header-brand',
      id: 'header-brand',
      title: 'CREV related links',
      'aria-label': 'CREV menu',
      'aria-haspopup': 'menu',
    },
      svg(ICON_APERTURE),
    ),
    h('div', { class: 'header-status', id: 'header-status', 'aria-live': 'polite' },
      h('span', { class: `status-dot ${statusDotClass()}` }),
      h('span', { class: 'header-label' }, statusText()),
    ),
    h('button', {
      class: 'header-icon-btn',
      id: 'open-codesearch',
      'aria-label': 'Code Search',
    }, svg(ICON_SEARCH)),
    h('button', {
      class: 'header-icon-btn',
      id: 'open-extended',
      'aria-label': 'Open Extended Code',
      title: 'Open the Extended Code editor',
    }, svg(ICON_TERMINAL_WINDOW)),
    h('span', { class: 'hdr-vsep', 'aria-hidden': 'true' }),
    // Page MODES — inspect / blueprint / paint are mutually toggleable states
    // on the live page, so they read as one segmented control, not three
    // scattered icons (T2 sign-off).
    h('div', { class: 'hdr-modes', role: 'group', 'aria-label': 'Page modes' },
      h('button', {
        class: `hdr-mode inspect-toggle ${S.inspectActive ? 'active' : ''}`,
        id: 'toggle-inspect',
        'aria-label': 'Toggle inspect overlays',
        'aria-pressed': S.inspectActive ? 'true' : 'false',
        title: 'Toggle inspect overlays (Ctrl+Shift+X: rebind at chrome://extensions/shortcuts)',
      }, svg(ICON_CROSSHAIR)),
      h('button', {
        class: `hdr-mode blueprint-toggle ${S.blueprintActive ? 'active' : ''}`,
        id: 'toggle-blueprint',
        'aria-label': 'Toggle blueprint layout overlay',
        'aria-pressed': S.blueprintActive ? 'true' : 'false',
        title: 'Toggle the blueprint layout editor overlay on the live BMP page',
      }, svg(ICON_BLUEPRINT)),
      h('button', {
        class: `hdr-mode paint-btn ${S.paintPhase !== 'off' ? 'active' : ''}`,
        id: 'toggle-paint',
        'aria-label': 'Paint Format',
        'aria-pressed': S.paintPhase !== 'off' ? 'true' : 'false',
        title: 'Right-click to choose which styles get painted',
      }, svg(ICON_PAINT_BROAD)),
    ),
  );

  const tabBar = buildTabBar();

  // 'needs-login' is recoverable in place (log into BMP, then retry), so it
  // gets the prominent Reconnect button alongside the hard-error states.
  const isError = ['unreachable', 'server-down', 'auth-failed', 'needs-login', 'no-config-access', 'needs-access'].includes(S.connState.display);
  // The connection strip lives ONLY on the Connect tab, and only when NOT cleanly connected — once
  // connected, each server row carries its own inline status, so the strip would just repeat it. It
  // stays for error/checking states because that's where the Reconnect/Test actions matter. (switchTab
  // toggles this `hidden` class; the strip stays mounted so its by-id refresh keeps working.)
  const showStrip = S.activeTab === 'connect' && S.connState.display !== 'connected';
  const statusStrip = h('div', { class: `status-strip ${statusStripClass()}${showStrip ? '' : ' hidden'}`, id: 'status-strip' },
    h('span', { class: `status-dot ${statusDotClass()}`, id: 'strip-dot' }),
    h('span', { class: 'status-strip-text', id: 'strip-text' }, statusStripText()),
    h('button', {
      class: `status-strip-reconnect ${isError ? '' : 'hidden'}`,
      id: 'strip-reconnect',
      'data-action': 'reconnect',
    }, 'Reconnect'),
    h('button', { class: 'status-strip-btn', 'data-action': 'test', title: 'Test connection' }, svg(ICON_REFRESH)),
  );

  // No sidebar paint status bar — during paint the user's focus is the page,
  // where the in-page banner is the HUD. The header paint button's active
  // state is the only sidebar signal needed.
  const tabContent = buildTabContent();

  // Cache count gets a label so the lone "0" in the corner isn't a mystery.
  // Hidden entirely when zero — nothing useful to surface yet.
  const cacheCountEl = S.cacheCount > 0
    ? h('div', { class: 'status-bar-count', title: `${S.cacheCount} objects cached` }, `${S.cacheCount} cached`)
    : null;
  const statusBar = h('div', { class: 'status-bar', id: 'status-bar', 'aria-live': 'polite' },
    h('div', { class: 'status-bar-connection', title: `Connection to BMP server: ${statusBarText()}` },
      h('span', { class: `status-dot ${statusDotClass()}` }),
      h('span', null, statusBarText()),
    ),
    h('div', { class: 'status-bar-activity', title: logTab.latestActivityMsg ? 'Latest activity: open Log tab for full history' : '' }, logTab.latestActivityMsg ?? ''),
    renderContextPill(),
    renderLatencyPill(),
    cacheCountEl,
  );

  // Feedback line — short confirmations (badge copies, saves) overlay the
  // status bar's right side for ~1.8s, then the quiet line returns.
  let flashTimer: ReturnType<typeof setTimeout> | null = null;
  document.addEventListener('crev:status-flash', (e) => {
    const bar = document.getElementById('status-bar');
    if (!bar) return;
    let el = bar.querySelector<HTMLElement>('.status-bar-flash');
    if (!el) { el = h('span', { class: 'status-bar-flash' }); bar.appendChild(el); }
    el.textContent = String((e as CustomEvent).detail ?? '');
    bar.classList.add('status-bar--flash');
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { bar.classList.remove('status-bar--flash'); }, 1800);
  });

  render(app, header, tabBar, renderSiteAccessStrip(), statusStrip, tabContent, statusBar);
  void refreshSiteAccessStrip();

  delegate(app, {
    tab: (el) => {
      const tabName = el.dataset.tab;
      if (tabName) switchTab(tabName);
    },
    test: () => {
      const btn = document.querySelector('#status-strip .status-strip-btn');
      if (btn) btn.classList.add('spinning');
      sendMessage({ type: 'CONNECTION_TEST' });
    },
    reconnect: () => sendMessage({ type: 'CONNECTION_TEST' }),
  });

  const paintBtn = app.querySelector('#toggle-paint');
  paintBtn?.addEventListener('click', () => sendMessage({ type: 'TOGGLE_PAINT' }));
  paintBtn?.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showPaintStyleMenu(e.currentTarget as HTMLElement);
  });
  app.querySelector('#toggle-inspect')?.addEventListener('click', () => sendMessage({ type: 'TOGGLE_INSPECT' }));
  app.querySelector('#toggle-blueprint')?.addEventListener('click', () => sendMessage({ type: 'BLUEPRINT_TOGGLE' }));
  app.querySelector('#open-extended')?.addEventListener('click', () => sendMessage({ type: 'OPEN_EXTENDED' }));
  app.querySelector('#open-codesearch')?.addEventListener('click', () => sendMessage({ type: 'OPEN_CODE_SEARCH' }));
  app.querySelector('#header-status')?.addEventListener('click', () => showProfileSwitcher());
  app.querySelector('#header-brand')?.addEventListener('click', (e) => showBrandMenu(e.currentTarget as HTMLElement));

  renderActiveTab();
}

function switchTab(tab: string) {
  const prev = S.activeTab;
  S.activeTab = tab;
  chrome.storage.session.set({ crev_active_tab: tab }).catch(e => log.swallow('panel:persistTab', e));

  // Deactivate previous, activate new
  tabs[prev]?.deactivate();
  tabs[tab]?.activate();

  // Update tab bar + panel visibility
  for (const btn of app.querySelectorAll<HTMLElement>('.tab[data-tab]')) {
    const isActive = btn.dataset.tab === tab;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-selected', String(isActive));
  }
  for (const panelName of tabOrder()) {
    const panel = getTabPanel(panelName);
    if (panel) panel.classList.toggle('active', panelName === tab);
  }
  // The connection strip is Connect-only (redundant elsewhere with the header + bottom bar).
  app.querySelector('#status-strip')?.classList.toggle('hidden', tab !== 'connect');

  renderActiveTab();
}

function renderActiveTab() {
  // Old overlay-era guard ("skip rendering tabs while detail is up")
  // is gone — the InspectTab IS a tab and renders normally. Other
  // tabs only render when active per the tab dispatcher.
  const tab = tabs[S.activeTab];
  const panel = getActivePanel();
  if (tab && panel) tab.render(panel);
}

// ── Header/Status helpers ────────────────────────────────────────

function updateToggle() {
  const btn = document.getElementById('toggle-inspect');
  if (btn) btn.className = `hdr-mode inspect-toggle ${S.inspectActive ? 'active' : ''}`;
  const bp = document.getElementById('toggle-blueprint');
  if (bp) bp.className = `hdr-mode blueprint-toggle ${S.blueprintActive ? 'active' : ''}`;
}

function updateObjectsBadge() {
  const badge = document.getElementById('objects-badge');
  if (badge) badge.textContent = String(S.cacheCount);
}

function statusDotClass(): string {
  switch (S.connState.display) {
    case 'connected': return 'ok';
    case 'online': return 'online';
    case 'needs-login': return 'warn';
    case 'unreachable': return S.connState.networkOffline ? 'warn' : 'fail';
    case 'server-down': case 'auth-failed': case 'no-config-access': return 'fail';
    case 'needs-access': return 'warn';
    case 'not-configured': case 'checking': return '';
    default: { const _e: never = S.connState.display; void _e; return ''; }
  }
}

/** The active tab is confidently NOT a BMP page, yet the profile session is up. "Connected · Steadfast"
 *  would misread as "this page is BMP", so the header leads with the page state instead. Only overrides
 *  the positive (connected/online) displays; real errors (auth-failed, server-down) still surface. */
function onNonBmpPage(): boolean {
  return S.bmpDetected === false && (S.connState.display === 'connected' || S.connState.display === 'online');
}

function statusText(): string {
  if (onNonBmpPage()) return 'Not a BMP page';
  switch (S.connState.display) {
    case 'not-configured': return 'No server';
    case 'checking': return 'Checking\u2026';
    case 'connected': return S.connState.profileLabel ?? 'Connected';
    case 'online': return 'Online';
    case 'needs-login': return 'Log into BMP';
    case 'no-config-access': return 'No config access';
    case 'auth-failed': return 'Auth failed';
    case 'server-down': return 'Server down';
    case 'unreachable': return S.connState.networkOffline ? 'No network' : 'Unreachable';
    case 'needs-access': return 'Grant access';
  }
}

function statusBarText(): string {
  if (onNonBmpPage()) return 'Not BMP';
  const d = S.connState.display;
  // Quiet-line rule: the green dot says "connected", so the text says WHICH
  // server — one fact, once.
  if (d === 'connected') return S.connState.profileLabel ?? 'Connected';
  if (d === 'server-down') return 'Down';
  return statusText();
}

function showPaintError(error: string) {
  // Errors surface as a toast — the dedicated sidebar paint bar is gone.
  showToast(error, 'error');
}

function updatePaintButton() {
  const btn = document.getElementById('toggle-paint');
  if (btn) btn.className = `hdr-mode paint-btn ${S.paintPhase !== 'off' ? 'active' : ''}`;
}

function statusStripClass(): string {
  if (onNonBmpPage()) return 'online';
  switch (S.connState.display) {
    case 'connected': return 'ok';
    case 'online': return 'online';
    case 'needs-login': return 'offline';
    case 'unreachable': return S.connState.networkOffline ? 'offline' : 'fail';
    case 'server-down': case 'auth-failed': case 'no-config-access': return 'fail';
    case 'needs-access': return 'warn';
    case 'not-configured': case 'checking': return '';
    default: { const _e: never = S.connState.display; void _e; return ''; }
  }
}

function statusStripText(): string {
  const s = S.connState;
  if (onNonBmpPage()) {
    return s.workspace
      ? `Not a BMP page. Still connected to ${s.workspace} for when you return.`
      : 'Not a BMP page.';
  }
  switch (s.display) {
    case 'not-configured': return 'No server configured';
    case 'checking': return 'Checking\u2026';
    case 'connected': {
      const parts: string[] = ['Connected'];
      if (s.profileLabel) parts[0] = s.profileLabel;
      if (s.workspace) parts.push(s.workspace);
      if (s.version) parts.push(`BMP ${s.version}`);
      if (s.authVia) parts.push(s.authVia === 'session' ? 'via browser session' : 'via stored login');
      return parts.join(' \u00b7 ');
    }
    case 'online': return 'Online (not authenticated)';
    case 'needs-login': return 'Not logged in. Open BMP in a tab, log in, then retry.';
    case 'no-config-access': return 'Logged in, but this user has no Configuration Access role.';
    case 'auth-failed': return 'Sign-in failed. Check the profile username and password.';
    case 'server-down': return 'Server down';
    case 'unreachable': return s.networkOffline ? 'No network' : 'Unreachable';
    case 'needs-access': return 'The extension needs site access to this BMP server. Grant it in the browser to connect.';
  }
}

function refreshStatusStrip() {
  const strip = document.getElementById('status-strip');
  if (!strip) return;
  // Keep the Connect-only + not-connected gate: a live status update must not un-hide the strip on
  // another tab, nor while cleanly connected (the rows carry status there).
  strip.className = `status-strip ${statusStripClass()}${S.activeTab === 'connect' && S.connState.display !== 'connected' ? '' : ' hidden'}`;
  const dot = document.getElementById('strip-dot');
  if (dot) dot.className = `status-dot ${statusDotClass()}`;
  const text = document.getElementById('strip-text');
  if (text) text.textContent = statusStripText();
  const reconnect = document.getElementById('strip-reconnect');
  if (reconnect) {
    // Only show Reconnect where a plain re-test can actually recover: the
    // network came back ('unreachable'), the server came back ('server-down'),
    // or the user logged into BMP in a tab ('needs-login', retry in place).
    // 'auth-failed' (wrong credentials) and 'no-config-access' (missing role)
    // can't be fixed by re-running the same auth — the button would be false
    // comfort, so the status text points at Edit profile / an admin instead.
    const canRetest = ['unreachable', 'server-down', 'needs-login'].includes(S.connState.display);
    reconnect.classList.toggle('hidden', !canRetest);
  }
  const btn = strip.querySelector('.status-strip-btn');
  if (btn) btn.classList.remove('spinning');
}

function updateHeaderStatus() {
  const container = document.getElementById('header-status');
  if (container) {
    const dot = container.querySelector('.status-dot');
    const label = container.querySelector('.header-label');
    if (dot) dot.className = `status-dot ${statusDotClass()}`;
    if (label) label.textContent = statusText();
  }
}

function updateStatusBar() {
  const bar = document.getElementById('status-bar');
  if (!bar) return;

  const conn = bar.querySelector('.status-bar-connection');
  if (conn) {
    const dot = conn.querySelector('.status-dot');
    const text = conn.querySelector('span:last-child');
    if (dot) dot.className = `status-dot ${statusDotClass()}`;
    if (text) text.textContent = statusBarText();
  }

  const activity = bar.querySelector('.status-bar-activity');
  if (activity) activity.textContent = logTab.latestActivityMsg ?? '';

  const count = bar.querySelector('.status-bar-count');
  if (count) count.textContent = String(S.cacheCount);

  updateContextPill();
  updateLatencyPill();
}

// ── Status bar: context + latency chips ───────────────────────────

/** Active-context chip — shows the current BMP context object so the user
 *  always sees what's selected, regardless of which panel tab is visible.
 *  Click jumps to the detail view. Hidden when there's nothing in context. */
function renderContextPill(): HTMLElement | null {
  const c = S.context;
  if (!c?.rid) return h('div', { class: 'status-bar-context status-bar-context--empty', id: 'status-bar-context', title: 'No object open. Click a widget (Inspect on), right-click a BMP element, or pick one to inspect it.' }, 'no object');
  const label = c.name || c.businessId || c.rid;
  // When the context is a Tab, prefix the label so it's distinguishable
  // from a same-named widget at a glance — tabs live alongside scorecards
  // and widgets in the chip slot.
  const prefix = c.type === 'Tab' ? 'Tab: ' : '';
  return h('button', {
    class: `status-bar-context${c.type === 'Tab' ? ' status-bar-context--tab' : ''}`,
    id: 'status-bar-context',
    title: `Inspecting: ${c.type ?? 'Object'} · ${label} · click to open`,
    onClick: () => {
      if (c.rid) {
        // Re-use the existing SELECT_OBJECT routing path. Wrapping in a
        // require()-style avoidance: emit through sendMessage to keep the
        // single source of truth in the orchestrator switch.
        sendMessage({ type: 'SELECT_OBJECT', rid: c.rid });
      }
    },
  },
    h('span', { class: 'status-bar-context-dot' }),
    h('span', { class: 'status-bar-context-name' }, prefix + label),
  );
}
function updateContextPill(): void {
  // The AI tab mirrors S.context as its selection chip — every context change
  // or enrichment that repaints the pill must also refresh the chips, or the
  // chip badge stays on the sparse (grey) identity forever.
  (tabs['ai'] as AiTab | undefined)?.contextChanged();
  const old = document.getElementById('status-bar-context');
  const next = renderContextPill();
  if (!old || !next) return;
  old.replaceWith(next);
}

/** Latency traffic light — 6-step ramp plus a grey "X" for "no data".
 *  Thresholds are tuned for a typical setup where the bridge daemon sits
 *  behind an SSH tunnel + a remote BMP server (the CREV team's reference
 *  configuration). Health-ping latency for that path runs ~50–120 ms on a
 *  healthy day; EC round-trips on small queries run 100–400 ms.
 *
 *  Tooltip explains what the number is so users on a different setup can
 *  recalibrate mentally without us having to ship per-deployment knobs.
 *
 *  Data source preference: latest EC duration (real user-perceived signal)
 *  if recent, else the health-poll responseMs. Falls back to grey X when
 *  not connected. */
function latencyLevel(ms: number | null, connected: boolean): { tier: number; label: string } {
  if (!connected) return { tier: -1, label: 'disconnected' };
  if (ms == null) return { tier: -1, label: 'no sample yet' };
  // 6-step ramp: 0=excellent → 5=problematic.
  if (ms <  80) return { tier: 0, label: 'excellent' };
  if (ms < 160) return { tier: 1, label: 'good' };
  if (ms < 320) return { tier: 2, label: 'ok' };
  if (ms < 600) return { tier: 3, label: 'slow' };
  if (ms < 1200) return { tier: 4, label: 'very slow' };
  return { tier: 5, label: 'problematic' };
}
function renderLatencyPill(): HTMLElement {
  const connected = S.connState.display === 'connected';
  // Prefer EC ms (user-action) — falls back to health-ping responseMs.
  const ms = S.lastEcMs ?? S.connState.responseMs ?? null;
  const { tier, label } = latencyLevel(ms, connected);
  const source = S.lastEcMs != null ? 'last EC round-trip' : 'health-check ping';
  const text = ms == null
    ? '—'
    : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
  const title = tier === -1
    ? (connected ? 'No latency sample yet. Run any query to see it' : 'Not connected to BMP')
    : `BMP latency: ${label} (${ms} ms via ${source}). Thresholds: <80 / <160 / <320 / <600 / <1200 / ≥1200 ms.`;
  return h('div', { class: `status-bar-latency status-bar-latency--t${tier}`, id: 'status-bar-latency', title },
    h('span', { class: 'status-bar-latency-ic' }, svg(ICON_PULSE)),
    h('span', { class: 'status-bar-latency-value' }, text),
  );
}
function updateLatencyPill(): void {
  const old = document.getElementById('status-bar-latency');
  if (!old) return;
  old.replaceWith(renderLatencyPill());
}

// ── Boot ─────────────────────────────────────────────────────────

/** Unobtrusive in-sidebar popup anchored under the CREV brand. Stays inside
 *  the panel (no new tab) so the user doesn't lose context — clicking a link
 *  inside opens that destination in a real tab via window.open. */
/** Human labels for the paintable style props (right-click menu). */
const PAINT_PROP_LABELS: Record<string, string> = {
  headerColor: 'Header color',
  fontColor: 'Font color',
  transparency: 'Transparency',
  shadow: 'Shadow',
  headerStyle: 'Header style',
  borderStyle: 'Border style',
  showToolMenu: 'Tool menu',
  disableSearch: 'Disable search',
};

/** Right-click menu on the paint button: toggle which style props Paint
 *  Format copies. Persists via SAVE_SETTINGS (paintProps) — the SW reads it in
 *  handlePaintApply. Stays open across toggles; closes on outside-click/Esc. */
function showPaintStyleMenu(anchor: HTMLElement): void {
  const existing = document.getElementById('paint-style-menu');
  if (existing) { existing.remove(); return; }

  const selected = new Set(S.settings.paintProps ?? PAINT_STYLE_PROPS);
  const rect = anchor.getBoundingClientRect();

  const rows = PAINT_STYLE_PROPS.map((prop) => {
    const cb = h('input', { type: 'checkbox', class: 'paint-style-cb' }) as HTMLInputElement;
    cb.checked = selected.has(prop);
    cb.addEventListener('change', () => {
      if (cb.checked) selected.add(prop); else selected.delete(prop);
      const paintProps = PAINT_STYLE_PROPS.filter(p => selected.has(p));
      S.settings = { ...S.settings, paintProps };
      sendMessage({ type: 'SAVE_SETTINGS', settings: { paintProps } });
    });
    return h('label', { class: 'paint-style-row', role: 'menuitemcheckbox' },
      cb, h('span', null, PAINT_PROP_LABELS[prop] ?? prop));
  });

  const menu = h('div', {
    id: 'paint-style-menu',
    class: 'brand-menu paint-style-menu',
    role: 'menu',
    style: `top:${rect.bottom + 4}px; right:${Math.max(4, window.innerWidth - rect.right)}px;`,
  },
    h('div', { class: 'paint-style-title' }, 'Paint these styles'),
    ...rows,
  );
  document.body.appendChild(menu);

  const close = (e?: Event) => {
    if (e && menu.contains(e.target as Node)) return;
    menu.remove();
    document.removeEventListener('mousedown', close);
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
  setTimeout(() => {
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey);
  }, 0);
}

function showBrandMenu(anchor: HTMLElement): void {
  const existing = document.getElementById('header-brand-menu');
  if (existing) { existing.remove(); return; }

  const rect = anchor.getBoundingClientRect();
  const menu = h('div', {
    id: 'header-brand-menu',
    class: 'brand-menu',
    role: 'menu',
    style: `top:${rect.bottom + 4}px; left:${rect.left}px;`,
  },
    // Code search now lives as a header icon (next to Extended Code / Paint).
    h('a', { class: 'brand-menu-link', role: 'menuitem', href: 'https://crev.theinemann.de', target: '_blank', rel: 'noopener' }, 'Open crev.theinemann.de'),
    h('a', { class: 'brand-menu-link', role: 'menuitem', href: 'https://github.com/HeinemannT/crev-inspector', target: '_blank', rel: 'noopener' }, 'GitHub repo'),
    h('a', { class: 'brand-menu-link', role: 'menuitem', href: 'https://github.com/HeinemannT/crev-inspector/releases', target: '_blank', rel: 'noopener' }, 'Releases'),
    h('div', { class: 'brand-menu-meta' }, `v${chrome.runtime.getManifest().version}`),
  );
  document.body.appendChild(menu);

  // Click outside / Escape closes
  const close = (e?: Event) => {
    if (e && menu.contains(e.target as Node)) return;
    menu.remove();
    document.removeEventListener('mousedown', close);
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
  // Defer attaching mousedown — otherwise the click that opened the menu
  // immediately closes it.
  setTimeout(() => {
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey);
  }, 0);
}

// Global Escape: bails out of context-picker mode so the user can drop the
// modal expectation without hunting for the button to disarm it.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const workshopTab = tabs.workshop as WorkshopTab;
  if (workshopTab?.isPickingContext?.()) {
    e.preventDefault();
    workshopTab.cancelPick(getActivePanel() ?? undefined);
  }
});

chrome.storage.session.get(['crev_active_tab', 'crev_settings_snapshot', 'crev_conn_snapshot'], (result) => {
  if (result.crev_active_tab && typeof result.crev_active_tab === 'string') {
    // Migration: legacy 'inspect' / 'page' tab keys map to Workshop.
    // Unknown values fall through to the default ('connect').
    const stored = result.crev_active_tab;
    const migrated = (stored === 'inspect' || stored === 'page') ? 'workshop' : stored;
    if ((ALL_TABS as readonly string[]).includes(migrated)) {
      S.activeTab = migrated;
    }
  }
  // chrome.storage.session.get returns Record<string, any>; cast at
  // the slot since we can't constrain the union per-key.
  if (result.crev_settings_snapshot) S.settings = result.crev_settings_snapshot as typeof S.settings;
  if (result.crev_conn_snapshot) S.connState = result.crev_conn_snapshot as typeof S.connState;
  aiEnabled = computeAiEnabled();
  // A stored 'ai' active tab is only valid once configured.
  if (S.activeTab === 'ai' && !aiEnabled) S.activeTab = 'connect';
  buildApp();
  sendMessage({ type: 'GET_CONNECTION_STATE' });
  sendMessage({ type: 'GET_SETTINGS' });
  sendMessage({ type: 'GET_DETECTION' }); // header's page-state (BMP vs not) for the active tab
  // Pull initial context so the status-bar context chip populates regardless
  // of which tab the user lands on. The Workshop layout pane also requests this on its
  // own activate(); the SW handler is idempotent.
  sendMessage({ type: 'GET_CONTEXT_RID' });
  switchTab(S.activeTab);
});
