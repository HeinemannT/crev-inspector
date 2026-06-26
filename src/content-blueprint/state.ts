/**
 * Blueprint editor state — the single `bp` singleton + the constants, with no rendering logic.
 * Actions mutate `bp` and call view.render(); view reads `bp`. Keeping the state here (data only)
 * means neither the view nor the controller owns it, and there's no import cycle through it.
 */
import type { LModel, PlanNote } from '../lib/layout/types';
import type { BlueprintCtx } from '../lib/layout/sync';
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
  picker: string | null;        // containerId/compositeId the add picker is open for
  movePicker: string | null;    // widgetId the move-destination menu is open for
  onScroll: (() => void) | null;
  onKey: ((e: KeyboardEvent) => void) | null;
  raf: number;                  // requestAnimationFrame id coalescing scroll re-renders (0 = none)
}

export const bp: BpState = {
  active: false, baseline: null, ctx: null, env: null, history: null,
  layer: null, selectedId: null, applying: false, preview: null, picker: null, movePicker: null,
  onScroll: null, onKey: null, raf: 0,
};

export function isBlueprintActive(): boolean { return bp.active; }

/** The edited model = history present (baseline + staged edits). Null until a page is loaded. */
export const model = (): LModel | null => bp.history?.present() ?? null;

/** Curated add palette — the common, verified-addable widget types grouped for the picker. Display
 *  names are friendly; the key is the BMP className. (A full per-host live-derived palette is a
 *  later refinement — these all add cleanly to a Scorecard/template container.) */
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
