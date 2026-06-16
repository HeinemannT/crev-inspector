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

import type { BmpObject, InspectorMessage, ObjectPaneIdentity, ObjectPaneCard, ObjectPaneSiblingMsg } from '../lib/types';
import { getTypeColor, getTypeAbbr } from '../lib/types';
import { h, render, svg } from '../lib/dom';
import { ICON_PENCIL, ICON_LAYOUT, ICON_SHIELD, ICON_ARROW_LEFT, ICON_ARROW_LINE_UP, ICON_X } from '../lib/icons';
import { resolveLayoutShortcut } from '../lib/layout-target';
import { confirmModal } from '../lib/modal';
import { displayValue } from './property-editors';
import { openColorPicker } from './color-picker';
import { renderPaneTree, type PaneTreeData } from './pane-tree';
import { openAccessTrace } from './access-trace';
import { renderCodeSection } from './sections/code-fields';
import { renderLinks, connectionsToLinks, referencesToLinks, type LinkInbound, type LinksModel } from './sections/links';
import { referencesFor } from '../lib/widget-metadata';
import { renderPropertyGroups, type PaneGroupsCtx } from './sections/property-groups';
import { renderFlowSection } from './sections/flow-walker';
import { renderContextSection } from './sections/context-fields';
import { S } from './state';
import { LOOKUP_WATCHDOG_TIMEOUT } from '../lib/constants';
import { hasFlow } from '../lib/widget-metadata';
import type { FlowChainMsg, ConnGroup } from '../lib/types';

type SendFn = (msg: InspectorMessage) => void;
type SaveTarget = 'instance' | 'template';

interface PaneState {
  rid: string;
  identity: ObjectPaneIdentity;
  parent: ObjectPaneIdentity | null;
  template: ObjectPaneIdentity | null;
  card: ObjectPaneCard | null;
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
  /** Connections (generic ref relationships). Populated for domain objects. */
  connections: ConnGroup[] | null;
  connectionsLoading: boolean;
  /** Inbound "referenced by" scan state (lazy, via rref()). */
  inbound: LinkInbound | null;
}

interface PaneChildren {
  rid: string;
  expanded: boolean;
  loading: boolean;
  items: Array<{ rid: string; businessId?: string; name?: string; type?: string }>;
}

// Property schema lives in pane-schema.ts so the full-view popout can reuse it.
import { findPropDef } from './pane-schema';
import { requestSchema, isPropAvailable, subscribePaneSchema } from './pane-schema-runtime';
import { showToast } from '../lib/toast';

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
      card: null,
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
      connections: null,
      connectionsLoading: false,
      inbound: null,
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
      this.state.card = msg.card;
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
      // Connections (generic ref relationships) — for domain objects only;
      // widget types keep the curated References section instead.
      this.state.connections = null;
      this.state.inbound = null;
      if (msg.instance.type && referencesFor(msg.instance.type).length === 0) {
        this.state.connectionsLoading = true;
        // Offer the inbound ("referenced by") scan as a lazy button.
        this.state.inbound = { loaded: false, targets: [] };
        this.sendMessage({ type: 'FETCH_CONNECTIONS', rid, className: msg.instance.type });
      } else {
        this.state.connectionsLoading = false;
      }
      this.renderDetail(panel);
      return true;
    }

    if (msg.type === 'CONNECTIONS_RESULT' && msg.rid === rid) {
      this.state.connectionsLoading = false;
      this.state.connections = msg.ok ? (msg.groups ?? []) : null;
      this.renderDetail(panel);
      return true;
    }

    if (msg.type === 'INBOUND_RESULT' && msg.rid === rid) {
      // Dedupe against edges already shown as declared reverse refs — the
      // inbound section should surface the EXTRA (often undeclared) referrers.
      const shown = new Set<string>();
      for (const g of this.state.connections ?? []) {
        if (g.direction === 'in') for (const t of g.targets) shown.add(t.rid);
      }
      const extra = (msg.targets ?? []).filter(t => !shown.has(t.rid));
      this.state.inbound = { loaded: true, capped: msg.capped, targets: extra };
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
        // BMP's React DOM does NOT re-render on out-of-band EC writes
        // (verified live — the committed change is invisible until a full
        // page reload). Rather than fight it with a fragile per-component
        // optimistic DOM patch, offer a one-click reload of the BMP tab.
        showToast('Saved. Reload the BMP page to see it.', 'success', {
          label: 'Reload',
          onClick: () => this.sendMessage({ type: 'RELOAD_BMP_TAB' }),
        });
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
      title: hasHistory ? 'Back to the previous object' : 'Close detail view',
      'aria-label': hasHistory ? 'Back' : 'Close',
      onClick: () => this.goBack(panel),
    }, svg(hasHistory ? ICON_ARROW_LEFT : ICON_X));

    // (Path breadcrumb trail removed — the back button + the "↑ inside" parent
    // crumb are the single location model now; the trail duplicated both.)

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
    // Icon-only header actions — distinct icons + tooltips/aria. (Labels were
    // clipping the object name; the name now owns its own row below.)
    const layoutBtn = layout?.selfIsLayout
      ? h('button', {
          class: 'detail-action-btn detail-action-btn--icon',
          title: `Open ${s.identity.type} in the Layout view`,
          'aria-label': `Open ${s.identity.type} in the Layout view`,
          onClick: () => { this.onOpenLayout!(layout.target, layout.highlight); },
        }, svg(ICON_LAYOUT))
      : null;
    const editBtn = showEditBtn
      ? h('button', {
          class: 'detail-action-btn detail-action-btn--icon',
          title: `Open .${editTargetProp} in the Extended Code editor`,
          'aria-label': `Edit ${editTargetProp} in the editor`,
          onClick: () => this.sendMessage({ type: 'OPEN_EDITOR', rid: s.rid, property: editTargetProp! }),
        }, svg(ICON_PENCIL))
      : null;
    const accessBtn = h('button', {
      class: 'detail-action-btn detail-action-btn--icon',
      title: 'Test access: trace whether a user or role can read, write, add, or delete this object',
      'aria-label': 'Test access',
      onClick: () => openAccessTrace({ rid: s.rid, name: s.identity.name, type: s.identity.type }),
    }, svg(ICON_SHIELD));
    const star = h('button', {
      class: `detail-star${isPinned ? ' active' : ''}`,
      title: isPinned ? 'Unpin from favorites' : 'Pin to favorites',
      'aria-label': isPinned ? 'Unpin from favorites' : 'Pin to favorites',
      'aria-pressed': isPinned ? 'true' : 'false',
      onClick: () => {
        this.sendMessage({
          type: 'TOGGLE_FAVORITE', rid: s.rid, name: s.identity.name,
          objectType: s.identity.type, businessId: s.identity.businessId,
        });
      },
    }, isPinned ? '★' : '☆');

    // Two-row header:
    //   Row 1 (context + actions): ← back · ↑parent ·········· edit · access · instance|template
    //   Row 2 (identity):          [chip] Name ··············· id · ★
    const headerRows: HTMLElement[] = [
      h('div', { class: 'pane-header-nav' },
        backButton,
        s.parent ? this.renderParentCrumb(s.parent, panel) : null,
        h('div', { class: 'pane-header-actions' },
          layoutBtn,
          editBtn,
          accessBtn,
          this.renderTargetToggle(hasTemplate, panel),
        ),
      ),
      h('div', { class: 'pane-header-id' },
        // The pill + name open THIS object's page in the BMP portal (?rid=).
        h('button', {
          class: 'pane-id-open',
          'aria-label': 'Open in BMP',
          onClick: () => this.sendMessage({ type: 'BMP_OPEN_OBJECT', rid: s.rid }),
        },
          h('span', { class: 'pane-id-chip', title: s.identity.type }, abbr),
          h('span', { class: 'pane-id-name', title: s.identity.name }, s.identity.name || '(unnamed)'),
        ),
        s.identity.businessId ? h('span', { class: 'pane-id-bid' }, s.identity.businessId) : null,
        star,
      ),
    ];
    if (s.card) {
      headerRows.push(this.renderCardCrumb(s.card, panel));
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

  /** Inline parent reference for the header's nav row: ↑ [type chip] Name.
   *  The up-arrow + the parent's own type chip are the visual language for
   *  "this is the container" — no "inside" word needed. Click → swap to it. */
  private renderParentCrumb(parent: ObjectPaneIdentity, panel: HTMLElement): HTMLElement {
    return h('button', {
      class: 'pane-parent-inline',
      title: `Open parent: ${parent.businessId || parent.rid}`,
      onClick: () => this.swapTo(parent.rid, {
        rid: parent.rid,
        name: parent.name,
        type: parent.type,
        businessId: parent.businessId,
        source: 'server',
        discoveredAt: Date.now(),
        updatedAt: Date.now(),
      }, panel),
    },
      h('span', { class: 'pane-parent-inline-arrow', 'aria-hidden': 'true' }, svg(ICON_ARROW_LINE_UP)),
      h('span', {
        class: 'pane-parent-inline-chip',
        style: `--type-color:${getTypeColor(parent.type)}`,
      }, getTypeAbbr(parent.type)),
      h('span', { class: 'pane-parent-inline-name' }, parent.name || '(unnamed)'),
    );
  }

  /** The object's effective detail card — its own `.card`, or (for enterprise
   *  objects whose instance card is empty) the card inherited from its template.
   *  The card is the mouseover detail view; clicking opens that card OBJECT in
   *  the inspector sidebar like any other object (a quiet, muted crumb — not a
   *  special portal link). */
  private renderCardCrumb(card: ObjectPaneCard, panel: HTMLElement): HTMLElement {
    const open = () => this.swapTo(card.rid, {
      rid: card.rid, name: card.name, type: card.type, businessId: card.businessId,
      source: 'server', discoveredAt: Date.now(), updatedAt: Date.now(),
    }, panel).catch(() => {});
    return h('div', {
      class: 'pane-card-crumb',
      role: 'button',
      tabindex: '0',
      onClick: open,
      onKeydown: (e: KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
      },
    },
      h('span', { class: 'pane-card-crumb-icon' }, '▦'),
      h('span', { class: 'pane-card-crumb-name' }, card.name || '(unnamed)'),
      card.viaTemplate ? h('span', { class: 'pane-card-crumb-tag' }, 'via template') : null,
      card.businessId ? h('span', { class: 'pane-card-crumb-bid' }, card.businessId) : null,
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

      // Links — the one object-relationship section. Widget types feed their
      // curated bindings (data set, InputSet, …) as outgoing links; domain
      // types feed discovered relationships (out + in) plus the lazy inbound
      // scan. Both render in the same name-first grammar. Each row re-centers
      // the pane (one-hop graph walk).
      const linksSection = renderLinks({
        links: this.buildLinksModel(),
        onNavigate: (rid) => this.swapTo(rid, null, panel, true).catch(() => {}),
        onScanInbound: () => {
          this.state!.inbound = { loaded: false, scanning: true, targets: [] };
          this.sendMessage({ type: 'FETCH_INBOUND', rid: this.state!.rid });
          this.renderDetail(panel);
        },
      });
      if (linksSection) wrap.appendChild(linksSection);
    }


    // Property groups (Layout / Display / Appearance / Visibility / Columns) —
    // shared with the Object View popout via the single renderer below, so the
    // two surfaces can't drift. See sections/property-groups.ts.
    wrap.appendChild(renderPropertyGroups(this.makeGroupsCtx(panel)));

    return wrap;
  }

  /** Normalize this object's links into the unified model: widget types use
   *  their curated bindings (outgoing only); domain types use discovered
   *  relationships plus the lazy inbound scan. The two are mutually exclusive
   *  (curated refs exist iff the type has reference metadata). */
  private buildLinksModel(): LinksModel {
    const type = this.state!.identity.type;
    const curated = referencesToLinks(type, this.state!.references);
    if (curated.length > 0) {
      return { outgoing: curated, incoming: [] };
    }
    const { outgoing, incoming } = connectionsToLinks(this.state!.connections ?? []);
    return { outgoing, incoming, inbound: this.state!.inbound ?? undefined };
  }

  /** Build the controller the shared property-group renderer needs. */
  private makeGroupsCtx(panel: HTMLElement): PaneGroupsCtx {
    return {
      objectType: this.state!.identity.type,
      isAvailable: (def) => isPropAvailable(this.state!.identity.type, def.prop, def.availableOn),
      displayValue: (prop) => this.currentDisplayValue(prop),
      serverValue: (prop) => this.currentServerValue(prop),
      isDirty: (prop) => this.draft[prop] != null,
      setDraft: (prop, value) => this.setDraft(prop, value, panel),
      openColorPicker: (def, anchor, currentBid) => openColorPicker({
        anchor,
        currentBid,
        sendMessage: this.sendMessage,
        onPick: (val) => this.setDraft(def.prop, val, panel),
      }),
    };
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
