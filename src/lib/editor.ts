import { getCtx } from './sw-context';
import { log } from './logger';
import { type EditorContext } from '../editor/editor-types';
import { computeOverrides } from '../editor/editor-types';
import { launchFrame } from './frame-launcher';

// ── Public API ────────────────────────────────────────────────────

export async function openEditorWindow(
  rid: string,
  preferredProperty?: string,
  target?: { tabId?: number; windowId?: number },
  opts?: { scrollToLine?: number },
) {
  const swCtx = getCtx();
  await swCtx.settingsReady;

  // Single EC call: identity + template + all code properties
  let editorData: import('../lib/bmp-client').EditorContextData | null = null;
  if (swCtx.client) {
    try {
      // Pass the caller's requested property so it's fetched too — otherwise
      // Edit on e.g. afterExpression / showExpression / initExpression would
      // open `expression` (the property wasn't in the fetched code map).
      editorData = await swCtx.client.fetchEditorContext(rid, preferredProperty ? [preferredProperty] : []);
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

  // Determine initial property — caller hint first, then instance, then template.
  // Caller hint is honored only if the property actually has content on the
  // instance or template, otherwise it'd open an empty tab.
  const hintValid = preferredProperty && (instanceCode[preferredProperty] || templateCode[preferredProperty]);
  const property = hintValid
    ? preferredProperty!
    : (Object.keys(instanceCode)[0] ?? Object.keys(templateCode)[0] ?? 'expression');

  const ctx: EditorContext = {
    instance,
    template,
    instanceCode,
    templateCode,
    overrides: template ? computeOverrides(instanceCode, templateCode) : {},
    saveTarget: swCtx.settings.saveTarget,
    property,
    executionContextRid: editorData.locationRid,
    useLookup: swCtx.client?.supportsLookup !== false,
    scrollToLine: opts?.scrollToLine,
  };

  const storageKey = `crev_editor_ctx_${rid}`;
  await chrome.storage.local.set({ [storageKey]: ctx });

  const label = instance.name
    ? `${instance.type || 'Object'} · ${instance.name}`
    : `Editor · ${instance.businessId || rid}`;
  await launchFrame({
    kind: 'editor',
    path: `editor/editor.html#${rid}`,
    label,
    defaultWidth: 960,
    defaultHeight: 640,
    tabId: target?.tabId,
    windowId: target?.windowId,
  });
}

/** Open a standalone Extended Code overlay with optional page context */
export async function openExtendedWindow(pageRid?: string, target?: { tabId?: number; windowId?: number }) {
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
    useLookup: swCtx.client?.supportsLookup !== false,
  };

  await chrome.storage.local.set({ crev_editor_ctx_extended: ctx });
  await launchFrame({
    kind: 'editor',
    path: 'editor/editor.html#extended',
    label: name ? `Extended Code · ${name}` : 'Extended Code',
    defaultWidth: 960,
    defaultHeight: 640,
    tabId: target?.tabId,
    windowId: target?.windowId,
  });
}
