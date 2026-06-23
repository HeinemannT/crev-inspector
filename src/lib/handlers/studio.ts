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

// ── CVO data-input children (CustomVisualizationExpression) ──────────────────
// References by businessId (rids exceed JS safe-int). Field/row delimiters are
// control chars (U+0001 / U+0002) — collision-free for arbitrary expression
// text — and `.whenMissing("")` keeps non-expression children from injecting
// "Missing value" warning text. Mirrors the listAccessSubjects accumulator idiom.
const FIELD = '\u0001'
const ROW = '\u0002'
const ident = (s: string) => s.replace(/[^\w-]/g, '') // identifier-safe; guards EC string injection

register('STUDIO_FETCH_CHILDREN', async (msg, respond) => {
  const ctx = getCtx()
  if (!ctx.client) { respond({ type: 'STUDIO_CHILDREN', ok: false, error: 'Not connected' }); return }
  const code = [
    `_r := SELECT CustomVisualization WHERE id = "${ident(msg.cvoBid)}"`,
    `_c := _r.first()`,
    `_out := ""`,
    `_c.children().forEach(_ch:`,
    `     _out := _out + str(_ch.rid) + "${FIELD}" + _ch.id.whenMissing("") + "${FIELD}" + _ch.key.whenMissing("") + "${FIELD}" + _ch.expression.whenMissing("") + "${ROW}"`,
    `)`,
    `_out`,
  ].join('\n')
  try {
    const res = await ctx.client.executeEc(code)
    if (!res.ok) { respond({ type: 'STUDIO_CHILDREN', ok: false, error: res.error }); return }
    const children = (res.log ?? '').split(ROW).filter(Boolean).map(rowStr => {
      const [rid, id, key, expression] = rowStr.split(FIELD)
      return { rid, id, key: key ?? '', expression: expression ?? '' }
    }).filter(c => c.rid && c.id)
    respond({ type: 'STUDIO_CHILDREN', ok: true, children })
  } catch (e) {
    respond({ type: 'STUDIO_CHILDREN', ok: false, error: errorMessage(e) })
  }
})

register('STUDIO_ADD_CHILD', async (msg, respond) => {
  const ctx = getCtx()
  if (!ctx.client) { respond({ type: 'STUDIO_CHILD_ADDED', ok: false, error: 'Not connected' }); return }
  // Add the child with id + key only (simple identifiers — no escaping). The
  // expression is set afterward via SAVE_PROPERTY. key is re-set via .change
  // because a key passed at add() time is stored prefixed (verified footgun).
  const id = ident(msg.childId)
  const key = ident(msg.key)
  const code = [
    `_r := SELECT CustomVisualization WHERE id = "${ident(msg.cvoBid)}"`,
    `_c := _r.first()`,
    `_n := _c.add(CustomVisualizationExpression, id := '${id}', key := '${key}')`,
    `_n.change(key := '${key}')`,
    `output(str(_n.rid))`,
  ].join('\n')
  try {
    const res = await ctx.client.executeEc(code, undefined, true)
    if (!res.ok) { respond({ type: 'STUDIO_CHILD_ADDED', ok: false, error: res.error }); return }
    respond({ type: 'STUDIO_CHILD_ADDED', ok: true, rid: (res.log ?? '').trim() })
  } catch (e) {
    respond({ type: 'STUDIO_CHILD_ADDED', ok: false, error: errorMessage(e) })
  }
})

register('STUDIO_FETCH_RESOURCE', async (msg, respond) => {
  const ctx = getCtx()
  if (!ctx.client) { respond({ type: 'STUDIO_RESOURCE', ok: false, rid: msg.rid, error: 'Not connected' }); return }
  const r = await ctx.client.downloadResource(msg.rid)
  respond({ type: 'STUDIO_RESOURCE', ok: r.ok, rid: msg.rid, text: r.text, error: r.error })
})

register('STUDIO_WRITE_RESOURCE', async (msg, respond) => {
  const ctx = getCtx()
  if (!ctx.client) { respond({ type: 'STUDIO_RESOURCE_WRITTEN', ok: false, error: 'Not connected' }); return }
  // name/mime must not contain the ';' triplet delimiter or quotes that would
  // break the EC string literal; base64 is [A-Za-z0-9+/=] only, so it's safe.
  const name = msg.name.replace(/["';]/g, '') || 'resource'
  const mime = msg.mime.replace(/["';]/g, '') || 'application/octet-stream'
  const id = ident(msg.resId)
  const content = `${name};${mime};${msg.base64}`
  const code = [
    `_any := SELECT FileResource`,
    `_fld := _any.first().parent`,
    `_new := _fld.add(FileResource, id := '${id}', name := '${name}')`,
    `_new.change(content := "${content}")`,
    `output(str(_new.rid))`,
  ].join('\n')
  try {
    const res = await ctx.client.executeEc(code, undefined, true)
    if (!res.ok) { respond({ type: 'STUDIO_RESOURCE_WRITTEN', ok: false, error: res.error }); return }
    respond({ type: 'STUDIO_RESOURCE_WRITTEN', ok: true, rid: (res.log ?? '').trim() })
  } catch (e) {
    respond({ type: 'STUDIO_RESOURCE_WRITTEN', ok: false, error: errorMessage(e) })
  }
})

register('STUDIO_DELETE_CHILD', async (msg, respond) => {
  const ctx = getCtx()
  if (!ctx.client) { respond({ type: 'STUDIO_CHILD_DELETED', ok: false, error: 'Not connected' }); return }
  const code = [
    `_r := SELECT CustomVisualizationExpression WHERE id = "${ident(msg.childId)}"`,
    `_o := _r.first()`,
    `_o.delete()`,
    `output("deleted")`,
  ].join('\n')
  try {
    const res = await ctx.client.executeEc(code, undefined, true)
    respond({ type: 'STUDIO_CHILD_DELETED', ok: res.ok, error: res.error })
  } catch (e) {
    respond({ type: 'STUDIO_CHILD_DELETED', ok: false, error: errorMessage(e) })
  }
})
