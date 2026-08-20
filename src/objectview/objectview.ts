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

import type {
  EditFieldPropertyResolution, ObjectPaneIdentity, ObjectPaneSiblingMsg, TypeSchemaProp,
} from '../lib/types';
import { getTypeColor } from '../lib/types';
import { intersectTypeSchemas } from '../lib/type-schema-utils';
import { typeBadge } from '../lib/type-badge';
import { h, render, svg } from '../lib/dom';
import { moveCaretToEnd } from '../lib/dom-selection';
import {
  ICON_ARROWS_LEFT_RIGHT, ICON_CARET_DOWN, ICON_CHEVRON, ICON_CODE,
  ICON_COLUMNS, ICON_COPY, ICON_CHECK, ICON_EYE, ICON_IDENTIFICATION_CARD, ICON_PENCIL,
  ICON_SHIELD_PH, ICON_SLIDERS_HORIZONTAL, ICON_TREE_STRUCTURE,
} from '../lib/icons';
import { identityBusinessIdError } from '../lib/object-identity';
import { appendEcPreview } from '../lib/ec-format';
import { installDirtyGuards } from '../editor-core/overlay';
import { sendFireForget, sendRequest, sendRequestBounded } from '../lib/messaging';
import { LOOKUP_WATCHDOG_TIMEOUT } from '../lib/constants';
import { findPropDef } from '../sidepanel/pane-schema';
import { buildChangesPayload, clearCommittedValues, paneValueEquals } from '../sidepanel/pane-edit';
import { displayValue } from '../sidepanel/property-editors';
import {
  renderPropertyElement,
  renderPropertyGroups,
  type PaneGroupsCtx,
} from '../sidepanel/sections/property-groups';
import { renderLinks, referencesToLinks } from '../sidepanel/sections/links';
import { renderFlowSection } from '../sidepanel/sections/flow-walker';
import { hasFlow } from '../lib/widget-metadata';
import { hasStudio, modeForType } from '../studio/studio-mode';
import { openAccessTrace, routeAccessMessage, initAccessTrace } from '../sidepanel/access-trace';
import { openColorPicker } from '../sidepanel/color-picker';
import { WorkspaceColorCatalogue } from '../lib/workspace-color-catalogue';
import { confirmCommandModal, confirmModal } from '../lib/modal';
import { clearCommittedResets, reconcileInstanceOverrides } from './saved-state';
import { replacePropertyElement, syncOptionalElement } from './local-update';
import { syncObjectViewInteractionLock } from './interaction-lock';
import { editFieldPropertyRelation } from '../lib/edit-field-property';

const objectViewColorCatalogue = new WorkspaceColorCatalogue();

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
document.addEventListener('click', (event) => {
  for (const menu of document.querySelectorAll<HTMLDetailsElement>('.ov-compare[open]')) {
    if (!menu.contains(event.target as Node)) menu.removeAttribute('open');
  }
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    document.querySelectorAll<HTMLDetailsElement>('.ov-compare[open]')
      .forEach(menu => menu.removeAttribute('open'));
  }
});

interface PaneState {
  environment: string;
  rid: string;
  identity: ObjectPaneIdentity;
  parent: ObjectPaneIdentity | null;
  template: ObjectPaneIdentity | null;
  instanceProps: Record<string, string>;
  templateProps: Record<string, string>;
  instanceOverrideProps: string[];
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
  /** EditField propertyMapping choices, resolved from the class(es) configured
   *  on CreateObjectViews that point at the owning EditPage. */
  editFieldClassNames: string[];
  editFieldProperties: TypeSchemaProp[] | null;
  editFieldPropertiesLoading: boolean;
  editFieldPropertiesError: string | null;
  editFieldProperty: EditFieldPropertyResolution | null;
  editFieldPropertyError: string | null;
}

type SaveTarget = 'instance' | 'template';
type IdentityProp = 'name' | 'id';
type IdentityEditLocation = 'header' | 'document';

let state: PaneState | null = null;
let draft: Record<string, string> = {};
let resetDraft = new Set<string>();
let target: SaveTarget = 'instance';
let pendingIdentityEdit: { prop: IdentityProp; location: IdentityEditLocation } | null = null;
let activePropertyEdit: string | null = null;
let outlineCleanup: (() => void) | null = null;
let loadAttempt = 0;
let loadTimers: Array<ReturnType<typeof setTimeout>> = [];

installDirtyGuards({
  isDirty: () => Object.keys(draft).length + resetDraft.size > 0,
  bodyText: 'This object view has unsaved changes. Close anyway?',
});

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

  // The title hint and authoritative BMP request are independent. Never make
  // the server request wait for extension storage.
  void chrome.storage.local.get(`crev_objectview_ctx_${rid}`).then(stored => {
    const ctx = stored[`crev_objectview_ctx_${rid}`] as { name?: string } | undefined;
    if (ctx?.name) document.title = `${ctx.name} - Companion Object View`;
  }).catch(() => { /* storage unavailable */ });

  // Kick off the fetch — the SW responds synchronously with OBJECT_PANE_DATA
  // (no separate port message), so sendRequest is the right pattern here.
  await reloadPane();
}

async function reloadPane(): Promise<void> {
  const attempt = ++loadAttempt;
  clearLoadTimers();
  renderObjectLoading('Loading…', 'normal');
  loadTimers.push(setTimeout(() => {
    if (attempt === loadAttempt) renderObjectLoading('Still loading…', 'slow');
  }, 3_000));
  loadTimers.push(setTimeout(() => {
    if (attempt === loadAttempt) {
      renderObjectLoading('Still loading. BMP is slow; waiting for the command to finish.', 'verySlow');
    }
  }, 7_000));

  let msg: Awaited<ReturnType<typeof sendRequestBounded>>;
  try {
    msg = await sendRequestBounded(
      { type: 'FETCH_OBJECT_PANE', rid },
      { timeoutMs: LOOKUP_WATCHDOG_TIMEOUT },
    );
  } catch (e) {
    if (attempt !== loadAttempt) return;
    clearLoadTimers();
    renderObjectLoadError(e instanceof Error ? e.message : 'Failed to load object');
    return;
  }
  if (attempt !== loadAttempt) return;
  clearLoadTimers();
  if (msg.type !== 'OBJECT_PANE_DATA' || msg.rid !== rid) {
    renderObjectLoadError('Failed to load object');
    return;
  }
  state = {
    environment: msg.environment,
    rid,
    identity: msg.instance,
    parent: msg.parent,
    template: msg.template,
    instanceProps: msg.instanceProps,
    templateProps: msg.templateProps,
    instanceOverrideProps: msg.instanceOverrideProps ?? [],
    siblings: msg.siblings,
    codeFields: msg.codeFields ?? {},
    flow: null,
    flowLoading: false,
    flowError: null,
    editFieldClassNames: msg.editFieldClassNames ?? [],
    editFieldProperties: null,
    editFieldPropertiesLoading: (msg.editFieldClassNames?.length ?? 0) > 0,
    editFieldPropertiesError: msg.instance.type === 'EditField' && !msg.editFieldClassNames?.length
      ? 'No owning CreateObjectView type found'
      : null,
    editFieldProperty: msg.editFieldProperty ?? null,
    editFieldPropertyError: msg.editFieldPropertyError ?? null,
    references: msg.references ?? {},
    loaded: true,
    error: (msg as any).error ?? null,
    saving: false,
  };
  activePropertyEdit = null;
  resetDraft.clear();
  if (!state.template) target = 'instance';
  document.title = `${msg.instance.name || msg.instance.businessId || rid} - Companion Object View`;
  root.removeAttribute('aria-busy');
  renderPane();
  if (state.editFieldPropertiesLoading) void loadEditFieldProperties();

  // Flow chain — the Inspect tab's anatomy view, fetched separately so the
  // pane paints first. Only for flow-bearing types (InputView, ActionButton…).
  if (msg.instance.type && hasFlow(msg.instance.type)) void loadFlow();
}

async function loadEditFieldProperties(): Promise<void> {
  const current = state;
  if (!current || current.identity.type !== 'EditField' || current.editFieldClassNames.length === 0) return;
  const expectedRid = current.rid;
  let response: Awaited<ReturnType<typeof sendRequestBounded>>;
  try {
    response = await sendRequestBounded(
      { type: 'FETCH_TYPE_SCHEMAS', classNames: current.editFieldClassNames },
      { timeoutMs: Math.max(15_000, current.editFieldClassNames.length * 10_000) },
    );
  } catch {
    if (!state || state.rid !== expectedRid) return;
    state.editFieldPropertiesLoading = false;
    state.editFieldPropertiesError = 'Could not load the object property schema';
    state.editFieldProperties = null;
    renderPane();
    return;
  }
  if (!state || state.rid !== expectedRid || state.environment !== current.environment) return;

  const schemas = response?.type === 'FETCH_TYPE_SCHEMAS_RESULT'
    && response.environment === current.environment
    ? response.results.flatMap(result => result.ok && result.props ? [result.props] : [])
    : [];
  state.editFieldPropertiesLoading = false;
  if (schemas.length !== current.editFieldClassNames.length) {
    state.editFieldPropertiesError = 'Could not load the object property schema';
    state.editFieldProperties = null;
    renderPane();
    return;
  }

  const shared = intersectTypeSchemas(schemas);
  shared.sort((a, b) =>
    Number(a.systemobject) - Number(b.systemobject)
      || (a.label || a.accessor).localeCompare(b.label || b.accessor),
  );
  state.editFieldProperties = shared;
  state.editFieldPropertiesError = shared.length === 0 ? 'No shared properties found' : null;
  renderPane();
}

function clearLoadTimers(): void {
  for (const timer of loadTimers) clearTimeout(timer);
  loadTimers = [];
}

async function loadFlow(): Promise<void> {
  if (!state || state.flowLoading || !hasFlow(state.identity.type)) return;
  const rid = state.rid;
  const objectType = state.identity.type;
  state.flowLoading = true;
  state.flowError = null;
  renderPane();
  const flowMsg = await sendRequest({ type: 'FETCH_FLOW_CHAIN', rid, objectType });
  if (!state || state.rid !== rid) return;
  state.flowLoading = false;
  if (flowMsg && flowMsg.type === 'FLOW_CHAIN_DATA') {
    state.flow = flowMsg.chain;
    state.flowError = flowMsg.error ?? null;
  } else {
    state.flowError = 'Flow fetch failed';
  }
  renderPane();
}

function renderObjectLoading(message: string, stage: 'normal' | 'slow' | 'verySlow'): void {
  root.setAttribute('aria-busy', 'true');
  render(root, h('div', { class: 'ov-shell' },
    h('div', { class: `pane-loading pane-loading--${stage}` }, message),
  ));
}

function renderObjectLoadError(message: string): void {
  root.removeAttribute('aria-busy');
  render(root, h('div', { class: 'ov-shell' },
    objectLoadErrorContent(message),
  ));
}

function objectLoadErrorContent(message: string): HTMLElement {
  return h('div', { class: 'ov-load-error' },
    h('div', { class: 'ov-error' }, message),
    h('div', { class: 'ov-load-actions' },
      h('button', { class: 'btn', 'data-action': 'retry-load' }, 'Retry'),
      h('button', { class: 'btn', 'data-action': 'reconnect-load' }, 'Reconnect'),
    ),
  );
}

// ── Draft helpers ─────────────────────────────────────────────────

function currentServerValue(prop: string): string {
  if (!state) return '';
  if (prop === 'name') {
    return target === 'template' ? (state.template?.name ?? '') : state.identity.name;
  }
  if (prop === 'id') {
    return target === 'template'
      ? (state.template?.businessId ?? '')
      : state.identity.businessId;
  }
  return target === 'template'
    ? (state.templateProps[prop] ?? '')
    : (state.instanceProps[prop] ?? '');
}

function currentDisplayValue(prop: string): string {
  if (target === 'instance' && resetDraft.has(prop) && state?.template) {
    return state.templateProps[prop] ?? '';
  }
  return draft[prop] ?? currentServerValue(prop);
}

function setDraft(prop: string, value: string): void {
  if (state?.saving) return;
  resetDraft.delete(prop);
  const server = currentServerValue(prop);
  if (paneValueEquals(prop, value, server)) delete draft[prop];
  else draft[prop] = value;
  activePropertyEdit = null;
  if (prop === 'name' || prop === 'id') {
    renderPane();
    return;
  }
  refreshProperty(prop);
  syncActionBar();
}


async function discardAll(): Promise<void> {
  if (state?.saving) return;
  const n = Object.keys(draft).length + resetDraft.size;
  if (n === 0) {
    if (state?.error) {
      state.error = null;
      renderPane();
    }
    return;
  }
  const ok = await confirmModal({
    title: `Discard ${n} change${n === 1 ? '' : 's'}?`,
    body: 'Pending edits will be reset to the server values.',
    confirmLabel: 'Discard',
    confirmVariant: 'danger',
  });
  if (!ok) return;
  const changedProps = [...new Set([...Object.keys(draft), ...resetDraft])];
  const changesIdentity = changedProps.some(prop => prop === 'name' || prop === 'id');
  draft = {};
  resetDraft.clear();
  activePropertyEdit = null;
  if (state) state.error = null;
  if (changesIdentity) {
    renderPane();
    return;
  }
  for (const prop of changedProps) refreshProperty(prop);
  syncActionBar();
}

async function commitSave(): Promise<void> {
  if (!state || state.saving) return;
  const props = Object.keys(draft);
  const resetProps = [...resetDraft];
  const saveTarget = target;
  if (props.length === 0 && resetProps.length === 0) return;

  // Diff preview before committing — same pattern as the side-panel.
  const diffRows = props.map(p => ({
    key: p,
    from: displayValue(currentServerValue(p)),
    to: displayValue(draft[p]),
  }));
  for (const prop of resetProps) {
    diffRows.push({
      key: `${prop} · reset override`,
      from: displayValue(currentServerValue(prop)),
      to: displayValue(state.templateProps[prop] ?? ''),
    });
  }
  const changesBusinessId = props.includes('id');

  const ok = await confirmCommandModal({
    title: changesBusinessId
      ? `Confirm business ID change${diffRows.length === 1 ? '' : 's'}`
      : `Save ${diffRows.length} change${diffRows.length === 1 ? '' : 's'}`,
    body: [
      `Apply changes to ${saveTarget}?`,
      changesBusinessId
        ? h('div', { class: 'ov-id-change-warning' },
          'Changing a business ID can break Extended Code, integrations, or saved references that use the old ID.',
        )
        : null,
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
    confirmLabel: changesBusinessId ? 'Change ID' : 'Save changes',
    confirmVariant: changesBusinessId ? 'danger' : 'success',
  });
  if (!ok) return;

  const committedDraft = { ...draft };
  const changes = buildChangesPayload(committedDraft);

  state.saving = true;
  state.error = null;
  syncObjectViewInteractionLock(root, true);
  syncActionBar();
  const savingState = state;
  try {
    const reply = await sendRequest({
      type: 'APPLY_OBJECT_CHANGES',
      environment: savingState.environment,
      rid: savingState.rid,
      target: saveTarget,
      changes,
      resetProps,
    });
    if (state !== savingState) return;

    if (reply && reply.type === 'APPLY_CHANGES_RESULT' && reply.ok) {
      if (saveTarget === 'instance') {
        for (const prop of props) {
          const value = committedDraft[prop];
          if (prop === 'name') state.identity.name = value;
          else if (prop === 'id') state.identity.businessId = value;
          else state.instanceProps[prop] = value;
        }
        for (const prop of resetProps) {
          state.instanceProps[prop] = state.templateProps[prop] ?? '';
        }
        state.instanceOverrideProps = reconcileInstanceOverrides(
          state.instanceOverrideProps,
          props.filter(prop => prop !== 'name' && prop !== 'id'),
          resetProps,
        );
      } else if (state.template) {
        for (const prop of props) {
          const value = committedDraft[prop];
          if (prop === 'name') state.template.name = value;
          else if (prop === 'id') state.template.businessId = value;
          else {
            state.templateProps[prop] = value;
            if (!state.instanceOverrideProps.includes(prop)) state.instanceProps[prop] = value;
          }
        }
      }

      clearCommittedValues(draft, committedDraft);
      clearCommittedResets(resetDraft, resetProps);
      activePropertyEdit = null;
      document.title = `${state.identity.name || state.identity.businessId || rid} - Companion Object View`;
      if (props.some(prop => prop === 'name' || prop === 'id')) {
        renderPane();
      } else {
        for (const prop of [...new Set([...props, ...resetProps])]) refreshProperty(prop);
      }
    } else {
      state.error = (reply && reply.type === 'APPLY_CHANGES_RESULT' ? reply.error : null)
        ?? 'No response from the extension. BMP may have saved; reload the object before retrying.';
    }
  } catch (error) {
    if (state === savingState) {
      state.error = error instanceof Error ? error.message : 'Save failed';
    }
  } finally {
    if (state === savingState) {
      state.saving = false;
      syncObjectViewInteractionLock(root, false);
      syncActionBar();
    }
  }
}

// ── Rendering ─────────────────────────────────────────────────────

/** Identity-only type badge. Copy is an explicit RID action below. */
function identityBadge(identity: ObjectPaneIdentity): HTMLElement {
  const b = typeBadge(identity.type);
  b.classList.add('pane-id-bdg');
  return b;
}

/** Blueprint-style inline rename: click the existing value (or its pencil) to
 * edit in place. Enter / outside click stages it, Escape cancels. Saving
 * remains a separate confirmed action so an accidental edit never writes to
 * BMP immediately. */
function renderEditableIdentity(
  prop: IdentityProp,
  value: string,
  location: IdentityEditLocation = 'header',
  showPencil = true,
): HTMLElement {
  const isName = prop === 'name';
  const requestEdit = (e: MouseEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    pendingIdentityEdit = { prop, location };
    renderPane();
  };
  const valueEl = h('span', {
    class: `${isName ? 'pane-id-name' : 'pane-id-bid'} ov-identity-value`,
    'data-identity-edit': `${location}-${prop}`,
    role: 'button',
    tabindex: '0',
    title: isName ? `Rename ${target}` : `Edit ${target} business ID`,
    onMousedown: requestEdit,
    onKeydown: (e: KeyboardEvent) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      pendingIdentityEdit = { prop, location };
      renderPane();
    },
  }, value || (isName ? '(unnamed)' : '(no ID)'));
  const pencil = h('button', {
    class: 'icon-btn ov-identity-pencil',
    type: 'button',
    title: isName ? `Rename ${target}` : `Edit ${target} business ID`,
    'aria-label': isName ? `Rename ${target}` : `Edit ${target} business ID`,
    onMousedown: requestEdit,
  }, svg(ICON_PENCIL));
  return h('span', {
    class: `ov-identity-field${isName ? ' ov-identity-field-name' : ''}`,
  }, valueEl, showPencil ? pencil : null);
}

function openPendingIdentityEdit(): void {
  const pending = pendingIdentityEdit;
  if (!pending) return;
  pendingIdentityEdit = null;
  const { prop, location } = pending;
  const field = root.querySelector<HTMLElement>(`[data-identity-edit="${location}-${prop}"]`);
  if (!field) return;

  const original = currentDisplayValue(prop);
  field.textContent = original;
  field.setAttribute('contenteditable', 'plaintext-only');
  field.focus({ preventScroll: true });
  if (!moveCaretToEnd(field)) return;

  let cancelled = false;
  const outside = (event: MouseEvent): void => {
    if (!field.isConnected) {
      document.removeEventListener('mousedown', outside, true);
      return;
    }
    if (event.target !== field && !field.contains(event.target as Node)) field.blur();
  };
  document.addEventListener('mousedown', outside, true);

  field.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      field.blur();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      cancelled = true;
      field.blur();
    }
  });
  field.addEventListener('blur', () => {
    document.removeEventListener('mousedown', outside, true);
    field.removeAttribute('contenteditable');
    if (cancelled) {
      renderPane();
      return;
    }

    const next = (field.textContent ?? '').trim();
    if (!next || next === original) {
      renderPane();
      return;
    }
    if (prop === 'id') {
      const error = identityBusinessIdError(next);
      if (error) {
        if (state) state.error = error;
        renderPane();
        return;
      }
    }
    if (state) state.error = null;
    setDraft(prop, next);
  }, { once: true });
}

function renderPane(): void {
  if (!state) return;
  const previousScrollTop = root.querySelector<HTMLElement>('.ov-body')?.scrollTop ?? 0;
  outlineCleanup?.();
  outlineCleanup = null;
  const s = state;
  const color = getTypeColor(s.identity.type);
  const hasTemplate = !!s.template;
  const activeIdentity = target === 'template' && s.template ? s.template : s.identity;
  const dirtyCount = Object.keys(draft).length + resetDraft.size;

  const switchTarget = async (next: SaveTarget) => {
    if (s.saving) return;
    if (target === next) return;
    if (next === 'template' && !hasTemplate) return;
    if (Object.keys(draft).length + resetDraft.size > 0) {
      const ok = await confirmModal({
        title: 'Discard draft to switch target?',
        body: 'Switching between template and instance resets your pending edits.',
        confirmLabel: 'Switch & discard',
        confirmVariant: 'danger',
      });
      if (!ok) return;
      draft = {};
      resetDraft.clear();
    }
    activePropertyEdit = null;
    target = next;
    renderPane();
  };
  const targetToggle = h('div', { class: 'pane-target-toggle', role: 'tablist', 'aria-label': 'Save target' },
    h('button', {
      class: `pane-target-btn${target === 'template' ? ' active' : ''}`,
      role: 'tab', 'aria-selected': target === 'template' ? 'true' : 'false',
      disabled: !hasTemplate,
      onClick: () => switchTarget('template'),
    }, 'Template'),
    h('button', {
      class: `pane-target-btn${target === 'instance' ? ' active' : ''}`,
      role: 'tab', 'aria-selected': target === 'instance' ? 'true' : 'false',
      onClick: () => switchTarget('instance'),
    }, 'Instance'),
  );

  // Two-row header: hierarchy + tools, then identity + source.
  const header = h('div', { class: 'ov-header pane-header', style: `--type-color:${color}` },
    h('div', { class: 'pane-header-nav' },
      renderHierarchyBreadcrumb(s.parent, s.identity),
      h('div', { class: 'pane-header-actions' },
        h('details', { class: 'ov-compare' },
          h('summary', {
            class: 'btn btn-small ov-compare-trigger',
            title: 'Compare this object',
          }, svg(ICON_ARROWS_LEFT_RIGHT), 'Compare', svg(ICON_CARET_DOWN)),
          h('div', { class: 'ov-compare-menu', role: 'menu' },
            hasTemplate
              ? h('button', {
                  class: 'ov-compare-item',
                  type: 'button',
                  role: 'menuitem',
                  'data-action': 'template-diff',
                }, svg(ICON_ARROWS_LEFT_RIGHT),
                h('span', null, 'Diff vs Template',
                  h('small', null, 'Inherited and overridden values'),
                ))
              : null,
            h('button', {
              class: 'ov-compare-item',
              type: 'button',
              role: 'menuitem',
              'data-action': 'diff',
            }, svg(ICON_ARROWS_LEFT_RIGHT),
            h('span', null, 'Diff',
              h('small', null, 'Compare with another object'),
            )),
          ),
        ),
        h('button', {
          class: 'btn btn-small',
          title: 'Test access: trace whether a user or role can read, write, add, or delete this object',
          onClick: () => openAccessTrace({ rid: s.rid, name: s.identity.name, type: s.identity.type }),
        }, svg(ICON_SHIELD_PH), 'Access'),
      ),
    ),
    h('div', { class: 'pane-header-id' },
      identityBadge(activeIdentity),
      renderEditableIdentity('name', currentDisplayValue('name')),
      renderEditableIdentity('id', currentDisplayValue('id')),
      h('div', { class: 'ov-source-control' },
        h('span', { class: 'ov-source-label' }, 'Source'),
        targetToggle,
      ),
    ),
  );

  const documentArea = renderPropertiesArea();
  const outline = renderSectionOutline(documentArea);

  const actionBar = dirtyCount > 0 || s.saving || !!s.error
    ? renderActionBar(dirtyCount)
    : null;

  render(root, h('div', { class: 'ov-shell pane-shell' },
    header,
    h('div', { class: 'ov-body' }, outline, documentArea),
    actionBar,
  ));
  syncObjectViewInteractionLock(root, s.saving);
  const body = root.querySelector<HTMLElement>('.ov-body');
  if (body) body.scrollTop = previousScrollTop;
  outlineCleanup = installSectionOutline();
  openPendingIdentityEdit();
  focusActivePropertyEditor();
}

function renderHierarchyBreadcrumb(
  parent: ObjectPaneIdentity | null,
  current: ObjectPaneIdentity,
): HTMLElement {
  return h('nav', { class: 'ov-breadcrumb', 'aria-label': 'Object hierarchy' },
    parent
      ? h('span', {
          class: 'ov-breadcrumb-continuation',
          title: 'Higher levels in the object hierarchy',
          'aria-label': 'Higher hierarchy levels omitted',
        }, '…')
      : null,
    parent ? h('span', { class: 'ov-breadcrumb-separator', 'aria-hidden': 'true' }, svg(ICON_CHEVRON)) : null,
    parent
      ? h('button', {
          class: 'ov-breadcrumb-parent',
          type: 'button',
          title: `Open parent: ${parent.businessId || parent.rid}`,
          onClick: () => sendFireForget({ type: 'OPEN_OBJECT_VIEW', rid: parent.rid }),
        },
          typeBadge(parent.type, { size: 'xs' }),
          h('span', { class: 'ov-breadcrumb-name' }, parent.name || '(unnamed)'),
          parent.businessId ? h('code', null, parent.businessId) : null,
        )
      : null,
    parent ? h('span', { class: 'ov-breadcrumb-separator', 'aria-hidden': 'true' }, svg(ICON_CHEVRON)) : null,
    h('span', { class: 'ov-breadcrumb-current', title: current.businessId || current.rid },
      current.name || current.businessId || '(unnamed)',
    ),
  );
}

function renderDocumentIdentityValue(prop: IdentityProp): HTMLElement {
  const value = currentDisplayValue(prop);
  const requestEdit = (e: Event): void => {
    e.preventDefault();
    e.stopPropagation();
    pendingIdentityEdit = { prop, location: 'document' };
    renderPane();
  };
  return h('span', {
    class: `dv-meta-v${prop === 'id' ? ' mono' : ''} ov-document-identity-value`,
    'data-identity-edit': `document-${prop}`,
    role: 'button',
    tabindex: '0',
    title: prop === 'name' ? `Rename ${target}` : `Edit ${target} business ID`,
    onMousedown: requestEdit,
    onKeydown: (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') requestEdit(e);
    },
  }, value || (prop === 'name' ? '(unnamed)' : '(no ID)'));
}

/** The shared property renderer keeps the side panel's compact group grammar.
 *  In the expanded view, promote those groups into one continuous document and
 *  split responsive columns back into the Layout section so the outline reads
 *  in the same order users think about the object. */
function decoratePropertyGroups(groups: HTMLElement): void {
  const displayGroup = groups.querySelector<HTMLElement>(':scope > [data-section-label="Display"]');
  const columnsRow = displayGroup?.querySelector<HTMLElement>(':scope > .prop-row--columns');
  if (displayGroup && columnsRow) {
    let layoutGroup = groups.querySelector<HTMLElement>(':scope > [data-section-label="Layout"]');
    if (!layoutGroup) {
      layoutGroup = h('div', {
        class: 'prop-group',
        'data-section-label': 'Layout',
      });
      groups.insertBefore(layoutGroup, displayGroup);
    }
    layoutGroup.appendChild(columnsRow);
    displayGroup.querySelector(':scope > .prop-divider')?.remove();
  }

  for (const group of groups.querySelectorAll<HTMLElement>(':scope > [data-section-label]')) {
    const rawLabel = group.dataset.sectionLabel ?? 'Properties';
    const label = rawLabel === 'Display' ? 'Behaviour' : rawLabel;
    group.dataset.sectionLabel = label;
    group.classList.add('ov-document-section');
    const title = group.querySelector<HTMLElement>(':scope > .prop-group-title');
    if (title) {
      title.classList.add('ov-document-heading');
      title.replaceChildren(...renderSectionHeadingContent(label));
    } else {
      group.insertBefore(h('div', { class: 'ov-document-heading' }, ...renderSectionHeadingContent(label)), group.firstChild);
    }
  }
}

function sectionIcon(label: string): string {
  switch (label) {
    case 'Identity': return ICON_IDENTIFICATION_CARD;
    case 'Layout': return ICON_COLUMNS;
    case 'Behaviour': return ICON_SLIDERS_HORIZONTAL;
    case 'Visibility': return ICON_EYE;
    case 'Code':
    case 'Flow': return ICON_CODE;
    case 'Relations':
    case 'References': return ICON_TREE_STRUCTURE;
    default: return ICON_SLIDERS_HORIZONTAL;
  }
}

function renderSectionHeadingContent(label: string): Array<HTMLElement | string> {
  return [
    h('span', { class: 'ov-section-icon', 'aria-hidden': 'true' }, svg(sectionIcon(label))),
    h('span', null, label),
  ];
}

function renderRelationsSection(): HTMLElement {
  const s = state!;
  const relationItems: HTMLElement[] = [];
  if (s.parent) {
    relationItems.push(
      h('button', {
        class: 'ov-relation-node',
        type: 'button',
        'data-open-rid': s.parent.rid,
        title: `Open parent ${s.parent.name || s.parent.businessId || s.parent.rid}`,
      },
        h('span', { class: 'ov-relation-node-label' }, 'Parent'),
        h('span', { class: 'ov-relation-node-value' },
          typeBadge(s.parent.type, { size: 'xs' }),
          h('span', null, s.parent.name || '(unnamed)'),
          s.parent.businessId ? h('code', null, s.parent.businessId) : null,
        ),
      ),
      h('span', { class: 'ov-relation-arrow', 'aria-hidden': 'true' }, '→'),
    );
  }
  relationItems.push(
    h('div', { class: 'ov-relation-node ov-relation-node--current' },
      h('span', { class: 'ov-relation-node-label' }, 'Current object'),
      h('span', { class: 'ov-relation-node-value' },
        typeBadge(s.identity.type, { size: 'xs' }),
        h('span', null, s.identity.name || '(unnamed)'),
        s.identity.businessId ? h('code', null, s.identity.businessId) : null,
      ),
    ),
  );
  const propertyRelation = editFieldPropertyRelation(
    s.identity.type,
    s.instanceProps.propertyMapping,
    s.editFieldProperty,
    s.editFieldPropertyError,
  );
  if (propertyRelation.kind !== 'absent') {
    relationItems.push(h('span', {
      class: 'ov-relation-arrow ov-relation-arrow--property',
      'aria-label': 'maps to property',
      title: 'propertyMapping',
    }, '→'));
    const resolved = propertyRelation.kind === 'resolved'
      ? propertyRelation.resolution
      : null;
    const propertyName = resolved?.property.name || propertyRelation.accessor;
    const meta = propertyRelation.kind === 'resolved'
      ? 'Property definition'
      : propertyRelation.error;
    relationItems.push(resolved
      ? h('button', {
          class: 'ov-relation-node ov-relation-node--property',
          type: 'button',
          'data-open-rid': resolved.property.rid,
          title: `Open mapped property ${propertyName}`,
        },
          h('span', { class: 'ov-relation-node-label' }, 'Mapped property'),
          h('span', { class: 'ov-relation-node-value' },
            typeBadge(resolved.property.type, { size: 'xs' }),
            h('span', null, propertyName),
            h('code', null, propertyRelation.accessor),
          ),
          h('span', { class: 'ov-relation-node-meta' }, meta),
        )
      : h('div', {
          class: 'ov-relation-node ov-relation-node--property is-unresolved',
          'aria-disabled': 'true',
          title: meta,
        },
          h('span', { class: 'ov-relation-node-label' }, 'Mapped property'),
          h('span', { class: 'ov-relation-node-value' },
            typeBadge('Property', { size: 'xs' }),
            h('span', null, propertyRelation.accessor),
            h('code', null, propertyRelation.accessor),
          ),
          h('span', { class: 'ov-relation-node-meta' }, meta),
        ));
  }
  const path = h('div', {
    class: `ov-relation-path ov-relation-path--${relationItems.length}`,
  }, ...relationItems);

  return h('section', {
    class: 'ov-document-section ov-relations-section',
    id: 'ov-section-relations',
    'data-section-label': 'Relations',
  },
    h('div', { class: 'ov-document-heading' }, ...renderSectionHeadingContent('Relations')),
    path,
    renderTemplateSection(),
    renderSiblingsSection(),
  );
}

function sectionSlug(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function renderSectionOutline(documentArea: HTMLElement): HTMLElement {
  const used = new Map<string, number>();
  const sections = [...documentArea.querySelectorAll<HTMLElement>(':scope > [data-section-label]')];
  return h('nav', { class: 'ov-outline', 'aria-label': 'Object sections' },
    ...sections.map((section, index) => {
      const label = section.dataset.sectionLabel ?? 'Section';
      const base = sectionSlug(label) || 'section';
      const count = used.get(base) ?? 0;
      used.set(base, count + 1);
      if (!section.id) section.id = `ov-section-${base}${count ? `-${count + 1}` : ''}`;
      return h('button', {
        class: 'ov-outline-item',
        type: 'button',
        'data-outline-target': section.id,
        'aria-current': index === 0 ? 'true' : 'false',
        onClick: () => scrollDocumentSection(section.id),
      },
        h('span', { class: 'ov-outline-icon', 'aria-hidden': 'true' }, svg(sectionIcon(label))),
        h('span', null, label),
      );
    }),
  );
}

function scrollDocumentSection(sectionId: string): void {
  const body = root.querySelector<HTMLElement>('.ov-body');
  const section = root.querySelector<HTMLElement>(`#${CSS.escape(sectionId)}`);
  if (!body || !section) return;
  const outline = root.querySelector<HTMLElement>('.ov-outline');
  const dockedOffset = outline && getComputedStyle(outline).flexDirection === 'row'
    ? outline.offsetHeight + 12
    : 16;
  const top = section.getBoundingClientRect().top
    - body.getBoundingClientRect().top
    + body.scrollTop
    - dockedOffset;
  body.scrollTo({ top, behavior: 'smooth' });
  setCurrentOutlineItem(sectionId);
}

function setCurrentOutlineItem(sectionId: string): void {
  for (const button of root.querySelectorAll<HTMLElement>('[data-outline-target]')) {
    button.setAttribute('aria-current', button.dataset.outlineTarget === sectionId ? 'true' : 'false');
  }
}

function installSectionOutline(): (() => void) | null {
  const body = root.querySelector<HTMLElement>('.ov-body');
  const sections = [...root.querySelectorAll<HTMLElement>('.ov-document > [data-section-label]')];
  if (!body || sections.length === 0) return null;

  let frame = 0;
  const update = (): void => {
    frame = 0;
    const marker = body.getBoundingClientRect().top + Math.min(120, body.clientHeight * 0.18);
    let current = sections[0];
    for (const section of sections) {
      if (section.getBoundingClientRect().top <= marker) current = section;
    }
    if (body.scrollTop + body.clientHeight >= body.scrollHeight - 2) current = sections[sections.length - 1];
    setCurrentOutlineItem(current.id);
  };
  const onScroll = (): void => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(update);
  };
  body.addEventListener('scroll', onScroll, { passive: true });
  update();
  return () => {
    body.removeEventListener('scroll', onScroll);
    cancelAnimationFrame(frame);
  };
}

function focusActivePropertyEditor(): void {
  if (!activePropertyEdit) return;
  const holder = root.querySelector<HTMLElement>(`[data-editing-prop="${CSS.escape(activePropertyEdit)}"]`);
  const control = holder?.matches('button, input, select, textarea')
    ? holder
    : holder?.querySelector<HTMLElement>('input, select, textarea, button');
  control?.focus({ preventScroll: true });
  if (control instanceof HTMLInputElement && control.type === 'text') control.select();
}

/**
 * Render the current version of one property into a detached group tree, then
 * swap only that property's DOM node into the live document. The `.ov-body`
 * scroll owner and every unrelated section remain untouched.
 */
function refreshProperty(prop: string, focus = false): void {
  const replaced = replacePropertyElement(root, prop, () => {
    const def = findPropDef(prop);
    return def ? renderPropertyElement(makeGroupsCtx(), def) : null;
  });
  if (!replaced) {
    // A property can structurally appear/disappear (for example an empty
    // auto-sized width). That rare case needs the complete section topology.
    renderPane();
    return;
  }
  if (focus) focusActivePropertyEditor();
}

function activatePropertyEditor(prop: string): void {
  if (state?.saving) return;
  const previous = activePropertyEdit;
  activePropertyEdit = prop;
  if (previous && previous !== prop) refreshProperty(previous);
  refreshProperty(prop, true);
}

/** Update only the shell footer used for pending/saving/error state. */
function syncActionBar(): void {
  if (!state) return;
  const shell = root.querySelector<HTMLElement>('.ov-shell');
  if (!shell) return;
  const dirtyCount = Object.keys(draft).length + resetDraft.size;
  const next = dirtyCount > 0 || state.saving || !!state.error
    ? renderActionBar(dirtyCount)
    : null;
  syncOptionalElement(shell, '.pane-actionbar', next);
}

function renderPropertiesArea(): HTMLElement {
  const s = state!;
  if (!s.loaded) return h('div', { class: 'pane-loading' }, 'Loading…');
  if (s.error && Object.keys(s.instanceProps).length === 0) {
    return objectLoadErrorContent(s.error);
  }

  const wrap = h('div', { class: 'ov-document' });

  // Identity meta — the Inspect tab's quiet Info grammar (dv-meta styles come
  // from the shared sidepanel.css). Copy buttons flash green like everywhere.
  const copyButton = (label: string, value: string): HTMLButtonElement => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const button = h('button', {
      class: 'dv-meta-copy',
      type: 'button',
      title: `Copy ${label}`,
      'aria-label': `Copy ${label}`,
      onClick: () => {
        navigator.clipboard?.writeText(value).catch(() => { /* blocked — silent */ });
        if (timer) clearTimeout(timer);
        button.classList.add('is-copied');
        button.replaceChildren(svg(ICON_CHECK));
        timer = setTimeout(() => {
          button.classList.remove('is-copied');
          button.replaceChildren(svg(ICON_COPY));
        }, 700);
      },
    }, svg(ICON_COPY)) as HTMLButtonElement;
    return button;
  };
  const metaRow = (label: string, value: string | undefined, copyable = false) => {
    if (!value) return [];
    return [
      h('span', { class: 'dv-meta-k' }, label),
      h('span', { class: 'dv-meta-v mono' }, value),
      copyable ? copyButton(label, value) : h('span'),
    ];
  };
  const activeIdentity = target === 'template' && s.template ? s.template : s.identity;
  const displayedName = currentDisplayValue('name');
  const displayedId = currentDisplayValue('id');
  const identityMeta = h('div', { class: 'dv-meta' },
    ...metaRow('Type', activeIdentity.type),
    h('span', { class: 'dv-meta-k' }, 'Name'),
    renderDocumentIdentityValue('name'),
    displayedName ? copyButton('name', displayedName) : h('span'),
    h('span', { class: 'dv-meta-k' }, target === 'template' ? 'Template ID' : 'Business ID'),
    renderDocumentIdentityValue('id'),
    displayedId ? copyButton(target === 'template' ? 'template ID' : 'business ID', displayedId) : h('span'),
    ...metaRow('RID', activeIdentity.rid, true),
  );
  wrap.appendChild(h('section', {
    class: 'ov-document-section ov-identity-section',
    id: 'ov-section-identity',
    'data-section-label': 'Identity',
  },
    h('div', { class: 'ov-document-heading' }, ...renderSectionHeadingContent('Identity')),
    identityMeta,
  ));

  const typeIsFlow = hasFlow(s.identity.type);

  // Flow — the Inspect tab's anatomy ledger, shared renderer. For flow types
  // the chain carries their code + references, so the popout's own code/links
  // sections are skipped (mirrors the Inspect rule).
  if (typeIsFlow) {
    const flowSection = renderFlowSection({
      chain: s.flow,
      loading: s.flowLoading,
      error: s.flowError,
      onRetry: () => { void loadFlow(); },
      onNavigate: (r) => { location.hash = r; },
      sendMessage: sendFireForget,
    });
    flowSection.classList.add('ov-document-section');
    flowSection.dataset.sectionLabel = 'Flow';
    wrap.appendChild(flowSection);
  }

  // Property groups — the popout KEEPS the layout/appearance editors (it is
  // the full-object EDITOR; on-page styling work lives in Blueprint, but this
  // surface is where deliberate property edits happen).
  const groups = renderPropertyGroups(makeGroupsCtx());
  decoratePropertyGroups(groups);
  while (groups.firstChild) wrap.appendChild(groups.firstChild);

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
    if (linksSection) {
      linksSection.classList.add('ov-document-section');
      linksSection.dataset.sectionLabel = 'References';
      wrap.appendChild(linksSection);
    }
  }

  wrap.appendChild(renderRelationsSection());
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
    isDirty: (prop) => draft[prop] != null || resetDraft.has(prop),
    isValueDirty: (prop) => draft[prop] != null,
    setDraft: (prop, value) => {
      setDraft(prop, value);
    },
    editOnDemand: {
      activeProp: activePropertyEdit,
      request: activatePropertyEditor,
    },
    cascade: {
      get: (prop) => {
        const s = state!;
        const hasTemplate = !!s.template;
        const explicitlyOverridden = target === 'instance'
          && hasTemplate
          && s.instanceOverrideProps.includes(prop);
        const resetStaged = resetDraft.has(prop);
        return {
          overridden: explicitlyOverridden,
          resetStaged,
        };
      },
      toggleReset: (prop) => {
        if (state?.saving) return;
        if (target !== 'instance' || !state?.template || !state.instanceOverrideProps.includes(prop)) return;
        if (resetDraft.has(prop)) resetDraft.delete(prop);
        else {
          resetDraft.add(prop);
          delete draft[prop];
        }
        activePropertyEdit = null;
        refreshProperty(prop);
        syncActionBar();
      },
    },
    propertyChoices: (prop) => {
      if (prop !== 'propertyMapping') return {};
      const classes = state!.editFieldClassNames;
      return {
        options: state!.editFieldProperties?.map(p => ({
          value: p.accessor,
          label: p.label && p.label !== p.accessor ? `${p.label} — ${p.accessor}` : p.accessor,
        })),
        loading: state!.editFieldPropertiesLoading,
        source: classes.join(' + '),
        error: state!.editFieldPropertiesError ?? undefined,
      };
    },
    openColorPicker: (def, anchor, currentBid) => openColorPicker({
      anchor,
      currentBid,
      catalogue: objectViewColorCatalogue,
      // Object View does not own the side-panel port, so the panel broadcast
      // cannot update this document's picker. Consume the one-shot response.
      sendMessage: (message) => {
        if (message.type !== 'FETCH_COLOR_SETS') return;
        void objectViewColorCatalogue.load(
          force => sendRequest<Extract<import('../lib/types').InspectorMessage, { type: 'COLOR_SETS_DATA' }>>({
            type: 'FETCH_COLOR_SETS',
            ...(force ? { force: true } : {}),
          }),
          message.force === true,
        );
      },
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

  return h('section', {
    class: 'prop-group ov-code-group ov-document-section',
    'data-section-label': 'Code',
  },
    h('div', { class: 'prop-group-title ov-document-heading' }, ...renderSectionHeadingContent('Code')),
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
    h('button', { class: 'btn', disabled: s.saving, onClick: discardAll }, dirtyCount === 0 ? 'Dismiss' : 'Discard'),
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
    actionEl.closest<HTMLDetailsElement>('.ov-compare')?.removeAttribute('open');
    if (actionEl.dataset.action === 'retry-load') {
      void reloadPane();
    }
    if (actionEl.dataset.action === 'reconnect-load') {
      sendFireForget({ type: 'CONNECTION_TEST' });
      void reloadPane();
    }
    if (actionEl.dataset.action === 'diff') {
      sendFireForget({ type: 'OPEN_DIFF', leftRid: rid });
    }
    if (actionEl.dataset.action === 'template-diff') {
      sendFireForget({ type: 'OPEN_TEMPLATE_DIFF', rid });
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
