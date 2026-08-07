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

import type {
  BmpObject,
  EditFieldPropertyResolution,
  InspectorMessage,
  ObjectPaneIdentity,
  ObjectPaneCard,
  ObjectPaneSiblingMsg,
  PropertyApplication,
} from '../lib/types';
import { h, render, svg, statusFlash } from '../lib/dom';
import { ICON_FILE_JS, ICON_CODE, ICON_LAYOUT, ICON_SHIELD, ICON_STAR_FILLED, ICON_STAR_HOLLOW, ICON_COPY, ICON_ARROW_OUT, ICON_CROSSHAIR, ICON_CHEVRON } from '../lib/icons';
import { resolveLayoutShortcut } from '../lib/layout-target';
import { confirmCommandModal, confirmModal } from '../lib/modal';
import { displayValue } from './property-editors';
import { renderPaneTree, type PaneTreeData } from './pane-tree';
import { typeBadge, wireBadgeCopy } from '../lib/type-badge';
import { objectChip } from '../lib/object-chip';
import { openAccessTrace } from './access-trace';
import { renderCodeSection } from './sections/code-fields';
import {
  renderLinks,
  connectionsToLinks,
  referencesToLinks,
  type LinkInbound,
  type LinksModel,
  type LinkTarget,
} from './sections/links';
import { referencesFor } from '../lib/widget-metadata';
import { renderFlowSection, type FlowPropertyOption } from './sections/flow-walker';
import { hasStudio, modeForType } from '../studio/studio-mode';
import { renderContextSection } from './sections/context-fields';
import { S } from './state';
import { LOOKUP_WATCHDOG_TIMEOUT } from '../lib/constants';
import { hasFlow, normalizeBmpEnum } from '../lib/widget-metadata';
import type { FlowChainMsg, ConnGroup } from '../lib/types';
import { renderPropertyView } from './sections/property-view';
import { panePresentation } from './pane-presentation';
import { editFieldPropertyRelation } from '../lib/edit-field-property';
import { intersectTypeSchemas } from '../lib/type-schema-utils';
import { resolveDisplayIdentity } from '../lib/object-identity';

type SendFn = (msg: InspectorMessage) => void;
type SaveTarget = 'instance' | 'template';

interface PaneState {
  environment: string;
  rid: string;
  identity: ObjectPaneIdentity;
  parent: ObjectPaneIdentity | null;
  template: ObjectPaneIdentity | null;
  card: ObjectPaneCard | null;
  instanceProps: Record<string, string>;
  templateProps: Record<string, string>;
  siblings: ObjectPaneSiblingMsg[];
  siblingTotal: number;
  codeFields: Record<string, string>;
  isPropertyDefinition: boolean;
  references: Record<string, ObjectPaneIdentity | null>;
  indirectCode: Record<string, string>;
  indirectCodeRids: Record<string, string>;
  /** Slow-load progress stage. Starts at 'normal'; bumps to 'slow' after 3s,
   *  'verySlow' after 7s. Watchdog fires after the transport deadline and replaces loading with the
   *  timeout error. Tells the user the inspector is alive when BMP is slow,
   *  instead of staring at a silent "Loading…" for fifteen seconds. */
  loadingStage: 'normal' | 'slow' | 'verySlow';
  contextValues: Record<string, string>;
  gateValues: Record<string, string>;
  lists: Record<string, ObjectPaneIdentity[]>;
  editFieldProperty: EditFieldPropertyResolution | null;
  editFieldPropertyError: string | null;
  editFieldClassNames: string[];
  propertyApplications: PropertyApplication[];
  propertyApplicationsError: string | null;
  propertyApplicationsState: 'idle' | 'loading' | 'loaded' | 'error';
  propertyApplicationsTotal: number;
  propertyApplicationsTruncated: boolean;
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
  error: string | null;
  items: Array<{ rid: string; businessId?: string; name?: string; type?: string }>;
}

// Property schema lives in pane-schema.ts so the full-view popout can reuse it.
import { buildChangesPayload, paneValueEquals } from './pane-edit';
import { consumeSchemaResult, isPropAvailable, requestSchema, requestSchemas, schemaError, schemaProps, subscribePaneSchema } from './pane-schema-runtime';
import { showToast } from '../lib/toast';
import { renderPropertyGroups, type PaneGroupsCtx } from './sections/property-groups';

export class DetailView {
  private state: PaneState | null = null;
  /** Per-property pending edits. Empty = no changes. */
  private draft: Record<string, string> = {};
  /** Where to save edits. Mirrors the editor's pattern. */
  private target: SaveTarget = 'instance';

  /** Active body segment — 'flow' is the anatomy lens (Flow chain, or Code +
   *  Links for non-flow types); 'structure' is the local tree (parent ·
   *  siblings · children); 'info' is identity metadata + context fields.
   *  Sticky across object swaps: the chosen lens is a working mode. */
  private segment: 'flow' | 'structure' | 'info' = 'flow';
  /** True while APPLY_OBJECT_CHANGES is in flight. */
  private saving = false;

  /** Local tree children expansion state for the current object. */
  private childrenState: PaneChildren | null = null;
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
    void this.swapTo(obj.rid, obj, panel, /* confirmIfDirty */ false);
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
      environment: '',
      parent: null,
      template: null,
      card: null,
      instanceProps: {},
      templateProps: {},
      siblings: [],
      siblingTotal: 0,
      codeFields: {},
      isPropertyDefinition: false,
      references: {},
      indirectCode: {},
      indirectCodeRids: {},
      loadingStage: 'normal',
      contextValues: {},
      gateValues: {},
      lists: {},
      editFieldProperty: null,
      editFieldPropertyError: null,
      editFieldClassNames: [],
      propertyApplications: [],
      propertyApplicationsError: null,
      propertyApplicationsState: 'idle',
      propertyApplicationsTotal: 0,
      propertyApplicationsTruncated: false,
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
      this.state.environment = msg.environment;
      this.state.parent = msg.parent;
      this.state.template = msg.template;
      this.state.card = msg.card;
      this.state.instanceProps = msg.instanceProps;
      this.state.templateProps = msg.templateProps;
      this.state.siblings = msg.siblings;
      this.state.siblingTotal = msg.siblingTotal ?? msg.siblings.length;
      this.state.codeFields = msg.codeFields ?? {};
      this.state.isPropertyDefinition = msg.isPropertyDefinition ?? false;
      this.state.references = msg.references ?? {};
      this.state.indirectCode = msg.indirectCode ?? {};
      this.state.indirectCodeRids = msg.indirectCodeRids ?? {};
      this.state.contextValues = msg.contextValues ?? {};
      this.state.gateValues = msg.gateValues ?? {};
      this.state.lists = msg.lists ?? {};
      this.state.editFieldProperty = msg.editFieldProperty ?? null;
      this.state.editFieldPropertyError = msg.editFieldPropertyError ?? null;
      this.state.editFieldClassNames = msg.editFieldClassNames ?? [];
      this.state.propertyApplications = msg.propertyApplications ?? [];
      this.state.propertyApplicationsError = msg.propertyApplicationsError ?? null;
      this.state.propertyApplicationsState = msg.propertyApplications !== undefined
        ? 'loaded'
        : msg.propertyApplicationsError
          ? 'error'
          : 'idle';
      this.state.propertyApplicationsTotal = msg.propertyApplicationsTotal ?? this.state.propertyApplications.length;
      this.state.propertyApplicationsTruncated = msg.propertyApplicationsTruncated ?? false;
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
      // The Property view is read-only and has its own fixed definition
      // fields. MethodConfig schema lookup is both unused here and unsupported
      // by some BMP versions, where it would leave a misleading
      // "Field load failed" status after an otherwise successful load.
      const presentation = panePresentation(
        msg.instance.type,
        this.state.isPropertyDefinition,
      );
      if (msg.instance.type && presentation.requestSchema) {
        requestSchema(msg.instance.type, this.sendMessage);
      }
      if (msg.instance.type === 'EditField') {
        requestSchemas(this.state.editFieldClassNames, this.sendMessage);
      }
      // Connections (generic ref relationships) — for domain objects only;
      // widget types keep the curated References section instead.
      this.state.connections = null;
      this.state.inbound = null;
      if (
        msg.instance.type
        && referencesFor(msg.instance.type).length === 0
        && !presentation.customRelationships
      ) {
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

    if (msg.type === 'PROPERTY_APPLICATIONS_RESULT' && msg.rid === rid) {
      if (msg.environment !== this.state.environment) return true;
      this.state.propertyApplicationsState = msg.ok ? 'loaded' : 'error';
      if (msg.ok) this.state.propertyApplications = msg.applications ?? [];
      this.state.propertyApplicationsTotal = msg.total ?? this.state.propertyApplications.length;
      this.state.propertyApplicationsTruncated = msg.truncated ?? false;
      this.state.propertyApplicationsError = msg.ok ? null : (msg.error ?? 'Property applications unavailable');
      this.renderDetail(panel);
      return true;
    }

    if (
      msg.type === 'FETCH_TYPE_SCHEMA_RESULT'
      && this.state.identity.type === 'EditField'
      && this.state.editFieldClassNames.includes(msg.className)
    ) {
      if (!schemaProps(msg.className) && !schemaError(msg.className)) consumeSchemaResult(msg);
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
      const outgoing = (this.state.connections ?? [])
        .filter(group => group.direction === 'out');
      const incoming = msg.ok ? (msg.groups ?? []) : [];
      this.state.connections = [...outgoing, ...incoming];
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
      if (msg.chain?.objectTypes?.length) {
        requestSchemas(msg.chain.objectTypes, this.sendMessage);
      }
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
      this.childrenState.error = msg.error ?? null;
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
      // This is a lost-response guard, not a server cancellation. BMP has no
      // reliable EC timeout and can keep running after the client detaches.
      this.state.loaded = true;
      this.state.error = 'Request timed out locally after 35 seconds. BMP may still be finishing it; retrying will reuse the active request.';
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

  private retryLoad(panel: HTMLElement, reconnect: boolean): void {
    if (!this.state) return;
    const rid = this.state.rid;
    this.clearLookupWatchdog();
    this.state.loaded = false;
    this.state.error = null;
    this.state.loadingStage = 'normal';
    if (reconnect) this.sendMessage({ type: 'CONNECTION_TEST' });
    this.sendMessage({ type: 'FETCH_OBJECT_PANE', rid });
    this.startLookupWatchdog(rid, panel);
    this.renderDetail(panel);
  }

  // ── Draft helpers ────────────────────────────────────────────────

  private currentServerValue(prop: string): string {
    if (!this.state) return '';
    return this.target === 'template'
      ? (this.state.templateProps[prop] ?? '')
      : (this.state.instanceProps[prop] ?? '');
  }

  // NOTE: the draft/save pipeline (draft map, action bar, APPLY_OBJECT_CHANGES)
  // stays although property groups moved to Blueprint — future editors (name,
  // context fields) will feed it. The per-editor helpers went with the groups.

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

    const ok = await confirmCommandModal({
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
    // and the client formats EC literals (string/number/bool aware). The
    // schema-driven coercion is shared with the StyleTab via buildChangesPayload.
    const changes = buildChangesPayload(this.draft);

    this.saving = true;
    this.state.error = null;
    this.renderDetail(panel);
    this.sendMessage({
      type: 'APPLY_OBJECT_CHANGES',
      environment: this.state.environment,
      rid: this.state.rid,
      target,
      changes,
    });
  }

  // ── Rendering ────────────────────────────────────────────────────

  /** The header type badge — click copies the primary display id (green ✓ flash),
   *  the panel-wide badge gesture. */
  private identityBadge(
    rid: string,
    businessId: string | undefined,
    templateBusinessId: string | undefined,
    type: string | undefined,
  ): HTMLElement {
    const display = resolveDisplayIdentity({ rid, businessId, templateBusinessId });
    const b = wireBadgeCopy(typeBadge(type), () => display.primary, {
      onCopied: copied => statusFlash(`Copied ${copied} \u2713`),
    });
    b.classList.add('pane-id-bdg');
    return b;
  }

  private renderDetail(panel: HTMLElement): void {
    if (!this.state) return;
    const s = this.state;
    const hasTemplate = !!s.template;
    const dirtyCount = Object.keys(this.draft).length;

    // Back button — pops the history stack if non-empty (returns to previous
    // object), otherwise closes the detail view. Lives inline in the header
    // row so it visually belongs to the object (not a standalone purple bar).
    const hasHistory = this.history.length > 0;
    // Always the quiet ‹ arrow (the mock's tasteful back) — with no history
    // it closes the detail, same semantics, no jarring ✕.
    const backButton = h('button', {
      class: 'dv-path-back',
      title: hasHistory ? 'Back to the previous object' : 'Close detail view',
      'aria-label': hasHistory ? 'Back' : 'Close',
      onClick: () => this.goBack(panel),
    }, svg(ICON_CHEVRON));

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
          class: 'dv-act',
          title: `Open ${s.identity.type} in the Layout view`,
          'aria-label': `Open ${s.identity.type} in the Layout view`,
          onClick: () => { this.onOpenLayout!(layout.target, layout.highlight); },
        }, svg(ICON_LAYOUT))
      : null;
    // CustomVisualization routes to the CVO studio (html/js + live preview)
    // instead of the EC editor; every other code-bearing type opens the editor.
    const studio = hasStudio(s.identity.type);
    const studioTitle = modeForType(s.identity.type).title;
    const editBtn = showEditBtn
      ? h('button', {
          class: 'dv-act',
          title: studio ? `Open in the ${studioTitle}` : `Open .${editTargetProp} in the Extended Code editor`,
          'aria-label': studio ? `Open in the ${studioTitle}` : `Edit ${editTargetProp} in the editor`,
          onClick: () => this.sendMessage(studio
            ? { type: 'OPEN_STUDIO', rid: s.rid, property: editTargetProp! }
            : { type: 'OPEN_EDITOR', rid: s.rid, property: editTargetProp! }),
        }, svg(studio ? ICON_FILE_JS : ICON_CODE))
      : null;
    const accessBtn = h('button', {
      class: 'dv-act',
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
          templateBusinessId: s.template?.businessId,
        });
      },
    }, svg(isPinned ? ICON_STAR_FILLED : ICON_STAR_HOLLOW));

    // Header per the Path-Spine sign-off (inspect-ledger.html):
    //   Path bar:  ‹ · parent / Current(bold)
    //   Identity:  [badge] Name ············ template|instance target
    //   Sub row:   Type ·················· open · layout · edit · access · ★
    const curLabel = s.identity.name || s.identity.businessId || '(unnamed)';
    const parentLabel = s.parent ? (s.parent.name || s.parent.businessId || '(unnamed)') : null;
    const pathBar = h('div', { class: 'dv-path' },
      backButton,
      s.parent ? h('button', {
        class: 'dv-crumb',
        title: `Open parent: ${s.parent.businessId || s.parent.rid}`,
        onClick: () => this.swapTo(s.parent!.rid, {
          rid: s.parent!.rid, name: s.parent!.name, type: s.parent!.type,
          businessId: s.parent!.businessId,
          source: 'server', discoveredAt: Date.now(), updatedAt: Date.now(),
        }, panel).catch(() => {}),
      }, parentLabel) : null,
      s.parent ? h('span', { class: 'dv-path-sep' }, '/') : null,
      h('span', { class: 'dv-path-cur', title: curLabel }, curLabel),
      h('span', { class: 'dv-sp' }),
      // Context picker ⌖ — right end of the path bar, per the mock. Arms the
      // layout pane's picker (it owns the pick flow).
      h('button', {
        class: 'dv-path-pick',
        title: 'Pick an element on the page to set as context',
        'aria-label': 'Pick context on page',
        onClick: () => document.dispatchEvent(new CustomEvent('crev:arm-context-picker')),
      }, svg(ICON_CROSSHAIR)),
    );
    const openBmpBtn = h('button', {
      class: 'dv-act',
      title: 'Open in web (new tab)',
      'aria-label': 'Open in web',
      onClick: () => this.sendMessage({ type: 'BMP_OPEN_OBJECT', rid: s.rid }),
    }, svg(ICON_ARROW_OUT));
    const header = h('div', { class: 'dv-header' },
      pathBar,
      h('div', { class: 'dv-idrow' },
        this.identityBadge(s.rid, s.identity.businessId, s.template?.businessId, s.identity.type),
        h('span', { class: 'dv-idname', title: s.identity.name }, curLabel),
        panePresentation(s.identity.type, s.isPropertyDefinition).showTargetToggle
          ? this.renderTargetToggle(hasTemplate, panel)
          : null,
      ),
      h('div', { class: 'dv-subrow' },
        h('span', { class: 'dv-subtype' }, s.identity.type ?? ''),
        h('span', { class: 'dv-sp' }),
        openBmpBtn,
        layoutBtn,
        editBtn,
        accessBtn,
        star,
      ),
    );

    // Properties or loading / error
    let propsBody: HTMLElement;
    if (!s.loaded) {
      // Loading-progress copy bumps at 3s and 7s so a slow BMP doesn't look
      // like a frozen inspector. Watchdog at 15s replaces this with the
      // lost-response guard without claiming server-side cancellation.
      const loadingMsg = s.loadingStage === 'verySlow'
        ? 'Still loading. BMP is slow; waiting for the command to finish.'
        : s.loadingStage === 'slow'
          ? 'Still loading…'
          : 'Loading…';
      propsBody = h('div', { class: `pane-loading pane-loading--${s.loadingStage}` }, loadingMsg);
    } else if (s.error && Object.keys(s.instanceProps).length === 0) {
      // Loaded but no usable data (timeout / fetch error) — show the error.
      // Save errors after a successful load also set s.error but keep the
      // props rendered; those surface in the action bar instead.
      const connectionError = /timed out|cannot reach|network|command|connection/i.test(s.error);
      propsBody = h('div', { class: 'pane-error' },
        h('div', {}, s.error),
        h('div', { class: 'pane-error-actions' },
          h('button', {
            class: 'btn btn-small',
            onClick: () => this.retryLoad(panel, false),
          }, 'Retry'),
          connectionError
            ? h('button', {
              class: 'btn btn-small',
              onClick: () => this.retryLoad(panel, true),
            }, 'Reconnect')
            : null,
        ),
      );
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

    // Single scroll area — the tree lives in the Structure segment now, so
    // the inner props↔tree splitter is gone (Path-Spine sign-off).
    const propsArea = h('div', { class: 'pane-props-area pane-props-area--full' },
      propsBody,
      actionBar,
    );

    render(panel, h('div', { class: 'pane-shell' }, header, propsArea));
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
    );
  }

  /** Inline parent reference for the header's nav row: ↑ [type chip] Name.
   *  The up-arrow + the parent's own type chip are the visual language for
   *  "this is the container" — no "inside" word needed. Click → swap to it. */
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
    return objectChip(card, {
      size: 'xs',
      className: 'pane-card-crumb',
      showId: true,
      annotation: card.viaTemplate ? 'via template' : undefined,
      onActivate: () => { void open(); },
      onOpenFull: () => { void open(); },
    });
  }

  private loadPropertyApplications(panel: HTMLElement): void {
    if (!this.state || this.state.propertyApplicationsState === 'loading') return;
    this.state.propertyApplicationsState = 'loading';
    this.state.propertyApplicationsError = null;
    this.renderDetail(panel);
    this.sendMessage({
      type: 'FETCH_PROPERTY_APPLICATIONS',
      rid: this.state.rid,
      environment: this.state.environment,
    });
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
    if (panePresentation(
      this.state!.identity.type,
      this.state!.isPropertyDefinition,
    ).body === 'property') {
      return renderPropertyView({
        identity: this.state!.identity,
        templateBusinessId: this.state!.template?.businessId,
        props: this.state!.instanceProps,
        codeFields: this.state!.codeFields,
        applications: this.state!.propertyApplications,
        applicationsError: this.state!.propertyApplicationsError,
        applicationsState: this.state!.propertyApplicationsState,
        applicationsTotal: this.state!.propertyApplicationsTotal,
        applicationsTruncated: this.state!.propertyApplicationsTruncated,
        onLoadApplications: () => this.loadPropertyApplications(panel),
        sendMessage: this.sendMessage,
      });
    }

    const wrap = h('div');

    if (this.state!.identity.type === 'EditField') {
      const fields = renderPropertyGroups(this.makeEditFieldEditor(panel));
      fields.classList.add('dv-edit-field-properties');
      wrap.appendChild(fields);
    }

    const typeIsFlow = hasFlow(this.state!.identity.type);

    // Segmented body — the Path-Spine design. First segment is the anatomy
    // lens: the Flow chain for flow-bearing types, Code + Links otherwise.
    // 'Info' carries identity metadata + context fields. Styling / layout
    // controls (Columns, tool menu, header style, border, transparency,
    // visibility) are Blueprint's job now and no longer render in Inspect.
    const firstLabel = typeIsFlow ? 'Flow' : 'Code';
    // Segment counts — quick scent of what each lens holds (mock: "Flow 6 ·
    // Structure 9"). Flow count walks the chain; Structure counts siblings.
    let flowCount = 0;
    let flowWithEc = 0;
    if (typeIsFlow && this.state!.flow) {
      type N = { children?: N[]; codeFields?: unknown[] };
      const walk = (n: N) => {
        flowCount++;
        if (n.codeFields && n.codeFields.length > 0) flowWithEc++;
        for (const c of n.children ?? []) walk(c);
      };
      for (const st of this.state!.flow.steps as N[]) walk(st);
    }
    const structCount = this.state!.siblingTotal || this.state!.siblings.length;
    // Quiet facts on the segment bar's right — same line as the tabs, so the
    // meta reads as part of the chrome instead of a tacked-on header. Steps
    // count lives in the Flow tab itself; here: EC count + persistence.
    const persistence = this.state!.contextValues?.persistence;
    const segFacts = this.segment === 'flow' && typeIsFlow
      ? [
          flowWithEc > 0 ? `${flowWithEc} with EC` : null,
          persistence ? `persistence ${normalizeBmpEnum(persistence).toLowerCase()}` : null,
        ].filter(Boolean).join(' · ')
      : '';
    wrap.appendChild(h('div', { class: 'dv-segs' },
      this.segBtn(firstLabel, 'flow', panel, flowCount || undefined),
      this.segBtn('Structure', 'structure', panel, structCount || undefined),
      this.segBtn('Info', 'info', panel),
      segFacts ? h('span', { class: 'dv-segs-meta' }, segFacts) : null,
    ));

    if (this.segment === 'structure') {
      wrap.appendChild(this.renderTreeArea(panel));
      return wrap;
    }
    if (this.segment === 'info') {
      wrap.appendChild(this.renderInfoPane(panel));
      return wrap;
    }

    if (typeIsFlow) {
      // Flow is the answer to "what does this widget actually do" — the chain
      // (button → transport group → ExtendedTransport · or · view → set →
      // inputs) IS the anatomy; its code lives inside the ledger steps.
      // Label's default-mode controls govern defaultExpression, so they live
      // inside the root Label step directly before that EC field.
      let rootContent: HTMLElement | null = null;
      let inactiveCodeFields: Record<string, string> | undefined;
      if (this.state!.identity.type === 'Label') {
        rootContent = this.renderContextFields(panel, true);
        rootContent?.classList.add('flow-default-config');
        const advancedDefault = this.draft.advancedDefault ?? this.currentServerValue('advancedDefault');
        if (advancedDefault !== 'true' && advancedDefault !== 'TRUE' && advancedDefault !== '1') {
          inactiveCodeFields = { defaultExpression: 'Inactive: Advanced default is off' };
        }
      }
      wrap.appendChild(renderFlowSection({
        chain: this.state!.flow,
        loading: this.state!.flowLoading,
        error: this.state!.flowError,
        onRetry: () => {
          if (!this.state || this.state.flowLoading) return;
          this.state.flowLoading = true;
          this.state.flowError = null;
          this.sendMessage({
            type: 'FETCH_FLOW_CHAIN',
            rid: this.state.rid,
            objectType: this.state.identity.type,
          });
          this.renderDetail(panel);
        },
        onNavigate: (rid) => { this.swapTo(rid, null, panel, true).catch(() => {}); },
        sendMessage: this.sendMessage,
        rootContent,
        inactiveCodeFields,
        propertyOptions: this.flowPropertyOptions(),
      }));
      return wrap;
    }

    // Non-flow types: Code + References take the role the Flow section does
    // for flow types.
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
      onNavigate: (rid) => { this.swapTo(rid, null, panel, true).catch(() => {}); },
      onScanInbound: () => {
        this.state!.inbound = { loaded: false, scanning: true, targets: [] };
        this.sendMessage({
          type: 'FETCH_INBOUND',
          rid: this.state!.rid,
          className: this.state!.identity.type,
        });
        this.renderDetail(panel);
      },
    });
    if (linksSection) wrap.appendChild(linksSection);

    return wrap;
  }

  private segBtn(label: string, key: 'flow' | 'structure' | 'info', panel: HTMLElement, count?: number): HTMLElement {
    return h('button', {
      class: `dv-seg${this.segment === key ? ' dv-seg--on' : ''}`,
      onClick: () => {
        if (this.segment === key) return;
        this.segment = key;
        this.renderDetail(panel);
      },
    }, label, count != null ? h('span', { class: 'dv-seg-n' }, String(count)) : null);
  }

  /** Info pane — the quiet identity meta grid (copyable ids) followed by the
   *  context fields (persistence, actionType, …). */
  private renderInfoPane(panel: HTMLElement): HTMLElement {
    const { rid, businessId, type } = this.state!.identity;
    const display = resolveDisplayIdentity({
      rid,
      businessId,
      templateBusinessId: this.state!.template?.businessId,
    });
    const metaRow = (label: string, value: string | undefined, copyable = false) => {
      const valEl = h('span', { class: 'dv-meta-v mono' }, value ?? '—');
      const cells: HTMLElement[] = [h('span', { class: 'dv-meta-k' }, label), valEl];
      if (copyable && value) {
        cells.push(h('button', {
          class: 'dv-meta-copy',
          title: `Copy ${label}`,
          onClick: () => {
            navigator.clipboard?.writeText(value).catch(() => { /* blocked — silent */ });
            statusFlash(`Copied ${value} \u2713`);
            const original = valEl.textContent;
            valEl.textContent = '✓ copied';
            valEl.classList.add('dv-meta-v--ok');
            setTimeout(() => { valEl.textContent = original; valEl.classList.remove('dv-meta-v--ok'); }, 700);
          },
        }, svg(ICON_COPY)));
      } else {
        cells.push(h('span'));
      }
      return cells;
    };

    const meta = h('div', { class: 'dv-meta' },
      ...metaRow('Type', type),
      ...metaRow(display.primaryLabel, display.primary, true),
      ...(display.secondary ? metaRow('Instance ID', display.secondary, true) : []),
      ...metaRow('RID', rid, true),
    );

    const wrap = h('div', {}, meta);

    // The object's detail card is a related object, not an ancestor — it
    // lives here in Info rather than in the path bar.
    if (this.state!.card) wrap.appendChild(this.renderCardCrumb(this.state!.card, panel));

    // Context fields — enum/boolean/list values that shape how to read the
    // object (actionType, persistence, useShowExpression, …). Only renders
    // when the type has populated context values.
    const ctxSection = this.renderContextFields(panel, false);
    if (ctxSection) wrap.appendChild(ctxSection);

    // Action rows — the mock's Info list (Open in web / Test access / Pin).
    const isPinned = S.favoriteEntries.some(f => f.rid === this.state!.rid);
    const irow = (icon: string, label: string, hint: string | null, onClick: () => void) =>
      h('button', { class: 'dv-irow', onClick },
        h('span', { class: 'dv-irow-ic' }, svg(icon)),
        h('span', { class: 'dv-irow-l' }, label),
        hint ? h('span', { class: 'dv-irow-r' }, hint) : null,
      );
    wrap.appendChild(h('div', { class: 'dv-irows' },
      irow(ICON_ARROW_OUT, 'Open in web', 'new tab',
        () => this.sendMessage({ type: 'BMP_OPEN_OBJECT', rid: this.state!.rid })),
      irow(ICON_SHIELD, 'Test access', 'read · write · add · delete',
        () => openAccessTrace({ rid: this.state!.rid, name: this.state!.identity.name, type: this.state!.identity.type })),
      irow(isPinned ? ICON_STAR_FILLED : ICON_STAR_HOLLOW, isPinned ? 'Unpin from favorites' : 'Pin to favorites', null,
        () => this.sendMessage({
          type: 'TOGGLE_FAVORITE', rid: this.state!.rid, name: this.state!.identity.name,
          objectType: this.state!.identity.type, businessId: this.state!.identity.businessId,
          templateBusinessId: this.state!.template?.businessId,
        })),
    ));

    return wrap;
  }

  private renderContextFields(panel: HTMLElement, editable: boolean): HTMLElement | null {
    return renderContextSection({
      type: this.state!.identity.type,
      contextValues: { ...this.state!.contextValues, ...this.draft },
      lists: this.state!.lists,
      onNavigate: (r) => { this.swapTo(r, null, panel, true).catch(() => {}); },
      editor: editable ? this.makeContextEditor(panel) : undefined,
    });
  }

  /** Flow can opt into writable context fields; Info uses the same values as
   * read-only facts. The editor reuses the Full View schema and controls. */
  private makeContextEditor(panel: HTMLElement): PaneGroupsCtx {
    const objectType = this.state!.identity.type;
    return {
      objectType,
      isAvailable: (def) => isPropAvailable(objectType, def.prop, def.availableOn),
      displayValue: (prop) => this.draft[prop] ?? this.currentServerValue(prop),
      serverValue: (prop) => this.currentServerValue(prop),
      isDirty: (prop) => this.draft[prop] != null,
      setDraft: (prop, value) => {
        if (paneValueEquals(prop, value, this.currentServerValue(prop))) delete this.draft[prop];
        else this.draft[prop] = value;
        this.renderDetail(panel);
      },
      openColorPicker: () => {},
    };
  }

  private makeEditFieldEditor(panel: HTMLElement): PaneGroupsCtx {
    const state = this.state!;
    const schemas = state.editFieldClassNames.flatMap(type => {
      const schema = schemaProps(type);
      return schema ? [schema] : [];
    });
    const complete = state.editFieldClassNames.length > 0
      && schemas.length === state.editFieldClassNames.length;
    const properties = complete
      ? intersectTypeSchemas(schemas)
        .sort((a, b) =>
          Number(a.systemobject) - Number(b.systemobject)
          || (a.label || a.accessor).localeCompare(b.label || b.accessor))
      : undefined;
    return {
      objectType: 'EditField',
      isAvailable: def => isPropAvailable('EditField', def.prop, def.availableOn),
      displayValue: prop => this.draft[prop] ?? this.currentServerValue(prop),
      serverValue: prop => this.currentServerValue(prop),
      isDirty: prop => this.draft[prop] != null,
      setDraft: (prop, value) => {
        if (paneValueEquals(prop, value, this.currentServerValue(prop))) delete this.draft[prop];
        else this.draft[prop] = value;
        this.renderDetail(panel);
      },
      propertyChoices: prop => {
        if (prop !== 'propertyMapping') return {};
        const error = state.editFieldClassNames.length === 0
          ? 'No owning object type found'
          : state.editFieldClassNames.map(type => schemaError(type)).find(Boolean);
        return {
          options: properties?.map(property => ({
            value: property.accessor,
            label: property.label || property.accessor,
            propertyId: property.propertyId || property.accessor,
            configClass: property.propertyConfigClass || property.configClass,
          })),
          loading: !complete && !error,
          source: state.editFieldClassNames.join(' + '),
          ...(error ? { error } : {}),
        };
      },
      openColorPicker: () => {},
    };
  }

  private flowPropertyOptions(): FlowPropertyOption[] | undefined {
    const objectTypes = this.state?.flow?.objectTypes ?? [];
    if (objectTypes.length === 0) return undefined;
    const schemas = objectTypes.flatMap(type => {
      const schema = schemaProps(type);
      return schema ? [schema] : [];
    });
    if (schemas.length !== objectTypes.length) return undefined;
    return intersectTypeSchemas(schemas).map(property => ({
      accessor: property.accessor,
      label: property.label || property.accessor,
      propertyId: property.propertyId || property.accessor,
      configClass: property.propertyConfigClass || property.configClass,
      propertyRid: property.propertyRid,
    }));
  }

  /** Normalize this object's links into the unified model: widget types use
   *  their curated bindings (outgoing only); domain types use discovered
   *  relationships plus the lazy inbound scan. The two are mutually exclusive
   *  (curated refs exist iff the type has reference metadata). */
  private buildLinksModel(): LinksModel {
    const type = this.state!.identity.type;
    const relation = editFieldPropertyRelation(
      type,
      this.state!.instanceProps.propertyMapping,
      this.state!.editFieldProperty,
      this.state!.editFieldPropertyError,
    );
    const mappedProperty: LinkTarget[] = relation.kind === 'resolved'
      ? [{
          rid: relation.resolution.property.rid,
          businessId: relation.resolution.property.businessId,
          name: relation.resolution.property.name,
          type: relation.resolution.property.type,
          field: 'Property',
        }]
      : relation.kind === 'unresolved'
        ? [{
            rid: relation.accessor,
            businessId: relation.accessor,
            field: 'Property',
            unavailableReason: relation.error,
          }]
        : [];
    const curated = referencesToLinks(type, this.state!.references);
    if (curated.length > 0) {
      return { outgoing: [...mappedProperty, ...curated], incoming: [] };
    }
    const { outgoing, incoming } = connectionsToLinks(this.state!.connections ?? []);
    return {
      outgoing: [...mappedProperty, ...outgoing],
      incoming,
      inbound: this.state!.inbound ?? undefined,
    };
  }

  /** Build the controller the shared property-group renderer needs. */
  private renderTreeArea(panel: HTMLElement): HTMLElement {
    const s = this.state!;
    const treeData: PaneTreeData = {
      parent: s.parent,
      current: {
        ...s.identity,
        ...(s.template?.businessId ? { templateBusinessId: s.template.businessId } : {}),
      },
      siblings: s.siblings,
      siblingTotal: s.siblingTotal,
      children: this.childrenState?.items,
      loadingChildren: this.childrenState?.loading,
      childrenError: this.childrenState?.error,
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
            error: null,
            items: this.childrenState?.items ?? [],
          };
          if (this.childrenState.loading) {
            this.sendMessage({ type: 'FETCH_CHILDREN', rid: s.rid });
          }
        }
        this.renderDetail(panel);
      },
      onRetryChildren: () => {
        if (!this.childrenState) return;
        this.childrenState.loading = true;
        this.childrenState.error = null;
        this.sendMessage({ type: 'FETCH_CHILDREN', rid: s.rid });
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

}
