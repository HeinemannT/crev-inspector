/**
 * Studio handlers — opens the studio overlay (CVO or TextElement mode; the
 * launcher resolves the mode from the object's type). Save/preview reuse the
 * EC handlers (SAVE_PROPERTY routes code props through saveCodeViaEc).
 */
import { register } from '../handler-registry'
import { getCtx } from '../sw-context'
import { openStudioWindow } from '../cvo-studio'
import { errorMessage, log } from '../logger'
import { formatEcLiteral } from '../ec-guards'
import { ecActivityDetail } from '../activity-format'
import type { StudioChildType } from '../types'

// CVO child kind -> BMP class. Each populates a different `_data.*` map.
const CHILD_CLASS: Record<StudioChildType, string> = {
  expression: 'CustomVisualizationExpression',
  table: 'CustomVisualizationTableReference',
  connection: 'CustomVisualizationServerConnection',
}

register('OPEN_STUDIO', (msg, _respond, meta) => {
  openStudioWindow(msg.rid, msg.property, { tabId: meta.senderTabId, windowId: meta.panelWindowId })
    .catch(e => log.swallow('handler:openStudio', e))
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
    const code = await ctx.client.fetchCodeViaEc(msg.rid, msg.props ?? ['html', 'javascript'])
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

// Studio-hosted FileResources live in one dedicated Category folder under the
// Resources root, created on first host. Stable id so re-hosts land together.
const STUDIO_ASSET_FOLDER_ID = 'folder_crev_studio_assets'
const STUDIO_ASSET_FOLDER_NAME = 'CREV Studio Assets'

register('STUDIO_FETCH_CHILDREN', async (msg, respond) => {
  const ctx = getCtx()
  if (!ctx.client) { respond({ type: 'STUDIO_CHILDREN', ok: false, error: 'Not connected' }); return }
  // Emit every child with its className + all type-specific fields; absent
  // props resolve to "" via whenMissing (a ServerConnection has no .expression,
  // an Expression has no .url, etc.). Control-char delimiters never collide with
  // field content. table is a reference, so emit the referenced table's id.
  const code = [
    `_r := SELECT CustomVisualization WHERE id = "${ident(msg.cvoBid)}"`,
    `_c := _r.first()`,
    `_out := ""`,
    `_c.children().forEach(_ch:`,
    `     _out := _out + str(_ch.rid) + "${FIELD}" + _ch.id.whenMissing("") + "${FIELD}" + _ch.className.whenMissing("") + "${FIELD}" + _ch.key.whenMissing("") + "${FIELD}" + _ch.expression.whenMissing("") + "${FIELD}" + _ch.table.id.whenMissing("") + "${FIELD}" + _ch.url.whenMissing("") + "${FIELD}" + _ch.urlParameters.whenMissing("") + "${FIELD}" + _ch.headers.whenMissing("") + "${FIELD}" + str(_ch.timeout.whenMissing("")) + "${ROW}"`,
    `)`,
    `_out`,
  ].join('\n')
  try {
    const res = await ctx.client.executeEc(code)
    if (!res.ok) { respond({ type: 'STUDIO_CHILDREN', ok: false, error: res.error }); return }
    const children = (res.log ?? '').split(ROW).filter(Boolean).map(rowStr => {
      const [rid, id, className, key, expression, table, url, urlParameters, headers, timeout] = rowStr.split(FIELD)
      const type: StudioChildType = (className ?? '').includes('TableReference') ? 'table'
        : (className ?? '').includes('ServerConnection') ? 'connection' : 'expression'
      return { rid, id, type, key: key ?? '', expression: expression ?? '', table: table ?? '', url: url ?? '', urlParameters: urlParameters ?? '', headers: headers ?? '', timeout: timeout ?? '' }
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
  const cls = CHILD_CLASS[msg.childType]
  const code = [
    `_r := SELECT CustomVisualization WHERE id = "${ident(msg.cvoBid)}"`,
    `_c := _r.first()`,
    `_n := _c.add(${cls}, id := '${id}', key := '${key}')`,
    `_n.change(key := '${key}')`,
    `output("RID=" + str(_n.rid))`,
  ].join('\n')
  const startedAt = Date.now()
  try {
    const res = await ctx.client.executeEc(code, undefined, true)
    const durationMs = Date.now() - startedAt
    if (!res.ok) {
      respond({ type: 'STUDIO_CHILD_ADDED', ok: false, error: res.error })
      ctx.logActivity('error', `Studio failed to add ${msg.childType} ${msg.childId} (${durationMs}ms)`, ecActivityDetail(res), {
        category: 'studio', action: 'add-child', durationMs,
      })
      return
    }
    // Same as STUDIO_WRITE_RESOURCE: the transactional log mixes change-tracking
    // with the output, so read the rid from the RID= marker, not a whole trim.
    respond({ type: 'STUDIO_CHILD_ADDED', ok: true, rid: (res.log ?? '').match(/RID=(-?\d+)/)?.[1] })
    ctx.logActivity('success', `Studio added ${msg.childType} ${msg.childId} to ${msg.cvoBid} (${durationMs}ms)`, undefined, {
      category: 'studio', action: 'add-child', durationMs,
    })
  } catch (e) {
    const error = errorMessage(e)
    respond({ type: 'STUDIO_CHILD_ADDED', ok: false, error })
    ctx.logActivity('error', `Studio add failed for ${msg.childId}`, error, {
      category: 'studio', action: 'add-child',
    })
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
  // ';' is the content-triplet delimiter the download servlet splits on, so it
  // must be stripped from name/mime. Everything else interpolated into an EC
  // string literal is escaped through formatEcLiteral (the value-slot guard) —
  // an uploaded filename is attacker-influenced, so it gets the real escape,
  // not incidental character-stripping.
  const name = msg.name.replace(/;/g, '') || 'resource'
  const mime = msg.mime.replace(/;/g, '') || 'application/octet-stream'
  const id = ident(msg.resId)
  const contentLit = formatEcLiteral(`${name};${mime};${msg.base64}`)
  const nameLit = formatEcLiteral(name)
  const folderNameLit = formatEcLiteral(STUDIO_ASSET_FOLDER_NAME)
  // Update-in-place if a resource with this id already exists ANYWHERE in the
  // resource tree (a prior host, or one created by another tool); only create
  // for a genuinely-new id. Searching the whole tree (not just our folder)
  // avoids a duplicate-id add failure when the resource lives elsewhere. New
  // resources go under a dedicated studio-owned Category folder, created once:
  // FileResources can't be added directly under the Resources root (BMP:
  // "Can't add ... to Resources"). Verified live 2026-06-24: idempotent, the
  // folder is created at most once, re-hosts write content only.
  const code = [
    `_froot := root.EXTERNALRESOURCE`,
    `_hits := _froot.descendants().filter(self.id = '${id}')`,
    `IF _hits.size() > 0 THEN`,
    `     _f := _hits.first()`,
    `     _f.change(content := "${contentLit}")`,
    `     output("RID=" + str(_f.rid))`,
    `ELSE`,
    `     _fhits := _froot.descendants().filter(self.id = '${STUDIO_ASSET_FOLDER_ID}')`,
    `     IF _fhits.size() > 0 THEN`,
    `          _folder := _fhits.first()`,
    `     ELSE`,
    `          _folder := _froot.add(Category, id := '${STUDIO_ASSET_FOLDER_ID}', name := "${folderNameLit}")`,
    `     ENDIF`,
    `     _new := _folder.add(FileResource, id := '${id}', name := "${nameLit}")`,
    `     _new.change(content := "${contentLit}")`,
    `     output("RID=" + str(_new.rid))`,
    `ENDIF`,
  ].join('\n')
  const startedAt = Date.now()
  try {
    const res = await ctx.client.executeEc(code, undefined, true)
    const durationMs = Date.now() - startedAt
    if (!res.ok) {
      respond({ type: 'STUDIO_RESOURCE_WRITTEN', ok: false, error: res.error })
      ctx.logActivity('error', `Studio failed to host ${name} (${durationMs}ms)`, ecActivityDetail(res), {
        category: 'studio', action: 'write-resource', durationMs,
      })
      return
    }
    // executeEc's log mixes change-tracking lines with the output value, so the
    // rid can't be read by trimming the whole log — pull it from the RID= marker.
    const rid = (res.log ?? '').match(/RID=(-?\d+)/)?.[1]
    if (!rid) {
      const error = 'Hosted, but could not read the new resource rid from BMP'
      respond({ type: 'STUDIO_RESOURCE_WRITTEN', ok: false, error })
      ctx.logActivity('error', `Studio hosted ${name}, but verification failed (${durationMs}ms)`, error, {
        category: 'studio', action: 'write-resource', durationMs,
      })
      return
    }
    respond({ type: 'STUDIO_RESOURCE_WRITTEN', ok: true, rid, id })
    ctx.logActivity('success', `Studio hosted ${name} as ${id} (${durationMs}ms)`, undefined, {
      category: 'studio', action: 'write-resource', durationMs,
    })
  } catch (e) {
    const error = errorMessage(e)
    respond({ type: 'STUDIO_RESOURCE_WRITTEN', ok: false, error })
    ctx.logActivity('error', `Studio host failed for ${name}`, error, {
      category: 'studio', action: 'write-resource',
    })
  }
})

// Resolve a child by id across the three classes (the caller may not know the
// type, e.g. delete). The id is unique, so the first non-empty hit wins.
function resolveChildLines(idVar: string, childId: string): string[] {
  const id = ident(childId)
  return [
    `_r := SELECT CustomVisualizationExpression WHERE id = "${id}"`,
    `IF _r.size() = 0 THEN _r := SELECT CustomVisualizationTableReference WHERE id = "${id}" ENDIF`,
    `IF _r.size() = 0 THEN _r := SELECT CustomVisualizationServerConnection WHERE id = "${id}" ENDIF`,
    `${idVar} := _r.first()`,
  ]
}

register('STUDIO_SAVE_CHILD', async (msg, respond) => {
  const ctx = getCtx()
  if (!ctx.client) { respond({ type: 'STUDIO_CHILD_SAVED', ok: false, error: 'Not connected' }); return }
  const f = msg.fields
  const lines = [
    `_r := SELECT ${CHILD_CLASS[msg.childType]} WHERE id = "${ident(msg.childId)}"`,
    `_o := _r.first()`,
    `_o.change(key := "${formatEcLiteral(msg.key)}")`,
  ]
  if (msg.childType === 'expression' && f.expression != null) {
    lines.push(`_o.change(expression := "${formatEcLiteral(f.expression)}")`)
  } else if (msg.childType === 'connection') {
    if (f.url != null) lines.push(`_o.change(url := "${formatEcLiteral(f.url)}")`)
    if (f.urlParameters != null) lines.push(`_o.change(urlParameters := "${formatEcLiteral(f.urlParameters)}")`)
    if (f.headers != null) lines.push(`_o.change(headers := "${formatEcLiteral(f.headers)}")`)
    if (f.timeout != null && /^\d+$/.test(f.timeout)) lines.push(`_o.change(timeout := ${f.timeout})`)
  } else if (msg.childType === 'table' && f.table) {
    // `table` is a reference. Resolve via t.get("id") (a value-slot string,
    // escaped) — NOT a bare t.<id> token, which breaks for hyphenated ids
    // (`t.a-b` parses as subtraction, silently yielding the wrong reference).
    lines.push(`_o.change(table := t.get("${formatEcLiteral(f.table)}"))`)
  }
  lines.push(`output("ok")`)
  const startedAt = Date.now()
  try {
    const res = await ctx.client.executeEc(lines.join('\n'), undefined, true)
    const durationMs = Date.now() - startedAt
    respond({ type: 'STUDIO_CHILD_SAVED', ok: res.ok, error: res.error })
    ctx.logActivity(
      res.ok ? 'success' : 'error',
      res.ok
        ? `Studio saved ${msg.childType} ${msg.childId} (${durationMs}ms)`
        : `Studio save failed for ${msg.childId} (${durationMs}ms)`,
      ecActivityDetail(res),
      { category: 'studio', action: 'save-child', durationMs },
    )
  } catch (e) {
    const error = errorMessage(e)
    respond({ type: 'STUDIO_CHILD_SAVED', ok: false, error })
    ctx.logActivity('error', `Studio save request failed for ${msg.childId}`, error, {
      category: 'studio', action: 'save-child',
    })
  }
})

register('STUDIO_DELETE_CHILD', async (msg, respond) => {
  const ctx = getCtx()
  if (!ctx.client) { respond({ type: 'STUDIO_CHILD_DELETED', ok: false, error: 'Not connected' }); return }
  const code = [
    ...resolveChildLines('_o', msg.childId),
    `_o.delete()`,
    `output("deleted")`,
  ].join('\n')
  const startedAt = Date.now()
  try {
    const res = await ctx.client.executeEc(code, undefined, true)
    const durationMs = Date.now() - startedAt
    respond({ type: 'STUDIO_CHILD_DELETED', ok: res.ok, error: res.error })
    ctx.logActivity(
      res.ok ? 'success' : 'error',
      res.ok
        ? `Studio deleted ${msg.childId} (${durationMs}ms)`
        : `Studio delete failed for ${msg.childId} (${durationMs}ms)`,
      ecActivityDetail(res),
      { category: 'studio', action: 'delete-child', durationMs },
    )
  } catch (e) {
    const error = errorMessage(e)
    respond({ type: 'STUDIO_CHILD_DELETED', ok: false, error })
    ctx.logActivity('error', `Studio delete request failed for ${msg.childId}`, error, {
      category: 'studio', action: 'delete-child',
    })
  }
})

// Resolve a configurator-typed business id (or a rid) to {rid, id, name}.
// Configurators work with ids; the data servlet needs a rid, so the render-
// context field accepts either and resolves here. A numeric ref is a rid
// (lookup, O(1)); anything else is a business id (whole-tree id filter — O(n),
// but this only runs on a manual field change). Ends with a bare `_out` so
// res.log is exactly the FIELD-delimited triple (the children-handler idiom).
register('STUDIO_RESOLVE_REF', async (msg, respond) => {
  const ctx = getCtx()
  if (!ctx.client) { respond({ type: 'STUDIO_REF_RESOLVED', ok: false, error: 'Not connected' }); return }
  const ref = (msg.ref ?? '').trim()
  if (!ref) { respond({ type: 'STUDIO_REF_RESOLVED', ok: false, error: 'Empty reference' }); return }
  // The triple ends with a ROW terminator so the parse can isolate it from the
  // trailing log framing (e.g. "Duration : …") that executeEc appends.
  const emit = `_out := str(_o.rid) + "${FIELD}" + _o.id.whenMissing("") + "${FIELD}" + _o.name.whenMissing("") + "${ROW}"`
  // rid -> lookup (O(1)); business id -> id-space resolver. Render contexts are
  // scorecards/pages (t.) or organisations (o.); templates aren't in
  // root.descendants(), so .get() on the id-space is the correct resolve.
  const id = ident(ref)
  const resolve = /^-?\d+$/.test(ref)
    ? [`_o := lookup(${ref})`]
    : [`_o := t.get("${id}")`, `IF _o.isMissing() THEN`, `     _o := o.get("${id}")`, `ENDIF`]
  const code = [...resolve, `IF _o.isMissing() THEN`, `     _out := ""`, `ELSE`, `     ${emit}`, `ENDIF`, `_out`].join('\n')
  try {
    const res = await ctx.client.executeEc(code)
    if (!res.ok) { respond({ type: 'STUDIO_REF_RESOLVED', ok: false, error: res.error }); return }
    const first = (res.log ?? '').split(ROW)[0]
    if (!first.includes(FIELD)) { respond({ type: 'STUDIO_REF_RESOLVED', ok: false, error: `No object with id or rid "${ref}"` }); return }
    const [rid, oid, name] = first.split(FIELD)
    respond({ type: 'STUDIO_REF_RESOLVED', ok: true, rid: (rid ?? '').trim(), id: (oid ?? '').trim(), name: name ?? '' })
  } catch (e) {
    respond({ type: 'STUDIO_REF_RESOLVED', ok: false, error: errorMessage(e) })
  }
})

// Batch-resolve FileResource rids (parsed from the CVO code) to {id, name} for
// the dependency list, so configurators see ids/names not bare rids. lookup()
// per rid; ends with a bare `_out` of ROW-separated, FIELD-delimited rows.
register('STUDIO_RESOLVE_RIDS', async (msg, respond) => {
  const ctx = getCtx()
  if (!ctx.client) { respond({ type: 'STUDIO_RIDS_RESOLVED', ok: false, error: 'Not connected' }); return }
  const rids = [...new Set((msg.rids ?? []).filter(r => /^-?\d+$/.test(r)))]
  if (rids.length === 0) { respond({ type: 'STUDIO_RIDS_RESOLVED', ok: true, refs: [] }); return }
  const lines = ['_out := ""']
  for (const r of rids) {
    lines.push(`_o := lookup(${r})`)
    lines.push(`_out := _out + "${r}" + "${FIELD}" + _o.id.whenMissing("") + "${FIELD}" + _o.name.whenMissing("") + "${ROW}"`)
  }
  lines.push('_out')
  try {
    const res = await ctx.client.executeEc(lines.join('\n'))
    if (!res.ok) { respond({ type: 'STUDIO_RIDS_RESOLVED', ok: false, error: res.error }); return }
    const refs = (res.log ?? '').split(ROW).filter(Boolean).map(row => {
      const [rid, id, name] = row.split(FIELD)
      return { rid: (rid ?? '').trim(), id: (id ?? '').trim(), name: (name ?? '').trim() }
    }).filter(x => /^-?\d+$/.test(x.rid))
    respond({ type: 'STUDIO_RIDS_RESOLVED', ok: true, refs })
  } catch (e) {
    respond({ type: 'STUDIO_RIDS_RESOLVED', ok: false, error: errorMessage(e) })
  }
})
