// Message union — extracted from types.ts (Plan 012). Groups every InspectorMessage
// sub-type by domain; each group is a standalone type for narrowing in handlers.
// Re-exported from './types' for back-compat. Imports domain interfaces from './types'
// (type-only) — messages depend on types, never the reverse.
import type {
  AccessSubject,
  AccessTraceAction,
  AccessTraceNode,
  ActivityEntry,
  BmpObject,
  CodeSearchResult,
  ColorSetData,
  ConnGroup,
  ConnTarget,
  ConnectionState,
  DetectionPhase,
  EnrichMode,
  FavoriteEntry,
  FlowChainMsg,
  FrameKind,
  HistoryEntry,
  InspectorSettings,
  LayoutNode,
  ObjectPaneCard,
  ObjectPaneIdentity,
  ObjectPaneSiblingMsg,
  PageContextSource,
  PaintPhase,
  ScriptHistoryEntry,
  ServerProfile,
  StudioChild,
  StudioChildType,
  TypeOptionSet,
  TypeSchemaProp,
  WidgetInfo,
} from './types';
import type { LModel, PlanNote, NodeStyle } from './layout/types';
import type { StylePreset } from './style-presets';
import type { BlueprintCtx } from './layout/sync';
import type { InstanceFanout, ContainerBlast } from './layout/blast-radius';

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
  | { type: 'SELECT_OBJECT'; rid: string; openPanel?: boolean }
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
  | { type: 'PROFILE_SWITCHED'; profileId: string; label: string };

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
  | { type: 'OPEN_STUDIO'; rid: string; property?: string }
  // Re-fetch a CVO's code after a save, to confirm what actually landed (the
  // save->reload pattern: catches a silent in-script rollback) and re-seed.
  | { type: 'STUDIO_FETCH_CODE'; rid: string; props?: string[] }
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

// ── Frame Overlay (in-page floating iframes for editor/diff/objectview/codesearch/cvo-studio) ─
export type FrameOverlayMessage =
  | { type: 'MOUNT_FRAME'; kind: FrameKind; url: string; label: string; defaultWidth: number; defaultHeight: number };

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
export type HistoryMessage =
  | { type: 'GET_HISTORY' }
  | { type: 'HISTORY_DATA'; entries: HistoryEntry[] }
  | { type: 'CLEAR_HISTORY' };

// ── Favorites ────────────────────────────────────────────────────
export type FavoritesMessage =
  | { type: 'TOGGLE_FAVORITE'; rid: string; name?: string; objectType?: string; businessId?: string }
  | { type: 'GET_FAVORITES' }
  | { type: 'FAVORITES_DATA'; entries: FavoriteEntry[] };

// ── Context Menu ─────────────────────────────────────────────────
export type ContextMenuMessage =
  | { type: 'SET_CONTEXT_RID'; rid: string; name?: string; objectType?: string; businessId?: string };

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

// ── Diff ─────────────────────────────────────────────────────────
export type DiffMessage =
  | { type: 'OPEN_DIFF'; leftRid: string; rightRid?: string }
  | { type: 'OPEN_TEMPLATE_DIFF'; rid: string }
  | { type: 'FETCH_DIFF_PROPS'; rid: string }
  | { type: 'DIFF_PROPS_RESULT'; rid: string; props: Record<string, string>; identity: { name?: string; type?: string; businessId?: string }; error?: string };

// ── Code Search ──────────────────────────────────────────────────
export type CodeSearchMessage =
  | { type: 'OPEN_CODE_SEARCH' }
  | { type: 'CODE_SEARCH_START'; query: string; subtreeRid?: string; types?: string[]; caseSensitive?: boolean }
  | { type: 'CODE_SEARCH_PROGRESS'; results: CodeSearchResult[]; searched: number; total: number }
  | { type: 'CODE_SEARCH_DONE'; totalResults: number; totalSearched: number; error?: string }
  | { type: 'CODE_SEARCH_STOP' }
  | { type: 'CODE_SEARCH_SCOPE'; scope: { rid: string; businessId: string; name: string; type: string } | null; error?: string }
  | { type: 'SEARCH_REFERENCES'; rid: string; businessId?: string; objectType?: string; name?: string };

// ── Script History ───────────────────────────────────────────────
export type ScriptHistoryMessage =
  | { type: 'GET_SCRIPT_HISTORY' }
  | { type: 'SCRIPT_HISTORY_DATA'; entries: ScriptHistoryEntry[] };

// ── Colors (linked CorpoColor picker) ────────────────────────────
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
  // Content → SW after the post-apply reload: turn blueprint back ON for the sender tab's window so
  // the editing session survives the refresh (apply toggles it off before reloading — see applyPage).
  | { type: 'BLUEPRINT_RESUME' }
  // Panel → SW after a successful chrome.permissions.request (the standard per-site prompt): re-sync
  // the dynamic content-script registrations and, when a tab is named, inject into it right away
  // (registered scripts only cover future loads) + refresh its detection/page info.
  | { type: 'SITE_ACCESS_CHANGED'; tabId?: number }
  | { type: 'LAYOUT_LOAD'; rid: string; prefer?: 'template' | 'instance' }
  // `env` = the active profile id at load time; the panel echoes it back on apply so the SW can
  // reject a commit aimed at a different environment (the user switched profiles mid-edit).
  | { type: 'LAYOUT_LOAD_RESULT'; ok: boolean; env?: string; ctx?: BlueprintCtx; model?: LModel; baseline?: LModel; orphans?: LayoutNode[]; error?: string }
  | { type: 'LAYOUT_APPLY'; env: string; ctx: BlueprintCtx; baseline: LModel; desired: LModel }
  | { type: 'LAYOUT_APPLY_RESULT'; ok: boolean; noop: boolean; stale?: boolean; script?: string; notes?: PlanNote[]; model?: LModel; baseline?: LModel; error?: string }
  // Apply-preview blast radius: is the page a template master (fan-out), and do any touched shared
  // containers reach pages outside the page's own template-family. Best-effort — both may be null.
  | { type: 'LAYOUT_BLAST'; pageId: string; containers: { id: string; rid?: string }[] }
  | { type: 'LAYOUT_BLAST_RESULT'; fanout: InstanceFanout | null; blast: ContainerBlast | null };

// ── Saved style presets (blueprint paintbrush library) ───────────
// Per-profile named widget appearance presets. The blueprint requests these one-shot (sendRequest);
// SAVE/DELETE mutate then echo the fresh list back as STYLE_PRESETS_DATA.
export type StylePresetMessage =
  | { type: 'LIST_STYLE_PRESETS' }
  | { type: 'SAVE_STYLE_PRESET'; name: string; style: NodeStyle }
  | { type: 'DELETE_STYLE_PRESET'; id: string }
  | { type: 'STYLE_PRESETS_DATA'; presets: StylePreset[] };

export type InspectorMessage =
  | PageMessage | InspectMessage | CacheMessage | ServerLookupMessage
  | ConnectionMessage | ProfileMessage | EcMessage | StudioMessage | FrameOverlayMessage | EnrichMessage
  | PaintMessage | DetectionMessage | ActivityMessage
  | HistoryMessage | FavoritesMessage | ContextMenuMessage
  | OverlayModeMessage | ObjectViewMessage | ObjectPaneMessage
  | DiffMessage | CodeSearchMessage | ScriptHistoryMessage
  | ColorMessage | NotificationMessage | LayoutMessage | StylePresetMessage;
