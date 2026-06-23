/**
 * CVO Studio handlers — opens the CustomVisualization studio overlay.
 * Save/preview reuse the EC handlers (SAVE_PROPERTY routes html/javascript
 * through saveCodeViaEc), so this only owns the open gesture for now.
 */
import { register } from '../handler-registry'
import { getCtx } from '../sw-context'
import { openCvoStudioWindow } from '../cvo-studio'
import { errorMessage, log } from '../logger'

register('OPEN_CVO_STUDIO', (msg, _respond, meta) => {
  openCvoStudioWindow(msg.rid, msg.property, { tabId: meta.senderTabId, windowId: meta.panelWindowId })
    .catch(e => log.swallow('handler:openCvoStudio', e))
  const ctx = getCtx()
  const cached = ctx.cache.get(msg.rid)
  if (cached) {
    ctx.history.record({ rid: msg.rid, name: cached.name, type: cached.type, businessId: cached.businessId, action: 'edited', timestamp: Date.now() })
  }
})

register('STUDIO_FETCH_CODE', async (msg, respond) => {
  const ctx = getCtx()
  if (!ctx.client) { respond({ type: 'STUDIO_CODE_DATA', ok: false, error: 'Not connected' }); return }
  try {
    const code = await ctx.client.fetchCodeViaEc(msg.rid, ['html', 'javascript'])
    respond({ type: 'STUDIO_CODE_DATA', ok: true, code })
  } catch (e) {
    respond({ type: 'STUDIO_CODE_DATA', ok: false, error: errorMessage(e) })
  }
})

register('STUDIO_FETCH_DATA', async (msg, respond) => {
  const ctx = getCtx()
  if (!ctx.client) { respond({ type: 'STUDIO_DATA', ok: false, error: 'Not connected' }); return }
  const r = await ctx.client.cvoData(msg.cvoRid, msg.businessObjectRid, 'M', msg.periodMillis)
  respond({ type: 'STUDIO_DATA', ok: r.ok, data: r.data, error: r.error, status: r.status })
})
