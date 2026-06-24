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
import { autocompletion } from '@codemirror/autocomplete'
import { lintGutter } from '@codemirror/lint'
import { baseEditingExtensions, baseKeymapBindings, languageExtension, catppuccinMocha, type CodeLang } from '../editor-core/cm-scaffold'
import { CodeSurface, isProgrammaticSwap } from '../editor-core/code-surface'
import { KBD_MOD } from '../editor-core/platform'
import { closeOverlayKeyBinding, installDirtyGuards } from '../editor-core/overlay'
import { detectFileResourceRids, detectCdnUrls } from './dep-detect'
import { h, svg, render as renderDom } from '../lib/dom'
import { sendRequest } from '../lib/messaging'
import { confirmModal } from '../lib/modal'
import { getTypeAbbr, getTypeColor, type StudioChild } from '../lib/types'
import { ICON_PLAY, ICON_REFRESH, ICON_FILE_JS, ICON_CHECK, ICON_ARROWS_OUT_SIMPLE, ICON_ARROWS_IN_SIMPLE } from '../lib/icons'
import { STUDIO_CTX_PREFIX, type StudioContext, type StudioCodeProp } from './studio-types'
import { isCvoSandboxOutbound, type CvoRenderRequest, type CvoConsoleLevel } from './cvo-protocol'
import { StudioConsole } from './studio-console'
import { syntaxErrorLinter, makeCvoApiSource } from './studio-editor-ext'

const CODE_PROPS: readonly StudioCodeProp[] = ['html', 'javascript']
const PREVIEW_DEBOUNCE_MS = 400

// ── State ────────────────────────────────────────────────────────
let ctx: StudioContext | null = null
/** Shared multi-slot editing engine (html + javascript slots). Owns the view,
 *  per-slot dirty, stash/restore, and save/discard baselines. */
let surface: CodeSurface | null = null
let activeProp: StudioCodeProp = 'html'
let previewVisible = true
// In-flight lock for doSave — prevents a second Cmd+S/click from stacking a
// confirm dialog or a duplicate save while the round-trips are awaited.
let saving = false
// Timestamp of the last successful save; drives the brief "Saved" pulse on the
// Save button (mirrors the EC editor).
let lastSavedAt = 0
const SAVED_FLASH_MS = 4000

// Preview data source. 'mock' uses the local mockData; 'live' fetches the real
// `_data` from BMP's data servlet for renderContextRid (org-rooted). liveData
// caches the last successful fetch; liveError holds the last failure (e.g. the
// org-gating 400) for display.
let dataMode: 'mock' | 'live' = 'mock'
let renderContextRid = ''
let liveData: Record<string, unknown> | null = null
let liveError: string | null = null
// Generation token for fetchLiveData — two rapid fetches (rid edit while a
// refresh is in flight) must not let the slower-resolving (older) one win.
let fetchGen = 0

// The CVO's data-input children (CustomVisualizationExpression). Each defines a
// `_data.expressions[key]` slot; editable here. Seeded into mockData so the mock
// preview carries the real slot keys.
let children: StudioChild[] = []

// Hosted FileResource libraries the CVO depends on, cached by rid (null =
// fetched but unavailable). lastLibs is the resolved set passed to the sandbox.
const libCache = new Map<string, string | null>()
let lastLibs: string[] = []

// The bottom panel is a single toggleable area with three tabs; null = collapsed
// so the canvas owns the preview pane. Auto-opens to 'console' on a CVO error.
type PanelTab = 'console' | 'inputs' | 'deps'
let panelTab: PanelTab | null = null
/** The persistent sandbox iframe — created once and re-attached across shell
 *  re-renders (like the editor reattaches its view), so toggling a panel /
 *  data mode / width never reloads the sandbox or flashes the preview. */
let sandboxFrame: HTMLIFrameElement | null = null

// Preview width for breakpoint testing (0 = full). The CVO re-renders at the
// chosen width, since container width changes how a responsive CVO lays out.
let previewWidth = 0
const PREVIEW_WIDTHS: ReadonlyArray<[string, number]> = [['Full', 0], ['1280', 1280], ['768', 768], ['375', 375]]

// Maximize the preview: hide the editor pane so the CVO is reviewed at full
// window width (a "full-screen CVO" view). In-place toggle — the iframe stays.
let previewMaximized = false

// Sandbox handshake: hold the latest render until the sandbox says it's ready.
let sandboxReady = false
let pendingRender = false
let runCounter = 0
/** Bumped on each runPreview so an in-flight one can bail if superseded during
 *  its async lib fetch (avoids two concurrent renders racing the ready-gate). */
let renderGen = 0
/** Console + error lines from the current run (owns its own buffer). */
const studioConsole = new StudioConsole()

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
      // CVO-API autocomplete on the javascript slot (_data.* + the live child
      // keys); plain CM completion elsewhere. Plus a dep-free syntax-error
      // linter (flags parse errors inline) + the lint gutter.
      slot.lang === 'javascript' ? autocompletion({ override: [cvoApiSource] }) : autocompletion(),
      syntaxErrorLinter,
      lintGutter(),
      keymap.of([
        ...baseKeymapBindings,
        { key: 'Ctrl-s', mac: 'Cmd-s', run: () => { doSave(); return true } },
        { key: 'Ctrl-Enter', mac: 'Cmd-Enter', run: () => { void runPreview({ retryDeps: true }); return true } },
        closeOverlayKeyBinding,
      ]),
      // Re-render on user edits only — a programmatic slot-swap (tab switch)
      // carries CodeSurface's annotation and must not trigger a preview rebuild.
      EditorView.updateListener.of(u => { if (u.docChanged && !isProgrammaticSwap(u)) schedulePreview() }),
    ],
    onDirtyChange: () => { refreshActions(); updatePropTabs() },
  })
  const code = activeCode()
  surface.setSlots(CODE_PROPS.map(p => ({ key: p, lang: p, code: code[p] ?? '' })))
  surface.activate(activeProp)
}

/** CVO-API autocomplete source — reads the live child keys lazily. */
const cvoApiSource = makeCvoApiSource(() => children.map(c => c.key).filter(Boolean))

/** Code map for the current save target (keystone always edits the instance;
 *  a template/instance toggle arrives with the rest of the edit loop). */
function activeCode(): Record<string, string> {
  if (!ctx) return {}
  return ctx.saveTarget === 'template' && ctx.template ? ctx.templateCode : ctx.instanceCode
}

// ── Shell ────────────────────────────────────────────────────────
// renderShell does the FULL build (init + preview toggle only). The frequent
// interactions (panel toggle, data mode, width, tab switch, dirty) update their
// own sub-container in place — so the sandbox iframe (created once, appended to
// #studio-canvas here) is never detached, never reloads, and never flashes.
function renderShell() {
  if (!ctx) return
  const id = ctx.instance

  renderDom(root,
    h('div', { class: 'studio-header' },
      h('div', { class: 'studio-id' },
        h('span', { class: 'studio-id-icon', title: 'CVO studio — HTML + JavaScript' }, svg(ICON_FILE_JS)),
        h('span', { class: 'studio-id-chip', style: `--type-color:${getTypeColor(id.type)}`, title: id.type || '' }, getTypeAbbr(id.type)),
        h('span', { class: 'studio-id-name' }, id.name || '(unnamed)'),
        h('span', { class: 'studio-id-bid' }, id.businessId || id.rid),
      ),
      h('div', { class: 'studio-actions', id: 'studio-actions' }),
    ),
    h('div', { class: 'studio-prop-tabs', id: 'studio-prop-tabs', role: 'tablist' }),
    h('div', { class: `studio-split${previewVisible ? '' : ' studio-split--no-preview'}${previewVisible && previewMaximized ? ' studio-split--preview-only' : ''}`, id: 'studio-split' },
      h('div', { class: 'studio-editor', id: 'studio-cm' }),
      previewVisible
        ? h('div', { class: 'studio-preview' },
            h('div', { class: 'studio-strip', id: 'studio-strip' }),
            h('div', { class: 'studio-canvas-outer' },
              h('div', { class: 'studio-canvas', id: 'studio-canvas', style: previewWidth ? `max-width:${previewWidth}px` : '' }),
            ),
            h('div', { class: 'studio-ptabs', id: 'studio-ptabs' }),
            h('div', { class: `studio-panel${panelTab ? '' : ' studio-panel--collapsed'}`, id: 'studio-panel' }),
          )
        : null,
    ),
  )

  surface?.reattach()
  if (previewVisible) {
    // Re-mounting the (persistent) iframe after a full rebuild reloads it, so
    // reset the handshake; the first preview re-renders once it's ready again.
    document.getElementById('studio-canvas')?.appendChild(ensureSandboxFrame())
    sandboxReady = false
    pendingRender = false
  }
  refreshActions()
  updatePropTabs()
  updateStrip()
  updatePanelTabs()
  renderPanelContent()
  if (previewVisible && surface) schedulePreview()
}

function ensureSandboxFrame(): HTMLIFrameElement {
  if (!sandboxFrame) {
    sandboxFrame = h('iframe', { id: 'studio-sandbox', class: 'studio-sandbox', src: 'sandbox.html', title: 'CVO preview' }) as HTMLIFrameElement
  }
  return sandboxFrame
}

/** Header action buttons + their enabled state — re-rendered in place on dirty
 *  change (never touches the canvas). */
function refreshActions() {
  const el = document.getElementById('studio-actions')
  if (!el) return
  const isDirty = anyDirty()
  const n = dirtyCount()
  // Mirror the EC editor's Save affordance: green when there are changes, a
  // brief "Saved" pulse after a commit, ghost (de-emphasised) when idle-clean.
  const justSaved = !isDirty && !saving && lastSavedAt > 0 && Date.now() - lastSavedAt < SAVED_FLASH_MS
  const saveClass = `btn ${isDirty || saving ? 'btn-success' : justSaved ? 'btn-success btn-saved' : 'btn-ghost'}`
  renderDom(el,
    h('button', { class: 'btn btn-accent', id: 'studio-run', title: 'Re-render preview (retries failed dependencies)', onClick: () => void runPreview({ retryDeps: true }) },
      svg(ICON_PLAY), ' Re-render', h('kbd', null, `${KBD_MOD}↵`)),
    h('button', { class: saveClass, id: 'studio-save', disabled: saving || !isDirty, title: `Save every changed field (html + javascript) · ${KBD_MOD}+S`, onClick: doSave },
      saving ? 'Saving…' : justSaved ? svg(ICON_CHECK) : null,
      saving ? null : justSaved ? ' Saved' : n > 1 ? `Save ${n}` : 'Save',
      isDirty ? h('kbd', null, `${KBD_MOD}S`) : null),
    h('button', { class: 'btn btn-ghost', id: 'studio-discard', disabled: !surface?.isDirty(activeProp), title: 'Revert this field to the saved BMP value', onClick: doDiscard }, 'Discard'),
    h('button', { class: 'btn btn-ghost', id: 'studio-download', title: 'Download the CVO source (html + javascript) as a .cvo.json bundle', onClick: doDownload }, 'Download'),
    h('div', { class: 'studio-actions-spacer' }),
    h('button', { class: `btn-micro${previewVisible ? ' active' : ''}`, title: 'Show / hide the live preview', onClick: togglePreview }, previewVisible ? 'Hide preview' : 'Show preview'),
  )
}

function updatePropTabs() {
  const el = document.getElementById('studio-prop-tabs')
  if (!el) return
  renderDom(el, ...CODE_PROPS.map(p => h('button', {
    class: `studio-prop-tab${p === activeProp ? ' active' : ''}`,
    role: 'tab',
    'data-prop': p,
    'aria-selected': p === activeProp ? 'true' : 'false',
    onClick: () => switchProp(p),
  }, h('span', null, p), surface?.isDirty(p) ? h('span', { class: 'studio-prop-dot', 'aria-label': 'unsaved' }) : null)))
}

const anyDirty = () => !!surface?.isDirty()
const dirtyCount = () => CODE_PROPS.filter(p => surface?.isDirty(p)).length

let previewTimer: ReturnType<typeof setTimeout> | null = null

function switchProp(p: StudioCodeProp) {
  if (p === activeProp) return
  activeProp = p
  updatePropTabs()
  refreshActions()
  surface?.activate(p)
}

/** Pull the `.error` off any studio response (all error-bearing replies carry
 *  an optional `error`), with a fallback when absent — collapses the repeated
 *  `resp?.type === 'X' ? resp.error : …` casts. */
function respError(resp: unknown, fallback = ''): string {
  const e = resp && typeof resp === 'object' && 'error' in resp ? (resp as { error?: unknown }).error : undefined
  return (typeof e === 'string' ? e : undefined) ?? fallback
}

// ── Preview (sandbox) ────────────────────────────────────────────
function schedulePreview() {
  if (previewTimer) clearTimeout(previewTimer)
  previewTimer = setTimeout(() => runPreview(), PREVIEW_DEBOUNCE_MS)
}

async function runPreview(opts: { retryDeps?: boolean } = {}) {
  if (previewTimer) { clearTimeout(previewTimer); previewTimer = null }
  if (!previewVisible) return
  const gen = ++renderGen
  clearConsole()
  // An explicit Re-render retries deps that previously failed to load (e.g. the
  // BMP session came up since); auto-renders don't, to avoid re-warning on
  // every keystroke. Resolve libraries before the ready-gate so a queued render
  // flushes with them ready.
  if (opts.retryDeps) for (const [rid, v] of libCache) if (v === null) libCache.delete(rid)
  const libs = await ensureLibs()
  if (gen !== renderGen) return // a newer runPreview started during the await
  lastLibs = libs // commit only after winning the gen race (no clobber by a stale ensureLibs)
  if (!sandboxReady) { pendingRender = true; return }
  postRender()
}

/** Detect the FileResource libraries the CVO loads and fetch their bytes via
 *  the SW (cookie-authed download), caching by rid. A transport failure (e.g.
 *  no BMP session) is cached as null and warned once so the CVO degrades rather
 *  than blocking; an explicit Re-render clears those nulls to retry. Returns the
 *  resolved set (the caller commits it after winning the render-gen race). */
async function ensureLibs(): Promise<string[]> {
  const rids = detectFileResourceRids(surface?.textFor('html') ?? '', surface?.textFor('javascript') ?? '')
  for (const rid of rids) {
    if (libCache.has(rid)) continue
    const resp = await sendRequest({ type: 'STUDIO_FETCH_RESOURCE', rid })
    if (resp?.type === 'STUDIO_RESOURCE' && resp.ok && resp.text != null) {
      libCache.set(rid, resp.text)
    } else {
      libCache.set(rid, null)
      logConsole('warn', `Dependency ${rid} unavailable (${respError(resp, 'no response')}) — preview runs without it`)
    }
  }
  return rids.map(r => libCache.get(r)).filter((t): t is string => !!t)
}

function postRender() {
  const frame = sandboxFrame
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
  const req: CvoRenderRequest = {
    type: 'CVO_RENDER',
    runId,
    html: surface?.textFor('html') ?? '',
    javascript: surface?.textFor('javascript') ?? '',
    data,
    libs: lastLibs,
  }
  frame.contentWindow.postMessage(req, '*')
}

// ── Control strip (one dense row: data source + width) ───────────
function updateStrip(): void {
  const el = document.getElementById('studio-strip')
  if (!el) return
  const ctxInput = h('input', {
    class: 'studio-ctx-input',
    placeholder: 'render-context rid',
    value: renderContextRid,
    spellcheck: 'false', autocomplete: 'off',
    title: 'Org-rooted object (scorecard/page) the CVO renders under — the data servlet is gated on it',
  }) as HTMLInputElement
  ctxInput.addEventListener('change', () => { renderContextRid = ctxInput.value.trim(); if (dataMode === 'live') fetchLiveData() })
  renderDom(el,
    h('div', { class: 'studio-seg', role: 'group', 'aria-label': 'Preview data' },
      h('button', { class: `studio-seg-btn${dataMode === 'mock' ? ' active' : ''}`, title: 'Render against local mock _data', onClick: () => setDataMode('mock') }, 'Mock'),
      h('button', { class: `studio-seg-btn${dataMode === 'live' ? ' active' : ''}`, title: 'Render against real BMP _data for the render context', onClick: () => setDataMode('live') }, 'Live'),
    ),
    dataMode === 'live' ? ctxInput : null,
    dataMode === 'live' ? h('button', { class: 'studio-icon-btn', title: 'Re-fetch live data', onClick: () => fetchLiveData() }, svg(ICON_REFRESH)) : null,
    dataMode === 'live' && liveError ? h('span', { class: 'studio-strip-err', title: liveError }, '⚠ live') : null,
    dataMode === 'live' && !liveError && liveData ? h('span', { class: 'studio-strip-ok', title: 'Rendering against live BMP data' }, '● live') : null,
    h('div', { class: 'studio-strip-spacer' }),
    h('div', { class: 'studio-seg', role: 'group', 'aria-label': 'Preview width' },
      ...PREVIEW_WIDTHS.map(([label, w]) => h('button', { class: `studio-seg-btn${previewWidth === w ? ' active' : ''}`, title: w ? `Render at ${w}px container width` : 'Full container width', onClick: () => setPreviewWidth(w) }, label)),
    ),
    h('button', {
      class: `studio-icon-btn${previewMaximized ? ' active' : ''}`,
      title: previewMaximized ? 'Restore the editor' : 'Maximize the preview (hide the editor)',
      'aria-label': previewMaximized ? 'Restore the editor' : 'Maximize the preview',
      'aria-pressed': previewMaximized ? 'true' : 'false',
      onClick: () => setPreviewMaximized(!previewMaximized),
    }, svg(previewMaximized ? ICON_ARROWS_IN_SIMPLE : ICON_ARROWS_OUT_SIMPLE)),
  )
}

function setPreviewMaximized(on: boolean): void {
  if (on === previewMaximized) return
  previewMaximized = on
  // In place: toggle the editor-hidden class on the split (the persistent iframe
  // stays mounted) and re-render the CVO, which now has the full window width.
  document.getElementById('studio-split')?.classList.toggle('studio-split--preview-only', on)
  updateStrip()
  void runPreview()
}

function setPreviewWidth(w: number): void {
  if (w === previewWidth) return
  previewWidth = w
  // In place: resize the canvas (the persistent iframe stays mounted) + re-render
  // the CVO at the new width (a responsive CVO lays out per container width).
  const canvas = document.getElementById('studio-canvas')
  if (canvas) canvas.style.maxWidth = w ? `${w}px` : ''
  updateStrip()
  void runPreview()
}

function setDataMode(mode: 'mock' | 'live'): void {
  if (mode === dataMode) return
  dataMode = mode
  liveError = null
  updateStrip()
  if (mode === 'live' && !liveData) fetchLiveData()
  else void runPreview()
}

async function fetchLiveData(): Promise<void> {
  if (!ctx) return
  if (!renderContextRid) {
    liveData = null
    liveError = 'no render context'
    logConsole('error', 'Live data needs an org-rooted render context — paste a scorecard/page rid in the Live field.')
    updateStrip()
    return
  }
  liveError = null
  const gen = ++fetchGen
  const resp = await sendRequest({ type: 'STUDIO_FETCH_DATA', cvoRid: ctx.instance.rid, businessObjectRid: renderContextRid })
  if (gen !== fetchGen) return // a newer fetch started during the await — its result wins
  if (resp?.type === 'STUDIO_DATA' && resp.ok && resp.data) {
    liveData = resp.data as Record<string, unknown>
    liveError = null
  } else {
    liveData = null
    liveError = respError(resp, 'Live data fetch failed')
    logConsole('error', `Live data: ${liveError}`)
  }
  updateStrip()
  void runPreview()
}

// ── Bottom panel (Console · Inputs · Deps), one toggleable area ──
function togglePanel(tab: PanelTab): void {
  panelTab = panelTab === tab ? null : tab
  updatePanelTabs()
  renderPanelContent()
}

function updatePanelTabs(): void {
  const el = document.getElementById('studio-ptabs')
  if (!el) return
  const errCount = studioConsole.errorCount
  const html = surface?.textFor('html') ?? ''
  const js = surface?.textFor('javascript') ?? ''
  const depCount = detectFileResourceRids(html, js).length + detectCdnUrls(html, js).length
  const tab = (id: PanelTab, label: string, count: number, err = false) =>
    h('button', { class: `studio-ptab${panelTab === id ? ' active' : ''}`, role: 'tab', onClick: () => togglePanel(id) },
      label,
      count ? h('span', { class: 'studio-ptab-n' }, String(count)) : null,
      err ? h('span', { class: 'studio-ptab-err', 'aria-label': 'errors' }) : null,
    )
  renderDom(el,
    tab('console', 'Console', studioConsole.count, errCount > 0),
    tab('inputs', 'Inputs', children.length),
    tab('deps', 'Deps', depCount),
  )
}

function renderPanelContent(): void {
  const el = document.getElementById('studio-panel')
  if (!el) return
  el.className = `studio-panel${panelTab ? '' : ' studio-panel--collapsed'}`
  if (panelTab === 'console') studioConsole.renderInto(el)
  else if (panelTab === 'inputs') renderInputsInto(el)
  else if (panelTab === 'deps') renderDepsInto(el)
  else renderDom(el)
}

/** Push a console line and reflect it (auto-opens the Console tab on error). */
function logConsole(level: CvoConsoleLevel, text: string): void {
  studioConsole.push(level, text)
  if (level === 'error' && panelTab !== 'console') panelTab = 'console'
  updatePanelTabs()
  renderPanelContent()
}

function clearConsole(): void {
  studioConsole.clear()
  updatePanelTabs()
  renderPanelContent()
}

// ── Data inputs (CVO children → _data.expressions) ───────────────
async function fetchChildren(): Promise<void> {
  if (!ctx?.instance.businessId) return
  const resp = await sendRequest({ type: 'STUDIO_FETCH_CHILDREN', cvoBid: ctx.instance.businessId })
  if (resp?.type === 'STUDIO_CHILDREN' && resp.ok && resp.children) {
    children = resp.children
    seedMockFromChildren()
    updatePanelTabs()
    renderPanelContent()
    void runPreview() // the mock _data shape changed (new slot keys)
  }
}

/** Give the mock `_data.expressions` the real slot keys (empty placeholder
 *  values), so a mock-mode preview sees the same shape as live. */
function seedMockFromChildren(): void {
  const ex: Record<string, string> = {}
  for (const c of children) if (c.key) ex[c.key] = mockData.expressions[c.key] ?? ''
  mockData.expressions = ex
}

function renderInputsInto(el: HTMLElement): void {
  renderDom(el,
    children.length === 0 ? h('div', { class: 'studio-panel-empty' }, 'No expression inputs') : null,
    ...children.map(renderChildRow),
    h('button', { class: 'studio-panel-add', title: 'Add a CustomVisualizationExpression input', onClick: doAddChild }, '+ Add input'),
  )
}

function renderChildRow(c: StudioChild): HTMLElement {
  const keyInput = h('input', { class: 'studio-child-key-input', value: c.key, spellcheck: 'false', autocomplete: 'off', title: 'JS key — _data.expressions.' + (c.key || '?') }) as HTMLInputElement
  const exprInput = h('input', { class: 'studio-child-expr', value: c.expression, spellcheck: 'false', autocomplete: 'off', title: c.expression || 'Reporter token, e.g. ${t.my_expr.expression}' }) as HTMLInputElement
  return h('div', { class: 'studio-child-row' },
    keyInput,
    exprInput,
    h('button', { class: 'btn-micro', title: 'Save key + expression', onClick: () => doSaveChild(c, keyInput.value.trim(), exprInput.value) }, 'Save'),
    h('button', { class: 'btn-micro studio-child-del', title: 'Remove this input', onClick: () => doRemoveChild(c) }, '✕'),
  )
}

async function doSaveChild(c: StudioChild, key: string, expression: string): Promise<void> {
  let okAll = true
  if (key && key !== c.key) {
    const r = await sendRequest({ type: 'SAVE_PROPERTY', rid: c.rid, objectType: 'CustomVisualizationExpression', property: 'key', value: key })
    if (r?.type === 'SAVE_RESULT' && r.ok) c.key = key
    else { okAll = false; logConsole('error', `Key save failed: ${respError(r)}`) }
  }
  if (expression !== c.expression) {
    const r = await sendRequest({ type: 'SAVE_PROPERTY', rid: c.rid, objectType: 'CustomVisualizationExpression', property: 'expression', value: expression })
    if (r?.type === 'SAVE_RESULT' && r.ok) c.expression = expression
    else { okAll = false; logConsole('error', `Expression save failed: ${respError(r)}`) }
  }
  if (okAll) logConsole('info', `Saved input "${c.key}"`)
  seedMockFromChildren()
  renderPanelContent()
  if (dataMode === 'live') fetchLiveData(); else void runPreview()
}

async function doAddChild(): Promise<void> {
  if (!ctx?.instance.businessId) return
  const key = `input_${children.length + 1}`
  const childId = `cve_${(ctx.instance.businessId || 'cvo').replace(/[^\w-]/g, '')}_${key}`
  const resp = await sendRequest({ type: 'STUDIO_ADD_CHILD', cvoBid: ctx.instance.businessId, childId, key })
  if (resp?.type === 'STUDIO_CHILD_ADDED' && resp.ok) { logConsole('info', `Added input "${key}"`); await fetchChildren() }
  else logConsole('error', `Add failed: ${respError(resp)}`)
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
  if (resp?.type === 'STUDIO_CHILD_DELETED' && resp.ok) { logConsole('info', `Removed input "${c.key}"`); await fetchChildren() }
  else logConsole('error', `Remove failed: ${respError(resp)}`)
}

// ── Dependencies + resource hosting ──────────────────────────────
function renderDepsInto(el: HTMLElement): void {
  const html = surface?.textFor('html') ?? ''
  const js = surface?.textFor('javascript') ?? ''
  const fileRes = detectFileResourceRids(html, js)
  const cdns = detectCdnUrls(html, js)
  renderDom(el,
    fileRes.length + cdns.length === 0 ? h('div', { class: 'studio-panel-empty' }, 'No external dependencies') : null,
    ...fileRes.map(rid => {
      const cached = libCache.get(rid)
      const status = cached === undefined ? '…' : cached ? '✓ loaded' : '✗ unavailable'
      return h('div', { class: 'studio-dep-row' },
        h('span', { class: 'studio-dep-kind' }, 'FileResource'),
        h('span', { class: 'studio-dep-id', title: 'rid ' + rid }, rid),
        h('span', { class: `studio-dep-status${cached === null ? ' studio-dep-warn' : ''}` }, status),
      )
    }),
    ...cdns.map(u => h('div', { class: 'studio-dep-row' },
      h('span', { class: 'studio-dep-kind studio-dep-kind--cdn' }, 'CDN'),
      h('span', { class: 'studio-dep-id', title: u }, u),
      h('span', { class: 'studio-dep-status studio-dep-warn' }, "⚠ won't load if air-gapped"),
    )),
    h('button', { class: 'studio-panel-add', title: 'Host a JS/asset file as a BMP FileResource', onClick: doHostResource }, '+ Host resource'),
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
    input.onchange = null // release the closure; the detached input is then GC-able
    const file = input.files?.[0]
    if (!file) return
    const bytes = new Uint8Array(await file.arrayBuffer())
    const resId = 'fr_' + file.name.replace(/[^\w]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48)
    const mime = file.type || 'application/octet-stream'
    logConsole('info', `Hosting ${file.name} (${Math.round(bytes.length / 1024)} KB)…`)
    const resp = await sendRequest({ type: 'STUDIO_WRITE_RESOURCE', resId, name: file.name, mime, base64: bytesToBase64(bytes) })
    if (resp?.type === 'STUDIO_RESOURCE_WRITTEN' && resp.ok && resp.rid) {
      const snippet = `<script src="/<workspace>/web/download?propName=content&rid=${resp.rid}"></script>`
      navigator.clipboard?.writeText(snippet).catch(() => {})
      logConsole('info', `Hosted "${file.name}" as rid ${resp.rid}. Reference snippet copied (set <workspace>):\n${snippet}`)
    } else {
      logConsole('error', `Host failed: ${respError(resp)}`)
    }
  }
  input.click()
}

window.addEventListener('message', ev => {
  if (!sandboxFrame || ev.source !== sandboxFrame.contentWindow) return
  const msg = ev.data
  if (!isCvoSandboxOutbound(msg)) return
  if (msg.type === 'CVO_SANDBOX_READY') {
    sandboxReady = true
    if (pendingRender) { pendingRender = false; postRender() }
    return
  }
  // Drop output from superseded runs.
  if (msg.runId !== runCounter) return
  if (msg.type === 'CVO_CONSOLE') logConsole(msg.level, msg.text)
  else if (msg.type === 'CVO_ERROR') logConsole('error', msg.message || 'Error')
})

// ── Save / discard / preview toggle ──────────────────────────────
async function doSave() {
  if (!ctx || !surface || saving) return
  // A CVO is html + javascript as ONE object. Commit every dirty code field in
  // one gesture — saving only the active field silently stranded the other,
  // an easy way to lose edits when switching tabs before saving.
  const dirty = CODE_PROPS.filter(p => surface!.isDirty(p))
  if (!dirty.length) return
  const target = ctx.saveTarget === 'template' && ctx.template ? ctx.template : ctx.instance
  // Lock before the confirm so a second Cmd+S can't stack a dialog or a save.
  saving = true
  refreshActions()
  try {
    await doSaveInner(target, dirty)
  } finally {
    saving = false
    refreshActions()
  }
}

async function doSaveInner(target: StudioContext['instance'], dirty: StudioCodeProp[]): Promise<void> {
  if (!surface) return
  const ok = await confirmModal({
    title: dirty.length > 1 ? `Save ${dirty.join(' + ')}` : `Save ${dirty[0]}`,
    body: `Write ${dirty.join(' and ')} to "${target.name || target.businessId || target.rid}"?`,
    confirmLabel: 'Save',
    confirmVariant: 'success',
  })
  if (!ok) return

  const savedValues = new Map<StudioCodeProp, string>()
  for (const p of dirty) {
    const value = surface.textFor(p)
    const resp = await sendRequest({
      type: 'SAVE_PROPERTY',
      rid: target.rid,
      objectType: target.type || 'CustomVisualization',
      property: p,
      value,
    })
    if (resp?.type === 'SAVE_RESULT' && resp.ok) {
      surface.markSaved(p)
      activeCode()[p] = value
      savedValues.set(p, value)
      logConsole('info', `Saved ${p} to BMP`)
    } else {
      logConsole('error', `Save failed for ${p}: ${respError(resp, 'no response')}`)
    }
  }
  if (!savedValues.size) return
  // Arm the "Saved" pulse and let it lapse on its own.
  lastSavedAt = Date.now()
  setTimeout(() => refreshActions(), SAVED_FLASH_MS)

  // Save->reload: re-read from BMP once to confirm what actually landed. A BMP
  // in-script .change() can return HTTP 200 yet silently roll back; comparing
  // the re-fetched value catches that. Only re-seed the slots we SAVED, and
  // only if the user hasn't re-edited them during the (awaited) round-trips —
  // re-seeding every slot would silently overwrite an edit typed into the other
  // field while the save was in flight.
  const verify = await sendRequest({ type: 'STUDIO_FETCH_CODE', rid: target.rid })
  if (verify?.type === 'STUDIO_CODE_DATA' && verify.ok && verify.code) {
    const fresh = verify.code
    for (const [p, value] of savedValues) {
      if ((fresh[p] ?? '') !== value) {
        logConsole('error', `Warning: BMP's ${p} differs from what was saved — possible silent rollback. The editor now shows BMP's value.`)
      }
      if (!surface.isDirty(p)) {
        surface.reloadSlots([{ key: p, lang: p, code: fresh[p] ?? '' }])
        activeCode()[p] = fresh[p] ?? ''
      }
    }
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
  updatePropTabs()
  void runPreview()
}

function togglePreview() {
  // renderShell rebuilds the structure; for a preview toggle it re-mounts (and
  // reloads) the iframe + resets the handshake, then schedules the first render.
  previewVisible = !previewVisible
  // Hiding the preview makes "maximize preview" meaningless; drop it so showing
  // the preview again returns to the normal split.
  if (!previewVisible) previewMaximized = false
  renderShell()
}

// Guard the overlay close when there are unsaved edits.
installDirtyGuards({ isDirty: anyDirty, bodyText: 'This CVO studio has unsaved changes. Close anyway?' })

init()
