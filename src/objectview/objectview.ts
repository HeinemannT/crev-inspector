/**
 * Object View Page — full-window popout for editing a single BMP object.
 *
 * Aligned with the side-panel DetailView so the two surfaces stay in lockstep:
 * - Same prop schema (src/sidepanel/pane-schema.ts) — adding a new editable
 *   prop there surfaces it in both UIs at once.
 * - Same property editors (src/sidepanel/property-editors.ts).
 * - Same EC fetch (FETCH_OBJECT_PANE) and save path (APPLY_OBJECT_CHANGES).
 * - Same CSS classes (sidepanel.css is loaded by the popout HTML).
 *
 * Wide-mode additions on top of the side-panel surface:
 * - Built-in Diff buttons (free-form + template).
 * - Children list with click-to-open-popout navigation.
 *
 * Reads RID from URL hash; restores caller context from chrome.storage.local
 * (set by openObjectViewWindow).
 */

import type { ObjectPaneIdentity, ObjectPaneSiblingMsg } from '../lib/types';
import { getTypeColor } from '../lib/types';
import { typeBadge } from '../lib/type-badge';
import { h, render, svg } from '../lib/dom';
import { ICON_ARROW_LINE_UP } from '../lib/icons';
import { resolveCopyText, getModifier } from '../lib/namespace';
import { appendEcPreview } from '../lib/ec-format';
import { installCloseHandshake } from '../lib/frame-close-handshake';
import { sendFireForget, sendRequest } from '../lib/messaging';
import { resolveLayoutShortcut } from '../lib/layout-target';
import { findPropDef } from '../sidepanel/pane-schema';
import { displayValue } from '../sidepanel/property-editors';
import { renderPropertyGroups, type PaneGroupsCtx } from '../sidepanel/sections/property-groups';
import { renderLinks, referencesToLinks } from '../sidepanel/sections/links';
import { renderFlowSection } from '../sidepanel/sections/flow-walker';
import { hasFlow } from '../lib/widget-metadata';
import { hasStudio, modeForType } from '../studio/studio-mode';
import { openAccessTrace, routeAccessMessage, initAccessTrace } from '../sidepanel/access-trace';
import { openColorPicker } from '../sidepanel/color-picker';
import { confirmModal } from '../lib/modal';

installCloseHandshake();

// The Access Trace overlay is shared with the side panel. The SW replies to the
// sender (respond()), so here we bridge its fire-and-forget sends through
// sendRequest and route the reply back into the overlay.
initAccessTrace((msg) => {
  if (msg.type === 'FETCH_ACCESS_SUBJECTS' || msg.type === 'REQUEST_ACCESS_TRACE') {
    void sendRequest(msg).then((resp) => { if (resp) routeAccessMessage(resp); });
  } else {
    sendFireForget(msg);
  }
});

const root = document.getElementById('objectview-root')!;
const rid = location.hash.slice(1);

// The "↑ inside" parent crumb (and any re-open of this overlay for a
// different object) navigates by swapping the iframe's hash. A hash-only
// change does NOT reload the document, so `rid` above would stay stale and
// the view wouldn't move. Reload on hashchange so the new RID is picked up.
window.addEventListener('hashchange', () => location.reload());

interface PaneState {
  rid: string;
  identity: ObjectPaneIdentity;
  parent: ObjectPaneIdentity | null;
  template: ObjectPaneIdentity | null;
  instanceProps: Record<string, string>;
  templateProps: Record<string, string>;
  siblings: ObjectPaneSiblingMsg[];
  /** Code-bearing properties (expression / html / javascript) — keyed
   *  by property name. Populated from OBJECT_PANE_DATA.codeFields. */
  codeFields: Record<string, string>;
  /** Reference-link props (table, dataReference, …) → the linked object. */
  references: Record<string, ObjectPaneIdentity | null>;
  loaded: boolean;
  error: string | null;
  saving: boolean;
  /** Flow chain (flow-bearing types only) — fetched after the pane lands. */
  flow: import('../lib/types').FlowChainMsg | null;
  flowLoading: boolean;
  flowError: string | null;
}

type SaveTarget = 'instance' | 'template';

let state: PaneState | null = null;
let draft: Record<string, string> = {};
let target: SaveTarget = 'instance';

if (!rid) {
  render(root, h('div', { class: 'ov-error' }, 'No RID specified'));
} else {
  // Wire the global click delegate ONCE at module init. It uses
  // `closest('[data-action]')` etc. so it doesn't care about which children
  // are present; attaching it inside renderPane() (every state change) was
  // stacking N handlers and firing OPEN_OBJECT_VIEW N times on a single click.
  root.addEventListener('click', handleActionClick);
  void init();
}

async function init() {
  // Loading skeleton — matches the pane-loading style from sidepanel.css.
  render(root, h('div', { class: 'ov-shell' },
    h('div', { class: 'pane-loading' }, 'Loading…'),
  ));

  // Read initial context from storage (title hint while EC is in flight).
  try {
    const stored = await chrome.storage.local.get(`crev_objectview_ctx_${rid}`);
    const ctx = stored[`crev_objectview_ctx_${rid}`] as { name?: string } | undefined;
    if (ctx?.name) document.title = `${ctx.name} - CREV Object View`;
  } catch { /* storage unavailable */ }

  // Kick off the fetch — the SW responds synchronously with OBJECT_PANE_DATA
  // (no separate port message), so sendRequest is the right pattern here.
  await reloadPane();
}

async function reloadPane(): Promise<void> {
  const msg = await sendRequest({ type: 'FETCH_OBJECT_PANE', rid });
  if (!msg || msg.type !== 'OBJECT_PANE_DATA' || msg.rid !== rid) {
    state = {
      rid,
      identity: { rid, businessId: '', type: '', name: '' },
      parent: null,
      template: null,
      instanceProps: {},
      templateProps: {},
      siblings: [],
      codeFields: {},
      references: {},
      loaded: true,
      error: 'Failed to load object',
      saving: false,
      flow: null,
      flowLoading: false,
      flowError: null,
    };
    renderPane();
    return;
  }
  state = {
    rid,
    identity: msg.instance,
    parent: msg.parent,
    template: msg.template,
    instanceProps: msg.instanceProps,
    templateProps: msg.templateProps,
    siblings: msg.siblings,
    codeFields: msg.codeFields ?? {},
    flow: null,
    flowLoading: false,
    flowError: null,
    references: msg.references ?? {},
    loaded: true,
    error: (msg as any).error ?? null,
    saving: false,
  };
  if (!state.template) target = 'instance';
  document.title = `${msg.instance.name || msg.instance.businessId || rid} - CREV Object View`;
  renderPane();

  // Flow chain — the Inspect tab's anatomy view, fetched separately so the
  // pane paints first. Only for flow-bearing types (InputView, ActionButton…).
  if (msg.instance.type && hasFlow(msg.instance.type)) {
    state.flowLoading = true;
    renderPane();
    const flowMsg = await sendRequest({ type: 'FETCH_FLOW_CHAIN', rid, objectType: msg.instance.type });
    if (state && state.rid === rid) {
      state.flowLoading = false;
      if (flowMsg && flowMsg.type === 'FLOW_CHAIN_DATA') {
        state.flow = flowMsg.chain;
        state.flowError = flowMsg.error ?? null;
      } else {
        state.flowError = 'Flow fetch failed';
      }
      renderPane();
    }
  }
}

// ── Draft helpers ─────────────────────────────────────────────────

function currentServerValue(prop: string): string {
  if (!state) return '';
  return target === 'template'
    ? (state.templateProps[prop] ?? '')
    : (state.instanceProps[prop] ?? '');
}

function currentDisplayValue(prop: string): string {
  return draft[prop] ?? currentServerValue(prop);
}

function setDraft(prop: string, value: string): void {
  const server = currentServerValue(prop);
  if (value === server) delete draft[prop];
  else draft[prop] = value;
  renderPane();
}


async function discardAll(): Promise<void> {
  const n = Object.keys(draft).length;
  if (n === 0) return;
  const ok = await confirmModal({
    title: `Discard ${n} change${n === 1 ? '' : 's'}?`,
    body: 'Pending edits will be reset to the server values.',
    confirmLabel: 'Discard',
    confirmVariant: 'danger',
  });
  if (!ok) return;
  draft = {};
  renderPane();
}

async function commitSave(): Promise<void> {
  if (!state || state.saving) return;
  const props = Object.keys(draft);
  if (props.length === 0) return;

  // Diff preview before committing — same pattern as the side-panel.
  const diffRows = props.map(p => ({
    key: p,
    from: displayValue(currentServerValue(p)),
    to: displayValue(draft[p]),
  }));

  const ok = await confirmModal({
    title: `Save ${props.length} change${props.length === 1 ? '' : 's'}`,
    body: [
      `Apply changes to ${target}?`,
      h('div', { class: 'crev-modal-diff-list' },
        ...diffRows.map(r =>
          h('div', { class: 'crev-modal-diff-row' },
            h('span', { class: 'crev-modal-diff-key' }, r.key),
            h('span', { class: 'crev-modal-diff-from' }, r.from),
            h('span', { class: 'crev-modal-diff-arrow' }, '→'),
            h('span', { class: 'crev-modal-diff-to' }, r.to),
          ),
        ),
      ),
    ],
    confirmLabel: 'Save changes',
    confirmVariant: 'success',
  });
  if (!ok) return;

  const changes: Record<string, string | number | boolean> = {};
  for (const p of props) {
    const value = draft[p];
    const def = findPropDef(p);
    if (def?.kind === 'number' || def?.kind === 'slider') {
      const n = parseFloat(value);
      changes[p] = Number.isFinite(n) ? n : 0;
    } else if (def?.kind === 'boolean') {
      changes[p] = value === 'true' || value === 'TRUE';
    } else {
      changes[p] = value;
    }
  }

  state.saving = true;
  state.error = null;
  renderPane();
  const reply = await sendRequest({ type: 'APPLY_OBJECT_CHANGES', rid: state.rid, target, changes });
  if (!state) return;
  state.saving = false;
  if (reply && reply.type === 'APPLY_CHANGES_RESULT' && reply.ok) {
    draft = {};
    await reloadPane();
  } else {
    state.error = (reply && reply.type === 'APPLY_CHANGES_RESULT' ? reply.error : null) ?? 'Save failed';
    renderPane();
  }
}

// ── Rendering ─────────────────────────────────────────────────────

/** The header type badge — click copies the business id (green ✓ flash),
 *  the panel-wide badge gesture. */
function identityBadge(): HTMLElement {
  const s = state!;
  const b = typeBadge(s.identity.type);
  const id = s.identity.businessId || s.rid;
  b.title = `Copy ${id}`;
  b.classList.add('pane-id-bdg');
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    navigator.clipboard?.writeText(id).catch(() => { /* blocked — silent */ });
    const lbl = b.querySelector<HTMLElement>('.lbl');
    const orig = lbl?.textContent ?? '';
    if (lbl) lbl.textContent = '\u2713';
    b.classList.add('bdg-copied');
    setTimeout(() => { if (lbl) lbl.textContent = orig; b.classList.remove('bdg-copied'); }, 700);
  });
  return b;
}

function renderPane(): void {
  if (!state) return;
  const s = state;
  const color = getTypeColor(s.identity.type);
  const hasTemplate = !!s.template;
  const dirtyCount = Object.keys(draft).length;

  const switchTarget = async (next: SaveTarget) => {
    if (target === next) return;
    if (next === 'template' && !hasTemplate) return;
    if (Object.keys(draft).length > 0) {
      const ok = await confirmModal({
        title: 'Discard draft to switch target?',
        body: 'Switching between template and instance resets your pending edits.',
        confirmLabel: 'Switch & discard',
        confirmVariant: 'danger',
      });
      if (!ok) return;
      draft = {};
    }
    target = next;
    renderPane();
  };
  const targetToggle = h('div', { class: 'pane-target-toggle', role: 'tablist', 'aria-label': 'Save target' },
    h('button', {
      class: `pane-target-btn${target === 'instance' ? ' active' : ''}`,
      role: 'tab', 'aria-selected': target === 'instance' ? 'true' : 'false',
      onClick: () => switchTarget('instance'),
    }, 'instance'),
    h('button', {
      class: `pane-target-btn${target === 'template' ? ' active' : ''}`,
      role: 'tab', 'aria-selected': target === 'template' ? 'true' : 'false',
      disabled: !hasTemplate,
      onClick: () => switchTarget('template'),
    }, 'template'),
  );

  // Two-row header, matching the side-panel's pattern:
  //   Row 1 (context + actions): ↑parent ···· Diff · Vs Template · Layout · instance|template
  //   Row 2 (identity):          [chip] Name ······················· id
  const header = h('div', { class: 'ov-header pane-header', style: `--type-color:${color}` },
    h('div', { class: 'pane-header-nav' },
      s.parent ? renderParentCrumb(s.parent) : h('span', { class: 'pane-header-nav-spacer' }),
      h('div', { class: 'pane-header-actions' },
        h('button', { class: 'btn btn-small', 'data-action': 'diff', title: 'Compare with another object' }, 'Diff…'),
        hasTemplate
          ? h('button', { class: 'btn btn-small', 'data-action': 'template-diff', title: 'Compare instance to its template' }, 'Vs Template')
          : null,
        h('button', {
          class: 'btn btn-small',
          title: 'Test access: trace whether a user or role can read, write, add, or delete this object',
          onClick: () => openAccessTrace({ rid: s.rid, name: s.identity.name, type: s.identity.type }),
        }, 'Access ↗'),
        renderLayoutShortcut(),
        targetToggle,
      ),
    ),
    h('div', { class: 'pane-header-id' },
      identityBadge(),
      h('span', { class: 'pane-id-name' }, s.identity.name || '(unnamed)'),
      s.identity.businessId ? h('span', { class: 'pane-id-bid' }, s.identity.businessId) : null,
    ),
  );

  const propsArea = h('div', { class: 'ov-props-area' }, renderPropertiesArea());

  const treeArea = h('div', { class: 'ov-tree-area' },
    renderSiblingsSection(),
    renderTemplateSection(),
  );

  const actionBar = dirtyCount > 0 || s.saving
    ? renderActionBar(dirtyCount)
    : null;

  render(root, h('div', { class: 'ov-shell pane-shell' },
    header,
    h('div', { class: 'ov-body' }, propsArea, treeArea),
    actionBar,
  ));
}

/** "Layout ↗" button — only for layout-container types (Scorecard / TabSet /
 *  Tab / Container). Sends OPEN_LAYOUT_FOR through the SW; the side panel
 *  handler does the actual tab switch + state priming. */
function renderLayoutShortcut(): HTMLElement | null {
  const s = state;
  if (!s?.identity?.type) return null;
  // Shared resolver (see lib/layout-target.ts) — identical routing to the
  // side-panel detail view's "Layout ↗" button.
  const layout = resolveLayoutShortcut({ rid: s.rid, type: s.identity.type }, s.parent);
  // Only for objects that ARE layout containers (Scorecard / TabSet / Tab /
  // Container) — not leaf widgets routed to their parent's layout.
  if (!layout?.selfIsLayout) return null;
  return h('button', {
    class: 'btn btn-small',
    title: 'Open this object in the Page tab\'s Layout view',
    onClick: () => sendFireForget({ type: 'OPEN_LAYOUT_FOR', rid: layout.target, highlightRid: layout.highlight }),
  }, 'Layout ↗');
}

function renderParentCrumb(parent: ObjectPaneIdentity): HTMLElement {
  return h('div', {
    class: 'pane-parent-crumb',
    role: 'button',
    tabindex: '0',
    title: `Open parent: ${parent.businessId || parent.rid}`,
    onClick: () => sendFireForget({ type: 'OPEN_OBJECT_VIEW', rid: parent.rid }),
  },
    h('span', { class: 'pane-parent-crumb-arrow' }, svg(ICON_ARROW_LINE_UP)),
    typeBadge(parent.type, { size: 'xs' }),
    h('span', { class: 'pane-parent-crumb-name' }, parent.name || '(unnamed)'),
    parent.businessId
      ? h('span', { class: 'pane-parent-crumb-bid' }, parent.businessId)
      : null,
  );
}

function renderPropertiesArea(): HTMLElement {
  const s = state!;
  if (!s.loaded) return h('div', { class: 'pane-loading' }, 'Loading…');
  if (s.error && Object.keys(s.instanceProps).length === 0) {
    return h('div', { class: 'pane-error' }, s.error);
  }

  const wrap = h('div');

  // Identity meta — the Inspect tab's quiet Info grammar (dv-meta styles come
  // from the shared sidepanel.css). Copy buttons flash green like everywhere.
  const metaRow = (label: string, value: string | undefined, copyable = false) => {
    if (!value) return [];
    const valEl = h('span', { class: 'dv-meta-v mono' }, value);
    const cells: HTMLElement[] = [h('span', { class: 'dv-meta-k' }, label), valEl];
    if (copyable) {
      cells.push(h('button', {
        class: 'dv-meta-copy', title: `Copy ${label}`,
        onClick: () => {
          navigator.clipboard?.writeText(value).catch(() => { /* blocked — silent */ });
          const orig = valEl.textContent;
          valEl.textContent = '\u2713 copied';
          valEl.classList.add('dv-meta-v--ok');
          setTimeout(() => { valEl.textContent = orig; valEl.classList.remove('dv-meta-v--ok'); }, 700);
        },
      }, '\u29c9'));
    } else {
      cells.push(h('span'));
    }
    return cells;
  };
  wrap.appendChild(h('div', { class: 'dv-meta' },
    ...metaRow('Type', s.identity.type),
    ...metaRow('Business ID', s.identity.businessId, true),
    ...metaRow('RID', s.rid, true),
  ));

  const typeIsFlow = hasFlow(s.identity.type);

  // Flow — the Inspect tab's anatomy ledger, shared renderer. For flow types
  // the chain carries their code + references, so the popout's own code/links
  // sections are skipped (mirrors the Inspect rule).
  if (typeIsFlow) {
    wrap.appendChild(renderFlowSection({
      chain: s.flow,
      loading: s.flowLoading,
      error: s.flowError,
      onNavigate: (r) => { location.hash = r; },
      sendMessage: sendFireForget,
    }));
  }

  // Property groups — the popout KEEPS the layout/appearance editors (it is
  // the full-object EDITOR; on-page styling work lives in Blueprint, but this
  // surface is where deliberate property edits happen).
  wrap.appendChild(renderPropertyGroups(makeGroupsCtx()));

  if (!typeIsFlow) {
    // Richer code section — popout-only. Each code prop renders as a
    // card with its own header (label + line count + Edit) and the
    // first ~5 lines of source, EC-syntax-highlighted for `expression`,
    // plain mono for HTML / JS. Click anywhere in the snippet opens
    // the property in the floating editor.
    const codeSection = renderPopoutCodeSection();
    if (codeSection) wrap.appendChild(codeSection);

    // Links — shared with the side panel. The popout only knows curated
    // bindings (no discovered-relationship scan), so it's outgoing-only.
    const linksSection = renderLinks({
      links: { outgoing: referencesToLinks(s.identity.type, s.references), incoming: [] },
      onNavigate: (rid) => { location.hash = rid; },
    });
    if (linksSection) wrap.appendChild(linksSection);
  }

  return wrap;
}

/** Controller for the shared property-group renderer (see property-groups.ts). */
function makeGroupsCtx(): PaneGroupsCtx {
  const objectType = state!.identity.type;
  return {
    objectType,
    isAvailable: (def) => !def.availableOn || def.availableOn.has(objectType),
    displayValue: (prop) => currentDisplayValue(prop),
    serverValue: (prop) => currentServerValue(prop),
    isDirty: (prop) => draft[prop] != null,
    setDraft: (prop, value) => setDraft(prop, value),
    openColorPicker: (def, anchor, currentBid) => openColorPicker({
      anchor,
      currentBid,
      sendMessage: sendFireForget,
      onPick: (val) => setDraft(def.prop, val),
    }),
  };
}

/** Maximum lines to preview per code field. 5 is the sweet spot:
 *  enough to see the shape of an EC snippet (typical `_o := …\n
 *  _o.forEach(…)` pattern) without scrolling the panel below the
 *  fold. The full body remains available via the Edit button. */
const POPOUT_CODE_PREVIEW_LINES = 5;

function renderPopoutCodeSection(): HTMLElement | null {
  const s = state;
  if (!s) return null;
  // Stable iteration order so the card layout is deterministic:
  // expression first (most common), then html, then javascript.
  // Anything else BMP might expose (unlikely) goes in alphabetical
  // tail after these three.
  const knownOrder = ['expression', 'html', 'javascript'];
  const propNames = Object.keys(s.codeFields).filter(p => s.codeFields[p]);
  const ordered = [
    ...knownOrder.filter(p => propNames.includes(p)),
    ...propNames.filter(p => !knownOrder.includes(p)).sort(),
  ];
  if (ordered.length === 0) return null;

  return h('div', { class: 'prop-group ov-code-group' },
    h('div', { class: 'prop-group-title' }, 'Code'),
    h('div', { class: 'ov-code-cards' },
      ...ordered.map(prop => renderPopoutCodeCard(prop, s.codeFields[prop])),
    ),
  );
}

function renderPopoutCodeCard(prop: string, body: string): HTMLElement {
  const lines = body.split('\n');
  const previewLines = lines.slice(0, POPOUT_CODE_PREVIEW_LINES);
  const isEc = prop === 'expression';
  const isHidden = lines.length > POPOUT_CODE_PREVIEW_LINES;
  const studio = hasStudio(state?.identity.type);
  const openMsg = () => sendFireForget(studio
    ? { type: 'OPEN_STUDIO', rid: state!.rid, property: prop }
    : { type: 'OPEN_EDITOR', rid: state!.rid, property: prop });
  const openTitle = studio
    ? `Open .${prop} in the ${modeForType(state?.identity.type).title} (${lines.length} lines total)`
    : `Open .${prop} in the Extended Code editor (${lines.length} lines total)`;

  const codeBlock = h('pre', {
    class: 'ov-code-card-body',
    role: 'button',
    tabindex: '0',
    title: openTitle,
    onClick: openMsg,
    onKeydown: (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openMsg();
      }
    },
  });

  // EC-tokenized for `.expression`; plain mono for HTML / JS — those
  // languages have their own complex tokenizers and a lightweight
  // shim would just be wrong.
  if (isEc) {
    previewLines.forEach((line, idx) => {
      if (idx > 0) codeBlock.appendChild(document.createElement('br'));
      // Empty lines need SOME content so the <br> doesn't collapse;
      // a zero-width space keeps the height.
      if (line === '') codeBlock.appendChild(document.createTextNode('​'));
      else appendEcPreview(codeBlock, line);
    });
  } else {
    codeBlock.textContent = previewLines.join('\n');
  }

  return h('div', { class: 'ov-code-card' },
    h('div', { class: 'ov-code-card-head' },
      h('span', { class: 'ov-code-card-prop' }, prop),
      h('span', { class: 'ov-code-card-meta' },
        `${lines.length} ${lines.length === 1 ? 'line' : 'lines'}`,
      ),
      h('button', {
        class: 'btn btn-small ov-code-card-edit',
        title: `Open .${prop} in the floating editor`,
        onClick: () => sendFireForget({ type: 'OPEN_EDITOR', rid: state!.rid, property: prop }),
      }, 'Edit ↗'),
    ),
    codeBlock,
    isHidden
      ? h('div', { class: 'ov-code-card-fade' }, `+${lines.length - POPOUT_CODE_PREVIEW_LINES} more lines`)
      : null,
  );
}

function renderActionBar(dirtyCount: number): HTMLElement {
  const s = state!;
  const summary = s.saving
    ? `Saving ${dirtyCount} change${dirtyCount === 1 ? '' : 's'}…`
    : s.error
      ? s.error
      : `${dirtyCount} pending change${dirtyCount === 1 ? '' : 's'} · target: ${target}`;
  return h('div', { class: 'pane-actionbar' },
    h('span', { class: 'pane-actionbar-summary' }, summary),
    h('button', { class: 'btn', disabled: s.saving, onClick: discardAll }, 'Discard'),
    h('button', { class: 'btn btn-success', disabled: s.saving || dirtyCount === 0, onClick: commitSave }, s.saving ? 'Saving…' : 'Save'),
  );
}

function renderSiblingsSection(): HTMLElement | null {
  const s = state!;
  if (!s.siblings || s.siblings.length === 0) return null;
  return h('div', { class: 'ov-section' },
    h('div', { class: 'ov-section-title' }, `Siblings (${s.siblings.length})`),
    h('div', { class: 'ov-children' },
      ...s.siblings.map(sib =>
        h('div', { class: 'ov-child-row', 'data-open-rid': sib.rid },
          typeBadge(sib.type, { size: 'xs' }),
          h('span', { class: 'ov-child-name' }, sib.name || '(unnamed)'),
          sib.businessId ? h('span', { class: 'ov-child-bid' }, sib.businessId) : null,
        ),
      ),
    ),
  );
}

function renderTemplateSection(): HTMLElement | null {
  const s = state!;
  if (!s.template) return null;
  const tmpl = s.template;
  return h('div', { class: 'ov-section' },
    h('div', { class: 'ov-section-title' }, 'Template'),
    h('div', { class: 'ov-template-link', 'data-open-rid': tmpl.rid },
      typeBadge(tmpl.type, { size: 'xs' }),
      h('span', { class: 'ov-child-name' }, tmpl.name || 'unnamed'),
      tmpl.businessId ? h('span', { class: 'ov-child-bid' }, tmpl.businessId) : null,
    ),
  );
}

function handleActionClick(e: Event): void {
  const target = e.target as HTMLElement;

  const actionEl = target.closest<HTMLElement>('[data-action]');
  if (actionEl) {
    if (actionEl.dataset.action === 'diff') {
      sendFireForget({ type: 'OPEN_DIFF', leftRid: rid });
    }
    if (actionEl.dataset.action === 'template-diff') {
      sendFireForget({ type: 'OPEN_TEMPLATE_DIFF', rid });
    }
    return;
  }

  // Modifier-aware identity copy. Same modifier semantics as the side-panel
  // (Alt → RID, Shift → template, Ctrl → ref, plain → BID/ID).
  const copyEl = target.closest<HTMLElement>('[data-copy]');
  if (copyEl) {
    const { text } = resolveCopyText({
      rid: copyEl.dataset.copyRid ?? copyEl.dataset.copy ?? '',
      businessId: copyEl.dataset.copy,
      type: copyEl.dataset.copyType,
      templateBusinessId: copyEl.dataset.copyTmpl,
    }, getModifier(e as MouseEvent));
    if (text) {
      navigator.clipboard.writeText(text).then(() => {
        copyEl.classList.add('copied');
        setTimeout(() => copyEl.classList.remove('copied'), 800);
      }).catch(() => {});
    }
    return;
  }

  // Drill-down to template / siblings — opens a new popout per click. Each
  // window holds one object; consistent with the side-panel's drill-down
  // history but separated so multiple objects can be open at once.
  const openEl = target.closest<HTMLElement>('[data-open-rid]');
  if (openEl) {
    const openRid = openEl.dataset.openRid;
    if (openRid) sendFireForget({ type: 'OPEN_OBJECT_VIEW', rid: openRid });
  }
}
