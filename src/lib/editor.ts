import { getCtx } from './sw-context';
import { resolveTabPageContext } from './page-context-resolver';
import { log } from './logger';
import { type EditorContext, type ObjectIdentity } from '../editor/editor-types';
import { computeOverrides } from '../editor/editor-types';
import { launchFrame } from './frame-launcher';

// ── Public API ────────────────────────────────────────────────────

/** The object the BMP page is currently rendering — the real EC execution
 *  context (`this`): the object the page is bound to at runtime (e.g. the
 *  CeRiskAssessment whose detail page hosts the widget). The widget's
 *  `.location` can't give this — it returns the page/template, not the
 *  enterprise instance the template renders for.
 *
 *  Resolves the effective tab (explicit `tabId`, else the active tab of the
 *  window), then defers to the shared page-context resolver — the SAME rule the
 *  footer and Page tab use (URL deep-link wins; fiber fills routed pages).
 *  Returns undefined when there's no current page object. Defensive: never
 *  throws (tab may be gone / chrome.tabs absent in tests). */
async function getCurrentPageRid(
  target?: { tabId?: number; windowId?: number },
): Promise<string | undefined> {
  try {
    if (typeof chrome === 'undefined' || !chrome.tabs) return undefined;
    let tabId = target?.tabId;
    if (tabId == null && typeof chrome.tabs.query === 'function') {
      const q: chrome.tabs.QueryInfo = target?.windowId != null
        ? { active: true, windowId: target.windowId }
        : { active: true, lastFocusedWindow: true };
      tabId = (await chrome.tabs.query(q))[0]?.id;
    }
    if (tabId == null) return undefined;
    const rid = (await resolveTabPageContext(tabId)).rid;
    // Final BMP-shape guard for `BigInt()` safety in executeEc.
    return rid && /^-?\d+$/.test(rid) ? rid : undefined;
  } catch {
    return undefined;
  }
}

/** Resolve the identity of the EC execution context for the header chip.
 *  Cache-first (the page object is almost always already enriched), with a
 *  lookup fallback. Returns undefined when there's no distinct context (no
 *  rid, or it's the widget itself) so the chip simply doesn't render. */
async function resolveContextIdentity(
  contextRid: string | undefined,
  instanceRid: string,
): Promise<ObjectIdentity | undefined> {
  if (!contextRid || contextRid === instanceRid) return undefined;
  const swCtx = getCtx();
  const cached = swCtx.cache.get(contextRid);
  if (cached?.type || cached?.name) {
    return { rid: contextRid, businessId: cached.businessId ?? '', type: cached.type ?? '', name: cached.name ?? '' };
  }
  if (swCtx.client) {
    try {
      const id = await swCtx.client.lookupIdentity(contextRid);
      if (id) return { rid: contextRid, businessId: id.businessId ?? '', type: id.type ?? '', name: id.name ?? '' };
    } catch (e) {
      log.swallow('editor:resolveContext', e);
    }
  }
  // Rid known but identity unresolved — still surface it (rid-only chip).
  return { rid: contextRid, businessId: '', type: '', name: '' };
}

export async function openEditorWindow(
  rid: string,
  preferredProperty?: string,
  target?: { tabId?: number; windowId?: number },
  opts?: { scrollToLine?: number; scrollToText?: string },
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

  // Resolve the EC execution context (`this`). The object the BMP page is
  // currently rendering (`?rid=`) is the real runtime context — for an
  // enterprise detail page that's the enterprise instance, NOT the
  // page/template that `.location` returns. Fall back to `.location`, then
  // (via getExecutionRid) the widget itself.
  const pageRid = await getCurrentPageRid(target);
  const executionContextRid = pageRid ?? editorData.locationRid;
  const executionContext = await resolveContextIdentity(executionContextRid, instance.rid);

  const ctx: EditorContext = {
    instance,
    template,
    instanceCode,
    templateCode,
    overrides: template ? computeOverrides(instanceCode, templateCode) : {},
    saveTarget: swCtx.settings.saveTarget,
    property,
    executionContextRid,
    executionContext,
    useLookup: swCtx.client?.supportsLookup !== false,
    scrollToLine: opts?.scrollToLine,
    scrollToText: opts?.scrollToText,
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

/** Open a standalone Extended Code overlay bound to the page's execution
 *  context. When the caller doesn't pass an explicit `pageRid`, it's resolved
 *  through the shared resolver — so the console gets the right `this` on BMP's
 *  custom-routed pages (where the URL has no `?rid=`) instead of opening
 *  contextless. */
export async function openExtendedWindow(
  pageRidOverride?: string,
  target?: { tabId?: number; windowId?: number },
  initialCode?: string,
) {
  const swCtx = getCtx();
  await swCtx.settingsReady;

  const pageRid = pageRidOverride ?? await getCurrentPageRid(target);

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
    ...(initialCode ? { initialCode } : {}),
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
