/**
 * Blueprint editor state — the single `bp` singleton + the constants, with no rendering logic.
 * Actions mutate `bp` and call view.render(); view reads `bp`. Keeping the state here (data only)
 * means neither the view nor the controller owns it, and there's no import cycle through it.
 */
import type { LModel, PlanNote, NodeStyle, FlowNode } from '../lib/layout/types';
import type { StylePreset } from '../lib/style-presets';
import { PAINT_STYLE_PROPS } from '../lib/style-props';
import type { BlueprintCtx } from '../lib/layout/sync';
import type { InstanceFanout, ContainerBlast } from '../lib/layout/blast-radius';
import { History } from '../lib/layout/history';

export const STYLE_ID = 'crev-blueprint-style';

export interface BpState {
  active: boolean;
  baseline: LModel | null;     // the loaded page (boxes anchor to its widgets)
  ctx: BlueprintCtx | null;
  env: string | null;          // env fingerprint from load → echoed on apply
  history: History | null;     // undo/redo over the edited model
  layer: HTMLElement | null;
  selectedId: string | null;
  applying: boolean;
  preview: PlanNote[] | null;   // non-null → the apply-preview modal is open
  previewScript: string;        // the FULL compiled EC behind the open preview (the modal's "Copy EC")
  blast: { fanout: InstanceFanout | null; blast: ContainerBlast | null } | null; // preview blast radius (async, best-effort)
  blastSeq: number;             // bumped per openApplyPreview; a late blast reply for an older seq is dropped
  blastPending: boolean;        // an impact (blast-radius) probe is in flight for the open preview — Confirm waits for it so a shared-master warning can't be skipped by a fast click
  discardArm: boolean;          // Discard button armed ("Sure?"): first click arms, second discards; auto-disarms after a few seconds
  discardTimer: number;         // setTimeout id auto-disarming Discard (0 = none)
  actionMenuOpen: boolean;      // the canvas-top-right action-menu dropdown is expanded (collapsed by default, like BMP's own Actions button, so it never covers the canvas until opened)
  picker: string | null;        // containerId/compositeId/tabId the add picker is open for
  pickerOpts: { afterId?: string; cols?: number; at?: { x: number; y: number } } | null; // positional insert (after a sibling, sized to a gap) + the click point to anchor the picker popup at
  // Flow editing: the add picker for a FLOW container (an InputSet/EditPage/ButtonGroup referenced by a
  // flow widget — NOT in the layout tree, so bp.picker can't address it). key = the container's
  // businessId; className drives the palette (flowChildPalette); afterId = positional insert;
  // isAction = the tray's "Add action" (creates a page-level menu ActionButton instead);
  // wireExisting = the "wire to existing" variant: key = the WIDGET id, className names the ref class
  // (InputSet/EditPage), rows come from bp.flowRefList (fetched at open; null = loading).
  flowPicker: { key: string; className: string; afterId?: string; at?: { x: number; y: number }; isAction?: boolean; wireExisting?: boolean } | null;
  flowRefList: import('../lib/layout/sync').FlowRefListItem[] | null; // wire-to-existing rows (null = loading)
  // Wire-to-existing children cache (FIX 2): the real current children of an EXISTING off-page
  // InputSet/EditPage the user wired to, keyed by ref businessId. Session-scoped (survives edits/undo);
  // baked into the model so the pure diff/render see it. `flowRefChildrenPending` = refs mid-fetch (the
  // cell shows a "loading" note until the reply lands, then falls back to the "unknown contents" note).
  flowRefChildren: Map<string, { className: string; rid?: string; children: FlowNode[] }>;
  flowRefChildrenPending: Set<string>;
  flowFolds: Set<string>;       // flow cells folded on the reference band (by flow-WIDGET id; default expanded)
  trayCardsOpen: Set<string>;   // action-tray ACTION cards with their transport list expanded (by button id)
  movePicker: string | null;    // widgetId the move-destination menu is open for
  tabMenu: { id: string; x: number; y: number } | null; // tab-strip right-click reorder menu (tab id + viewport anchor)
  swatch: { nodeId: string; prop: 'headerColor' | 'fontColor' } | null; // G3: the colour swatch popup target (style mode), null = closed
  swatchExpanded: Set<string>; // G3: which swatch-popup colour folders are open (per session; 'Basics' open by default)
  // G4 — the paintbrush (style mode). `mode`: off / pick (eyedropper, sampling a source) / paint (applying
  // the held style). `held` = the captured appearance. brushMask = which props the brush copies.
  // paintPanel = open popup (setup mask, or the save+library menu).
  brush: { mode: 'off' | 'pick' | 'paint'; held: NodeStyle | null };
  brushMask: Set<string>;
  paintPanel: 'setup' | 'library' | null;
  presets: StylePreset[]; // saved-style library cache (loaded from the SW per profile)
  renameId: string | null;      // node whose inline-rename should OPEN on the next render (dbl-click / toolbar pencil)
  onResize: (() => void) | null; // window 'resize' handler (re-anchors the canvas; scroll is native)
  onKey: ((e: KeyboardEvent) => void) | null;
  onPop: (() => void) | null;    // 'popstate' handler — reloads the overlay when back/forward changes the page rid
  onBeforeUnload: ((e: BeforeUnloadEvent) => void) | null; // 'beforeunload' — warns before a reload/close discards staged edits
  loadedRid: string;             // the URL ?rid= the current model was loaded for (detects a page change on back/forward)
  editingTemplate: boolean;      // F: editing the shared template (vs this instance) — drives the [Template|This instance] toggle
  mode: 'layout' | 'style';      // G3: layout editing (cols/move/rename) vs style editing (colours/shadow/border) — pure render switch, same loaded model
  raf: number;                  // requestAnimationFrame id coalescing resize re-renders (0 = none)
  resultMode: boolean;          // last render used the result canvas (vs the live-fallback) — read by chrome
  gen: number;                  // session generation, bumped on each enable; in-flight I/O captures it
                                //   and bails if it changed (toggle-off-then-on starts a new session)
  hint: string | null;          // transient contextual hint shown in the bottom bar (gesture coaching)
  trayOpen: boolean;            // pending-changes tray docked open
  dragging: boolean;            // a pointer drag is in flight — suppresses scroll re-renders mid-gesture
  renaming: boolean;            // an inline-rename field is open — suppresses re-renders (they'd destroy it)
  observer: MutationObserver | null; // watches BMP content for tab switches (visible rid set changes)
  resizeObs: ResizeObserver | null;  // watches BMP content height — re-render when a widget grows (async table rows) so the backdrop keeps covering it
  ridSig: string;               // signature of the visible rids at last render — re-render when it changes
  mutRaf: number;               // rAF id coalescing mutation-driven re-renders (0 = none)
  bodyResizeTimer: number;      // setTimeout id debouncing body-height (ResizeObserver) re-renders so a lazy-loading table's many growth frames collapse to ONE rebuild (0 = none)
  flipNext: boolean;            // animate result cells from old→new position on the next render (set by an edit)
  viewTabId: string | null;     // tab shown in the canvas (header tab bar switches it); null → follow BMP's live tab
  unusedTabsOpen: boolean;      // tab bar: the "+N empty" fold is expanded (shared-tabset tabs with no widgets on this page)
  ghostTrayOpen: boolean;       // canvas: the per-tab "N hidden widgets" tray below the add-zone is expanded
  scrollSpacer: HTMLElement | null; // body-level spacer that extends page scroll height to cover a taller-than-content panel
  peek: boolean;                // sticky peek toggle (overlay faded so the live widgets show); hover peeks transiently
  // Frozen document-space anchor of the result canvas for the CURRENT tab. The canvas top doesn't move
  // when you scroll or when content grows BELOW it, but a re-render triggered mid-scroll (the body-height
  // ResizeObserver firing on lazy table rows) would otherwise recompute the anchor from whatever widgets
  // are on-screen at that scroll — shifting the canvas off the real widgets. Caching it keeps the canvas
  // pinned; it's recomputed only on a genuine viewport resize (onResize clears it) or a tab/page change
  // (keyed by tabId; cleared in resetModel).
  resultAnchor: { tabId: string; docTop: number; left: number; width: number } | null;
}

/** Every per-session field at its idle/empty value. Defined ONCE so the initial `bp` and the teardown
 *  reset can't drift (a field added to one but not the other used to leak across sessions). `gen` is the
 *  sole field NOT reset here — it's the monotonic session counter. */
function freshState(): Omit<BpState, 'gen'> {
  return {
    active: false, baseline: null, ctx: null, env: null, history: null,
    layer: null, selectedId: null, applying: false, preview: null, previewScript: '', blast: null, blastSeq: 0, blastPending: false, discardArm: false, discardTimer: 0, actionMenuOpen: false, picker: null, pickerOpts: null,
    flowPicker: null, flowRefList: null, flowRefChildren: new Map(), flowRefChildrenPending: new Set(), flowFolds: new Set(), trayCardsOpen: new Set(),
    movePicker: null, tabMenu: null, swatch: null, swatchExpanded: new Set(['Basics']),
    brush: { mode: 'off', held: null }, brushMask: new Set(PAINT_STYLE_PROPS), paintPanel: null, presets: [], renameId: null,
    onResize: null, onKey: null, onPop: null, onBeforeUnload: null, loadedRid: '', editingTemplate: false, mode: 'layout', raf: 0, resultMode: false, hint: null, trayOpen: false, dragging: false, renaming: false,
    observer: null, resizeObs: null, ridSig: '', mutRaf: 0, bodyResizeTimer: 0, flipNext: false, viewTabId: null, unusedTabsOpen: false,
    ghostTrayOpen: false, scrollSpacer: null, peek: false,
    resultAnchor: null,
  };
}

export const bp: BpState = { gen: 0, ...freshState() };

/** Reset every per-session field to idle (preserving the monotonic `gen`) — called on teardown so no
 *  selection, blast probe, observer, peek, etc. leaks into the next session. Listeners/observers/DOM are
 *  torn down by the caller BEFORE this nulls their references. */
export function resetState(): void { Object.assign(bp, freshState()); }

/** Reset just the LOADED-MODEL fields (NOT the whole session) — for reloading onto a different page or
 *  toggling the edit target. Keeps the layer/listeners/gen; clears the model + the view state tied to the
 *  page being left. The single place that knows which fields "are the loaded model", so a new model field
 *  can't be forgotten at a reload site. */
export function resetModel(): void {
  bp.baseline = null; bp.ctx = null; bp.history = null;
  bp.selectedId = null; bp.viewTabId = null; bp.unusedTabsOpen = false; bp.ridSig = ''; bp.peek = false;
  bp.resultAnchor = null; bp.actionMenuOpen = false;
  // In-flight apply / preview state is tied to the page being left. A reload mid-apply (a popstate/
  // link-nav bumps `gen`, so the late apply reply returns early without clearing `applying`) would
  // otherwise leave "Applying…" stuck and Apply/Discard disabled on the fresh page — M5. Clearing it
  // here, the single reload chokepoint, also dismisses a preview modal orphaned by the reload.
  bp.applying = false; bp.preview = null; bp.previewScript = ''; bp.blast = null; bp.blastPending = false;
  if (bp.discardTimer) { clearTimeout(bp.discardTimer); bp.discardTimer = 0; }
  bp.discardArm = false;
  // flow view state is page-scoped: fold state / open cards / picker all refer to the old page's ids
  // (pitfall 10 — temp `new:` ids must not survive a reload; staged edits live in the model itself)
  bp.flowPicker = null; bp.flowRefList = null; bp.flowFolds = new Set(); bp.trayCardsOpen = new Set();
  // the ref-children cache is keyed by page-unique businessIds — stale on a page change / target toggle
  bp.flowRefChildren = new Map(); bp.flowRefChildrenPending = new Set();
}

export function isBlueprintActive(): boolean { return bp.active; }

/** The edited model = history present (baseline + staged edits). Null until a page is loaded. */
export const model = (): LModel | null => {
  const m = bp.history?.present();
  if (!m) return null;
  // Inject the session ref-children cache (on-demand-fetched children of wired-existing off-page
  // InputSets/EditPages) on every read. History.present() clones fresh each call and the stack states
  // predate the async fetch, so this is the only reliable place to surface the fetched children —
  // for display (the wired ref's existing children) and for apply (a wired-ref child's rid lookup).
  if (bp.flowRefChildren.size) m.flowRefChildren = Object.fromEntries(bp.flowRefChildren);
  return m;
};

/** Curated add palette — the common, verified-addable widget types grouped for the picker. Display
 *  names are friendly; the key is the BMP className. (A full per-host live-derived palette is a
 *  later refinement — these all add cleanly to a Scorecard/template container.) */
/** Quick-access widgets shown in a "Most used" section at the top of the add picker. A fixed shortlist
 *  (not customizable) — the full PALETTE below still lists every type, so this is a convenience, not the
 *  only path. All verified addable via a bare `_sc.add(<className>)` (incl. CreateObjectView). */
export const MOST_USED: { key: string; name: string }[] = [
  { key: 'InputView', name: 'Input View' },
  { key: 'ExtendedTable', name: 'Extended Table' },
  { key: 'DescriptionView', name: 'Description View' },
  { key: 'TextElement', name: 'Text Element' },
  { key: 'ActionButton', name: 'Action Button' },
  { key: 'CreateObjectView', name: 'Create Object View' },
];

export const PALETTE: { group: string; items: { key: string; name: string }[] }[] = [
  { group: 'Status', items: [
    { key: 'SimpleStatus', name: 'Simple Status' }, { key: 'Status', name: 'Status' },
    { key: 'FunctionStatus', name: 'Function Status' }, { key: 'Trend', name: 'Trend' } ] },
  { group: 'Charts', items: [
    { key: 'BarChart', name: 'Bar Chart' }, { key: 'LineChart', name: 'Line Chart' },
    { key: 'BarLineChart', name: 'Bar & Line' }, { key: 'PieChart', name: 'Pie Chart' },
    { key: 'AreaChart', name: 'Area Chart' }, { key: 'RadarChart', name: 'Radar Chart' } ] },
  { group: 'Tables & Lists', items: [
    { key: 'ExtendedTable', name: 'Extended Table' }, { key: 'RiskList', name: 'Risk List' },
    { key: 'CheckList', name: 'Check List' }, { key: 'IssueList', name: 'Issue List' } ] },
  { group: 'Text & Media', items: [
    { key: 'TextElement', name: 'Text' }, { key: 'DescriptionView', name: 'Description' },
    { key: 'ImageView', name: 'Image' }, { key: 'Spacer', name: 'Spacer' } ] },
  { group: 'Input & Action', items: [
    { key: 'InputView', name: 'Input View' }, { key: 'ActionButton', name: 'Action Button' },
    { key: 'CustomVisualization', name: 'Custom (CVO)' }, { key: 'URLView', name: 'URL / Embed' } ] },
];
