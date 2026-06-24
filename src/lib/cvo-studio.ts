/**
 * SW-side launcher for the CVO Studio overlay — the CustomVisualization
 * sibling of openEditorWindow(). Fetches the CVO's html + javascript in one EC
 * call, stashes a lean StudioContext in chrome.storage.local, and mounts the
 * studio iframe overlay on the target tab (same frame-overlay path as the
 * editor). Save flows back through the existing SAVE_PROPERTY handler.
 */
import { getCtx } from './sw-context'
import { log } from './logger'
import { launchFrame } from './frame-launcher'
import { resolveTabPageContext } from './page-context-resolver'
import { STUDIO_CTX_PREFIX, type StudioContext, type StudioCodeProp } from '../studio/studio-types'

/** The object the BMP page is currently rendering — the default render context
 *  for the live-`_data` fetch (the data servlet is gated on it being org-rooted).
 *  Mirrors the editor's getCurrentPageRid; defensive (tab may be gone / no
 *  chrome.tabs in tests). Returns undefined when there's no current page object. */
async function getRenderContextRid(target?: { tabId?: number; windowId?: number }): Promise<string | undefined> {
  try {
    if (typeof chrome === 'undefined' || !chrome.tabs) return undefined
    let tabId = target?.tabId
    if (tabId == null && typeof chrome.tabs.query === 'function') {
      const q: chrome.tabs.QueryInfo = target?.windowId != null
        ? { active: true, windowId: target.windowId }
        : { active: true, lastFocusedWindow: true }
      tabId = (await chrome.tabs.query(q))[0]?.id
    }
    if (tabId == null) return undefined
    const rid = (await resolveTabPageContext(tabId)).rid
    return rid && /^-?\d+$/.test(rid) ? rid : undefined
  } catch {
    return undefined
  }
}

const CVO_CODE_PROPS: readonly StudioCodeProp[] = ['html', 'javascript']

export async function openCvoStudioWindow(
  rid: string,
  preferredProperty?: string,
  target?: { tabId?: number; windowId?: number },
): Promise<void> {
  const swCtx = getCtx()
  await swCtx.settingsReady

  // One EC round-trip: identity + template + the html/javascript code maps.
  let data: import('./bmp-client').EditorContextData | null = null
  if (swCtx.client) {
    try {
      data = await swCtx.client.fetchEditorContext(rid, [...CVO_CODE_PROPS])
    } catch (e) {
      log.swallow('cvo-studio:fetchContext', e)
    }
  }

  if (!data) {
    const cached = swCtx.cache.get(rid)
    data = {
      instance: { rid, businessId: cached?.businessId ?? '', type: cached?.type ?? '', name: cached?.name ?? '' },
      template: null,
      instanceCode: {},
      templateCode: {},
    }
  }

  const { instance, template, instanceCode, templateCode } = data
  const property: StudioCodeProp = preferredProperty === 'javascript' ? 'javascript' : 'html'
  const renderContextRid = await getRenderContextRid(target)

  const ctx: StudioContext = {
    instance,
    template,
    instanceCode,
    templateCode,
    saveTarget: swCtx.settings.saveTarget,
    property,
    renderContextRid,
  }

  // Stash the context for the studio page to read on load. A CVO's html+js can
  // be hundreds of KB, so clear any stale studio contexts first (read-once
  // handoff — bounds storage growth to the one we're about to open) and guard
  // the write so a full quota surfaces a clear error instead of launching a
  // studio that loads into "No CVO context found".
  try {
    const all = await chrome.storage.local.get(null)
    const stale = Object.keys(all).filter(k => k.startsWith(STUDIO_CTX_PREFIX))
    if (stale.length) await chrome.storage.local.remove(stale)
    await chrome.storage.local.set({ [`${STUDIO_CTX_PREFIX}${rid}`]: ctx })
  } catch (e) {
    log.swallow('cvo-studio:stashContext', e)
    throw new Error('Could not open the CVO studio: browser storage is full. Clear some space and try again.')
  }

  const label = instance.name
    ? `CVO · ${instance.name}`
    : `CVO Studio · ${instance.businessId || rid}`
  await launchFrame({
    kind: 'cvo-studio',
    path: `studio/studio.html#${rid}`,
    label,
    defaultWidth: 1100,
    defaultHeight: 720,
    tabId: target?.tabId,
    windowId: target?.windowId,
  })
}
