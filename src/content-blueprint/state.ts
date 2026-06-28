/**
 * Blueprint editor state — the single `bp` singleton + the constants, with no rendering logic.
 * Actions mutate `bp` and call view.render(); view reads `bp`. Keeping the state here (data only)
 * means neither the view nor the controller owns it, and there's no import cycle through it.
 */
import type { LModel, PlanNote } from '../lib/layout/types';
import type { BlueprintCtx, NeedsTabset } from '../lib/layout/sync';
import type { InstanceFanout, ContainerBlast } from '../lib/layout/blast-radius';
import { History } from '../lib/layout/history';

export const LAYER_ID = 'crev-blueprint-layer';
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
  blast: { fanout: InstanceFanout | null; blast: ContainerBlast | null } | null; // preview blast radius (async, best-effort)
  blastSeq: number;             // bumped per openApplyPreview; a late blast reply for an older seq is dropped
  picker: string | null;        // containerId/compositeId/tabId the add picker is open for
  pickerOpts: { afterId?: string; cols?: number } | null; // positional insert: place after a sibling, sized to a gap
  movePicker: string | null;    // widgetId the move-destination menu is open for
  onScroll: (() => void) | null;
  onKey: ((e: KeyboardEvent) => void) | null;
  raf: number;                  // requestAnimationFrame id coalescing scroll re-renders (0 = none)
  gen: number;                  // session generation, bumped on each enable; in-flight I/O captures it
                                //   and bails if it changed (toggle-off-then-on starts a new session)
  hint: string | null;          // transient contextual hint shown in the bottom bar (gesture coaching)
  trayOpen: boolean;            // pending-changes tray docked open
  dragging: boolean;            // a pointer drag is in flight — suppresses scroll re-renders mid-gesture
  renaming: boolean;            // an inline-rename field is open — suppresses re-renders (they'd destroy it)
  observer: MutationObserver | null; // watches BMP content for tab switches (visible rid set changes)
  ridSig: string;               // signature of the visible rids at last render — re-render when it changes
  mutRaf: number;               // rAF id coalescing mutation-driven re-renders (0 = none)
  needsTabset: NeedsTabset | null; // page has RESULT widgets but no tabset → show the create-tabset prompt
  creatingTabset: boolean;      // create-tabset request in flight (disables the prompt's Create button)
  flipNext: boolean;            // animate result cells from old→new position on the next render (set by an edit)
  viewTabId: string | null;     // tab shown in the canvas (header tab bar switches it); null → follow BMP's live tab
}

export const bp: BpState = {
  active: false, baseline: null, ctx: null, env: null, history: null,
  layer: null, selectedId: null, applying: false, preview: null, blast: null, blastSeq: 0, picker: null, pickerOpts: null, movePicker: null,
  onScroll: null, onKey: null, raf: 0, gen: 0, hint: null, trayOpen: false, dragging: false, renaming: false,
  observer: null, ridSig: '', mutRaf: 0, needsTabset: null, creatingTabset: false, flipNext: false, viewTabId: null,
};

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
