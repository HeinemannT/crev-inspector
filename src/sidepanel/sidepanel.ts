/**
 * Side panel orchestrator — boot, tab routing, header/status rendering.
 * Tabs are self-contained components (Tab interface). This module:
 * - Updates shared state (S.connState, S.settings, etc.)
 * - Routes messages to active tab's handleMessage()
 * - Manages header, status strip, status bar, paint button
 */

import type { InspectorMessage } from '../lib/types';
import { h, render, svg } from '../lib/dom';
import { delegate } from './delegate';
import { log } from '../lib/logger';
import { ICON_PAINT, ICON_REFRESH, ICON_LIGHTNING, ICON_TORNADO } from './utils';
import { DetailView } from './detail-view';
import { initReferenceView, showReferenceView, handleReferenceMessage, isReferenceActive } from './reference-view';
import { S, sendMessage, getActivePanel, getTabPanel, tabPanelId, onPortMessage, onReconnect, connectPanel } from './state';
import { dispatchBroadcast } from '../lib/handler-registry';
import { showProfileSwitcher } from './profile-switcher';
import type { Tab } from './tabs/tab-types';
import { ConnectTab } from './tabs/connect-tab';
import { ObjectsTab } from './tabs/objects-tab';
import { LogTab } from './tabs/log-tab';
import { WorkshopTab } from './tabs/workshop-tab';
import { showToast } from '../lib/toast';

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
  log: new LogTab(sendMessage),
};

const logTab = tabs.log as LogTab;
logTab.onActivityChange(() => updateStatusBar());

initReferenceView(
  () => renderActiveTab(),
  navigateToDetail,
  sendMessage,
);

// ── Message routing ──────────────────────────────────────────────

onPortMessage((msg: InspectorMessage) => {
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

  // Shared state updates
  let headerChanged = false;
  switch (msg.type) {
    case 'INSPECT_STATE':
      S.inspectActive = msg.active;
      updateToggle();
      break;
    case 'CACHE_STATS':
      S.cacheCount = msg.count;
      updateObjectsBadge();
      break;
    case 'SETTINGS_DATA':
      S.settings = msg.settings;
      headerChanged = true;
      break;
    case 'CONNECTION_STATE':
      S.connState = msg.state;
      headerChanged = true;
      updateLatencyPill();
      break;
    case 'CONTEXT_RID_DATA':
      // Track the latest BMP context object so the status bar can surface
      // "what's selected" across tabs. A null rid means context was cleared.
      if ('rid' in msg && msg.rid) {
        S.context = { rid: msg.rid, name: msg.name, type: msg.objectType, businessId: msg.businessId };
      } else {
        S.context = null;
      }
      updateContextPill();
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
  tabs[S.activeTab]?.activate();
});

connectPanel();

// ── Render ───────────────────────────────────────────────────────

const TAB_NAMES = ['connect', 'workshop', 'objects', 'log'] as const;

function buildApp(): void {
  const header = h('div', { class: 'header' },
    h('button', {
      class: 'header-brand',
      id: 'header-brand',
      title: 'CREV: click for related links',
      'aria-haspopup': 'menu',
    },
      h('span', { class: 'header-brand-mark', 'aria-hidden': 'true' }, svg(ICON_TORNADO)),
      'CREV',
    ),
    h('div', { class: 'header-status', id: 'header-status', 'aria-live': 'polite' },
      h('span', { class: `status-dot ${statusDotClass()}` }),
      h('span', { class: 'header-label' }, statusText()),
    ),
    h('button', {
      class: 'header-icon-btn',
      id: 'open-extended',
      'aria-label': 'Open Extended Code',
      title: 'Open Extended Code (Ctrl+Shift+E by default: rebind at chrome://extensions/shortcuts)',
    }, svg(ICON_LIGHTNING)),
    h('button', {
      class: `paint-btn ${S.paintPhase !== 'off' ? 'active' : ''}`,
      id: 'toggle-paint',
      'aria-label': 'Paint Format',
      title: 'Paint Format: copy visual style between objects.\nApplies: headerColor, fontColor, transparency, shadow, headerStyle, borderStyle.\nPick a source widget, then click targets to apply.',
    }, svg(ICON_PAINT)),
    h('button', {
      class: `inspect-toggle ${S.inspectActive ? 'active' : ''}`,
      id: 'toggle-inspect',
      title: 'Toggle inspect overlays (Ctrl+Shift+X: rebind at chrome://extensions/shortcuts)',
    }, 'Inspect', h('kbd', null, '⌃⇧X')),
  );

  const tabBar = h('div', { class: 'tab-bar', role: 'tablist' },
    ...TAB_NAMES.map(t => {
      // Display label per internal tab key; everything not in the map
      // falls back to a capitalised key.
      const TAB_LABELS: Record<string, string> = {
        connect: 'Connect',
        workshop: 'Workshop',
        objects: 'Browse',
        log: 'Log',
      };
      const label = TAB_LABELS[t] ?? (t.charAt(0).toUpperCase() + t.slice(1));
      const badges: (HTMLElement | string | false | null)[] = [label];

      if (t === 'objects') {
        badges.push(h('span', { class: 'badge', id: 'objects-badge' }, String(S.cacheCount)));
      }
      if (t === 'connect') {
        badges.push(h('span', { class: `tab-dot ${connectDotClass()}`, id: 'connect-tab-dot' }));
      }
      if (t === 'workshop') {
        // Dirty-dot — surfaces unsaved property edits on Workshop's
        // detail half even when the user has navigated to another
        // tab. Toggled in-place from DetailView's render path.
        badges.push(h('span', {
          class: `inspect-dirty-dot${detailView.isDirty() ? ' active' : ''}`,
          id: 'inspect-dirty-dot',
          'aria-hidden': 'true',
          title: detailView.isDirty() ? 'You have unsaved changes on this object' : '',
        }));
      }

      const TAB_TITLES: Record<string, string> = {
        connect: 'Server profiles',
        workshop: 'Layout + selected object detail: the configurator workspace',
        objects: 'Browse cached objects: search by RID, BID, or name',
        log: 'Activity feed',
      };
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

  const isError = ['unreachable', 'server-down', 'auth-failed'].includes(S.connState.display);
  const statusStrip = h('div', { class: `status-strip ${statusStripClass()}`, id: 'status-strip' },
    h('span', { class: `status-dot ${statusDotClass()}`, id: 'strip-dot' }),
    h('span', { class: 'status-strip-text', id: 'strip-text' }, statusStripText()),
    h('button', {
      class: `status-strip-reconnect ${isError ? '' : 'hidden'}`,
      id: 'strip-reconnect',
      'data-action': 'reconnect',
    }, 'Reconnect'),
    h('button', { class: 'status-strip-btn', 'data-action': 'test', title: 'Test connection' }, svg(ICON_REFRESH)),
  );

  const paintStatus = S.paintPhase !== 'off'
    ? h('div', { class: 'paint-status-bar', id: 'paint-status' },
        S.paintPhase === 'picking'
          ? 'Click a widget to pick its style'
          : ['Painting from ', h('b', null, S.paintSourceName ?? '?'), ': click targets'],
      )
    : null;

  const tabContent = h('div', { class: 'tab-content' },
    ...TAB_NAMES.map(t =>
      h('div', { class: `tab-panel ${S.activeTab === t ? 'active' : ''}`, id: tabPanelId(t), role: 'tabpanel' }),
    ),
  );

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

  render(app, header, tabBar, statusStrip, paintStatus, tabContent, statusBar);

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

  app.querySelector('#toggle-paint')?.addEventListener('click', () => sendMessage({ type: 'TOGGLE_PAINT' }));
  app.querySelector('#toggle-inspect')?.addEventListener('click', () => sendMessage({ type: 'TOGGLE_INSPECT' }));
  app.querySelector('#open-extended')?.addEventListener('click', () => sendMessage({ type: 'OPEN_EXTENDED' }));
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
  for (const panelName of TAB_NAMES) {
    const panel = getTabPanel(panelName);
    if (panel) panel.classList.toggle('active', panelName === tab);
  }

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
  if (btn) {
    btn.className = `inspect-toggle ${S.inspectActive ? 'active' : ''}`;
    // Preserve the kbd chip — only toggle the class.
  }
}

function updateObjectsBadge() {
  const badge = document.getElementById('objects-badge');
  if (badge) badge.textContent = String(S.cacheCount);
}

function statusDotClass(): string {
  switch (S.connState.display) {
    case 'connected': return 'ok';
    case 'online': return 'online';
    case 'unreachable': return S.connState.networkOffline ? 'warn' : 'fail';
    case 'server-down': case 'auth-failed': return 'fail';
    default: return '';
  }
}

function statusText(): string {
  switch (S.connState.display) {
    case 'not-configured': return 'No server';
    case 'checking': return 'Checking\u2026';
    case 'connected': return S.connState.profileLabel ?? 'Connected';
    case 'online': return 'Online';
    case 'auth-failed': return 'Auth failed';
    case 'server-down': return 'Server down';
    case 'unreachable': return S.connState.networkOffline ? 'No network' : 'Unreachable';
  }
}

function statusBarText(): string {
  const d = S.connState.display;
  if (d === 'connected') return 'Connected';
  if (d === 'server-down') return 'Down';
  return statusText();
}

function connectDotClass(): string {
  switch (S.connState.display) {
    case 'connected': return 'tab-dot--ok';
    case 'online': return 'tab-dot--ok tab-dot--dim';
    case 'unreachable': return S.connState.networkOffline ? 'tab-dot--warn' : 'tab-dot--fail';
    case 'server-down': case 'auth-failed': return 'tab-dot--fail';
    default: return 'tab-dot--gray';
  }
}

function showPaintError(error: string) {
  const tabBar = app.querySelector('.tab-bar');
  if (!tabBar) return;
  let bar = document.getElementById('paint-error');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'paint-error';
    bar.className = 'paint-status-bar paint-status-bar--error';
    tabBar.insertAdjacentElement('afterend', bar);
  }
  bar.textContent = error;
  setTimeout(() => bar?.remove(), 4000);
}

function updatePaintButton() {
  const btn = document.getElementById('toggle-paint');
  if (btn) {
    btn.className = `paint-btn ${S.paintPhase !== 'off' ? 'active' : ''}`;
  }
  const statusBar = document.getElementById('paint-status');
  if (statusBar) {
    if (S.paintPhase === 'off') {
      statusBar.remove();
    } else if (S.paintPhase === 'picking') {
      statusBar.textContent = 'Click a widget to pick its style';
    } else {
      statusBar.textContent = '';
      statusBar.append('Painting from ', h('b', null, S.paintSourceName ?? '?'), ': click targets');
    }
  } else if (S.paintPhase !== 'off') {
    buildApp();
  }
}

function statusStripClass(): string {
  switch (S.connState.display) {
    case 'connected': return 'ok';
    case 'online': return 'online';
    case 'unreachable': return S.connState.networkOffline ? 'offline' : 'fail';
    case 'server-down': case 'auth-failed': return 'fail';
    default: return '';
  }
}

function statusStripText(): string {
  const s = S.connState;
  switch (s.display) {
    case 'not-configured': return 'No server configured';
    case 'checking': return 'Checking\u2026';
    case 'connected': {
      const parts: string[] = ['Connected'];
      if (s.profileLabel) parts[0] = s.profileLabel;
      if (s.workspace) parts.push(s.workspace);
      if (s.version) parts.push(`BMP ${s.version}`);
      return parts.join(' \u00b7 ');
    }
    case 'online': return 'Online (not authenticated)';
    case 'auth-failed': return 'Auth failed';
    case 'server-down': return 'Server down';
    case 'unreachable': return s.networkOffline ? 'No network' : 'Unreachable';
  }
}

function refreshStatusStrip() {
  const strip = document.getElementById('status-strip');
  if (!strip) return;
  strip.className = `status-strip ${statusStripClass()}`;
  const dot = document.getElementById('strip-dot');
  if (dot) dot.className = `status-dot ${statusDotClass()}`;
  const text = document.getElementById('strip-text');
  if (text) text.textContent = statusStripText();
  const reconnect = document.getElementById('strip-reconnect');
  if (reconnect) {
    const isError = ['unreachable', 'server-down', 'auth-failed'].includes(S.connState.display);
    reconnect.classList.toggle('hidden', !isError);
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
  if (!c?.rid) return h('div', { class: 'status-bar-context status-bar-context--empty', id: 'status-bar-context', title: 'No BMP context: right-click an element or use the Page-tab crosshair to set one' }, 'no context');
  const label = c.name || c.businessId || c.rid;
  // When the context is a Tab, prefix the label so it's distinguishable
  // from a same-named widget at a glance — tabs live alongside scorecards
  // and widgets in the chip slot.
  const prefix = c.type === 'Tab' ? 'Tab: ' : '';
  return h('button', {
    class: `status-bar-context${c.type === 'Tab' ? ' status-bar-context--tab' : ''}`,
    id: 'status-bar-context',
    title: `Context: ${c.type ?? 'Object'} · ${label} · click to open`,
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
    h('span', { class: 'status-bar-latency-dot' }, tier === -1 ? '✕' : ''),
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
    h('button', { class: 'brand-menu-link', role: 'menuitem',
      onClick: () => { sendMessage({ type: 'OPEN_CODE_SEARCH' }); document.getElementById('header-brand-menu')?.remove(); },
    }, 'Code search…'),
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
    if ((TAB_NAMES as readonly string[]).includes(migrated)) {
      S.activeTab = migrated;
    }
  }
  // chrome.storage.session.get returns Record<string, any>; cast at
  // the slot since we can't constrain the union per-key.
  if (result.crev_settings_snapshot) S.settings = result.crev_settings_snapshot as typeof S.settings;
  if (result.crev_conn_snapshot) S.connState = result.crev_conn_snapshot as typeof S.connState;
  buildApp();
  sendMessage({ type: 'GET_CONNECTION_STATE' });
  sendMessage({ type: 'GET_SETTINGS' });
  // Pull initial context so the status-bar context chip populates regardless
  // of which tab the user lands on. The Workshop layout pane also requests this on its
  // own activate(); the SW handler is idempotent.
  sendMessage({ type: 'GET_CONTEXT_RID' });
  switchTab(S.activeTab);
});
