import { getCtx } from './sw-context';
import { log } from './logger';
import { type EditorContext } from '../editor/editor-types';
import { computeOverrides } from '../editor/editor-types';

/** Track open editor windows by RID to prevent duplicates */
const openEditorWindows = new Map<string, number>();

// ── Shared window helpers ─────────────────────────────────────────

function wireWindowLifecycle(winId: number, key: string, cleanupKey: string) {
  openEditorWindows.set(key, winId);
  let boundsTimer: ReturnType<typeof setTimeout> | undefined;

  const onBoundsChanged = (window: chrome.windows.Window) => {
    if (window.id !== winId) return;
    if (boundsTimer) clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      chrome.storage.local.set({
        crev_editor_bounds: { width: window.width, height: window.height, left: window.left, top: window.top },
      }).catch(e => log.swallow('editor:persistBounds', e));
    }, 500);
  };

  const onRemoved = (removedId: number) => {
    if (removedId !== winId) return;
    openEditorWindows.delete(key);
    chrome.storage.local.remove(cleanupKey).catch(e => log.swallow('editor:cleanupCtx', e));
    chrome.windows.onBoundsChanged.removeListener(onBoundsChanged);
    chrome.windows.onRemoved.removeListener(onRemoved);
  };

  chrome.windows.onBoundsChanged.addListener(onBoundsChanged);
  chrome.windows.onRemoved.addListener(onRemoved);
}

async function openOrFocusWindow(key: string, storageKey: string, ctx: EditorContext, hashFragment: string) {
  // Focus existing window if open
  const existingWinId = openEditorWindows.get(key);
  if (existingWinId != null) {
    try {
      await chrome.storage.local.set({ [storageKey]: ctx });
      await chrome.windows.update(existingWinId, { focused: true });
      return;
    } catch (e) {
      log.swallow('editor:focusExisting', e);
      openEditorWindows.delete(key);
    }
  }

  // Store context and open new window
  await chrome.storage.local.set({ [storageKey]: ctx });

  const stored = await chrome.storage.local.get('crev_editor_bounds');
  const bounds = (stored.crev_editor_bounds ?? {}) as Record<string, number | undefined>;

  const win = await chrome.windows.create({
    type: 'popup',
    url: chrome.runtime.getURL(`editor/editor.html#${hashFragment}`),
    width: bounds.width ?? 720,
    height: bounds.height ?? 540,
    left: bounds.left,
    top: bounds.top,
  }).catch(e => { log.swallow('editor:createWindow', e); return null; });

  if (win?.id != null) {
    wireWindowLifecycle(win.id, key, storageKey);
  }
}

// ── Public API ────────────────────────────────────────────────────

export async function openEditorWindow(rid: string) {
  const swCtx = getCtx();
  await swCtx.settingsReady;

  // Single EC call: identity + template + all code properties
  let editorData: import('../lib/bmp-client').EditorContextData | null = null;
  if (swCtx.client) {
    try {
      editorData = await swCtx.client.fetchEditorContext(rid);
    } catch (e) {
      log.swallow('editor:fetchContext', e);
    }
  }

  // Fall back to cache for identity if EC failed or threw
  if (!editorData) {
    const cached = swCtx.cache.get(rid);
    editorData = {
      instance: {
        rid,
        businessId: cached?.businessId ?? '',
        type: cached?.type ?? '',
        name: cached?.name ?? '',
      },
      template: null,
      instanceCode: {},
      templateCode: {},
    };
  }

  const { instance, template, instanceCode, templateCode } = editorData;

  // Determine initial property — prefer instance, fall back to template
  let property = Object.keys(instanceCode)[0] ?? Object.keys(templateCode)[0] ?? 'expression';

  const ctx: EditorContext = {
    instance,
    template,
    instanceCode,
    templateCode,
    overrides: template ? computeOverrides(instanceCode, templateCode) : {},
    saveTarget: swCtx.settings.saveTarget,
    property,
    executionContextRid: editorData.locationRid,
  };

  const storageKey = `crev_editor_ctx_${rid}`;
  await openOrFocusWindow(rid, storageKey, ctx, rid);
}

/** Open a standalone Extended Code window with optional page context */
export async function openExtendedWindow(pageRid?: string) {
  const swCtx = getCtx();
  await swCtx.settingsReady;

  let name = '';
  let type = '';
  let businessId = '';

  // Resolve page object identity for context display
  if (pageRid && swCtx.client) {
    const identity = await swCtx.client.lookupIdentity(pageRid).catch(() => null);
    if (identity) {
      name = identity.name ?? '';
      type = identity.type ?? '';
      businessId = identity.businessId ?? '';
    } else {
      const cached = swCtx.cache.get(pageRid);
      if (cached) {
        name = cached.name ?? '';
        type = cached.type ?? '';
        businessId = cached.businessId ?? '';
      }
    }
  }

  const ctx: EditorContext = {
    instance: { rid: pageRid ?? '', businessId, type, name },
    template: null,
    instanceCode: {},
    templateCode: {},
    overrides: {},
    saveTarget: swCtx.settings.saveTarget,
    property: null,
    extended: true,
    executionContextRid: pageRid,
  };

  const storageKey = 'crev_editor_ctx_extended';
  await openOrFocusWindow('extended', storageKey, ctx, 'extended');
}
