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
import { CodeSurface } from '../editor-core/code-surface'
import { h, svg, render as renderDom } from '../lib/dom'
import { sendRequest } from '../lib/messaging'
import { confirmModal } from '../lib/modal'
import { installCloseHandshake } from '../lib/frame-close-handshake'
import { getTypeAbbr, getTypeColor } from '../lib/types'
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
  context: { orgid: 'org_demo', period: 'M', start: Date.now(), end: Date.now(), yearToDate: false },
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
  document.title = ctx.instance.name ? `CVO · ${ctx.instance.name}` : 'CVO Studio'

  renderShell()
  ensureSurface()
  schedulePreview()
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
      EditorView.updateListener.of(u => { if (u.docChanged) schedulePreview() }),
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
        h('div', { class: 'studio-actions-spacer' }),
        h('button', { class: `btn-micro${previewVisible ? ' active' : ''}`, id: 'studio-toggle-preview', title: 'Show / hide the live preview', onClick: togglePreview }, previewVisible ? 'Hide preview' : 'Show preview'),
      ),
    ),
    // Property tabs (html / javascript)
    h('div', { class: 'studio-prop-tabs', role: 'tablist' },
      ...CODE_PROPS.map(p => h('button', {
        class: `studio-prop-tab${p === activeProp ? ' active' : ''}`,
        role: 'tab',
        'aria-selected': p === activeProp ? 'true' : 'false',
        onClick: () => switchProp(p),
      }, h('span', null, p), surface?.isDirty(p) ? h('span', { class: 'studio-prop-dot', 'aria-label': 'unsaved' }) : null)),
    ),
    // Split: editor | preview
    h('div', { class: `studio-split${previewVisible ? '' : ' studio-split--no-preview'}` },
      h('div', { class: 'studio-editor', id: 'studio-cm' }),
      previewVisible
        ? h('div', { class: 'studio-preview' },
            h('iframe', { id: 'studio-sandbox', class: 'studio-sandbox', src: 'sandbox.html', title: 'CVO preview' }),
            h('div', { class: 'studio-console', id: 'studio-console' }),
          )
        : null,
    ),
  )

  // Re-attach the live editor view into the freshly-rendered shell.
  surface?.reattach()
  renderConsole()
}

function refreshActions() {
  const save = document.getElementById('studio-save') as HTMLButtonElement | null
  if (save) save.disabled = !anyDirty()
  const discard = document.getElementById('studio-discard') as HTMLButtonElement | null
  if (discard) discard.disabled = !surface?.isDirty(activeProp)
  for (const tab of document.querySelectorAll<HTMLElement>('.studio-prop-tab')) {
    const p = tab.querySelector('span')?.textContent as StudioCodeProp | undefined
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

function runPreview() {
  if (previewTimer) { clearTimeout(previewTimer); previewTimer = null }
  if (!previewVisible) return
  consoleLines = []
  renderConsole()
  if (!sandboxReady) { pendingRender = true; return }
  postRender()
}

function postRender() {
  const frame = document.getElementById('studio-sandbox') as HTMLIFrameElement | null
  if (!frame?.contentWindow) { pendingRender = true; return }
  const runId = ++runCounter
  // textFor() pulls the live doc for the active slot and the stashed text for
  // the inactive one — so a render always uses the latest of both fields.
  frame.contentWindow.postMessage({
    type: 'CVO_RENDER',
    runId,
    html: surface?.textFor('html') ?? '',
    javascript: surface?.textFor('javascript') ?? '',
    data: mockData,
  }, '*')
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
  } else {
    const err = resp?.type === 'SAVE_RESULT' ? resp.error : 'no response'
    consoleLines.push({ level: 'error', text: `Save failed: ${err ?? '(unknown)'}` })
  }
  refreshActions()
  renderConsole()
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
  sandboxReady = false // the iframe is recreated by renderShell
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
