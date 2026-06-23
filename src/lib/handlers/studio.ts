/**
 * CVO Studio handlers — opens the CustomVisualization studio overlay.
 * Save/preview reuse the EC handlers (SAVE_PROPERTY routes html/javascript
 * through saveCodeViaEc), so this only owns the open gesture for now.
 */
import { register } from '../handler-registry'
import { getCtx } from '../sw-context'
import { openCvoStudioWindow } from '../cvo-studio'
import { log } from '../logger'

register('OPEN_CVO_STUDIO', (msg, _respond, meta) => {
  openCvoStudioWindow(msg.rid, msg.property, { tabId: meta.senderTabId, windowId: meta.panelWindowId })
    .catch(e => log.swallow('handler:openCvoStudio', e))
  const ctx = getCtx()
  const cached = ctx.cache.get(msg.rid)
  if (cached) {
    ctx.history.record({ rid: msg.rid, name: cached.name, type: cached.type, businessId: cached.businessId, action: 'edited', timestamp: Date.now() })
  }
})
