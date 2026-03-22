/**
 * Unified message router — eliminates duplication between port and one-shot handlers.
 */

import type { InspectorMessage } from './types';
import { SCRIPT_PROPS, CODE_PROPS_FOR_TYPE } from './types';
import { getCtx } from './sw-context';
import { enrichBadges, resetEnrichment, refreshEnrichment, incrementGeneration } from './enrichment';
import { openEditorWindow } from './editor';
import { runAuthTest, pushConnectionState } from './connection';
import { getTabDetection, setTabDetection, updateBadge } from './detection';
import { saveSettings, rebuildClient, setManualOverride } from './settings';
import { sendPageInfoToPanel, handleGetDetection, ensureContentScript } from './tab-awareness';
import { togglePaint, handlePaintPick, handlePaintApply, handlePaintConfirm } from './paint';
import { getActivityLog } from './activity';
import { log, errorMessage } from './logger';
import { COMMON_DIFF_PROPS } from './constants';

import type { DetectionPhase } from './types';

// Lazy-loaded modules for Object View, Diff, and Code Search
let objectViewLauncher: typeof import('./objectview-launcher') | null = null;
let diffLauncher: typeof import('./diff-launcher') | null = null;
let codeSearchModule: typeof import('./code-search') | null = null;
let codeSearchLauncher: typeof import('./codesearch-launcher') | null = null;

const SCRIPT_PROPS_SET: Set<string> = new Set(SCRIPT_PROPS);

// ── Shared handlers (used by both port and one-shot) ─────────────

export function handleEcExecute(
  msg: InspectorMessage & { type: 'EC_EXECUTE' },
  respond: (r: InspectorMessage) => void,
) {
  const ctx = getCtx();
  ctx.settingsReady.then(() => {
    if (ctx.client) {
      ctx.client.executeEc(msg.code, msg.objectRid, msg.transactional ?? false)
        .then(result => {
          respond({ type: 'EC_RESULT', ...result });
          // Record to script history
          ctx.scriptHistory.record({
            code: msg.code,
            timestamp: Date.now(),
            ok: result.ok,
            mode: msg.transactional ? 'execute' : 'preview',
          });
          // Record EC execution history when targeting an object
          if (msg.objectRid && result.ok) {
            const cached = ctx.cache.get(msg.objectRid);
            ctx.history.record({ rid: msg.objectRid, name: cached?.name, type: cached?.type, businessId: cached?.businessId, action: 'ec-executed', timestamp: Date.now() });
          }
        })
        .catch(e => respond({ type: 'EC_RESULT', ok: false, error: errorMessage(e) }));
    } else {
      respond({ type: 'EC_RESULT', ok: false, error: 'Not connected' });
    }
  });
}

export function handleSaveProperty(
  msg: InspectorMessage & { type: 'SAVE_PROPERTY' },
  respond: (r: { ok: boolean; error?: string }) => void,
) {
  const ctx = getCtx();
  ctx.settingsReady.then(() => {
    if (!ctx.client) { respond({ ok: false, error: 'Not connected' }); return; }

    const isCodeProp = SCRIPT_PROPS_SET.has(msg.property);
    const promise = isCodeProp
      ? ctx.client.saveCodeViaEc(msg.rid, msg.property, msg.value)
      : ctx.client.saveProperty(msg.rid, msg.objectType, msg.property, msg.value);
    promise
      .then(result => respond(result))
      .catch(e => respond({ ok: false, error: errorMessage(e) }));
  });
}

export function handleGetCache(msg: InspectorMessage & { type: 'GET_CACHE' }): InspectorMessage {
  const ctx = getCtx();
  const objects = msg.filter ? ctx.cache.search(msg.filter) : ctx.cache.getAll();
  return { type: 'CACHE_DATA', objects };
}

/** Shared lookup: identity + code props + cache. Used by both SERVER_LOOKUP and FULL_LOOKUP. */
async function lookupObject(rid: string): Promise<import('./types').BmpObject> {
  const ctx = getCtx();
  if (!ctx.client) throw new Error('Not connected');

  const identity = await ctx.client.lookupIdentity(rid);
  if (!identity) throw new Error('Object not found');

  const now = Date.now();
  const properties: Record<string, unknown> = {};
  const type = identity.type ?? '';
  const propsToFetch = CODE_PROPS_FOR_TYPE[type];
  if (propsToFetch) {
    try {
      const codeProps = await ctx.client.fetchCodeViaEc(rid, [...propsToFetch]);
      Object.assign(properties, codeProps);
    } catch (e) {
      log.swallow('router:fetchCodeProps', e);
    }
  }

  const obj: import('./types').BmpObject = {
    rid,
    name: identity.name,
    type: identity.type,
    businessId: identity.businessId,
    properties,
    source: 'server',
    discoveredAt: now,
    updatedAt: now,
  };

  ctx.cache.put(obj);
  return obj;
}

export function handleServerLookup(rid: string) {
  const ctx = getCtx();
  ctx.settingsReady.then(async () => {
    try {
      const obj = await lookupObject(rid);
      ctx.history.record({ rid, name: obj.name, type: obj.type, businessId: obj.businessId, action: 'viewed', timestamp: Date.now() });
      ctx.sendToPanel({ type: 'SERVER_LOOKUP_RESULT', rid, object: obj });
    } catch (e) {
      ctx.sendToPanel({ type: 'SERVER_LOOKUP_RESULT', rid, object: null, error: errorMessage(e) });
    }
  });
}

// ── Content message handler ──────────────────────────────────────

export function handleContentMessage(msg: InspectorMessage, senderTabId?: number) {
  const ctx = getCtx();
  switch (msg.type) {
    case 'OBJECTS_DISCOVERED':
      ctx.cache.putAll(msg.objects);
      ctx.logActivity('success', `Found ${msg.objects.length} object${msg.objects.length !== 1 ? 's' : ''}`);
      ctx.sendToPanel({ type: 'CACHE_STATS', count: ctx.cache.size });
      break;

    case 'TOGGLE_INSPECT':
      toggleInspect();
      break;

    case 'TOGGLE_PAINT':
      togglePaint(ensureContentScript);
      break;

    case 'PAINT_PICK':
      ctx.logActivity('info', 'Paint: copying styles\u2026');
      handlePaintPick(msg.rid);
      break;

    case 'PAINT_APPLY':
      handlePaintApply(msg.rid);
      break;

    case 'PAINT_CONFIRM':
      handlePaintConfirm(msg.rid);
      break;

    case 'ENRICH_BADGES':
      ctx.settingsReady.then(() => enrichBadges(msg.rids));
      break;

    case 'DETECTION_RESULT': {
      const phase: DetectionPhase = msg.isBmp ? 'detected' : 'not-detected';
      // Only log when detection state actually changes (avoid flooding activity log)
      const prevDet = senderTabId != null ? getTabDetection(senderTabId) : undefined;
      if (!prevDet || prevDet.phase !== phase) {
        const pct = Math.round(msg.confidence * 100);
        ctx.logActivity(msg.isBmp ? 'success' : 'info', msg.isBmp ? `Detection: BMP page (${pct}%)` : `Detection: not BMP (${pct}%)`);
      }
      if (senderTabId != null) {
        setTabDetection(senderTabId, { phase, confidence: msg.confidence, signals: msg.signals });
        updateBadge(senderTabId, msg.isBmp);
      }
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]?.id === senderTabId) {
          ctx.sendToPanel({ type: 'DETECTION_STATE', phase, confidence: msg.confidence, signals: msg.signals });
        }
      });
      break;
    }

    default: break;
  }
}

// ── Panel message handler ────────────────────────────────────────

export function handlePanelMessage(msg: InspectorMessage) {
  const ctx = getCtx();
  switch (msg.type) {
    case 'TOGGLE_INSPECT':
      toggleInspect();
      break;

    case 'TOGGLE_PAINT':
      togglePaint(ensureContentScript);
      break;

    case 'GET_CACHE':
      ctx.sendToPanel(handleGetCache(msg));
      break;

    case 'GET_SETTINGS':
      ctx.sendToPanel({ type: 'SETTINGS_DATA', settings: ctx.settings });
      break;

    case 'SAVE_SETTINGS': {
      const onlyEnrichMode = Object.keys(msg.settings).length === 1 && 'enrichMode' in msg.settings;
      const prevMode = ctx.settings.enrichMode;
      ctx.settings = { ...ctx.settings, ...msg.settings };
      saveSettings();
      if (ctx.settings.enrichMode !== prevMode) {
        ctx.broadcastToContent({ type: 'ENRICH_MODE', mode: ctx.settings.enrichMode });
      }
      if (!onlyEnrichMode) rebuildClient();
      break;
    }

    case 'SAVE_PROFILE': {
      const profiles = [...ctx.settings.profiles];
      const idx = profiles.findIndex(p => p.id === msg.profile.id);
      if (idx >= 0) {
        profiles[idx] = msg.profile;
      } else {
        profiles.push(msg.profile);
      }
      let activeId = ctx.settings.activeProfileId;
      if (!activeId || profiles.length === 1) {
        activeId = msg.profile.id;
      }
      ctx.settings = { ...ctx.settings, profiles, activeProfileId: activeId };
      saveSettings();
      rebuildClient(true);
      ctx.sendToPanel({ type: 'SETTINGS_DATA', settings: ctx.settings });
      break;
    }

    case 'DELETE_PROFILE': {
      const deletedId = msg.profileId;
      const profiles = ctx.settings.profiles.filter(p => p.id !== deletedId);
      let activeId = ctx.settings.activeProfileId;
      if (activeId === deletedId) {
        activeId = profiles[0]?.id ?? '';
      }
      ctx.settings = { ...ctx.settings, profiles, activeProfileId: activeId };
      saveSettings();
      rebuildClient(true);
      // Clean up orphaned storage keys for deleted profile
      const orphanKeys = ['cache', 'cache_date', 'history', 'favorites', 'script_history']
        .map(k => `crev_${deletedId}_${k}`);
      chrome.storage.local.remove(orphanKeys).catch(e => log.swallow('settings:cleanupProfile', e));
      ctx.sendToPanel({ type: 'SETTINGS_DATA', settings: ctx.settings });
      break;
    }

    case 'SET_ACTIVE_PROFILE': {
      if (ctx.settings.activeProfileId !== msg.profileId) {
        const profile = ctx.settings.profiles.find(p => p.id === msg.profileId);
        ctx.settings = { ...ctx.settings, activeProfileId: msg.profileId };
        setManualOverride();
        saveSettings();
        rebuildClient(true);
        if (profile) {
          ctx.broadcastToContent({ type: 'PROFILE_SWITCHED', profileId: msg.profileId, label: profile.label });
        }
      }
      break;
    }

    case 'CONNECTION_TEST':
      runAuthTest();
      break;

    case 'SERVER_LOOKUP':
      handleServerLookup(msg.rid);
      break;

    case 'EC_EXECUTE':
      handleEcExecute(msg, r => ctx.sendToPanel(r));
      break;

    case 'CLEAR_CACHE':
      ctx.cache.clear();
      resetEnrichment();
      ctx.sendToPanel({ type: 'CACHE_STATS', count: 0 });
      break;

    case 'REFRESH_ENRICHMENT':
      refreshEnrichment();
      break;

    case 'GET_PAGE_INFO':
      sendPageInfoToPanel();
      break;

    case 'GET_DETECTION':
      handleGetDetection();
      break;

    case 'GET_ACTIVITY':
      ctx.sendToPanel({ type: 'ACTIVITY_LOG', entries: getActivityLog() });
      break;

    case 'GET_CONNECTION_STATE':
      pushConnectionState();
      break;

    case 'OPEN_EDITOR': {
      openEditorWindow(msg.rid);
      // Record history for editor opens
      const cached = ctx.cache.get(msg.rid);
      if (cached) {
        ctx.history.record({ rid: msg.rid, name: cached.name, type: cached.type, businessId: cached.businessId, action: 'edited', timestamp: Date.now() });
      }
      break;
    }

    case 'SAVE_PROPERTY':
      handleSaveProperty(msg, r => ctx.sendToPanel({ type: 'SAVE_RESULT', ...r }));
      break;

    // ── History & Favorites ─────────────────────────────────────
    case 'GET_HISTORY':
      ctx.sendToPanel({ type: 'HISTORY_DATA', entries: ctx.history.getAll() });
      break;

    case 'CLEAR_HISTORY':
      ctx.history.clear();
      ctx.sendToPanel({ type: 'HISTORY_DATA', entries: [] });
      break;

    case 'TOGGLE_FAVORITE': {
      ctx.favorites.toggle(msg.rid, { name: msg.name, type: msg.objectType, businessId: msg.businessId });
      ctx.sendToPanel({ type: 'FAVORITES_DATA', entries: ctx.favorites.getAll() });
      break;
    }

    case 'GET_FAVORITES':
      ctx.sendToPanel({ type: 'FAVORITES_DATA', entries: ctx.favorites.getAll() });
      break;

    // ── Script History ─────────────────────────────────────────
    case 'GET_SCRIPT_HISTORY':
      ctx.sendToPanel({ type: 'SCRIPT_HISTORY_DATA', entries: ctx.scriptHistory.getAll() });
      break;

    // ── Object View ──────────────────────────────────────────────
    case 'OPEN_OBJECT_VIEW':
      loadObjectViewLauncher().then(m => m.openObjectViewWindow(msg.rid)).catch(e => log.swallow('router:openObjectView', e));
      break;

    case 'OPEN_CODE_SEARCH':
      loadCodeSearchLauncher().then(m => m.openCodeSearchWindow()).catch(e => log.swallow('router:openCodeSearch', e));
      break;

    case 'OPEN_DIFF':
      loadDiffLauncher().then(m => m.openDiffWindow(msg.leftRid, msg.rightRid)).catch(e => log.swallow('router:openDiff', e));
      break;

    case 'OPEN_TEMPLATE_DIFF': {
      const ctx2 = getCtx();
      ctx2.settingsReady.then(async () => {
        if (!ctx2.client) return;
        const tmpl = await ctx2.client.resolveTemplate(msg.rid);
        if (tmpl.templateRid) {
          const m = await loadDiffLauncher();
          m.openDiffWindow(tmpl.templateRid, msg.rid, 'template');
        }
      });
      break;
    }

    default: break;
  }
}

// ── One-shot message handler ─────────────────────────────────────

export function handleOneShotMessage(
  msg: InspectorMessage,
  sender: chrome.runtime.MessageSender,
  sendResponse: (r: any) => void,
): boolean {
  if (msg.type === 'GET_CACHE') {
    sendResponse(handleGetCache(msg));
    return true;
  }
  if (msg.type === 'EC_EXECUTE') {
    handleEcExecute(msg, sendResponse);
    return true;
  }
  if (msg.type === 'SAVE_PROPERTY') {
    handleSaveProperty(msg, sendResponse);
    return true;
  }
  if (msg.type === 'OPEN_EDITOR') {
    openEditorWindow(msg.rid);
    return false;
  }
  if (msg.type === 'GET_SCRIPT_HISTORY') {
    sendResponse({ type: 'SCRIPT_HISTORY_DATA', entries: getCtx().scriptHistory.getAll() });
    return true;
  }
  if (msg.type === 'GET_FAVORITES') {
    sendResponse({ type: 'FAVORITES_DATA', entries: getCtx().favorites.getAll() });
    return true;
  }
  if (msg.type === 'GET_OVERLAY_PROPS') {
    const ctx = getCtx();
    const result: Record<string, Record<string, string>> = {};
    for (const rid of msg.rids) {
      const cached = ctx.cache.get(rid);
      if (cached?.properties) {
        const props: Record<string, string> = {};
        for (const [k, v] of Object.entries(cached.properties as Record<string, unknown>)) {
          if (v != null && v !== '' && typeof v === 'string') props[k] = v;
          else if (v != null && v !== '' && v !== false) props[k] = String(v);
        }
        result[rid] = props;
      }
    }
    sendResponse({ type: 'OVERLAY_PROPS_DATA', props: result });
    return true;
  }
  if (msg.type === 'OPEN_OBJECT_VIEW') {
    loadObjectViewLauncher().then(m => m.openObjectViewWindow(msg.rid)).catch(e => log.swallow('oneshot:openObjectView', e));
    return false;
  }
  if (msg.type === 'CODE_SEARCH_START') {
    loadCodeSearch().then(m => m.startCodeSearch(msg.query, msg.subtreeRid, msg.types)).catch(e => log.swallow('oneshot:codeSearch', e));
    return false;
  }
  if (msg.type === 'CODE_SEARCH_STOP') {
    loadCodeSearch().then(m => m.stopCodeSearch()).catch(e => log.swallow('oneshot:codeSearchStop', e));
    return false;
  }
  if (msg.type === 'OPEN_CODE_SEARCH') {
    loadCodeSearchLauncher().then(m => m.openCodeSearchWindow()).catch(e => log.swallow('oneshot:openCodeSearch', e));
    return false;
  }
  if (msg.type === 'FETCH_DIFF_PROPS') {
    handleFetchDiffProps(msg.rid, sendResponse);
    return true;
  }
  if (msg.type === 'OPEN_DIFF') {
    loadDiffLauncher().then(m => m.openDiffWindow(msg.leftRid, msg.rightRid)).catch(e => log.swallow('oneshot:openDiff', e));
    return false;
  }
  if (msg.type === 'OPEN_TEMPLATE_DIFF') {
    const ctx = getCtx();
    ctx.settingsReady.then(async () => {
      if (!ctx.client) return;
      const tmpl = await ctx.client.resolveTemplate(msg.rid);
      if (tmpl.templateRid) {
        const m = await loadDiffLauncher();
        m.openDiffWindow(tmpl.templateRid, msg.rid, 'template');
      }
    });
    return false;
  }
  if (msg.type === 'FULL_LOOKUP') {
    handleFullLookup(msg.rid, sendResponse);
    return true;
  }
  if (msg.type === 'DETECTION_RESULT') {
    const tabId = sender.tab?.id;
    if (tabId != null) handleContentMessage(msg, tabId);
    return false;
  }
  return false;
}


// ── Object View launcher (lazy-loaded) ──────────────────────────

async function loadCodeSearch() {
  if (!codeSearchModule) codeSearchModule = await import('./code-search');
  return codeSearchModule;
}

async function loadCodeSearchLauncher() {
  if (!codeSearchLauncher) codeSearchLauncher = await import('./codesearch-launcher');
  return codeSearchLauncher;
}

async function loadObjectViewLauncher() {
  if (!objectViewLauncher) {
    objectViewLauncher = await import('./objectview-launcher');
  }
  return objectViewLauncher;
}

async function loadDiffLauncher() {
  if (!diffLauncher) {
    diffLauncher = await import('./diff-launcher');
  }
  return diffLauncher;
}

// ── Full Lookup (for Object View page) ──────────────────────────

async function handleFullLookup(rid: string, sendResponse: (r: any) => void) {
  const ctx = getCtx();
  await ctx.settingsReady;
  try {
    const obj = await lookupObject(rid);

    // Resolve template + children (full lookup extras)
    let template: { rid: string; name: string; type: string } | undefined;
    if (ctx.client) {
      const tmpl = await ctx.client.resolveTemplate(rid);
      if (tmpl.templateRid) {
        template = { rid: tmpl.templateRid, name: tmpl.templateName ?? '', type: tmpl.templateType ?? '' };
      }
    }
    const children = ctx.client ? await ctx.client.fetchChildren(rid) : [];

    sendResponse({ type: 'FULL_LOOKUP_RESULT', rid, object: obj, template, children });
  } catch (e) {
    sendResponse({ type: 'FULL_LOOKUP_RESULT', rid, object: null, error: errorMessage(e) });
  }
}

// ── Diff property fetching ──────────────────────────────────────

async function handleFetchDiffProps(rid: string, sendResponse: (r: any) => void) {
  const ctx = getCtx();
  await ctx.settingsReady;
  if (!ctx.client) {
    sendResponse({ type: 'DIFF_PROPS_RESULT', rid, props: {}, identity: {}, error: 'Not connected' });
    return;
  }
  try {
    const identity = await ctx.client.lookupIdentity(rid);
    if (!identity) {
      sendResponse({ type: 'DIFF_PROPS_RESULT', rid, props: {}, identity: {}, error: 'Object not found' });
      return;
    }

    const type = identity.type ?? '';
    const codePropsForType = CODE_PROPS_FOR_TYPE[type] ?? [];
    const allProps = [...new Set([...COMMON_DIFF_PROPS, ...codePropsForType])];
    const props = await ctx.client.fetchCodeViaEc(rid, allProps);

    sendResponse({ type: 'DIFF_PROPS_RESULT', rid, props, identity });
  } catch (e) {
    sendResponse({ type: 'DIFF_PROPS_RESULT', rid, props: {}, identity: {}, error: errorMessage(e) });
  }
}

// ── Inspect toggle ───────────────────────────────────────────────

export async function toggleInspect() {
  const ctx = getCtx();
  ctx.inspectActive = !ctx.inspectActive;
  if (!ctx.inspectActive) incrementGeneration();
  ctx.logActivity('info', ctx.inspectActive ? 'Inspect mode ON' : 'Inspect mode OFF');
  chrome.storage.local.set({ crev_inspect_active: ctx.inspectActive }).catch(e => log.swallow('router:persistInspect', e));
  const msg: InspectorMessage = { type: 'INSPECT_STATE', active: ctx.inspectActive };

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabId = tabs[0]?.id;
  if (tabId != null) await ensureContentScript(tabId);

  ctx.broadcastToContent(msg);
  ctx.sendToPanel(msg);

  if (tabId != null) chrome.tabs.sendMessage(tabId, msg).catch(e => log.swallow('router:toggleInspectTab', e));
}
