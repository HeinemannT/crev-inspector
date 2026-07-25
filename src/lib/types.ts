import type { AuthMode, AuthVia } from './bmp-auth';
export type { AuthMode, AuthVia };
import type { AiSettings } from './ai/types';
export type { AiSettings };
// Style-prop catalog is single-sourced in style-props.ts; imported for DEFAULT_SETTINGS below and
// re-exported for back-compat with the many `from './types'` import sites.
import { PAINT_STYLE_PROPS, COLOR_LINK_PROPS, PAINT_PROP_RESET, STYLE_PROPS, styleResetLiteral } from './style-props';
export { PAINT_STYLE_PROPS, COLOR_LINK_PROPS, PAINT_PROP_RESET, STYLE_PROPS, styleResetLiteral };
// The message union and the type-color/abbreviation registry are single-sourced in
// messages.ts / type-registry.ts respectively; re-exported below for back-compat with
// the many `from './types'` import sites.
import { CHART_TYPES } from './type-registry';
export * from './messages';
export * from './type-registry';

/** Unified connection state — single source of truth for health + auth */
export interface ConnectionState {
  display: 'not-configured' | 'checking' | 'reconnecting' | 'connected' | 'online' | 'command-failed' | 'auth-failed' | 'server-down' | 'unreachable' | 'needs-login' | 'no-config-access' | 'needs-access';
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
 *  Grouped by domain — each group is a standalone type for narrowing in handlers.
 *  The message union itself lives in ./messages (re-exported below for back-compat). */

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

/** Identity carried by BMP's create/edit React surface. This is deliberately
 * separate from PageContext: `editPageRid` identifies the form definition,
 * while PageContext continues to identify the bound business object used by
 * Blueprint and EC execution. */
export interface EditPageContext {
  editPageRid: string;
  initializerRid?: string;
  templateRid?: string;
  webParentRid?: string;
  parentRid?: string;
  objectRid?: string;
  objectName?: string;
  objectType?: string;
}

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
  /** Optional help text supplied by BMP's concrete-object `help()` output. */
  description?: string;
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

// Frame kinds are the in-page iframe surfaces.
export type FrameKind = 'editor' | 'diff' | 'objectview' | 'codesearch' | 'cvo-studio';
/** Optional in-place intent for an already-open frame. Today the editor uses
 * this to switch code properties without reloading and losing slot drafts. */
export interface FrameActivation {
  type: 'editor';
  rid: string;
  property?: string;
  scrollToLine?: number;
  scrollToText?: string;
}

// ── History ──────────────────────────────────────────────────────
export interface HistoryEntry {
  rid: string;
  name?: string;
  type?: string;
  businessId?: string;
  action: 'viewed' | 'edited' | 'painted' | 'ec-executed';
  timestamp: number;
}

// ── Favorites ────────────────────────────────────────────────────
export interface FavoriteEntry {
  rid: string;
  name?: string;
  type?: string;
  businessId?: string;
  addedAt: number;
}

/** A flat node in a layout projection. Parent linkage is via `parentRid`;
 *  consumers fold these into a tree client-side. Workshop's portal-tree
 *  fetch returns only TabSet/Tab/Container; Blueprint's dual-model fetch can
 *  additionally carry page-owned widget nodes via `containerRid`. */
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

// ── BMP object identity ─────────────────────────────────────────
/** Canonical resolved identity shared by every extension surface.
 *  RIDs remain strings because BMP uses 64-bit Java longs. */
export interface ObjectIdentity {
  rid: string;
  businessId: string;
  type: string;
  name: string;
}

/** Sparse identity accepted at UI boundaries while enrichment is pending. */
export type ObjectReference = Pick<ObjectIdentity, 'rid'> &
  Partial<Omit<ObjectIdentity, 'rid'>> & {
    templateBusinessId?: string;
  };

/** Compatibility name for pane-specific payloads. New shared UI should use
 *  ObjectIdentity / ObjectReference rather than inventing another shape. */
export type ObjectPaneIdentity = ObjectIdentity;

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

// Flow walker — InputView/ActionButton/Label downstream graph
export interface FlowCodeFieldMsg {
  prop: string;
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

// ── Code Search ──────────────────────────────────────────────────
export interface CodeSearchResult {
  rid: string; name?: string; type?: string; businessId?: string;
  property: string;
  matchingLines: Array<{ lineNum: number; text: string }>;
}

// ── Script History ───────────────────────────────────────────────
export interface ScriptHistoryEntry {
  code: string; timestamp: number; ok: boolean; mode: 'preview' | 'execute'; durationMs?: number;
}

// ── Colors (linked CorpoColor picker) ────────────────────────────
// BMP widget colors (headerColor / fontColor / bgColor) are LINKS to
// CorpoColor objects in CorpoColorSets, not hex strings — so they're picked
// from a list, not typed. The picker fetches the workspace's colorsets once.
export interface ColorOption { bid: string; name: string; rgb: string }
/** `folder` = businessId of the Category the set lives in ('ColorRoot' for the system sets) —
 *  used to order workspace-custom sets ahead of the stock palette in the pickers. */
export interface ColorSetData { id: string; name: string; colors: ColorOption[]; folder?: string }

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
  /** AI coding-assistant config. Absent until the user configures a provider
   *  + key in the Connect tab. The API key inside is stored AES-GCM encrypted;
   *  it is stripped from the session snapshot (see snapshotSettings). */
  ai?: AiSettings;
}

export const DEFAULT_SETTINGS: InspectorSettings = {
  schemaVersion: 3,
  profiles: [],
  activeProfileId: '',
  autoDetect: true,
  saveTarget: 'template',
  enrichMode: 'widgets',
  // Default: copy every paintable style prop (single-sourced — see style-props.ts).
  paintProps: [...PAINT_STYLE_PROPS],
};

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
  // The two sanitized HTML bodies (no EC slots on this type) — also makes
  // Code Search cover TextElement content.
  TextElement: ['text', 'longText'],
};

/** Types that have viewable/editable code properties */
export const TYPES_WITH_CODE = new Set(Object.keys(CODE_PROPS_FOR_TYPE));
