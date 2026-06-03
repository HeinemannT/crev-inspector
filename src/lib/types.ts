/** Unified connection state — single source of truth for health + auth */
export interface ConnectionState {
  display: 'not-configured' | 'checking' | 'connected' | 'online' | 'auth-failed' | 'server-down' | 'unreachable';
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

// ── Page & Object Discovery ──────────────────────────────────────
export type PageMessage =
  | { type: 'OBJECTS_DISCOVERED'; objects: BmpObject[] }
  | { type: 'GET_PAGE_INFO' }
  | { type: 'PAGE_INFO'; url: string; rid?: string; tabRid?: string; tabName?: string; widgets: WidgetInfo[]; detection?: { confidence: number; signals: string[]; isBmp: boolean } }
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
  | { type: 'CACHE_DATA'; objects: BmpObject[] }
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
  | { type: 'OPEN_EDITOR'; rid: string; property?: string; scrollToLine?: number }
  | { type: 'OPEN_EXTENDED' };

// ── Frame Overlay (in-page floating iframes for editor/diff/objectview/codesearch) ─
export type FrameOverlayMessage =
  | { type: 'MOUNT_FRAME'; kind: FrameKind; url: string; label: string; defaultWidth: number; defaultHeight: number };

// Frame kinds are the in-page iframe surfaces.
export type FrameKind = 'editor' | 'diff' | 'objectview' | 'codesearch';

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
  | { type: 'LAYOUT_TREE_RESULT'; rid: string; nodes: LayoutNode[]; error?: string }
  | { type: 'MOVE_OBJECT'; rid: string; relTo: string; position: 'above' | 'below' }
  | { type: 'MOVE_OBJECT_RESULT'; rid: string; ok: boolean; error?: string };

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
export type InspectorMessage =
  | PageMessage | InspectMessage | CacheMessage | ServerLookupMessage
  | ConnectionMessage | ProfileMessage | EcMessage | FrameOverlayMessage | EnrichMessage
  | PaintMessage | DetectionMessage | ActivityMessage
  | HistoryMessage | FavoritesMessage | ContextMenuMessage
  | OverlayModeMessage | ObjectViewMessage | ObjectPaneMessage
  | DiffMessage | CodeSearchMessage | ScriptHistoryMessage
  | ColorMessage | NotificationMessage;

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
  bmpUser: string;
  bmpPass: string;
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
  schemaVersion: 1,
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
export const CHART_TYPES = ['BarChart','PieChart','LineChart','AreaChart','WaterfallChart','BubbleChart','RadarChart','TreeChart','GanttChart','NetworkChart','PolarChart','BarLineChart'] as const;
const CHART_COLOR = '#fa4d56'; // viz red
const CHART_ABBREVIATIONS: Record<string, string> = {
  BarChart: 'BAR', PieChart: 'PIE', LineChart: 'LIN', AreaChart: 'ARA',
  WaterfallChart: 'WFL', BubbleChart: 'BUB', RadarChart: 'RDR', TreeChart: 'TRE',
  GanttChart: 'GNT', NetworkChart: 'NET', PolarChart: 'PLR', BarLineChart: 'BLC',
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

  // ── Visualization (warm family) ───────────────────────────────
  ExtendedTable:       '#fa4d56',
  FilterTable:         '#ff6b6b',
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

