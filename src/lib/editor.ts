import { TYPES_WITH_CODE, CODE_PROPS_FOR_TYPE } from './types';
import { getCtx } from './sw-context';
import { log } from './logger';

/** Track open editor windows by RID to prevent duplicates */
const openEditorWindows = new Map<string, number>();

/** Fetch code properties via EC (handles CorpoExpression types transparently) */
async function fetchCodePropsViaEc(rid: string, type: string): Promise<Record<string, string>> {
  const ctx = getCtx();
  if (!ctx.client) return {};
  const propsToFetch = CODE_PROPS_FOR_TYPE[type];
  if (!propsToFetch) return {};
  return ctx.client.fetchCodeViaEc(rid, [...propsToFetch]);
}

export async function openEditorWindow(rid: string) {
  const ctx = getCtx();
  await ctx.settingsReady;

  // 1. Fetch identity + resolve template in parallel (both are independent EC calls)
  let name = '';
  let type = '';
  let businessId = '';
  let templateRid: string | undefined;
  let templateName: string | undefined;
  let templateType: string | undefined;
  let templateCodeProps: Record<string, string> | undefined;

  if (ctx.client) {
    const [identity, tmpl] = await Promise.all([
      ctx.client.lookupIdentity(rid),
      ctx.client.resolveTemplate(rid),
    ]);

    if (identity) {
      name = identity.name ?? '';
      type = identity.type ?? '';
      businessId = identity.businessId ?? '';
    }

    if (tmpl.templateRid) {
      templateRid = tmpl.templateRid;
      templateName = tmpl.templateName;
      templateType = tmpl.templateType ?? type;

      // Fetch template code via EC
      const tmplEcProps = await fetchCodePropsViaEc(tmpl.templateRid, templateType ?? type);
      if (Object.keys(tmplEcProps).length > 0) {
        templateCodeProps = tmplEcProps;
      }
    }
  }

  // Fall back to cache if EC didn't return data
  if (!type) {
    const cached = ctx.cache.get(rid);
    if (cached) {
      name = name || cached.name || '';
      type = cached.type || '';
      businessId = businessId || cached.businessId || '';
    }
  }

  // 2. Fetch instance code properties via EC
  let codeProps: Record<string, string> = {};
  if (ctx.client && TYPES_WITH_CODE.has(type)) {
    codeProps = await fetchCodePropsViaEc(rid, type);
  }

  // 3. Extract primary property and code
  let property = Object.keys(codeProps)[0] ?? 'expression';
  let code = codeProps[property] ?? '';

  // 4. If instance code is empty and template code exists, use template code as initial content
  if (!code && templateCodeProps && Object.keys(templateCodeProps).length > 0) {
    const tmplProperty = Object.keys(templateCodeProps)[0];
    code = templateCodeProps[tmplProperty];
    property = tmplProperty;
    codeProps = { ...templateCodeProps, ...codeProps };
  }

  // Focus existing editor window for this RID if one is already open
  const existingWinId = openEditorWindows.get(rid);
  if (existingWinId != null) {
    try {
      // Update context before focusing so editor has latest data
      await chrome.storage.local.set({
        [`crev_editor_ctx_${rid}`]: {
          rid, type, name, businessId, property, code, codeProps,
          templateRid, templateName, templateType, templateCodeProps,
          saveTarget: ctx.settings.saveTarget,
        },
      });
      await chrome.windows.update(existingWinId, { focused: true });
      return;
    } catch (e) {
      log.swallow('editor:focusExisting', e);
      openEditorWindows.delete(rid);
    }
  }

  // Store context for editor page (per-RID key)
  await chrome.storage.local.set({
    [`crev_editor_ctx_${rid}`]: {
      rid, type, name, businessId, property, code, codeProps,
      templateRid, templateName, templateType, templateCodeProps,
      saveTarget: ctx.settings.saveTarget,
    },
  });

  // Open editor window with remembered bounds + RID in hash
  const stored = await chrome.storage.local.get('crev_editor_bounds');
  const bounds = (stored.crev_editor_bounds ?? {}) as Record<string, number | undefined>;

  const win = await chrome.windows.create({
    type: 'popup',
    url: chrome.runtime.getURL(`editor/editor.html#${rid}`),
    width: bounds.width ?? 720,
    height: bounds.height ?? 540,
    left: bounds.left,
    top: bounds.top,
  });

  if (win?.id != null) {
    const winId = win.id;
    openEditorWindows.set(rid, winId);
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
      openEditorWindows.delete(rid);
      // Clean up per-RID context on window close
      chrome.storage.local.remove(`crev_editor_ctx_${rid}`).catch(e => log.swallow('editor:cleanupCtx', e));
      chrome.windows.onBoundsChanged.removeListener(onBoundsChanged);
      chrome.windows.onRemoved.removeListener(onRemoved);
    };

    chrome.windows.onBoundsChanged.addListener(onBoundsChanged);
    chrome.windows.onRemoved.addListener(onRemoved);
  }
}

/** Open a standalone Extended Code window with optional page context */
export async function openExtendedWindow(pageRid?: string) {
  const ctx = getCtx();
  await ctx.settingsReady;

  let name = '';
  let type = '';
  let objectRid = pageRid;

  // Resolve page object identity for context display
  if (pageRid && ctx.client) {
    const identity = await ctx.client.lookupIdentity(pageRid).catch(() => null);
    if (identity) {
      name = identity.name ?? '';
      type = identity.type ?? '';
    } else {
      const cached = ctx.cache.get(pageRid);
      if (cached) {
        name = cached.name ?? '';
        type = cached.type ?? '';
      }
    }
  }

  const key = 'extended';

  // Focus existing extended window if open
  const existingWinId = openEditorWindows.get(key);
  if (existingWinId != null) {
    try {
      await chrome.storage.local.set({
        crev_editor_ctx_extended: {
          rid: pageRid ?? '', type, name, businessId: '',
          property: null, code: '', codeProps: {},
          objectRid, extended: true,
          saveTarget: ctx.settings.saveTarget,
        },
      });
      await chrome.windows.update(existingWinId, { focused: true });
      return;
    } catch (e) {
      log.swallow('editor:focusExtended', e);
      openEditorWindows.delete(key);
    }
  }

  await chrome.storage.local.set({
    crev_editor_ctx_extended: {
      rid: pageRid ?? '', type, name, businessId: '',
      property: null, code: '', codeProps: {},
      objectRid, extended: true,
      saveTarget: ctx.settings.saveTarget,
    },
  });

  const stored = await chrome.storage.local.get('crev_editor_bounds');
  const bounds = (stored.crev_editor_bounds ?? {}) as Record<string, number | undefined>;

  const win = await chrome.windows.create({
    type: 'popup',
    url: chrome.runtime.getURL('editor/editor.html#extended'),
    width: bounds.width ?? 720,
    height: bounds.height ?? 540,
    left: bounds.left,
    top: bounds.top,
  }).catch(e => { log.swallow('editor:createExtended', e); return null; });

  if (win?.id != null) {
    const winId = win.id;
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
      chrome.storage.local.remove('crev_editor_ctx_extended').catch(e => log.swallow('editor:cleanupExtended', e));
      chrome.windows.onBoundsChanged.removeListener(onBoundsChanged);
      chrome.windows.onRemoved.removeListener(onRemoved);
    };

    chrome.windows.onBoundsChanged.addListener(onBoundsChanged);
    chrome.windows.onRemoved.addListener(onRemoved);
  }
}
