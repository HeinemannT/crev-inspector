import type { AuthMode, AuthVia } from './bmp-auth';
export type { AuthMode, AuthVia };
import type { LModel, PlanNote } from './layout/types';
import type { BlueprintCtx } from './layout/sync';
import type { InstanceFanout, ContainerBlast } from './layout/blast-radius';

/** Unified connection state — single source of truth for health + auth */
export interface ConnectionState {
  display: 'not-configured' | 'checking' | 'connected' | 'online' | 'auth-failed' | 'server-down' | 'unreachable' | 'needs-login' | 'no-config-access';
  /** How the live connection was established (only meaningful when connected). */
  authVia: AuthVia | null;
  version: string | null;
  responseMs: number | null;
  profileLabel: string | null;
  user: string | null;
  workspace: string | null;
  authError: string | null;
  networkOffline: boolean;
  lastUpdate: number;
}

/** Metadata about a BMP object discovered via DOM, fiber, or server */
export interface BmpObject {
  rid: string;
  name?: string;
  type?: string;
  typename?: string;
  businessId?: string;
  templateBusinessId?: string;
  /** Cascade target for flow-bearing widgets (InputView → inputSet,
   *  ActionButton → actionObject). Surfaced on the badge as a second pill so
   *  the chain shape is visible without opening the sidebar. */
  cascade?: { rid: string; businessId?: string; type?: string; name?: string };
  webParentRid?: string;
  /** Breadcrumb context from a live quickSearch hit: the object's web parent
   *  and the page it lives on. Lets Browse disambiguate same-named objects. */
  webParentName?: string;
  pageRid?: string;
  pageName?: string;
  tabRid?: string;
  hasChildren?: boolean;
  properties?: Record<string, unknown>;
  treePath?: string[];
  source: ObjectSource;
  discoveredAt: number;
  updatedAt: number;
}

type ObjectSource = 'dom' | 'fiber' | 'server';

/** Messages between content script, interceptor, and service worker.
 *  Grouped by domain — each group is a standalone type for narrowing in handlers. */

// ── Page context ─────────────────────────────────────────────────

/** Which provider supplied the resolved page object. `none` = no provider
 *  had one (truly contextless page). Ordered by authority in resolution. */
export type PageContextSource = 'url' | 'fiber' | 'dom' | 'none';

/** The single answer to "what object is BMP rendering right now, in what tab".
 *  Resolved once (URL ⊕ fiber ⊕ DOM) and shared by every surface — Page tab,
 *  footer/status chip, Workshop, and the editor's EC execution `this` — so they
 *  can't drift apart. `rid` granularity matches `?rid=`: a scorecard on a
 *  landing page, an enterprise object on a detail page. */
export interface PageContext {
  rid?: string;
  tabRid?: string;
  tabName?: string;
  source: PageContextSource;
}

// ── Page & Object Discovery ──────────────────────────────────────
export type PageMessage =
  | { type: 'OBJECTS_DISCOVERED'; objects: BmpObject[] }
  | { type: 'GET_PAGE_INFO' }
  | { type: 'PAGE_INFO'; url: string; rid?: string; tabRid?: string; tabName?: string; contextSource?: PageContextSource; widgets: WidgetInfo[]; detection?: { confidence: number; signals: string[]; isBmp: boolean } }
  // Page context from the MAIN-world interceptor (React fiber). On BMP's
  // custom-routed pages the bound object lives only in the fiber
  // (`webParentRid` / `selectedTabRid`), never in the URL/DOM. The interceptor
  // posts this to the content script, which both resolves it locally (Page
  // tab) and forwards it to the SW (footer + editor EC `this`).
  | { type: 'PAGE_CONTEXT'; rid?: string; tabRid?: string }
  // Content-script signal: BMP did an SPA route change (URL param flipped).
  // SW forwards by re-running sendPageInfoToPanel so the Page tab's widget
  // list refreshes — without this, post-route widgets show grey "?" until
  // the user clicks Refresh or switches panel tabs.
  | { type: 'BMP_URL_CHANGED' }
  | { type: 'GET_CONTEXT_RID' }
  | { type: 'CONTEXT_RID_DATA'; rid?: string; name?: string; objectType?: string; businessId?: string }
  | { type: 'SELECT_OBJECT'; rid: string }
  | { type: 'COPY_TO_CLIPBOARD'; text: string };

// ── Inspect Toggle ───────────────────────────────────────────────
export type InspectMessage =
  | { type: 'TOGGLE_INSPECT' }
  | { type: 'SET_INSPECT_STATE'; active: boolean }
  | { type: 'INSPECT_STATE'; active: boolean };

// ── Cache ────────────────────────────────────────────────────────
export type CacheMessage =
  | { type: 'GET_CACHE'; filter?: string }
  // `filter` echoes the GET_CACHE filter so a consumer can drop a late/reordered
  // response that no longer matches the current query.
  | { type: 'CACHE_DATA'; objects: BmpObject[]; filter?: string }
  // Live workspace search via BMP's GraphQL quickSearch (the engine the web
  // portal's search box uses). gen guards against out-of-order responses.
  | { type: 'BROWSE_SEARCH'; query: string; page?: number; pageSize?: number; gen: number }
  | { type: 'BROWSE_SEARCH_RESULT'; query: string; gen: number; ok: boolean; objects?: BmpObject[]; totalHits?: number; error?: string }
  | { type: 'CLEAR_CACHE' }
  // Reset everything except user-facing preferences (favorites, settings).
  // Use this when the extension is in a bad state and you want a clean slate
  // without re-configuring servers. Clears: object cache, enrichment state,
  // activity log, compare pivot, context rid per tab, in-flight fetches.
  | { type: 'RESET_ALL' }
  | { type: 'CACHE_STATS'; count: number }
  // Storage quota warning — SW failed to persist the object cache because
  // chrome.storage.local hit the 10 MB ceiling. Panel surfaces a small
  // banner so the user can hit Reset / Clear instead of staring at silent
  // stale data.
  | { type: 'CACHE_QUOTA_WARNING'; size: number }
  // Approximate byte size of the persisted cache — requested on demand by
  // the Connect tab so it can show "N cached · ~X MB".
  | { type: 'GET_CACHE_BYTES' }
  | { type: 'CACHE_BYTES'; bytes: number }
  // In-place BMP navigation: the content script clicks the matching tab
  // button (no reload) and scroll-and-highlights the target widget. Sent by
  // the Extended Code editor's "go to this object" action.
  | { type: 'BMP_GOTO'; bmpTabId?: number; rid?: string; tabRid?: string; tabName?: string }
  // Open a top-level object (a card / page / scorecard) in the BMP portal by
  // navigating the tab to ?rid=<rid>. Unlike BMP_GOTO (which highlights a widget
  // on the CURRENT page), this loads the object's own page.
  | { type: 'BMP_OPEN_OBJECT'; rid: string; bmpTabId?: number }
  // Hard-reload the BMP tab. Out-of-band EC writes (property/colour/style
  // edits from the detail view) do NOT re-render BMP's React DOM — verified
  // live: the committed change is invisible until a full page reload. So
  // after a successful save we offer a one-click reload; the SW reloads the
  // active BMP tab (mirrors BMP_GOTO's tab resolution).
  | { type: 'RELOAD_BMP_TAB'; bmpTabId?: number };

// ── Server Lookup (detail view) ──────────────────────────────────
export type ServerLookupMessage =
  | { type: 'SERVER_LOOKUP'; rid: string }
  | { type: 'SERVER_LOOKUP_RESULT'; rid: string; object: BmpObject | null; error?: string }
  | { type: 'LINKED_LOOKUP'; rid: string; objectType: string }
  | { type: 'LINKED_LOOKUP_RESULT'; rid: string; key: string; label: string; linkedId?: string; linkedName?: string; linkedRid?: string; error?: string }
  | { type: 'HOVER_LOOKUP'; rid: string }
  | { type: 'HOVER_LOOKUP_RESULT'; rid: string; name?: string; objectType?: string; businessId?: string; codePreview?: string }
  | { type: 'HOVER_RESOLVE'; ref: string }
  | { type: 'HOVER_RESOLVE_RESULT'; ref: string; name?: string; objectType?: string; rid?: string; businessId?: string; codePreview?: string }
  // Cross-window jump: the popout's "Layout ↗" button asks the side
  // panel to open the Page tab's Layout view for the given rid (with
  // optional highlight for the widget row that should flash). The SW
  // handler forwards to the panel; the panel orchestrates the
  // switchTab + WorkshopLayoutPane.openLayoutFor. When no panel is open in the
  // popout's source window, the message no-ops silently.
  | { type: 'OPEN_LAYOUT_FOR'; rid: string; highlightRid?: string }
  // Type-schema lookup powering the Vars + Properties panel in the
  // extended-code editor. One round trip per class returns every
  // property (system + custom) with its EC accessor, display label,
  // and config-class. Cached in the SW; refresh=true bypasses the
  // cache and re-fetches. See type-schema-cache.ts.
  | { type: 'FETCH_TYPE_SCHEMA'; className: string; refresh?: boolean }
  | { type: 'FETCH_TYPE_SCHEMA_RESULT'; className: string; ok: boolean; props?: TypeSchemaProp[]; canonicalClassName?: string; error?: string }
  // Allowed values for a class's list/tag properties — drives value
  // autocomplete (WHERE/filter `<listprop> = t.<id>`) and the Vars panel's
  // option dropdowns. Separate from FETCH_TYPE_SCHEMA so a failure here can't
  // regress property-name completion. One EC round trip per class, cached in
  // the SW. See handlers/objects.ts buildOptionsEc.
  | { type: 'FETCH_TYPE_OPTIONS'; className: string; refresh?: boolean }
  | { type: 'FETCH_TYPE_OPTIONS_RESULT'; className: string; ok: boolean; options?: TypeOptionSet[]; error?: string }
  // Resolve a `root.<lcCategory>.children()` style reference to the
  // class of objects it returns — one EC call per category root,
  // cached forever per server.
  | { type: 'RESOLVE_ROOT_CATEGORY'; category: string }
  | { type: 'RESOLVE_ROOT_CATEGORY_RESULT'; category: string; ok: boolean; className?: string };

export interface TypeSchemaProp {
  /** EC accessor (e.g. `domain_tags`). The exact string a script writes
   *  after `_obj.` to read the property. Resolved via the two-step
   *  `.as(linkedTo).as(id)` chain — NOT `.as(linkedTo.id)` which is a
   *  similar-looking EC expression that returns DISPLAY names. */
  accessor: string;
  /** Display label shown in BMP's UI (e.g. "Domain Tags"). */
  label: string;
  /** The property-config class (e.g. `TagMethodConfig`,
   *  `ReferenceMethodConfig`). Drives the kind chip in the UI. */
  configClass: string;
  /** True for BMP built-in props (id, name, parent, …). The Vars panel
   *  filters these out by default; toggling the filter is instant
   *  because the data was already fetched. */
  systemobject: boolean;
}

/** One allowed value of a list/tag property — a ListPropertySetItem or Tag,
 *  addressable in EC as `t.<businessId>`. */
export interface TypeOptionItem {
  /** EC reference form, e.g. `t.master`. Emitted verbatim by value autocomplete
   *  (a literal string would match the display NAME, not the id — fragile). */
  ref: string;
  /** Display name shown as the completion detail (e.g. "Master"). */
  name: string;
}

/** A list/tag property's option set, resolved from its ListPropertySet
 *  (list/historical-list) or TagList (tag). */
export interface TypeOptionSet {
  /** The property accessor the options belong to (e.g. `subtype`). */
  accessor: string;
  /** True for multi-value tag properties — they compare with CONTAINS / IN,
   *  not = / != (single-select lists). */
  multi: boolean;
  items: TypeOptionItem[];
}

// ── Connection & Settings ────────────────────────────────────────
export type ConnectionMessage =
  | { type: 'GET_SETTINGS' }
  | { type: 'SETTINGS_DATA'; settings: InspectorSettings }
  | { type: 'SAVE_SETTINGS'; settings: Partial<InspectorSettings> }
  | { type: 'CONNECTION_TEST' }
  | { type: 'CONNECTION_STATE'; state: ConnectionState }
  | { type: 'GET_CONNECTION_STATE' };

// ── Profiles ─────────────────────────────────────────────────────
export type ProfileMessage =
  | { type: 'SAVE_PROFILE'; profile: ServerProfile }
  | { type: 'DELETE_PROFILE'; profileId: string }
  | { type: 'SET_ACTIVE_PROFILE'; profileId: string }
  | { type: 'PROFILE_SWITCHED'; profileId: string; label: string }
  | { type: 'SHOW_PROFILE_SWITCHER' };

// ── EC Execution ─────────────────────────────────────────────────
export type EcMessage =
  | { type: 'EC_EXECUTE'; code: string; objectRid?: string; transactional?: boolean }
  // `durationMs` is the SW-measured EC round-trip. The panel surfaces it in
  // the status bar latency chip — it's the user-perceived signal of how
  // responsive BMP is to actual work (vs health-check pings).
  | { type: 'EC_RESULT'; ok: boolean; log?: string; hasError?: boolean; hasWarning?: boolean; error?: string; durationMs?: number }
  | { type: 'SAVE_PROPERTY'; rid: string; objectType: string; property: string; value: string }
  | { type: 'SAVE_RESULT'; ok: boolean; error?: string }
  | { type: 'OPEN_EDITOR'; rid: string; property?: string; scrollToLine?: number; scrollToText?: string }
  | { type: 'OPEN_EXTENDED' };

// ── CVO Studio ───────────────────────────────────────────────────
// The CVO studio is the editor's CustomVisualization sibling: it opens a CVO's
// html + javascript as files with a live sandbox preview. Saving reuses
// SAVE_PROPERTY (html/javascript route through saveCodeViaEc), so this family
// only carries the open gesture for now.
export type StudioMessage =
  | { type: 'OPEN_CVO_STUDIO'; rid: string; property?: string }
  // Re-fetch a CVO's code after a save, to confirm what actually landed (the
  // save->reload pattern: catches a silent in-script rollback) and re-seed.
  | { type: 'STUDIO_FETCH_CODE'; rid: string }
  | { type: 'STUDIO_CODE_DATA'; ok: boolean; code?: Record<string, string>; error?: string }
  // Fetch live `_data` from the CVO data servlet for the chosen render context.
  | { type: 'STUDIO_FETCH_DATA'; cvoRid: string; businessObjectRid: string; periodMillis?: number }
  | { type: 'STUDIO_DATA'; ok: boolean; data?: unknown; error?: string; status?: number }
  // CVO data-input children (CustomVisualizationExpression) — referenced by
  // businessId (rids exceed JS safe-int). Edits go through SAVE_PROPERTY; only
  // add (id+key) and delete (childId) need generated EC, on simple identifiers.
  | { type: 'STUDIO_FETCH_CHILDREN'; cvoBid: string }
  | { type: 'STUDIO_CHILDREN'; ok: boolean; children?: StudioChild[]; error?: string }
  | { type: 'STUDIO_ADD_CHILD'; cvoBid: string; childId: string; key: string; childType: StudioChildType }
  | { type: 'STUDIO_CHILD_ADDED'; ok: boolean; rid?: string; error?: string }
  // Save a child's key + its type-specific fields in one EC (handles the table
  // reference + the int timeout that a plain SAVE_PROPERTY can't).
  | { type: 'STUDIO_SAVE_CHILD'; childId: string; childType: StudioChildType; key: string; fields: Partial<Record<'expression' | 'table' | 'url' | 'urlParameters' | 'headers' | 'timeout', string>> }
  | { type: 'STUDIO_CHILD_SAVED'; ok: boolean; error?: string }
  | { type: 'STUDIO_DELETE_CHILD'; childId: string }
  | { type: 'STUDIO_CHILD_DELETED'; ok: boolean; error?: string }
  // Download a FileResource's decoded content (a hosted JS library) to inject
  // into the sandbox preview.
  | { type: 'STUDIO_FETCH_RESOURCE'; rid: string }
  | { type: 'STUDIO_RESOURCE'; ok: boolean; rid: string; text?: string; error?: string }
  // Host a file as a FileResource: write content via EC .change(content :=
  // "name;mime;base64") — the GraphQL path silently writes empty (footgun).
  | { type: 'STUDIO_WRITE_RESOURCE'; resId: string; name: string; mime: string; base64: string }
  | { type: 'STUDIO_RESOURCE_WRITTEN'; ok: boolean; rid?: string; id?: string; error?: string }
  // Resolve a configurator-friendly business id (or a rid) to {rid, id, name}.
  | { type: 'STUDIO_RESOLVE_REF'; ref: string }
  | { type: 'STUDIO_REF_RESOLVED'; ok: boolean; rid?: string; id?: string; name?: string; error?: string }
  // Batch rid -> {id, name} for the dependency list (lookup(rid).id).
  | { type: 'STUDIO_RESOLVE_RIDS'; rids: string[] }
  | { type: 'STUDIO_RIDS_RESOLVED'; ok: boolean; refs?: Array<{ rid: string; id: string; name: string }>; error?: string };

/** The three CVO child kinds, by what they populate in `_data`. */
export type StudioChildType = 'expression' | 'table' | 'connection'

export interface StudioChild {
  /** rid as a string (Java long — never a JS number). */
  rid: string
  /** businessId. */
  id: string
  /** Which `_data.*` map this populates. */
  type: StudioChildType
  /** JS-side key → `_data.<type-map>[key]`. */
  key: string
  /** expression: Reporter-token text → _data.expressions[key]. */
  expression?: string
  /** table: referenced table's business id → _data.tables[key]. */
  table?: string
  /** connection: upstream config → _data.serverConnections[key] (a proxy path). */
  url?: string
  urlParameters?: string
  headers?: string
  timeout?: string
}

// ── Frame Overlay (in-page floating iframes for editor/diff/objectview/codesearch/cvo-studio) ─
export type FrameOverlayMessage =
  | { type: 'MOUNT_FRAME'; kind: FrameKind; url: string; label: string; defaultWidth: number; defaultHeight: number };

// Frame kinds are the in-page iframe surfaces.
export type FrameKind = 'editor' | 'diff' | 'objectview' | 'codesearch' | 'cvo-studio';

// ── Enrichment ───────────────────────────────────────────────────
export type EnrichMessage =
  | { type: 'ENRICH_BADGES'; rids: string[] }
  | { type: 'BADGE_ENRICHMENT'; enrichments: Record<string, { businessId?: string; type?: string; name?: string; templateBusinessId?: string; cascade?: { rid: string; businessId?: string; type?: string; name?: string } }> }
  | { type: 'ENRICH_MODE'; mode: EnrichMode }
  | { type: 'RE_ENRICH' }
  | { type: 'REFRESH_ENRICHMENT' };

// ── Paint Format ─────────────────────────────────────────────────
export type PaintMessage =
  | { type: 'TOGGLE_PAINT' }
  | { type: 'PAINT_STATE'; phase: PaintPhase; sourceRid?: string; sourceName?: string }
  | { type: 'PAINT_PICK'; rid: string }
  | { type: 'PAINT_APPLY'; rid: string }
  | { type: 'PAINT_APPLY_RESULT'; rid: string; ok: boolean; error?: string };

// ── Detection ────────────────────────────────────────────────────
export type DetectionMessage =
  | { type: 'DETECTION_RESULT'; confidence: number; signals: string[]; isBmp: boolean }
  | { type: 'GET_DETECTION' }
  | { type: 'DETECTION_STATE'; phase: DetectionPhase; confidence: number; signals: string[] }
  | { type: 'BMP_SIGNALS_RESULT'; signals: string[] };

// ── Activity ─────────────────────────────────────────────────────
export type ActivityMessage =
  | { type: 'GET_ACTIVITY' }
  | { type: 'ACTIVITY_LOG'; entries: ActivityEntry[] }
  | { type: 'ACTIVITY_ENTRY'; entry: ActivityEntry };

// ── History ──────────────────────────────────────────────────────
export interface HistoryEntry {
  rid: string;
  name?: string;
  type?: string;
  businessId?: string;
  action: 'viewed' | 'edited' | 'painted' | 'ec-executed';
  timestamp: number;
}

export type HistoryMessage =
  | { type: 'GET_HISTORY' }
  | { type: 'HISTORY_DATA'; entries: HistoryEntry[] }
  | { type: 'CLEAR_HISTORY' };

// ── Favorites ────────────────────────────────────────────────────
export interface FavoriteEntry {
  rid: string;
  name?: string;
  type?: string;
  businessId?: string;
  addedAt: number;
}

export type FavoritesMessage =
  | { type: 'TOGGLE_FAVORITE'; rid: string; name?: string; objectType?: string; businessId?: string }
  | { type: 'GET_FAVORITES' }
  | { type: 'FAVORITES_DATA'; entries: FavoriteEntry[] };

// ── Context Menu ─────────────────────────────────────────────────
export type ContextMenuAction = 'copy-rid' | 'copy-bid' | 'copy-name' | 'view-props' | 'open-editor' | 'paint-from';

export type ContextMenuMessage =
  | { type: 'SET_CONTEXT_RID'; rid: string; name?: string; objectType?: string; businessId?: string }
  | { type: 'CONTEXT_MENU_ACTION'; action: ContextMenuAction; rid: string; tabId: number };

// ── Technical Overlay ────────────────────────────────────────────
export type OverlayModeMessage =
  | { type: 'TOGGLE_TECHNICAL_OVERLAY' }
  | { type: 'TECHNICAL_OVERLAY_STATE'; active: boolean }
  | { type: 'GET_OVERLAY_PROPS'; rids: string[] }
  | { type: 'OVERLAY_PROPS_DATA'; props: Record<string, Record<string, string>> };

// ── Object View ──────────────────────────────────────────────────
export type ObjectViewMessage =
  | { type: 'OPEN_OBJECT_VIEW'; rid: string }
  | { type: 'FULL_LOOKUP'; rid: string }
  | { type: 'FULL_LOOKUP_RESULT'; rid: string; object: BmpObject | null; template?: { rid: string; name: string; type: string; businessId?: string }; children?: Array<{ rid: string; name?: string; type?: string; businessId?: string }>; error?: string }
  | { type: 'FETCH_CHILDREN'; rid: string }
  | { type: 'FETCH_CHILDREN_RESULT'; rid: string; children: Array<{ rid: string; name?: string; type?: string; businessId?: string }>; error?: string }
  | { type: 'FETCH_LAYOUT_TREE'; rid: string }
  | { type: 'LAYOUT_TREE_RESULT'; rid: string; nodes: LayoutNode[]; error?: string };

/** A flat node in the layout subtree for a TabSet / Tab / Container /
 *  Scorecard. Parent linkage is via `parentRid`; the panel folds these
 *  into a tree client-side. Only layout-bearing types are included
 *  (Tab, TabSet, Container, plus widget refs at the leaves). */
export interface LayoutNode {
  rid: string;
  parentRid?: string;
  /** Layout owner that hosts this node — for widgets, the cell they
   *  bind to via `container :=`. Null for the root + top-level nodes. */
  containerRid?: string;
  businessId?: string;
  name?: string;
  type: string;
  /** Responsive column sizing (1..6). Set for Tab + Container + any
   *  widget that carries it. Undefined for TabSet (no grid of its own). */
  columnsLargeScreen?: number;
  columnsMediumScreen?: number;
  columnsSmallScreen?: number;
  /** Authored chart/URLView height in px — needed so the blueprint edits from the real value
   *  rather than a default (otherwise a height edit overwrites the live height). */
  chartHeight?: number;
}

// ── Object Pane (sidepanel DetailView property editor) ──────────
export interface ObjectPaneIdentity {
  rid: string;
  businessId: string;
  type: string;
  name: string;
}

/** An object's effective detail card, plus whether it was inherited from the
 *  object's template (enterprise objects carry the card on their template,
 *  not the instance). Shared by ObjectPaneData, the OBJECT_PANE_DATA message,
 *  and the detail-view state so the four sites can't drift. */
export type ObjectPaneCard = ObjectPaneIdentity & { viaTemplate: boolean };

// ── Access Trace (admin permission test) ─────────────────────────

export type AccessTraceAction = 'READ' | 'UPDATE' | 'DELETE' | 'CREATE';

/** One node of the PBAC decision tree returned by AccessTraceCommand.
 *  `element` is the node kind (TraceRequest / Statement / Subject / Action /
 *  HasAccessTo / All / Any / Equal / Contains…), `result` is whether access is
 *  granted at this node (null when not a boolean leaf), `details` is the
 *  type-specific "why" (e.g. Statement → policyRid / statementIndex). */
export interface AccessTraceNode {
  element: string;
  result: boolean | null;
  timedOut: boolean;
  details: Record<string, string>;
  children: AccessTraceNode[];
}

/** A user or role that can be tested as the trace subject. */
export interface AccessSubject {
  rid: string;
  name: string;
  kind: 'user' | 'role';
  businessId?: string;
}
export interface ObjectPaneSiblingMsg {
  rid: string;
  businessId: string;
  name: string;
  type: string;
  isCurrent: boolean;
}
// ── Connections (generic reference relationships) ───────────────────

/** A resolved endpoint of a relationship edge. */
export interface ConnTarget {
  rid: string;
  name: string;
  type: string;
  businessId: string;
  /** The rid resolved to nothing (dangling/deleted reference). */
  broken?: boolean;
  /** Junction far-side (C2): the object on the other side of a thin junction. */
  via?: ConnTarget;
}

/** One relationship field and its current endpoints. */
export interface ConnGroup {
  field: string;
  label: string;
  /** out = forward ref (this → target); in = reverse ref (target → this). */
  direction: 'out' | 'in';
  targets: ConnTarget[];
}

export type ObjectPaneMessage =
  | { type: 'FETCH_OBJECT_PANE'; rid: string }
  | { type: 'CANCEL_FETCH_OBJECT_PANE'; rid: string }
  | { type: 'OBJECT_PANE_DATA'; rid: string;
      instance: ObjectPaneIdentity;
      parent: ObjectPaneIdentity | null;
      template: ObjectPaneIdentity | null;
      card: ObjectPaneCard | null;
      instanceProps: Record<string, string>;
      templateProps: Record<string, string>;
      siblings: ObjectPaneSiblingMsg[];
      /** True child count under the parent; `siblings` may be a capped slice. */
      siblingTotal: number;
      codeFields: Record<string, string>;
      references: Record<string, ObjectPaneIdentity | null>;
      indirectCode: Record<string, string>;
      /** Target rids for indirect code edits. See ObjectPaneData. */
      indirectCodeRids: Record<string, string>;
      contextValues: Record<string, string>;
      gateValues: Record<string, string>;
      lists: Record<string, ObjectPaneIdentity[]>;
      error?: string }
  | { type: 'APPLY_OBJECT_CHANGES'; rid: string; target: 'instance' | 'template'; changes: Record<string, string | number | boolean> }
  | { type: 'APPLY_CHANGES_RESULT'; rid: string; ok: boolean; error?: string }
  // Connections — generic reference relationships (forward + reverse) resolved
  // from the object's class config. The relationship view for domain objects.
  | { type: 'FETCH_CONNECTIONS'; rid: string; className: string }
  | { type: 'CONNECTIONS_RESULT'; rid: string; ok: boolean; groups?: ConnGroup[]; error?: string }
  // Inbound scan — "who references me" via rref(), incl. undeclared edges.
  | { type: 'FETCH_INBOUND'; rid: string }
  | { type: 'INBOUND_RESULT'; rid: string; ok: boolean; targets?: ConnTarget[]; capped?: boolean; error?: string }
  | { type: 'FETCH_FLOW_CHAIN'; rid: string; objectType: string }
  | { type: 'FLOW_CHAIN_DATA'; rid: string; chain: FlowChainMsg | null; error?: string }
  // Access trace (admin permission test)
  | { type: 'FETCH_ACCESS_SUBJECTS' }
  | { type: 'ACCESS_SUBJECTS_DATA'; subjects: AccessSubject[]; canTrace: boolean; error?: string }
  | { type: 'REQUEST_ACCESS_TRACE'; rid: string; subjectRid: string; action: AccessTraceAction }
  | { type: 'ACCESS_TRACE_RESULT'; rid: string; node: AccessTraceNode | null; error?: string };

// Flow walker — InputView/ActionButton/Label downstream graph
export interface FlowCodeFieldMsg {
  prop: string;
  length: number;
  lineCount: number;
  firstLine: string;
  reads?: Array<{ key: string; sourceRid: string }>;
  /** Boolean prop that gates this EC at runtime. When `gateValue !== 'true'`
   *  the UI renders the row dimmed with a gate hint. */
  gateProp?: string;
  gateValue?: string;
  /** Indirection target — when the EC lives on a related object (e.g.
   *  ActionButton.showExpression → ExtendedExpression.expression), Edit
   *  must open the TARGET's field, not the source. See FlowCodeField. */
  targetRid?: string;
  targetProp?: string;
}
export interface FlowStepMsg {
  identity: ObjectPaneIdentity;
  edgeLabel?: string;
  inputKey?: string;
  codeFields?: FlowCodeFieldMsg[];
  children?: FlowStepMsg[];
  hint?: string;
}
export interface FlowChainMsg {
  steps: FlowStepMsg[];
}

// ── Diff ─────────────────────────────────────────────────────────
export type DiffMessage =
  | { type: 'OPEN_DIFF'; leftRid: string; rightRid?: string }
  | { type: 'OPEN_TEMPLATE_DIFF'; rid: string }
  | { type: 'FETCH_DIFF_PROPS'; rid: string }
  | { type: 'DIFF_PROPS_RESULT'; rid: string; props: Record<string, string>; identity: { name?: string; type?: string; businessId?: string }; error?: string }
  | { type: 'SET_COMPARE_RID'; rid: string; name?: string; objectType?: string };

// ── Code Search ──────────────────────────────────────────────────
export interface CodeSearchResult {
  rid: string; name?: string; type?: string; businessId?: string;
  property: string;
  matchingLines: Array<{ lineNum: number; text: string }>;
}

export type CodeSearchMessage =
  | { type: 'OPEN_CODE_SEARCH' }
  | { type: 'CODE_SEARCH_START'; query: string; subtreeRid?: string; types?: string[]; caseSensitive?: boolean }
  | { type: 'CODE_SEARCH_PROGRESS'; results: CodeSearchResult[]; searched: number; total: number }
  | { type: 'CODE_SEARCH_DONE'; totalResults: number; totalSearched: number; error?: string }
  | { type: 'CODE_SEARCH_STOP' }
  | { type: 'CODE_SEARCH_SCOPE'; scope: { rid: string; businessId: string; name: string; type: string } | null; error?: string }
  | { type: 'SEARCH_REFERENCES'; rid: string; businessId?: string; objectType?: string; name?: string };

// ── Script History ───────────────────────────────────────────────
export interface ScriptHistoryEntry {
  code: string; timestamp: number; ok: boolean; mode: 'preview' | 'execute'; durationMs?: number;
}

export type ScriptHistoryMessage =
  | { type: 'GET_SCRIPT_HISTORY' }
  | { type: 'SCRIPT_HISTORY_DATA'; entries: ScriptHistoryEntry[] };

// ── Colors (linked CorpoColor picker) ────────────────────────────
// BMP widget colors (headerColor / fontColor / bgColor) are LINKS to
// CorpoColor objects in CorpoColorSets, not hex strings — so they're picked
// from a list, not typed. The picker fetches the workspace's colorsets once.
export interface ColorOption { bid: string; name: string; rgb: string }
export interface ColorSetData { id: string; name: string; colors: ColorOption[] }
export type ColorMessage =
  // `force` bypasses the persistent colour cache (manual refresh in the picker).
  | { type: 'FETCH_COLOR_SETS'; force?: boolean }
  | { type: 'COLOR_SETS_DATA'; sets: ColorSetData[] };

// ── Notifications (ephemeral panel toasts) ───────────────────────
// SW fires `TOAST` to surface user-action failures that are otherwise
// buried in the Log tab. The panel renders a top-right notification
// that auto-dismisses. Kept separate from `ActivityEntry` so the log
// can stay quiet while the user still sees what failed.
export type NotificationMessage =
  | { type: 'TOAST'; text: string; kind: 'success' | 'error' | 'info' }
  | { type: 'CLOSE_PANEL' }
  /** First message sent by every side-panel instance on connect — tells
   *  the SW which window the panel is attached to. Without this the SW
   *  has to guess via lastFocusedWindow, which breaks when the user has
   *  the panel open in two windows simultaneously (the most-recently-
   *  touched window wins, the other panel goes deaf). */
  | { type: 'PANEL_HELLO'; windowId: number };

// ── Full union (backward-compatible) ─────────────────────────────
/** Blueprint layout-builder messages (sidepanel/content ↔ SW). The SW owns BmpClient and runs
 *  the layout-service; the panel holds the editable model + history and sends high-level
 *  load/apply. Models are plain JSON (LModel) so they cross the port unchanged. */
export type LayoutMessage =
  // Blueprint overlay toggle: panel → SW (BLUEPRINT_TOGGLE) flips per-window state; SW → content/panel
  // (BLUEPRINT_STATE) drives the overlay on/off. Mirrors the inspect/paint toggle convention.
  | { type: 'BLUEPRINT_TOGGLE' }
  | { type: 'BLUEPRINT_STATE'; active: boolean }
  | { type: 'LAYOUT_LOAD'; rid: string }
  // `env` = the active profile id at load time; the panel echoes it back on apply so the SW can
  // reject a commit aimed at a different environment (the user switched profiles mid-edit).
  | { type: 'LAYOUT_LOAD_RESULT'; ok: boolean; env?: string; ctx?: BlueprintCtx; model?: LModel; baseline?: LModel; orphans?: LayoutNode[]; error?: string }
  | { type: 'LAYOUT_APPLY'; env: string; ctx: BlueprintCtx; baseline: LModel; desired: LModel }
  | { type: 'LAYOUT_APPLY_RESULT'; ok: boolean; noop: boolean; stale?: boolean; script?: string; notes?: PlanNote[]; model?: LModel; baseline?: LModel; error?: string }
  // Apply-preview blast radius: is the page a template master (fan-out), and do any touched shared
  // containers reach pages outside the page's own template-family. Best-effort — both may be null.
  | { type: 'LAYOUT_BLAST'; pageId: string; containers: { id: string; rid?: string }[] }
  | { type: 'LAYOUT_BLAST_RESULT'; fanout: InstanceFanout | null; blast: ContainerBlast | null };

export type InspectorMessage =
  | PageMessage | InspectMessage | CacheMessage | ServerLookupMessage
  | ConnectionMessage | ProfileMessage | EcMessage | StudioMessage | FrameOverlayMessage | EnrichMessage
  | PaintMessage | DetectionMessage | ActivityMessage
  | HistoryMessage | FavoritesMessage | ContextMenuMessage
  | OverlayModeMessage | ObjectViewMessage | ObjectPaneMessage
  | DiffMessage | CodeSearchMessage | ScriptHistoryMessage
  | ColorMessage | NotificationMessage | LayoutMessage;

export interface WidgetInfo {
  rid: string;
  name?: string;
  type?: string;
  element?: string;
  rect?: { top: number; left: number; width: number; height: number };
}

export type SaveTarget = 'template' | 'instance';
export type EnrichMode = 'widgets' | 'all';

export interface ServerProfile {
  id: string;
  label: string;
  bmpUrl: string;
  /** Username/password are optional — a `session` profile carries neither and
   *  borrows the browser's live BMP session instead. Empty string = unset. */
  bmpUser: string;
  bmpPass: string;
  /** How this profile authenticates. Defaults to `auto` (session-first, then
   *  password) for migrated profiles; `session` for credential-less ones. */
  authMode?: AuthMode;
}

export interface InspectorSettings {
  schemaVersion: number;
  profiles: ServerProfile[];
  activeProfileId: string;
  autoDetect: boolean;
  saveTarget: SaveTarget;
  enrichMode: EnrichMode;
  /** Which visual-style properties Paint Format copies. Subset of
   *  PAINT_STYLE_PROPS, toggled via the paint button's right-click menu.
   *  Optional/undefined ⇒ copy all (see DEFAULT_SETTINGS + activePaintProps). */
  paintProps?: string[];
}

export const DEFAULT_SETTINGS: InspectorSettings = {
  schemaVersion: 2,
  profiles: [],
  activeProfileId: '',
  autoDetect: true,
  saveTarget: 'template',
  enrichMode: 'all',
  // Default: copy every style prop (mirrors PAINT_STYLE_PROPS, inlined because
  // that const is declared later in this file).
  paintProps: ['headerColor', 'fontColor', 'transparency', 'shadow', 'headerStyle', 'borderStyle'],
};

/** Chart types — all share the same color. Charts are visualizations →
 *  warm/red family per the pill taxonomy below. */
export const CHART_TYPES = ['BarChart','PieChart','LineChart','AreaChart','WaterfallChart','BubbleChart','RadarChart','TreeChart','GanttChart','NetworkChart','PolarChart','BarLineChart','RiskChart','RiskRadarChart'] as const;
// Charts share one softer coral so they read as a family — and so the bold
// ExtendedTable red (#fa4d56) clearly stands out from them. Risk charts get
// their own deeper red below (they're a distinct beast from generic charts).
const CHART_COLOR = '#ff8a80'; // chart coral (lighter than table red)
const RISK_CHART_COLOR = '#d4374a'; // deeper red — risk charts
const CHART_ABBREVIATIONS: Record<string, string> = {
  BarChart: 'BAR', PieChart: 'PIE', LineChart: 'LIN', AreaChart: 'ARA',
  WaterfallChart: 'WFC', BubbleChart: 'BUB', RadarChart: 'RDR', TreeChart: 'TRE',
  GanttChart: 'GNT', NetworkChart: 'NET', PolarChart: 'PLR', BarLineChart: 'BLC',
  // RiskChart / RiskRadarChart are HasExtendedExpression charts too — same viz
  // family, same `expression` code-prop. Explicit abbrs so they don't both
  // collapse to the "RIS" first-three fallback.
  RiskChart: 'RKC', RiskRadarChart: 'RRC',
};

/**
 * Pill colors — semantic taxonomy.
 *
 * The user should be able to read a page at a glance and tell what each
 * widget DOES from the pill color alone:
 *
 *   • Blue family     → interactable (user clicks/types: inputs, buttons)
 *   • Warm/red family → visualization (tables, charts, dashboards)
 *   • Green family    → structural/page (pages, scorecards, model)
 *   • Purple family   → logic / code-bearing (workflow, EC, expression)
 *   • Cool neutral    → content (text, labels — passive)
 *   • Domain palette  → preserved for Risk/Control/Action/Measure etc. since
 *                       those carry meaning beyond UI-role classification
 *   • #707070 grey    → unknown / not-yet-loaded (DEFAULT_TYPE_COLOR below)
 *
 * Keep families internally distinguishable (light/medium/dark per family) so
 * adjacent pills on a dense page don't read as one block of color.
 */
const TYPE_COLORS: Record<string, string> = {
  // ── Structural / page (green family) ──────────────────────────
  Organisation: '#24a148',
  Scorecard:    '#42be65',
  EditPage:     '#6fdc8c',
  ModelPage:    '#6fdc8c',

  // ── Layout structure (indigo family) ──────────────────────────
  // Tabs / containers organise the page. Given their own hue so they
  // read as navigation/layout chrome and stop falling back to the
  // anonymous "unknown" grey in trees and chips.
  TabSet:    '#5d6bc7',
  Tab:       '#7e8ce0',
  Container: '#9aa3e8',

  // ── Logic / code (purple family) — transport sits with its EC siblings ──
  ExtendedTransport: '#9b7bff',

  // ── Visualization (warm family) ───────────────────────────────
  // Tables all share the bold red so they read as one group that stands out
  // from the (coral) charts — no need to tell ExtendedTable/ReportTable/
  // FilterTable apart from each other.
  ExtendedTable:       '#fa4d56',
  FilterTable:         '#fa4d56',
  FilteredComments:    '#ff8389',
  ReportTable:         '#fa4d56',
  CustomVisualization: '#ff8389',
  DashboardFolder:     '#ff7eb6',
  DashboardHTML:       '#ff7eb6',

  // ── Interactables (blue family) ───────────────────────────────
  InputView:        '#1f8bff',
  InputSet:         '#4589ff',
  TextInput:        '#78a9ff',
  NumberInput:      '#78a9ff',
  DateInput:        '#78a9ff',
  ChoiceInput:      '#78a9ff',
  BooleanInput:     '#78a9ff',
  ButtonInput:      '#0f62fe',
  ActionButton:     '#0f62fe',
  CreateObjectView: '#4589ff',

  // ── Logic / code-bearing (purple family) ──────────────────────
  Workflow:           '#a56eff',
  ExtendedCode:       '#be95ff',
  ExtendedExpression: '#d4bbff',

  // ── Content (passive but coloured to stand out from #707070 unknown) ──
  // Warm muted tone — narrative content, not interactable but distinct from
  // "type not yet known" greys.
  TextElement: '#d2a373',
  Label:       '#bca37a',

  // ── Status ────────────────────────────────────────────────────
  StatusType: '#f1c21b',

  // ── Domain palette (preserved — meanings beyond UI role) ──────
  Strategy:    '#33b1ff',
  Theme:       '#08bdba',
  Perspective: '#82cfff',
  Objective:   '#08bdba',
  Measure:     '#42be65',
  Risk:        '#fa4d56',
  Control:     '#3ddbd9',
  Action:      '#ff832b',

  ...Object.fromEntries(CHART_TYPES.map(t => [t, CHART_COLOR])),
  // Risk charts override the generic chart coral with a deeper red so they
  // stand apart from the other charts at a glance.
  RiskChart: RISK_CHART_COLOR,
  RiskRadarChart: RISK_CHART_COLOR,
};

// All abbreviations normalised to 3 characters so pills render at uniform
// width — mixed 2/3-letter codes (IS vs TIN vs CVO) created a stepladder
// effect that was distracting on dense pages.
const TYPE_ABBREVIATIONS: Record<string, string> = {
  Organisation:        'ORG',
  Scorecard:           'SCD',
  ExtendedTable:       'TBL',
  FilterTable:         'FTB',
  FilteredComments:    'FCM',
  ReportTable:         'RTB',
  CustomVisualization: 'CVO',
  DashboardFolder:     'DSH',
  DashboardHTML:       'DHT',
  EditPage:            'EPG',
  ModelPage:           'MPG',
  Container:           'CON',
  TabSet:              'TBS',
  Tab:                 'TAB',
  StatusType:          'STA',
  Strategy:            'STR',
  Theme:               'THM',
  Perspective:         'PER',
  Objective:           'OBJ',
  Measure:             'MEA',
  Risk:                'RSK',
  Control:             'CTL',
  Action:              'ACT',
  InputView:           'INV',
  InputSet:            'INS',
  TextInput:           'TIN',
  NumberInput:         'NIN',
  DateInput:           'DIN',
  ChoiceInput:         'CIN',
  BooleanInput:        'BIN',
  ButtonInput:         'BTN',
  CreateObjectView:    'COV',
  TextElement:         'TXT',
  Label:               'LBL',
  ActionButton:        'ACB',
  Workflow:            'WFL',
  ExtendedCode:        'XCO',
  ExtendedExpression:  'XPR',
  ExtendedTransport:   'XTR',
  ...CHART_ABBREVIATIONS,
};

export const DEFAULT_TYPE_COLOR = '#707070';

export function getTypeColor(type?: string): string {
  if (!type) return DEFAULT_TYPE_COLOR;
  return TYPE_COLORS[type] ?? DEFAULT_TYPE_COLOR;
}

export function getTypeAbbr(type?: string): string {
  if (!type) return '?';
  return TYPE_ABBREVIATIONS[type] ?? type.substring(0, 3).toUpperCase();
}

/** Activity feed entry */
export interface ActivityEntry {
  id: number;
  time: number;
  level: 'info' | 'success' | 'warn' | 'error';
  message: string;
  detail?: string;
  /** Profile the action ran against. Used to filter the Log tab when
   *  the user has multiple environments configured. Missing on legacy
   *  entries — UI treats them as belonging to the active profile. */
  profileId?: string;
}

/** Detection state machine phases */
export type DetectionPhase = 'unknown' | 'checking' | 'detected' | 'not-detected';

/** Paint format phases */
export type PaintPhase = 'off' | 'picking' | 'applying';

/** Property names that contain code/scripts (ordered: primary first) */
export const SCRIPT_PROPS = [
  'expression', 'html', 'javascript',
] as const;

/** Visual style properties to copy with Paint Format */
export const PAINT_STYLE_PROPS = [
  'headerColor', 'fontColor', 'transparency', 'shadow', 'headerStyle', 'borderStyle',
] as const;

/** Pane/paint props that are LINKS to CorpoColor objects (not hex/value props):
 *  written as references (`prop := t.<colorBid>`), picked from the colourset
 *  list, never typed. */
export const COLOR_LINK_PROPS: ReadonlySet<string> = new Set(['headerColor', 'fontColor']);

/** EC literal that RESETS each style prop to "no styling" — emitted by Paint
 *  Format when the source widget lacks the prop, so the target ends up matching
 *  the source. Each value is TYPE-CORRECT per BMP (live-verified 2026-06-02 on
 *  a Text element): colour refs clear with "", transparency with 0, shadow with
 *  FALSE, and the header/border-style enums with their "None" member.
 *  NOTE: `:= ""` ERRORS on number/enum props ("Could not convert value :  into
 *  Transparency/Header style/Border style"), and `:= MISSING` is a silent
 *  no-op — neither is a usable reset, which is why this explicit map exists. */
export const PAINT_PROP_RESET: Record<string, string> = {
  headerColor: '""',
  fontColor: '""',
  transparency: '0',
  shadow: 'FALSE',
  headerStyle: '"None"',
  borderStyle: '"None"',
};

/** A colour-link draft value is stored as `"<bid> <name>"` (the picker writes
 *  both so the UI can show the name without a cache hit). Both the display
 *  layer and the EC serializer need just the leading bid — extract it here so
 *  the parse rule lives in one place. */
export function colorLinkBid(value: unknown): string {
  return String(value ?? '').trim().split(/\s+/)[0] ?? '';
}

/** Map from BMP type → code property names to fetch/save.
 *  All HasExtendedExpression types use 'expression' (CorpoExtendedExpression).
 *  CustomVisualization uses plain String properties 'html' and 'javascript'.
 *
 *  For ActionButton / ButtonInput / Label we list only the DIRECT string
 *  props (`expression`, `initExpression`, `afterExpression`, `defaultExpression`).
 *  Their `showExpression` / `enableExpression` / `validateExpression` are
 *  References to an ExtendedExpression whose `.expression` carries the EC
 *  text — that surface is covered by adding ExtendedExpression itself,
 *  which catches every indirect gate-EC at the source. */
export const CODE_PROPS_FOR_TYPE: Record<string, readonly string[]> = {
  ExtendedTable: ['expression'],
  ExtendedMethodConfig: ['expression'],
  ...Object.fromEntries(CHART_TYPES.map(t => [t, ['expression'] as readonly string[]])),
  CustomVisualization: ['html', 'javascript'],
  ActionButton: ['expression', 'initExpression', 'afterExpression'],
  ButtonInput: ['expression', 'initExpression', 'afterExpression', 'defaultExpression'],
  Label: ['defaultExpression', 'expression'],
  ExtendedTransport: ['expression'],
  ExtendedExpression: ['expression'],
};

/** Types that have viewable/editable code properties */
export const TYPES_WITH_CODE = new Set(Object.keys(CODE_PROPS_FOR_TYPE));

