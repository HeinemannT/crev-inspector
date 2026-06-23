/**
 * CVO Studio — privileged page (mounted as an in-page overlay iframe, same
 * path as the EC editor). Owns the editor + panels and relays between the
 * sandbox (which runs the CVO) and the service worker (which talks to BMP).
 *
 * Keystone scope (Phase 1): open a CustomVisualization's html + javascript as
 * files, edit with real syntax, and see it render live in the sandbox against a
 * MOCK `_data`, with console + thrown errors surfaced. Build-on-edit + a manual
 * Run, show/hide preview, and Save/Discard of the active code field through the
 * existing SAVE_PROPERTY handler. Live `_data`, editable children, and the
 * dependency/resource panels arrive in later phases.
 *
 * The CodeMirror wiring here is intentionally minimal — when the shared
 * code-surface engine is extracted (against this studio + the EC editor), this
 * file adopts it and the local createEditor goes away.
 */
import { EditorView, keymap } from '@codemirror/view'
import { baseEditingExtensions, baseKeymapBindings, languageExtension, catppuccinMocha, type CodeLang } from '../editor-core/cm-scaffold'
import { CodeSurface, isProgrammaticSwap } from '../editor-core/code-surface'
import { detectFileResourceRids, detectCdnUrls } from './dep-detect'
import { h, svg, render as renderDom } from '../lib/dom'
import { sendRequest } from '../lib/messaging'
import { confirmModal } from '../lib/modal'
import { installCloseHandshake } from '../lib/frame-close-handshake'
import { getTypeAbbr, getTypeColor, type StudioChild } from '../lib/types'
import { ICON_PLAY } from '../lib/icons'
import { STUDIO_CTX_PREFIX, type StudioContext, type StudioCodeProp } from './studio-types'

const CODE_PROPS: readonly StudioCodeProp[] = ['html', 'javascript']
const PREVIEW_DEBOUNCE_MS = 400

const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform)
const KBD_MOD = isMac ? '⌘' : 'Ctrl'

// ── State ────────────────────────────────────────────────────────
let ctx: StudioContext | null = null
/** Shared multi-slot editing engine (html + javascript slots). Owns the view,
 *  per-slot dirty, stash/restore, and save/discard baselines. */
let surface: CodeSurface | null = null
let activeProp: StudioCodeProp = 'html'
let previewVisible = true

// Preview data source. 'mock' uses the local mockData; 'live' fetches the real
// `_data` from BMP's data servlet for renderContextRid (org-rooted). liveData
// caches the last successful fetch; liveError holds the last failure (e.g. the
// org-gating 400) for display.
let dataMode: 'mock' | 'live' = 'mock'
let renderContextRid = ''
let liveData: Record<string, unknown> | null = null
let liveError: string | null = null

// The CVO's data-input children (CustomVisualizationExpression). Each defines a
// `_data.expressions[key]` slot; editable here. Seeded into mockData so the mock
// preview carries the real slot keys.
let children: StudioChild[] = []
let childrenOpen = false

// Hosted FileResource libraries the CVO depends on, cached by rid ('' = fetched
// but unavailable). lastLibs is the resolved set passed to the sandbox.
const libCache = new Map<string, string>()
let lastLibs: string[] = []
let resourcesOpen = false

// Sandbox handshake: hold the latest render until the sandbox says it's ready.
let sandboxReady = false
let pendingRender = false
let runCounter = 0
/** Console + error lines from the current run, newest last. */
interface ConsoleLine { level: 'log' | 'warn' | 'error' | 'info'; text: string }
let consoleLines: ConsoleLine[] = []

/** Mock `_data` used until live data lands (Phase 3). Mirrors the shape the
 *  data servlet returns; `.element` is attached inside the sandbox. */
const mockData = {
  // A real (non-zero-width) period so a CVO that buckets/ranges by date sees a
  // plausible window in preview. Last 365 days ending now.
  context: { orgid: 'org_demo', period: 'M', start: Date.now() - 365 * 24 * 3600 * 1000, end: Date.now(), yearToDate: false },
  expressions: {} as Record<string, string>,
  tables: {} as Record<string, unknown>,
  serverConnections: {} as Record<string, string>,
  queryEndpoint: '',
}

const root = document.getElementById('studio-root')!

// ── Init ─────────────────────────────────────────────────────────
async function init() {
  renderDom(root, h('div', { class: 'studio-loading' }, 'Loading…'))
  const rid = location.hash.slice(1)
  try {
    const key = `${STUDIO_CTX_PREFIX}${rid}`
    const result = await chrome.storage.local.get([key])
    ctx = (result[key] as StudioContext | null) ?? null
  } catch {
    renderDom(root, h('div', { class: 'studio-loading' }, 'Failed to load CVO context'))
    return
  }
  if (!ctx) {
    renderDom(root, h('div', { class: 'studio-loading' }, 'No CVO context found'))
    return
  }

  activeProp = ctx.property ?? 'html'
  renderContextRid = ctx.renderContextRid ?? ''
  document.title = ctx.instance.name ? `CVO · ${ctx.instance.name}` : 'CVO Studio'

  renderShell()
  ensureSurface()
  schedulePreview()
  fetchChildren()
}

/** Create the editing surface (once) with the html + javascript slots, or
 *  re-attach its view after a shell re-render. */
function ensureSurface() {
  if (surface) { surface.reattach(); return }
  surface = new CodeSurface(() => document.getElementById('studio-cm'), {
    buildExtensions: (slot) => [
      ...baseEditingExtensions(),
      languageExtension(slot.lang as CodeLang),
      catppuccinMocha,
      keymap.of([
        ...baseKeymapBindings,
        { key: 'Ctrl-s', mac: 'Cmd-s', run: () => { doSave(); return true } },
        { key: 'Ctrl-Enter', mac: 'Cmd-Enter', run: () => { runPreview(); return true } },
        { key: 'Escape', run: () => { try { window.parent.postMessage({ type: 'CREV_OVERLAY_CLOSE_PLEASE' }, '*') } catch { /* ignore */ } return true } },
      ]),
      // Re-render on user edits only — a programmatic slot-swap (tab switch)
      // carries CodeSurface's annotation and must not trigger a preview rebuild.
      EditorView.updateListener.of(u => { if (u.docChanged && !isProgrammaticSwap(u)) schedulePreview() }),
    ],
    onDirtyChange: () => refreshActions(),
  })
  const code = activeCode()
  surface.setSlots(CODE_PROPS.map(p => ({ key: p, lang: p, code: code[p] ?? '' })))
  surface.activate(activeProp)
}

/** Code map for the current save target (keystone always edits the instance;
 *  a template/instance toggle arrives with the rest of the edit loop). */
function activeCode(): Record<string, string> {
  if (!ctx) return {}
  return ctx.saveTarget === 'template' && ctx.template ? ctx.templateCode : ctx.instanceCode
}

// ── Shell ────────────────────────────────────────────────────────
function renderShell() {
  if (!ctx) return
  const id = ctx.instance
  const typeColor = getTypeColor(id.type)
  const typeAbbr = getTypeAbbr(id.type)

  renderDom(root,
    // Header: identity + actions
    h('div', { class: 'studio-header' },
      h('div', { class: 'studio-id' },
        h('span', { class: 'studio-id-chip', style: `--type-color:${typeColor}`, title: id.type || '' }, typeAbbr),
        h('span', { class: 'studio-id-name' }, id.name || '(unnamed)'),
        h('span', { class: 'studio-id-bid' }, id.businessId || id.rid),
      ),
      h('div', { class: 'studio-actions' },
        h('button', { class: 'btn btn-accent', id: 'studio-run', title: `Re-render preview · ${KBD_MOD}+Enter`, onClick: () => runPreview() },
          svg(ICON_PLAY), ' Run'),
        h('button', { class: 'btn', id: 'studio-save', disabled: !anyDirty(), title: `Save the active field · ${KBD_MOD}+S`, onClick: doSave }, 'Save'),
        h('button', { class: 'btn btn-ghost', id: 'studio-discard', disabled: !surface?.isDirty(activeProp), title: 'Revert this field to the saved BMP value', onClick: doDiscard }, 'Discard'),
        h('button', { class: 'btn btn-ghost', id: 'studio-download', title: 'Download the CVO source (html + javascript) as a .cvo.json bundle', onClick: doDownload }, 'Download'),
        h('div', { class: 'studio-actions-spacer' }),
        h('button', { class: `btn-micro${previewVisible ? ' active' : ''}`, id: 'studio-toggle-preview', title: 'Show / hide the live preview', onClick: togglePreview }, previewVisible ? 'Hide preview' : 'Show preview'),
      ),
    ),
    // Property tabs (html / javascript)
    h('div', { class: 'studio-prop-tabs', role: 'tablist' },
      ...CODE_PROPS.map(p => h('button', {
        class: `studio-prop-tab${p === activeProp ? ' active' : ''}`,
        role: 'tab',
        'data-prop': p,
        'aria-selected': p === activeProp ? 'true' : 'false',
        onClick: () => switchProp(p),
      }, h('span', null, p), surface?.isDirty(p) ? h('span', { class: 'studio-prop-dot', 'aria-label': 'unsaved' }) : null)),
    ),
    // Split: editor | preview
    h('div', { class: `studio-split${previewVisible ? '' : ' studio-split--no-preview'}` },
      h('div', { class: 'studio-editor', id: 'studio-cm' }),
      previewVisible
        ? h('div', { class: 'studio-preview' },
            renderDataBar(),
            renderDataInputs(),
            renderResources(),
            h('iframe', { id: 'studio-sandbox', class: 'studio-sandbox', src: 'sandbox.html', title: 'CVO preview' }),
            h('div', { class: 'studio-console', id: 'studio-console' }),
          )
        : null,
    ),
  )

  // Re-attach the live editor view into the freshly-rendered shell.
  surface?.reattach()
  renderConsole()
  // renderShell built a FRESH sandbox iframe (renderDom replaced the DOM), so the
  // prior handshake is void — reset it and re-render once the new iframe is ready
  // (pendingRender flushes on CVO_SANDBOX_READY). Guarded on `surface` so init's
  // first renderShell (pre-ensureSurface) doesn't fire an empty render — init
  // schedules the first preview itself.
  if (previewVisible) {
    sandboxReady = false
    pendingRender = false
    if (surface) schedulePreview()
  }
}

function refreshActions() {
  const save = document.getElementById('studio-save') as HTMLButtonElement | null
  if (save) save.disabled = !anyDirty()
  const discard = document.getElementById('studio-discard') as HTMLButtonElement | null
  if (discard) discard.disabled = !surface?.isDirty(activeProp)
  for (const tab of document.querySelectorAll<HTMLElement>('.studio-prop-tab')) {
    const p = tab.getAttribute('data-prop') as StudioCodeProp | null
    if (p) tab.querySelector('.studio-prop-dot')?.classList.toggle('studio-prop-dot--hidden', !surface?.isDirty(p))
  }
}

const anyDirty = () => !!surface?.isDirty()

// ── Editor ───────────────────────────────────────────────────────
let previewTimer: ReturnType<typeof setTimeout> | null = null

function switchProp(p: StudioCodeProp) {
  if (p === activeProp) return
  activeProp = p
  renderShell()
  surface?.activate(p)
}

// ── Preview (sandbox) ────────────────────────────────────────────
function schedulePreview() {
  if (previewTimer) clearTimeout(previewTimer)
  previewTimer = setTimeout(() => runPreview(), PREVIEW_DEBOUNCE_MS)
}

async function runPreview() {
  if (previewTimer) { clearTimeout(previewTimer); previewTimer = null }
  if (!previewVisible) return
  consoleLines = []
  renderConsole()
  // Resolve the CVO's hosted FileResource libraries (cached) before rendering,
  // so the sandbox can run them before the CVO. Done before the ready-gate so a
  // queued render flushes with libs ready.
  await ensureLibs()
  if (!sandboxReady) { pendingRender = true; return }
  postRender()
}

/** Detect the FileResource libraries the CVO loads and fetch their bytes via
 *  the SW (cookie-authed download), caching by rid. Unavailable deps (e.g. no
 *  BMP session) are cached as '' and warned once, so the CVO degrades rather
 *  than blocking — matching the portal's graceful-degradation guidance. */
async function ensureLibs(): Promise<void> {
  const rids = detectFileResourceRids(surface?.textFor('html') ?? '', surface?.textFor('javascript') ?? '')
  for (const rid of rids) {
    if (libCache.has(rid)) continue
    const resp = await sendRequest({ type: 'STUDIO_FETCH_RESOURCE', rid })
    if (resp?.type === 'STUDIO_RESOURCE' && resp.ok && resp.text != null) {
      libCache.set(rid, resp.text)
    } else {
      libCache.set(rid, '')
      consoleLines.push({ level: 'warn', text: `Dependency ${rid} unavailable (${(resp?.type === 'STUDIO_RESOURCE' ? resp.error : 'no response') ?? ''}) — preview runs without it` })
      renderConsole()
    }
  }
  lastLibs = rids.map(r => libCache.get(r) ?? '').filter(Boolean)
}

function postRender() {
  const frame = document.getElementById('studio-sandbox') as HTMLIFrameElement | null
  if (!frame?.contentWindow) { pendingRender = true; return }
  const runId = ++runCounter
  // textFor() pulls the live doc for the active slot and the stashed text for
  // the inactive one — so a render always uses the latest of both fields.
  // In live mode render against the real servlet `_data` (falling back to mock
  // until the first successful fetch); otherwise the mock.
  // NOTE: target origin is '*'. Live `_data` can be sensitive; the sandbox is
  // the only embedded frame and validates ev.source, but if other frames are
  // ever embedded here, target the sandbox's specific origin instead.
  const data = dataMode === 'live' && liveData ? liveData : mockData
  frame.contentWindow.postMessage({
    type: 'CVO_RENDER',
    runId,
    html: surface?.textFor('html') ?? '',
    javascript: surface?.textFor('javascript') ?? '',
    data,
    libs: lastLibs,
  }, '*')
}

// ── Preview data source (mock / live `_data`) ────────────────────
function renderDataBar(): HTMLElement {
  const ctxInput = h('input', {
    class: 'studio-ctx-input',
    id: 'studio-ctx-rid',
    placeholder: 'render-context rid',
    value: renderContextRid,
    spellcheck: 'false', autocomplete: 'off',
    title: 'Org-rooted object (scorecard/page) the CVO renders under — the data servlet is gated on it',
  }) as HTMLInputElement
  ctxInput.addEventListener('change', () => {
    renderContextRid = ctxInput.value.trim()
    if (dataMode === 'live') fetchLiveData()
  })
  return h('div', { class: 'studio-databar' },
    h('span', { class: 'studio-databar-label' }, 'Data'),
    h('button', { class: `studio-databar-btn${dataMode === 'mock' ? ' active' : ''}`, title: 'Render against local mock _data', onClick: () => setDataMode('mock') }, 'Mock'),
    h('button', { class: `studio-databar-btn${dataMode === 'live' ? ' active' : ''}`, title: 'Render against real BMP _data for the render context', onClick: () => setDataMode('live') }, 'Live'),
    dataMode === 'live' ? ctxInput : null,
    dataMode === 'live' ? h('button', { class: 'studio-databar-btn', title: 'Re-fetch live data', onClick: () => fetchLiveData() }, '↻') : null,
    dataMode === 'live' && liveError ? h('span', { class: 'studio-databar-error', title: liveError }, '⚠ ' + (liveError.length > 70 ? liveError.slice(0, 70) + '…' : liveError)) : null,
    dataMode === 'live' && !liveError && liveData ? h('span', { class: 'studio-databar-ok', title: 'Rendering against live BMP data' }, 'live') : null,
  )
}

function setDataMode(mode: 'mock' | 'live'): void {
  if (mode === dataMode) return
  dataMode = mode
  liveError = null
  renderShell() // re-renders the data bar + the fresh iframe (which schedules a render)
  if (mode === 'live' && !liveData) fetchLiveData()
}

async function fetchLiveData(): Promise<void> {
  if (!ctx) return
  if (!renderContextRid) {
    liveData = null
    liveError = 'Set a render-context rid (an org-rooted scorecard/page) to fetch live data.'
    renderShell()
    return
  }
  liveError = null
  const resp = await sendRequest({ type: 'STUDIO_FETCH_DATA', cvoRid: ctx.instance.rid, businessObjectRid: renderContextRid })
  if (resp?.type === 'STUDIO_DATA' && resp.ok && resp.data) {
    liveData = resp.data as Record<string, unknown>
    liveError = null
  } else {
    liveData = null
    liveError = (resp?.type === 'STUDIO_DATA' ? resp.error : undefined) ?? 'Live data fetch failed'
  }
  renderShell() // reflect status; the fresh iframe schedules a render with the new data
}

// ── Data inputs (CVO children → _data.expressions) ───────────────
async function fetchChildren(): Promise<void> {
  if (!ctx?.instance.businessId) return
  const resp = await sendRequest({ type: 'STUDIO_FETCH_CHILDREN', cvoBid: ctx.instance.businessId })
  if (resp?.type === 'STUDIO_CHILDREN' && resp.ok && resp.children) {
    children = resp.children
    seedMockFromChildren()
    renderShell()
  }
}

/** Give the mock `_data.expressions` the real slot keys (empty placeholder
 *  values), so a mock-mode preview sees the same shape as live. */
function seedMockFromChildren(): void {
  const ex: Record<string, string> = {}
  for (const c of children) if (c.key) ex[c.key] = mockData.expressions[c.key] ?? ''
  mockData.expressions = ex
}

function renderDataInputs(): HTMLElement {
  const header = h('button', {
    class: 'studio-inputs-header',
    title: 'CustomVisualizationExpression children — each maps to _data.expressions[key]',
    onClick: () => { childrenOpen = !childrenOpen; renderShell() },
  }, `${childrenOpen ? '▾' : '▸'} Data inputs (${children.length})`)
  if (!childrenOpen) return h('div', { class: 'studio-inputs' }, header)
  return h('div', { class: 'studio-inputs studio-inputs--open' },
    header,
    h('div', { class: 'studio-inputs-list' },
      children.length === 0 ? h('div', { class: 'studio-inputs-empty' }, 'No expression inputs') : null,
      ...children.map(renderChildRow),
      h('button', { class: 'studio-inputs-add', title: 'Add a CustomVisualizationExpression input', onClick: doAddChild }, '+ Add input'),
    ),
  )
}

function renderChildRow(c: StudioChild): HTMLElement {
  const keyInput = h('input', { class: 'studio-child-key-input', value: c.key, spellcheck: 'false', autocomplete: 'off', title: 'JS key — _data.expressions.' + (c.key || '?') }) as HTMLInputElement
  const exprInput = h('input', { class: 'studio-child-expr', value: c.expression, spellcheck: 'false', autocomplete: 'off', title: c.expression || 'Reporter token, e.g. ${t.my_expr.expression}' }) as HTMLInputElement
  return h('div', { class: 'studio-child-row' },
    keyInput,
    exprInput,
    h('button', { class: 'studio-databar-btn', title: 'Save key + expression', onClick: () => doSaveChild(c, keyInput.value.trim(), exprInput.value) }, 'Save'),
    h('button', { class: 'studio-databar-btn studio-child-del', title: 'Remove this input', onClick: () => doRemoveChild(c) }, '✕'),
  )
}

async function doSaveChild(c: StudioChild, key: string, expression: string): Promise<void> {
  let okAll = true
  if (key && key !== c.key) {
    const r = await sendRequest({ type: 'SAVE_PROPERTY', rid: c.rid, objectType: 'CustomVisualizationExpression', property: 'key', value: key })
    if (r?.type === 'SAVE_RESULT' && r.ok) c.key = key
    else { okAll = false; consoleLines.push({ level: 'error', text: `Key save failed: ${(r?.type === 'SAVE_RESULT' ? r.error : '') ?? ''}` }) }
  }
  if (expression !== c.expression) {
    const r = await sendRequest({ type: 'SAVE_PROPERTY', rid: c.rid, objectType: 'CustomVisualizationExpression', property: 'expression', value: expression })
    if (r?.type === 'SAVE_RESULT' && r.ok) c.expression = expression
    else { okAll = false; consoleLines.push({ level: 'error', text: `Expression save failed: ${(r?.type === 'SAVE_RESULT' ? r.error : '') ?? ''}` }) }
  }
  if (okAll) consoleLines.push({ level: 'info', text: `Saved input "${c.key}"` })
  seedMockFromChildren()
  renderShell()
  if (dataMode === 'live') fetchLiveData()
}

async function doAddChild(): Promise<void> {
  if (!ctx?.instance.businessId) return
  const n = children.length + 1
  const key = `input_${n}`
  const childId = `cve_${(ctx.instance.businessId || 'cvo').replace(/[^\w-]/g, '')}_${key}`
  const resp = await sendRequest({ type: 'STUDIO_ADD_CHILD', cvoBid: ctx.instance.businessId, childId, key })
  if (resp?.type === 'STUDIO_CHILD_ADDED' && resp.ok) {
    consoleLines.push({ level: 'info', text: `Added input "${key}"` })
    await fetchChildren()
  } else {
    consoleLines.push({ level: 'error', text: `Add failed: ${(resp?.type === 'STUDIO_CHILD_ADDED' ? resp.error : '') ?? ''}` })
    renderConsole()
  }
}

async function doRemoveChild(c: StudioChild): Promise<void> {
  const ok = await confirmModal({
    title: 'Remove input?',
    body: `Delete the "${c.key}" expression input (${c.id}) from this CVO? This removes the _data.expressions.${c.key} slot.`,
    confirmLabel: 'Remove',
    confirmVariant: 'danger',
  })
  if (!ok) return
  const resp = await sendRequest({ type: 'STUDIO_DELETE_CHILD', childId: c.id })
  if (resp?.type === 'STUDIO_CHILD_DELETED' && resp.ok) {
    consoleLines.push({ level: 'info', text: `Removed input "${c.key}"` })
    await fetchChildren()
  } else {
    consoleLines.push({ level: 'error', text: `Remove failed: ${(resp?.type === 'STUDIO_CHILD_DELETED' ? resp.error : '') ?? ''}` })
    renderConsole()
  }
}

// ── Dependencies + resource hosting ──────────────────────────────
function renderResources(): HTMLElement {
  const html = surface?.textFor('html') ?? ''
  const js = surface?.textFor('javascript') ?? ''
  const fileRes = detectFileResourceRids(html, js)
  const cdns = detectCdnUrls(html, js)
  const n = fileRes.length + cdns.length
  const header = h('button', {
    class: 'studio-inputs-header',
    title: 'Hosted FileResource libraries + external scripts this CVO loads',
    onClick: () => { resourcesOpen = !resourcesOpen; renderShell() },
  }, `${resourcesOpen ? '▾' : '▸'} Dependencies (${n})`)
  if (!resourcesOpen) return h('div', { class: 'studio-inputs' }, header)
  return h('div', { class: 'studio-inputs studio-inputs--open' },
    header,
    h('div', { class: 'studio-inputs-list' },
      n === 0 ? h('div', { class: 'studio-inputs-empty' }, 'No external dependencies') : null,
      ...fileRes.map(rid => {
        const cached = libCache.get(rid)
        const status = cached === undefined ? '…' : cached ? '✓ loaded' : '✗ unavailable'
        return h('div', { class: 'studio-dep-row' },
          h('span', { class: 'studio-dep-kind' }, 'FileResource'),
          h('span', { class: 'studio-dep-id', title: 'rid ' + rid }, rid),
          h('span', { class: `studio-dep-status${cached === '' ? ' studio-dep-warn' : ''}` }, status),
        )
      }),
      ...cdns.map(u => h('div', { class: 'studio-dep-row' },
        h('span', { class: 'studio-dep-kind studio-dep-kind--cdn' }, 'CDN'),
        h('span', { class: 'studio-dep-id', title: u }, u),
        h('span', { class: 'studio-dep-status studio-dep-warn' }, "⚠ won't load if air-gapped"),
      )),
      h('button', { class: 'studio-inputs-add', title: 'Host a JS/asset file as a BMP FileResource', onClick: doHostResource }, '+ Host resource'),
    ),
  )
}

/** Base64-encode bytes in chunks (avoids the arg-count limit of a single
 *  String.fromCharCode(...bytes) on large files). */
function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  return btoa(bin)
}

function doHostResource(): void {
  const input = document.createElement('input')
  input.type = 'file'
  input.onchange = async () => {
    const file = input.files?.[0]
    if (!file) return
    const bytes = new Uint8Array(await file.arrayBuffer())
    const resId = 'fr_' + file.name.replace(/[^\w]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48)
    const mime = file.type || 'application/octet-stream'
    consoleLines.push({ level: 'info', text: `Hosting ${file.name} (${Math.round(bytes.length / 1024)} KB)…` })
    renderConsole()
    const resp = await sendRequest({ type: 'STUDIO_WRITE_RESOURCE', resId, name: file.name, mime, base64: bytesToBase64(bytes) })
    if (resp?.type === 'STUDIO_RESOURCE_WRITTEN' && resp.ok && resp.rid) {
      const snippet = `<script src="/<workspace>/web/download?propName=content&rid=${resp.rid}"></script>`
      navigator.clipboard?.writeText(snippet).catch(() => {})
      consoleLines.push({ level: 'info', text: `Hosted "${file.name}" as rid ${resp.rid}. Reference snippet copied (set <workspace>, or build it at runtime like the ERMQ host):\n${snippet}` })
    } else {
      consoleLines.push({ level: 'error', text: `Host failed: ${(resp?.type === 'STUDIO_RESOURCE_WRITTEN' ? resp.error : '') ?? ''}` })
    }
    renderConsole()
  }
  input.click()
}

window.addEventListener('message', ev => {
  const frame = document.getElementById('studio-sandbox') as HTMLIFrameElement | null
  if (!frame || ev.source !== frame.contentWindow) return
  const msg = ev.data as { type?: string; level?: ConsoleLine['level']; text?: string; message?: string; stack?: string; runId?: number } | undefined
  if (!msg) return
  if (msg.type === 'CVO_SANDBOX_READY') {
    sandboxReady = true
    if (pendingRender) { pendingRender = false; postRender() }
    return
  }
  // Drop output from superseded runs.
  if (typeof msg.runId === 'number' && msg.runId !== runCounter) return
  if (msg.type === 'CVO_CONSOLE' && msg.text != null) {
    consoleLines.push({ level: msg.level ?? 'log', text: msg.text })
    renderConsole()
  } else if (msg.type === 'CVO_ERROR') {
    consoleLines.push({ level: 'error', text: msg.message || 'Error' })
    renderConsole()
  }
})

function renderConsole() {
  const el = document.getElementById('studio-console')
  if (!el) return
  if (consoleLines.length === 0) {
    renderDom(el, h('div', { class: 'studio-console-empty' }, 'No console output'))
    return
  }
  renderDom(el, ...consoleLines.map(l =>
    h('div', { class: `studio-console-line studio-console-line--${l.level}` }, l.text)))
  el.scrollTop = el.scrollHeight
}

// ── Save / discard / preview toggle ──────────────────────────────
async function doSave() {
  if (!ctx || !surface || !surface.isDirty(activeProp)) return
  const value = surface.textFor(activeProp)
  const target = ctx.saveTarget === 'template' && ctx.template ? ctx.template : ctx.instance
  const ok = await confirmModal({
    title: `Save ${activeProp}`,
    body: `Write ${activeProp} to "${target.name || target.businessId || target.rid}"?`,
    confirmLabel: 'Save',
    confirmVariant: 'success',
  })
  if (!ok) return
  const save = document.getElementById('studio-save') as HTMLButtonElement | null
  if (save) save.disabled = true
  const resp = await sendRequest({
    type: 'SAVE_PROPERTY',
    rid: target.rid,
    objectType: target.type || 'CustomVisualization',
    property: activeProp,
    value,
  })
  if (resp?.type === 'SAVE_RESULT' && resp.ok) {
    surface.markSaved(activeProp)
    activeCode()[activeProp] = value
    consoleLines.push({ level: 'info', text: `Saved ${activeProp} to BMP` })
    refreshActions()
    renderConsole()
    // Save->reload: re-read from BMP to confirm what actually landed. A BMP
    // in-script .change() can return HTTP 200 yet silently roll back; comparing
    // the re-fetched value catches that, and reloadSlots re-seeds every slot to
    // the server-canonical text.
    const verify = await sendRequest({ type: 'STUDIO_FETCH_CODE', rid: target.rid })
    if (verify?.type === 'STUDIO_CODE_DATA' && verify.ok && verify.code) {
      const fresh = verify.code
      surface.reloadSlots(CODE_PROPS.map(p => ({ key: p, lang: p, code: fresh[p] ?? '' })))
      for (const p of CODE_PROPS) activeCode()[p] = fresh[p] ?? ''
      if ((fresh[activeProp] ?? '') !== value) {
        consoleLines.push({ level: 'error', text: `Warning: BMP's ${activeProp} differs from what was saved — possible silent rollback. The editor now shows BMP's value.` })
        renderConsole()
      }
    }
  } else {
    const err = resp?.type === 'SAVE_RESULT' ? resp.error : 'no response'
    consoleLines.push({ level: 'error', text: `Save failed: ${err ?? '(unknown)'}` })
    refreshActions()
    renderConsole()
  }
}

/** Export the CVO's source (both fields) as a single round-trippable bundle —
 *  one download (no multi-file browser prompt), good for backup/sharing. */
function doDownload() {
  if (!ctx || !surface) return
  const base = ctx.instance.businessId || ctx.instance.rid || 'cvo'
  const bundle = {
    schema: 'crev-cvo-source/1',
    id: ctx.instance.businessId || null,
    rid: ctx.instance.rid,
    name: ctx.instance.name || null,
    html: surface.textFor('html'),
    javascript: surface.textFor('javascript'),
  }
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${base}.cvo.json`
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

async function doDiscard() {
  if (!ctx || !surface || !surface.isDirty(activeProp)) return
  const ok = await confirmModal({
    title: 'Discard changes?',
    body: `Revert ${activeProp} to the value BMP last reported. Your edits will be lost.`,
    confirmLabel: 'Discard',
    confirmVariant: 'danger',
  })
  if (!ok) return
  surface.discard()
  refreshActions()
  schedulePreview()
}

function togglePreview() {
  previewVisible = !previewVisible
  // The iframe is recreated by renderShell — reset the handshake + any queued
  // render so the fresh sandbox's READY drives a clean first render.
  sandboxReady = false
  pendingRender = false
  renderShell()
  ensureSurface()
  if (previewVisible) schedulePreview()
}

// Guard the overlay close when there are unsaved edits.
installCloseHandshake(async () => {
  if (!anyDirty()) return true
  return confirmModal({
    title: 'Discard unsaved changes?',
    body: 'This CVO studio has unsaved changes. Close anyway?',
    confirmLabel: 'Discard',
    confirmVariant: 'danger',
  })
})

window.addEventListener('beforeunload', e => {
  if (!anyDirty()) return
  e.preventDefault()
  e.returnValue = ''
})

init()
