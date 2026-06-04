/**
 * CREV Inspector — EC Editor Window.
 * CodeMirror 6 editor for Extended Code, HTML, and JavaScript properties.
 * Communicates with service worker for preview/save operations.
 */
import { EditorState, Compartment } from '@codemirror/state'
import { EditorView, keymap, lineNumbers, highlightActiveLineGutter, highlightActiveLine, drawSelection } from '@codemirror/view'
import { defaultKeymap, indentWithTab, history, historyKeymap } from '@codemirror/commands'
import { bracketMatching, foldGutter, indentOnInput, foldKeymap, indentUnit } from '@codemirror/language'
import { closeBrackets, closeBracketsKeymap, autocompletion, startCompletion } from '@codemirror/autocomplete'
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search'
import { lintGutter } from '@codemirror/lint'
import { catppuccinMocha } from './catppuccin-theme'

// Shared types + context helpers
import { type SaveTarget, type ScriptHistoryEntry, getTypeAbbr, getTypeColor } from '../lib/types'
import { h, svg, render as renderDom } from '../lib/dom'
import { ICON_PLAY, ICON_X, ICON_WRAP, ICON_VARIABLE, ICON_CLOCK, ICON_CHECK, ICON_LIGHTNING, ICON_TABLE, ICON_COPY, ICON_REFRESH, ICON_BOOK } from '../lib/icons'
import { renderEcOutput, ecOutputToText, parseBmpDurationMs } from './ec-output'
import { showBookPopover } from './book'
import { anchorPopover } from '../lib/popover-anchor'
import { installCloseHandshake } from '../lib/frame-close-handshake'
import { sendFireForget, sendRequest } from '../lib/messaging'
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
  canonicalType,
  type TypeInference,
} from './ec/typeInference'
import { starExpansionCompletions } from './ec/starExpansion'
import { extendedLinter } from './ec/diagnostics'
import { runtimeErrorLinter, setRuntimeError, parseEcErrorLocation, clearRuntimeErrors } from './ec/runtimeErrors'
import { ecBlockMatching } from './ec/blockMatching'
import { ecFoldService } from './ec/foldRegions'
import { wrapInIf, wrapInForEach } from './ec/wrapCommands'
import { selectNextOccurrence } from './ec/renameVariable'

// ── State ────────────────────────────────────────────────────────

let ctx: EditorContext | null = null
let editorView: EditorView | null = null
/** Whether the live editor view is configured for Extended Code (EC gets
 *  the EC language, linter, var tracker, etc.). Tracked so a target /
 *  property switch can tell whether it can swap the doc in-place (same
 *  language) or must rebuild the view (EC ⇄ plain HTML/JS — different
 *  extension set). See `loadEditorDoc`. */
let currentIsEc = false
/** Set true around a programmatic doc-replace (target / property switch)
 *  so the editor's updateListener doesn't treat the swap as a user edit
 *  (which would flip `dirty`, reset the preview gate, and mark the output
 *  stale). dispatch() runs the listener synchronously, so this flag is
 *  always back to false before any user interaction. */
let programmaticDocSwap = false
let activeProperty = ''
let bottomPanelOpen = false
let bottomMode: 'output' | 'history' | 'vars' = 'output'
let dirty = false
let outputHeight = 160 // default px, persisted
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
const wrapCompartment = new Compartment()
let wrapLines = false
let tablePreview = true
let decodePreview = true
// Vars panel — phase 3. Tracks the currently selected variable in
// the left pane so the right pane (properties) knows what to render.
// Default selection is "last assigned" (resolved at render time).
let varsSelected: string | null = null
let varsShowSystem = false
let varsFilter = ''
// Kind-family pills (Text, Num, Date, …). Multi-select — when empty,
// every kind passes. When non-empty, only props whose family is in
// this set survive. Maps to the family strings returned by
// `propFamily()` below (which collapses the BMP MethodConfig
// hierarchy into a small, user-recognisable taxonomy: Text and
// RichText both fall under "text"; Number and HistoricalNumber both
// under "num"; etc.).
const varsKindFilter = new Set<string>()
// Cursor position to restore in the filter input after a re-render.
// null = don't restore (no recent edit).
let varsFilterRefocus: number | null = null
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
let saveLabelTimer: ReturnType<typeof setTimeout> | null = null
/** Per-property cursor + scroll + undo snapshot. Keyed by `${target}:${prop}`
 *  so template vs instance keeps independent state for the same property.
 *  Lets the user tab between properties without losing where they were. */
interface PropEditState { docText: string; selection: { anchor: number; head: number }; scrollTop: number; dirty: boolean }
const propStateCache = new Map<string, PropEditState>()
const propStateKey = (target: SaveTarget | 'extended', prop: string): string => `${target}:${prop}`
/** Snapshot of what BMP returned at editor boot (and after each
 *  successful save). Survives stashCurrentPropState() — which writes
 *  the LIVE buffer back into ctx — so doDiscard can revert to the
 *  actual server-side value, not a buffer the user just typed. */
const originalCode = new Map<string, string>()

const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform)
const KBD_MOD = isMac ? '⌘' : 'Ctrl'

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

  // Snapshot what BMP gave us so Discard can revert. Cache by
  // `${target}:${prop}` — instance and template buffers are
  // independent, the user may switch between them mid-edit.
  for (const [prop, val] of Object.entries(ctx.instanceCode ?? {})) {
    originalCode.set(propStateKey('instance', prop), val)
  }
  for (const [prop, val] of Object.entries(ctx.templateCode ?? {})) {
    originalCode.set(propStateKey('template', prop), val)
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

  // Re-render the Vars panel whenever type inferences or schemas
  // change. The subscription is permanent — Vars is the only panel
  // that depends on async EC fetches, and a stray re-render on a
  // different tab is cheap (renderBottomContent early-exits if
  // bottomMode !== 'vars').
  subscribeInference(() => {
    if (bottomPanelOpen && bottomMode === 'vars') renderBottomContent()
  })
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
    `${KBD_MOD}+Enter        Preview (dry-run)`,
    `${KBD_MOD}+Shift+Enter  Execute`,
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
        [`${KBD_MOD}+Enter`,        'Preview (dry-run, safe)'],
        [`${KBD_MOD}+Shift+Enter`,  'Execute: commits changes'],
        [`${KBD_MOD}+S`,            'Save current property'],
      ],
    },
    {
      title: 'Editing',
      rows: [
        [`${KBD_MOD}+D`,        'Select next occurrence (multi-cursor)'],
        [`${KBD_MOD}+/`,        'Toggle line comment'],
        [`${KBD_MOD}+F`,        'Find in editor'],
        [`${KBD_MOD}+Shift+F`,  'Find & replace'],
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
  const typeAbbr = getTypeAbbr(identity.type)
  const typeColor = getTypeColor(identity.type)
  const bid = identity.businessId || identity.rid

  // Identity strip at top of window \u2014 replaces redundant info from old toolbar
  const headerChildren: (HTMLElement | string | false)[] = []
  if (isExtended) {
    headerChildren.push(
      h('span', { class: 'editor-id-chip', style: `--type-color:${typeColor}` }, 'EC'),
      h('span', { class: 'editor-id-name' }, identity.name || 'Extended Code'),
      identity.businessId && h('span', { class: 'editor-id-bid' }, identity.businessId),
    )
  } else {
    headerChildren.push(
      h('span', { class: 'editor-id-chip', style: `--type-color:${typeColor}`, title: identity.type || '' }, typeAbbr),
      // Identity name doubles as a "show me in BMP" link: clicking
      // posts BMP_GOTO via the SW so the user's BMP tab navigates to
      // this object without an alt-tab + click chase.
      h('button', {
        class: 'editor-id-name editor-id-name--link',
        title: `${identity.name ?? '(unnamed)'}. Click to navigate the BMP tab to this object`,
        'data-action': 'goto-bmp',
      }, identity.name || '(unnamed)'),
      h('span', { class: 'editor-id-bid' }, bid),
      // EC execution context (`this`) — the object the page renders for,
      // which is NOT the widget. Crucial for enterprise templates where the
      // widget sits on a CeRiskAssessment detail page: `this` is the
      // assessment, not the table. Surfaced so the user can trust what
      // preview/execute binds `this` to.
      ctx.executionContext != null && h('span', {
        class: 'editor-id-context',
        title: `EC context — \`this\` binds to ${ctx.executionContext.type || 'object'}${ctx.executionContext.name ? ` '${ctx.executionContext.name}'` : ''} (the object the page renders for, not the widget)`,
      },
        h('span', { class: 'editor-id-context-arrow' }, 'this → '),
        ctx.executionContext.name || ctx.executionContext.businessId || ctx.executionContext.type || ctx.executionContext.rid,
      ),
    )
  }

  // Segmented target toggle (template \u27f7 instance)
  const segToggle = (!isExtended && ctx.template)
    ? h('div', { class: 'editor-seg', role: 'tablist', 'aria-label': 'Save target' },
        h('button', {
          class: `editor-seg-btn${ctx.saveTarget === 'template' ? ' active' : ''}`,
          'data-target': 'template',
          role: 'tab',
          'aria-selected': ctx.saveTarget === 'template' ? 'true' : 'false',
          title: `${formatLabel(ctx.template!, 'full')}: changes propagate`,
        }, 'template'),
        h('button', {
          class: `editor-seg-btn${ctx.saveTarget === 'instance' ? ' active' : ''}`,
          'data-target': 'instance',
          role: 'tab',
          'aria-selected': ctx.saveTarget === 'instance' ? 'true' : 'false',
          title: formatLabel(ctx.instance, 'full'),
        }, 'instance'),
      )
    : false

  const header = h('div', { class: 'editor-header' },
    h('div', { class: 'editor-header-id' }, ...headerChildren.filter(Boolean) as (HTMLElement | string)[]),
    segToggle || h('span'),
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

  // Action toolbar \u2014 split Preview/Execute button + smart Save + wrap.
  // Save label flips to "Saved" briefly after a successful save, then
  // back to "Save" \u2014 keeps the user informed without a separate toast.
  const saveLabel = dirty ? 'Save' : (lastSavedAt && Date.now() - lastSavedAt < 4000 ? 'Saved' : 'Save')
  const saveJustHappened = !dirty && saveLabel === 'Saved'
  const saveClass = `btn ${dirty ? 'btn-success' : saveJustHappened ? 'btn-success btn-saved' : 'btn-ghost'}`
  const actionRow = h('div', { class: 'editor-actions' },
    // Split button: primary Preview + chevron revealing Execute.
    // The Execute item is disabled until a successful preview arms
    // it \u2014 the gate is physical (greyed dropdown row) rather than a
    // separate top-level button that's almost always disabled.
    h('div', { class: 'editor-split' },
      h('button', { class: 'btn btn-accent editor-split-main', id: 'btn-preview', title: `Preview (dry-run, safe) \u00b7 ${KBD_MOD}+Enter` },
        svg(ICON_PLAY), ' Preview ',
        h('kbd', null, `${KBD_MOD}\u21b5`),
      ),
      h('button', {
        class: 'btn btn-accent editor-split-chev',
        id: 'btn-preview-more',
        title: 'More run actions',
        'aria-haspopup': 'menu',
        'aria-expanded': 'false',
      }, '\u25be'),
    ),
    !isExtended && h('button', {
      class: saveClass,
      id: 'btn-save',
      disabled: !dirty,
      title: dirty ? `Save (${KBD_MOD}+S)` : saveJustHappened ? 'Just saved' : 'No changes to save',
    },
      saveJustHappened ? svg(ICON_CHECK) : null,
      ` ${saveLabel} `,
      dirty ? h('kbd', null, `${KBD_MOD}S`) : null,
    ),
    !isExtended && h('button', {
      class: 'btn btn-ghost',
      id: 'btn-discard',
      disabled: !dirty,
      title: dirty ? 'Revert to the saved BMP value (discards your edits)' : 'Nothing to discard',
    }, ' Discard'),
    h('div', { class: 'editor-actions-spacer' }),
    h('span', { class: 'editor-status', id: 'status-bar' }, 'Ln 1, Col 1'),
    // Editor-meta utilities — wrap toggle + help — sit at the far
    // right, separated from the action verbs (Preview/Save/Discard).
    // Previously btn-wrap sat between Discard and the spacer which
    // read as another action.
    h('button', {
      class: `btn-micro${wrapLines ? ' active' : ''}`,
      id: 'btn-wrap',
      title: 'Toggle line wrapping (editor only)',
    }, svg(ICON_WRAP)),
    // Book — EC quick-lookup overlay. Three tabs: Namespaces
    // (live help() output, cached), EC syntax cheat, and curated
    // snippets. Sits next to the `?` help button — together they
    // form the "I forgot the syntax" surface.
    h('button', {
      class: 'btn-micro editor-book-btn',
      id: 'btn-book',
      title: 'EC quick reference: namespaces, syntax cheat, snippets',
      'aria-label': 'Open EC quick reference',
    }, svg(ICON_BOOK)),
    // Discoverable feature reference. Hover shows the cheat sheet inline as a
    // browser tooltip; click opens a richer popover (see wireHelpButton).
    // Without this, every shortcut lived in CLAUDE.md / the README.
    h('button', {
      class: 'btn-micro editor-help-btn',
      id: 'btn-help',
      title: editorHelpText(),
      'aria-label': 'Editor features and shortcuts',
    }, '?'),
  )

  renderDom(root,
    header,
    propTabs || h('div', { class: 'editor-prop-tabs editor-prop-tabs--empty' }),
    h('div', { class: 'editor-cm-wrap', id: 'cm-container' }),
    actionRow,
    h('div', { class: 'editor-drag-handle', id: 'drag-handle', style: 'display:none' }),
    h('div', { class: 'editor-output', id: 'bottom-panel', style: `display:none;height:${outputHeight}px` },
      h('div', { id: 'bottom-panel-content' }),
    ),
    h('div', { class: 'editor-bottom-bar', id: 'bottom-bar' },
      // Bottom bar carries ONLY the panel tabs + close. Output-specific
      // controls (decode / table / copy) moved into the Output content
      // header where they actually apply. Wrap moved to the editor
      // toolbar where it belongs.
      h('div', { class: 'editor-panel-tabs', role: 'tablist', 'aria-label': 'Bottom panel' },
        h('button', { class: `editor-panel-tab${bottomPanelOpen && bottomMode === 'output' ? ' active' : ''}`, id: 'btn-output-tab', role: 'tab' }, 'Output'),
        h('button', { class: `editor-panel-tab${bottomPanelOpen && bottomMode === 'vars' ? ' active' : ''}`, id: 'btn-vars', role: 'tab' }, svg(ICON_VARIABLE), ' Vars'),
        h('button', { class: `editor-panel-tab${bottomPanelOpen && bottomMode === 'history' ? ' active' : ''}`, id: 'btn-history', role: 'tab' }, svg(ICON_CLOCK), ' History'),
      ),
      h('div', { class: 'editor-bottom-spacer' }),
      h('button', { class: 'btn-micro', id: 'btn-clear', title: 'Clear editor and output' }, svg(ICON_X)),
    ),
  )

  // Re-attach the live CodeMirror view into the freshly-rendered shell
  // instead of leaving an empty #cm-container for createEditor to rebuild.
  // renderDom() just replaced the whole shell DOM, detaching editorView.dom;
  // moving it back in keeps the view (doc, history, selection, scroll) alive
  // so a target/property switch can swap the doc in place via loadEditorDoc
  // rather than tearing CodeMirror down and reflowing it. On first paint
  // editorView is null, so createEditor mounts fresh as before.
  if (editorView) {
    const cont = document.getElementById('cm-container')
    if (cont && editorView.dom.parentElement !== cont) {
      cont.appendChild(editorView.dom)
      editorView.requestMeasure()
    }
  }

  // Wire toolbar
  document.getElementById('btn-preview')?.addEventListener('click', doPreview)
  document.getElementById('btn-preview-more')?.addEventListener('click', toggleRunMenu)
  document.getElementById('btn-save')?.addEventListener('click', doSave)
  document.getElementById('btn-discard')?.addEventListener('click', doDiscard)
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
  document.getElementById('btn-output-tab')?.addEventListener('click', toggleOutput)
  document.getElementById('btn-clear')?.addEventListener('click', doClear)
  document.getElementById('btn-vars')?.addEventListener('click', toggleVars)
  document.getElementById('btn-history')?.addEventListener('click', toggleHistory)
  document.getElementById('btn-wrap')?.addEventListener('click', toggleWrap)
  document.getElementById('btn-table')?.addEventListener('click', toggleTable)
  document.getElementById('btn-decode')?.addEventListener('click', toggleDecode)
  document.getElementById('btn-help')?.addEventListener('click', (e) => showEditorHelp(e.currentTarget as HTMLElement))
  document.getElementById('btn-book')?.addEventListener('click', (e) =>
    showBookPopover(e.currentTarget as HTMLElement, {
      // Insert at the current cursor position. The editor never
      // loses focus when the popover opens (we don't .focus() any
      // element), so the cursor / selection from when the user was
      // typing is exactly what gets replaced here.
      insertAtCursor: (text: string) => {
        if (!editorView) return false
        const { from, to } = editorView.state.selection.main
        editorView.dispatch({
          changes: { from, to, insert: text },
          selection: { anchor: from + text.length },
        })
        // Keep keyboard focus on the editor so the user can continue
        // typing immediately — the popover stays open but isn't
        // grabbing keys.
        editorView.focus()
        return true
      },
    }),
  )
  wireDragHandle()

  // Wire template/instance toggle
  for (const btn of document.querySelectorAll<HTMLElement>('.editor-seg-btn')) {
    btn.addEventListener('click', () => {
      const target = btn.dataset.target as SaveTarget
      if (!target || !ctx || target === ctx.saveTarget) return
      stashCurrentPropState()
      ctx.saveTarget = target
      previewDone = false
      // Re-determine active property from new target's code
      const newCode = getActiveCode(ctx)
      if (!newCode[activeProperty]) {
        activeProperty = Object.keys(newCode)[0] ?? activeProperty
      }
      updateWindowTitle()
      renderShell()
      loadEditorDoc(newCode[activeProperty] ?? '')
    })
  }

  // Wire property tabs
  for (const tab of document.querySelectorAll<HTMLElement>('.editor-prop-tab')) {
    tab.addEventListener('click', () => {
      const prop = tab.dataset.prop
      if (!prop || prop === activeProperty || !ctx) return
      stashCurrentPropState()
      activeProperty = prop
      previewDone = false
      renderShell()
      const code = getActiveCode(ctx)
      loadEditorDoc(code[prop] ?? '')
    })
  }
}

/** Save the live EditorView's text + cursor + scroll into the per-property
 *  cache so we can restore them when the user comes back to this slot.
 *  Also writes the buffer into ctx so save-target / property switching
 *  doesn't lose typed-but-unsaved work. */
function stashCurrentPropState(): void {
  if (!ctx || !editorView) return
  const text = editorView.state.doc.toString()
  // Keep the in-memory ctx copy in sync so the seg/property toggle's
  // own "save current code to current target" logic still works.
  const currentCode = getActiveCode(ctx)
  currentCode[activeProperty] = text
  const target: SaveTarget | 'extended' = ctx.extended ? 'extended' : ctx.saveTarget
  const sel = editorView.state.selection.main
  const scrollEl = editorView.scrollDOM
  propStateCache.set(propStateKey(target, activeProperty), {
    docText: text,
    selection: { anchor: sel.anchor, head: sel.head },
    scrollTop: scrollEl?.scrollTop ?? 0,
    dirty,
  })
}

/** Look up the stashed state for the active property + target. Used by
 *  createEditor to restore cursor / scroll / dirty after a tab switch. */
function getStashedPropState(): PropEditState | undefined {
  if (!ctx) return undefined
  const target: SaveTarget | 'extended' = ctx.extended ? 'extended' : ctx.saveTarget
  return propStateCache.get(propStateKey(target, activeProperty))
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

  // EC mode covers TWO entry points:
  //   - editing a widget's `.expression` property (activeProperty set
  //     when opened from the side panel)
  //   - the standalone "Extended Code" scratch window (ctx.extended
  //     === true; activeProperty is empty since there's no property
  //     to save back to)
  // Both run Extended Code, so both get the EC language, highlight
  // style, variable tracker, hover docs, type inference, etc.
  // Before this check included ctx.extended, the scratch window had
  // ZERO syntax highlighting + a permanently-empty Vars panel.
  const isEc = activeProperty === 'expression' || (ctx?.extended === true)
  currentIsEc = isEc

  const extensions = [
    // Base
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightActiveLine(),
    drawSelection(),
    bracketMatching(),
    closeBrackets(),
    indentOnInput(),
    // Indent unit + visual tab width = 5 spaces. EC scripts in the
    // BMP Config Studio default to 5-space indentation (and the
    // Architect workflow doc has the same convention), so matching
    // it means copy-pasted EC keeps its alignment when it lands in
    // the editor. `indentUnit` is what indentOnInput / Tab key
    // insert; `tabSize` is how literal `\t` characters render —
    // setting both keeps both forms 5-wide.
    indentUnit.of('     '),
    EditorState.tabSize.of(5),
    history(),
    foldGutter(),
    highlightSelectionMatches(),
    // Two completion sources for EC:
    //   - starExpansion: type `*` inside `.table(`/`.forEach(`/etc.
    //     surfaces the "expand to all properties" snippet.
    //   - extendedCompletions: the existing identifier/method-name
    //     suggestions (and the scaffold completions).
    // starExpansion is listed first so it wins on the rare `*` case.
    autocompletion({ override: isEc ? [starExpansionCompletions, extendedCompletions] : undefined }),
    // `*` doesn't count as an "identifier char" so the autocomplete
    // extension won't auto-activate when typed. Kick it explicitly so
    // the `*`-expansion snippet surfaces immediately.
    isEc ? EditorView.updateListener.of((update) => {
      if (!update.docChanged) return
      let typedStar = false
      update.changes.iterChanges((_a, _b, _c, _d, inserted) => {
        if (inserted.toString().endsWith('*')) typedStar = true
      })
      if (typedStar) startCompletion(update.view)
    }) : [],
    catppuccinMocha,
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
      // F2 rename-all-occurrences removed in v0.20.11 — the
      // identifier-rewrite logic was buggy in EC's tokeniser. Use
      // Ctrl-D (select next occurrence) + multi-cursor edit instead.
      { key: 'Ctrl-d', run: selectNextOccurrence },
      // Preview / Run / Save shortcuts
      { key: 'Ctrl-Enter', run: () => { doPreview(); return true } },
      { key: 'F5', run: () => { doPreview(); return true }, preventDefault: true },
      { key: 'Ctrl-Shift-Enter', run: () => { doRun(); return true } },
      { key: 'Ctrl-s', run: () => { doSave(); return true } },
      // Esc — close the host overlay. CodeMirror's own Esc handlers
      // (search panel close, etc.) run earlier in the keymap chain
      // and return true when they consume the event, so this only
      // fires when the user actually means "close the window".
      {
        key: 'Escape',
        run: () => {
          try { window.parent.postMessage({ type: 'CREV_OVERLAY_CLOSE_PLEASE' }, '*') } catch { /* ignore */ }
          return true
        },
      },
    ]),

    // Cursor position + selection tracking + previewDone gating
    EditorView.updateListener.of(update => {
      if (update.selectionSet || update.docChanged) {
        updateStatusBar(update.view)
        const { from, to } = update.state.selection.main
        const btn = document.getElementById('btn-preview')
        if (btn) { btn.innerHTML = ''; btn.append(svg(ICON_PLAY), from !== to ? ' Preview \u00b7' : ' Preview'); }
      }
      if (update.docChanged) {
        // A target/property switch replaces the whole doc programmatically.
        // That's not a user edit — don't flip dirty, don't reset the
        // preview gate, don't mark the output stale. loadEditorDoc handles
        // dirty/scroll/var-rescan for the swapped-in doc itself.
        if (programmaticDocSwap) return
        if (!dirty) {
          dirty = true
          updateSaveButton()
        }
        // Reset preview gate when code changes
        if (previewDone) {
          previewDone = false
          updateRunButton()
        }
        // Flag the output panel "stale" so the user knows the
        // displayed result no longer matches the editor's code.
        if (!staleAfterPreview && lastMode === 'preview' && lastOutputOk) {
          staleAfterPreview = true
          if (bottomPanelOpen && bottomMode === 'output') renderBottomContent()
        }
        // Line numbers in any pending runtime-error marker are now
        // stale — clear it so the user doesn't chase a squiggle that
        // doesn't point at the real offender anymore.
        clearRuntimeErrors(editorView)
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
      bmpBidDecorator,
      ...varHighlight,
      typeInferenceListener,
      extendedLinter,
      runtimeErrorLinter,
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

  // Initial variable scan — the variableTracker updateListener only
  // fires on docChanged, which isn't true for the first doc we hand
  // EditorView at construction time. Without this prime call the Vars
  // panel stays empty until the user types something.
  // When the property ISN'T EC (HTML / JS / CSS), explicitly wipe the
  // tracked-vars state so the Vars panel doesn't show the previous
  // EC property's variables.
  if (isEc) {
    scanVariables(state.doc)
    scanDocForInferences(state.doc)
  } else {
    clearTrackedVariables()
    clearInferences()
  }

  // Restore the per-property selection + scroll. The doc body is the
  // caller's responsibility (passed in via `code`); we only restore
  // the navigation state on top of it. Skipped when the stash's text
  // diverges from the loaded body (could happen if BMP changed under us).
  //
  // The Code-Search `scrollToLine` overrides the stash for one paint
  // so a user who clicks "L42" in the popup lands on line 42 even if
  // they had previously scrolled the same property elsewhere. The
  // field is then consumed (set back to undefined) so it doesn't keep
  // pulling them back on subsequent property switches.
  const scrollToLine = ctx?.scrollToLine
  if (scrollToLine && scrollToLine > 0) {
    requestAnimationFrame(() => {
      if (!editorView) return
      const doc = editorView.state.doc
      const lineNum = Math.max(1, Math.min(scrollToLine, doc.lines))
      const line = doc.line(lineNum)
      editorView.dispatch({
        selection: { anchor: line.from, head: line.from },
        // `EditorView.scrollIntoView` is a transaction effect; we ask
        // for the matched line to land in the centre so the user sees
        // its context (lines above + below) without having to scroll
        // further on arrival.
        effects: EditorView.scrollIntoView(line.from, { y: 'center' }),
      })
      editorView.focus()
    })
    if (ctx) ctx.scrollToLine = undefined
    dirty = false
  } else {
    const stash = getStashedPropState()
    if (stash && stash.docText === code) {
      dirty = stash.dirty
      const docLen = editorView.state.doc.length
      const a = Math.min(stash.selection.anchor, docLen)
      const hd = Math.min(stash.selection.head, docLen)
      editorView.dispatch({ selection: { anchor: a, head: hd } })
      requestAnimationFrame(() => {
        if (editorView?.scrollDOM) editorView.scrollDOM.scrollTop = stash.scrollTop
      })
    } else {
      dirty = false
    }
  }
  updateSaveButton()
  editorView.focus()
}

/** Load `code` into the editor for a target / property switch.
 *
 *  When the live view already exists and stays in the SAME language family
 *  (EC→EC or plain→plain — true for every instance⇄template switch, since
 *  that's the same property), we swap the document IN PLACE with a single
 *  transaction instead of tearing the view down and rebuilding it. The old
 *  path (`renderShell()` rebuilt the `#cm-container`, then `createEditor`
 *  destroyed + recreated the CodeMirror view, restoring scroll a frame
 *  later via rAF) made the editor visibly reflow and left the cursor a few
 *  pixels off target. An in-place swap keeps the view mounted, so selection
 *  and scroll restore synchronously in the same frame — no flash, no jump.
 *
 *  Falls back to a full `createEditor` only when the language must change
 *  (EC ⇄ HTML/JS need a different extension set) or there's no view yet. */
function loadEditorDoc(code: string): void {
  const isEc = activeProperty === 'expression' || (ctx?.extended === true)
  if (!editorView || isEc !== currentIsEc) {
    createEditor(code)
    return
  }

  const view = editorView
  const stash = getStashedPropState()
  const hasStash = !!(stash && stash.docText === code)
  const docLen = code.length
  const anchor = hasStash ? Math.min(stash!.selection.anchor, docLen) : 0
  const head = hasStash ? Math.min(stash!.selection.head, docLen) : 0

  // Single atomic swap: replace the whole doc + place the cursor. Flagged
  // programmatic so the updateListener doesn't treat it as a user edit.
  // When we have a remembered scroll for this target, suppress CM's own
  // scroll-into-view and restore the exact offset ourselves below (the
  // view kept its layout, so scrollDOM has a real height this same frame —
  // no rAF jump). With no memory, let CM reveal the cursor (lands at the
  // top), which is steadier than poking scrollTop, since a doc-replace
  // makes CM re-anchor the viewport.
  programmaticDocSwap = true
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: code },
    selection: { anchor, head },
    scrollIntoView: !hasStash,
  })
  programmaticDocSwap = false

  if (hasStash && view.scrollDOM) view.scrollDOM.scrollTop = stash!.scrollTop
  dirty = hasStash ? stash!.dirty : false

  // Re-prime the trackers for the new doc, exactly like createEditor does
  // at construction (the updateListener only fires for user edits).
  if (isEc) {
    scanVariables(view.state.doc)
    scanDocForInferences(view.state.doc)
  } else {
    clearTrackedVariables()
    clearInferences()
  }
  clearRuntimeErrors(view)
  updateSaveButton()
  updateStatusBar(view)
  view.focus()
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
      clearRuntimeErrors(editorView)
    } else {
      const errText = response.error ?? response.log ?? 'Execution failed'
      showOutput(errText, false)
      // Paint an inline marker if BMP told us where to look.
      // Parser tries both `response.error` and `response.log` since
      // structural errors land in different fields.
      const loc = parseEcErrorLocation(errText) ?? parseEcErrorLocation(response.log ?? '')
      if (loc && editorView) setRuntimeError(editorView, loc.line, loc.column, errText.split('\n')[0])
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
  updateRunButton()

  // Refresh history in background
  sendRequest({ type: 'GET_SCRIPT_HISTORY' }).then(r => {
    if (r?.type === 'SCRIPT_HISTORY_DATA') historyEntries = r.entries
  })
}

/** Update Run button disabled state and tooltip */
function updateRunButton() {
  // The split-button chevron lights up subtly when Execute is armed.
  // We track this via a class so the user gets a passive cue without
  // a separate top-level button.
  const chev = document.getElementById('btn-preview-more')
  if (chev) chev.classList.toggle('editor-split-chev--armed', previewDone)
}

/** Update Save button disabled state and dirty styling */
function updateSaveButton() {
  const btn = document.getElementById('btn-save') as HTMLButtonElement | null
  if (btn) {
    btn.disabled = !dirty
    btn.title = dirty ? `Save (${KBD_MOD}+S)` : 'No changes to save'
    btn.classList.toggle('btn-success', dirty)
    btn.classList.toggle('btn-ghost', !dirty)
  }
  // Discard is dirty-gated too — only it was rendered once at boot
  // with `disabled: !dirty` and nothing kept it in sync as the user
  // typed. Sync both buttons from the same place so a future
  // dirty-tracking change can't drift them apart again.
  const discardBtn = document.getElementById('btn-discard') as HTMLButtonElement | null
  if (discardBtn) {
    discardBtn.disabled = !dirty
    discardBtn.title = dirty ? 'Revert to the saved BMP value (discards your edits)' : 'Nothing to discard'
  }
}

/** Revert the editor to the BMP-loaded value for the active property.
 *  Confirms when dirty so an accidental click can't blow away work.
 *  The "saved" value comes from ctx — the snapshot we got at editor
 *  boot. After save, that snapshot was already updated to the new
 *  value, so Discard rolls back to the most recent SUCCESSFUL save. */
/** Show or hide the split-button's overflow menu (Execute action). */
function toggleRunMenu(): void {
  const existing = document.getElementById('run-menu')
  if (existing) { existing.remove(); return }
  const anchor = document.getElementById('btn-preview-more')
  if (!anchor) return
  anchor.setAttribute('aria-expanded', 'true')
  const rect = anchor.getBoundingClientRect()
  const menu = document.createElement('div')
  menu.id = 'run-menu'
  menu.className = 'editor-run-menu'
  menu.role = 'menu'
  menu.style.top = `${rect.bottom + 4}px`
  menu.style.left = `${rect.left - 120}px`
  const item = h('button', {
    class: `editor-run-menu-item${previewDone ? '' : ' disabled'}`,
    role: 'menuitem',
    title: previewDone ? `Execute the previewed code (${KBD_MOD}+Shift+Enter)` : 'Preview successfully first to unlock',
    onClick: () => {
      menu.remove()
      anchor.setAttribute('aria-expanded', 'false')
      if (previewDone) doRun()
    },
  },
    svg(ICON_LIGHTNING),
    h('span', { class: 'editor-run-menu-label' }, ' Execute'),
    h('kbd', null, `${KBD_MOD}⇧↵`),
  )
  menu.appendChild(item)
  document.body.appendChild(menu)
  // Dismiss on outside click + Esc. Self-cleans on close.
  const dismiss = (e: Event) => {
    if (e instanceof KeyboardEvent && e.key !== 'Escape') return
    if (e instanceof MouseEvent && (e.target === menu || menu.contains(e.target as Node))) return
    menu.remove()
    anchor.setAttribute('aria-expanded', 'false')
    document.removeEventListener('mousedown', dismiss, true)
    document.removeEventListener('keydown', dismiss, true)
  }
  setTimeout(() => {
    document.addEventListener('mousedown', dismiss, true)
    document.addEventListener('keydown', dismiss, true)
  }, 0)
}

async function doDiscard(): Promise<void> {
  if (!ctx || !editorView || !dirty) return
  const target: SaveTarget = ctx.saveTarget
  const original = originalCode.get(propStateKey(target, activeProperty)) ?? ''
  const ok = await confirmModal({
    title: 'Discard changes?',
    body: `Revert "${activeProperty}" to the value BMP last reported. Your edits will be lost.`,
    confirmLabel: 'Discard',
    confirmVariant: 'danger',
  })
  if (!ok) return
  editorView.dispatch({
    changes: { from: 0, to: editorView.state.doc.length, insert: original },
  })
  // Also bring ctx's buffer back in sync — otherwise a subsequent
  // property switch would re-stash the now-discarded edits.
  const code = getActiveCode(ctx)
  code[activeProperty] = original
  propStateCache.delete(propStateKey(target, activeProperty))
  dirty = false
  staleAfterPreview = false
  previewDone = false
  updateSaveButton()
  updateRunButton()
  editorView.focus()
}

async function doSave() {
  if (!editorView || !ctx) return
  const code = editorView.state.doc.toString()

  const target = getSaveTarget(ctx)
  const targetLabel = ctx.saveTarget === 'template' && ctx.template
    ? `template "${formatLabel(target.identity, 'full')}"`
    : `instance "${formatLabel(target.identity, 'full')}"`

  const confirmed = await confirmModal({
    title: `Save ${activeProperty}`,
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
      property: activeProperty,
      value: code,
    })
    if (response?.type === 'SAVE_RESULT' && response.ok) {
      showOutput(`Saved to ${targetLabel}`, true)
      dirty = false
      lastSavedAt = Date.now()
      // Fade the Save → Saved → Save label back after ~4s. Re-render
      // the action toolbar so the button reverts to its default look
      // without flashing the user's eyes mid-edit.
      if (saveLabelTimer) clearTimeout(saveLabelTimer)
      saveLabelTimer = setTimeout(() => { renderShell() }, 4200)
      const activeCodeMap = getActiveCode(ctx)
      activeCodeMap[activeProperty] = code
      // Refresh the "BMP knows about this" snapshot so Discard reverts
      // to what just landed on the server, not the editor's pre-save
      // value.
      originalCode.set(propStateKey(ctx.saveTarget, activeProperty), code)
      const rid = location.hash.slice(1)
      if (rid) {
        await chrome.storage.local.set({ [`crev_editor_ctx_${rid}`]: ctx })
      }
    } else if (response?.type === 'SAVE_RESULT') {
      // Explicit failure — the SW returned a SAVE_RESULT with ok=false. The
      // error string is what BMP / the bridge reported; surface it verbatim.
      const detail = response.error ?? '(no error message)'
      // eslint-disable-next-line no-console
      console.error('[CREV] SAVE_PROPERTY failed', { rid: target.rid, property: activeProperty, response })
      showOutput(`Save failed: ${detail}`, false)
    } else {
      // No SAVE_RESULT came back. In MV3 this almost always means the SW was
      // unloaded mid-request and the message port closed before the response
      // could be sent. BMP may or may not have written the value. Surface
      // that ambiguity so the user knows to verify rather than blindly retry.
      // eslint-disable-next-line no-console
      console.warn('[CREV] SAVE_PROPERTY: no response (likely SW unloaded). BMP may have saved successfully — verify before retrying.', { rid: target.rid, property: activeProperty, response })
      showOutput('No response from service worker. BMP may have saved. Refresh the object pane to verify before retrying.', false)
    }
  } finally {
    if (btn) { delete btn.dataset.saving }
    updateSaveButton()
  }
}

/** Copy text to clipboard and briefly flash a button's content with a check icon. */
function flashCopy(btn: HTMLElement, text: string, restore: () => void) {
  navigator.clipboard.writeText(text).catch(() => {})
  const prev = btn.innerHTML
  btn.innerHTML = ''
  btn.append(svg(ICON_CHECK))
  setTimeout(() => { btn.innerHTML = prev; restore() }, 900)
}

// ── Modal ───────────────────────────────────────────────────────

interface ConfirmOpts {
  title: string;
  body: string;
  confirmLabel?: string;
  cancelLabel?: string;
  confirmVariant?: 'accent' | 'danger' | 'success';
}

/** In-app confirmation modal. Replaces window.confirm() — native confirm in
 *  iframes can be styled poorly by some BMP themes and is suppressed by
 *  SPA navigation. Returns Promise<boolean>. */
function confirmModal(opts: ConfirmOpts): Promise<boolean> {
  return new Promise(resolve => {
    const variant = opts.confirmVariant ?? 'accent'
    let resolved = false
    const settle = (v: boolean) => {
      if (resolved) return
      resolved = true
      document.removeEventListener('keydown', onKey, true)
      backdrop.remove()
      resolve(v)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); settle(false) }
      else if (e.key === 'Enter') { e.stopPropagation(); settle(true) }
    }
    const cancelBtn = h('button', {
      class: 'btn',
      onClick: () => settle(false),
    }, opts.cancelLabel ?? 'Cancel')
    const confirmBtn = h('button', {
      class: `btn btn-${variant}`,
      onClick: () => settle(true),
    }, opts.confirmLabel ?? 'OK')
    const dialog = h('div', { class: 'editor-modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'editor-modal-title' },
      h('h2', { class: 'editor-modal-title', id: 'editor-modal-title' }, opts.title),
      h('p', { class: 'editor-modal-body' }, opts.body),
      h('div', { class: 'editor-modal-actions' }, cancelBtn, confirmBtn),
    )
    const backdrop = h('div', {
      class: 'editor-modal-backdrop',
      onClick: (e: MouseEvent) => { if (e.target === backdrop) settle(false) },
    }, dialog)
    document.body.appendChild(backdrop)
    document.addEventListener('keydown', onKey, true)
    requestAnimationFrame(() => confirmBtn.focus())
  })
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
  const setActive = (id: string, mode: typeof bottomMode) => {
    const el = document.getElementById(id)
    if (el) el.classList.toggle('active', bottomPanelOpen && bottomMode === mode)
  }
  setActive('btn-output-tab', 'output')
  setActive('btn-vars', 'vars')
  setActive('btn-history', 'history')
}

function renderBottomContent() {
  const container = document.getElementById('bottom-panel-content')
  if (!container) return

  if (bottomMode === 'output') {
    const modeLabel = lastMode === 'save' ? 'Saved' : lastMode === 'execute' ? 'Executed' : 'Preview'
    const cls = lastOutputOk ? 'ok' : 'error'
    const outputContent = lastOutputOk
      ? renderEcOutput(lastOutputText, tablePreview, decodePreview)
      : h('div', { class: 'editor-output-content error' }, lastOutputText)
    renderDom(container,
      h('div', { class: 'editor-output-header' },
        h('span', { class: `editor-output-pill ${cls}` },
          svg(lastOutputOk ? ICON_CHECK : ICON_X),
          h('span', null, ` ${modeLabel}`),
          lastDuration != null ? h('span', {
            class: 'editor-output-pill-dur',
            // Round-trip = wall-clock incl. SW + network; BMP = server-side
            // compute. Spelled out in the tooltip, compact in the pill.
            title: lastBmpMs != null
              ? `${lastDuration}ms round-trip · ${lastBmpMs}ms BMP compute`
              : `${lastDuration}ms round-trip`,
          }, lastBmpMs != null ? `${lastDuration}ms · ${lastBmpMs}ms BMP` : `${lastDuration}ms`) : null,
        ),
        // "Stale" pill when the editor's code has diverged from what
        // this output reflects — keeps the user from acting on results
        // that no longer match the buffer.
        staleAfterPreview
          ? h('span', { class: 'editor-output-stale', title: 'You edited the code after this preview ran' }, '⚠ stale. Preview again')
          : null,
        h('div', { class: 'editor-output-header-spacer' }),
        // Output-specific controls moved here from the bottom bar —
        // decode + table operate on THIS panel's content, copy snapshots
        // THIS panel's text. Wrap stayed in the editor toolbar where
        // the line-wrapping it controls actually lives.
        h('button', {
          class: `btn-micro${decodePreview ? ' active' : ''}`,
          title: 'Decode escape sequences (\\n, \\t, \\", \\\\)',
          onClick: toggleDecode,
        }, h('span', { class: 'btn-micro-label' }, '\\n')),
        h('button', {
          class: `btn-micro${tablePreview ? ' active' : ''}`,
          title: 'Toggle table rendering for | -separated rows',
          onClick: toggleTable,
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
        h('button', { class: 'btn-micro', title: 'Close', onClick: hideBottomPanel }, svg(ICON_X)),
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
              if (!editorView) return
              // Replacing the editor doc nukes whatever the user has
              // typed. Confirm when there's unsaved work to avoid
              // silent data loss — this exact path was the #1 bug in
              // the editor audit.
              if (dirty) {
                const ok = await confirmModal({
                  title: 'Discard current changes?',
                  body: 'Loading from history replaces the editor content. Unsaved edits will be lost.',
                  confirmLabel: 'Load from history',
                  confirmVariant: 'danger',
                })
                if (!ok) return
              }
              editorView.dispatch({ changes: { from: 0, to: editorView.state.doc.length, insert: e.code } })
              editorView.focus()
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

  renderDom(container,
    h('div', { class: 'editor-vars-split' },
      renderVarsList(vars, inferences, selected),
      renderVarsProps(selected, inferences),
    ),
  )

  // Restore the props list scroll on the newly-rendered element.
  const nextList = container.querySelector<HTMLElement>('.editor-vars-props-list')
  if (nextList && varsPropsScrollTop > 0) nextList.scrollTop = varsPropsScrollTop

  // Filter input was recreated by the render — restore focus + caret
  // so the user can type continuously. Only fires when the previous
  // event was a filter edit (varsFilterRefocus is non-null).
  if (varsFilterRefocus != null) {
    const input = document.getElementById('vars-filter-input') as HTMLInputElement | null
    if (input) {
      input.focus()
      try { input.setSelectionRange(varsFilterRefocus, varsFilterRefocus) } catch { /* not all browsers */ }
    }
    varsFilterRefocus = null
  }
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
          if (editorView) {
            const line = editorView.state.doc.line(Math.min(v.line, editorView.state.doc.lines))
            editorView.dispatch({ selection: { anchor: line.from }, scrollIntoView: true })
            editorView.focus()
          }
        },
        onMouseenter: () => { if (editorView) setHighlightedVar(editorView, v.name) },
        onMouseleave: () => { if (editorView) setHighlightedVar(editorView, null) },
        title: `${v.name} := ${v.rhs} (line ${v.line}). Double-click to jump`,
      },
        h('span', { class: 'editor-vars-name' }, v.name),
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
      h('input', {
        class: 'editor-vars-props-filter',
        id: 'vars-filter-input',
        placeholder: 'Filter properties\u2026',
        value: varsFilter,
        // Live-update \u2014 re-render below recreates this element, so we
        // mark it for focus-restoration so the user can keep typing
        // without losing the caret position.
        onInput: (e: Event) => {
          const el = e.currentTarget as HTMLInputElement
          varsFilter = el.value
          varsFilterRefocus = el.selectionStart ?? el.value.length
          renderBottomContent()
        },
      }),
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
        : visible.map(p =>
          h('div', {
            class: `editor-vars-prop-row${p.systemobject ? ' editor-vars-prop-row--system' : ''}`,
            // Click inserts the bare accessor at the cursor (no leading
            // dot \u2014 the user adds the dot themselves). If the user had
            // text selected, the selection is replaced.
            onClick: () => insertAtCursor(p.accessor),
            title: `${p.accessor} \u00b7 ${p.label} \u00b7 ${p.configClass}. Click to insert ${p.accessor} at cursor`,
          },
            h('span', { class: 'editor-vars-prop-accessor' }, p.accessor),
            h('span', { class: 'editor-vars-prop-label' }, p.label),
            h('span', { class: `editor-vars-prop-kind editor-vars-prop-kind--${kindFamily(p.configClass)}` }, kindShort(p.configClass)),
          ),
        ),
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
  if (!editorView) return
  const { from, to } = editorView.state.selection.main
  editorView.dispatch({
    changes: { from, to, insert: text },
    selection: { anchor: from + text.length },
  })
  editorView.focus()
}

function doClear() {
  lastOutputText = ''
  lastOutputOk = true
  lastMode = null
  lastDuration = null
  lastBmpMs = null
  previewDone = false
  updateRunButton()
  if (editorView) {
    editorView.dispatch({ changes: { from: 0, to: editorView.state.doc.length, insert: '' } })
    editorView.focus()
  }
  hideBottomPanel()
  dirty = false
  updateSaveButton()
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
  if (btn) btn.className = `btn-micro${wrapLines ? ' active' : ''}`
  chrome.storage.local.set({ crev_editor_wrap: wrapLines }).catch(() => {})
}

function toggleTable() {
  tablePreview = !tablePreview
  const btn = document.getElementById('btn-table')
  if (btn) btn.className = `btn-micro${tablePreview ? ' active' : ''}`
  if (bottomPanelOpen && bottomMode === 'output') renderBottomContent()
  chrome.storage.local.set({ crev_editor_table: tablePreview }).catch(() => {})
}

function toggleDecode() {
  decodePreview = !decodePreview
  const btn = document.getElementById('btn-decode')
  if (btn) btn.className = `btn-micro${decodePreview ? ' active' : ''}`
  if (bottomPanelOpen && bottomMode === 'output') renderBottomContent()
  chrome.storage.local.set({ crev_editor_decode: decodePreview }).catch(() => {})
}

function toggleOutput() {
  if (bottomPanelOpen && bottomMode === 'output') {
    hideBottomPanel()
  } else {
    bottomMode = 'output'
    bottomPanelOpen = true
    openBottomPanel()
    renderBottomContent()
  }
}

function loadHistory() {
  sendRequest({ type: 'GET_SCRIPT_HISTORY' }).then(response => {
    if (response?.type === 'SCRIPT_HISTORY_DATA') historyEntries = response.entries
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
  let pointerId: number | null = null

  // Pointer events instead of mouse/* — gives us touch + stylus
  // support and matches the layout-size + frame-overlay handlers
  // elsewhere in the extension. setPointerCapture means we don't
  // need document-level move listeners.
  function onMove(e: PointerEvent) {
    const delta = startY - e.clientY
    const newHeight = Math.max(60, Math.min(window.innerHeight * 0.8, startHeight + delta))
    outputHeight = newHeight
    const panel = document.getElementById('bottom-panel')
    if (panel) panel.style.height = `${newHeight}px`
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

installCloseHandshake(async () => {
  if (!dirty) return true
  return confirmModal({
    title: 'Discard unsaved changes?',
    body: 'This editor has unsaved changes. Close anyway?',
    confirmLabel: 'Discard',
    confirmVariant: 'danger',
  })
})

// Host-page navigation guard. The overlay iframe dies with the page; without
// this, an unsaved EC draft would be silently destroyed when the user clicks
// a link in BMP. The browser's native prompt is the only reliable signal here
// — modals would race the navigation.
window.addEventListener('beforeunload', (e) => {
  if (!dirty) return
  e.preventDefault()
  // Some browsers ignore returnValue but still honor preventDefault.
  e.returnValue = ''
})

// Window-level F5 fallback: when focus has wandered out of the CodeMirror
// editor (the user clicked a button, the toolbar, an empty area…), the
// editor's keymap doesn't see F5 and the browser would refresh the page,
// destroying any unsaved draft. Catch F5 globally and route it through
// the same `doPreview()` the CM keymap uses.
window.addEventListener('keydown', (e) => {
  if (e.key !== 'F5' || e.ctrlKey || e.shiftKey || e.altKey || e.metaKey) return
  e.preventDefault()
  doPreview()
}, true)

// ── Launch ───────────────────────────────────────────────────────

init()
