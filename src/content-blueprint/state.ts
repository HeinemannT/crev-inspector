/**
 * Blueprint editor state — the single `bp` singleton + the constants, with no rendering logic.
 * Actions mutate `bp` and call view.render(); view reads `bp`. Keeping the state here (data only)
 * means neither the view nor the controller owns it, and there's no import cycle through it.
 */
import type { LModel, PlanNote, NodeStyle } from '../lib/layout/types';
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
  picker: string | null;        // containerId/compositeId/tabId the add picker is open for
  pickerOpts: { afterId?: string; cols?: number; at?: { x: number; y: number } } | null; // positional insert (after a sibling, sized to a gap) + the click point to anchor the picker popup at
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
    layer: null, selectedId: null, applying: false, preview: null, previewScript: '', blast: null, blastSeq: 0, picker: null, pickerOpts: null, movePicker: null, tabMenu: null, swatch: null, swatchExpanded: new Set(['Basics']),
    brush: { mode: 'off', held: null }, brushMask: new Set(PAINT_STYLE_PROPS), paintPanel: null, presets: [], renameId: null,
    onResize: null, onKey: null, onPop: null, loadedRid: '', editingTemplate: false, mode: 'layout', raf: 0, resultMode: false, hint: null, trayOpen: false, dragging: false, renaming: false,
    observer: null, resizeObs: null, ridSig: '', mutRaf: 0, flipNext: false, viewTabId: null, unusedTabsOpen: false,
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
  bp.resultAnchor = null;
}

export function isBlueprintActive(): boolean { return bp.active; }

/** The edited model = history present (baseline + staged edits). Null until a page is loaded. */
export const model = (): LModel | null => bp.history?.present() ?? null;

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
