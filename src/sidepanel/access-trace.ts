/**
 * Access Trace overlay — the admin permission test, in-panel.
 *
 * Launched from the detail-view ("Test access"). A focused, dismissible card:
 * object (auto) → subject (user/role) + action → verdict + PBAC decision tree.
 * Kept deliberately small: auto-runs when subject+action are set, no clutter.
 *
 * Self-contained: sends FETCH_ACCESS_SUBJECTS / REQUEST_ACCESS_TRACE; the
 * sidepanel routes ACCESS_SUBJECTS_DATA / ACCESS_TRACE_RESULT back via
 * `routeAccessMessage`.
 */
import { h, render, svg } from '../lib/dom';
import { ICON_X_CIRCLE, ICON_CHECK_CIRCLE, ICON_MINUS_CIRCLE, ICON_CHECK, ICON_CHEVRON, ICON_X } from '../lib/icons';
import { typeBadge, wireBadgeCopy } from '../lib/type-badge';
import type { AccessSubject, AccessTraceAction, AccessTraceNode, InspectorMessage } from '../lib/types';

/** How this overlay reaches the SW. Injected by the host surface (the side panel
 *  routes responses through its port; the popout bridges via sendRequest) so the
 *  same overlay works on both. Set via {@link initAccessTrace}. */
let sendMessage: (m: InspectorMessage) => void = () => { /* set by initAccessTrace */ };
export function initAccessTrace(send: (m: InspectorMessage) => void): void {
  sendMessage = send;
}

interface TraceObject { rid: string; name: string; type: string }

const ACTIONS: { key: AccessTraceAction; label: string }[] = [
  { key: 'READ', label: 'Read' },
  { key: 'UPDATE', label: 'Write' },
  { key: 'CREATE', label: 'Add' },
  { key: 'DELETE', label: 'Delete' },
];

/** Friendly label for a trace node's `element` kind. */
function elementLabel(el: string): string {
  switch (el) {
    case 'TraceRequest': return 'Access request';
    case 'Access request': return 'Access request';
    case 'Statement': return 'Statement';
    case 'Subject': return 'Subject match';
    case 'Action': return 'Action match';
    case 'HasAccessTo': return 'Inherited (HasAccessTo)';
    case 'All': return 'All of';
    case 'Any': return 'Any of';
    case 'Equal': return 'Equals';
    case 'ExactTypeOf': return 'Exact type';
    case 'Contains': return 'Contains';
    case 'ContainsAny': return 'Contains any';
    case 'ContainsAll': return 'Contains all';
    default: return el || 'Condition';
  }
}

interface State {
  open: boolean;
  obj: TraceObject | null;
  subjects: AccessSubject[] | null;   // null = not loaded (cached once loaded)
  subjectsLoading: boolean;
  canTrace: boolean;
  subjectsError: string | null;
  filter: string;
  pickerOpen: boolean;
  subject: AccessSubject | null;
  action: AccessTraceAction;
  result: AccessTraceNode | null;
  tracing: boolean;
  traceError: string | null;
  expanded: Set<string>;              // node paths expanded
  showAllRules: boolean;              // reveal the non-granting statements
  copied: boolean;
}

const state: State = {
  open: false, obj: null, subjects: null, subjectsLoading: false, canTrace: true, subjectsError: null,
  filter: '', pickerOpen: false, subject: null, action: 'READ',
  result: null, tracing: false, traceError: null, expanded: new Set(), showAllRules: false, copied: false,
};

/** Load the subject list once per session; cached across panel re-opens. A
 *  transient failure leaves `subjects` null so the next open (or Retry) refetches. */
function loadSubjects(): void {
  if (state.subjects !== null || state.subjectsLoading) return;
  state.subjectsLoading = true;
  state.subjectsError = null;
  sendMessage({ type: 'FETCH_ACCESS_SUBJECTS' });
}

let rootEl: HTMLElement | null = null;

export function isAccessTraceOpen(): boolean { return state.open; }

export function openAccessTrace(obj: TraceObject): void {
  state.open = true;
  state.obj = obj;
  state.subject = null;
  state.result = null;
  state.traceError = null;
  state.tracing = false;
  state.filter = '';
  state.pickerOpen = false;
  state.expanded = new Set();
  loadSubjects();
  mount();
}

export function closeAccessTrace(): void {
  state.open = false;
  if (rootEl) { rootEl.remove(); rootEl = null; }
}

/** Route the two access-trace responses from the sidepanel message loop. */
export function routeAccessMessage(msg: InspectorMessage): boolean {
  if (msg.type === 'ACCESS_SUBJECTS_DATA') {
    state.subjectsLoading = false;
    state.canTrace = msg.canTrace;
    state.subjectsError = msg.error ?? null;
    // On error keep `subjects` null so the next open / Retry refetches.
    state.subjects = msg.error ? null : msg.subjects;
    if (state.open) rerender();
    return true;
  }
  if (msg.type === 'ACCESS_TRACE_RESULT') {
    if (!state.open || !state.obj || msg.rid !== state.obj.rid) return true;
    state.tracing = false;
    state.result = msg.node;
    state.traceError = msg.error ?? null;
    state.showAllRules = false;
    state.expanded = new Set();
    // Auto-expand the branch(es) that actually granted, so a GRANT shows *why*
    // without hunting. A DENY has none → nothing auto-opens, and the dozens of
    // non-granting statements stay collapsed behind a disclosure (renderResult).
    if (msg.node) {
      msg.node.children.forEach((c, i) => { if (c.result === true) state.expanded.add(`0.${i}`); });
    }
    rerender();
    return true;
  }
  return false;
}

function runTrace(): void {
  if (!state.obj || !state.subject) return;
  state.tracing = true;
  state.result = null;
  state.traceError = null;
  rerender();
  sendMessage({ type: 'REQUEST_ACCESS_TRACE', rid: state.obj.rid, subjectRid: state.subject.rid, action: state.action });
}

function mount(): void {
  closeMountOnly();
  rootEl = h('div', { class: 'atrace-backdrop', onClick: (e: MouseEvent) => { if (e.target === rootEl) closeAccessTrace(); } });
  document.body.appendChild(rootEl);
  document.addEventListener('keydown', onKey);
  rerender();
}
function closeMountOnly(): void { if (rootEl) { rootEl.remove(); rootEl = null; } }
function onKey(e: KeyboardEvent): void {
  if (!state.open) { document.removeEventListener('keydown', onKey); return; }
  if (e.key === 'Escape') { e.stopPropagation(); closeAccessTrace(); document.removeEventListener('keydown', onKey); }
}

/**
 * Rebuild the whole card. By default the scrollable body resets to the top,
 * which is right for NEW content (a fresh trace, action/subject change). For
 * IN-PLACE updates — expanding a statement, show-all-rules, the copy flash —
 * pass `keepScroll: true` so the rebuild doesn't yank the user back to the top.
 */
function rerender(opts?: { keepScroll?: boolean }): void {
  if (!rootEl) return;
  const prevScroll = opts?.keepScroll
    ? (rootEl.querySelector('.atrace-body') as HTMLElement | null)?.scrollTop ?? 0
    : 0;
  render(rootEl, h('div', { class: 'atrace-card', onClick: (e: MouseEvent) => e.stopPropagation() },
    renderHeader(),
    renderBody(),
  ));
  if (prevScroll > 0) {
    const body = rootEl.querySelector('.atrace-body') as HTMLElement | null;
    if (body) body.scrollTop = prevScroll;
  }
}

function renderHeader(): HTMLElement {
  const o = state.obj!;
  return h('div', { class: 'atrace-head' },
    h('span', { class: 'atrace-title' }, 'Test access'),
    h('span', { class: 'atrace-obj' },
      wireBadgeCopy(typeBadge(o.type, { size: 'xs' }), () => o.rid),
      h('span', { class: 'atrace-obj-name', title: o.name }, o.name || '(unnamed)'),
    ),
    h('button', { class: 'atrace-close', title: 'Close (Esc)', 'aria-label': 'Close', onClick: () => closeAccessTrace() }, svg(ICON_X)),
  );
}

function renderBody(): HTMLElement {
  if (state.subjectsLoading) {
    return h('div', { class: 'atrace-body' }, h('div', { class: 'atrace-msg' }, 'Loading subjects…'));
  }
  if (state.subjectsError) {
    return h('div', { class: 'atrace-body' },
      h('div', { class: 'atrace-msg atrace-msg--err' },
        'Couldn’t load subjects. ',
        h('button', { class: 'atrace-link', onClick: () => { loadSubjects(); rerender(); } }, 'Retry'),
        h('div', { class: 'atrace-msg-sub' }, state.subjectsError),
      ),
    );
  }
  if (!state.canTrace) {
    return h('div', { class: 'atrace-body' },
      h('div', { class: 'atrace-msg atrace-msg--warn' },
        'Access tracing needs admin / Configuration-Studio access on this BMP session.',
      ),
    );
  }
  return h('div', { class: 'atrace-body' },
    renderControls(),
    renderResult(),
  );
}

function renderControls(): HTMLElement {
  return h('div', { class: 'atrace-controls' },
    h('div', { class: 'atrace-row' },
      h('span', { class: 'atrace-lbl' }, 'Subject'),
      renderSubjectPicker(),
    ),
    h('div', { class: 'atrace-row' },
      h('span', { class: 'atrace-lbl' }, 'Action'),
      h('div', { class: 'atrace-seg' },
        ...ACTIONS.map(a => h('button', {
          class: `atrace-seg-btn${state.action === a.key ? ' active' : ''}`,
          onClick: () => { state.action = a.key; if (state.subject) runTrace(); else rerender(); },
        }, a.label)),
      ),
    ),
  );
}

function renderSubjectPicker(): HTMLElement {
  if (state.subject && !state.pickerOpen) {
    return h('div', { class: 'atrace-subject-chosen' },
      h('span', { class: `atrace-kind atrace-kind--${state.subject.kind}` }, state.subject.kind),
      h('span', { class: 'atrace-subject-name' }, state.subject.name),
      h('button', { class: 'atrace-link', onClick: () => { state.pickerOpen = true; state.filter = ''; rerender(); } }, 'change'),
    );
  }
  const all = state.subjects ?? [];
  const q = state.filter.trim().toLowerCase();
  const matches = (q ? all.filter(s => s.name.toLowerCase().includes(q) || (s.businessId ?? '').toLowerCase().includes(q)) : all).slice(0, 50);
  const input = h('input', {
    class: 'atrace-search', type: 'text', placeholder: 'Search user or role…', value: state.filter,
    onInput: (e: Event) => { state.filter = (e.target as HTMLInputElement).value; renderListOnly(matchesList()); },
  }) as HTMLInputElement;
  const list = h('div', { class: 'atrace-list' }, ...matches.map(renderSubjectOption));
  // Stash the list node so input keystrokes can refresh just it (no focus loss).
  setTimeout(() => input.focus(), 0);
  return h('div', { class: 'atrace-picker' }, input, list);
}

function matchesList(): AccessSubject[] {
  const all = state.subjects ?? [];
  const q = state.filter.trim().toLowerCase();
  return (q ? all.filter(s => s.name.toLowerCase().includes(q) || (s.businessId ?? '').toLowerCase().includes(q)) : all).slice(0, 50);
}
function renderListOnly(matches: AccessSubject[]): void {
  const list = rootEl?.querySelector('.atrace-list');
  if (list) render(list as HTMLElement, ...matches.map(renderSubjectOption));
}
function renderSubjectOption(s: AccessSubject): HTMLElement {
  return h('button', {
    class: 'atrace-opt',
    onClick: () => { state.subject = s; state.pickerOpen = false; runTrace(); },
  },
    h('span', { class: `atrace-kind atrace-kind--${s.kind}` }, s.kind),
    h('span', { class: 'atrace-opt-name' }, s.name),
    s.businessId ? h('span', { class: 'atrace-opt-bid' }, s.businessId) : null,
  );
}

function renderResult(): HTMLElement | null {
  if (state.tracing) return h('div', { class: 'atrace-result' }, h('div', { class: 'atrace-msg' }, 'Tracing…'));
  if (state.traceError) return h('div', { class: 'atrace-result' }, h('div', { class: 'atrace-msg atrace-msg--err' }, state.traceError));
  if (!state.subject) return h('div', { class: 'atrace-result' }, h('div', { class: 'atrace-msg atrace-msg--hint' }, 'Pick a subject to trace.'));
  if (!state.result) return null;
  const granted = state.result.result === true;
  const kids = state.result.children;
  // Split top-level rules: the one(s) that granted vs the rest. A grant is
  // decided by a statement returning true; everything else is noise you only
  // want on demand. This is what keeps a deny from dumping 80+ identical ✗ rows.
  const granting: { node: AccessTraceNode; i: number }[] = [];
  const others: { node: AccessTraceNode; i: number }[] = [];
  kids.forEach((node, i) => (node.result === true ? granting : others).push({ node, i }));
  const action = ACTIONS.find(a => a.key === state.action)?.label ?? state.action;
  const plural = (n: number, s: string) => `${n} ${s}${n === 1 ? '' : 's'}`;
  const summary = granted
    ? `${granting.length} of ${kids.length} ${kids.length === 1 ? 'statement grants' : 'statements grant'} ${action}`
    : `No statement grants ${action} · ${plural(kids.length, 'rule')} evaluated`;

  return h('div', { class: 'atrace-result' },
    h('div', { class: `atrace-verdict atrace-verdict--${granted ? 'ok' : 'no'}` },
      h('span', { class: 'atrace-verdict-icon', 'aria-hidden': 'true' }, svg(granted ? ICON_CHECK_CIRCLE : ICON_X_CIRCLE)),
      h('span', { class: 'atrace-verdict-label' }, granted ? 'Granted' : 'Denied'),
      h('span', { class: 'atrace-verdict-ctx' }, `${state.subject.name} · ${action}`),
    ),
    kids.length ? h('div', { class: 'atrace-summary' }, summary) : null,
    h('div', { class: 'atrace-toolbar' },
      h('button', { class: 'atrace-link', title: 'Copy verdict + tree as text', onClick: () => copyResult() }, state.copied ? ['Copied ', svg(ICON_CHECK)] : 'Copy'),
      kids.length ? h('button', { class: 'atrace-link', onClick: () => expandAll() }, 'Expand all') : null,
      kids.length ? h('button', { class: 'atrace-link', onClick: () => collapseAll() }, 'Collapse all') : null,
    ),
    h('div', { class: 'atrace-tree' },
      // The granting branch(es) first — auto-expanded, the part you actually want.
      ...granting.map(({ node, i }) => renderNode(node, `0.${i}`)),
      // The rest hide behind a disclosure so the verdict isn't buried under
      // dozens of identical non-granting rows. Full tree still one click + Copy away.
      others.length
        ? h('button', {
            class: `atrace-disclosure${state.showAllRules ? ' is-open' : ''}`,
            onClick: () => { state.showAllRules = !state.showAllRules; rerender({ keepScroll: true }); },
          },
            h('span', { class: 'atrace-disclosure-tw' }, svg(ICON_CHEVRON)),
            `${state.showAllRules ? 'Hide' : 'Show'} ${plural(others.length, granting.length ? 'non-granting statement' : 'evaluated statement')}`,
          )
        : null,
      state.showAllRules
        ? h('div', { class: 'atrace-others' }, ...renderOthers(others))
        : null,
    ),
  );
}

/** Render the non-granting statements, collapsing the bulk of identical
 *  subject-mismatch rows (e.g. "✗ role:roleBasic · 0" ×20) into one counted
 *  row. Statements that actually matched the subject — and only failed later on
 *  action/conditions — keep their own expandable row: those near-misses are the
 *  ones worth reading. */
function renderOthers(others: { node: AccessTraceNode; i: number }[]): HTMLElement[] {
  const out: HTMLElement[] = [];
  const groups = new Map<string, { node: AccessTraceNode; i: number; count: number }>();
  const order: string[] = [];
  for (const { node, i } of others) {
    // "Notable" = the subject matched, so deeper conditions were evaluated.
    if (node.children.some(c => c.element !== 'Subject')) { out.push(renderNode(node, `0.${i}`)); continue; }
    // Group by subject only — the per-statement index is meaningless once you
    // aggregate ("role:Basic ·0 ×53" reads like all 53 are index 0). A lone
    // statement still shows its index via renderNode below.
    const key = statementSubject(node) ?? 'statement';
    const g = groups.get(key);
    if (g) g.count++;
    else { groups.set(key, { node, i, count: 1 }); order.push(key); }
  }
  for (const key of order) {
    const g = groups.get(key)!;
    out.push(g.count > 1 ? renderCollapsedRow(g.node, g.count) : renderNode(g.node, `0.${g.i}`));
  }
  return out;
}

/** A single non-expandable row standing in for `count` statements that all
 *  reference the same subject (no index — see renderOthers). */
function renderCollapsedRow(node: AccessTraceNode, count: number): HTMLElement {
  const subject = statementSubject(node) ?? 'statement';
  return h('div', { class: 'atrace-node atrace-node--no', title: `${count} statements reference ${subject}; none grant access` },
    h('span', { class: 'atrace-node-tw' }, '·'),
    h('span', { class: 'atrace-node-icon' }, svg(ICON_X_CIRCLE)),
    h('span', { class: 'atrace-node-label' }, subject),
    h('span', { class: 'atrace-node-count' }, `${count} statements`),
  );
}

/** Collect the paths of every node that has children (for Expand all). */
function collectExpandable(nodes: AccessTraceNode[], prefix: string, out: string[]): void {
  nodes.forEach((n, i) => {
    const p = `${prefix}.${i}`;
    if (n.children.length) { out.push(p); collectExpandable(n.children, p, out); }
  });
}
function expandAll(): void {
  if (!state.result) return;
  state.showAllRules = true; // Expand all implies revealing the collapsed rules too.
  const paths: string[] = [];
  collectExpandable(state.result.children, '0', paths);
  state.expanded = new Set(paths);
  rerender({ keepScroll: true });
}
function collapseAll(): void { state.expanded.clear(); state.showAllRules = false; rerender({ keepScroll: true }); }

/** Serialize the trace to indented text for the clipboard. */
function nodeToText(n: AccessTraceNode, depth: number): string {
  const icon = n.result === true ? '✓' : n.result === false ? '✗' : '–';
  const det = Object.entries(n.details).map(([k, v]) => `${k}=${v}`).join(', ');
  let line = `${'  '.repeat(depth)}${icon} ${elementLabel(n.element)}${det ? ` (${det})` : ''}${n.timedOut ? ' [timed out]' : ''}`;
  for (const c of n.children) line += '\n' + nodeToText(c, depth + 1);
  return line;
}
function copyResult(): void {
  const { result: r, obj: o, subject: s } = state;
  if (!r || !o || !s) return;
  const verdict = r.result === true ? 'GRANTED' : 'DENIED';
  const action = ACTIONS.find(a => a.key === state.action)?.label;
  const header = `${verdict}: ${s.kind} "${s.name}" · ${action} · ${o.type} "${o.name}"`;
  const body = r.children.map(c => nodeToText(c, 1)).join('\n');
  void navigator.clipboard?.writeText(`${header}\n${body}`).then(() => {
    state.copied = true;
    rerender({ keepScroll: true });
    setTimeout(() => { state.copied = false; if (rootEl) rerender({ keepScroll: true }); }, 1400);
  }).catch(() => { /* clipboard blocked — silent */ });
}

/** The Subject-match child of a statement carries the role/user the statement
 *  is about, e.g. `original=[role:role_auditor]`. Pull the bare subject out. */
function statementSubject(node: AccessTraceNode): string | null {
  const subj = node.children.find(c => c.element === 'Subject' || typeof c.details?.original === 'string');
  const raw = subj?.details?.original;
  return raw ? raw.replace(/^\[|\]$/g, '').trim() || null : null;
}

function renderNode(node: AccessTraceNode, path: string): HTMLElement {
  // A Statement's identity is *who it grants to* — render that subject, not the
  // bare "Statement (statementIndex=3)". The lone Subject-match child just
  // restates the subject, so fold it away; statements that matched the subject
  // keep their Action/condition children. The statementIndex is dropped: it's a
  // statement's position within its (unnamed-here) permission, so the same index
  // repeats across the workspace — meaningless and unactionable on its own.
  const isStatement = node.element === 'Statement';
  const subject = isStatement ? statementSubject(node) : null;
  const childEntries = node.children
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => !(isStatement && c.element === 'Subject'));
  const hasKids = childEntries.length > 0;
  const isOpen = state.expanded.has(path);
  const resClass = node.result === true ? 'ok' : node.result === false ? 'no' : 'na';

  let label: string;
  let detail: string | null;
  if (isStatement) {
    label = subject ?? 'statement';
    detail = null;
  } else {
    label = elementLabel(node.element);
    detail = Object.keys(node.details).length ? summariseDetails(node.details) : null;
  }

  const row = h('div', {
    class: `atrace-node atrace-node--${resClass}`,
    onClick: hasKids ? () => { if (isOpen) state.expanded.delete(path); else state.expanded.add(path); rerender({ keepScroll: true }); } : undefined,
  },
    h('span', { class: `atrace-node-tw${hasKids && isOpen ? ' is-open' : ''}` }, hasKids ? svg(ICON_CHEVRON) : '·'),
    h('span', { class: 'atrace-node-icon' }, svg(node.result === true ? ICON_CHECK_CIRCLE : node.result === false ? ICON_X_CIRCLE : ICON_MINUS_CIRCLE)),
    h('span', { class: 'atrace-node-label' }, label),
    node.timedOut ? h('span', { class: 'atrace-node-timeout' }, 'timed out') : null,
    detail ? h('span', { class: 'atrace-node-detail' }, detail) : null,
  );
  if (!hasKids || !isOpen) return row;
  return h('div', { class: 'atrace-node-group' }, row,
    h('div', { class: 'atrace-node-kids' }, ...childEntries.map(({ c, i }) => renderNode(c, `${path}.${i}`))),
  );
}

/** A short one-line summary of the most useful detail keys. */
function summariseDetails(d: Record<string, string>): string {
  const pick = (k: string) => (d[k] ? `${k}=${d[k]}` : '');
  const parts = [pick('subject'), pick('action'), pick('statementIndex'), pick('reference'), pick('type')].filter(Boolean);
  if (parts.length) return parts.join(' · ');
  // Fall back to the first 1-2 entries.
  return Object.entries(d).slice(0, 2).map(([k, v]) => `${k}=${v}`).join(' · ');
}
