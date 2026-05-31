/**
 * EC editor — Book popover.
 *
 * Quick-lookup overlay anchored under the book icon (next to the `?`
 * help button in the EC editor toolbar). Three tabs:
 *
 *   1. Namespaces — prefix → BMP type lookup (`cecme → CeControlMeasure`).
 *      Static data, sourced once from `help()` and committed to this
 *      file so the popover never pings BMP at runtime. Filter input
 *      narrows the list as the user types. Click a row → copies the
 *      prefix to clipboard.
 *
 *   2. EC syntax cheat — static one-page reference: operators,
 *      special values, control flow, common methods. Curated for
 *      "I forget the syntax" moments.
 *
 *   3. Snippets — 5 copy-only EC patterns, syntax-highlighted using
 *      the shared ec-format tokeniser so they read the same as the
 *      editor surface itself.
 *
 * Esc / outside-click dismiss. Positioning is shared with the `?`
 * help popover via `lib/popover-anchor.ts`.
 */

import { h } from '../lib/dom'
import { anchorPopover } from '../lib/popover-anchor'
import { tokenizeEcLine, renderTokens } from '../lib/ec-format'

type TabKey = 'namespaces' | 'cheat' | 'snippets'

/** Side-channel into the editor for "click to insert at cursor"
 *  flows. The Book popover never imports the editor module directly
 *  (that would pull EC editor extensions into anything that wants the
 *  Book) — the editor wires this on its way to opening us. */
export interface BookHandlers {
  /** Insert `text` at the editor's current selection / cursor. The
   *  editor is expected to also keep focus so the user can continue
   *  typing. Returns true if the insertion happened. */
  insertAtCursor: (text: string) => boolean
}

/** One ID-space prefix row. A single prefix can map to several BMP
 *  types (e.g. `t` → TemplateCategory, ActionPlan, SharedWeb) so
 *  `types` is a list. `group` drives the section break in the
 *  rendered list. */
interface NamespaceRow {
  prefix: string
  types: string[]
  group: 'platform' | 'enterprise'
}

/** Curated from a single `help()` run against the Hetzner workspace
 *  (commit message in git history references the run). The set is
 *  install-time stable in BMP — adding a new prefix requires a
 *  module install + restart, which doesn't happen on a typical
 *  developer's box without intervention. If this drifts, the user
 *  notices a missing prefix and we update the constant. */
const NAMESPACES: NamespaceRow[] = [
  // Platform — short canonical prefixes.
  { prefix: 'root', group: 'platform',   types: ['root'] },
  { prefix: 't',    group: 'platform',   types: ['TemplateCategory', 'ActionPlan', 'SharedWeb'] },
  { prefix: 'o',    group: 'platform',   types: ['Organisation'] },
  { prefix: 'n',    group: 'platform',   types: ['Node'] },
  { prefix: 'nt',   group: 'platform',   types: ['NodeType'] },
  { prefix: 'u',    group: 'platform',   types: ['User', 'Unknown'] },
  { prefix: 'g',    group: 'platform',   types: ['Group'] },
  { prefix: 'p',    group: 'platform',   types: ['CustomPeriod'] },
  { prefix: 'r',    group: 'platform',   types: ['ExternalResource'] },
  { prefix: 'd',    group: 'platform',   types: ['Defaults'] },
  { prefix: 'c',    group: 'platform',   types: ['ClassConfig'] },
  { prefix: 'k',    group: 'platform',   types: ['CustomProperty'] },
  { prefix: 'ap',   group: 'platform',   types: ['AccessProfile'] },
  { prefix: 'ndi',  group: 'platform',   types: ['NodeDataImport'] },

  // Enterprise / GRC modules.
  { prefix: 'ceven', group: 'enterprise', types: ['CeVendor'] },
  { prefix: 'cetas', group: 'enterprise', types: ['CeTask'] },
  { prefix: 'cecom', group: 'enterprise', types: ['CeComment'] },
  { prefix: 'ceinc', group: 'enterprise', types: ['CeIncident'] },
  { prefix: 'cepro', group: 'enterprise', types: ['CeProcedure'] },
  { prefix: 'cepol', group: 'enterprise', types: ['CePolicy'] },
  { prefix: 'cecme', group: 'enterprise', types: ['CeControlMeasure'] },
  { prefix: 'ceiss', group: 'enterprise', types: ['CeIssue'] },
  { prefix: 'ceass', group: 'enterprise', types: ['CeAsset'] },
  { prefix: 'ceser', group: 'enterprise', types: ['CeService'] },
  { prefix: 'cecot', group: 'enterprise', types: ['CeContract'] },
  { prefix: 'ceprj', group: 'enterprise', types: ['CeProject'] },
  { prefix: 'cereg', group: 'enterprise', types: ['CeRegulation'] },
  { prefix: 'cecor', group: 'enterprise', types: ['CeComplianceRequirement'] },
  { prefix: 'ceind', group: 'enterprise', types: ['CeIndicator'] },
  { prefix: 'ceatt', group: 'enterprise', types: ['CeAttachment'] },
  { prefix: 'ceras', group: 'enterprise', types: ['CeRiskAssessment'] },
  { prefix: 'acpol', group: 'enterprise', types: ['AccessPolicy'] },
  { prefix: 'role',  group: 'enterprise', types: ['Role'] },
  { prefix: 'ceprd', group: 'enterprise', types: ['CeProduct'] },
  { prefix: 'sa',    group: 'enterprise', types: ['ServiceAccount'] },
  { prefix: 'cepsc', group: 'enterprise', types: ['CePreScreening'] },
  { prefix: 'ceprv', group: 'enterprise', types: ['CePrivacy'] },
  { prefix: 'cewfl', group: 'enterprise', types: ['CeWorkflow'] },
  { prefix: 'cedis', group: 'enterprise', types: ['CeDistribution'] },
  { prefix: 'ceinq', group: 'enterprise', types: ['CeInquiry'] },
  { prefix: 'ceqst', group: 'enterprise', types: ['CeQuestionnaire'] },
  { prefix: 'cedpi', group: 'enterprise', types: ['CeDpia'] },
  { prefix: 'cetia', group: 'enterprise', types: ['CeTia'] },
  { prefix: 'ceasa', group: 'enterprise', types: ['CeAssuranceActivity'] },
  { prefix: 'fas',   group: 'enterprise', types: ['FormsAndSurveys'] },
  { prefix: 'ba',    group: 'enterprise', types: ['BusinessApplication'] },
]

// ── Session state ─────────────────────────────────────────────────

/** Which tab was open last; restored across re-opens of the popover. */
let lastTab: TabKey = 'namespaces'

/** Substring filter — Namespaces tab only (the cheat and snippets tabs
 *  are short enough to scan without filtering). */
let nsFilter = ''

/** Track every setTimeout we schedule for fade-out animations so we
 *  can cancel them on close. Without this, a Copy click followed by
 *  fast popover dismissal would leave timers running against detached
 *  DOM nodes — no crash but small garbage. */
const pendingTimers = new Set<ReturnType<typeof setTimeout>>()

/** Tracked timer for the single live banner. Re-flashing replaces the
 *  banner DOM but used to leave the old timer running until expiry.
 *  Stored here so the next flash cancels the previous timer first. */
let bannerTimer: ReturnType<typeof setTimeout> | null = null

const POPOVER_ID = 'editor-book-popover'

/** Handlers passed in by the editor on open. Captured into a module
 *  ref so the namespace-click handler doesn't have to thread it
 *  through every renderXxx. Cleared on `closePopover`. */
let handlers: BookHandlers | null = null

// ── Public entry ──────────────────────────────────────────────────

/** Open the Book popover anchored under `anchor`. Toggles closed if
 *  already open. `bookHandlers` carries the side channel into the
 *  editor (currently just `insertAtCursor`). */
export function showBookPopover(anchor: HTMLElement, bookHandlers: BookHandlers): void {
  const existing = document.getElementById(POPOVER_ID)
  if (existing) { closePopover(existing); return }

  handlers = bookHandlers

  const popover = h('div', {
    id: POPOVER_ID,
    class: 'editor-book-popover',
    role: 'dialog',
    'aria-label': 'EC quick reference',
    style: 'top:-9999px; left:-9999px;',
  })
  document.body.appendChild(popover)
  renderShell(popover)
  anchorPopover(popover, anchor)

  // Auto-focus the filter input when we open on the Namespaces tab —
  // the typical flow is "open book → type a few letters → click row".
  // Skipping the manual click-into-filter trims one step.
  if (lastTab === 'namespaces') {
    popover.querySelector<HTMLInputElement>('.editor-book-filter-input')?.focus()
  }

  // Defer the global dismiss listener install so the SAME click that
  // opened us doesn't immediately close us.
  const onMouseDown = (e: MouseEvent) => {
    if (popover.contains(e.target as Node)) return
    closePopover(popover)
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') closePopover(popover)
  }
  setTimeout(() => {
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKey)
  }, 0)
  // Stash the listeners on the element so closePopover can detach them.
  ;(popover as HTMLElement & { _crevCleanup?: () => void })._crevCleanup = () => {
    document.removeEventListener('mousedown', onMouseDown)
    document.removeEventListener('keydown', onKey)
  }
}

function closePopover(popover: HTMLElement): void {
  // Clear any in-flight flash timers so they don't fire against the
  // detached popover.
  for (const t of pendingTimers) clearTimeout(t)
  pendingTimers.clear()
  if (bannerTimer) { clearTimeout(bannerTimer); bannerTimer = null }

  ;(popover as HTMLElement & { _crevCleanup?: () => void })._crevCleanup?.()
  popover.remove()
  handlers = null
}

// ── Shell + body re-render ───────────────────────────────────────

/** Full shell render — tabs + body. Called once on open and on tab
 *  switch. Filter keystrokes go through `rerenderBody` instead so
 *  scroll position is preserved on the unchanged shell.
 *
 *  No header ("EC quick reference" title) and no footer ("Press Esc
 *  to close…") — both ate vertical space without telling the user
 *  anything they couldn't infer (Esc-to-close is universal popover
 *  behaviour; the popover's identity is obvious from its anchor +
 *  content). */
function renderShell(popover: HTMLElement): void {
  popover.innerHTML = ''
  popover.appendChild(renderTabs(popover))
  popover.appendChild(renderBody(popover))
}

function rerenderBody(popover: HTMLElement): void {
  const oldBody = popover.querySelector('.editor-book-body')
  if (!oldBody) return
  oldBody.replaceWith(renderBody(popover))
}

function renderTabs(popover: HTMLElement): HTMLElement {
  const TABS: Array<{ key: TabKey; label: string }> = [
    { key: 'namespaces', label: 'Namespaces' },
    { key: 'cheat',      label: 'EC cheat' },
    { key: 'snippets',   label: 'Snippets' },
  ]
  return h('div', { class: 'editor-book-tabs', role: 'tablist' },
    ...TABS.map(t =>
      h('button', {
        class: `editor-book-tab${lastTab === t.key ? ' active' : ''}`,
        role: 'tab',
        'aria-selected': lastTab === t.key ? 'true' : 'false',
        onClick: () => {
          lastTab = t.key
          renderShell(popover)
          // Match the on-open behaviour: switching INTO Namespaces
          // auto-focuses the filter so the user can start typing
          // immediately without a second click.
          if (t.key === 'namespaces') {
            popover.querySelector<HTMLInputElement>('.editor-book-filter-input')?.focus()
          }
        },
      }, t.label),
    ),
  )
}

function renderBody(popover: HTMLElement): HTMLElement {
  if (lastTab === 'namespaces') return renderNamespacesTab(popover)
  if (lastTab === 'cheat')      return renderCheatTab()
  return renderSnippetsTab()
}

// ── Namespaces tab ─────────────────────────────────────────────────

function renderNamespacesTab(popover: HTMLElement): HTMLElement {
  const body = h('div', { class: 'editor-book-body editor-book-body--namespaces' })

  body.appendChild(renderFilterInput(popover))

  const q = nsFilter.trim().toLowerCase()
  const matches = q
    ? NAMESPACES.filter(r =>
        r.prefix.toLowerCase().includes(q) ||
        r.types.some(t => t.toLowerCase().includes(q)),
      )
    : NAMESPACES

  if (matches.length === 0) {
    body.appendChild(h('div', { class: 'editor-book-empty' },
      `No matches for "${nsFilter}". `,
      h('button', {
        class: 'editor-book-link',
        onClick: () => { nsFilter = ''; rerenderBody(popover) },
      }, 'Clear filter'),
    ))
    return body
  }

  const platform = matches.filter(r => r.group === 'platform')
  const enterprise = matches.filter(r => r.group === 'enterprise')

  if (platform.length > 0) {
    body.appendChild(h('div', { class: 'editor-book-section-title' }, 'Platform prefixes'))
    body.appendChild(renderNamespaceList(platform, popover))
  }
  if (enterprise.length > 0) {
    body.appendChild(h('div', { class: 'editor-book-section-title' }, 'Enterprise / GRC'))
    body.appendChild(renderNamespaceList(enterprise, popover))
  }

  body.appendChild(h('div', { class: 'editor-book-meta' },
    h('span', null, `${NAMESPACES.length} prefixes`),
    h('span', { class: 'editor-book-meta-hint' }, 'Click prefix or type name to insert'),
  ))

  return body
}

function renderNamespaceList(rows: NamespaceRow[], popover: HTMLElement): HTMLElement {
  return h('table', { class: 'editor-book-ns-table' },
    ...rows.map(r => {
      const prefixToken = `${r.prefix}.`
      // Each side of the row is independently clickable. The PREFIX
      // cell inserts `prefix.` (i.e. `cecme.`) — the lookup syntax.
      // Each TYPE name is its own click target inserting the
      // PascalCase class name (i.e. `CeControlMeasure`) — the
      // SELECT/.add(T) syntax. Splitting them lets the user grab
      // whichever side they need without typing the rest by hand.
      return h('tr', { class: 'editor-book-ns-row' },
        h('td', { class: 'editor-book-ns-prefix editor-book-ns-clickable' },
          h('span', {
            class: 'editor-book-ns-token',
            onClick: () => insertAndCopy(popover, prefixToken),
          }, r.prefix),
        ),
        h('td', { class: 'editor-book-ns-arrow' }, '→'),
        h('td', { class: 'editor-book-ns-types editor-book-ns-clickable' },
          // Each type name is its own span — independently clickable.
          // Joined by " · " text nodes so the visual reads as a list
          // but only the type names highlight on hover.
          ...interleave(
            r.types.map(t =>
              h('span', {
                class: 'editor-book-ns-token',
                onClick: () => insertAndCopy(popover, t),
              }, t),
            ),
            ' · ',
          ),
        ),
      )
    }),
  )
}

/** Insert `token` at the editor cursor AND copy it to the clipboard.
 *  Single handler for both clickable cells in a namespace row, so
 *  the success / failure flash text is consistent. */
function insertAndCopy(popover: HTMLElement, token: string): void {
  const inserted = handlers?.insertAtCursor(token) ?? false
  void copyText(token).then(copied => {
    const msg = inserted && copied ? `Inserted "${token}" + copied`
              : inserted            ? `Inserted "${token}"`
              : copied              ? `Copied "${token}"`
              :                       'Action failed'
    flashBanner(popover, msg, inserted || copied)
  })
}

/** Interleave a separator between array items: `[a, b, c] → [a, sep,
 *  b, sep, c]`. Used to join clickable type-name spans with non-
 *  clickable text nodes. */
function interleave<T>(items: T[], sep: string): (T | string)[] {
  const out: (T | string)[] = []
  for (let i = 0; i < items.length; i++) {
    if (i > 0) out.push(sep)
    out.push(items[i])
  }
  return out
}

// ── EC cheat tab ───────────────────────────────────────────────────

function renderCheatTab(): HTMLElement {
  const groups: Array<{ title: string; rows: Array<[string, string]> }> = [
    {
      title: 'Assignment & operators',
      rows: [
        ['_v := x',         'Assign (NOT `=`)'],
        ['_list :+ _x',     'Append to list (NOT `+=`)'],
        ['=  !=  <  >  <=  >=  <>', 'Compare'],
        ['+  -  *  /  %',   'Arithmetic'],
        ['AND  OR  NOT',    'Logical (uppercase, named)'],
        ['NOT IN  NOT CONTAINS', 'Negated set ops'],
      ],
    },
    {
      title: 'Constants & context',
      rows: [
        ['MISSING',       'Null-ish. Use `.whenMissing(default)`'],
        ['TRUE  FALSE',   'Booleans'],
        ['today  BOP  EOP', 'Today + period start/end'],
        ['root',           'Workspace root (categories live here)'],
        ['this  self',    'Action / forEach context bindings'],
        ['this.object',   'Currently rendered object (Action context)'],
      ],
    },
    {
      title: 'Control flow',
      rows: [
        ['IF cond THEN … ELSE … ENDIF', 'Block: ELSE mandatory'],
        ['(IF cond THEN x ELSE y ENDIF)', 'Paren-wrap to use IF as an expression on RHS'],
        ['list.forEach(_o:  …)', 'Iterate: COLON, not `=>`'],
      ],
    },
    {
      title: 'SELECT / navigation',
      rows: [
        ['SELECT CeIssue', 'List<CeIssue>: case-insensitive type name'],
        ['SELECT CeIssue FROM root WHERE …', 'Scoped + filtered'],
        ['_xs.filter(name != "")', 'Filter (NO colon in filter)'],
        ['_xs.first()  _xs.last()', 'Scalar collapse'],
        ['_xs.size()  _xs.indexOf(_x)', 'Cardinality + position'],
        ['_o.children(CeIssue)', 'Typed direct children'],
        ['_o.descendants(CeIssue)', 'Recursive'],
      ],
    },
    {
      title: 'Read vs evaluate',
      rows: [
        ['t.calc.expression',      'EVALUATES the EC code in calc.expression'],
        ['output(t.calc.expression)', 'Returns the SOURCE TEXT as a string'],
        ['_o.name.whenMissing("")','Safe property read with fallback'],
        ['_o.linkedTo',             'Resolves an InputView ref to its target'],
      ],
    },
    {
      // Curated less-obvious EC. Excluded the standard `.children`
      // / `.filter` / `.forEach` already covered above; these are
      // the "I always forget this one exists" surface.
      title: 'Esoteric: less-obvious methods',
      rows: [
        ['_o.rref()',                  'Reverse refs: who points TO this object'],
        ['_xs.calculate(expr, [start], [end])', 'Per-item expression with self + date range'],
        ['_xs.tree(expr)',             'Hierarchical grouping'],
        ['_xs.hmap(prop)',             'Historical-values map'],
        ['_xs.as(name)',               'Pluck one property: degrades silently'],
        ['_o.url()',                   'Object URL: open in BMP'],
        ['lookup(rid)',                'Resolve any object by numeric RID'],
        ['_o.canAdd() / canChange()',  'Permission check before mutate'],
        ['_o.generate(true)',          'Generate EC to recreate (with IDs)'],
        ['_o.genedit(*)',              'Generate editable change script'],
        ['error("msg")',               'Abort transaction with message'],
        ['notify(subject, body, type, recipients)', 'Send in-app notification'],
        ['sendmail(subject, body, recipients)', 'Send email: must be transactional'],
        ['_o.priority(int)',           'Set load priority for SELECT'],
        ['_t.addTimeColumns(value, periodType, start, end, header)', 'Table time series'],
      ],
    },
  ]
  return h('div', { class: 'editor-book-body editor-book-body--cheat' },
    ...groups.map(g =>
      h('div', { class: 'editor-book-cheat-group' },
        h('div', { class: 'editor-book-section-title' }, g.title),
        h('table', { class: 'editor-book-cheat-table' },
          ...g.rows.map(([k, v]) =>
            h('tr', null,
              h('td', { class: 'editor-book-cheat-token' }, k),
              h('td', { class: 'editor-book-cheat-desc' }, v),
            ),
          ),
        ),
      ),
    ),
  )
}

// ── Snippets tab ───────────────────────────────────────────────────

interface Snippet {
  title: string
  hint: string
  code: string
}

/** Five curated EC patterns. Each is independently runnable — paste
 *  into the editor + hit Preview. */
const SNIPPETS: Snippet[] = [
  {
    title: 'Read .expression as TEXT (not evaluate)',
    hint: 'bare .expression EVALUATES; output(.expression) returns the source text.',
    code:
`_text := output(t.calc_revenue.expression)
_text.whenMissing("(no source)")`,
  },
  {
    title: 'Days between two dates',
    hint: 'EC date arithmetic returns milliseconds. Divide to convert.',
    code:
`_diff := today - date("2026-01-01")
_diff / 86400000`,
  },
  {
    title: 'Format number with 2 decimals',
    hint: 'No native formatter. Slice the stringified value.',
    code:
`_n := 1234.5678
_t := str(_n)
_t.substring(0, _t.indexOf(".") + 3)`,
  },
  {
    title: 'Parse JSON + lookup by key',
    hint: '.map(keyProp, valueProp) builds a lookup; .get(key) reads.',
    code:
`_data := JSON('[{"id":"a","val":1},{"id":"b","val":2}]')
_data.map(id, val).get("a")`,
  },
  {
    title: 'Find code references to k.foo',
    hint: 'Searches every ExtendedExpression body for the substring.',
    code:
`SELECT ExtendedExpression
    WHERE output(Expression).indexOf("k.foo") >= 0`,
  },
]

function renderSnippetsTab(): HTMLElement {
  const body = h('div', { class: 'editor-book-body editor-book-body--snippets' })
  for (const s of SNIPPETS) body.appendChild(renderSnippetCard(s))
  return body
}

function renderSnippetCard(s: Snippet): HTMLElement {
  return h('div', { class: 'editor-book-snippet' },
    h('div', { class: 'editor-book-snippet-head' },
      h('div', { class: 'editor-book-snippet-title' }, s.title),
      h('button', {
        class: 'editor-book-snippet-copy',
        title: 'Copy snippet',
        onClick: (e: Event) => {
          const btn = e.currentTarget as HTMLButtonElement
          void copyText(s.code).then(ok => flashButton(btn, ok ? 'Copied' : 'Failed', ok))
        },
      }, 'Copy'),
    ),
    renderHighlightedCode(s.code),
    s.hint ? h('div', { class: 'editor-book-snippet-hint' }, s.hint) : null,
  )
}

/** Render the snippet code with the same EC syntax-highlight palette
 *  the editor uses. Each line is tokenised independently — block
 *  comments spanning lines aren't supported (the snippets don't use
 *  them, and the editor's full parser is the authoritative path for
 *  multi-line state). */
function renderHighlightedCode(code: string): HTMLElement {
  const pre = h('pre', { class: 'editor-book-snippet-code' })
  const lines = code.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) pre.appendChild(document.createTextNode('\n'))
    const line = lines[i]
    renderTokens(pre, line, tokenizeEcLine(line))
  }
  return pre
}

// ── Filter input ───────────────────────────────────────────────────

function renderFilterInput(popover: HTMLElement): HTMLElement {
  return h('div', { class: 'editor-book-filter' },
    h('input', {
      class: 'editor-book-filter-input',
      type: 'text',
      placeholder: 'Filter by prefix or type…',
      value: nsFilter,
      autocomplete: 'off',
      onInput: (e: Event) => {
        const el = e.currentTarget as HTMLInputElement
        nsFilter = el.value
        const caret = el.selectionStart ?? el.value.length
        rerenderBody(popover)
        // The body re-render replaced the input — re-focus the fresh
        // one and restore the caret position so typing continues
        // smoothly. Body-only rerender preserves shell scroll/state.
        const fresh = popover.querySelector<HTMLInputElement>('.editor-book-filter-input')
        fresh?.focus()
        fresh?.setSelectionRange(caret, caret)
      },
    }),
  )
}

// ── Clipboard + flash feedback ────────────────────────────────────

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

/** Track a fade-out timer so close-while-flashing cancels it. */
function trackedTimeout(fn: () => void, ms: number): void {
  const t = setTimeout(() => {
    pendingTimers.delete(t)
    fn()
  }, ms)
  pendingTimers.add(t)
}

/** Flash the Copy button text to "Copied" / "Failed" for ~900 ms. */
function flashButton(btn: HTMLButtonElement, label: string, ok: boolean): void {
  const original = btn.textContent
  btn.textContent = label
  const cls = ok ? 'editor-book-copied' : 'editor-book-copy-fail'
  btn.classList.add(cls)
  trackedTimeout(() => {
    btn.textContent = original
    btn.classList.remove(cls)
  }, 900)
}

/** Flash a one-second banner immediately under the tab row. Used by
 *  namespace-row clicks — click feedback can't live on the row itself
 *  because the user has already moved on.
 *
 *  Re-flashing while a previous banner is still up replaces the DOM
 *  AND cancels the previous timer; without that the orphan timer
 *  would just expire 1 s later trying to remove an already-detached
 *  node. Tracked in the dedicated `bannerTimer` slot (one banner at
 *  a time by design) rather than `pendingTimers` so we can clear
 *  precisely. */
function flashBanner(popover: HTMLElement, text: string, ok: boolean): void {
  if (bannerTimer) { clearTimeout(bannerTimer); bannerTimer = null }
  popover.querySelector('.editor-book-flash')?.remove()
  const flash = h('div', { class: `editor-book-flash editor-book-flash--${ok ? 'ok' : 'fail'}` }, text)
  // Anchor under the tabs (the title used to live above and act as
  // the anchor; we dropped it for space, so the tabs row is now
  // top-of-shell).
  popover.querySelector('.editor-book-tabs')?.after(flash)
  bannerTimer = setTimeout(() => {
    flash.remove()
    bannerTimer = null
  }, 1000)
}
