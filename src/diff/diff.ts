/**
 * Diff Page — side-by-side property comparison between two BMP objects.
 * Uses CodeMirror MergeView for visual diff rendering.
 */

import { typeBadge, wireBadgeCopy } from '../lib/type-badge';
import { h, render } from '../lib/dom';
import { serializeForDiff } from '../lib/diff-serializer';
import { CODE_PROPS_FOR_TYPE } from '../lib/types';
import { installCloseHandshake } from '../lib/frame-close-handshake';
import { sendRequest } from '../lib/messaging';

installCloseHandshake();

// Dynamic imports for CodeMirror (heavy)
let MergeView: typeof import('@codemirror/merge').MergeView | null = null;
let EditorState: typeof import('@codemirror/state').EditorState | null = null;
let EditorView: typeof import('@codemirror/view').EditorView | null = null;
let catppuccinMocha: typeof import('../editor-core/theme').catppuccinMocha | null = null;

const root = document.getElementById('diff-root')!;

// State
interface DiffSide {
  rid: string;
  props: Record<string, string> | null;
  identity: { name?: string; type?: string; businessId?: string } | null;
  loading: boolean;
  error: string | null;
}

let left: DiffSide = { rid: '', props: null, identity: null, loading: false, error: null };
let right: DiffSide = { rid: '', props: null, identity: null, loading: false, error: null };
let mergeViewInstance: InstanceType<typeof import('@codemirror/merge').MergeView> | null = null;
let isTemplateMode = false;

// Read initial state from hash and storage
init();

async function init() {
  // Parse hash: #leftRid,rightRid or #leftRid
  const hash = location.hash.slice(1);
  if (hash) {
    const [l, r] = hash.split(',');
    if (l) left.rid = l;
    if (r) right.rid = r;
  }

  // Check storage for context. In template-diff mode we always honor the
  // stored leftRid (the template RID) even if the hash already had something —
  // the launcher writes ctx after computing the template, so it's authoritative.
  const stored = await chrome.storage.local.get('crev_diff_ctx');
  const ctx = stored.crev_diff_ctx as { leftRid?: string; rightRid?: string; mode?: string } | undefined;
  if (ctx) {
    if (ctx.mode === 'template') {
      isTemplateMode = true;
      if (ctx.leftRid) left.rid = ctx.leftRid;
      if (ctx.rightRid) right.rid = ctx.rightRid;
    } else {
      if (ctx.leftRid && !left.rid) left.rid = ctx.leftRid;
      if (ctx.rightRid && !right.rid) right.rid = ctx.rightRid;
    }
    // Clean up
    chrome.storage.local.remove('crev_diff_ctx').catch(() => {});
  }

  renderUI();

  // Auto-load both sides eagerly in template-diff mode (the user came in
  // expecting both panes filled). In manual mode, only load what's already
  // populated and let the user click Load for the rest.
  if (left.rid) fetchSide('left');
  if (right.rid) fetchSide('right');
}

function renderUI() {
  const leftIdentity = left.identity;
  const rightIdentity = right.identity;

  const leftLabel = isTemplateMode ? 'Template' : 'Left';
  const rightLabel = isTemplateMode ? 'Instance' : 'Right';

  // Inputs default to the BID (resolved identity) once a side has loaded;
  // before that they show whatever the user typed / launcher passed. Accepting
  // both forms lets the user paste an RID from a URL or a BID from a script.
  const leftValue = leftIdentity?.businessId ?? left.rid;
  const rightValue = rightIdentity?.businessId ?? right.rid;

  const bar = h('div', { class: 'diff-bar' },
    // Left side
    h('div', { class: 'diff-side' },
      h('span', { class: 'diff-side-label' }, leftLabel),
      h('input', {
        class: 'diff-rid-input',
        id: 'left-rid',
        value: leftValue,
        placeholder: 'RID or t.bid / o.bid / k.bid',
        title: 'Numeric RID, or a business ID with a namespace prefix (t. = template, o. = organisation, k. = property, r. = resource). Bare BIDs without a prefix are ambiguous and not accepted.',
      }),
      leftIdentity ? renderIdentityChip(leftIdentity) : null,
      h('button', { class: 'btn btn-accent', id: 'btn-load-left' }, 'Load'),
    ),

    h('span', { class: 'diff-sep', 'aria-hidden': 'true' }),

    // Right side
    h('div', { class: 'diff-side' },
      h('span', { class: 'diff-side-label' }, rightLabel),
      h('input', {
        class: 'diff-rid-input',
        id: 'right-rid',
        value: rightValue,
        placeholder: 'RID or t.bid / o.bid / k.bid',
        title: 'Numeric RID, or a business ID with a namespace prefix (t. = template, o. = organisation, k. = property, r. = resource). Bare BIDs without a prefix are ambiguous and not accepted.',
      }),
      rightIdentity ? renderIdentityChip(rightIdentity) : null,
      h('button', { class: 'btn btn-accent', id: 'btn-load-right' }, 'Load'),
    ),

    // Actions
    h('div', { class: 'diff-actions' },
      h('button', { class: 'btn', id: 'btn-swap', title: 'Swap sides' }, 'Swap'),
    ),
  );

  const mergeContainer = h('div', { class: 'diff-merge-container', id: 'merge-container' });

  // Status messages
  let statusEl: HTMLElement | null = null;
  if (left.loading || right.loading) {
    statusEl = h('div', { class: 'diff-loading' }, 'Loading properties\u2026');
  } else if (left.error) {
    statusEl = h('div', { class: 'diff-error' }, `Left: ${left.error}`);
  } else if (right.error) {
    statusEl = h('div', { class: 'diff-error' }, `Right: ${right.error}`);
  } else if (!left.props && !right.props) {
    statusEl = h('div', { class: 'diff-hint' }, 'Enter RIDs and click Load to compare objects');
  }

  render(root, bar, statusEl ?? mergeContainer);

  // Wire events
  document.getElementById('btn-load-left')?.addEventListener('click', () => {
    const input = document.getElementById('left-rid') as HTMLInputElement;
    if (input?.value.trim()) {
      left.rid = input.value.trim();
      fetchSide('left');
    }
  });

  document.getElementById('btn-load-right')?.addEventListener('click', () => {
    const input = document.getElementById('right-rid') as HTMLInputElement;
    if (input?.value.trim()) {
      right.rid = input.value.trim();
      fetchSide('right');
    }
  });

  document.getElementById('btn-swap')?.addEventListener('click', () => {
    const tmp = { ...left };
    left = { ...right };
    right = tmp;
    renderUI();
    if (left.props && right.props) updateMergeView();
  });

  // If both sides loaded, render merge view
  if (left.props && right.props && !statusEl) {
    updateMergeView();
  }
}

function renderIdentityChip(identity: { name?: string; type?: string; businessId?: string }): HTMLElement {
  const children: (HTMLElement | string)[] = [
    identity.businessId
      ? wireBadgeCopy(typeBadge(identity.type, { size: 'xs' }), () => identity.businessId!)
      : typeBadge(identity.type, { size: 'xs' }),
    ' ',
    identity.name ?? 'unnamed',
  ];
  // BID is the stable identifier across workspaces — show it next to the name
  // so the user can confirm they loaded the right object even when names match.
  if (identity.businessId) {
    children.push(' ', h('span', { class: 'diff-bid' }, identity.businessId));
  }
  return h('span', { class: 'diff-identity' }, ...children);
}

/** Pattern for namespaced BIDs ("t.someBid", "k.pMyProp", "g.somegroup").
 *  Anything that contains a dot and isn't all-digits we treat as a BID and
 *  resolve to a RID via EC before fetching. Numeric strings are RIDs. */
const BID_RE = /^[a-z]+\.[A-Za-z0-9_-]+$/;

async function resolveToRid(input: string): Promise<string | null> {
  const trimmed = input.trim();
  if (!trimmed) return null;
  // Already numeric → RID
  if (/^\d+$/.test(trimmed)) return trimmed;
  // Namespace.bid form (t.foo / o.bar / k.baz / r.qux / etc.) — the
  // SW handler resolves via EC `lookup("ns.bid")`. We accept the
  // namespace prefix as the disambiguator; without it, BMP can't
  // tell which root category to look in.
  if (BID_RE.test(trimmed)) return trimmed;
  // Bare BID without a namespace prefix — reject up front with a
  // clearer error than the generic "Enter a RID or BID" message
  // that fetchSide would otherwise show.
  return null;
}

async function fetchSide(side: 'left' | 'right') {
  const s = side === 'left' ? left : right;
  s.loading = true;
  s.error = null;
  s.props = null;
  s.identity = null;
  renderUI();

  // Accept either a RID or a `t.someBid`-style reference. The SW handler
  // does the actual resolution; resolveToRid is a no-op for now but keeps
  // the door open for client-side validation/preview.
  const ref = await resolveToRid(s.rid);
  if (!ref) {
    s.loading = false;
    s.error = 'Enter a numeric RID, or a BID with a namespace prefix (e.g. t.someBid, o.someOrg, k.someProp).';
    renderUI();
    return;
  }

  const response = await sendRequest({ type: 'FETCH_DIFF_PROPS', rid: ref });
  s.loading = false;
  if (response?.type !== 'DIFF_PROPS_RESULT') {
    s.error = 'Unexpected response';
  } else if (response.error) {
    s.error = response.error;
  } else {
    s.props = response.props;
    s.identity = response.identity;
    // Pin the canonical RID. We used to write the BID back into `s.rid` for
    // display purposes, but that made every subsequent re-fetch run BID→RID
    // resolution again. Keep `s.rid` numeric; the input field's display
    // value is derived from `s.identity.businessId` in renderUI so the user
    // still sees the friendly form. `response.rid` carries the resolved
    // numeric RID from the SW handler.
    if (response.rid && /^-?\d+$/.test(response.rid)) {
      s.rid = response.rid;
    }
  }
  renderUI();
}

async function updateMergeView() {
  if (!left.props || !right.props) return;

  // Determine code props from types
  const leftCodeProps = getCodePropNames(left.identity?.type);
  const rightCodeProps = getCodePropNames(right.identity?.type);
  const allCodeProps = [...new Set([...leftCodeProps, ...rightCodeProps])];

  const leftText = serializeForDiff(
    { rid: left.rid, name: left.identity?.name, type: left.identity?.type, businessId: left.identity?.businessId },
    left.props,
    allCodeProps,
  );
  const rightText = serializeForDiff(
    { rid: right.rid, name: right.identity?.name, type: right.identity?.type, businessId: right.identity?.businessId },
    right.props,
    allCodeProps,
  );

  // Lazy-load CodeMirror merge
  if (!MergeView) {
    const [mergeModule, stateModule, viewModule, themeModule] = await Promise.all([
      import('@codemirror/merge'),
      import('@codemirror/state'),
      import('@codemirror/view'),
      import('../editor-core/theme'),
    ]);
    MergeView = mergeModule.MergeView;
    EditorState = stateModule.EditorState;
    EditorView = viewModule.EditorView;
    catppuccinMocha = themeModule.catppuccinMocha;
  }

  const container = document.getElementById('merge-container');
  if (!container) return;

  // Destroy previous
  if (mergeViewInstance) {
    mergeViewInstance.destroy();
    mergeViewInstance = null;
  }

  container.textContent = '';

  mergeViewInstance = new MergeView!({
    a: {
      doc: leftText,
      extensions: [
        EditorView!.editable.of(false),
        EditorState!.readOnly.of(true),
        catppuccinMocha!,
      ],
    },
    b: {
      doc: rightText,
      extensions: [
        EditorView!.editable.of(false),
        EditorState!.readOnly.of(true),
        catppuccinMocha!,
      ],
    },
    parent: container,
    // Fold runs of unchanged lines into a "N unchanged lines" gutter
    // marker so the user lands on the actual differences. Margin=2
    // keeps 2 lines of context around each chunk; minSize=5 means
    // groups of <5 equal lines stay visible (avoids over-folding
    // short property sections).
    collapseUnchanged: { margin: 2, minSize: 5 },
    // Show each line's source-line number on each side. Built into
    // MergeView via gutter config.
    gutter: true,
  });

  // Update title
  const leftName = left.identity?.name ?? left.rid;
  const rightName = right.identity?.name ?? right.rid;
  document.title = `${leftName} \u2194 ${rightName} - CREV Diff`;
}

function getCodePropNames(type?: string): string[] {
  if (!type) return [];
  return [...(CODE_PROPS_FOR_TYPE[type] ?? [])];
}
