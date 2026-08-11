import { getCtx } from './sw-context';
import { resolveTabPageContext } from './page-context-resolver';
import { log } from './logger';
import { type EditorContext, type ObjectIdentity } from '../editor/editor-types';
import { computeOverrides } from '../editor/editor-types';
import { launchFrame, resolveFrameTargetTabId } from './frame-launcher';
import {
  beginEditorLaunchSession,
  failEditorLaunchContext,
  publishEditorLaunchContext,
} from './editor-launch-session';
import { ENVIRONMENT_CHANGED_ERROR, environmentToken } from './environment';

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

/** Resolve launch-time decoration for the EC execution-context chip. Keep this
 *  cache-only: a missing label must not add another serialized BMP command to
 *  editor startup. The RID still renders and can be enriched elsewhere. */
function resolveContextIdentity(
  contextRid: string | undefined,
  instanceRid: string,
): ObjectIdentity | undefined {
  if (!contextRid || contextRid === instanceRid) return undefined;
  const swCtx = getCtx();
  const cached = swCtx.cache.get(contextRid);
  if (cached?.type || cached?.name) {
    return { rid: contextRid, businessId: cached.businessId ?? '', type: cached.type ?? '', name: cached.name ?? '' };
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
  const targetTabId = await resolveFrameTargetTabId(target);
  if (targetTabId == null) {
    log.warn('editor:noTargetTab', 'No active tab is available for the editor launch');
    return;
  }
  const frozenTarget = { tabId: targetTabId };
  const cached = swCtx.cache.get(rid);
  const loadingContext: EditorContext = {
    environment: environmentToken(swCtx),
    instance: {
      rid,
      businessId: cached?.businessId ?? '',
      type: cached?.type ?? '',
      name: cached?.name ?? '',
    },
    template: null,
    instanceCode: {},
    templateCode: {},
    overrides: {},
    saveTarget: swCtx.settings.saveTarget,
    property: preferredProperty ?? 'expression',
    loading: true,
    scrollToLine: opts?.scrollToLine,
    scrollToText: opts?.scrollToText,
  };

  // Start the BMP request before the local handoff. Once the placeholder is
  // stored, the iframe can mount immediately and wait for this same key to be
  // replaced with the authoritative context.
  const contextPromise = buildEditorContext(rid, preferredProperty, frozenTarget, opts);
  const launchSession = await beginEditorLaunchSession(rid, loadingContext);

  const label = cached?.name
    ? `${cached.type || 'Object'} · ${cached.name}`
    : `Editor · ${cached?.businessId || rid}`;
  const launchPromise = launchFrame({
    kind: 'editor',
    path: launchSession.path,
    label,
    defaultWidth: 960,
    defaultHeight: 640,
    resourceKey: `editor:${rid}`,
    activation: {
      type: 'editor',
      rid,
      property: preferredProperty,
      scrollToLine: opts?.scrollToLine,
      scrollToText: opts?.scrollToText,
    },
    tabId: targetTabId,
  });

  try {
    const ctx = await contextPromise;
    await publishEditorLaunchContext(launchSession, ctx);
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Failed to load code from BMP';
    await failEditorLaunchContext(launchSession, loadingContext, message);
  }
  await launchPromise;
}

/** Fetch and compose the complete editor context without opening a frame.
 *  Used both for initial launch and the in-window Retry action. */
export async function buildEditorContext(
  rid: string,
  preferredProperty?: string,
  target?: { tabId?: number; windowId?: number },
  opts?: { scrollToLine?: number; scrollToText?: string },
): Promise<EditorContext> {
  const swCtx = getCtx();
  await swCtx.settingsReady;
  const environment = environmentToken(swCtx);
  const client = swCtx.client;
  const saveTarget = swCtx.settings.saveTarget;
  // Page-context detection is independent of the BMP editor query. Starting it
  // now removes a tabs/page-resolution waterfall after the server response.
  const pageRidPromise = getCurrentPageRid(target);

  // Single EC call: identity + template + all code properties
  let editorData: import('../lib/bmp-client').EditorContextData | null = null;
  let loadError: string | undefined;
  if (client) {
    try {
      // Pass the caller's requested property so it's fetched too — otherwise
      // Edit on e.g. afterExpression / showExpression / initExpression would
      // open `expression` (the property wasn't in the fetched code map).
      editorData = await client.fetchEditorContext(rid, preferredProperty ? [preferredProperty] : []);
    } catch (e) {
      log.swallow('editor:fetchContext', e);
      loadError = e instanceof Error ? e.message : 'Failed to load code from BMP';
    }
  } else {
    loadError = 'No BMP connection is available';
  }
  if (environmentToken(swCtx) !== environment) throw new Error(ENVIRONMENT_CHANGED_ERROR);

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
    loadError ??= 'BMP returned no editor context';
  }

  const { instance, template, instanceCode, templateCode } = editorData;

  // Determine initial property — caller hint first, then instance, then template.
  // Caller-requested fields are retained in the fetched maps even when empty,
  // allowing an explicit Create action to open a new code value safely.
  const hintValid = preferredProperty
    && (Object.prototype.hasOwnProperty.call(instanceCode, preferredProperty)
      || Object.prototype.hasOwnProperty.call(templateCode, preferredProperty));
  const property = hintValid
    ? preferredProperty!
    : (Object.keys(instanceCode)[0] ?? Object.keys(templateCode)[0] ?? 'expression');

  // Resolve the EC execution context (`this`). The object the BMP page is
  // currently rendering (`?rid=`) is the real runtime context — for an
  // enterprise detail page that's the enterprise instance, NOT the
  // page/template that `.location` returns. Fall back to `.location`, then
  // (via getExecutionRid) the widget itself.
  const pageRid = await pageRidPromise;
  const executionContextRid = pageRid ?? editorData.locationRid;
  const executionContext = resolveContextIdentity(executionContextRid, instance.rid);
  if (environmentToken(swCtx) !== environment) throw new Error(ENVIRONMENT_CHANGED_ERROR);

  const ctx: EditorContext = {
    environment,
    instance,
    template,
    instanceCode,
    templateCode,
    overrides: template ? computeOverrides(instanceCode, templateCode) : {},
    saveTarget,
    property,
    loadError,
    executionContextRid,
    executionContext,
    useLookup: client?.supportsLookup !== false,
    scrollToLine: opts?.scrollToLine,
    scrollToText: opts?.scrollToText,
  };
  return ctx;
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
  const environment = environmentToken(swCtx);
  const client = swCtx.client;

  const pageRid = pageRidOverride ?? await getCurrentPageRid(target);

  let name = '';
  let type = '';
  let businessId = '';
  let templateBusinessId: string | undefined;

  // The scratch window needs identity only for its title/context chip. Keep
  // startup strictly cache-only: a cosmetic BMP lookup would occupy the
  // serialized command channel and could delay the editor's first Preview/Run.
  // The execution RID remains available even when the decoration is sparse.
  if (pageRid) {
    const cached = swCtx.cache.get(pageRid);
    if (cached?.name || cached?.type || cached?.businessId) {
      name = cached.name ?? '';
      type = cached.type ?? '';
      businessId = cached.businessId ?? '';
      templateBusinessId = cached.templateBusinessId;
    }
  }
  if (environmentToken(swCtx) !== environment) throw new Error(ENVIRONMENT_CHANGED_ERROR);

  const ctx: EditorContext = {
    environment,
    instance: {
      rid: pageRid ?? '',
      businessId,
      type,
      name,
      ...(templateBusinessId ? { templateBusinessId } : {}),
    },
    template: null,
    instanceCode: {},
    templateCode: {},
    overrides: {},
    saveTarget: swCtx.settings.saveTarget,
    property: null,
    extended: true,
    ...(initialCode ? { initialCode } : {}),
    executionContextRid: pageRid,
    useLookup: client?.supportsLookup !== false,
  };

  await chrome.storage.local.set({ crev_editor_ctx_extended: ctx });
  await launchFrame({
    kind: 'editor',
    path: 'editor/editor.html#extended',
    label: name ? `Extended Code · ${name}` : 'Extended Code',
    defaultWidth: 960,
    defaultHeight: 640,
    resourceKey: 'editor:extended',
    // A code handoff is a new scratch document, not merely a request to focus
    // the existing one. Replacing it must therefore use the dirty guard.
    replaceExisting: !!initialCode,
    tabId: target?.tabId,
    windowId: target?.windowId,
  });
}
