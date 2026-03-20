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
  | { type: 'PAGE_INFO'; url: string; rid?: string; tabRid?: string; widgets: WidgetInfo[]; detection?: { confidence: number; signals: string[]; isBmp: boolean } }
  | { type: 'SELECT_OBJECT'; rid: string }
  | { type: 'COPY_TO_CLIPBOARD'; text: string };

// ── Inspect Toggle ───────────────────────────────────────────────
export type InspectMessage =
  | { type: 'TOGGLE_INSPECT' }
  | { type: 'INSPECT_STATE'; active: boolean };

// ── Cache ────────────────────────────────────────────────────────
export type CacheMessage =
  | { type: 'GET_CACHE'; filter?: string }
  | { type: 'CACHE_DATA'; objects: BmpObject[] }
  | { type: 'CLEAR_CACHE' }
  | { type: 'CACHE_STATS'; count: number };

// ── Server Lookup (detail view) ──────────────────────────────────
export type ServerLookupMessage =
  | { type: 'SERVER_LOOKUP'; rid: string }
  | { type: 'SERVER_LOOKUP_RESULT'; rid: string; object: BmpObject | null; error?: string };

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
  | { type: 'EC_RESULT'; ok: boolean; log?: string; hasError?: boolean; hasWarning?: boolean; error?: string }
  | { type: 'SAVE_PROPERTY'; rid: string; objectType: string; property: string; value: string }
  | { type: 'SAVE_RESULT'; ok: boolean; error?: string }
  | { type: 'OPEN_EDITOR'; rid: string };

// ── Enrichment ───────────────────────────────────────────────────
export type EnrichMessage =
  | { type: 'ENRICH_BADGES'; rids: string[] }
  | { type: 'BADGE_ENRICHMENT'; enrichments: Record<string, { businessId?: string; type?: string; name?: string }> }
  | { type: 'ENRICH_MODE'; mode: EnrichMode }
  | { type: 'RE_ENRICH' }
  | { type: 'REFRESH_ENRICHMENT' };

// ── Paint Format ─────────────────────────────────────────────────
export type PaintMessage =
  | { type: 'TOGGLE_PAINT' }
  | { type: 'PAINT_STATE'; phase: PaintPhase; sourceRid?: string; sourceName?: string }
  | { type: 'PAINT_PICK'; rid: string }
  | { type: 'PAINT_APPLY'; rid: string }
  | { type: 'PAINT_PREVIEW'; rid: string; diff: Array<{ prop: string; from: string; to: string }> }
  | { type: 'PAINT_CONFIRM'; rid: string }
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
  | { type: 'FULL_LOOKUP_RESULT'; rid: string; object: BmpObject | null; template?: { rid: string; name: string; type: string }; children?: Array<{ rid: string; name?: string; type?: string; businessId?: string }>; error?: string };

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
  | { type: 'CODE_SEARCH_START'; query: string; subtreeRid?: string; types?: string[] }
  | { type: 'CODE_SEARCH_PROGRESS'; results: CodeSearchResult[]; searched: number; total: number }
  | { type: 'CODE_SEARCH_DONE'; totalResults: number; totalSearched: number }
  | { type: 'CODE_SEARCH_STOP' };

// ── Script History ───────────────────────────────────────────────
export interface ScriptHistoryEntry {
  code: string; timestamp: number; ok: boolean; mode: 'preview' | 'execute';
}

export type ScriptHistoryMessage =
  | { type: 'GET_SCRIPT_HISTORY' }
  | { type: 'SCRIPT_HISTORY_DATA'; entries: ScriptHistoryEntry[] };

// ── Full union (backward-compatible) ─────────────────────────────
export type InspectorMessage =
  | PageMessage | InspectMessage | CacheMessage | ServerLookupMessage
  | ConnectionMessage | ProfileMessage | EcMessage | EnrichMessage
  | PaintMessage | DetectionMessage | ActivityMessage
  | HistoryMessage | FavoritesMessage | ContextMenuMessage
  | OverlayModeMessage | ObjectViewMessage
  | DiffMessage | CodeSearchMessage | ScriptHistoryMessage;

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
}

export const DEFAULT_SETTINGS: InspectorSettings = {
  schemaVersion: 1,
  profiles: [],
  activeProfileId: '',
  autoDetect: true,
  saveTarget: 'template',
  enrichMode: 'all',
};

/** Chart types — all share the same color (#33b1ff) */
export const CHART_TYPES = ['BarChart','PieChart','LineChart','AreaChart','WaterfallChart','BubbleChart','RadarChart','TreeChart','GanttChart','NetworkChart','PolarChart','BarLineChart'] as const;
const CHART_COLOR = '#33b1ff';
const CHART_ABBREVIATIONS: Record<string, string> = {
  BarChart: 'BAR', PieChart: 'PIE', LineChart: 'LIN', AreaChart: 'ARA',
  WaterfallChart: 'WFL', BubbleChart: 'BUB', RadarChart: 'RDR', TreeChart: 'TRE',
  GanttChart: 'GNT', NetworkChart: 'NET', PolarChart: 'PLR', BarLineChart: 'BLC',
};

/** Type badge colors */
const TYPE_COLORS: Record<string, string> = {
  Organisation: '#4589ff',
  Scorecard: '#08bdba',
  ExtendedTable: '#33b1ff',
  CustomVisualization: '#be95ff',
  DashboardFolder: '#ff7eb6',
  EditPage: '#42be65',
  StatusType: '#f1c21b',
  Strategy: '#78a9ff',
  Theme: '#08bdba',
  Perspective: '#82cfff',
  Objective: '#ff7eb6',
  Measure: '#42be65',
  Risk: '#fa4d56',
  Control: '#3ddbd9',
  Action: '#ff832b',
  ...Object.fromEntries(CHART_TYPES.map(t => [t, CHART_COLOR])),
};

const TYPE_ABBREVIATIONS: Record<string, string> = {
  Organisation: 'ORG',
  Scorecard: 'SC',
  ExtendedTable: 'TBL',
  CustomVisualization: 'CVO',
  DashboardFolder: 'DSH',
  EditPage: 'PG',
  StatusType: 'ST',
  Strategy: 'STR',
  Theme: 'THM',
  Perspective: 'PER',
  Objective: 'OBJ',
  Measure: 'MEA',
  Risk: 'RSK',
  Control: 'CTL',
  Action: 'ACT',
  ...CHART_ABBREVIATIONS,
};

export const DEFAULT_TYPE_COLOR = '#8d8d8d';

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

/** Map from BMP type → code property names to fetch/save.
 *  All HasExtendedExpression types use 'expression' (CorpoExtendedExpression).
 *  CustomVisualization uses plain String properties 'html' and 'javascript'. */
export const CODE_PROPS_FOR_TYPE: Record<string, readonly string[]> = {
  ExtendedTable: ['expression'],
  ExtendedMethodConfig: ['expression'],
  ...Object.fromEntries(CHART_TYPES.map(t => [t, ['expression'] as readonly string[]])),
  CustomVisualization: ['html', 'javascript'],
};

/** Types that have viewable/editable code properties */
export const TYPES_WITH_CODE = new Set(Object.keys(CODE_PROPS_FOR_TYPE));

