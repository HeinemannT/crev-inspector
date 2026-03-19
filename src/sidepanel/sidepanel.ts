/**
 * Side panel orchestrator — render, tab switching, message routing, header/status.
 */

import type { InspectorMessage, DetectionPhase } from '../lib/types';
import { h, render, svg } from '../lib/dom';
import { delegate } from './delegate';
import { log } from '../lib/logger';
import { ICON_PAINT, ICON_REFRESH } from './utils';
import { initDetailView, showDetail, handleDetailMessage, isDetailActive, clearDetail } from './detail-view';
import { S, pushActivityEntry, sendMessage, getActivePanel, port } from './state';
import { renderConnectTab } from './tabs/connect-tab';
import { renderObjectsTab } from './tabs/objects-tab';
import { renderPageTab } from './tabs/page-tab';
import { renderLogTab, renderActivityFeed } from './tabs/log-tab';

// ── Init ────────────────────────────────────────────────────────

const app = document.getElementById('app')!;

initDetailView(
  () => { S.detailRid = null; renderActiveTab(); },
  sendMessage,
);

// ── Message routing ──────────────────────────────────────────────

port.onMessage.addListener((msg: InspectorMessage) => {
  // Route detail-relevant messages when in detail view
  if (S.detailRid && (msg.type === 'SERVER_LOOKUP_RESULT' || msg.type === 'EC_RESULT')) {
    const panel = getActivePanel();
    if (panel && handleDetailMessage(msg, panel)) return;
  }

  switch (msg.type) {
    case 'INSPECT_STATE':
      S.inspectActive = msg.active;
      updateToggle();
      break;

    case 'CACHE_STATS':
      S.cacheCount = msg.count;
      updateObjectsBadge();
      updateStatusBar();
      break;

    case 'PAGE_INFO':
      S.pageInfo = { url: msg.url, rid: msg.rid, tabRid: msg.tabRid, widgets: msg.widgets };
      if (msg.detection) {
        const phase: DetectionPhase = msg.detection.isBmp ? 'detected' : 'not-detected';
        S.detection = { phase, confidence: msg.detection.confidence, signals: msg.detection.signals };
      }
      if (S.activeTab === 'page' && !S.detailRid) renderPageTab(navigateToDetail);
      break;

    case 'CACHE_DATA':
      S.cacheObjects = msg.objects;
      if (S.activeTab === 'objects' && !S.detailRid) renderObjectsTab(navigateToDetail);
      break;

    case 'SETTINGS_DATA':
      S.settings = msg.settings;
      if (S.activeTab === 'connect' && !S.editingProfile) renderConnectTab();
      break;

    case 'CONNECTION_STATE':
      S.connState = msg.state;
      if (S.activeTab === 'connect' && !S.editingProfile) renderConnectTab();
      updateHeaderStatus();
      refreshStatusStrip();
      updateStatusBar();
      break;

    case 'PROFILE_SWITCHED':
      if (S.activeTab === 'connect' && !S.editingProfile) renderConnectTab();
      updateHeaderStatus();
      refreshStatusStrip();
      updateStatusBar();
      break;

    case 'DETECTION_STATE':
      S.detection = { phase: msg.phase, confidence: msg.confidence, signals: msg.signals };
      if (S.activeTab === 'page' && !S.detailRid) renderPageTab(navigateToDetail);
      break;

    case 'ACTIVITY_LOG':
      S.activityEntries = msg.entries;
      if (S.activeTab === 'log') renderLogTab();
      updateStatusBar();
      break;

    case 'ACTIVITY_ENTRY':
      pushActivityEntry(msg.entry);
      if (S.activeTab === 'log') renderActivityFeed();
      S.latestActivityMsg = msg.entry.message;
      updateStatusBar();
      if (S.latestActivityTimer) clearTimeout(S.latestActivityTimer);
      S.latestActivityTimer = setTimeout(() => {
        S.latestActivityMsg = null;
        updateStatusBar();
      }, 3000);
      break;

    case 'HISTORY_DATA':
      S.historyEntries = msg.entries;
      if (S.activeTab === 'objects' && !S.detailRid) renderObjectsTab(navigateToDetail);
      break;

    case 'FAVORITES_DATA':
      S.favoriteEntries = msg.entries;
      if (S.activeTab === 'objects' && !S.detailRid) renderObjectsTab(navigateToDetail);
      // Re-render detail view star if open
      if (S.detailRid && isDetailActive()) {
        const panel = getActivePanel();
        if (panel) renderActiveTab();
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
      if ('rid' in msg) navigateToDetail(msg.rid);
      break;
  }
});

// ── Render ───────────────────────────────────────────────────────

const TABS = ['connect', 'objects', 'page', 'log'] as const;

function buildApp(): void {
  const header = h('div', { class: 'header' },
    h('div', { class: 'header-status', id: 'header-status' },
      h('span', { class: `status-dot ${statusDotClass()}` }),
      h('span', { class: 'header-label' }, statusText()),
    ),
    h('button', {
      class: `paint-btn ${S.paintPhase !== 'off' ? 'active' : ''}`,
      id: 'toggle-paint',
      title: 'Paint Format: copy visual style between objects.\nApplies: headerColor, fontColor, transparency, shadow, headerStyle, borderStyle.\nPick a source widget, then click targets to apply.',
    }, svg(ICON_PAINT)),
    h('button', {
      class: `inspect-toggle ${S.inspectActive ? 'active' : ''}`,
      id: 'toggle-inspect',
      title: 'Toggle inspect overlays (Ctrl+Shift+X)',
    }, 'Inspect'),
  );

  const tabBar = h('div', { class: 'tab-bar' },
    ...TABS.map(t => {
      const label = t.charAt(0).toUpperCase() + t.slice(1);
      const badges: (HTMLElement | string | false | null)[] = [label];

      if (t === 'objects') {
        badges.push(h('span', { class: 'badge', id: 'objects-badge' }, String(S.cacheCount)));
      }
      if (t === 'connect') {
        badges.push(h('span', { class: `tab-dot ${connectDotClass()}`, id: 'connect-tab-dot' }));
      }
      if (t === 'log') {
        const errCount = S.activityEntries.filter(e => e.level === 'error').length;
        if (errCount > 0) {
          badges.push(h('span', { class: 'badge badge--error', id: 'log-badge' }, String(errCount)));
        }
      }
      if (t === 'page' && S.pageInfo?.widgets?.length) {
        badges.push(h('span', { class: 'badge', id: 'page-badge' }, String(S.pageInfo.widgets.length)));
      }

      const TAB_TITLES: Record<string, string> = {
        connect: 'Server profiles', objects: 'Discovered objects', page: 'Current BMP page',
        log: 'Activity feed',
      };
      return h('button', {
        class: `tab ${S.activeTab === t ? 'active' : ''}`,
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
          : ['Painting from ', h('b', null, S.paintSourceName ?? '?'), ' \u2014 click targets'],
      )
    : null;

  const tabContent = h('div', { class: 'tab-content' },
    ...TABS.map(t =>
      h('div', { class: `tab-panel ${S.activeTab === t ? 'active' : ''}`, id: `panel-${t}` }),
    ),
  );

  const statusBar = h('div', { class: 'status-bar', id: 'status-bar' },
    h('div', { class: 'status-bar-connection' },
      h('span', { class: `status-dot ${statusDotClass()}` }),
      h('span', null, statusBarText()),
    ),
    h('div', { class: 'status-bar-activity' }, S.latestActivityMsg ?? ''),
    h('div', { class: 'status-bar-count' }, String(S.cacheCount)),
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
    reconnect: () => {
      sendMessage({ type: 'CONNECTION_TEST' });
    },
  });

  app.querySelector('#toggle-paint')?.addEventListener('click', () => sendMessage({ type: 'TOGGLE_PAINT' }));
  app.querySelector('#toggle-inspect')?.addEventListener('click', () => sendMessage({ type: 'TOGGLE_INSPECT' }));

  renderActiveTab();
}

function switchTab(tab: string) {
  S.activeTab = tab;
  chrome.storage.session.set({ crev_active_tab: tab }).catch(e => log.swallow('panel:persistTab', e));

  if (tab === 'page') {
    S.detection = { phase: 'unknown', confidence: 0, signals: [] };
    S.pageInfo = null;
  }

  // Update tab bar classes + panel visibility without rebuilding the entire DOM
  for (const btn of app.querySelectorAll<HTMLElement>('.tab[data-tab]')) {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  }
  for (const panel of app.querySelectorAll<HTMLElement>('.tab-panel')) {
    const panelTab = panel.id.replace('panel-', '');
    panel.classList.toggle('active', panelTab === tab);
  }

  renderActiveTab();

  switch (tab) {
    case 'page':
      sendMessage({ type: 'GET_PAGE_INFO' });
      break;
    case 'objects':
      sendMessage({ type: 'GET_CACHE', filter: S.cacheFilter });
      sendMessage({ type: 'GET_HISTORY' });
      sendMessage({ type: 'GET_FAVORITES' });
      break;
    case 'connect':
      sendMessage({ type: 'GET_SETTINGS' });
      break;
    case 'log':
      sendMessage({ type: 'GET_ACTIVITY' });
      break;
  }
}

function renderActiveTab() {
  if (S.detailRid && isDetailActive()) return;
  switch (S.activeTab) {
    case 'page': renderPageTab(navigateToDetail); break;
    case 'objects': renderObjectsTab(navigateToDetail); break;
    case 'connect': renderConnectTab(); break;
    case 'log': renderLogTab(); break;
  }
}

// ── Detail navigation ────────────────────────────────────────────

function navigateToDetail(rid: string) {
  S.detailRid = rid;
  let obj = S.cacheObjects.find(o => o.rid === rid);
  if (!obj && S.pageInfo) {
    const widget = S.pageInfo.widgets.find(w => w.rid === rid);
    if (widget) {
      obj = { rid: widget.rid, name: widget.name, type: widget.type, source: 'dom', discoveredAt: Date.now(), updatedAt: Date.now() };
    }
  }
  if (!obj) {
    obj = { rid, source: 'dom', discoveredAt: Date.now(), updatedAt: Date.now() };
  }
  const panel = getActivePanel();
  if (panel) showDetail(obj, panel);
}

// ── Header/Status helpers ────────────────────────────────────────

function updateToggle() {
  const btn = document.getElementById('toggle-inspect');
  if (btn) {
    btn.className = `inspect-toggle ${S.inspectActive ? 'active' : ''}`;
    btn.textContent = 'Inspect';
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

/** Check if the extension is connected to a BMP server */
export function isConnected(): boolean {
  return S.connState.display === 'connected';
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
      statusBar.append('Painting from ', h('b', null, S.paintSourceName ?? '?'), ' \u2014 click targets');
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
  // Stop refresh spinner once state arrives
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
  if (activity) activity.textContent = S.latestActivityMsg ?? '';

  const count = bar.querySelector('.status-bar-count');
  if (count) count.textContent = String(S.cacheCount);
}

// ── Boot ─────────────────────────────────────────────────────────

chrome.storage.session.get('crev_active_tab', (result) => {
  if (result.crev_active_tab && typeof result.crev_active_tab === 'string') {
    S.activeTab = result.crev_active_tab;
  }
  buildApp();
  sendMessage({ type: 'GET_CACHE' });
  sendMessage({ type: 'GET_SETTINGS' });
  sendMessage({ type: 'GET_CONNECTION_STATE' });
  sendMessage({ type: 'GET_PAGE_INFO' });
  sendMessage({ type: 'GET_FAVORITES' });
  if (S.activeTab === 'log') sendMessage({ type: 'GET_ACTIVITY' });
  if (S.activeTab === 'objects') sendMessage({ type: 'GET_HISTORY' });
});
