/**
 * Workshop layout pane — top half of the Workshop tab. Renders the
 * page-detection status, the workshop-ctx-strip (scorecard/tab chips
 * + crosshair picker), the layout tree of the current context
 * (Scorecard / TabSet / Tab / Container), and a generic object tree
 * for non-layout-bearing contexts.
 *
 * Implements the `Tab` interface so WorkshopTab can forward lifecycle
 * calls (activate / deactivate / handleMessage / render) directly.
 */

import type { InspectorMessage, BmpObject, WidgetInfo, DetectionPhase, LayoutNode } from '../../lib/types';
import { getTypeColor, getTypeAbbr } from '../../lib/types';
import { h, render, svg } from '../../lib/dom';
import { delegate } from '../delegate';
import { truncRid, ICON_REFRESH, ICON_CROSSHAIR, ICON_LAYOUT } from '../utils';
import type { Tab, SendFn } from './tab-types';
import { LAYOUT_BEARING_TYPES } from '../../lib/layout-target';

type WidgetEnrichment = { rid: string; businessId?: string; type?: string; name?: string };

/** Context types whose `descendants()` form a renderable layout grid.
 *  These all live in the portal (TabSet → Tab → Container), so the subtree
 *  walk returns the real container hierarchy. A *Scorecard* is deliberately
 *  excluded: it lives in the org model and only owns widgets — the Tabs and
 *  Containers it renders belong to a shared, global TabSet, so its
 *  `descendants()` never yields the grid. For a Scorecard we show the object
 *  tree instead and let the user click the active-Tab chip to inspect the
 *  page's layout. */
const LAYOUT_TREE_TYPES = new Set(['TabSet', 'Tab', 'Container']);

/** BMP authors prefix their data-test attributes with "widget-" (e.g. data-test="widget-RiskPicker").
 *  Strip it so the list reads as the actual widget id, not the framework convention.
 *  Exported for tests. */
export function cleanWidgetName(raw: string | undefined): string {
  if (!raw) return '';
  return raw.replace(/^widget-/i, '');
}

export class WorkshopLayoutPane implements Tab {
  // Detection + widgets (from PAGE_INFO)
  private detection = { phase: 'unknown' as DetectionPhase, confidence: 0, signals: [] as string[] };
  private widgets: WidgetInfo[] = [];
  // Ambient page location — separate from contextRid so the user can see
  // "scorecard + active tab" even when contextRid was set elsewhere.
  // Populated from PAGE_INFO.rid / .tabRid on every refresh.
  private pageRid: string | null = null;
  private pageTabRid: string | null = null;
  private pageTabName: string | null = null;
  /** Enrichment for the widget list — rid → { type, name, businessId }.
   *  Populated lazily as SERVER_LOOKUP_RESULTs arrive for the widget rids we
   *  asked about on every PAGE_INFO. The overlay BADGE_ENRICHMENT broadcast
   *  goes to content scripts, not the panel, so we pump enrichments through a
   *  dedicated panel-side path. */
  private widgetEnrichments = new Map<string, WidgetEnrichment>();
  /** RIDs currently in flight for enrichment — keeps us from re-asking. */
  private widgetEnrichInFlight = new Set<string>();

  // Context object + template tree
  private contextRid: string | null = null;
  private contextObj: BmpObject | null = null;
  private contextLoading = false;
  private contextAutoDetected = false; // true if contextRid came from PAGE_INFO, not right-click
  // Layout subtree (TabSet / Tab / Container / Scorecard). Fetched in a
  // single EC round trip when the context object is one of those types.
  // Folded into a tree client-side and rendered with size pills + inline
  // edits for `columnsLargeScreen`.
  private layoutNodes: LayoutNode[] | null = null;
  private layoutLoadingFor: string | null = null;
  /** Active responsive breakpoint for the grid preview. Toggles which
   *  `columns*Screen` field drives the column-spans. Defaults to L
   *  (matches what the user is typically editing). */
  private gridBreakpoint: 'L' | 'M' | 'S' = 'L';
  /** Briefly-highlighted node in the grid preview / layout tree — set
   *  when the user clicks a cell in the preview to focus its tree row.
   *  Cleared after a short timeout via setTimeout in the click handler. */
  private highlightedNodeRid: string | null = null;
  /** Pre-edit values stashed so we can revert the optimistic update
   *  when APPLY_CHANGES_RESULT comes back with ok=false. Cleared on
   *  success (the re-fetch is the new source of truth). */
  private layoutRevertOnFailure = new Map<string, number>();
  /** True while the user has the pointer down on a layout-size bar.
   *  Render is suppressed during the drag — a mid-drag re-render
   *  detaches the bar element, breaking pointer capture and stranding
   *  the gesture. Any pending re-render is deferred to drag-end. */
  private layoutDragging = false;
  /** A render() that fired during a drag is queued; replayed once
   *  the drag finishes. */
  private layoutRenderPending = false;
  // Shared by the Layout tree (toggle-layout-node, focus-tree-row) to track
  // which nodes are user-expanded.
  private expandedNodes = new Set<string>();
  /** Preview section starts collapsed; click the disclosure chevron in
   *  its header to expand. Resets on context switch so a new scorecard
   *  opens clean. Layout has no disclosure — it's the primary view of
   *  the workshop's top half. */
  private previewSectionExpanded = false;
  /** True while the user is in "pick context" mode (paintbrush-style picker
   *  next to Context header). The next overlay click → SET_CONTEXT_RID. */
  private pickingContext = false;
  /** Did WE turn inspect mode on at the moment we armed the picker?
   *  If true, disarm restores inspect to off. If false, we never
   *  touched it (it was already on, OR the user toggled it during
   *  the pick) and we leave it alone. */
  private didEnableInspectForPick = false;
  /** Last known inspect-mode state, kept fresh by INSPECT_STATE
   *  broadcasts from the service worker. */
  private inspectActive = false;

  private send: SendFn;
  private onNavigate: (rid: string) => void;

  constructor(send: SendFn, onNavigate: (rid: string) => void) {
    this.send = send;
    this.onNavigate = onNavigate;
  }

  activate() {
    // Single-source flow: GET_PAGE_INFO is the canonical path. Its
    // handler in PAGE_INFO falls back to GET_CONTEXT_RID if the page
    // didn't return a rid. Sending both here used to race — two
    // responses would step on each other's contextRid assignment.
    this.send({ type: 'GET_PAGE_INFO' });
  }

  /** Wipe all context + page state (used on workspace/profile switch — every
   *  RID here belongs to the old workspace) and re-detect for the new one. */
  reset(): void {
    this.detection = { phase: 'unknown', confidence: 0, signals: [] };
    this.widgets = [];
    this.pageRid = null;
    this.pageTabRid = null;
    this.pageTabName = null;
    this.widgetEnrichments.clear();
    this.widgetEnrichInFlight.clear();
    this.contextRid = null;
    this.contextObj = null;
    this.contextLoading = false;
    this.contextAutoDetected = false;
    this.layoutNodes = null;
    this.layoutLoadingFor = null;
    this.highlightedNodeRid = null;
    this.expandedNodes.clear();
    this.previewSectionExpanded = false;
    this.pickingContext = false;
    this.activate(); // re-detect page context in the new workspace
  }

  deactivate() {
    // Cancel any in-flight context pick when the tab is hidden — the user has
    // navigated away, the modal "pick now" expectation no longer fits the UI.
    this.pickingContext = false;
  }

  /** True when the user has armed the paintbrush-style context picker.
   *  The orchestrator (sidepanel.ts) uses this to intercept the next
   *  SELECT_OBJECT from the page overlay and convert it into SET_CONTEXT_RID. */
  isPickingContext(): boolean {
    return this.pickingContext;
  }

  /** Consume the next overlay pick — sets the rid as context and re-renders
   *  with the picker disarmed. Called by the orchestrator. */
  consumePick(rid: string, name?: string, type?: string, businessId?: string, container?: HTMLElement): void {
    this.disarmPicker();
    this.send({ type: 'SET_CONTEXT_RID', rid, name, objectType: type, businessId });
    if (container) this.render(container);
  }

  /** Disarm the picker without committing — used by Escape. */
  cancelPick(container?: HTMLElement): void {
    if (!this.pickingContext) return;
    this.disarmPicker();
    if (container) this.render(container);
  }

  /** Common teardown: clear pickingContext + restore inspect-mode
   *  only if WE were the one who flipped it on. If the user
   *  manually toggled inspect during the pick, we don't undo their
   *  change. */
  private disarmPicker(): void {
    if (!this.pickingContext) return;
    this.pickingContext = false;
    if (this.didEnableInspectForPick) {
      this.didEnableInspectForPick = false;
      this.send({ type: 'SET_INSPECT_STATE', active: false });
    }
  }

  findObject(rid: string) {
    if (this.contextObj?.rid === rid) return this.contextObj;
    const w = this.widgets.find(w => w.rid === rid);
    if (w) return { rid: w.rid, name: w.name, type: w.type, source: 'dom' as const, discoveredAt: Date.now(), updatedAt: Date.now() };
    return null;
  }

  /** True when the top pane has a tall structural view to show (the Layout
   *  tree, for portal layout types). When false the pane is just the context
   *  strip, so WorkshopTab sizes it to content and lets the detail half take
   *  the rest — no dead padding under a lone chip row. */
  hasLayoutTree(): boolean {
    return !!(this.contextObj?.type && LAYOUT_TREE_TYPES.has(this.contextObj.type));
  }

  handleMessage(msg: InspectorMessage): boolean {
    switch (msg.type) {
      case 'PAGE_INFO':
        this.widgets = msg.widgets;
        this.pageRid = msg.rid ?? null;
        this.pageTabRid = msg.tabRid ?? null;
        this.pageTabName = msg.tabName ?? null;
        if (msg.detection) {
          const phase: DetectionPhase = msg.detection.isBmp ? 'detected' : 'not-detected';
          this.detection = { phase, confidence: msg.detection.confidence, signals: msg.detection.signals };
        }
        // Auto-detect: empty → set the page's rid.
        // Follow the URL: if the existing context was AUTO-detected and
        // the user has navigated BMP to a different scorecard, switch
        // to it. Manual right-click / picker context is preserved
        // because contextAutoDetected stays false.
        if (!this.contextRid && msg.rid) {
          this.setContext(msg.rid, true /* auto-detected */);
        } else if (
          this.contextRid && this.contextAutoDetected && msg.rid && msg.rid !== this.contextRid
        ) {
          this.setContext(msg.rid, true);
        } else if (!this.contextRid && !msg.rid) {
          // PAGE_INFO came back without a rid (content-script reachable but
          // URL has no `?rid=` — fresh BMP tab on the home page). Fire a
          // GET_CONTEXT_RID anyway: that handler has a tab-URL fallback +
          // also checks the right-click context map, so the user gets the
          // chip populated as soon as anything is available.
          this.send({ type: 'GET_CONTEXT_RID' });
        }
        // Kick off enrichment for any widget we don't yet know the type/name of.
        // SERVER_LOOKUP_RESULT comes back per-rid; we update widgetEnrichments
        // as each lands. The handler dedupes via widgetEnrichInFlight + Map.
        this.requestWidgetEnrichments();
        return true;
      case 'DETECTION_STATE':
        this.detection = { phase: msg.phase, confidence: msg.confidence, signals: msg.signals };
        return true;
      case 'INSPECT_STATE':
        // Track inspect-mode state so the context picker knows whether
        // it needs to flip it on (and remember to flip it back off).
        this.inspectActive = msg.active;
        return false;
      case 'CONTEXT_RID_DATA':
        if ('rid' in msg && msg.rid) {
          // Explicit right-click always takes precedence over auto-detection
          if (msg.rid === this.contextRid && !this.contextAutoDetected) return false; // same explicit context, skip
          this.setContext(msg.rid, false /* user-set */);
        } else if (!this.contextAutoDetected) {
          // Only clear if the current context was user-set (don't clobber auto-detected)
          this.contextRid = null;
          this.contextObj = null;
          this.contextLoading = false;
        }
        return true;
      case 'FULL_LOOKUP_RESULT':
        if ('rid' in msg && msg.rid === this.contextRid && this.contextLoading) {
          this.contextLoading = false;
          if (msg.object) {
            this.contextObj = msg.object;
            // Kick off layout-tree fetch when the context is a layout
            // container — single EC round-trip returns the whole nested
            // hierarchy (Tab → Container → Container → Widget refs).
            const objType = msg.object.type;
            if (objType && LAYOUT_TREE_TYPES.has(objType)) {
              this.layoutLoadingFor = msg.rid;
              this.layoutNodes = null;
              this.send({ type: 'FETCH_LAYOUT_TREE', rid: msg.rid });
            } else {
              this.layoutNodes = null;
              this.layoutLoadingFor = null;
            }
          }
          return true;
        }
        return false;
      case 'LAYOUT_TREE_RESULT':
        if ('rid' in msg && msg.rid === this.layoutLoadingFor) {
          this.layoutLoadingFor = null;
          this.layoutNodes = msg.nodes ?? [];
          return true;
        }
        return false;
      case 'MOVE_OBJECT_RESULT':
        if ('ok' in msg && msg.ok && this.contextRid) {
          // Order changed — re-fetch the layout subtree so the tree
          // reflects the new sibling sequence.
          this.layoutLoadingFor = this.contextRid;
          this.send({ type: 'FETCH_LAYOUT_TREE', rid: this.contextRid });
          return true;
        }
        return false;
      case 'APPLY_CHANGES_RESULT':
        // Layout edits go through APPLY_OBJECT_CHANGES with optimistic
        // local update. We have to either confirm by re-fetching (to
        // pick up cascade effects: sibling reflow when a width changes)
        // or revert if BMP rejected the save.
        if ('rid' in msg && this.layoutNodes && this.contextRid) {
          const target = this.layoutNodes.find(n => n.rid === msg.rid);
          if (target) {
            if (msg.ok) {
              // Re-fetch — the new value may have triggered a row wrap
              // or hidden the element on this breakpoint.
              this.layoutLoadingFor = this.contextRid;
              this.send({ type: 'FETCH_LAYOUT_TREE', rid: this.contextRid });
            } else if (this.layoutRevertOnFailure.has(msg.rid)) {
              // Revert the optimistic update so the UI stops lying about
              // the (failed) save. Stash was set in the edit handler.
              const original = this.layoutRevertOnFailure.get(msg.rid)!;
              target.columnsLargeScreen = original;
              this.layoutRevertOnFailure.delete(msg.rid);
            }
            return true;
          }
        }
        return false;
      case 'SERVER_LOOKUP_RESULT':
        // Widget enrichment path — populate identity for a widget-list rid.
        // The context object's own SERVER_LOOKUP goes through FULL_LOOKUP_RESULT.
        if ('rid' in msg && this.widgetEnrichInFlight.has(msg.rid)) {
          this.widgetEnrichInFlight.delete(msg.rid);
          if (msg.object) {
            this.widgetEnrichments.set(msg.rid, {
              rid: msg.rid,
              businessId: msg.object.businessId,
              type: msg.object.type,
              name: msg.object.name,
            });
            return true;
          }
        }
        return false;
      default:
        return false;
    }
  }

  /** Request server enrichment for any widget we haven't resolved yet.
   *  Each SERVER_LOOKUP responds with the full BmpObject; we keep only the
   *  identity fields (type, name, businessId) for rendering. Inexpensive in
   *  bytes — the heavy lifting is server-side; the panel only re-renders. */
  private requestWidgetEnrichments(): void {
    for (const w of this.widgets) {
      if (!w.rid) continue;
      if (this.widgetEnrichments.has(w.rid)) continue;
      if (this.widgetEnrichInFlight.has(w.rid)) continue;
      // Skip if the DOM already gave us a real type — the only failure mode
      // we're fixing is "no type / no name", not "show the user the BMP name
      // instead of the DOM data-test." (Users can still drill in.)
      if (w.type && w.name) continue;
      this.widgetEnrichInFlight.add(w.rid);
      this.send({ type: 'SERVER_LOOKUP', rid: w.rid });
    }
    // Also enrich the page-location chips (scorecard + active tab) so
    // the chips show human names rather than the bare RID once the
    // server answer lands.
    for (const rid of [this.pageRid, this.pageTabRid]) {
      if (!rid) continue;
      if (this.widgetEnrichments.has(rid)) continue;
      if (this.widgetEnrichInFlight.has(rid)) continue;
      this.widgetEnrichInFlight.add(rid);
      this.send({ type: 'SERVER_LOOKUP', rid });
    }
  }

  /** Entry point for the "Layout ↗" shortcut (from DetailView's
   *  header or the popout's OPEN_LAYOUT_FOR). Resolves the most
   *  useful layout-bearing ancestor of `rid` and flashes the
   *  widget's row in the resulting tree.
   *
   *  Resolution order:
   *    1. If `rid` is itself layout-bearing, use it.
   *    2. Else walk up `this.layoutNodes` to the nearest Tab,
   *       falling back to TabSet → Scorecard if no Tab on the chain.
   *    3. Else fall back to `rid` as-is; FULL_LOOKUP picks the right
   *       layout to fetch from the object's own type. */
  openLayoutFor(rid: string, highlightRid?: string): void {
    const target = this.resolveLayoutTarget(rid);
    // The pre-resolve rid is what the user actually wanted to find
    // Explicit highlight wins; otherwise the pre-resolve rid is what
    // the user clicked, so highlight that row in the resulting tree.
    const highlight = highlightRid ?? (target !== rid ? rid : undefined);
    this.setContext(target, false /* user-set, sticky */);
    if (highlight) this.highlightedNodeRid = highlight;
  }

  /** Walk the cached layoutNodes upward from `rid` to find the
   *  nearest Tab. Returns the original rid if no walk is possible. */
  private resolveLayoutTarget(rid: string): string {
    if (!this.layoutNodes) return rid;
    const byRid = new Map<string, { rid: string; parentRid?: string; containerRid?: string; type: string }>();
    for (const n of this.layoutNodes) byRid.set(n.rid, n);
    const start = byRid.get(rid);
    if (!start) return rid;
    if (start.type === 'Tab') return rid;
    // containerRid covers the widget→cell hop; parentRid covers
    // everything else (Container→Container, Container→Tab, ...).
    let cur: typeof start | undefined = start;
    let bestSoFar: string | null = null;
    const MAX_DEPTH = 12;
    for (let i = 0; i < MAX_DEPTH && cur; i++) {
      if (cur.type === 'Tab') return cur.rid;
      // Remember the highest layout-bearing ancestor as a fallback
      // when there's no Tab on the chain.
      if (cur !== start && LAYOUT_BEARING_TYPES.has(cur.type)) bestSoFar = cur.rid;
      const nextRid: string | undefined = cur.containerRid ?? cur.parentRid;
      cur = nextRid ? byRid.get(nextRid) : undefined;
    }
    return bestSoFar ?? rid;
  }

  private setContext(rid: string, autoDetected: boolean): void {
    this.contextRid = rid;
    this.contextAutoDetected = autoDetected;
    this.contextLoading = true;
    this.contextObj = null;
    this.expandedNodes.clear();
    // Drop the old layout immediately — otherwise the panel briefly
    // shows the previous scorecard's tabs/containers while FULL_LOOKUP
    // round-trips. Also reset any pending layout fetch belonging to
    // the previous context so its in-flight reply doesn't overwrite
    // the new one.
    this.layoutNodes = null;
    this.layoutLoadingFor = null;
    this.highlightedNodeRid = null;
    // Reset Preview disclosure so a new scorecard opens with just the
    // primary layout tree visible.
    this.previewSectionExpanded = false;
    this.send({ type: 'FULL_LOOKUP', rid });
  }


  /** The orchestrator tells us whether the bottom (detail) half is showing an
   *  object. When it is, the layout half drops its verbose "pick context" nag —
   *  the user clearly already has something loaded. */
  private detailActive = false;
  setDetailActive(active: boolean): void { this.detailActive = active; }

  render(container: HTMLElement) {
    // Skip if the user is mid-drag on a layout-size bar. A re-render
    // would detach the bar element and break pointer capture. The
    // pending flag replays the render once the drag ends.
    if (this.layoutDragging) {
      this.layoutRenderPending = true;
      return;
    }
    const children: (HTMLElement | false | null)[] = [];

    // Context band — OUR design. Its job is to carry WHERE you are: the page's
    // context object (Scorecard / Page / …) and the active Tab, with a subtle
    // detection dot instead of a meaningless "detection %". Always shown.
    {
      const detected = this.detection.phase === 'detected';
      const checking = this.detection.phase === 'checking' || this.detection.phase === 'unknown';
      const resolveName = (rid: string, fallback: string) =>
        this.widgetEnrichments.get(rid)?.name || fallback;
      // The context object's real type, not a hardcoded "Scorecard" — it may be
      // a Page, a Template, etc.
      const pageType = (this.pageRid ? this.widgetEnrichments.get(this.pageRid)?.type : null) || 'Scorecard';
      const chipChildren: HTMLElement[] = [];
      // Suppress chips that point at the current context — the click would be a
      // no-op (e.g. the auto-detected scorecard is already the context).
      if (this.pageRid && this.pageRid !== this.contextRid) {
        chipChildren.push(h('button', {
          class: 'workshop-ctx-chip',
          'data-action': 'pick-page-scorecard',
          'data-rid': this.pageRid,
          title: `Set ${pageType} as context`,
        },
          h('span', { class: 'pane-tree-chip', style: `--type-color:${getTypeColor(pageType)}` }, getTypeAbbr(pageType)),
          h('span', { class: 'workshop-ctx-chip-value' }, resolveName(this.pageRid, truncRid(this.pageRid))),
        ));
      }
      if (this.pageTabRid && this.pageTabRid !== this.contextRid) {
        chipChildren.push(h('button', {
          class: 'workshop-ctx-chip',
          'data-action': 'pick-page-tab',
          'data-rid': this.pageTabRid,
          'data-name': this.pageTabName ?? '',
          title: 'Set the active tab as context',
        },
          h('span', { class: 'pane-tree-chip', style: `--type-color:${getTypeColor('Tab')}` }, getTypeAbbr('Tab')),
          h('span', { class: 'workshop-ctx-chip-value' }, this.pageTabName || resolveName(this.pageTabRid, truncRid(this.pageTabRid))),
        ));
      }

      let body: HTMLElement;
      if (chipChildren.length > 0) {
        body = h('div', { class: 'workshop-ctx-chips' }, ...chipChildren);
      } else if (checking) {
        body = h('span', { class: 'workshop-ctx-empty' }, 'Checking page…');
      } else if (this.pageRid) {
        body = h('span', { class: 'workshop-ctx-empty' }, 'On the page you’re inspecting.');
      } else if (detected) {
        body = h('span', { class: 'workshop-ctx-empty' }, 'BMP page · no scorecard context.');
      } else {
        body = h('span', { class: 'workshop-ctx-empty' }, 'Not a BMP page.');
      }

      children.push(h('div', { class: 'workshop-ctx-strip' },
        h('span', {
          class: `workshop-ctx-dot workshop-ctx-dot--${detected ? 'on' : checking ? 'checking' : 'off'}`,
          title: detected ? 'On a BMP page' : checking ? 'Detecting…' : 'Not a BMP page',
          'aria-hidden': 'true',
        }),
        body,
        h('button', {
          class: `workshop-ctx-picker${this.pickingContext ? ' active' : ''}`,
          'data-action': 'pick-context',
          title: this.pickingContext
            ? 'Cancel context picker (Esc)'
            : 'Pick an element on the page to set as context',
          'aria-pressed': this.pickingContext ? 'true' : 'false',
        }, svg(ICON_CROSSHAIR)),
      ));
    }

    // The workshop-ctx-strip above carries the picker + ambient
    // chips; the empty / loading states below render directly when no
    // context is set yet.
    if (!this.contextRid && !this.contextLoading && (this.pickingContext || !this.detailActive)) {
      // Suppress the verbose prompt when a detail is already open below — it
      // just nags above a loaded object. Still shown while actively picking.
      children.push(h('div', { class: 'empty-state empty-state--compact' },
        this.pickingContext
          ? 'Click any BMP element on the page to set it as context. Press Escape to cancel.'
          : 'Pick a scorecard/tab chip above, click the crosshair, or right-click a BMP element to set context.',
      ));
    } else if (this.contextLoading) {
      children.push(h('div', { class: 'empty-state' }, 'Loading\u2026'));
    } else if (this.contextObj) {
      // No standalone identity banner here: the context strip above names
      // your page location, the object tree's root row names the object
      // (with its business id), and the detail half below is the full
      // editor. A separate "object + id" header just repeated the name.

      // Auto-detect hint
      if (this.contextAutoDetected) {
        children.push(h('div', { class: 'inspector-auto-hint' },
          'Auto-detected from page URL. Right-click a BMP element to override',
        ));
      }

      // Layout subtree — only for portal grid-bearing contexts (TabSet /
      // Tab / Container). Each row's `columnsLargeScreen` renders as a
      // 6-bar mini-grid that doubles as a drag-to-edit affordance.
      if (this.contextObj?.type && LAYOUT_TREE_TYPES.has(this.contextObj.type)) {
        const layoutLoading = this.layoutLoadingFor === this.contextRid;
        children.push(h('div', { class: 'section-title' },
          h('span', { class: 'section-title-icon', 'aria-hidden': 'true' }, svg(ICON_LAYOUT)),
          'Layout',
          layoutLoading
            ? h('span', { class: 'layout-loading-spinner' }, '⏳')
            : h('button', {
                class: 'refresh-enrich-btn',
                'data-action': 'refresh-layout',
                title: 'Re-fetch the layout subtree',
              }, svg(ICON_REFRESH)),
          // Blueprint toggle now lives in the header button row (Search / Paint / Inspect / Blueprint)
          // as a global overlay toggle — see sidepanel.ts.
        ));
        if (this.layoutNodes) {
          children.push(this.renderLayout(this.contextRid!, this.layoutNodes));
        } else if (layoutLoading) {
          children.push(h('div', { class: 'empty-state empty-state--compact' }, 'Walking subtree…'));
        }
        // Preview gets its own independent disclosure so users can
        // open one without the other.
        if (this.layoutNodes) {
          children.push(h('div', {
            class: `section-title section-title--toggle${this.previewSectionExpanded ? ' section-title--open' : ''}`,
            'data-action': 'toggle-preview-section',
            role: 'button',
            tabindex: '0',
            'aria-expanded': this.previewSectionExpanded ? 'true' : 'false',
            title: this.previewSectionExpanded ? 'Click to collapse' : 'Click to expand',
          },
            h('span', { class: 'section-chev' }, this.previewSectionExpanded ? '▾' : '▸'),
            'Preview',
          ));
          if (this.previewSectionExpanded) {
            children.push(this.renderGridPreviewSection(this.contextRid!, this.layoutNodes));
          }
        }
      }

      // No object tree for non-layout contexts: the detail half below is
      // the full editor and already anchors you in the hierarchy (parent
      // breadcrumb · siblings · children). A second downward tree up here
      // just duplicated that, separated by the editor. Layout contexts keep
      // their Layout tree above (it's the grid editor, not a duplicate).
    }

    render(container, ...children);

    // Wire drag-to-resize on every layout-size bar. Pointer-down on
    // the bar captures the pointer; pointer-move maps the X position
    // to a column count (0..6) by dividing the bar's width into 7
    // zones; pointer-up commits via APPLY_OBJECT_CHANGES. Done here
    // (post-render) so freshly-rendered bars pick up listeners every
    // re-render. Single bar at a time — pointer capture serialises.
    this.wireLayoutDrag(container);
    // Wire drag-to-reorder on tab rows. Drag the ≡ handle on a Tab to
    // a new position in the TabSet; drop commits via MOVE_OBJECT
    // (BMP EC `.moveBefore` / `.moveAfter`).
    this.wireLayoutTabReorder(container);

    delegate(container, {
      widget: (el) => {
        const rid = el.dataset.rid;
        if (rid) this.onNavigate(rid);
      },
      'pick-page-scorecard': (el) => {
        // Promote the ambient scorecard to user-set context. Bypasses
        // SET_CONTEXT_RID round-trip — we already have the rid + type;
        // SERVER_LOOKUP will fill name/businessId.
        const rid = el.dataset.rid;
        if (rid) {
          this.send({ type: 'SET_CONTEXT_RID', rid, objectType: 'Scorecard' });
          this.setContext(rid, false);
          this.render(container);
        }
      },
      'pick-page-tab': (el) => {
        const rid = el.dataset.rid;
        const name = el.dataset.name || undefined;
        if (rid) {
          // Tab object — name comes from data-title on the tab button.
          // type='Tab' lets the detail view + status bar render the
          // correct chip color.
          this.send({ type: 'SET_CONTEXT_RID', rid, name, objectType: 'Tab' });
          this.setContext(rid, false);
          this.render(container);
        }
      },
      'refresh-widgets': () => {
        // Re-query the page for fresh widgets (covers the case where the user
        // scrolled / navigated after the panel opened) AND nudge enrichment
        // to re-fetch any cached badge IDs that may have changed.
        this.send({ type: 'GET_PAGE_INFO' });
        this.send({ type: 'REFRESH_ENRICHMENT' });
      },
      'nav-layout-node': (el) => {
        const rid = el.dataset.rid;
        if (rid) this.onNavigate(rid);
      },
      'toggle-layout-node': (el) => {
        const rid = el.dataset.rid;
        if (!rid) return;
        if (this.expandedNodes.has(rid)) this.expandedNodes.delete(rid);
        else this.expandedNodes.add(rid);
        this.render(container);
      },
      'refresh-layout': () => {
        if (this.contextRid) {
          this.layoutLoadingFor = this.contextRid;
          this.layoutNodes = null;
          this.send({ type: 'FETCH_LAYOUT_TREE', rid: this.contextRid });
          this.render(container);
        }
      },
      'toggle-preview-section': () => {
        this.previewSectionExpanded = !this.previewSectionExpanded;
        this.render(container);
      },
      'grid-bp': (el) => {
        const bp = el.dataset.bp;
        if (bp === 'L' || bp === 'M' || bp === 'S') {
          this.gridBreakpoint = bp;
          this.render(container);
        }
      },
      'focus-tree-row': (el) => {
        // Bidirectional focus — clicking a cell in the grid preview
        // scrolls the corresponding tree row into view and flashes it.
        // Also auto-expands the chain of ancestors so the row IS in
        // the DOM (the layout tree collapses by budget).
        const rid = el.dataset.rid;
        if (!rid || !this.layoutNodes) return;
        let cur = this.layoutNodes.find(n => n.rid === rid);
        const trail: string[] = [];
        let depth = 0;
        while (cur && depth < 20) {
          trail.push(cur.rid);
          cur = cur.parentRid ? this.layoutNodes.find(n => n.rid === cur!.parentRid) : undefined;
          depth++;
        }
        for (const r of trail) this.expandedNodes.add(r);
        this.highlightedNodeRid = rid;
        this.render(container);
        // Scroll + flash AFTER render so the DOM exists.
        setTimeout(() => {
          const row = container.querySelector<HTMLElement>(`.layout-row[data-layout-rid="${CSS.escape(rid)}"]`);
          if (row) row.scrollIntoView({ block: 'center', behavior: 'smooth' });
          setTimeout(() => {
            this.highlightedNodeRid = null;
            this.render(container);
          }, 1600);
        }, 0);
      },
      'pick-context': () => {
        if (this.pickingContext) {
          // Toggle off.
          this.disarmPicker();
        } else {
          // Arm. Force inspect ON so overlay clicks fire SELECT_OBJECT
          // (which is what the picker intercepts). Track that WE
          // turned it on so disarm knows to turn it off.
          this.pickingContext = true;
          if (!this.inspectActive) {
            this.didEnableInspectForPick = true;
            this.send({ type: 'SET_INSPECT_STATE', active: true });
          }
        }
        this.render(container);
      },
    });
  }

  /** Fold the flat LayoutNode array into a children-by-parent map and
   *  render recursively. Uses `containerRid` for widgets (which bind to
   *  a cell via the write-once `container` field at create time) and
   *  `parentRid` for layout nodes themselves (Tab → TabSet, Container →
   *  Tab/Container, etc.). */
  /** Attach pointer-drag listeners to every .layout-size bar inside
   *  the panel. Drag horizontally to set columnsLargeScreen (0..6).
   *  Commits via APPLY_OBJECT_CHANGES on pointer-up; pointer-cancel
   *  reverts. Tab/TabSet edits show a confirm because TabSets are
   *  shared across scorecards. */
  private wireLayoutDrag(container: HTMLElement): void {
    if (!this.layoutNodes) return;
    const bars = container.querySelectorAll<HTMLElement>('.layout-size');
    for (const bar of bars) {
      const rid = bar.dataset.rid;
      if (!rid) continue;
      const node = this.layoutNodes.find(n => n.rid === rid);
      if (!node || node.columnsLargeScreen == null) continue;

      const original = node.columnsLargeScreen;
      let dragging = false;
      let pointerId: number | null = null;
      let lastValue = original;

      // Map an absolute x within the bar's rect to a 0..6 column count.
      // Seven equal buckets (one per value 0..6) so each is the same
      // size; the prior round-based mapping made the "0" zone a tiny
      // sliver, almost impossible to hit by drag.
      const xToCols = (clientX: number): number => {
        const rect = bar.getBoundingClientRect();
        const rel = clientX - rect.left;
        const cell = Math.floor((rel / rect.width) * 7);
        return Math.max(0, Math.min(6, cell));
      };

      const preview = (cols: number) => {
        if (cols === lastValue) return;
        lastValue = cols;
        // Repaint THIS bar's cells in place — don't trigger a full
        // re-render mid-drag (the cell DOM moves, breaking pointer
        // capture). DOM children of the bar are: <span.layout-size-bar>
        // (6 cells) + <span.layout-size-num>.
        const cells = bar.querySelectorAll<HTMLElement>('.layout-size-cell');
        cells.forEach((c, i) => c.classList.toggle('filled', i < cols));
        const num = bar.querySelector<HTMLElement>('.layout-size-num');
        if (num) num.textContent = String(cols);
      };

      const onMove = (e: PointerEvent) => {
        if (!dragging) return;
        preview(xToCols(e.clientX));
      };
      const finish = (commit: boolean) => {
        if (!dragging) return;
        dragging = false;
        this.layoutDragging = false;
        if (pointerId != null) {
          try { bar.releasePointerCapture(pointerId); } catch { /* released */ }
          pointerId = null;
        }
        bar.removeEventListener('pointermove', onMove);
        bar.removeEventListener('pointerup', onUp);
        bar.removeEventListener('pointercancel', onCancel);
        bar.classList.remove('layout-size--dragging');

        // Replay any render that was deferred during the drag. We do this
        // BEFORE the commit branch so reverted previews still get painted.
        if (this.layoutRenderPending) {
          this.layoutRenderPending = false;
          this.render(container);
        }

        if (!commit || lastValue === original) {
          preview(original);
          return;
        }

        // Tabs + TabSets are shared resources — confirm before saving.
        const isShared = node.type === 'Tab' || node.type === 'TabSet';
        if (isShared) {
          // eslint-disable-next-line no-alert
          const ok = window.confirm(
            `Edit "${node.name ?? node.rid}" (${node.type}): this object is shared across every Scorecard bound to its TabSet.\n\nApply ${original} → ${lastValue}?`,
          );
          if (!ok) { preview(original); return; }
        }

        this.layoutRevertOnFailure.set(rid, original);
        node.columnsLargeScreen = lastValue;
        this.send({
          type: 'APPLY_OBJECT_CHANGES',
          rid,
          target: 'instance',
          changes: { columnsLargeScreen: String(lastValue) },
        });
      };
      const onUp = () => finish(true);
      const onCancel = () => finish(false);

      bar.addEventListener('pointerdown', (e: PointerEvent) => {
        // Left button only — let right-click fall through for context menus.
        if (e.button !== 0) return;
        e.preventDefault();
        dragging = true;
        this.layoutDragging = true;
        pointerId = e.pointerId;
        lastValue = original;
        try { bar.setPointerCapture(e.pointerId); } catch { /* fine */ }
        bar.addEventListener('pointermove', onMove);
        bar.addEventListener('pointerup', onUp);
        bar.addEventListener('pointercancel', onCancel);
        bar.classList.add('layout-size--dragging');
        // Snap to the click position immediately so single-clicks
        // resize too (not just drags).
        preview(xToCols(e.clientX));
      });
    }
  }

  /** Drag-to-reorder for Tab AND Container rows. Pointer-down on the ≡
   *  handle starts the drag; a ghost insertion line follows the pointer
   *  between same-type, same-parent siblings; pointer-up commits via
   *  MOVE_OBJECT (which expands to EC `.moveBefore` / `.moveAfter` on
   *  the server). Tab moves prompt because TabSets are shared across
   *  scorecards; Container moves don't (containers are scorecard-local
   *  in the typical configuration). The spacer variant is filtered out
   *  via the `:not(.layout-handle--spacer)` selector. */
  private wireLayoutTabReorder(container: HTMLElement): void {
    if (!this.layoutNodes) return;
    const handles = container.querySelectorAll<HTMLElement>('.layout-handle:not(.layout-handle--spacer)');
    for (const handle of handles) {
      const row = handle.closest<HTMLElement>('.layout-row');
      if (!row) continue;
      const draggedRid = row.dataset.layoutRid;
      if (!draggedRid) continue;
      const draggedNode = this.layoutNodes.find(n => n.rid === draggedRid);
      if (!draggedNode) continue;
      const isTab = draggedNode.type === 'Tab';
      const isContainer = draggedNode.type === 'Container';
      if (!isTab && !isContainer) continue;
      // CSS class to filter siblings to the SAME type — moving a
      // Container next to a Tab makes no sense (different parents in
      // BMP's layout model).
      const siblingSelector = isTab ? '.layout-row--tab' : '.layout-row--container';

      let dragging = false;
      let pointerId: number | null = null;
      let indicator: HTMLElement | null = null;
      let dropTargetRid: string | null = null;
      let dropPosition: 'above' | 'below' = 'above';

      const ensureIndicator = (): HTMLElement => {
        if (indicator) return indicator;
        const el = document.createElement('div');
        el.className = 'layout-drop-indicator';
        container.appendChild(el);
        indicator = el;
        return el;
      };
      const removeIndicator = () => {
        if (indicator) { indicator.remove(); indicator = null; }
      };

      const findSiblingRowAt = (clientY: number): { row: HTMLElement; rid: string; position: 'above' | 'below' } | null => {
        // Siblings = other rows of the SAME type under the SAME parent
        // (TabSet for Tabs; Container/Tab for Containers). Returns the
        // closest one and whether the pointer is above or below its
        // mid-line.
        const siblings = Array.from(container.querySelectorAll<HTMLElement>(siblingSelector))
          .filter(r => r.dataset.layoutRid && r.dataset.layoutRid !== draggedRid);
        if (siblings.length === 0) return null;
        let best: { row: HTMLElement; rid: string; position: 'above' | 'below'; dist: number } | null = null;
        for (const sib of siblings) {
          const rid = sib.dataset.layoutRid!;
          // Only same-parent siblings reorder cleanly. Sibling parent
          // must match dragged's parent.
          const sibNode = this.layoutNodes!.find(n => n.rid === rid);
          if (!sibNode || sibNode.parentRid !== draggedNode.parentRid) continue;
          const rect = sib.getBoundingClientRect();
          const mid = rect.top + rect.height / 2;
          const dist = Math.abs(clientY - mid);
          const position: 'above' | 'below' = clientY < mid ? 'above' : 'below';
          if (!best || dist < best.dist) best = { row: sib, rid, position, dist };
        }
        return best;
      };

      const onMove = (e: PointerEvent) => {
        if (!dragging) return;
        const hit = findSiblingRowAt(e.clientY);
        if (!hit) { removeIndicator(); dropTargetRid = null; return; }
        dropTargetRid = hit.rid;
        dropPosition = hit.position;
        const ind = ensureIndicator();
        const rect = hit.row.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();
        ind.style.top = `${(hit.position === 'above' ? rect.top : rect.bottom) - containerRect.top + container.scrollTop - 1}px`;
        ind.style.left = `${rect.left - containerRect.left}px`;
        ind.style.width = `${rect.width}px`;
      };
      const finish = (commit: boolean) => {
        if (!dragging) return;
        dragging = false;
        this.layoutDragging = false;
        if (pointerId != null) {
          try { handle.releasePointerCapture(pointerId); } catch { /* released */ }
          pointerId = null;
        }
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        handle.removeEventListener('pointercancel', onCancel);
        row.classList.remove('layout-row--dragging');
        removeIndicator();

        if (this.layoutRenderPending) {
          this.layoutRenderPending = false;
          this.render(container);
        }

        if (!commit || !dropTargetRid || dropTargetRid === draggedRid) return;

        // Shared-resource confirmation only for Tabs — every TabSet is
        // potentially shared across scorecards, so a silent re-order
        // would be surprising. Containers are scorecard-local in the
        // typical configuration, so we move them without a prompt
        // (the optimistic re-fetch still lets the user undo via
        // refresh + drag back).
        if (isTab) {
          // eslint-disable-next-line no-alert
          const ok = window.confirm(
            `Move Tab "${draggedNode.name ?? draggedRid}" ${dropPosition} "${this.layoutNodes!.find(n => n.rid === dropTargetRid)?.name ?? dropTargetRid}"?\n\nThis affects every Scorecard bound to this TabSet.`,
          );
          if (!ok) return;
        }

        this.send({
          type: 'MOVE_OBJECT',
          rid: draggedRid,
          relTo: dropTargetRid,
          position: dropPosition,
        });
      };
      const onUp = () => finish(true);
      const onCancel = () => finish(false);

      handle.addEventListener('pointerdown', (e: PointerEvent) => {
        if (e.button !== 0) return;
        e.preventDefault();
        dragging = true;
        this.layoutDragging = true;
        pointerId = e.pointerId;
        try { handle.setPointerCapture(e.pointerId); } catch { /* fine */ }
        handle.addEventListener('pointermove', onMove);
        handle.addEventListener('pointerup', onUp);
        handle.addEventListener('pointercancel', onCancel);
        row.classList.add('layout-row--dragging');
      });
    }
  }

  /** Wrap the grid preview in a section with breakpoint toggle.
   *  Renders one preview per Tab in the subtree — for a TabSet/Scorecard
   *  context, the user sees the whole strip; for a Tab context, just
   *  that tab; for a Container context, the container's mini-grid. */
  private renderGridPreviewSection(rootRid: string, nodes: LayoutNode[]): HTMLElement {
    const root = nodes.find(n => n.rid === rootRid);
    if (!root) return h('div', {});
    const colsFieldByBp = { L: 'columnsLargeScreen', M: 'columnsMediumScreen', S: 'columnsSmallScreen' } as const;
    const colField = colsFieldByBp[this.gridBreakpoint];

    // Decide what to render at the top level:
    //  - Tab → that tab's grid
    //  - Container → that container's grid
    //  - Scorecard / TabSet → each Tab as its own preview, stacked
    const previewRoots: LayoutNode[] = root.type === 'Tab' || root.type === 'Container'
      ? [root]
      : nodes.filter(n => n.type === 'Tab' && n.parentRid && this.isDescendantOfTabSet(n, rootRid, nodes));

    return h('div', { class: 'grid-preview-section' },
      // The "Preview" word is now on the outer disclosure header — keep
      // only the breakpoint toggle here.
      h('div', { class: 'grid-preview-header' },
        h('div', { class: 'grid-bp-toggle' },
          h('button', {
            class: `grid-bp${this.gridBreakpoint === 'L' ? ' active' : ''}`,
            'data-action': 'grid-bp', 'data-bp': 'L',
            title: 'Large screen (≥ 992px)',
          }, 'L'),
          h('button', {
            class: `grid-bp${this.gridBreakpoint === 'M' ? ' active' : ''}`,
            'data-action': 'grid-bp', 'data-bp': 'M',
            title: 'Medium screen (768..991px)',
          }, 'M'),
          h('button', {
            class: `grid-bp${this.gridBreakpoint === 'S' ? ' active' : ''}`,
            'data-action': 'grid-bp', 'data-bp': 'S',
            title: 'Small screen (< 768px)',
          }, 'S'),
        ),
      ),
      h('div', { class: 'grid-preview-note' }, 'Structural: heights are not to scale'),
      ...previewRoots.map(r => h('div', { class: 'grid-preview-tab' },
        r.type === 'Tab' ? h('div', { class: 'grid-preview-tab-label' }, r.name ?? r.businessId ?? r.rid) : null,
        this.renderGridNode(r, nodes, colField, 0),
      )),
    );
  }

  /** Is `node` a Tab descended from the TabSet/Scorecard at `rootRid`?
   *  Walks up parentRid in the flat layout array. Used by the grid
   *  preview to enumerate the tabs that belong to the current context. */
  private isDescendantOfTabSet(node: LayoutNode, rootRid: string, nodes: LayoutNode[]): boolean {
    const byRid = new Map(nodes.map(n => [n.rid, n]));
    let cur: LayoutNode | undefined = node;
    let depth = 0;
    while (cur && depth < 20) {
      if (cur.rid === rootRid) return true;
      if (!cur.parentRid) return false;
      cur = byRid.get(cur.parentRid);
      depth++;
    }
    return false;
  }

  /** Render one node + its layout children as a CSS Grid. Recursive.
   *  Container/Tab → grid container with 6 columns; children get
   *  `grid-column: span N` where N is their `columns*Screen` for the
   *  active breakpoint. Widgets → leaf cell with type + name. */
  private renderGridNode(
    node: LayoutNode,
    nodes: LayoutNode[],
    colField: 'columnsLargeScreen' | 'columnsMediumScreen' | 'columnsSmallScreen',
    depth: number,
  ): HTMLElement {
    const MAX_DEPTH = 6;
    if (depth > MAX_DEPTH) {
      return h('div', { class: 'grid-cell grid-cell--deep' }, '…');
    }
    const span = (node[colField] ?? 6) || 6;
    const color = getTypeColor(node.type);
    const cls = ['grid-cell', `grid-cell--${node.type.toLowerCase()}`];
    if (span === 0) cls.push('grid-cell--hidden');
    if (this.highlightedNodeRid === node.rid) cls.push('grid-cell--highlight');

    // Children of THIS node (other Containers + Widgets bound here).
    // For widgets, `containerRid` is their home (write-once binding);
    // for layout nodes, `parentRid` is the bmp .parent linkage.
    const layoutChildren = nodes.filter(n =>
      (n.type === 'Container' && n.parentRid === node.rid)
    );
    const widgetChildren = nodes.filter(n =>
      n.type !== 'Container' && n.type !== 'Tab' && n.type !== 'TabSet' && n.containerRid === node.rid,
    );
    const allChildren = [...layoutChildren, ...widgetChildren];
    const hasChildren = allChildren.length > 0;

    const styleParts: string[] = [];
    if (depth > 0) styleParts.push(`grid-column: span ${Math.max(1, Math.min(6, span === 0 ? 1 : span))}`);
    if (hasChildren) {
      styleParts.push('display: grid');
      styleParts.push('grid-template-columns: repeat(6, 1fr)');
      styleParts.push('grid-auto-rows: minmax(28px, auto)');
      styleParts.push('gap: 2px');
    }
    const style = styleParts.join('; ');

    return h('div', {
      class: cls.join(' '),
      style,
      'data-action': 'focus-tree-row',
      'data-rid': node.rid,
      title: `${node.type} · ${node.name ?? node.businessId ?? node.rid} · ${span}/6 (${this.gridBreakpoint})`,
    },
      // Type chip + name pair. The chip is the same colour scheme as
      // the layout tree, so the user's eyes can match the same node
      // across both surfaces.
      h('div', { class: 'grid-cell-head' },
        h('span', { class: 'grid-cell-type', style: `--type-color:${color}` }, getTypeAbbr(node.type)),
        h('span', { class: 'grid-cell-name' }, node.name ?? node.businessId ?? truncRid(node.rid)),
        span === 0 ? h('span', { class: 'grid-cell-hidden-badge', title: 'columns=0: hidden at this breakpoint' }, '∅') : null,
      ),
      // Children recurse into the same grid system.
      ...allChildren.map(c => this.renderGridNode(c, nodes, colField, depth + 1)),
    );
  }

  private renderLayout(rootRid: string, nodes: LayoutNode[]): HTMLElement {
    // Index by rid for fast lookup.
    const byRid = new Map(nodes.map(n => [n.rid, n]));
    // children-by-effective-parent. For widgets we group under
    // `containerRid` (their layout home). For everything else we use
    // `parentRid`.
    const childrenOf = new Map<string, LayoutNode[]>();
    const LAYOUT_TYPES = new Set(['Tab', 'TabSet', 'Container', 'Scorecard']);
    for (const n of nodes) {
      const parent = LAYOUT_TYPES.has(n.type)
        ? n.parentRid
        : (n.containerRid ?? n.parentRid);
      if (!parent || !byRid.has(parent)) continue;
      const list = childrenOf.get(parent) ?? [];
      list.push(n);
      childrenOf.set(parent, list);
    }
    const root = byRid.get(rootRid);
    if (!root) return h('div', { class: 'empty-state empty-state--compact' }, 'No layout data for this object.');

    // Auto-expand by size budget — open enough nodes to show ~30 rows
    // by default. Better than a depth-only cut: a wide scorecard with
    // many tabs shows tabs without forcing every container open; a
    // narrow scorecard with deep nesting expands further automatically.
    // User-toggled expansions in `expandedNodes` always override this.
    const AUTO_EXPAND_BUDGET = 30;
    const autoExpanded = new Set<string>();
    let visibleBudget = AUTO_EXPAND_BUDGET;
    const stack: string[] = [root.rid];
    while (stack.length && visibleBudget > 0) {
      const rid = stack.shift()!;
      autoExpanded.add(rid);
      const kids = childrenOf.get(rid) ?? [];
      visibleBudget -= kids.length;
      if (visibleBudget < 0) break;
      for (const k of kids) stack.push(k.rid);
    }

    return h('div', { class: 'layout-tree' }, this.renderLayoutNode(root, childrenOf, 0, autoExpanded));
  }

  private renderLayoutNode(
    node: LayoutNode,
    childrenOf: Map<string, LayoutNode[]>,
    depth: number,
    autoExpanded: Set<string>,
  ): HTMLElement {
    const kids = childrenOf.get(node.rid) ?? [];
    const isExpanded = this.expandedNodes.has(node.rid) || autoExpanded.has(node.rid);
    const hasKids = kids.length > 0;
    const color = getTypeColor(node.type);
    const cols = node.columnsLargeScreen;
    const showSize = cols != null && (node.type === 'Tab' || node.type === 'Container' || node.type === 'CustomVisualization' || node.type === 'ExtendedTable' || node.type === 'InputView' || node.type === 'TextElement' || node.type === 'ActionButton');

    // Tab + TabSet are SHARED resources — the same TabSet can power
    // many scorecards. Surface in the tooltip so users know they're
    // editing more than this scorecard's view.
    const sharedNote = node.type === 'Tab' || node.type === 'TabSet'
      ? ' (shared resource: affects every Scorecard bound to this TabSet)'
      : '';

    const row = h('div', {
      class: `layout-row layout-row--${node.type.toLowerCase()}${this.highlightedNodeRid === node.rid ? ' layout-row--highlight' : ''}`,
      style: `padding-left:${depth * 14}px`,
      'data-layout-rid': node.rid,
      'data-layout-type': node.type,
    },
      // Drag handle slot — present on every row to keep the chevron /
      // type chip / name vertically aligned. Tabs AND Containers get a
      // live ≡ glyph: drag a Tab to reorder within its TabSet, drag a
      // Container to reorder among its sibling Containers. Other types
      // (Widget, TabSet, Scorecard) get a fixed-width spacer.
      (node.type === 'Tab' || node.type === 'Container')
        ? h('span', {
            class: 'layout-handle',
            title: node.type === 'Tab'
              ? 'Drag to reorder this tab'
              : 'Drag to reorder this container among its siblings',
          }, '≡')
        : h('span', { class: 'layout-handle layout-handle--spacer', 'aria-hidden': 'true' }),
      h('span', {
        class: `layout-chev${hasKids ? ' clickable' : ''}`,
        'data-action': hasKids ? 'toggle-layout-node' : undefined,
        'data-rid': node.rid,
      }, hasKids ? (isExpanded ? '▾' : '▸') : '  '),
      h('span', { class: 'layout-type', style: `--type-color:${color}`, title: node.type }, getTypeAbbr(node.type)),
      h('span', {
        class: 'layout-name',
        'data-action': 'nav-layout-node',
        'data-rid': node.rid,
        title: `${node.businessId ?? node.rid}. Click to open in detail view`,
      }, node.name || node.businessId || truncRid(node.rid)),
      showSize
        ? h('span', {
            class: `layout-size${node.type === 'Tab' ? ' layout-size--shared' : ''}`,
            'data-rid': node.rid,
            title: `Columns (L): ${cols}/6. Drag to resize (0..6)${sharedNote}`,
          },
            h('span', { class: 'layout-size-bar' },
              ...Array.from({ length: 6 }, (_, i) =>
                h('span', { class: `layout-size-cell${i < cols! ? ' filled' : ''}` }),
              ),
            ),
            h('span', { class: 'layout-size-num' }, `${cols}`),
          )
        : null,
    );

    const branch = h('div', { class: 'layout-branch' }, row);
    if (isExpanded && hasKids) {
      // Stable order: layout objects first (Tab > Container), widgets
      // last. Within each band keep server order (DOM order on the page).
      const layoutChildren = kids.filter(k => k.type === 'Tab' || k.type === 'Container');
      const widgetChildren = kids.filter(k => k.type !== 'Tab' && k.type !== 'Container');
      for (const k of [...layoutChildren, ...widgetChildren]) {
        branch.appendChild(this.renderLayoutNode(k, childrenOf, depth + 1, autoExpanded));
      }
    }
    return branch;
  }
}
