/**
 * Unified message router — eliminates duplication between port and one-shot handlers.
 */

import type { InspectorMessage } from './types';
import { SCRIPT_PROPS, CODE_PROPS_FOR_TYPE } from './types';
import { getCtx } from './sw-context';
import { enrichBadges, resetEnrichment, refreshEnrichment, incrementGeneration } from './enrichment';
import { togglePaint, handlePaintPick, handlePaintApply, handlePaintConfirm } from './paint';
import { openEditorWindow } from './editor';
import { runAuthTest, pushConnectionState } from './connection';
import { getTabDetection, setTabDetection, updateBadge } from './detection';
import { saveSettings, rebuildClient, setManualOverride } from './settings';
import { sendPageInfoToPanel, handleGetDetection, ensureContentScript } from './tab-awareness';
import { getActivityLog } from './activity';
import { log, errorMessage } from './logger';

import type { DetectionPhase } from './types';

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
        .then(result => respond({ type: 'EC_RESULT', ...result }))
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

export function handleServerLookup(rid: string) {
  const ctx = getCtx();
  ctx.settingsReady.then(async () => {
    if (!ctx.client) {
      ctx.sendToPanel({ type: 'SERVER_LOOKUP_RESULT', rid, object: null, error: 'Not connected' });
      return;
    }
    try {
      const identity = await ctx.client.lookupIdentity(rid);
      if (!identity) {
        ctx.sendToPanel({ type: 'SERVER_LOOKUP_RESULT', rid, object: null, error: 'Object not found' });
        return;
      }

      const now = Date.now();
      const properties: Record<string, unknown> = {};

      const type = identity.type ?? '';
      const propsToFetch = CODE_PROPS_FOR_TYPE[type];
      if (propsToFetch) {
        const codeProps = await ctx.client.fetchCodeViaEc(rid, [...propsToFetch]);
        Object.assign(properties, codeProps);
      }

      const obj = {
        rid,
        name: identity.name,
        type: identity.type,
        businessId: identity.businessId,
        properties,
        source: 'server' as const,
        discoveredAt: now,
        updatedAt: now,
      };

      ctx.cache.put(obj);
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

    case 'ENRICH_BADGES':
      ctx.settingsReady.then(() => enrichBadges(msg.rids));
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
      const profiles = ctx.settings.profiles.filter(p => p.id !== msg.profileId);
      let activeId = ctx.settings.activeProfileId;
      if (activeId === msg.profileId) {
        activeId = profiles[0]?.id ?? '';
      }
      ctx.settings = { ...ctx.settings, profiles, activeProfileId: activeId };
      saveSettings();
      rebuildClient(true);
      ctx.sendToPanel({ type: 'SETTINGS_DATA', settings: ctx.settings });
      break;
    }

    case 'SET_ACTIVE_PROFILE': {
      if (ctx.settings.activeProfileId !== msg.profileId) {
        ctx.settings = { ...ctx.settings, activeProfileId: msg.profileId };
        setManualOverride();
        saveSettings();
        rebuildClient(true);
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

    case 'OPEN_EDITOR':
      openEditorWindow(msg.rid);
      break;

    case 'TOGGLE_PAINT':
      togglePaint(ensureContentScript);
      break;

    case 'SAVE_PROPERTY':
      handleSaveProperty(msg, r => ctx.sendToPanel({ type: 'SAVE_RESULT', ...r }));
      break;

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
  if (msg.type === 'DETECTION_RESULT') {
    const tabId = sender.tab?.id;
    if (tabId != null) handleContentMessage(msg, tabId);
    return false;
  }
  return false;
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
