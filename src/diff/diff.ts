/**
 * Diff Page — side-by-side property comparison between two BMP objects.
 * Uses CodeMirror MergeView for visual diff rendering.
 */

import type { InspectorMessage } from '../lib/types';
import { getTypeColor, getTypeAbbr } from '../lib/types';
import { h, render } from '../lib/dom';
import { serializeForDiff } from '../lib/diff-serializer';
import { COMMON_DIFF_PROPS } from '../lib/constants';
import { CODE_PROPS_FOR_TYPE } from '../lib/types';

// Dynamic imports for CodeMirror (heavy)
let MergeView: typeof import('@codemirror/merge').MergeView | null = null;
let EditorState: typeof import('@codemirror/state').EditorState | null = null;
let EditorView: typeof import('@codemirror/view').EditorView | null = null;
let oneDark: typeof import('@codemirror/theme-one-dark').oneDark | null = null;

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

  // Check storage for context
  const stored = await chrome.storage.local.get('crev_diff_ctx');
  const ctx = stored.crev_diff_ctx as { leftRid?: string; rightRid?: string; mode?: string } | undefined;
  if (ctx) {
    if (ctx.leftRid && !left.rid) left.rid = ctx.leftRid;
    if (ctx.rightRid && !right.rid) right.rid = ctx.rightRid;
    if (ctx.mode === 'template') isTemplateMode = true;
    // Clean up
    chrome.storage.local.remove('crev_diff_ctx').catch(() => {});
  }

  renderUI();

  // Auto-load if RIDs present
  if (left.rid) fetchSide('left');
  if (right.rid) fetchSide('right');
}

function renderUI() {
  const leftIdentity = left.identity;
  const rightIdentity = right.identity;

  const leftLabel = isTemplateMode ? 'Template' : 'Left';
  const rightLabel = isTemplateMode ? 'Instance' : 'Right';

  const bar = h('div', { class: 'diff-bar' },
    // Left side
    h('div', { class: 'diff-side' },
      h('span', { class: 'diff-side-label' }, leftLabel),
      h('input', { class: 'diff-rid-input', id: 'left-rid', value: left.rid, placeholder: 'Enter RID' }),
      leftIdentity ? renderIdentityChip(leftIdentity) : null,
      h('button', { class: 'btn', id: 'btn-load-left' }, 'Load'),
    ),

    h('span', { class: 'diff-sep' }, '\u2194'),

    // Right side
    h('div', { class: 'diff-side' },
      h('span', { class: 'diff-side-label' }, rightLabel),
      h('input', { class: 'diff-rid-input', id: 'right-rid', value: right.rid, placeholder: 'Enter RID' }),
      rightIdentity ? renderIdentityChip(rightIdentity) : null,
      h('button', { class: 'btn', id: 'btn-load-right' }, 'Load'),
    ),

    // Actions
    h('div', { class: 'diff-actions' },
      h('button', { class: 'btn', id: 'btn-swap' }, 'Swap'),
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
  const color = getTypeColor(identity.type);
  const abbr = getTypeAbbr(identity.type);
  return h('span', { class: 'diff-identity' },
    h('span', { class: 'diff-type-badge', style: `--type-color:${color}` }, abbr),
    ' ', identity.name ?? 'unnamed',
  );
}

function fetchSide(side: 'left' | 'right') {
  const s = side === 'left' ? left : right;
  s.loading = true;
  s.error = null;
  s.props = null;
  s.identity = null;
  renderUI();

  chrome.runtime.sendMessage(
    { type: 'FETCH_DIFF_PROPS', rid: s.rid } as InspectorMessage,
    (response: any) => {
      if (chrome.runtime.lastError) {
        s.loading = false;
        s.error = chrome.runtime.lastError.message ?? 'Communication error';
        renderUI();
        return;
      }
      if (!response || response.type !== 'DIFF_PROPS_RESULT') {
        s.loading = false;
        s.error = 'Unexpected response';
        renderUI();
        return;
      }
      s.loading = false;
      if (response.error) {
        s.error = response.error;
      } else {
        s.props = response.props;
        s.identity = response.identity;
      }
      renderUI();
    },
  );
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
      import('@codemirror/theme-one-dark'),
    ]);
    MergeView = mergeModule.MergeView;
    EditorState = stateModule.EditorState;
    EditorView = viewModule.EditorView;
    oneDark = themeModule.oneDark;
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
        oneDark!,
      ],
    },
    b: {
      doc: rightText,
      extensions: [
        EditorView!.editable.of(false),
        EditorState!.readOnly.of(true),
        oneDark!,
      ],
    },
    parent: container,
  });

  // Update title
  const leftName = left.identity?.name ?? left.rid;
  const rightName = right.identity?.name ?? right.rid;
  document.title = `${leftName} \u2194 ${rightName} \u2014 CREV Diff`;
}

function getCodePropNames(type?: string): string[] {
  if (!type) return [];
  return [...(CODE_PROPS_FOR_TYPE[type] ?? [])];
}
