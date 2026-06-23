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
import { STUDIO_CTX_PREFIX, type StudioContext, type StudioCodeProp } from '../studio/studio-types'

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

  const ctx: StudioContext = {
    instance,
    template,
    instanceCode,
    templateCode,
    saveTarget: swCtx.settings.saveTarget,
    property,
  }

  await chrome.storage.local.set({ [`${STUDIO_CTX_PREFIX}${rid}`]: ctx })

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
