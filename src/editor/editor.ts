/**
 * CREV Inspector — EC Editor Window.
 * CodeMirror 6 editor for Extended Code, HTML, and JavaScript properties.
 * Communicates with service worker for preview/save operations.
 */
import { EditorState, type Extension } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { autocompletion, startCompletion } from '@codemirror/autocomplete'
import { openSearchPanel } from '@codemirror/search'
import { lintGutter } from '@codemirror/lint'
import { baseEditingExtensions, baseKeymapBindings, languageExtension, catppuccinMocha, type CodeLang } from '../editor-core/cm-scaffold'
import { CodeSurface, isProgrammaticSwap, type CodeSlot } from '../editor-core/code-surface'
import { reconcileLostSave } from '../editor-core/save-reconcile'
import { KBD_MOD } from '../editor-core/platform'
import { closeOverlayKeyBinding, installDirtyGuards, OVERLAY_CLOSE_MESSAGE } from '../editor-core/overlay'

// Shared types + context helpers
import { type SaveTarget, type ScriptHistoryEntry, type InspectorMessage, getTypeColor } from '../lib/types'
import { typeBadge, wireBadgeCopy } from '../lib/type-badge'
import { objectChip } from '../lib/object-chip'
import { h, svg, render as renderDom } from '../lib/dom'
import { captureTypingFocus } from '../lib/focus-keep'
import { ICON_PLAY, ICON_X, ICON_WRAP, ICON_VARIABLE, ICON_CLOCK, ICON_CHECK, ICON_LIGHTNING, ICON_TABLE, ICON_COPY, ICON_REFRESH, ICON_BOOK, ICON_ARROWS_OUT_SIMPLE, ICON_ARROWS_IN_SIMPLE, ICON_CODE, ICON_CHEVRON, ICON_WARNING, ICON_SPARKLE } from '../lib/icons'
import { fetchAiConfig } from '../editor-core/ai-config'
import type { AiAssist } from '../editor-core/ai-assist'
import type { AiLang, AiObjectContext, AiContextSource } from '../lib/ai/types'
import { renderEcOutput, ecOutputToText, parseBmpDurationMs, formatRunTiming } from './ec-output'
import { showBookPopover } from './book'
import { anchorPopover } from '../lib/popover-anchor'
import { sendFireForget, sendRequest, sendRequestBounded } from '../lib/messaging'
import { confirmModal } from '../lib/modal'
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
import { extendedCompletions, variableTracker, getTrackedVariables, scanVariables, clearTrackedVariables } from './ec/completions'
import { extendedHoverDocs } from './ec/hoverDocs'
import { bmpObjectHover, bmpBidDecorator } from './ec/bmpObjectHover'
import { varHighlight, setHighlightedVar } from './ec/varHighlight'
import {
  typeInferenceListener, scanDocForInferences, clearInferences,
  getAllInferences, getSchema, ensureSchema, refreshSchema,
  intersectionSchema, subscribe as subscribeInference, getSchemaError,
  canonicalType, getOption, ensureOptionsNow,
  type TypeInference,
} from './ec/typeInference'
import { starExpansionCompletions } from './ec/starExpansion'
import { propertyCompletions, valueCompletions } from './ec/propertyCompletions'
import { extendedLinter } from './ec/diagnostics'
import { runtimeErrorLinter, setRuntimeError, parseEcErrorLocation, clearRuntimeErrors } from './ec/runtimeErrors'
import { ecBlockMatching } from './ec/blockMatching'
import { ecFoldService } from './ec/foldRegions'
import { wrapInIf, wrapInForEach } from './ec/wrapCommands'

// ── State ────────────────────────────────────────────────────────

let ctx: EditorContext | null = null
/** The shared multi-slot editing engine. Owns the live CodeMirror view, the
 *  per-slot loaded baseline / working text / cursor / dirty, swap-vs-rebuild,
 *  and save/discard. Slots are keyed `${target}:${prop}` (or "extended" for the
 *  scratch window). Replaces the editor's former editorView + propStateCache +
 *  originalCode + dirty + programmaticDocSwap machinery. */
let surface: CodeSurface | null = null
/** Language family for a slot. EC covers the `expression` prop + the scratch
 *  window; html/javascript/css get grammar-only; else plain. */
type SlotLang = 'ec' | 'html' | 'javascript' | 'css' | 'plain'
let activeProperty = ''
/** AI assistant — created in init() only when a provider key is configured.
 *  When null, NOTHING of the AI feature renders (zero-footprint rule). */
let aiAssist: AiAssist | null = null
let aiConfigured = false
let bottomPanelOpen = false
let bottomMode: 'output' | 'history' | 'vars' = 'output'
let outputHeight = 160 // last manually-dragged px, persisted
/** How the output panel sizes itself. 'auto' fits the content (capped at a
 *  fraction of the window) so a one-line result is compact and a long log
 *  grows then scrolls; 'manual' means the user dragged the divider and we
 *  respect their height. Maximize is an independent overlay on top of both. */
let outputSizing: 'auto' | 'manual' = 'auto'
let outputMaximized = false
const MIN_OUTPUT_PX = 90
const OUTPUT_DEFAULT_FRAC = 0.33 // auto floor: a fresh preview opens to ~1/3 of the window
const OUTPUT_AUTO_FRAC = 0.45 // auto height ceiling, as a fraction of window
const OUTPUT_MAX_FRAC = 0.78 // maximized height, as a fraction of window
let previewDone = false // gating: Run unlocked only after successful preview
let lastMode: 'preview' | 'execute' | 'save' | null = null
let lastDuration: number | null = null
/** BMP's self-reported server-side compute time (the `Duration : Nms` line
 *  parsed out of the output), in ms. Shown next to the round-trip time in
 *  the output pill — e.g. `286ms · 59ms BMP` — so the user can tell network
 *  + SW overhead apart from BMP's own execution cost. */
let lastBmpMs: number | null = null
let lastOutputText = ''
let lastOutputOk = true
let historyEntries: ScriptHistoryEntry[] = []
let wrapLines = false
let tablePreview = true
let decodePreview = true
// Vars panel — phase 3. Tracks the currently selected variable in
// the left pane so the right pane (properties) knows what to render.
// Default selection is "last assigned" (resolved at render time).
let varsSelected: string | null = null
let varsShowSystem = false
let varsFilter = ''
// Accessors whose option dropdown (list/tag allowed values) is expanded in the
// Vars panel. Keyed by accessor — only one type's props show at a time.
const varsExpandedOptions = new Set<string>()
// Kind-family pills (Text, Num, Date, …). Multi-select — when empty,
// every kind passes. When non-empty, only props whose family is in
// this set survive. Maps to the family strings returned by
// `propFamily()` below (which collapses the BMP MethodConfig
// hierarchy into a small, user-recognisable taxonomy: Text and
// RichText both fall under "text"; Number and HistoricalNumber both
// under "num"; etc.).
const varsKindFilter = new Set<string>()
// The props filter is a PERSISTENT input node (built once, reused across the
// vars-panel rebuilds), with focus restored by the shared captureTypingFocus —
// same approach as the Browse + code-search inputs.
let varsFilterInputEl: HTMLInputElement | null = null
let varsFilterTypedAt = 0
// Scroll position of the props list, captured before a re-render so we
// can restore it after. Without this, clicking a property to insert
// at the cursor (which triggers docChanged → re-render) bounced the
// list back to the top mid-edit.
let varsPropsScrollTop = 0
/** True when the doc has been edited since the last successful preview.
 *  Drives the "code changed — preview again" cue in the output header. */
let staleAfterPreview = false
/** Timestamp of the last successful save. Drives the temporary
 *  "Saved" label on the Save button (fades back after a few seconds). */
let lastSavedAt: number | null = null
let contextRetryGeneration = 0
let saveLabelTimer: ReturnType<typeof setTimeout> | null = null
/** CodeSurface slot key for a (target, prop) pair. The scratch window is the
 *  single "extended" slot. (Per-slot cursor/scroll/dirty + the loaded baseline
 *  for Discard now live inside CodeSurface, keyed by these strings.) */
const slotKey = (target: SaveTarget | 'extended', prop: string): string =>
  target === 'extended' ? 'extended' : `${target}:${prop}`
/** Key of the currently-active slot. */
const activeKey = (): string => ctx?.extended ? 'extended' : slotKey(ctx?.saveTarget ?? 'instance', activeProperty)
/** Language family for a property (or the scratch window). */
function langFor(prop: string, extended: boolean): SlotLang {
  if (extended || prop === 'expression') return 'ec'
  if (prop === 'html' || prop === 'javascript' || prop === 'css') return prop
  // TextElement's html-bearing bodies (BMP sanitizes them server-side on save)
  if (prop === 'text' || prop === 'longText') return 'html'
  return 'plain'
}
/** Dirty state of the active slot (drives Save/Discard); anyDirty spans all
 *  slots (drives the close / unload guards so a dirty inactive prop isn't lost). */
const curDirty = (): boolean => surface?.isDirty(activeKey()) ?? false
const anyDirty = (): boolean => surface?.isDirty() ?? false

// ── Init ─────────────────────────────────────────────────────────

const root = document.getElementById('editor-root')!

async function init() {
  renderDom(root, h('div', { class: 'editor-loading' }, 'Loading\u2026'))

  // Load context from per-RID key (hash = RID)
  try {
    const rid = location.hash.slice(1)
    const perRidKey = rid ? `crev_editor_ctx_${rid}` : null
    const keys = ['crev_editor_output_height', 'crev_editor_decode', 'crev_editor_wrap', 'crev_editor_table']
    if (perRidKey) keys.push(perRidKey)
    const result = await chrome.storage.local.get(keys)
    ctx = perRidKey ? (result[perRidKey] as EditorContext | null) : null
    if (typeof result.crev_editor_output_height === 'number') {
      outputHeight = result.crev_editor_output_height
    }
    if (typeof result.crev_editor_decode === 'boolean') decodePreview = result.crev_editor_decode
    if (typeof result.crev_editor_wrap === 'boolean') wrapLines = result.crev_editor_wrap
    if (typeof result.crev_editor_table === 'boolean') tablePreview = result.crev_editor_table
  } catch {
    renderDom(root, h('div', { class: 'editor-loading' }, 'Failed to load context'))
    return
  }

  if (!ctx) {
    renderDom(root, h('div', { class: 'editor-loading' }, 'No editor context found'))
    return
  }
  if (ctx.loadError) {
    renderEditorLoadError(ctx.loadError)
    return
  }

  if (ctx.extended) {
    activeProperty = ''
  } else {
    const activeCode = getActiveCode(ctx)
    activeProperty = ctx.property ?? Object.keys(activeCode)[0] ?? 'expression'
    if (!activeCode[activeProperty]) {
      activeProperty = Object.keys(activeCode)[0] ?? 'expression'
    }
  }
  await setupAiAssist()
  updateWindowTitle()
  renderShell()
  ensureSurface()

  // Re-render the Vars panel whenever type inferences or schemas
  // change. The subscription is permanent — Vars is the only panel
  // that depends on async EC fetches, and a stray re-render on a
  // different tab is cheap (renderBottomContent early-exits if
  // bottomMode !== 'vars').
  subscribeInference(() => {
    if (bottomPanelOpen && bottomMode === 'vars') renderBottomContent()
  })

  // Keep the auto / maximized output height proportional as the window
  // resizes. No-op while the panel is closed or in manual mode.
  window.addEventListener('resize', () => {
    if (bottomPanelOpen) applyOutputHeight()
  })

  // Route Ctrl/Cmd+F to CodeMirror's search panel from ANYWHERE in the editor
  // window. searchKeymap already binds it when the code area is focused, but if
  // focus is on the output panel or a toolbar button the key falls through to
  // Chrome's native find — which can only see the lines CodeMirror has rendered
  // (it virtualizes the document), so it can't reach off-screen matches. Capture
  // the key first and open the (document-aware) CM panel instead.
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === 'f' || e.key === 'F')) {
      if (surface?.view) {
        // We are the single owner of Ctrl+F in this window: stop here so the
        // key neither reaches Chrome's native find nor double-fires via
        // searchKeymap's own Mod-f binding when the code area is focused.
        e.preventDefault()
        e.stopPropagation()
        openSearchPanel(surface.view)
      }
    }
  }, true)
}

function isConnectionLoadError(message: string): boolean {
  return /timed out|cannot reach|network|command|connection|service worker|did not respond/i.test(message)
}

function renderEditorLoadError(message: string, retrying = false): void {
  const identity = ctx?.instance
  const label = identity
    ? (identity.name || identity.businessId || identity.rid)
    : location.hash.slice(1)
  renderDom(root, h('div', { class: 'editor-load-error' },
    h('div', { class: 'editor-load-error-title' }, label || 'Editor context'),
    h('div', { class: 'editor-load-error-message' }, retrying ? 'Retrying…' : message),
    h('div', { class: 'editor-load-error-actions' },
      h('button', {
        class: 'btn btn-primary',
        disabled: retrying,
        onClick: () => { void retryEditorContext(false) },
      }, retrying ? 'Retrying…' : 'Retry'),
      isConnectionLoadError(message)
        ? h('button', {
          class: 'btn',
          disabled: retrying,
          onClick: () => { void retryEditorContext(true) },
        }, 'Reconnect')
        : null,
      h('button', {
        class: 'btn',
        onClick: () => window.parent.postMessage({ type: OVERLAY_CLOSE_MESSAGE }, '*'),
      }, 'Close'),
    ),
  ))
}

async function retryEditorContext(reconnect: boolean): Promise<void> {
  if (!ctx) return
  const attempt = ++contextRetryGeneration
  const originalError = ctx.loadError ?? 'Failed to load editor context'
  renderEditorLoadError(originalError, true)
  if (reconnect) sendFireForget({ type: 'CONNECTION_TEST' })
  try {
    const msg = await sendRequestBounded({
      type: 'FETCH_EDITOR_CONTEXT',
      rid: ctx.instance.rid,
      property: ctx.property ?? undefined,
    }, { timeoutMs: 15_000 })
    if (attempt !== contextRetryGeneration || msg.type !== 'EDITOR_CONTEXT_DATA') return
    ctx = msg.context
    if (ctx.loadError) {
      renderEditorLoadError(ctx.loadError)
      return
    }
    await chrome.storage.local.set({ [`crev_editor_ctx_${ctx.instance.rid}`]: ctx })
    location.reload()
  } catch (e) {
    if (attempt !== contextRetryGeneration) return
    renderEditorLoadError(e instanceof Error ? e.message : originalError)
  }
}

// ── Window title ────────────────────────────────────────────────

function updateWindowTitle() {
  if (!ctx) return
  if (ctx.extended) {
    const name = ctx.instance.name
    document.title = name ? `Extended Code - ${name}` : 'Extended Code'
    return
  }
  const identity = getActiveIdentity(ctx)
  document.title = `${identity.type || 'Object'} \u00b7 ${formatLabel(identity, 'full')}`
}

// ── Help reference ──────────────────────────────────────────────

/** Plain-text feature list shown as the help button's hover tooltip. Tight
 *  enough to read inside a native tooltip box without scrolling. The richer
 *  click-popover version lives in showEditorHelp() below. */
function editorHelpText(): string {
  return [
    `F5              Preview (dry-run)`,
    `${KBD_MOD}+S            Save (when editing a property)`,
    `${KBD_MOD}+D            Select next occurrence (then multi-cursor edit to rename)`,
    `${KBD_MOD}+/            Toggle comment`,
    'Tab / Shift+Tab Indent / outdent',
    '',
    'Click ?-button for full reference.',
  ].join('\n');
}

/** Open the rich help popover anchored under the ? button. Stays inside the
 *  editor window. Esc / outside-click dismisses. */
function showEditorHelp(anchor: HTMLElement): void {
  const existing = document.getElementById('editor-help-popover');
  if (existing) { existing.remove(); return; }
  const groups: Array<{ title: string; rows: Array<[string, string]> }> = [
    {
      title: 'Run',
      rows: [
        ['F5',                     'Preview (dry-run, safe)'],
        [`${KBD_MOD}+S`,            'Save current property'],
      ],
    },
    {
      title: 'Editing',
      rows: [
        [`${KBD_MOD}+D`,        'Select next occurrence (multi-cursor)'],
        [`${KBD_MOD}+/`,        'Toggle line comment'],
        [`${KBD_MOD}+F`,        'Find / replace (in-editor panel)'],
        ['Tab',        'Indent selection'],
        ['Shift+Tab',  'Outdent selection'],
        ['Esc',        'Close editor window'],
      ],
    },
    {
      title: 'Inline help',
      rows: [
        ['Hover identifier', 'EC method / keyword doc'],
        ['Hover RID / BID',  'Object preview'],
        ['Ctrl+click ref',   'Jump to definition'],
      ],
    },
    {
      title: 'Variables',
      rows: [
        ['name :=',          'Track any identifier (not just _underscore)'],
        ['Vars tab',         'List tracked vars with first-seen line'],
      ],
    },
    {
      title: 'Output',
      rows: [
        ['Output tab',       'EC log + Result'],
        ['Decode \\n',       'Render escape sequences'],
        ['Table view',       'Render | -separated table output'],
      ],
    },
  ];
  const popover = h('div', {
    id: 'editor-help-popover',
    class: 'editor-help-popover',
    role: 'dialog',
    'aria-label': 'Editor reference',
    // Position off-screen for the initial paint so width/height measure
    // correctly without flicker; clamped to viewport in the next tick.
    style: 'top:-9999px; left:-9999px;',
  },
    h('div', { class: 'editor-help-title' }, 'Extended Code editor: quick reference'),
    ...groups.map(g =>
      h('div', { class: 'editor-help-group' },
        h('div', { class: 'editor-help-group-title' }, g.title),
        h('table', { class: 'editor-help-table' },
          ...g.rows.map(([k, v]) =>
            h('tr', null,
              h('td', { class: 'editor-help-key' }, h('kbd', null, k)),
              h('td', { class: 'editor-help-val' }, v),
            ),
          ),
        ),
      ),
    ),
    h('div', { class: 'editor-help-footer' }, 'Press Esc to close · MCP ec_help has the full language reference'),
  );
  document.body.appendChild(popover);
  anchorPopover(popover, anchor);

  const close = (e?: Event) => {
    if (e && popover.contains(e.target as Node)) return;
    popover.remove();
    document.removeEventListener('mousedown', close);
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
  setTimeout(() => {
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey);
  }, 0);
}

// ── Shell layout ─────────────────────────────────────────────────

function renderShell() {
  if (!ctx) return

  const isExtended = !!ctx.extended
  const activeCode = getActiveCode(ctx)
  const propKeys = Object.keys(activeCode)
  const identity = isExtended ? ctx.instance : getActiveIdentity(ctx)
  const typeColor = getTypeColor(identity.type)
  const bid = identity.businessId || identity.rid

  // Identity strip at top of window \u2014 replaces redundant info from old toolbar
  const headerChildren: (HTMLElement | string | false)[] = []
  if (isExtended) {
    headerChildren.push(
      identity.type
        ? wireBadgeCopy(typeBadge(identity.type, { size: 'xs' }), () => bid)
        : h('span', { class: 'editor-id-chip', style: `--type-color:${typeColor}` }, 'EC'),
      h('span', { class: 'editor-id-name' }, identity.name || 'Extended Code'),
      identity.businessId && h('span', { class: 'editor-id-bid' }, identity.businessId),
    )
  } else {
    // EC execution context (`this`) — the object the BMP page renders for,
    // NOT the widget being edited. It uses the shared object contract so the
    // context can be inspected instead of being a bespoke text-only marker.
    const exec = ctx.executionContext
    headerChildren.push(
      wireBadgeCopy(typeBadge(identity.type, { size: 'xs' }), () => bid),
      // Identity name doubles as a "show me in BMP" link: clicking
      // posts BMP_GOTO via the SW so the user's BMP tab navigates to
      // this object without an alt-tab + click chase.
      h('button', {
        class: 'editor-id-name editor-id-name--link',
        title: `${identity.name ?? '(unnamed)'}. Click to navigate the BMP tab to this object`,
        'data-action': 'goto-bmp',
      }, identity.name || '(unnamed)'),
      h('span', { class: 'editor-id-bid' }, bid),
      exec
        ? objectChip(exec, {
            size: 'xs',
            className: 'editor-id-context',
            annotation: 'context',
            onActivate: () => sendFireForget({ type: 'SELECT_OBJECT', rid: exec.rid, openPanel: true }),
          })
        : false,
    )
  }

  // Segmented target toggle (template \u27f7 instance)
  const segToggle = (!isExtended && ctx.template)
    ? h('div', { class: 'seg', role: 'tablist', 'aria-label': 'Save target' },
        h('button', {
          class: `seg-btn${ctx.saveTarget === 'template' ? ' active' : ''}`,
          'data-target': 'template',
          role: 'tab',
          'aria-selected': ctx.saveTarget === 'template' ? 'true' : 'false',
          title: `${formatLabel(ctx.template!, 'full')}: changes propagate to every instance`,
        }, 'Template'),
        h('button', {
          class: `seg-btn${ctx.saveTarget === 'instance' ? ' active' : ''}`,
          'data-target': 'instance',
          role: 'tab',
          'aria-selected': ctx.saveTarget === 'instance' ? 'true' : 'false',
          title: `${formatLabel(ctx.instance, 'full')}: this object only`,
        }, 'Instance'),
      )
    : false

  const header = h('div', { class: 'editor-header' },
    h('div', { class: 'editor-header-id' },
      h('span', { class: 'editor-id-icon', title: 'Extended Code editor' }, svg(ICON_CODE)),
      ...headerChildren.filter(Boolean) as (HTMLElement | string)[]),
    segToggle
      ? h('div', { class: 'editor-header-target' },
          h('span', { class: 'editor-target-label' }, 'Editing'),
          segToggle,
        )
      : h('span'),
  )

  // Property tabs (tablist with underline indicator)
  const propTabs = (!isExtended && propKeys.length > 1)
    ? h('div', { class: 'editor-prop-tabs', role: 'tablist', 'aria-label': 'Property' },
        ...propKeys.map(key =>
          h('button', {
            class: `editor-prop-tab${key === activeProperty ? ' active' : ''}`,
            'data-prop': key,
            role: 'tab',
            'aria-selected': key === activeProperty ? 'true' : 'false',
            title: ctx!.overrides[key] ? 'Instance differs from template' : '',
          },
            h('span', null, key),
            ctx!.overrides[key] ? h('span', { class: 'editor-prop-tab-dot', 'aria-label': 'overridden' }) : null,
          ),
        ),
      )
    : false

  const actionRow = buildActionRow()

  // Capture focus BEFORE renderDom detaches the editor's DOM — reading it
  // afterwards always yields false (the node is no longer in the document).
  // Restored after the view is re-attached below.
  const hadFocus = surface?.view?.hasFocus ?? false

  renderDom(root,
    header,
    propTabs || h('div', { class: 'editor-prop-tabs editor-prop-tabs--empty' }),
    h('div', { class: 'editor-cm-wrap', id: 'cm-container' }),
    actionRow,
    // Resize divider. (The panel size toggle lives in the output panel
    // header — see renderBottomContentInner.)
    h('div', { class: 'editor-drag-handle', id: 'drag-handle', style: 'display:none' }),
    h('div', { class: 'editor-output', id: 'bottom-panel', style: `display:none;height:${outputHeight}px` },
      h('div', { id: 'bottom-panel-content' }),
    ),
    h('div', { class: 'editor-bottom-bar', id: 'bottom-bar' },
      // Bottom bar carries ONLY the panel tabs. Output-specific controls
      // (decode / table / copy) live in the Output content header where
      // they actually apply; the panel size toggle sits beside them.
      // Clicking the active tab collapses the panel (togglePanel).
      h('div', { class: 'editor-panel-tabs', role: 'tablist', 'aria-label': 'Bottom panel' },
        h('button', { class: `editor-panel-tab${bottomPanelOpen && bottomMode === 'output' ? ' active' : ''}`, id: 'btn-output-tab', role: 'tab' }, 'Output'),
        h('button', { class: `editor-panel-tab${bottomPanelOpen && bottomMode === 'vars' ? ' active' : ''}`, id: 'btn-vars', role: 'tab' }, svg(ICON_VARIABLE), ' Vars'),
        h('button', { class: `editor-panel-tab${bottomPanelOpen && bottomMode === 'history' ? ' active' : ''}`, id: 'btn-history', role: 'tab' }, svg(ICON_CLOCK), ' History'),
      ),
    ),
  )

  // Re-attach the live CodeMirror view into the freshly-rendered shell.
  // renderDom() replaced the whole shell DOM, detaching the view; moving it
  // back in keeps the view (doc, history, selection, scroll) alive so a
  // target/property switch can swap the doc in place rather than rebuilding.
  // On first paint surface is null (ensureSurface mounts fresh afterwards).
  if (surface) {
    surface.reattach()
    // renderDom() dropped keyboard focus; re-grab it only if the view was
    // focused before the re-render — otherwise a renderShell() that fires
    // mid-edit (e.g. the save-label fade timer) would steal the cursor.
    if (hadFocus) surface.focus()
  }

  // Wire toolbar
  for (const el of document.querySelectorAll<HTMLElement>('[data-action="goto-bmp"]')) {
    el.addEventListener('click', () => {
      if (!ctx) return
      const target = getSaveTarget(ctx)
      // Fire-and-forget — SW resolves the BMP tab and clicks the tab
      // button + scrolls to the widget. Same primitive the graph view
      // popout uses.
      sendFireForget({ type: 'BMP_GOTO', rid: target.rid })
    })
  }
  document.getElementById('btn-output-tab')?.addEventListener('click', () => togglePanel('output'))
  document.getElementById('btn-vars')?.addEventListener('click', () => togglePanel('vars'))
  document.getElementById('btn-history')?.addEventListener('click', () => togglePanel('history'))
  wireDragHandle()
  const maxBtn = document.getElementById('btn-output-max')
  if (maxBtn) {
    // Don't let a press on the button start a divider drag.
    maxBtn.addEventListener('pointerdown', (e) => e.stopPropagation())
    maxBtn.addEventListener('click', toggleMaximizeOutput)
  }

  // Wire template/instance toggle. CodeSurface stashes the outgoing slot and
  // swaps/rebuilds the incoming one; we just point it at the new slot key.
  for (const btn of document.querySelectorAll<HTMLElement>('.seg-btn')) {
    btn.addEventListener('click', () => {
      const target = btn.dataset.target as SaveTarget
      if (!target || !ctx || target === ctx.saveTarget) return
      ctx.saveTarget = target
      previewDone = false
      // Re-determine active property from new target's code
      const newCode = getActiveCode(ctx)
      if (!newCode[activeProperty]) {
        activeProperty = Object.keys(newCode)[0] ?? activeProperty
      }
      updateWindowTitle()
      renderShell()
      surface?.activate(activeKey())
      broadcastEditorContext()
    })
  }

  // Wire property tabs
  for (const tab of document.querySelectorAll<HTMLElement>('.editor-prop-tab')) {
    tab.addEventListener('click', () => {
      const prop = tab.dataset.prop
      if (!prop || prop === activeProperty || !ctx) return
      activeProperty = prop
      previewDone = false
      renderShell()
      surface?.activate(activeKey())
      broadcastEditorContext()
    })
  }
}

// ── Editing surface (CodeSurface) ────────────────────────────────

/** Prime (or wipe) the Vars + type-inference trackers for a freshly-loaded
 *  doc. The trackers' own updateListeners only fire on user edits, so both
 *  the initial construction and an in-place doc swap have to seed them by
 *  hand; for non-EC slots we clear instead, so the Vars panel doesn't show
 *  a previous EC property's variables. */
function primeTrackers(doc: EditorState['doc'], isEc: boolean): void {
  if (isEc) {
    scanVariables(doc)
    scanDocForInferences(doc)
  } else {
    clearTrackedVariables()
    clearInferences()
  }
}

/** Build the per-slot extension set: base scaffold + language layer + EC keymap
 *  + an app-reactions listener. CodeSurface appends line wrapping and its own
 *  dirty/cursor listener on top, so they're deliberately absent here. The full
 *  keymap (Preview/Run/Save/Esc) is attached to every slot, matching the old
 *  single-view editor. */
function buildExtensions(slot: CodeSlot): Extension[] {
  const isEc = slot.lang === 'ec'
  const exts: Extension[] = [
    ...baseEditingExtensions(),
    // EC gets the `*`-expansion + identifier/method/property/value completions;
    // other slots get CM's default completion only.
    //
    // Auto-show relies on CM's default activateOnTyping (NOT overridden here):
    // any input.type keystroke activates the sources (verified in CM source —
    // getUpdateType treats every input.type as Activate, no word-char gate; even
    // `(` via closeBrackets carries userEvent input.type). So completions pop
    // ~100ms after WHERE␣ / `(` / `=` / `CONTAINS` / a typed name, and each
    // source's validFor keeps the popup open as the user types. Do NOT set
    // activateOnTyping:false or the property/value popups stop auto-appearing.
    autocompletion({ override: isEc ? [starExpansionCompletions, propertyCompletions, valueCompletions, extendedCompletions] : undefined }),
    // `*` isn't an identifier char, so kick autocomplete explicitly so the
    // `*`-expansion snippet surfaces immediately on type.
    isEc ? EditorView.updateListener.of((update) => {
      if (!update.docChanged) return
      let typedStar = false
      update.changes.iterChanges((_a, _b, _c, _d, inserted) => {
        if (inserted.toString().endsWith('*')) typedStar = true
      })
      if (typedStar) startCompletion(update.view)
    }) : [],
    catppuccinMocha,
    keymap.of([
      ...baseKeymapBindings,
      { key: 'Ctrl-Shift-x', run: wrapInIf },
      { key: 'Ctrl-Shift-e', run: wrapInForEach },
      // Preview on F5 only. Ctrl+Enter was advertised on the button but never fired
      // reliably inside the BMP page context, so it's removed. Execute is
      // button-only by design (no keyboard shortcut).
      { key: 'F5', run: () => { void doPreview(); return true }, preventDefault: true },
      { key: 'Ctrl-s', run: () => { void doSave(); return true } },
      // AI assistant — Mod-k. No-op when no provider key is configured.
      { key: 'Mod-k', run: () => { openAiAssist(); return true }, preventDefault: true },
      closeOverlayKeyBinding,
    ]),

    // App-specific reactions only. Cursor + dirty are handled by CodeSurface's
    // onCursor / onDirtyChange callbacks; here we do the preview-gate / stale /
    // runtime-error bookkeeping — and only for REAL user edits (a programmatic
    // slot-swap carries CodeSurface's annotation, which we skip).
    EditorView.updateListener.of(update => {
      if (update.selectionSet || update.docChanged) updatePreviewSelDot()
      if (!update.docChanged || isProgrammaticSwap(update)) return
      if (previewDone) { previewDone = false; refreshActions() }
      if (!staleAfterPreview && lastMode === 'preview' && lastOutputOk) {
        staleAfterPreview = true
        if (bottomPanelOpen && bottomMode === 'output') renderBottomContent()
      }
      // A pending runtime-error marker now points at stale line numbers.
      clearRuntimeErrors(update.view)
    }),
  ]

  if (isEc) {
    exts.push(
      extendedLanguage,
      extendedHighlighting,
      variableTracker,
      extendedHoverDocs,
      bmpObjectHover,
      bmpBidDecorator,
      ...varHighlight,
      typeInferenceListener,
      extendedLinter,
      runtimeErrorLinter,
      ecBlockMatching,
      ecFoldService,
      lintGutter(),
    )
  } else if (slot.lang === 'html' || slot.lang === 'javascript' || slot.lang === 'css') {
    // Grammar-only slots. lang-html bundles the embedded CSS + JS grammars.
    exts.push(languageExtension(slot.lang as CodeLang))
  }
  return exts
}

/** Create the editing surface once (registering every property as a slot, keyed
 *  `${target}:${prop}`) and activate the initial slot, or — when it already
 *  exists — re-attach its view after a shell re-render. */
function ensureSurface(): void {
  if (surface) { surface.reattach(); return }
  if (!ctx) return
  surface = new CodeSurface(() => document.getElementById('cm-container'), {
    buildExtensions,
    onDirtyChange: () => refreshActions(),
    onCursor: () => updateStatusBar(),
    onAfterLoad: (view, slot) => primeTrackers(view.state.doc, slot.lang === 'ec'),
  })
  surface.setWrap(wrapLines)

  const slots: CodeSlot[] = []
  if (ctx.extended) {
    // Preload a chat "Open in editor" handoff's code (one-shot), else blank.
    const seed = ctx.initialCode ?? ''
    ctx.initialCode = undefined
    slots.push({ key: 'extended', lang: 'ec', code: seed })
  } else {
    for (const [prop, val] of Object.entries(ctx.instanceCode ?? {})) {
      slots.push({ key: slotKey('instance', prop), lang: langFor(prop, false), code: val })
    }
    for (const [prop, val] of Object.entries(ctx.templateCode ?? {})) {
      slots.push({ key: slotKey('template', prop), lang: langFor(prop, false), code: val })
    }
    // Guarantee the initial active slot exists even if its code map is empty
    // (matches the old createEditor, which always mounted a view).
    if (!slots.some(s => s.key === activeKey())) {
      slots.push({ key: activeKey(), lang: langFor(activeProperty, false), code: getActiveCode(ctx)[activeProperty] ?? '' })
    }
  }
  surface.setSlots(slots)

  // Consume the one-shot Code-Search jump on the INITIAL load only; subsequent
  // tab/target switches must not re-jump. CodeSurface.jumpTo lands on the
  // occurrence nearest the hinted line.
  surface.activate(activeKey(), { scrollToLine: ctx.scrollToLine, scrollToText: ctx.scrollToText })
  ctx.scrollToLine = undefined
  ctx.scrollToText = undefined
  refreshActions()
}

// ── Status bar ───────────────────────────────────────────────────

/** Update the Ln/Col readout from the live view's cursor. Driven by
 *  CodeSurface's onCursor and a refreshActions rebuild. */
function updateStatusBar(): void {
  const view = surface?.view
  if (!view) return
  const pos = view.state.selection.main.head
  const line = view.state.doc.lineAt(pos)
  const col = pos - line.from + 1
  const bar = document.getElementById('status-bar')
  if (bar) bar.textContent = `Ln ${line.number}, Col ${col}`
}

// ── AI assistant ─────────────────────────────────────────────────

/** Probe for a configured AI provider and subscribe to config changes so the
 *  assistant appears / disappears live (zero-footprint). When it isn't
 *  configured, nothing AI renders (buildActionRow gates the sparkle button on
 *  `aiConfigured`, Mod-k is a no-op) and the merge-heavy ai-assist module is
 *  never loaded. */
async function setupAiAssist(): Promise<void> {
  chrome.runtime.onMessage.addListener((msg: InspectorMessage) => {
    if (msg.type === 'AI_CONFIG_CHANGED') void applyAiConfig(msg.configured)
    // Chat-tab Apply: when the proposal targets the object + slot this editor
    // has open, raise the standard merge-diff Accept/Reject on the live doc.
    if ((msg.type === 'AI_APPLY_PROPOSAL' || msg.type === 'AI_INSERT_AT_CURSOR') && aiAssist && ctx) {
      const target = getSaveTarget(ctx)
      const slot = ctx.extended ? 'expression' : activeProperty
      if (msg.target.rid === target.rid && msg.target.slot === slot) {
        if (msg.type === 'AI_APPLY_PROPOSAL') aiAssist.propose(msg.code)
        else aiAssist.insertAtCursor(msg.code)
      }
    }
  })
  // Tell the sidepanel this editor is gone so its 'editor' context chip drops.
  window.addEventListener('pagehide', () => {
    if (aiConfigured) sendFireForget({ type: 'AI_EDITOR_CONTEXT', source: null })
  })
  try {
    const cfg = await fetchAiConfig()
    await applyAiConfig(cfg.configured)
  } catch {
    aiConfigured = false
  }
}

/** React to the current AI-configured state: lazily build the assistant (which
 *  pulls in @codemirror/merge) on first need, or tear it down + close anything
 *  open when the key is removed. Repaints the toolbar so the sparkle follows. */
async function applyAiConfig(configured: boolean): Promise<void> {
  if (configured) {
    if (!aiAssist) {
      const { createAiAssist } = await import('../editor-core/ai-assist')
      aiAssist = createAiAssist({
        surface: () => surface,
        lang: () => aiLangForActiveSlot(),
        context: () => aiContext(),
        anchorEl: () => document.getElementById('btn-ai'),
        contextSource: () => aiContextSource(),
      })
    }
    aiConfigured = true
  } else {
    aiConfigured = false
    aiAssist?.close()
    aiAssist = null
  }
  broadcastEditorContext()
  refreshActions()
}

/** Open the AI popover (no-op when the feature isn't configured). */
function openAiAssist(): void {
  if (aiConfigured) aiAssist?.open()
}

/** Map the active slot's language family to the AI request lang. */
function aiLangForActiveSlot(): AiLang {
  const lang = langFor(activeProperty, !!ctx?.extended)
  if (lang === 'ec') return 'extended'
  if (lang === 'javascript') return 'javascript'
  return 'html'
}

/** The 'editor' context source for the chat envelope: the open object's
 *  identity + the active slot's full code (+ selection). Null for the scratch
 *  Extended window with no object, or before a context loads. */
function aiContextSource(): AiContextSource | null {
  if (!ctx) return null
  const identity = ctx.extended ? ctx.instance : getActiveIdentity(ctx)
  if (!identity?.rid) return null
  const slotName = ctx.extended ? 'expression' : activeProperty
  const view = surface?.view
  const code = view ? view.state.doc.toString() : (getActiveCode(ctx)[slotName] ?? '')
  const lang = aiLangForActiveSlot()
  const source: AiContextSource = {
    kind: 'editor',
    object: {
      rid: identity.rid,
      businessId: identity.businessId ?? '',
      name: identity.name ?? '',
      type: identity.type ?? '',
      ...(ctx.template?.businessId ? { templateBusinessId: ctx.template.businessId } : {}),
    },
    slot: { name: slotName, lang, code },
  }
  const sel = view?.state.selection.main
  if (sel && sel.from !== sel.to && source.slot) {
    source.slot.selection = { from: sel.from, to: sel.to }
  }
  return source
}

/** Broadcast which object+slot this editor has open, so the sidepanel AI chat
 *  tab can render its 'editor' context chip. Zero-footprint: only sent while a
 *  provider key is configured. Last-writer-wins when several editors are open
 *  (the most recently opened / switched surface owns the chip). */
function broadcastEditorContext(): void {
  if (!aiConfigured) return
  sendFireForget({ type: 'AI_EDITOR_CONTEXT', source: aiContextSource() })
}

/** Object grounding for the prompt: identity + the other code props, truncated. */
function aiContext(): AiObjectContext {
  if (!ctx) return {}
  const identity = ctx.extended ? ctx.instance : getActiveIdentity(ctx)
  const codeMap = getActiveCode(ctx)
  const otherSlots = Object.entries(codeMap)
    .filter(([prop]) => prop !== activeProperty && !ctx!.extended)
    .map(([name, code]) => ({ name, code: (code ?? '').slice(0, 1500) }))
    .filter(s => s.code.trim() !== '')
  return {
    objectType: identity.type,
    businessId: identity.businessId,
    name: identity.name,
    templateBusinessId: ctx.template?.businessId,
    slotName: ctx.extended ? undefined : activeProperty,
    otherSlots: otherSlots.length ? otherSlots : undefined,
  }
}

// ── Actions ──────────────────────────────────────────────────────

/** Return selected text if any, otherwise full document. */
function getRunCode(): string {
  return surface?.getRunCode() ?? ''
}

async function doPreview() { await executeEc(false) }
async function doRun() { if (previewDone) await executeEc(true) }

async function executeEc(transactional: boolean) {
  if (!surface || !ctx) return
  const code = getRunCode()
  const startTime = Date.now()

  lastMode = transactional ? 'execute' : 'preview'
  lastDuration = null
  lastBmpMs = null
  staleAfterPreview = false
  showOutput(transactional ? 'Executing\u2026' : 'Previewing\u2026', true)

  let ok = false
  const response = await sendRequest({
    type: 'EC_EXECUTE',
    code,
    objectRid: getExecutionRid(ctx),
    ...(transactional ? { transactional: true } : {}),
  })
  lastDuration = Date.now() - startTime
  if (response?.type === 'EC_RESULT') {
    ok = response.ok !== false
    if (ok) {
      showOutput(response.log ?? 'No output', true)
      // Successful run wipes any lingering error marker — the line
      // that previously failed now runs fine.
      if (surface.view) clearRuntimeErrors(surface.view)
    } else {
      const errText = response.error ?? response.log ?? 'Execution failed'
      showOutput(errText, false)
      // Paint an inline marker if BMP told us where to look.
      // Parser tries both `response.error` and `response.log` since
      // structural errors land in different fields.
      const loc = parseEcErrorLocation(errText) ?? parseEcErrorLocation(response.log ?? '')
      if (loc && surface.view) setRuntimeError(surface.view, loc.line, loc.column, errText.split('\n')[0])
    }
  } else {
    showOutput('No response from service worker', false)
  }

  // Preview gate: successful preview unlocks Run; Run always re-locks
  if (transactional) {
    previewDone = false
  } else {
    previewDone = ok
  }
  refreshActions()

  // Refresh history in background
  sendRequest({ type: 'GET_SCRIPT_HISTORY' }).then(r => {
    if (r?.type === 'SCRIPT_HISTORY_DATA') historyEntries = r.entries
  }).catch(() => {})
}

/** Re-render the action toolbar in place from current state — the single
 *  source of truth for Save / Discard / Execute / Preview enablement. Safe to
 *  call any time: it never touches #cm-container, so editor focus is untouched.
 *  Replaces the old updateSaveButton / updateRunButton imperative patchers. */
function refreshActions(): void {
  const existing = document.querySelector('.editor-actions')
  if (!existing) return
  existing.replaceWith(buildActionRow())
  updateStatusBar()
}

/** Toggle the "runs selection" dot on the Preview button. Cheap class flip —
 *  no rebuild — so it can run on every selection change without churn. */
function updatePreviewSelDot(): void {
  const btn = document.getElementById('btn-preview')
  if (btn && surface?.view) btn.classList.toggle('editor-run-preview--sel', !surface.view.state.selection.main.empty)
}

/** Build the action toolbar (.editor-actions) from current state. Re-rendered
 *  wholesale by refreshActions(); buttons carry inline handlers so a rebuild
 *  re-wires them automatically. */
function buildActionRow(): HTMLElement {
  const isExtended = !!ctx?.extended
  const hasSel = !!surface?.view && !surface.view.state.selection.main.empty
  const isDirty = curDirty()
  const saveLabel = !isDirty && lastSavedAt && Date.now() - lastSavedAt < 4000 ? 'Saved' : 'Save'
  const saveJustHappened = !isDirty && saveLabel === 'Saved'
  const saveClass = `btn ${isDirty ? 'btn-success' : saveJustHappened ? 'btn-success btn-saved' : 'btn-ghost'}`
  return h('div', { class: 'editor-actions' },
    // Preview | Execute — one segmented control. Execute stays disabled until a
    // successful, non-stale preview arms it (editing resets previewDone).
    h('div', { class: 'editor-run-group' },
      h('button', {
        class: `btn btn-accent editor-run-preview${hasSel ? ' editor-run-preview--sel' : ''}`,
        id: 'btn-preview',
        title: 'Preview (dry-run, safe) · F5',
        onClick: doPreview,
      },
        svg(ICON_PLAY), ' ', h('span', { class: 'editor-run-label' }, 'Preview'), ' ', h('kbd', null, 'F5'),
      ),
      h('button', {
        class: 'btn btn-accent editor-run-execute',
        id: 'btn-execute',
        disabled: !previewDone,
        title: previewDone ? 'Execute the previewed code' : 'Preview successfully first to unlock',
        onClick: () => { if (previewDone) void doRun() },
      },
        svg(ICON_LIGHTNING), ' Execute',
      ),
    ),
    !isExtended && h('button', {
      class: saveClass,
      id: 'btn-save',
      disabled: !isDirty,
      title: isDirty ? `Save (${KBD_MOD}+S)` : saveJustHappened ? 'Just saved' : 'No changes to save',
      onClick: doSave,
    },
      saveJustHappened ? svg(ICON_CHECK) : null,
      ` ${saveLabel} `,
      isDirty ? h('kbd', null, `${KBD_MOD}S`) : null,
    ),
    !isExtended && h('button', {
      class: 'btn btn-ghost',
      id: 'btn-discard',
      disabled: !isDirty,
      title: isDirty ? 'Revert to the saved BMP value (discards your edits)' : 'Nothing to discard',
      onClick: doDiscard,
    }, ' Discard'),
    h('div', { class: 'editor-actions-spacer' }),
    h('span', { class: 'editor-status', id: 'status-bar' }, 'Ln 1, Col 1'),
    // Editor-meta utilities — AI, wrap, EC reference, help — far right,
    // separated from the action verbs. The AI button only exists when a
    // provider key is configured (zero-footprint rule).
    aiConfigured && h('button', {
      class: 'btn-micro editor-ai-btn',
      id: 'btn-ai',
      title: `Ask or edit with AI (${KBD_MOD}+K)`,
      'aria-label': 'AI assistant',
      onClick: openAiAssist,
    }, svg(ICON_SPARKLE)),
    h('button', {
      class: `btn-micro${wrapLines ? ' active' : ''}`,
      id: 'btn-wrap',
      title: 'Toggle line wrapping (editor only)',
      onClick: toggleWrap,
    }, svg(ICON_WRAP)),
    h('button', {
      class: 'btn-micro editor-book-btn',
      id: 'btn-book',
      title: 'EC quick reference: namespaces, syntax cheat, snippets',
      'aria-label': 'Open EC quick reference',
      onClick: (e: Event) => openBook(e.currentTarget as HTMLElement),
    }, svg(ICON_BOOK)),
    h('button', {
      class: 'btn-micro help-btn',
      id: 'btn-help',
      title: editorHelpText(),
      'aria-label': 'Editor features and shortcuts',
      onClick: (e: Event) => showEditorHelp(e.currentTarget as HTMLElement),
    }, '?'),
  )
}

/** Open the EC quick-reference book popover anchored under its button. Inserts
 *  a chosen snippet at the editor cursor (reusing insertAtCursor). */
function openBook(anchor: HTMLElement): void {
  showBookPopover(anchor, {
    insertAtCursor: (text: string) => {
      if (!surface?.view) return false
      insertAtCursor(text)
      return true
    },
  })
}

/** Revert the editor to the BMP-loaded value for the active property.
 *  Confirms when dirty so an accidental click can't blow away work.
 *  The "saved" value comes from ctx — the snapshot we got at editor
 *  boot. After save, that snapshot was already updated to the new
 *  value, so Discard rolls back to the most recent SUCCESSFUL save. */

async function doDiscard(): Promise<void> {
  if (!ctx || !surface || !curDirty()) return
  const ok = await confirmModal({
    title: 'Discard changes?',
    body: `Revert "${activeProperty}" to the value BMP last reported. Your edits will be lost.`,
    confirmLabel: 'Discard',
    confirmVariant: 'danger',
  })
  if (!ok) return
  // CodeSurface reverts the active slot to its loaded (last-saved) baseline.
  surface.discard()
  // Keep ctx's buffer in sync so a later property switch doesn't re-stash the
  // now-discarded edits.
  getActiveCode(ctx)[activeProperty] = surface.textFor(activeKey())
  staleAfterPreview = false
  previewDone = false
  refreshActions()
  surface.focus()
}

async function doSave() {
  if (!surface || !ctx) return
  const saveSurface = surface
  const saveContext = ctx
  const property = activeProperty
  const slotKey = activeKey()
  const code = saveSurface.getDoc()
  const savedCodeMap = getActiveCode(saveContext)
  const storageRid = location.hash.slice(1)

  const target = getSaveTarget(saveContext)
  const targetLabel = saveContext.saveTarget === 'template' && saveContext.template
    ? `template "${formatLabel(target.identity, 'full')}"`
    : `instance "${formatLabel(target.identity, 'full')}"`

  const confirmed = await confirmModal({
    title: `Save ${property}`,
    body: `Write to ${targetLabel}?`,
    confirmLabel: 'Save',
    confirmVariant: 'success',
  })
  if (!confirmed) return

  lastMode = 'save'
  lastDuration = null
  lastBmpMs = null
  const btn = document.getElementById('btn-save') as HTMLButtonElement | null
  if (btn) { btn.disabled = true; btn.dataset.saving = '1' }

  try {
    const response = await sendRequest({
      type: 'SAVE_PROPERTY',
      rid: target.rid,
      objectType: target.type,
      property,
      value: code,
    })
    if (response?.type === 'SAVE_RESULT' && response.ok) {
      const newerEdits = saveSurface.textFor(slotKey) !== code
      await acceptSavedValue(saveSurface, slotKey, savedCodeMap, saveContext, property, code, storageRid)
      showOutput(newerEdits
        ? `Saved ${property} to ${targetLabel}. Newer edits remain unsaved.`
        : `Saved to ${targetLabel}`, true)
    } else if (response?.type === 'SAVE_RESULT') {
      // Explicit failure — the SW returned a SAVE_RESULT with ok=false. The
      // error string is what BMP / the bridge reported; surface it verbatim.
      const detail = response.error ?? '(no error message)'
      // eslint-disable-next-line no-console
      console.error('[CREV] SAVE_PROPERTY failed', { rid: target.rid, property, response })
      showOutput(`Save failed: ${detail}`, false)
    } else {
      // No SAVE_RESULT came back. In MV3 this almost always means the SW was
      // unloaded mid-request and the message port closed before the response
      // could be sent. BMP may or may not have written the value, so re-read
      // the exact property before deciding whether the save succeeded.
      // eslint-disable-next-line no-console
      console.warn('[CREV] SAVE_PROPERTY: no response; verifying the stored value before reporting failure.', { rid: target.rid, property, response })
      const verify = await sendRequest({ type: 'STUDIO_FETCH_CODE', rid: target.rid, props: [property] })
      const stored = verify?.type === 'STUDIO_CODE_DATA'
        && verify.ok
        && verify.code
        && Object.prototype.hasOwnProperty.call(verify.code, property)
        ? verify.code[property]
        : undefined
      const state = reconcileLostSave(code, saveSurface.textFor(slotKey), stored)
      if (state === 'confirmed' || state === 'confirmed-with-newer-edits') {
        await acceptSavedValue(saveSurface, slotKey, savedCodeMap, saveContext, property, code, storageRid)
        showOutput(state === 'confirmed'
          ? `Saved to ${targetLabel} (confirmed after the response was lost).`
          : `Saved ${property} to ${targetLabel} (confirmed after the response was lost). Newer edits remain unsaved.`, true)
      } else if (state === 'mismatch') {
        showOutput('The save response was lost and BMP stores a different value. Your current edit remains unsaved.', false)
      } else {
        showOutput('No save response, and the stored value could not be verified. Your current edit remains unsaved.', false)
      }
    }
  } finally {
    if (btn) { delete btn.dataset.saving }
    refreshActions()
  }
}

async function acceptSavedValue(
  saveSurface: CodeSurface,
  slotKey: string,
  savedCodeMap: Record<string, string>,
  saveContext: EditorContext,
  property: string,
  code: string,
  storageRid: string,
): Promise<void> {
  // Move only the server baseline. If the user typed while save/verification
  // was in flight, CodeSurface keeps that newer document dirty and Discard
  // returns to this confirmed value.
  saveSurface.markValueSaved(slotKey, code)
  savedCodeMap[property] = code
  lastSavedAt = Date.now()
  if (saveLabelTimer) clearTimeout(saveLabelTimer)
  saveLabelTimer = setTimeout(() => { refreshActions() }, 4200)
  if (storageRid) await chrome.storage.local.set({ [`crev_editor_ctx_${storageRid}`]: saveContext })
}

/** Copy text to clipboard and briefly flash a button's content with a check icon. */
function flashCopy(btn: HTMLElement, text: string, restore: () => void) {
  navigator.clipboard.writeText(text).catch(() => {})
  const prev = btn.innerHTML
  btn.innerHTML = ''
  btn.append(svg(ICON_CHECK))
  setTimeout(() => { btn.innerHTML = prev; restore() }, 900)
}

// ── Bottom panel (output / vars / history) ──────────────────────

function showOutput(text: string, ok: boolean) {
  lastOutputText = text
  lastOutputOk = ok
  // Pull BMP's own compute time out of the output so the pill can show it
  // next to the round-trip. Null for the "Previewing…" placeholder (no
  // Duration line yet) and for outputs BMP didn't time.
  lastBmpMs = parseBmpDurationMs(text)
  // Non-preview output (executes, saves) makes the prior "stale" cue
  // meaningless — it referred to a preview that's now superseded.
  if (lastMode !== 'preview') staleAfterPreview = false
  bottomMode = 'output'
  bottomPanelOpen = true
  openBottomPanel()
  renderBottomContent()
}

function openBottomPanel() {
  const panel = document.getElementById('bottom-panel')
  const handle = document.getElementById('drag-handle')
  if (panel) panel.style.display = ''
  if (handle) handle.style.display = ''
  applyOutputHeight()
  updateBottomBar()
}

/** Size the output panel per the current mode: maximized → a large fixed
 *  fraction; manual → the user's dragged height; auto → fit the content,
 *  capped so a huge log grows to a ceiling then scrolls internally. Called
 *  on open, after each content render, on maximize toggle, and on resize. */
function applyOutputHeight() {
  const panel = document.getElementById('bottom-panel')
  if (!panel || panel.style.display === 'none') return
  const winH = window.innerHeight
  // Manual drag and the Vars / History tabs both use a fixed height (the
  // user's dragged size, clamped). Only the Output tab in auto mode fits
  // its content.
  const fixedHeight = Math.min(outputHeight, Math.round(winH * 0.9))
  if (outputMaximized) {
    panel.style.height = `${Math.round(winH * OUTPUT_MAX_FRAC)}px`
  } else if (outputSizing === 'auto' && bottomMode === 'output') {
    // Auto: measure the natural content height (briefly unconstrained),
    // then clamp to [floor, ceiling]. Synchronous — no paint in between,
    // so there's no flicker from the transient `auto`. Scoped to the
    // Output tab only: Vars / History re-render on every inference update,
    // so measuring them each time would jitter the panel and force sync
    // layout in a hot path.
    panel.style.height = 'auto'
    const natural = panel.offsetHeight
    const capped = Math.min(natural, Math.round(winH * OUTPUT_AUTO_FRAC))
    // Floor at ~1/3 of the window so a fresh preview opens to a comfortable
    // default size (a one-line result no longer opens as a thin sliver); longer
    // output still grows to the OUTPUT_AUTO_FRAC ceiling, then scrolls.
    const floor = Math.max(MIN_OUTPUT_PX, Math.round(winH * OUTPUT_DEFAULT_FRAC))
    panel.style.height = `${Math.max(floor, capped)}px`
  } else {
    panel.style.height = `${fixedHeight}px`
  }
  updateMaximizeButton()
}

function toggleMaximizeOutput(e?: Event) {
  e?.stopPropagation()
  outputMaximized = !outputMaximized
  applyOutputHeight()
}

function updateMaximizeButton() {
  const btn = document.getElementById('btn-output-max')
  if (!btn) return
  // Flip the icon with the state so the button always shows what clicking
  // will do: arrows-out = maximize, arrows-in = restore.
  btn.innerHTML = outputMaximized ? ICON_ARROWS_IN_SIMPLE : ICON_ARROWS_OUT_SIMPLE
  const label = outputMaximized ? 'Restore output size' : 'Maximize output'
  btn.title = label
  btn.setAttribute('aria-label', label)
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
  const setActive = (id: string, mode: typeof bottomMode) => {
    const el = document.getElementById(id)
    if (el) el.classList.toggle('active', bottomPanelOpen && bottomMode === mode)
  }
  setActive('btn-output-tab', 'output')
  setActive('btn-vars', 'vars')
  setActive('btn-history', 'history')
}

function renderBottomContent() {
  renderBottomContentInner()
  // Auto-size tracks the freshly-rendered content (no-op in manual/maximized
  // modes and when the panel is hidden).
  applyOutputHeight()
}

function renderBottomContentInner() {
  const container = document.getElementById('bottom-panel-content')
  if (!container) return

  if (bottomMode === 'output') {
    const modeLabel = lastMode === 'save' ? 'Saved' : lastMode === 'execute' ? 'Executed' : 'Preview'
    const cls = lastOutputOk ? 'ok' : 'error'
    const timing = lastDuration != null ? formatRunTiming(lastDuration, lastBmpMs) : null
    const outputContent = lastOutputOk
      ? renderEcOutput(lastOutputText, tablePreview, decodePreview)
      : h('div', { class: 'editor-output-content error' }, lastOutputText)
    renderDom(container,
      h('div', { class: 'editor-output-header' },
        h('span', { class: `editor-output-pill ${cls}` },
          svg(lastOutputOk ? ICON_CHECK : ICON_X),
          h('span', null, ` ${modeLabel}`),
          timing ? h('span', { class: 'editor-output-pill-dur', title: timing.title }, timing.text) : null,
        ),
        // "Stale" pill when the editor's code has diverged from what
        // this output reflects — keeps the user from acting on results
        // that no longer match the buffer.
        staleAfterPreview
          ? h('span', { class: 'editor-output-stale', title: 'You edited the code after this preview ran' }, svg(ICON_WARNING), ' stale. Preview again')
          : null,
        h('div', { class: 'editor-output-header-spacer' }),
        // Output-specific controls moved here from the bottom bar —
        // decode + table operate on THIS panel's content, copy snapshots
        // THIS panel's text. Wrap stayed in the editor toolbar where
        // the line-wrapping it controls actually lives.
        h('button', {
          class: `btn-micro${decodePreview ? ' active' : ''}`,
          title: 'Decode escape sequences (\\n, \\t, \\", \\\\)',
          onClick: () => toggleOutputPref('decode'),
        }, h('span', { class: 'btn-micro-label' }, '\\n')),
        h('button', {
          class: `btn-micro${tablePreview ? ' active' : ''}`,
          title: 'Toggle table rendering for | -separated rows',
          onClick: () => toggleOutputPref('table'),
        }, svg(ICON_TABLE)),
        h('button', {
          class: 'btn-micro',
          id: 'btn-copy-output',
          title: 'Copy output',
          onClick: (e: Event) => {
            const btn = (e.currentTarget as HTMLElement)
            // Mirror what the panel shows. On OK output that's the parsed
            // view (tables → TSV for spreadsheet-paste, other lines verbatim,
            // honouring the decode + table toggles). On ERROR the panel shows
            // raw text untouched, so copy the raw bytes to match.
            const copyText = lastOutputOk
              ? ecOutputToText(lastOutputText, tablePreview, decodePreview)
              : lastOutputText
            flashCopy(btn, copyText, () => {})
          },
        }, svg(ICON_COPY)),
        // Divider: the content controls (\n / table / copy) are about the
        // OUTPUT TEXT; the size toggle is about the PANEL. A subtle rule +
        // gap separates the two groups, both on the right.
        h('div', { class: 'editor-output-header-div' }),
        // Single maximize ↔ restore toggle. The icon shows what clicking
        // will do (arrows-out = maximize, arrows-in = restore) and flips
        // with the state — see updateMaximizeButton. Collapsing the panel
        // entirely is the bottom bar's job: click the active tab.
        h('button', {
          class: 'btn-micro', id: 'btn-output-max',
          title: outputMaximized ? 'Restore output size' : 'Maximize output',
          'aria-label': outputMaximized ? 'Restore output size' : 'Maximize output',
          onClick: toggleMaximizeOutput,
        }, svg(outputMaximized ? ICON_ARROWS_IN_SIMPLE : ICON_ARROWS_OUT_SIMPLE)),
      ),
      outputContent,
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
            onClick: async () => {
              const view = surface?.view
              if (!view) return
              // Replacing the editor doc nukes whatever the user has
              // typed. Confirm when there's unsaved work to avoid
              // silent data loss — this exact path was the #1 bug in
              // the editor audit.
              if (curDirty()) {
                const ok = await confirmModal({
                  title: 'Discard current changes?',
                  body: 'Loading from history replaces the editor content. Unsaved edits will be lost.',
                  confirmLabel: 'Load from history',
                  confirmVariant: 'danger',
                })
                if (!ok) return
              }
              // A real user action (not a programmatic swap) — flows through
              // CodeSurface's listener and marks the slot dirty.
              view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: e.code } })
              view.focus()
            },
          },
            h('span', { class: 'editor-history-icon' }, svg(e.mode === 'execute' ? ICON_LIGHTNING : ICON_PLAY)),
            h('span', { class: `editor-history-status ${e.ok ? 'ok' : 'fail'}` }, svg(e.ok ? ICON_CHECK : ICON_X)),
            h('span', { class: 'editor-history-dur' }, e.durationMs != null ? `${e.durationMs}ms` : ''),
            h('span', { class: 'editor-history-code' }, e.code.split('\n')[0].slice(0, 50)),
            h('span', { class: 'editor-history-time' }, relativeTime(e.timestamp)),
          ),
        ),
      ),
    )
  }

  if (bottomMode === 'vars') {
    renderVarsPanel(container)
  }
}

/** Vars + Properties panel \u2014 phase 3.
 *  Horizontal split: left 40% = tracked vars with type chips;
 *  right 60% = property list for the selected var's inferred type.
 *  Click a property row \u2192 inserts `<accessor>` at the editor cursor.
 *  Highlights occurrences in the editor on var hover (via varHighlight). */
/** Persistent props-filter input — built once and reused across vars-panel
 *  rebuilds, so typing never recreates the node (focus is reclaimed by
 *  captureTypingFocus in renderVarsPanel). */
function getVarsFilterInput(): HTMLInputElement {
  if (varsFilterInputEl) return varsFilterInputEl
  const input = h('input', {
    class: 'editor-vars-props-filter',
    id: 'vars-filter-input',
    placeholder: 'Filter properties…',
    autocomplete: 'off', autocorrect: 'off', spellcheck: 'false',
  }) as HTMLInputElement
  input.value = varsFilter
  input.addEventListener('input', () => {
    varsFilterTypedAt = Date.now()
    varsFilter = input.value
    renderBottomContent()
  })
  varsFilterInputEl = input
  return input
}

function renderVarsPanel(container: HTMLElement): void {
  const vars = getTrackedVariables()
  if (vars.length === 0) {
    renderDom(container, h('div', { class: 'editor-history-empty' }, 'No variables. Use _name := expression'))
    return
  }

  // Resolve the active selection: explicit pick > most-recent
  // "interesting" var. "Interesting" = list or scalar (something with
  // properties to show). Falls back to most-recent overall so the
  // pane is never blank when the user just has primitive vars.
  const inferences = getAllInferences()
  let selected = varsSelected && vars.some(v => v.name === varsSelected) ? varsSelected : null
  if (!selected) {
    const interesting = vars.filter(v => {
      const inf = inferences.get(v.name)
      return inf?.kind === 'list' || inf?.kind === 'scalar'
    })
    const pickFrom = interesting.length > 0 ? interesting : vars
    selected = pickFrom.reduce((best, v) => (!best || v.line > best.line ? v : best), null as { name: string; line: number } | null)?.name ?? null
  }

  // Capture the props-list scroll BEFORE the re-render replaces it.
  // The new node starts at scrollTop=0 by default, which jumps the
  // user to the top mid-edit (e.g. they clicked a property at the
  // bottom of a long list to insert; the doc change triggered a
  // re-render; the list scrolled back to the top).
  const prevList = container.querySelector<HTMLElement>('.editor-vars-props-list')
  if (prevList) varsPropsScrollTop = prevList.scrollTop

  // The props filter input is detached + reattached by this render; reclaim its
  // focus + caret if the user was just typing in it (shared helper).
  const restoreFilterFocus = captureTypingFocus(
    { el: varsFilterInputEl, at: varsFilterTypedAt },
    el => container.contains(el),
  )

  renderDom(container,
    h('div', { class: 'editor-vars-split' },
      renderVarsList(vars, inferences, selected),
      renderVarsProps(selected, inferences),
    ),
  )

  // Restore the props list scroll on the newly-rendered element.
  const nextList = container.querySelector<HTMLElement>('.editor-vars-props-list')
  if (nextList && varsPropsScrollTop > 0) nextList.scrollTop = varsPropsScrollTop

  restoreFilterFocus()
}

function renderVarsList(
  vars: ReturnType<typeof getTrackedVariables>,
  inferences: Map<string, TypeInference>,
  selected: string | null,
): HTMLElement {
  return h('div', { class: 'editor-vars-list-pane' },
    ...vars.map(v => {
      const inf = inferences.get(v.name)
      const typeChip = renderTypeChip(inf)
      return h('div', {
        class: `editor-vars-item${selected === v.name ? ' editor-vars-item--selected' : ''}`,
        onClick: () => {
          if (varsSelected !== v.name) varsPropsScrollTop = 0
          varsSelected = v.name
          renderBottomContent()
        },
        // Double-click jumps to the assignment line \u2014 preserves the
        // old single-click behaviour, just shifted.
        onDblclick: () => {
          const view = surface?.view
          if (view) {
            const line = view.state.doc.line(Math.min(v.line, view.state.doc.lines))
            view.dispatch({ selection: { anchor: line.from }, scrollIntoView: true })
            view.focus()
          }
        },
        onMouseenter: () => { if (surface?.view) setHighlightedVar(surface.view, v.name) },
        onMouseleave: () => { if (surface?.view) setHighlightedVar(surface.view, null) },
        title: inf?.kind === 'scalar' && inf.loopVar
          ? `${v.name}: loop element of ${v.rhs} (line ${v.line}). Double-click to jump`
          : `${v.name} := ${v.rhs} (line ${v.line}). Double-click to jump`,
      },
        h('span', { class: 'editor-vars-name' }, v.name),
        inf?.kind === 'scalar' && inf.loopVar
          ? h('span', { class: 'editor-vars-loopbadge', title: 'Loop variable (bound by forEach/map/…)' }, 'loop')
          : null,
        typeChip,
      )
    }),
  )
}

/** Render a small chip describing the inferred type for the var name
 *  displayed on its row. Drives the right-pane filter when clicked. */
function renderTypeChip(inf: TypeInference | undefined): HTMLElement {
  if (!inf) return h('span', { class: 'editor-vars-typechip editor-vars-typechip--unknown', title: 'No inference yet' }, '?')
  switch (inf.kind) {
    case 'list': {
      const labels = inf.types.map(canonicalType)
      return h('span', {
        class: 'editor-vars-typechip editor-vars-typechip--list',
        title: labels.length > 1 ? `List of ${labels.join(' | ')}: properties shown are the intersection` : `List<${labels[0]}>`,
      }, `[${labels.join('|')}]`)
    }
    case 'scalar':
      return h('span', {
        class: 'editor-vars-typechip editor-vars-typechip--scalar',
        title: `Single ${canonicalType(inf.type)}`,
      }, canonicalType(inf.type))
    case 'primitive':
      return h('span', {
        class: 'editor-vars-typechip editor-vars-typechip--primitive',
        title: `${inf.primitive}: primitive, no properties`,
      }, inf.primitive)
    case 'unknown':
      return h('span', {
        class: 'editor-vars-typechip editor-vars-typechip--unknown',
        title: inf.reason,
      }, '?')
  }
}

function renderVarsProps(selected: string | null, inferences: Map<string, TypeInference>): HTMLElement {
  if (!selected) {
    return h('div', { class: 'editor-vars-props-pane' })
  }
  const inf = inferences.get(selected)
  if (!inf) {
    return h('div', { class: 'editor-vars-props-pane' },
      h('div', { class: 'editor-vars-props-empty' }, 'No type inferred for this variable yet.'),
    )
  }
  if (inf.kind === 'primitive') {
    return h('div', { class: 'editor-vars-props-pane' },
      h('div', { class: 'editor-vars-props-empty' }, `${inf.primitive}: primitive, no object properties.`),
    )
  }
  if (inf.kind === 'unknown') {
    return h('div', { class: 'editor-vars-props-pane' },
      h('div', { class: 'editor-vars-props-empty' }, inf.reason),
    )
  }

  // List or scalar \u2192 resolve to one or more types and intersect.
  const types = inf.kind === 'list' ? inf.types : [inf.type]
  // Make sure every type has a fetch in flight or done.
  for (const t of types) ensureSchema(t)

  let props = inf.kind === 'list' && types.length > 1
    ? intersectionSchema(types)
    : getSchema(types[0])

  if (!props) {
    // Distinguish "schema is loading" from "fetch failed". For
    // multi-type lists we only need ONE failure to know the
    // intersection will fail \u2014 surface the first error we find.
    const failedType = types.find(t => getSchemaError(t))
    if (failedType) {
      const err = getSchemaError(failedType)
      return h('div', { class: 'editor-vars-props-pane' },
        h('div', { class: 'editor-vars-props-error' },
          h('div', { class: 'editor-vars-props-error-head' }, `Couldn\u2019t load ${canonicalType(failedType)}`),
          h('div', { class: 'editor-vars-props-error-body' }, err ?? 'Unknown error'),
          h('button', {
            class: 'btn btn-small',
            title: 'Re-fetch from BMP',
            onClick: () => { for (const t of types) refreshSchema(t) },
          }, 'Retry'),
        ),
      )
    }
    return h('div', { class: 'editor-vars-props-pane' },
      h('div', { class: 'editor-vars-props-empty' }, `Loading schema for ${types.map(canonicalType).join(' + ')}\u2026`),
    )
  }

  const totalCount = props.length
  const systemCount = props.filter(p => p.systemobject).length
  const customCount = totalCount - systemCount

  // Client-side filters \u2014 all O(n) over ~50-200 props, instant.
  //   1. System pill (default off): include systemobject:true props
  //      only when the System pill is active.
  //   2. Kind pills (multi-select, default none): if any are active,
  //      only props whose family is in the set survive. Empty = all
  //      kinds pass (so the user doesn't have to enable every pill
  //      just to see everything).
  //   3. Substring search across accessor + label.
  let visible = varsShowSystem ? props : props.filter(p => !p.systemobject)
  if (varsKindFilter.size > 0) {
    visible = visible.filter(p => {
      const fam = propFamily(p.configClass)
      // System props get a free pass when the System pill is on AND
      // no other kind is selected \u2014 otherwise they're filtered by
      // the active kind set like everything else.
      if (fam === 'sys') return varsShowSystem
      return varsKindFilter.has(fam)
    })
  }
  if (varsFilter.trim()) {
    const q = varsFilter.toLowerCase()
    visible = visible.filter(p => p.accessor.toLowerCase().includes(q) || p.label.toLowerCase().includes(q))
  }

  // Load the list/tag option sets if any optionable prop is visible, so the
  // expandable dropdowns can fill. Cheap + cached; panel re-renders on arrival.
  const hasOptionable = visible.some(p => { const f = propFamily(p.configClass); return f === 'list' || f === 'tag' })
  if (hasOptionable) for (const t of types) ensureOptionsNow(t)
  const findOpt = (accessor: string) => { for (const t of types) { const o = getOption(t, accessor); if (o) return o } return undefined }

  const typeLabel = types.length === 1 ? canonicalType(types[0]) : types.map(canonicalType).join(' \u2229 ')
  return h('div', { class: 'editor-vars-props-pane' },
    h('div', { class: 'editor-vars-props-head' },
      h('span', { class: 'editor-vars-props-title' },
        types.length === 1 ? `${typeLabel}` : `${typeLabel} (intersection)`,
        h('span', { class: 'editor-vars-props-count' },
          ` \u00b7 ${customCount} custom`,
          systemCount > 0 ? ` / ${systemCount} system` : '',
        ),
      ),
      h('button', {
        class: 'btn-micro',
        title: 'Re-fetch schema from BMP (bypasses cache)',
        onClick: () => { for (const t of types) refreshSchema(t) },
      }, svg(ICON_REFRESH)),
    ),
    h('div', { class: 'editor-vars-props-controls' },
      getVarsFilterInput(),
    ),
    // Pill row \u2014 System toggle + multi-select kind filters.
    h('div', { class: 'editor-vars-props-pills', role: 'group', 'aria-label': 'Property kind filters' },
      h('button', {
        class: `editor-vars-pill editor-vars-pill--sys${varsShowSystem ? ' active' : ''}`,
        title: `Show ${systemCount} BMP system fields (id, name, parent, \u2026)`,
        onClick: () => { varsShowSystem = !varsShowSystem; renderBottomContent() },
      }, `System${systemCount > 0 ? ` ${systemCount}` : ''}`),
      ...KIND_FILTER_PILLS.map(p => h('button', {
        class: `editor-vars-pill editor-vars-pill--${p.family}${varsKindFilter.has(p.family) ? ' active' : ''}`,
        title: p.title,
        onClick: () => {
          if (varsKindFilter.has(p.family)) varsKindFilter.delete(p.family)
          else varsKindFilter.add(p.family)
          renderBottomContent()
        },
      }, p.label)),
    ),
    h('div', { class: 'editor-vars-props-list' },
      visible.length === 0
        ? h('div', { class: 'editor-vars-props-empty' }, 'No properties match.')
        : visible.map(p => {
          const fam = propFamily(p.configClass)
          const optionable = fam === 'list' || fam === 'tag'
          const expanded = optionable && varsExpandedOptions.has(p.accessor)
          const row = h('div', {
            class: `editor-vars-prop-row${p.systemobject ? ' editor-vars-prop-row--system' : ''}`,
            // Click inserts the bare accessor at the cursor (no leading
            // dot \u2014 the user adds the dot themselves). If the user had
            // text selected, the selection is replaced.
            onClick: () => insertAtCursor(p.accessor),
            title: `${p.accessor} \u00b7 ${p.label} \u00b7 ${p.configClass}. Click to insert ${p.accessor} at cursor`,
          },
            optionable
              ? h('button', {
                  class: `editor-vars-prop-expand${expanded ? ' expanded' : ''}`,
                  title: expanded ? 'Hide allowed values' : 'Show allowed values',
                  onClick: (e: Event) => {
                    e.stopPropagation()
                    if (varsExpandedOptions.has(p.accessor)) varsExpandedOptions.delete(p.accessor)
                    else varsExpandedOptions.add(p.accessor)
                    renderBottomContent()
                  },
                }, svg(ICON_CHEVRON))
              : h('span', { class: 'editor-vars-prop-expand-spacer' }),
            h('span', { class: 'editor-vars-prop-accessor' }, p.accessor),
            h('span', { class: 'editor-vars-prop-label' }, p.label),
            h('span', { class: `editor-vars-prop-kind editor-vars-prop-kind--${kindFamily(p.configClass)}` }, kindShort(p.configClass)),
          )
          if (!expanded) return row
          // Allowed-value dropdown \u2014 each value inserts its t.<businessId> ref.
          const opt = findOpt(p.accessor)
          const items = opt?.items ?? []
          return h('div', { class: 'editor-vars-prop-group' },
            row,
            h('div', { class: 'editor-vars-prop-options' },
              items.length === 0
                ? h('div', { class: 'editor-vars-prop-options-empty' }, opt ? 'No values defined.' : 'Loading values\u2026')
                : [
                    ...items.map(it => h('div', {
                      class: 'editor-vars-prop-option',
                      title: `Insert ${it.ref} at cursor`,
                      onClick: () => insertAtCursor(it.ref),
                    },
                      h('span', { class: 'editor-vars-prop-option-ref' }, it.ref),
                      h('span', { class: 'editor-vars-prop-option-name' }, it.name),
                    )),
                    h('div', { class: 'editor-vars-prop-options-set' }, `${opt!.multi ? 'tag list' : 'value list'} \u00b7 ${items.length}`),
                  ],
            ),
          )
        }),
    ),
  )
}

/** Map BMP's MethodConfig classNames to a short chip label. */
function kindShort(configClass: string): string {
  if (configClass === 'TextMethodConfig') return 'Text'
  if (configClass === 'RichTextMethodConfig') return 'Rich'
  if (configClass === 'NumberMethodConfig' || configClass === 'HistoricalNumberMethodConfig') return 'Num'
  if (configClass === 'DateMethodConfig' || configClass === 'HistoricalDateMethodConfig') return 'Date'
  if (configClass === 'ListMethodConfig' || configClass === 'HistoricalListMethodConfig') return 'List'
  if (configClass === 'TagMethodConfig') return 'Tag'
  if (configClass === 'ReferenceMethodConfig' || configClass === 'HistoricalReferenceMethodConfig') return 'Ref'
  if (configClass === 'ReverseReferenceMethodConfig') return 'RRef'
  if (configClass === 'ExtendedMethodConfig') return 'EC'
  if (configClass === 'SystemMethodConfig') return 'Sys'
  return configClass.replace(/MethodConfig$/, '')
}

/** Family used for the chip colour. Keep small + stable. */
function kindFamily(configClass: string): string {
  if (configClass === 'ReferenceMethodConfig' || configClass === 'HistoricalReferenceMethodConfig' || configClass === 'ReverseReferenceMethodConfig') return 'ref'
  if (configClass === 'ExtendedMethodConfig') return 'ec'
  if (configClass === 'SystemMethodConfig') return 'sys'
  if (configClass.startsWith('Historical')) return 'hist'
  return 'data'
}

/** User-facing family for the filter pills. Wider than `kindFamily`
 *  (which is colour-only and groups by data/ref/sys/ec/hist) — here we
 *  treat Text and RichText as one bucket, Number-and-HistoricalNumber
 *  as one, etc. so the configurator's mental model "I'm looking for
 *  text fields" finds both regular and historical variants per the
 *  user's spec: "if someone clicks text, that gives both historicaltext
 *  and normal text etc." */
type PropFamily = 'ref' | 'text' | 'num' | 'date' | 'list' | 'tag' | 'ec';
function propFamily(configClass: string): PropFamily | 'sys' | 'other' {
  if (configClass === 'SystemMethodConfig') return 'sys'
  if (configClass === 'ReferenceMethodConfig' || configClass === 'HistoricalReferenceMethodConfig' || configClass === 'ReverseReferenceMethodConfig') return 'ref'
  if (configClass === 'TextMethodConfig' || configClass === 'RichTextMethodConfig') return 'text'
  if (configClass === 'NumberMethodConfig' || configClass === 'HistoricalNumberMethodConfig') return 'num'
  if (configClass === 'DateMethodConfig' || configClass === 'HistoricalDateMethodConfig') return 'date'
  if (configClass === 'ListMethodConfig' || configClass === 'HistoricalListMethodConfig') return 'list'
  if (configClass === 'TagMethodConfig') return 'tag'
  if (configClass === 'ExtendedMethodConfig') return 'ec'
  return 'other'
}

const KIND_FILTER_PILLS: ReadonlyArray<{ family: PropFamily; label: string; title: string }> = [
  { family: 'ref',  label: 'Ref',  title: 'Reference + ReverseReference + historical references' },
  { family: 'text', label: 'Text', title: 'Plain text + rich text' },
  { family: 'num',  label: 'Num',  title: 'Number + historical number' },
  { family: 'date', label: 'Date', title: 'Date + historical date' },
  { family: 'list', label: 'List', title: 'List + historical list' },
  { family: 'tag',  label: 'Tag',  title: 'Tag' },
  { family: 'ec',   label: 'EC',   title: 'Extended Code expression' },
]

/** Insert text at the editor cursor \u2014 used by the property
 *  click-to-insert. Focuses the editor after insertion so the user
 *  keeps typing without an alt-tab. */
function insertAtCursor(text: string): void {
  surface?.insertAtCursor(text)
}

/** Open the bottom panel to `mode`, or collapse it if that mode is already
 *  showing. Unifies the former toggleOutput / toggleVars / toggleHistory. */
function togglePanel(mode: typeof bottomMode): void {
  if (bottomPanelOpen && bottomMode === mode) {
    hideBottomPanel()
    return
  }
  bottomMode = mode
  bottomPanelOpen = true
  openBottomPanel()
  if (mode === 'history') loadHistory()
  else renderBottomContent()
}

function toggleWrap() {
  wrapLines = !wrapLines
  surface?.setWrap(wrapLines)
  const btn = document.getElementById('btn-wrap')
  if (btn) btn.className = `btn-micro${wrapLines ? ' active' : ''}`
  chrome.storage.local.set({ crev_editor_wrap: wrapLines }).catch(() => {})
}

function toggleOutputPref(which: 'table' | 'decode'): void {
  if (which === 'table') tablePreview = !tablePreview
  else decodePreview = !decodePreview
  if (bottomPanelOpen && bottomMode === 'output') renderBottomContent()
  const payload: Record<string, boolean> = which === 'table'
    ? { crev_editor_table: tablePreview }
    : { crev_editor_decode: decodePreview }
  chrome.storage.local.set(payload).catch(() => {})
}

function loadHistory() {
  sendRequest({ type: 'GET_SCRIPT_HISTORY' }).then(response => {
    if (response?.type === 'SCRIPT_HISTORY_DATA') historyEntries = response.entries
    renderBottomContent()
  }).catch(() => {})
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
  let pointerId: number | null = null

  // Pointer events instead of mouse/* — gives us touch + stylus
  // support and matches the layout-size + frame-overlay handlers
  // elsewhere in the extension. setPointerCapture means we don't
  // need document-level move listeners.
  function onMove(e: PointerEvent) {
    const delta = startY - e.clientY
    const newHeight = Math.max(60, Math.min(window.innerHeight * 0.9, startHeight + delta))
    // Dragging is an explicit size choice — leave auto/maximized behind.
    outputHeight = newHeight
    outputSizing = 'manual'
    outputMaximized = false
    const panel = document.getElementById('bottom-panel')
    if (panel) panel.style.height = `${newHeight}px`
    updateMaximizeButton()
  }
  function finish() {
    if (pointerId != null) {
      try { handle!.releasePointerCapture(pointerId) } catch { /* released */ }
      pointerId = null
    }
    handle!.classList.remove('dragging')
    handle!.removeEventListener('pointermove', onMove)
    handle!.removeEventListener('pointerup', finish)
    handle!.removeEventListener('pointercancel', finish)
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    chrome.storage.local.set({ crev_editor_output_height: outputHeight }).catch(() => {})
  }

  handle.addEventListener('pointerdown', (e: PointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    startY = e.clientY
    pointerId = e.pointerId
    const panel = document.getElementById('bottom-panel')
    startHeight = panel ? panel.offsetHeight : outputHeight
    try { handle.setPointerCapture(e.pointerId) } catch { /* fine */ }
    handle.classList.add('dragging')
    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'
    handle.addEventListener('pointermove', onMove)
    handle.addEventListener('pointerup', finish)
    handle.addEventListener('pointercancel', finish)
  })
}

// ── Overlay close-request handshake ─────────────────────────────
// Guards both exits an overlay editor has: the host close-request (in-app
// confirm) and host-page navigation (the iframe dies with the page, so the
// browser's native beforeunload prompt is the only reliable signal).
installDirtyGuards({ isDirty: anyDirty, bodyText: 'This editor has unsaved changes. Close anyway?' })

// Window-level F5 fallback: when focus has wandered out of the CodeMirror
// editor (the user clicked a button, the toolbar, an empty area…), the
// editor's keymap doesn't see F5 and the browser would refresh the page,
// destroying any unsaved draft. Catch F5 globally and route it through
// the same `doPreview()` the CM keymap uses.
window.addEventListener('keydown', (e) => {
  if (e.key !== 'F5' || e.ctrlKey || e.shiftKey || e.altKey || e.metaKey) return
  e.preventDefault()
  void doPreview()
}, true)

// ── Launch ───────────────────────────────────────────────────────

void init()
