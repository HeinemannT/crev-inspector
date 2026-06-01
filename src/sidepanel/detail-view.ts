/**
 * Object pane — split-pane editor for a single BMP object.
 *
 * Top half: typed property editors (color / number / enum / toggle / slider),
 * grouped Container · Layout · Appearance · Behavior. Dirty edits accumulate
 * into a draft; sticky action bar surfaces Discard + Save. Save → in-app
 * confirmation modal listing the diff → batched _o.change() EC call.
 *
 * Bottom half: local-neighborhood tree (parent breadcrumb · siblings ·
 * lazy children). Click any sibling/child → swaps the pane in place.
 *
 * Backed by FETCH_OBJECT_PANE / APPLY_OBJECT_CHANGES (single EC call each).
 * Works for model (.linkedTo) and enterprise (.template) objects alike.
 */

import type { BmpObject, InspectorMessage, ObjectPaneIdentity, ObjectPaneSiblingMsg } from '../lib/types';
import { getTypeColor, getTypeAbbr } from '../lib/types';
import { h, render } from '../lib/dom';
import { resolveLayoutShortcut } from '../lib/layout-target';
import { confirmModal } from '../lib/modal';
import {
  colorEditor, booleanEditor, numberEditor, enumEditor, sliderEditor,
  displayValue, type PropEditorContext,
} from './property-editors';
import { renderPaneTree, type PaneTreeData } from './pane-tree';
import { renderCodeSection } from './sections/code-fields';
import { renderReferenceSection } from './sections/reference-edges';
import { renderFlowSection } from './sections/flow-walker';
import { renderContextSection } from './sections/context-fields';
import { S } from './state';
import { LOOKUP_WATCHDOG_TIMEOUT } from '../lib/constants';
import { hasFlow } from '../lib/widget-metadata';
import type { FlowChainMsg } from '../lib/types';

type SendFn = (msg: InspectorMessage) => void;
type SaveTarget = 'instance' | 'template';

interface PaneState {
  rid: string;
  identity: ObjectPaneIdentity;
  parent: ObjectPaneIdentity | null;
  template: ObjectPaneIdentity | null;
  instanceProps: Record<string, string>;
  templateProps: Record<string, string>;
  siblings: ObjectPaneSiblingMsg[];
  codeFields: Record<string, string>;
  references: Record<string, ObjectPaneIdentity | null>;
  indirectCode: Record<string, string>;
  indirectCodeRids: Record<string, string>;
  /** Slow-load progress stage. Starts at 'normal'; bumps to 'slow' after 3s,
   *  'verySlow' after 7s. Watchdog fires at 15s and replaces loading with the
   *  timeout error. Tells the user the inspector is alive when BMP is slow,
   *  instead of staring at a silent "Loading…" for fifteen seconds. */
  loadingStage: 'normal' | 'slow' | 'verySlow';
  contextValues: Record<string, string>;
  gateValues: Record<string, string>;
  lists: Record<string, ObjectPaneIdentity[]>;
  loaded: boolean;
  error: string | null;
  /** Flow walker state. Populated when type is in FLOW_TYPES. */
  flow: FlowChainMsg | null;
  flowLoading: boolean;
  flowError: string | null;
}

interface PaneChildren {
  rid: string;
  expanded: boolean;
  loading: boolean;
  items: Array<{ rid: string; businessId?: string; name?: string; type?: string }>;
}

// Property schema lives in pane-schema.ts so the full-view popout can reuse it.
import { PROP_GROUPS, findPropDef, type PropDef } from './pane-schema';
import { requestSchema, isPropAvailable, subscribePaneSchema } from './pane-schema-runtime';

export class DetailView {
  private state: PaneState | null = null;
  /** Per-property pending edits. Empty = no changes. */
  private draft: Record<string, string> = {};
  /** Where to save edits. Mirrors the editor's pattern. */
  private target: SaveTarget = 'instance';
  /** True while APPLY_OBJECT_CHANGES is in flight. */
  private saving = false;
  /** Local tree children expansion state for the current object. */
  private childrenState: PaneChildren | null = null;
  /** Properties-area height as a percentage of the split (40..85).
   *  Default 80% — inside Workshop the DetailView is already in the
   *  bottom half of an outer split, so its OWN inner split must lean
   *  hard toward props (the user is editing) and only give the tree
   *  sub-pane (siblings/children of non-layout types) ~20% of detail
   *  height. Users who need more tree room drag the inner divider. */
  private splitPct = 80;

  private lookupTimeout: ReturnType<typeof setTimeout> | null = null;
  /** Timers that bump `state.loadingStage` from 'normal' → 'slow' → 'verySlow'
   *  at 3s / 7s so the loading row tells the user the inspector is alive when
   *  BMP is slow. Cleared on every completion path. */
  private slowLoadTimers: Array<ReturnType<typeof setTimeout>> = [];

  /** Stack of previously-viewed identities so the Back button retraces the
   *  user's drill-down AND the breadcrumb trail can render each step with its
   *  own type chip + name. Stored as identities (not bare rids) because the
   *  trail renders before the next pane's enrichment lands — we don't want a
   *  flash of "(loading…)" for chips we already know about. Cleared on tab
   *  change / new external `show()`. Capped at HISTORY_MAX with oldest-first
   *  eviction so deep drilling doesn't leak memory. */
  private history: ObjectPaneIdentity[] = [];
  private static readonly HISTORY_MAX = 50;
  /** Set the first time we have to evict the oldest history entry, so
   *  the warn() fires once per session instead of on every overflow. */
  private warnedHistoryCap = false;

  /** Active panel reference for keyboard handlers that fire outside the
   *  click → renderDetail() flow. Set in `show()`; cleared in `clear()`. */
  private activePanel: HTMLElement | null = null;

  /** AbortController for every listener attached at constructor time.
   *  Calling `destroy()` aborts the controller, which removes all
   *  listeners in one shot — no per-listener cleanup bookkeeping. */
  private readonly lifetime = new AbortController();

  constructor(
    private onBack: () => void,
    private sendMessage: SendFn,
    /** Optional callback the orchestrator wires for the header's
     *  "Layout ↗" button. Receives the rid of the layout-bearing
     *  object the user wants to jump to, plus an optional
     *  `highlightRid` for the widget whose row should flash in the
     *  layout tree (set when the user opened from a widget rather
     *  than from a Tab/Container directly). */
    private onOpenLayout?: (rid: string, highlightRid?: string) => void,
  ) {
    // Restore persisted divider position. The storage key is
    // suffixed `_v23` so stale values tuned for the pre-Workshop
    // layout (much smaller default props share) don't leak in.
    try {
      const stored = localStorage.getItem('crev_pane_split_v23');
      const n = stored ? parseFloat(stored) : NaN;
      if (Number.isFinite(n) && n >= 40 && n <= 85) this.splitPct = n;
    } catch { /* localStorage disabled, fine */ }

    // Re-render when a type schema lands (pane-schema-runtime
    // populates the cache from any active tab; we only need to
    // repaint when our pane is what's visible).
    this.unsubSchema = subscribePaneSchema(() => {
      if (!this.state || !this.activePanel) return;
      this.renderDetail(this.activePanel);
    });
  }
  private unsubSchema: () => void = () => { /* assigned in ctor */ };

  /** Remove every listener attached during the view's lifetime and
   *  drop refs to DOM nodes that would otherwise keep the panel
   *  reachable from the global listener set. Safe to call once. */
  destroy(): void {
    this.lifetime.abort();
    this.unsubSchema();
    this.activePanel = null;
    this.history = [];
    this.state = null;
  }

  isActive(): boolean {
    return this.state != null;
  }

  /** True when there are unsaved property edits. Drives the dirty-dot
   *  on the Inspect tab so the user knows there's an unsaved object
   *  even when they've switched tabs. */
  isDirty(): boolean {
    return Object.keys(this.draft).length > 0;
  }

  /** Public entry — show the pane for an object. Discards any in-flight draft.
   *  Caller should confirm if dirty before navigating (we ALSO guard internally
   *  below via confirmDirtyNavigate). New `show()` clears the history stack —
   *  this is a fresh entry, not a drill-down. */
  show(obj: BmpObject, panel: HTMLElement): void {
    this.history = [];
    this.activePanel = panel;
    this.swapTo(obj.rid, obj, panel, /* confirmIfDirty */ false);
  }

  /** Drill-down entry — called by the orchestrator when the user clicks a
   *  different pill while the detail view is already open. Preserves the
   *  history stack so Back/Breadcrumb retains the trail; confirms unsaved
   *  edits via swapTo's internal guard. */
  navigateFromExternal(rid: string, obj: BmpObject, panel: HTMLElement): void {
    this.activePanel = panel;
    this.swapTo(rid, obj, panel, /* confirmIfDirty */ true).catch(() => {
      // Swallowed — confirm modal cancel rejects the promise; the detail view
      // stays on the current object which is the desired outcome.
    });
  }

  /** Re-render the current detail view in place. Used by the orchestrator
   *  when shared state changes (e.g. FAVORITES_DATA toggles the star) but
   *  no server fetch is needed. Cheap when state is loaded; no-op otherwise. */
  refresh(panel: HTMLElement): void {
    if (!this.state) return;
    this.activePanel = panel;
    this.renderDetail(panel);
  }

  /** Navigate to a different RID (used by tree clicks). Internal.
   *  Pushes the current RID onto the history stack before swapping (unless
   *  `skipHistory` is set — used when the Back button itself rewinds), so
   *  Back returns to where the user came from. */
  private async swapTo(rid: string, hintObj: BmpObject | null, panel: HTMLElement, confirmIfDirty = true, skipHistory = false): Promise<void> {
    if (confirmIfDirty && Object.keys(this.draft).length > 0) {
      const ok = await confirmModal({
        title: 'Discard unsaved changes?',
        body: 'You have unsaved property changes. Discard and navigate?',
        confirmLabel: 'Discard & open',
        cancelLabel: 'Stay here',
        confirmVariant: 'danger',
      });
      if (!ok) return;
    }
    // Push current identity onto history before replacing state — but only
    // if it's a real change (avoid duplicate entries on accidental re-clicks).
    // Skipped when the Back button itself is unwinding. Capped at HISTORY_MAX
    // with oldest-first eviction so deep drilling doesn't leak memory.
    if (!skipHistory && this.state && this.state.rid !== rid) {
      const last = this.history[this.history.length - 1];
      if (!last || last.rid !== this.state.rid) {
        this.history.push(this.state.identity);
        if (this.history.length > DetailView.HISTORY_MAX) {
          this.history.shift();
          // Warn once per session — silently shifting means Back stops
          // reaching the user's original entry point, which is
          // surprising. Once is enough: the same session probably
          // drills many times.
          if (!this.warnedHistoryCap) {
            this.warnedHistoryCap = true;
            // eslint-disable-next-line no-console
            console.warn(`[crev:detail-view] Back history capped at ${DetailView.HISTORY_MAX} — oldest entries are being dropped.`);
          }
        }
      }
    }
    this.clearLookupWatchdog();
    this.state = {
      rid,
      identity: hintObj ? {
        rid,
        businessId: hintObj.businessId ?? '',
        type: hintObj.type ?? '',
        name: hintObj.name ?? '',
      } : { rid, businessId: '', type: '', name: '' },
      parent: null,
      template: null,
      instanceProps: {},
      templateProps: {},
      siblings: [],
      codeFields: {},
      references: {},
      indirectCode: {},
      indirectCodeRids: {},
      loadingStage: 'normal',
      contextValues: {},
      gateValues: {},
      lists: {},
      loaded: false,
      error: null,
      flow: null,
      flowLoading: false,
      flowError: null,
    };
    this.draft = {};
    this.target = 'instance';
    this.saving = false;
    this.childrenState = null;
    this.renderDetail(panel);
    // Scroll to the top of the props area on every new object. Without
    // this, a drill-down into a referenced object inherits the scroll
    // position of the previous pane — landing the user halfway down a
    // list of properties they don't yet recognise. Done AFTER render
    // so the new node exists in the DOM.
    const propsEl = panel.querySelector<HTMLElement>('.pane-props-area');
    if (propsEl) propsEl.scrollTop = 0;
    this.sendMessage({ type: 'FETCH_OBJECT_PANE', rid });
    this.startLookupWatchdog(rid, panel);
  }

  handleMessage(msg: InspectorMessage, panel: HTMLElement): boolean {
    if (!this.state) return false;
    const rid = this.state.rid;

    if (msg.type === 'OBJECT_PANE_DATA' && msg.rid === rid) {
      this.clearLookupWatchdog();
      this.state.identity = msg.instance;
      this.state.parent = msg.parent;
      this.state.template = msg.template;
      this.state.instanceProps = msg.instanceProps;
      this.state.templateProps = msg.templateProps;
      this.state.siblings = msg.siblings;
      this.state.codeFields = msg.codeFields ?? {};
      this.state.references = msg.references ?? {};
      this.state.indirectCode = msg.indirectCode ?? {};
      this.state.indirectCodeRids = msg.indirectCodeRids ?? {};
      this.state.contextValues = msg.contextValues ?? {};
      this.state.gateValues = msg.gateValues ?? {};
      this.state.lists = msg.lists ?? {};
      this.state.loaded = true;
      this.state.error = msg.error ?? null;
      // If no template available, force target back to instance
      if (!this.state.template) this.target = 'instance';
      // Trigger the flow walker fetch in parallel — only for relevant types
      if (msg.instance.type && hasFlow(msg.instance.type)) {
        this.state.flowLoading = true;
        this.state.flowError = null;
        this.sendMessage({ type: 'FETCH_FLOW_CHAIN', rid, objectType: msg.instance.type });
      } else {
        this.state.flow = null;
        this.state.flowLoading = false;
      }
      // Kick off a schema fetch so isPropAvailable can override the
      // hardcoded mixin sets once the schema lands. The response is
      // consumed in pane-schema-runtime's broadcast subscriber; we
      // re-render via subscribePaneSchema.
      if (msg.instance.type) requestSchema(msg.instance.type, this.sendMessage);
      this.renderDetail(panel);
      return true;
    }


    if (msg.type === 'FLOW_CHAIN_DATA' && msg.rid === rid) {
      this.state.flow = msg.chain;
      this.state.flowLoading = false;
      this.state.flowError = msg.error ?? null;
      this.renderDetail(panel);
      return true;
    }

    if (msg.type === 'APPLY_CHANGES_RESULT' && msg.rid === rid) {
      this.saving = false;
      if (msg.ok) {
        // Optimistic: refetch to pick up server-canonical values
        this.draft = {};
        this.sendMessage({ type: 'FETCH_OBJECT_PANE', rid });
      } else {
        // Keep draft, surface the error in the action bar
        this.state.error = msg.error ?? 'Save failed';
      }
      this.renderDetail(panel);
      return true;
    }

    if (msg.type === 'FETCH_CHILDREN_RESULT' && msg.rid === rid && this.childrenState?.rid === rid) {
      this.childrenState.items = msg.children.map(c => ({
        rid: c.rid, businessId: c.businessId, name: c.name, type: c.type,
      }));
      this.childrenState.loading = false;
      this.renderDetail(panel);
      return true;
    }

    return false;
  }

  clear(): void {
    this.clearLookupWatchdog();
    this.state = null;
    this.draft = {};
    this.saving = false;
    this.childrenState = null;
    this.activePanel = null;
  }

  // ── Watchdog ─────────────────────────────────────────────────────

  private startLookupWatchdog(rid: string, panel: HTMLElement): void {
    this.clearLookupWatchdog();
    // Stage 1: "Still loading…" after 3s. The user knows the inspector is
    // alive, not frozen. Bumps the state field and re-renders the loading
    // text only — props remain in their loading skeleton.
    this.slowLoadTimers.push(setTimeout(() => {
      if (!this.state || this.state.rid !== rid || this.state.loaded) return;
      this.state.loadingStage = 'slow';
      this.renderDetail(panel);
    }, 3_000));
    // Stage 2: "BMP is slow…" hint after 7s. Same mechanism, stronger copy.
    this.slowLoadTimers.push(setTimeout(() => {
      if (!this.state || this.state.rid !== rid || this.state.loaded) return;
      this.state.loadingStage = 'verySlow';
      this.renderDetail(panel);
    }, 7_000));
    this.lookupTimeout = setTimeout(() => {
      this.lookupTimeout = null;
      if (!this.state || this.state.rid !== rid || this.state.loaded) return;
      // Tell the SW to abort the in-flight EC — otherwise it keeps running
      // (and burning a bridge slot) for the full 30s EC timeout while the
      // user already sees the timed-out error in the pane.
      this.sendMessage({ type: 'CANCEL_FETCH_OBJECT_PANE', rid });
      this.state.loaded = true;
      this.state.error = 'Request timed out';
      this.renderDetail(panel);
    }, LOOKUP_WATCHDOG_TIMEOUT);
  }
  private clearLookupWatchdog(): void {
    if (this.lookupTimeout) { clearTimeout(this.lookupTimeout); this.lookupTimeout = null; }
    // Clear slow-load timers on every completion path (response, error,
    // timeout, swap-away) so they can't fire against stale state.
    for (const t of this.slowLoadTimers) clearTimeout(t);
    this.slowLoadTimers = [];
  }

  // ── Draft helpers ────────────────────────────────────────────────

  private currentServerValue(prop: string): string {
    if (!this.state) return '';
    return this.target === 'template'
      ? (this.state.templateProps[prop] ?? '')
      : (this.state.instanceProps[prop] ?? '');
  }

  private currentDisplayValue(prop: string): string {
    return this.draft[prop] ?? this.currentServerValue(prop);
  }

  private setDraft(prop: string, value: string, panel: HTMLElement): void {
    const server = this.currentServerValue(prop);
    if (value === server) delete this.draft[prop];
    else this.draft[prop] = value;
    this.renderDetail(panel);
  }

  private revertOne(prop: string, panel: HTMLElement): void {
    delete this.draft[prop];
    this.renderDetail(panel);
  }

  private async discardAll(panel: HTMLElement): Promise<void> {
    const n = Object.keys(this.draft).length;
    if (n === 0) return;
    const ok = await confirmModal({
      title: `Discard ${n} change${n === 1 ? '' : 's'}?`,
      body: 'Pending edits will be reset to the server values.',
      confirmLabel: 'Discard',
      confirmVariant: 'danger',
    });
    if (!ok) return;
    this.draft = {};
    this.renderDetail(panel);
  }

  private async commitSave(panel: HTMLElement): Promise<void> {
    if (!this.state || this.saving) return;
    const props = Object.keys(this.draft);
    if (props.length === 0) return;

    // Build the diff for the confirmation modal
    const diffRows: Array<{ key: string; from: string; to: string }> = [];
    for (const p of props) {
      diffRows.push({
        key: p,
        from: displayValue(this.currentServerValue(p)),
        to: displayValue(this.draft[p]),
      });
    }

    const target = this.target;
    const identity = this.state.identity;
    const tmpl = this.state.template;
    const label = target === 'template' && tmpl
      ? `template "${tmpl.name || tmpl.businessId}"`
      : `instance "${identity.name || identity.businessId}"`;

    const ok = await confirmModal({
      title: `Save ${props.length} change${props.length === 1 ? '' : 's'}`,
      body: [
        `Apply changes to ${label}?`,
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

    // Build the changes payload. The handler validates against PANE_PROPS_SET
    // and the client formats EC literals (string/number/bool aware).
    const changes: Record<string, string | number | boolean> = {};
    for (const p of props) {
      const value = this.draft[p];
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

    this.saving = true;
    this.state.error = null;
    this.renderDetail(panel);
    this.sendMessage({
      type: 'APPLY_OBJECT_CHANGES',
      rid: this.state.rid,
      target,
      changes,
    });
  }

  // ── Rendering ────────────────────────────────────────────────────

  private renderDetail(panel: HTMLElement): void {
    if (!this.state) return;
    const s = this.state;
    const color = getTypeColor(s.identity.type);
    const abbr = getTypeAbbr(s.identity.type);
    const hasTemplate = !!s.template;
    const dirtyCount = Object.keys(this.draft).length;

    // Back button — pops the history stack if non-empty (returns to previous
    // object), otherwise closes the detail view. Lives inline in the header
    // row so it visually belongs to the object (not a standalone purple bar).
    const hasHistory = this.history.length > 0;
    const backButton = h('button', {
      class: `pane-back-inline${hasHistory ? ' pane-back-inline--history' : ''}`,
      title: hasHistory ? 'Return to the previous object (Backspace)' : 'Close detail view',
      'aria-label': hasHistory ? 'Back' : 'Close',
      onClick: () => this.goBack(panel),
    }, hasHistory ? '←' : '✕');

    // Breadcrumb trail — clickable chips for every drill-down step plus the
    // current object. Replaces the text-only Back orientation; the user can
    // see how deep they are and jump to any prior step in one click.
    const trail = this.renderBreadcrumbTrail(panel);

    // Header — title row + parent crumb directly under it. Container as a
    // crumb (not a body section) puts identity context near the title and
    // frees the Flow / Code section to be the first thing under the fold.
    // Back button lives at the left edge of the title row so it reads as
    // a header control (think browser-tab back arrow), not as a separate band.
    // Header layout: identity row uses ALL the panel width (back + chip + name
    // + bid + star, name flexes to fill). Target toggle (instance | template)
    // sits on a second row below — it eats too much horizontal space sharing
    // a row with the name, especially in narrow sidebars where the name was
    // clipping to ellipsis after 6 characters.
    const isPinned = S.favoriteEntries.some(f => f.rid === s.rid);
    // "Layout ↗" — opens the layout-bearing target in the Layout tree,
    // highlighting this object's row. Shared resolver (see layout-target.ts)
    // keeps this identical to the Object View popout's shortcut.
    const layout = this.onOpenLayout
      ? resolveLayoutShortcut({ rid: s.rid, type: s.identity.type }, s.parent)
      : null;

    // "Edit ↗" — visible when the object has a code-bearing property
    // with actual content. Opens that property in the floating
    // Extended Code editor. Saves the user from scrolling down to
    // the Code section + clicking the per-row Edit button. Picks the
    // FIRST non-empty code prop (typically `expression`; for
    // CustomVisualization it falls back to `html` then `javascript`).
    const codeProps = ['expression', 'html', 'javascript'];
    const editTargetProp = codeProps.find(p => s.codeFields?.[p]);
    const showEditBtn = !!editTargetProp;
    // Header row reads as "what + where + actions":
    //   ← [chip] [name]  [Layout ↗] [Edit ↗]  [bid]  [★]
    // chip+name form the title; the action buttons hug them; bid is
    // a secondary identifier; star is the state action on the far
    // right. In narrow panels the name flex-shrinks first; bid
    // gracefully hides if it doesn't fit.
    const headerRows: HTMLElement[] = [
      h('div', { class: 'pane-header-row' },
        backButton,
        h('span', { class: 'pane-id-chip', title: s.identity.type }, abbr),
        h('span', { class: 'pane-id-name', title: s.identity.name }, s.identity.name || '(unnamed)'),
        layout
          ? h('button', {
              class: 'detail-layout-btn',
              title: layout.selfIsLayout
                ? `Open ${s.identity.type} in the Layout view`
                : `Show this ${s.identity.type || 'widget'} in its ${layout.targetType}’s Layout view`,
              onClick: () => { this.onOpenLayout!(layout.target, layout.highlight); },
            }, 'Layout ↗')
          : null,
        showEditBtn
          ? h('button', {
              class: 'detail-edit-btn',
              title: `Open .${editTargetProp} in the Extended Code editor`,
              onClick: () => this.sendMessage({ type: 'OPEN_EDITOR', rid: s.rid, property: editTargetProp! }),
            }, 'Edit ↗')
          : null,
        s.identity.businessId ? h('span', { class: 'pane-id-bid' }, s.identity.businessId) : null,
        h('button', {
          class: `detail-star${isPinned ? ' active' : ''}`,
          title: isPinned ? 'Unpin from favorites' : 'Pin to favorites',
          'aria-label': isPinned ? 'Unpin from favorites' : 'Pin to favorites',
          'aria-pressed': isPinned ? 'true' : 'false',
          onClick: () => {
            this.sendMessage({
              type: 'TOGGLE_FAVORITE',
              rid: s.rid,
              name: s.identity.name,
              objectType: s.identity.type,
              businessId: s.identity.businessId,
            });
          },
        }, isPinned ? '★' : '☆'),
      ),
      h('div', { class: 'pane-header-meta-row' },
        this.renderTargetToggle(hasTemplate, panel),
        // Type label, pushed to the right of the toggle. Shows the BMP class
        // name in muted text so the user can confirm what the chip abbreviates.
        h('span', { class: 'pane-header-type-name' }, s.identity.type || ''),
      ),
    ];
    if (s.parent) {
      headerRows.push(this.renderParentCrumb(s.parent, panel));
    }
    const header = h('div', { class: 'pane-header', style: `--type-color:${color}` }, ...headerRows);

    // Properties or loading / error
    let propsBody: HTMLElement;
    if (!s.loaded) {
      // Loading-progress copy bumps at 3s and 7s so a slow BMP doesn't look
      // like a frozen inspector. Watchdog at 15s replaces this with the
      // timeout error and cancels the in-flight EC.
      const loadingMsg = s.loadingStage === 'verySlow'
        ? 'Still loading. BMP is slow. Cancelling in a few seconds if it doesn’t respond.'
        : s.loadingStage === 'slow'
          ? 'Still loading…'
          : 'Loading…';
      propsBody = h('div', { class: `pane-loading pane-loading--${s.loadingStage}` }, loadingMsg);
    } else if (s.error && Object.keys(s.instanceProps).length === 0) {
      // Loaded but no usable data (timeout / fetch error) — show the error.
      // Save errors after a successful load also set s.error but keep the
      // props rendered; those surface in the action bar instead.
      propsBody = h('div', { class: 'pane-error' }, s.error);
    } else {
      propsBody = this.renderPropertiesArea(panel);
    }

    // Save-action bar sits sticky-bottom inside the props area, so it
    // floats above the props↔tree divider — always reachable without
    // scrolling past the sibling/children navigation below.
    const actionBar = (dirtyCount > 0 || this.saving)
      ? this.renderActionBar(panel, dirtyCount)
      : null;
    if (actionBar) actionBar.classList.add('pane-action-bar--floating');

    const propsArea = h('div', {
      class: 'pane-props-area',
      style: `flex: 0 0 ${this.splitPct}%`,
    },
      propsBody,
      actionBar,
    );

    const divider = h('div', { class: 'pane-divider', role: 'separator', 'aria-label': 'Resize divider', 'aria-valuenow': String(this.splitPct), 'aria-valuemin': '40', 'aria-valuemax': '85' });
    this.wireDivider(divider, panel);

    const treeArea = h('div', { class: 'pane-tree-area' },
      s.loaded ? this.renderTreeArea(panel) : h('div', { class: 'pane-loading' }, ''),
    );

    const split = h('div', { class: 'pane-split' }, propsArea, divider, treeArea);

    const children: (HTMLElement | null | false)[] = [
      trail,
      header,
      split,
    ];

    render(panel, h('div', { class: 'pane-shell' }, ...children.filter(Boolean) as HTMLElement[]));
    // Keep the tab-bar's dirty dot synced with the live draft state.
    // Cheap DOM mutation; the dot lives in the header so it survives
    // panel re-renders. No-op if the dot isn't in the DOM yet (boot
    // window before buildApp).
    const dot = document.getElementById('inspect-dirty-dot');
    if (dot) {
      const dirty = dirtyCount > 0;
      dot.classList.toggle('active', dirty);
      dot.title = dirty ? 'You have unsaved changes on this object' : '';
    }
  }

  private renderTargetToggle(hasTemplate: boolean, panel: HTMLElement): HTMLElement {
    return h('div', { class: 'pane-target-toggle', role: 'tablist', 'aria-label': 'Save target' },
      h('button', {
        class: `pane-target-btn${this.target === 'instance' ? ' active' : ''}`,
        role: 'tab',
        'aria-selected': this.target === 'instance' ? 'true' : 'false',
        title: 'Save to this instance only',
        onClick: async () => {
          if (this.target === 'instance') return;
          if (Object.keys(this.draft).length > 0) {
            const ok = await confirmModal({
              title: 'Discard draft to switch target?',
              body: 'Switching between template and instance resets your pending edits.',
              confirmLabel: 'Switch & discard',
              confirmVariant: 'danger',
            });
            if (!ok) return;
            this.draft = {};
          }
          this.target = 'instance';
          this.renderDetail(panel);
        },
      }, 'instance'),
      h('button', {
        class: `pane-target-btn${this.target === 'template' ? ' active' : ''}`,
        role: 'tab',
        'aria-selected': this.target === 'template' ? 'true' : 'false',
        disabled: !hasTemplate,
        title: hasTemplate ? 'Save to template: propagates to all instances' : 'No template available',
        onClick: async () => {
          if (!hasTemplate || this.target === 'template') return;
          if (Object.keys(this.draft).length > 0) {
            const ok = await confirmModal({
              title: 'Discard draft to switch target?',
              body: 'Switching between template and instance resets your pending edits.',
              confirmLabel: 'Switch & discard',
              confirmVariant: 'danger',
            });
            if (!ok) return;
            this.draft = {};
          }
          this.target = 'template';
          this.renderDetail(panel);
        },
      }, 'template'),
    );
  }

  /** Compact parent crumb under the title row. Tells you WHERE the current
   *  object lives (its container) without a full body section. Click → swap
   *  to the parent (same path the old Container chip used). */
  private renderParentCrumb(parent: ObjectPaneIdentity, panel: HTMLElement): HTMLElement {
    return h('div', {
      class: 'pane-parent-crumb',
      role: 'button',
      tabindex: '0',
      title: `Open container: ${parent.name || parent.businessId}`,
      onClick: () => this.swapTo(parent.rid, {
        rid: parent.rid,
        name: parent.name,
        type: parent.type,
        businessId: parent.businessId,
        source: 'server',
        discoveredAt: Date.now(),
        updatedAt: Date.now(),
      }, panel),
      onKeydown: (e: KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          this.swapTo(parent.rid, null, panel).catch(() => {});
        }
      },
    },
      h('span', { class: 'pane-parent-crumb-arrow' }, '↑ inside'),
      h('span', {
        class: 'pane-parent-crumb-chip',
        style: `--type-color:${getTypeColor(parent.type)}`,
      }, getTypeAbbr(parent.type)),
      h('span', { class: 'pane-parent-crumb-name' }, parent.name || '(unnamed)'),
      parent.businessId
        ? h('span', { class: 'pane-parent-crumb-bid' }, parent.businessId)
        : null,
    );
  }

  /** Pop the history stack and navigate back. Single-source for the Back
   *  button click + the Backspace shortcut so both paths stay in sync. */
  private goBack(panel: HTMLElement): void {
    if (this.history.length > 0) {
      const prev = this.history.pop()!;
      this.swapTo(prev.rid, {
        rid: prev.rid,
        businessId: prev.businessId,
        type: prev.type,
        name: prev.name,
        source: 'server',
        discoveredAt: Date.now(),
        updatedAt: Date.now(),
      }, panel, /* confirmIfDirty */ false, /* skipHistory */ true).catch(() => {});
    } else {
      this.clear();
      this.onBack();
    }
  }

  /** Clickable breadcrumb chips for the drill-down trail + the current
   *  object. Each prior step is clickable to jump back to that depth (the
   *  history above that point is preserved as a stack). The current chip is
   *  visually emphasized; long trails truncate from the left with a "…"
   *  ellipsis chip so the head fits in the pane width.
   *
   *  Returns null when there's nothing to show (no history → bare title is
   *  enough orientation; the Back button reads "Close" in that case). */
  private renderBreadcrumbTrail(panel: HTMLElement): HTMLElement | null {
    if (this.history.length === 0 || !this.state) return null;
    const current = this.state.identity;
    const items = [...this.history, current];

    // Truncate from the left if the trail is too long. Keep the FIRST chip
    // (root context) + an ellipsis + the last few. 5-chip ceiling is plenty
    // visible without wrapping.
    const MAX_CHIPS = 5;
    let truncatedHead: ObjectPaneIdentity | null = null;
    let visibleItems = items;
    if (items.length > MAX_CHIPS) {
      truncatedHead = items[0];
      visibleItems = items.slice(items.length - (MAX_CHIPS - 1));
    }

    const chips: (HTMLElement | string | null)[] = [];
    if (truncatedHead) {
      chips.push(this.renderTrailChip(truncatedHead, 0, panel, false));
      chips.push(h('span', { class: 'pane-trail-sep' }, '…'));
    }
    for (let i = 0; i < visibleItems.length; i++) {
      const step = visibleItems[i];
      const isCurrent = i === visibleItems.length - 1;
      // The "depth" we'd pop-to when clicked = position in the FULL items
      // list (not visibleItems), so click handlers truncate history correctly.
      const fullIndex = truncatedHead ? items.length - visibleItems.length + i : i;
      if (i > 0) chips.push(h('span', { class: 'pane-trail-sep' }, '›'));
      chips.push(this.renderTrailChip(step, fullIndex, panel, isCurrent));
    }
    return h('nav', {
      class: 'pane-trail',
      'aria-label': 'Object history',
    }, ...chips);
  }

  private renderTrailChip(
    step: ObjectPaneIdentity,
    depthIndex: number,
    panel: HTMLElement,
    isCurrent: boolean,
  ): HTMLElement {
    // Click on a past chip: truncate history at that depth, then navigate.
    // The clicked step becomes the new current pane; everything below it in
    // the history disappears (no forward stack — keeps the model simple).
    const onClick = isCurrent ? undefined : () => {
      this.history = this.history.slice(0, depthIndex);
      this.swapTo(step.rid, {
        rid: step.rid,
        businessId: step.businessId,
        type: step.type,
        name: step.name,
        source: 'server',
        discoveredAt: Date.now(),
        updatedAt: Date.now(),
      }, panel, /* confirmIfDirty */ false, /* skipHistory */ true).catch(() => {});
    };
    const label = step.name || step.businessId || step.type || '(unnamed)';
    return h('button', {
      class: `pane-trail-chip${isCurrent ? ' pane-trail-chip--current' : ''}`,
      title: isCurrent ? `${step.type}: ${label}` : `Jump back to ${step.type}: ${label}`,
      disabled: isCurrent,
      onClick,
    },
      h('span', {
        class: 'pane-trail-chip-type',
        style: `--type-color:${getTypeColor(step.type)}`,
      }, getTypeAbbr(step.type)),
      h('span', { class: 'pane-trail-chip-name' }, label),
    );
  }

  private renderPropertiesArea(panel: HTMLElement): HTMLElement {
    const wrap = h('div');

    const typeIsFlow = hasFlow(this.state!.identity.type);

    // Flow is the answer to "what does this widget actually do" — render it
    // FIRST for flow-bearing types so the chain (button → transport group →
    // ExtendedTransport · or · view → set → inputs) is the first thing the
    // user sees, not the last. Container + Context follow.
    if (typeIsFlow) {
      wrap.appendChild(renderFlowSection({
        chain: this.state!.flow,
        loading: this.state!.flowLoading,
        error: this.state!.flowError,
        onNavigate: (rid) => this.swapTo(rid, null, panel, true).catch(() => {}),
        sendMessage: this.sendMessage,
      }));
    }

    // Container moved to a parent-crumb in the header (renderParentCrumb)
    // so identity context lives next to the title, freeing Flow / Code to be
    // the first body section.

    // Context section — enum/boolean/list values that shape how to read the
    // other sections (actionType, persistence, useShowExpression, …). Only
    // renders when the type has populated context values.
    const ctxSection = renderContextSection({
      type: this.state!.identity.type,
      contextValues: this.state!.contextValues,
      lists: this.state!.lists,
      onNavigate: (rid) => this.swapTo(rid, null, panel, true).catch(() => {}),
    });
    if (ctxSection) wrap.appendChild(ctxSection);

    // For non-flow types, Code + References take the role the Flow section
    // does for flow types. Flow types already rendered the Flow section
    // above; their code lives inside the chain cards.
    if (!typeIsFlow) {
      const codeSection = renderCodeSection({
        type: this.state!.identity.type,
        rid: this.state!.rid,
        codeFields: this.state!.codeFields,
        indirectCode: this.state!.indirectCode,
        indirectCodeRids: this.state!.indirectCodeRids,
        gateValues: this.state!.gateValues,
        sendMessage: this.sendMessage,
      });
      if (codeSection) wrap.appendChild(codeSection);

      const refSection = renderReferenceSection({
        type: this.state!.identity.type,
        references: this.state!.references,
        onNavigate: (rid) => this.swapTo(rid, null, panel, true).catch(() => {}),
      });
      if (refSection) wrap.appendChild(refSection);
    }

    const objectType = this.state!.identity.type;

    // Property groups — for each, render visible props (those that exist on
    // server or have a draft, AND apply to this BMP type).
    for (const group of PROP_GROUPS) {
      const visibleDefs: PropDef[] = [];
      let dirtyInGroup = 0;
      for (const def of group.props) {
        // Type-availability gate — schema-cached truth when present,
        // static `availableOn` set as fallback.
        if (!isPropAvailable(objectType, def.prop, def.availableOn)) continue;
        const draftPresent = this.draft[def.prop] != null;
        const serverHas = this.currentServerValue(def.prop) !== '';
        // 'text' is read-only — only render the row when the server
        // actually has a value (otherwise we'd surface a permanent "—"
        // on every list/table widget regardless of configuration).
        const isAlwaysShown = def.kind === 'boolean' || def.kind === 'enum' || def.kind === 'slider';
        if (!serverHas && !draftPresent && !isAlwaysShown) continue;
        if (draftPresent) dirtyInGroup++;
        visibleDefs.push(def);
      }
      if (visibleDefs.length === 0) continue;

      const titleChildren: (HTMLElement | string | null)[] = [group.title];
      if (dirtyInGroup > 0) titleChildren.push(h('span', { class: 'prop-group-count' }, ` · ${dirtyInGroup} changed`));

      // Layout + Display groups render WITHOUT a title bar — the rows
      // (Width/Height, Columns triplet, etc.) are self-explanatory and
      // the title was just adding vertical clutter in the most-used
      // sections of the pane. The dirty count still surfaces, just as
      // an invisible affordance (group still flagged through styling
      // when something inside is dirty).
      const suppressTitle = group.title === 'Layout' || group.title === 'Display';

      // The Display group renders compactly: the columns triplet lives on a
      // single row, the rest of the props pack into a tight grid. Reduces
      // scroll for the common case where the user only cares about one knob.
      if (group.title === 'Display') {
        wrap.appendChild(this.renderDisplayGroup(visibleDefs, titleChildren, panel, suppressTitle));
      } else {
        wrap.appendChild(
          h('div', { class: 'prop-group' },
            suppressTitle
              ? null
              : h('div', { class: 'prop-group-title' }, ...titleChildren.filter(Boolean) as (HTMLElement | string)[]),
            ...visibleDefs.map(d => this.renderPropRow(d, panel)),
          ),
        );
      }
    }

    return wrap;
  }

  /** Compact rendering for the Display group. Columns triplet on one row,
   *  remaining props in a 2-column flex grid so booleans/enums share lines. */
  private renderDisplayGroup(defs: PropDef[], titleChildren: (HTMLElement | string | null)[], panel: HTMLElement, suppressTitle = false): HTMLElement {
    const columnsDefs = defs.filter(d =>
      d.prop === 'columnsLargeScreen' || d.prop === 'columnsMediumScreen' || d.prop === 'columnsSmallScreen',
    );
    const otherDefs = defs.filter(d => !columnsDefs.includes(d));

    const columnsRow = columnsDefs.length > 0
      ? h('div', { class: 'prop-row prop-row--columns', title: 'Responsive width: large / medium / small screens (0–6, 0 = full width)' },
          h('span', { class: 'prop-label' }, 'Columns'),
          h('div', { class: 'prop-columns-triplet' },
            ...columnsDefs.map(def => this.renderColumnCell(def, panel)),
          ),
        )
      : null;

    const otherRows = otherDefs.map(d => this.renderPropRow(d, panel));

    return h('div', { class: 'prop-group prop-group--display' },
      suppressTitle
        ? null
        : h('div', { class: 'prop-group-title' }, ...titleChildren.filter(Boolean) as (HTMLElement | string)[]),
      columnsRow,
      h('div', { class: 'prop-grid' }, ...otherRows),
    );
  }

  /** Single column-size editor — small numeric box with the L/M/S label
   *  underneath. Shares dirty styling with the rest of the property cells. */
  private renderColumnCell(def: PropDef, panel: HTMLElement): HTMLElement {
    const value = this.currentDisplayValue(def.prop);
    const original = this.currentServerValue(def.prop);
    const dirty = this.draft[def.prop] != null;
    const input = h('input', {
      class: `prop-column-input${dirty ? ' prop-cell--dirty' : ''}`,
      type: 'number',
      min: 0,
      max: 6,
      step: 1,
      value: value || '',
      'aria-label': def.label,
    }) as HTMLInputElement;
    input.addEventListener('input', () => this.setDraft(def.prop, input.value, panel));
    return h('div', {
      class: `prop-column-cell${dirty ? ' is-dirty' : ''}`,
      title: `${def.label} (server: ${original || 'none'})`,
    }, input, h('span', { class: 'prop-column-label' }, def.label));
  }

  private renderPropRow(def: PropDef, panel: HTMLElement): HTMLElement {
    const value = this.currentDisplayValue(def.prop);
    const original = this.currentServerValue(def.prop);
    const dirty = this.draft[def.prop] != null;
    const ctx: PropEditorContext = {
      value,
      original,
      dirty,
      onChange: (next) => this.setDraft(def.prop, next, panel),
    };
    let editor: HTMLElement;
    switch (def.kind) {
      case 'color':   editor = colorEditor(ctx); break;
      case 'number':  editor = numberEditor(ctx, { unit: def.unit, ...(def.range ?? {}) }); break;
      case 'enum':    editor = enumEditor(ctx, def.options ?? []); break;
      case 'boolean': editor = booleanEditor(ctx); break;
      case 'slider':  editor = sliderEditor(ctx, def.range!); break;
      case 'text':
        // Read-only display — used for structured values like
        // columnWidths where editing requires a custom UI we haven't
        // built yet. Empty values render as a dim "—" so the row still
        // tells the user "this exists but isn't set".
        editor = h('span', { class: 'prop-text-value' }, value || h('span', { class: 'prop-text-empty' }, '—'));
        break;
    }
    return h('div', { class: 'prop-row' },
      h('span', { class: 'prop-label', title: `BMP property: ${def.prop}` }, def.label),
      editor,
      dirty && def.kind !== 'text'
        ? h('button', {
            class: 'prop-revert',
            title: `Reset to ${displayValue(original)}`,
            'aria-label': 'Revert this property',
            onClick: () => this.revertOne(def.prop, panel),
          }, '↻')
        : h('span', { class: 'prop-revert', 'aria-hidden': 'true' }),
    );
  }

  private renderTreeArea(panel: HTMLElement): HTMLElement {
    const s = this.state!;
    const treeData: PaneTreeData = {
      parent: s.parent,
      current: s.identity,
      siblings: s.siblings,
      children: this.childrenState?.items,
      loadingChildren: this.childrenState?.loading,
      childrenExpanded: this.childrenState?.expanded,
    };
    return renderPaneTree(treeData, {
      onNavigate: (rid) => {
        this.swapTo(rid, null, panel, true).catch(() => {});
      },
      onToggleChildren: () => {
        if (this.childrenState?.expanded) {
          this.childrenState.expanded = false;
        } else {
          this.childrenState = {
            rid: s.rid,
            expanded: true,
            loading: !this.childrenState || this.childrenState.items.length === 0,
            items: this.childrenState?.items ?? [],
          };
          if (this.childrenState.loading) {
            this.sendMessage({ type: 'FETCH_CHILDREN', rid: s.rid });
          }
        }
        this.renderDetail(panel);
      },
    });
  }

  private renderActionBar(panel: HTMLElement, dirtyCount: number): HTMLElement {
    return h('div', { class: 'pane-actionbar' },
      h('span', { class: 'pane-actionbar-summary' },
        ...(this.state?.error
          ? [h('strong', { style: 'color: var(--danger)' }, this.state.error)]
          : [h('strong', null, String(dirtyCount)), ` pending · target: ${this.target}`]),
      ),
      h('button', {
        class: 'btn',
        disabled: this.saving,
        onClick: () => this.discardAll(panel),
      }, 'Discard'),
      h('button', {
        class: 'btn btn-success',
        disabled: this.saving || dirtyCount === 0,
        onClick: () => this.commitSave(panel),
      }, this.saving ? 'Saving…' : 'Save'),
    );
  }

  // ── Divider drag ─────────────────────────────────────────────────

  private wireDivider(handle: HTMLElement, panel: HTMLElement): void {
    let startY = 0;
    let startPct = 0;
    let dragging = false;
    const onMove = (e: PointerEvent) => {
      if (!dragging) return;
      const splitEl = panel.querySelector<HTMLElement>('.pane-split');
      if (!splitEl) return;
      const height = splitEl.getBoundingClientRect().height;
      if (height <= 0) return;
      const dy = e.clientY - startY;
      const next = clamp(startPct + (dy / height) * 100, 40, 85);
      this.splitPct = next;
      const propsEl = panel.querySelector<HTMLElement>('.pane-props-area');
      if (propsEl) propsEl.style.flex = `0 0 ${next}%`;
    };
    const finish = (e: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      try { handle.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', finish);
      handle.classList.remove('dragging');
      try { localStorage.setItem('crev_pane_split_v23', String(this.splitPct)); } catch { /* ignore */ }
    };
    handle.addEventListener('pointerdown', (e: PointerEvent) => {
      dragging = true;
      startY = e.clientY;
      startPct = this.splitPct;
      handle.setPointerCapture(e.pointerId);
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', finish);
      handle.classList.add('dragging');
    });
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}
