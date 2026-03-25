/**
 * CREV Inspector — EC Editor Window.
 * CodeMirror 6 editor for Extended Code, HTML, and JavaScript properties.
 * Communicates with service worker for preview/save operations.
 */
import { EditorState, Compartment } from '@codemirror/state'
import { EditorView, keymap, lineNumbers, highlightActiveLineGutter, highlightActiveLine, drawSelection } from '@codemirror/view'
import { defaultKeymap, indentWithTab, history, historyKeymap } from '@codemirror/commands'
import { bracketMatching, foldGutter, indentOnInput, foldKeymap } from '@codemirror/language'
import { closeBrackets, closeBracketsKeymap, autocompletion } from '@codemirror/autocomplete'
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search'
import { lintGutter } from '@codemirror/lint'
import { oneDark } from '@codemirror/theme-one-dark'

// Shared types + context helpers
import { type SaveTarget, type ScriptHistoryEntry } from '../lib/types'
import { h, render as renderDom } from '../lib/dom'
import { renderEcOutput } from './ec-output'
import {
  type EditorContext,
  formatLabel,
  getActiveCode,
  getActiveIdentity,
  getExecutionRid,
  getSaveTarget,
} from './editor-types'

// EC-specific extensions
import { extendedLanguage } from './ec/language'
import { extendedHighlighting } from './ec/highlight'
import { extendedCompletions, variableTracker, getTrackedVariables } from './ec/completions'
import { extendedHoverDocs } from './ec/hoverDocs'
import { bmpObjectHover } from './ec/bmpObjectHover'
import { extendedLinter } from './ec/diagnostics'
import { ecBlockMatching } from './ec/blockMatching'
import { ecFoldService } from './ec/foldRegions'
import { wrapInIf, wrapInForEach } from './ec/wrapCommands'
import { renameAllOccurrences, selectNextOccurrence } from './ec/renameVariable'

// ── State ────────────────────────────────────────────────────────

let ctx: EditorContext | null = null
let editorView: EditorView | null = null
let activeProperty = ''
let bottomPanelOpen = false
let bottomMode: 'output' | 'snippets' | 'history' | 'vars' = 'output'
let dirty = false
let outputHeight = 160 // default px, persisted
let previewDone = false // gating: Run unlocked only after successful preview
let lastMode: 'preview' | 'execute' | 'save' | null = null
let lastDuration: number | null = null
let lastOutputText = ''
let lastOutputOk = true
let historyEntries: ScriptHistoryEntry[] = []
const wrapCompartment = new Compartment()
let wrapLines = false

// ── Init ─────────────────────────────────────────────────────────

const root = document.getElementById('editor-root')!

async function init() {
  renderDom(root, h('div', { class: 'editor-loading' }, 'Loading\u2026'))

  // Load context from per-RID key (hash = RID)
  try {
    const rid = location.hash.slice(1)
    const perRidKey = rid ? `crev_editor_ctx_${rid}` : null
    const keys = ['crev_editor_output_height']
    if (perRidKey) keys.push(perRidKey)
    const result = await chrome.storage.local.get(keys)
    ctx = perRidKey ? (result[perRidKey] as EditorContext | null) : null
    if (typeof result.crev_editor_output_height === 'number') {
      outputHeight = result.crev_editor_output_height
    }
  } catch {
    renderDom(root, h('div', { class: 'editor-loading' }, 'Failed to load context'))
    return
  }

  if (!ctx) {
    renderDom(root, h('div', { class: 'editor-loading' }, 'No editor context found'))
    return
  }

  if (ctx.extended) {
    activeProperty = ''
    updateWindowTitle()
    renderShell()
    createEditor('')
  } else {
    const activeCode = getActiveCode(ctx)
    activeProperty = ctx.property ?? Object.keys(activeCode)[0] ?? 'expression'
    if (!activeCode[activeProperty]) {
      activeProperty = Object.keys(activeCode)[0] ?? 'expression'
    }
    updateWindowTitle()
    renderShell()
    createEditor(activeCode[activeProperty] ?? '')
  }
}

// ── Window title ────────────────────────────────────────────────

function updateWindowTitle() {
  if (!ctx) return
  if (ctx.extended) {
    const name = ctx.instance.name
    document.title = name ? `Extended Code \u2014 ${name}` : 'Extended Code'
    return
  }
  const identity = getActiveIdentity(ctx)
  document.title = `${identity.type || 'Object'} \u00b7 ${formatLabel(identity, 'full')}`
}

// ── Shell layout ─────────────────────────────────────────────────

function renderShell() {
  if (!ctx) return

  const isExtended = !!ctx.extended
  const activeCode = getActiveCode(ctx)
  const propKeys = Object.keys(activeCode)

  // Property tabs with override indicators
  const propTabs = (!isExtended && propKeys.length > 1)
    ? h('div', { class: 'editor-prop-tabs' },
        ...propKeys.map(key =>
          h('button', {
            class: `editor-prop-tab${key === activeProperty ? ' active' : ''}${ctx!.overrides[key] ? ' editor-prop-tab--overridden' : ''}`,
            'data-prop': key,
            title: ctx!.overrides[key] ? 'Instance differs from template' : '',
          }, key),
        ),
      )
    : false

  // Template/instance toggle with identity labels
  const toggle = (!isExtended && ctx.template)
    ? h('div', { class: 'editor-target-toggle' },
        h('button', {
          class: `editor-target-btn${ctx.saveTarget === 'template' ? ' active' : ''}`,
          'data-target': 'template',
          title: `${formatLabel(ctx.template!, 'full')} \u2014 changes propagate`,
        }, formatLabel(ctx.template!, 'short')),
        h('button', {
          class: `editor-target-btn${ctx.saveTarget === 'instance' ? ' active' : ''}`,
          'data-target': 'instance',
          title: formatLabel(ctx.instance, 'full'),
        }, formatLabel(ctx.instance, 'short')),
      )
    : false

  // Target label
  const targetChildren: (HTMLElement | string)[] = []
  if (isExtended) {
    const inst = ctx.instance
    targetChildren.push(inst.name ? `${inst.type || 'Page'} \u00b7 ${inst.name}` : 'Extended Code')
  } else {
    const identity = getActiveIdentity(ctx)
    const bid = identity.businessId || identity.type || identity.rid
    const isTemplateMode = ctx.saveTarget === 'template' && ctx.template
    if (isTemplateMode) {
      targetChildren.push(`template: ${bid}`)
    } else {
      targetChildren.push(propKeys.length <= 1 ? `${bid} \u00b7 ${activeProperty}` : bid)
    }
    if (!isTemplateMode && propKeys.length <= 1 && ctx.overrides[activeProperty]) {
      targetChildren.push(h('span', { class: 'editor-override-dot', title: 'Instance differs from template' }))
    }
  }

  renderDom(root,
    h('div', { class: 'editor-cm-wrap', id: 'cm-container' }),
    h('div', { class: 'editor-toolbar' },
      h('button', { class: 'btn btn-accent', id: 'btn-preview' }, 'Preview \u25B6'),
      h('button', { class: 'btn btn-danger', id: 'btn-run', disabled: !previewDone, title: previewDone ? 'Execute transactionally' : 'Preview first to unlock' }, 'Run \u25B6'),
      !isExtended && h('button', { class: 'btn btn-success', id: 'btn-save' }, 'Save'),
      h('button', { class: 'btn', id: 'btn-copy' }, 'Copy'),
      propTabs,
      toggle,
      h('span', { class: 'editor-toolbar-target' }, ...targetChildren),
      h('div', { class: 'editor-toolbar-spacer' }),
      h('span', { class: 'editor-status', id: 'status-bar' }, 'Ln 1, Col 1'),
    ),
    h('div', { class: 'editor-drag-handle', id: 'drag-handle', style: 'display:none' }),
    h('div', { class: 'editor-output', id: 'bottom-panel', style: `display:none;height:${outputHeight}px` },
      h('div', { id: 'bottom-panel-content' }),
    ),
    h('div', { class: 'editor-bottom-bar', id: 'bottom-bar' },
      h('button', { class: 'btn-bottom', id: 'btn-clear', title: 'Clear editor and output' }, '\u2715 Clear'),
      h('button', { class: 'btn-bottom', id: 'btn-wrap', title: 'Toggle line wrapping' }, '\u21a9 Wrap'),
      h('div', { class: 'editor-bottom-spacer' }),
      h('button', { class: 'btn-bottom', id: 'btn-vars' }, '\u{1D465} Vars'),
      h('button', { class: 'btn-bottom', id: 'btn-snippets' }, '{ } Snippets'),
      h('button', { class: 'btn-bottom', id: 'btn-history' }, '\u25d4 History'),
    ),
  )

  // Wire toolbar
  document.getElementById('btn-preview')?.addEventListener('click', doPreview)
  document.getElementById('btn-run')?.addEventListener('click', doRun)
  document.getElementById('btn-save')?.addEventListener('click', doSave)
  document.getElementById('btn-copy')?.addEventListener('click', doCopy)
  document.getElementById('btn-clear')?.addEventListener('click', doClear)
  document.getElementById('btn-vars')?.addEventListener('click', toggleVars)
  document.getElementById('btn-snippets')?.addEventListener('click', toggleSnippets)
  document.getElementById('btn-history')?.addEventListener('click', toggleHistory)
  document.getElementById('btn-wrap')?.addEventListener('click', toggleWrap)
  wireDragHandle()

  // Wire template/instance toggle
  for (const btn of document.querySelectorAll<HTMLElement>('.editor-target-btn')) {
    btn.addEventListener('click', () => {
      const target = btn.dataset.target as SaveTarget
      if (!target || !ctx || target === ctx.saveTarget) return
      // Save current code to the current target's code
      if (editorView) {
        const currentCode = getActiveCode(ctx)
        currentCode[activeProperty] = editorView.state.doc.toString()
      }
      ctx.saveTarget = target
      previewDone = false
      // Re-determine active property from new target's code
      const newCode = getActiveCode(ctx)
      if (!newCode[activeProperty]) {
        activeProperty = Object.keys(newCode)[0] ?? activeProperty
      }
      updateWindowTitle()
      renderShell()
      createEditor(newCode[activeProperty] ?? '')
    })
  }

  // Wire property tabs
  for (const tab of document.querySelectorAll<HTMLElement>('.editor-prop-tab')) {
    tab.addEventListener('click', () => {
      const prop = tab.dataset.prop
      if (!prop || prop === activeProperty || !ctx) return
      // Save current code
      if (editorView) {
        const currentCode = getActiveCode(ctx)
        currentCode[activeProperty] = editorView.state.doc.toString()
      }
      activeProperty = prop
      previewDone = false
      renderShell()
      const code = getActiveCode(ctx)
      createEditor(code[prop] ?? '')
    })
  }
}

// ── CodeMirror setup ─────────────────────────────────────────────

function createEditor(code: string) {
  const container = document.getElementById('cm-container')
  if (!container) return

  // Destroy previous instance
  if (editorView) {
    editorView.destroy()
    editorView = null
  }

  const isEc = activeProperty === 'expression'

  const extensions = [
    // Base
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightActiveLine(),
    drawSelection(),
    bracketMatching(),
    closeBrackets(),
    indentOnInput(),
    history(),
    foldGutter(),
    highlightSelectionMatches(),
    autocompletion({ override: isEc ? [extendedCompletions] : undefined }),
    oneDark,
    wrapCompartment.of(wrapLines ? EditorView.lineWrapping : []),

    // Keymaps
    keymap.of([
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...foldKeymap,
      indentWithTab,
      // EC-specific
      { key: 'Ctrl-Shift-x', run: wrapInIf },
      { key: 'Ctrl-Shift-e', run: wrapInForEach },
      { key: 'F2', run: renameAllOccurrences },
      { key: 'Ctrl-d', run: selectNextOccurrence },
      // Preview / Run / Save shortcuts
      { key: 'Ctrl-Enter', run: () => { doPreview(); return true } },
      { key: 'F5', run: () => { doPreview(); return true }, preventDefault: true },
      { key: 'Ctrl-Shift-Enter', run: () => { doRun(); return true } },
      { key: 'Ctrl-s', run: () => { doSave(); return true } },
    ]),

    // Cursor position + selection tracking + previewDone gating
    EditorView.updateListener.of(update => {
      if (update.selectionSet || update.docChanged) {
        updateStatusBar(update.view)
        const { from, to } = update.state.selection.main
        const btn = document.getElementById('btn-preview')
        if (btn) btn.textContent = from !== to ? 'Preview \u25B6 \u00b7' : 'Preview \u25B6'
      }
      if (update.docChanged) {
        dirty = true
        // Reset preview gate when code changes
        if (previewDone) {
          previewDone = false
          updateRunButton()
        }
      }
    }),
  ]

  // EC-specific extensions
  if (isEc) {
    extensions.push(
      extendedLanguage,
      extendedHighlighting,
      variableTracker,
      extendedHoverDocs,
      bmpObjectHover,
      extendedLinter,
      ecBlockMatching,
      ecFoldService,
      lintGutter(),
    )
  }

  const state = EditorState.create({
    doc: code,
    extensions,
  })

  editorView = new EditorView({
    state,
    parent: container,
  })

  dirty = false
  editorView.focus()
}

// ── Status bar ───────────────────────────────────────────────────

function updateStatusBar(view: EditorView) {
  const pos = view.state.selection.main.head
  const line = view.state.doc.lineAt(pos)
  const col = pos - line.from + 1
  const bar = document.getElementById('status-bar')
  if (bar) bar.textContent = `Ln ${line.number}, Col ${col}`
}

// ── Actions ──────────────────────────────────────────────────────

/** Return selected text if any, otherwise full document. */
function getRunCode(): string {
  if (!editorView) return ''
  const { from, to } = editorView.state.selection.main
  if (from !== to) return editorView.state.doc.sliceString(from, to)
  return editorView.state.doc.toString()
}

async function doPreview() { await executeEc(false) }
async function doRun() { if (previewDone) await executeEc(true) }

async function executeEc(transactional: boolean) {
  if (!editorView || !ctx) return
  const code = getRunCode()
  const startTime = Date.now()

  lastMode = transactional ? 'execute' : 'preview'
  lastDuration = null
  showOutput(transactional ? 'Executing\u2026' : 'Previewing\u2026', true)

  let ok = false
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'EC_EXECUTE',
      code,
      objectRid: getExecutionRid(ctx),
      ...(transactional ? { transactional: true } : {}),
    })
    lastDuration = Date.now() - startTime
    ok = response?.ok !== false
    if (ok) {
      showOutput(response?.log ?? 'No output', true)
    } else {
      showOutput(response?.error ?? response?.log ?? 'Execution failed', false)
    }
  } catch (e) {
    lastDuration = Date.now() - startTime
    showOutput(String(e), false)
  }

  // Preview gate: successful preview unlocks Run; Run always re-locks
  if (transactional) {
    previewDone = false
  } else {
    previewDone = ok
  }
  updateRunButton()

  // Refresh history in background
  chrome.runtime.sendMessage({ type: 'GET_SCRIPT_HISTORY' }).then((r: any) => {
    if (r?.entries) historyEntries = r.entries
  }).catch(() => {})
}

/** Update Run button disabled state and tooltip */
function updateRunButton() {
  const btn = document.getElementById('btn-run') as HTMLButtonElement | null
  if (!btn) return
  btn.disabled = !previewDone
  btn.title = previewDone ? 'Execute transactionally (Ctrl+Shift+Enter)' : 'Preview first to unlock'
}

async function doSave() {
  if (!editorView || !ctx) return
  const code = editorView.state.doc.toString()

  const target = getSaveTarget(ctx)
  const targetLabel = ctx.saveTarget === 'template' && ctx.template
    ? `template "${formatLabel(target.identity, 'full')}"`
    : `instance "${formatLabel(target.identity, 'full')}"`

  if (!confirm(`Save ${activeProperty} to ${targetLabel}?`)) return

  lastMode = 'save'
  lastDuration = null
  const btn = document.getElementById('btn-save') as HTMLButtonElement
  if (btn) { btn.disabled = true; btn.textContent = 'Saving\u2026' }

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'SAVE_PROPERTY',
      rid: target.rid,
      objectType: target.type,
      property: activeProperty,
      value: code,
    })
    if (response?.ok) {
      showOutput(`Saved to ${targetLabel}`, true)
      dirty = false
      // Update in-memory code
      const activeCodeMap = getActiveCode(ctx)
      activeCodeMap[activeProperty] = code
      // Persist updated context
      const rid = location.hash.slice(1)
      if (rid) {
        await chrome.storage.local.set({ [`crev_editor_ctx_${rid}`]: ctx })
      }
    } else {
      showOutput(response?.error ?? 'Save failed', false)
    }
  } catch (e) {
    showOutput(String(e), false)
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Save' }
  }
}

function doCopy() {
  if (!editorView) return
  const code = editorView.state.doc.toString()
  navigator.clipboard.writeText(code)
  const btn = document.getElementById('btn-copy')
  if (btn) {
    btn.textContent = '\u2713 Copied'
    setTimeout(() => { btn.textContent = 'Copy' }, 1000)
  }
}

// ── Bottom panel (output / snippets / history) ──────────────────

function showOutput(text: string, ok: boolean) {
  lastOutputText = text
  lastOutputOk = ok
  bottomMode = 'output'
  bottomPanelOpen = true
  openBottomPanel()
  renderBottomContent()
}

function openBottomPanel() {
  const panel = document.getElementById('bottom-panel')
  const handle = document.getElementById('drag-handle')
  if (panel) { panel.style.display = ''; panel.style.height = `${outputHeight}px` }
  if (handle) handle.style.display = ''
  updateBottomBar()
}

function hideBottomPanel() {
  bottomPanelOpen = false
  const panel = document.getElementById('bottom-panel')
  const handle = document.getElementById('drag-handle')
  if (panel) panel.style.display = 'none'
  if (handle) handle.style.display = 'none'
  updateBottomBar()
}

function updateBottomBar() {
  const varsBtn = document.getElementById('btn-vars')
  const snippetsBtn = document.getElementById('btn-snippets')
  const historyBtn = document.getElementById('btn-history')
  if (varsBtn) varsBtn.className = `btn-bottom${bottomPanelOpen && bottomMode === 'vars' ? ' active' : ''}`
  if (snippetsBtn) snippetsBtn.className = `btn-bottom${bottomPanelOpen && bottomMode === 'snippets' ? ' active' : ''}`
  if (historyBtn) historyBtn.className = `btn-bottom${bottomPanelOpen && bottomMode === 'history' ? ' active' : ''}`
}

function renderBottomContent() {
  const container = document.getElementById('bottom-panel-content')
  if (!container) return

  if (bottomMode === 'output') {
    const modeLabel = lastMode === 'save' ? 'Saved' : lastMode === 'execute' ? 'Executed' : 'Preview'
    const cls = lastOutputOk ? 'ok' : 'error'
    const durationText = lastDuration != null ? `\u00b7 ${lastDuration}ms` : ''
    const outputContent = lastOutputOk
      ? renderEcOutput(lastOutputText)
      : h('div', { class: 'editor-output-content error' }, lastOutputText)
    renderDom(container,
      h('div', { class: 'editor-output-header' },
        h('span', { class: `editor-output-mode ${cls}` }, modeLabel),
        h('span', { class: 'editor-output-duration' }, durationText),
        h('span', { class: 'editor-output-close', onClick: hideBottomPanel }, '\u2715'),
      ),
      outputContent,
    )
    return
  }

  if (bottomMode === 'snippets') {
    const ridStr = ctx ? (ctx.extended ? ctx.executionContextRid ?? 'RID' : ctx.instance.rid) : 'RID'
    const snippets = [
      { id: 'genedit', desc: 'GenEdit (full object)', code: `lookup(${ridStr}).genEdit(*)` },
      { id: 'children', desc: 'Walk children', code: `lookup(${ridStr}).children().forEach(_c: ...)` },
      { id: 'change', desc: 'Change property', code: `lookup(${ridStr}).change("property", "value")` },
      { id: 'search', desc: 'Search descendants', code: `SELECT * FROM lookup(${ridStr}) WHERE ...` },
    ]
    renderDom(container,
      h('div', { class: 'editor-snippet-list' },
        ...snippets.map(s =>
          h('div', { class: 'editor-snippet-item', onClick: () => insertSnippet(s.id, ridStr) },
            h('div', { class: 'editor-snippet-desc' }, s.desc),
            h('code', null, s.code),
          ),
        ),
      ),
    )
    return
  }

  if (bottomMode === 'history') {
    if (historyEntries.length === 0) {
      renderDom(container, h('div', { class: 'editor-history-empty' }, 'No history yet'))
      return
    }

    // Sparkline: last 10 runs
    const spark = historyEntries.slice(-10)
    const maxDur = Math.max(...spark.map(e => e.durationMs ?? 0), 1)
    const sparkline = h('div', { class: 'ec-sparkline' },
      ...spark.map(e => {
        const pct = Math.max(2, Math.round(((e.durationMs ?? 0) / maxDur) * 14))
        return h('div', {
          class: `ec-sparkline-bar ${e.ok ? 'ok' : 'fail'}`,
          style: `height:${pct}px`,
          title: `${e.durationMs ?? '?'}ms · ${e.ok ? 'ok' : 'error'} · ${e.mode}`,
        })
      }),
      h('span', { class: 'ec-sparkline-label' }, `last ${spark.length}`),
    )

    renderDom(container,
      sparkline,
      h('div', { class: 'editor-history-list' },
        ...historyEntries.map(e =>
          h('div', {
            class: 'editor-history-item',
            onClick: () => {
              if (editorView) {
                editorView.dispatch({ changes: { from: 0, to: editorView.state.doc.length, insert: e.code } })
                editorView.focus()
              }
            },
          },
            h('span', { class: 'editor-history-icon' }, e.mode === 'execute' ? '\u26A1' : '\u25B6'),
            h('span', { class: `editor-history-status ${e.ok ? 'ok' : 'fail'}` }, e.ok ? '\u2713' : '\u2717'),
            h('span', { class: 'editor-history-dur' }, e.durationMs != null ? `${e.durationMs}ms` : ''),
            h('span', { class: 'editor-history-code' }, e.code.split('\n')[0].slice(0, 50)),
            h('span', { class: 'editor-history-time' }, relativeTime(e.timestamp)),
          ),
        ),
      ),
    )
  }

  if (bottomMode === 'vars') {
    const vars = getTrackedVariables()
    if (vars.length === 0) {
      renderDom(container, h('div', { class: 'editor-history-empty' }, 'No variables \u2014 use _name := expression'))
      return
    }
    renderDom(container,
      h('div', { class: 'editor-vars-list' },
        ...vars.map(v =>
          h('div', {
            class: 'editor-vars-item',
            onClick: () => {
              if (editorView) {
                const line = editorView.state.doc.line(Math.min(v.line, editorView.state.doc.lines))
                editorView.dispatch({ selection: { anchor: line.from }, scrollIntoView: true })
                editorView.focus()
              }
            },
          },
            h('span', { class: 'editor-vars-name' }, v.name),
            h('span', { class: 'editor-vars-assign' }, ':='),
            h('span', { class: 'editor-vars-rhs' }, v.rhs || '\u2026'),
          ),
        ),
      ),
    )
  }
}

function insertSnippet(id: string, rid: string) {
  if (!editorView) return
  let code = ''
  switch (id) {
    case 'genedit': code = `lookup(${rid}).genEdit(*)`; break
    case 'children': code = `_o := lookup(${rid})\n_o.children().forEach(_c:\n  _c.businessIdentifier + " | " + _c.name\n)`; break
    case 'change': code = `_o := lookup(${rid})\n_o.change("description", "new value")`; break
    case 'search': code = `SELECT * FROM lookup(${rid}) WHERE name CONTAINS "..."`; break
  }
  if (code) {
    editorView.dispatch({ changes: { from: 0, to: editorView.state.doc.length, insert: code } })
    editorView.focus()
  }
}

function doClear() {
  lastOutputText = ''
  lastOutputOk = true
  lastMode = null
  lastDuration = null
  previewDone = false
  updateRunButton()
  if (editorView) {
    editorView.dispatch({ changes: { from: 0, to: editorView.state.doc.length, insert: '' } })
    editorView.focus()
  }
  hideBottomPanel()
  dirty = false
}

function toggleVars() {
  if (bottomPanelOpen && bottomMode === 'vars') {
    hideBottomPanel()
  } else {
    bottomMode = 'vars'
    bottomPanelOpen = true
    openBottomPanel()
    renderBottomContent()
  }
}

function toggleSnippets() {
  if (bottomPanelOpen && bottomMode === 'snippets') {
    hideBottomPanel()
  } else {
    bottomMode = 'snippets'
    bottomPanelOpen = true
    openBottomPanel()
    renderBottomContent()
  }
}

function toggleHistory() {
  if (bottomPanelOpen && bottomMode === 'history') {
    hideBottomPanel()
  } else {
    bottomMode = 'history'
    bottomPanelOpen = true
    openBottomPanel()
    loadHistory()
  }
}

function toggleWrap() {
  wrapLines = !wrapLines
  if (editorView) {
    editorView.dispatch({ effects: wrapCompartment.reconfigure(wrapLines ? EditorView.lineWrapping : []) })
  }
  const btn = document.getElementById('btn-wrap')
  if (btn) btn.className = `btn-bottom${wrapLines ? ' active' : ''}`
}

function loadHistory() {
  chrome.runtime.sendMessage({ type: 'GET_SCRIPT_HISTORY' }).then((response: any) => {
    if (response?.entries) historyEntries = response.entries
    renderBottomContent()
  }).catch(() => {
    renderBottomContent()
  })
}

function relativeTime(ts: number): string {
  const seconds = Math.floor((Date.now() - ts) / 1000)
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

// ── Drag handle for resizable output ──────────────────────────────

function wireDragHandle() {
  const handle = document.getElementById('drag-handle')
  if (!handle) return

  let startY = 0
  let startHeight = 0

  function onMouseMove(e: MouseEvent) {
    const delta = startY - e.clientY
    const newHeight = Math.max(60, Math.min(window.innerHeight * 0.8, startHeight + delta))
    outputHeight = newHeight
    const panel = document.getElementById('bottom-panel')
    if (panel) panel.style.height = `${newHeight}px`
  }

  function onMouseUp() {
    handle!.classList.remove('dragging')
    document.removeEventListener('mousemove', onMouseMove)
    document.removeEventListener('mouseup', onMouseUp)
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    chrome.storage.local.set({ crev_editor_output_height: outputHeight }).catch(() => {})
  }

  handle.addEventListener('mousedown', (e) => {
    e.preventDefault()
    startY = e.clientY
    const panel = document.getElementById('bottom-panel')
    startHeight = panel ? panel.offsetHeight : outputHeight
    handle.classList.add('dragging')
    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  })
}

// ── Launch ───────────────────────────────────────────────────────

init()
