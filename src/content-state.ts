/**
 * Content script state — single object holding all mutable state.
 * Replaces 20 scattered module-level `let` variables.
 * Can be reset atomically on page unload or re-injection.
 */

import type { EditPageContext, EnrichMode, PaintPhase } from './lib/types';
import type { DetectionResult } from './lib/dom-scanner';

/** Cascade target on the badge — for flow-bearing widgets we surface the
 *  next link in the chain (InputView → inputSet, ActionButton → actionObject)
 *  as a second pill so the structure is visible at a glance. */
export type CascadeTarget = { rid: string; businessId?: string; type?: string; name?: string };
export type EnrichmentData = {
  businessId?: string;
  type?: string;
  name?: string;
  templateBusinessId?: string;
  cascade?: CascadeTarget;
};

export type EditPageInspectField = {
  rid: string;
  businessId: string;
  name: string;
  className: 'EditField' | 'EditPageInfo';
  /** Index in the complete EditPage child stream, including non-EditField rows. */
  streamIndex: number;
  property?: string;
  propertyObject?: CascadeTarget;
};

export class ContentState {
  inspectActive = false;
  enrichMode: EnrichMode = 'widgets';
  paintPhase: PaintPhase = 'off';
  paintSourceName: string | null = null;
  styleInjected = false;
  technicalOverlay = false;
  fromSync = false;
  prevConnDisplay: string | null = null;
  environment: string | null = null;
  lastUrl = typeof window !== 'undefined' ? window.location.href : '';
  lastDetection: DetectionResult | null = null;

  /** Page context from the MAIN-world interceptor (React fiber). The bound
   *  object + active tab — the only source on BMP's custom-routed pages where
   *  the URL/DOM are blank. Fed by PAGE_CONTEXT, consumed by resolvePageContext.
   *  Cleared on URL change so a stale page object can't outlive a navigation. */
  fiberPageContext: { rid?: string; tabRid?: string } | null = null;

  /** Form-definition identity on BMP create/edit routes. Kept separate from
   * fiberPageContext so showing the EditPage chip cannot change execution
   * context for Blueprint or Extended Code. */
  editPageContext: EditPageContext | null = null;
  /** Ordered EditField identities resolved from the standalone EditPage.
   *  The DOM carries only native form controls, so this is the join table
   *  Inspect uses to project configuration badges onto those controls. */
  editPageInspectRid: string | null = null;
  editPageInspectFields: EditPageInspectField[] = [];
  editPageInspectLoadingRid: string | null = null;
  editPageInspectRequest = 0;
  editPageInspectRetryAt = 0;

  // Enrichment data from server (RID → identity)
  enrichments = new Map<string, EnrichmentData>();

  // Cached properties for technical overlay cards
  overlayProps = new Map<string, Record<string, string>>();

  // Tracks which elements already have overlays attached
  badgedElements = new WeakSet<Element>();

  // Dedup: RIDs we've already requested enrichment for
  requestedRids = new Set<string>();

  // Dedup: RIDs we've already sent as OBJECTS_DISCOVERED
  discoveredRids = new Set<string>();

  // Favorites cache for quick inspector star state
  favoriteRids = new Set<string>();

  // MutationObserver instance
  observer: MutationObserver | null = null;

  // Timers
  tooltipHideTimer: ReturnType<typeof setTimeout> | null = null;
  debounceTimer: ReturnType<typeof setTimeout> | null = null;
  /** Coalesced BMP render/context refresh owned by content-observer. It lives
   *  here (rather than in the observer closure) so reinjection can cancel it. */
  renderRefreshTimer: ReturnType<typeof setTimeout> | null = null;

  // Transient DOM state — the badge pill the cursor is currently over
  // (hover-tooltip dedup guard).
  hoveredLabelEl: Element | null = null;
  /** Current rich object-card anchor + keyboard trigger. The card is portalled
   *  under documentElement, so these references preserve its focus contract. */
  tooltipLabelEl: HTMLElement | null = null;
  tooltipTriggerEl: HTMLElement | null = null;
  tooltipRestoreInProgress = false;

  // Synthetic identity attached to BMP's normal page heading. It is cached
  // until the heading detaches or the resolved page RID changes, so a busy
  // dashboard does not repeatedly run header detection.
  pageHeaderElement: HTMLElement | null = null;
  pageHeaderLabel: HTMLElement | null = null;
  pageHeaderRid: string | null = null;

  /** AbortController whose signal is passed to every page-lifetime
   *  event listener (document.body mouseover, paint banner clicks, etc.).
   *  Aborted by resetAll() so a re-injection or double-load doesn't
   *  pile up duplicate listeners. */
  listenerLifetime: AbortController = new AbortController();

  /** Reset enrichment-related state (on inspect off, URL change, or re-inject) */
  resetOverlays() {
    this.badgedElements = new WeakSet();
    this.requestedRids.clear();
    this.overlayProps.clear();
    this.hoveredLabelEl = null;
    this.tooltipLabelEl = null;
    this.tooltipTriggerEl = null;
    this.tooltipRestoreInProgress = false;
  }

  /** Reset discovery dedup (on URL change) */
  resetDiscovery() {
    this.discoveredRids.clear();
  }

  resetEditPageInspection() {
    this.editPageInspectRid = null;
    this.editPageInspectFields = [];
    this.editPageInspectLoadingRid = null;
    this.editPageInspectRequest++;
    this.editPageInspectRetryAt = 0;
  }

  /** Full reset for re-injection guard */
  resetAll() {
    this.inspectActive = false;
    this.enrichMode = 'widgets';
    this.paintPhase = 'off';
    this.paintSourceName = null;
    this.styleInjected = false;
    this.technicalOverlay = false;
    this.fromSync = false;
    this.prevConnDisplay = null;
    this.environment = null;
    this.lastUrl = typeof window !== 'undefined' ? window.location.href : '';
    this.lastDetection = null;
    this.fiberPageContext = null;
    this.editPageContext = null;
    this.resetEditPageInspection();
    this.enrichments.clear();
    this.resetOverlays();
    this.pageHeaderElement = null;
    this.pageHeaderLabel = null;
    this.pageHeaderRid = null;
    this.resetDiscovery();
    this.favoriteRids.clear();
    if (this.debounceTimer) { clearTimeout(this.debounceTimer); this.debounceTimer = null; }
    if (this.renderRefreshTimer) { clearTimeout(this.renderRefreshTimer); this.renderRefreshTimer = null; }
    if (this.tooltipHideTimer) { clearTimeout(this.tooltipHideTimer); this.tooltipHideTimer = null; }
    this.observer?.disconnect();
    this.observer = null;
    // Detach every page-lifetime listener in one shot, then arm a
    // fresh controller for the next injection cycle.
    this.listenerLifetime.abort();
    this.listenerLifetime = new AbortController();
  }
}
