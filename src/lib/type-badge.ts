/**
 * Type badge — the signature "full-bleed stub": a domain-coloured tile (icon,
 * white) welded to a neutral code chip (the 3-letter abbreviation). The icon
 * carries the object's role; the tile colour carries its domain band. Colour
 * lives on the tile ONLY, so a wall of badges reads as a colour-keyed column
 * without shouting.
 *
 * Shared across Browse rows, the object tree, the object header, the inspect
 * overlay, and the EC window so every surface labels a type identically.
 *
 * Sub-badges (opts.sub) stack UNDERNEATH the stub — a violet `</>` when the
 * object carries Extended Code, a teal link when it references other objects
 * (its jump target). Used on the inspect corner label + detail header.
 */
import { h, svg } from './dom';
import {
  ICON_BUILDINGS, ICON_BROWSER, ICON_COMPASS, ICON_EYE_OPEN, ICON_STACK,
  ICON_CROSSHAIR, ICON_GAUGE, ICON_LIGHTNING, ICON_WARNING, ICON_SHIELD,
  ICON_WARNING_CIRCLE, ICON_CHART_LINE_UP, ICON_TRAY, ICON_CARDHOLDER,
  ICON_TRAY_ARROW_DOWN, ICON_CARDS_THREE, ICON_PENCIL, ICON_VARIABLE,
  ICON_CLOCK, ICON_LIST, ICON_CHECK, ICON_PLAY, ICON_BOOK, ICON_CONTAINER,
  ICON_TABS, ICON_FOLDER, ICON_TABLE, ICON_FILE_JS, ICON_FILE_HTML,
  ICON_CHART, ICON_CODE, ICON_SWAP, ICON_CUBE, ICON_LINK,
} from './icons';
import { getTypeAbbr, getTypeColor, CHART_TYPES } from './types';

/** BMP type → its role glyph. Colour comes from getTypeColor (the domain band);
 *  this map is only the icon. Anything absent falls back to the cube. */
const TYPE_ICON: Record<string, string> = {
  // Organisation + pages
  Organisation: ICON_BUILDINGS,
  Scorecard: ICON_BROWSER,
  ModelPage: ICON_BROWSER,
  // GRC / scorecard-tree objects
  Strategy: ICON_COMPASS,
  Perspective: ICON_EYE_OPEN,
  Theme: ICON_STACK,
  Objective: ICON_CROSSHAIR,
  Measure: ICON_GAUGE,
  Action: ICON_LIGHTNING,
  Risk: ICON_WARNING,
  Control: ICON_SHIELD,
  Issue: ICON_WARNING_CIRCLE,
  Indicator: ICON_CHART_LINE_UP,
  // Input surfaces — the tray/card pairs
  InputView: ICON_TRAY,
  CreateObjectView: ICON_CARDHOLDER,
  InputSet: ICON_TRAY_ARROW_DOWN,
  EditPage: ICON_CARDS_THREE,
  // Input fields
  TextInput: ICON_PENCIL,
  NumberInput: ICON_VARIABLE,
  DateInput: ICON_CLOCK,
  ChoiceInput: ICON_LIST,
  BooleanInput: ICON_CHECK,
  ReferenceInput: ICON_LIST,
  ButtonInput: ICON_PLAY,
  Label: ICON_BOOK,
  ActionButton: ICON_LIGHTNING,
  // Layout structure
  Container: ICON_CONTAINER,
  TabSet: ICON_TABS,
  Tab: ICON_TABS,
  DashboardFolder: ICON_FOLDER,
  // Tables
  ExtendedTable: ICON_TABLE,
  FilterTable: ICON_TABLE,
  ReportTable: ICON_TABLE,
  FilteredComments: ICON_TABLE,
  // Visualization
  CustomVisualization: ICON_FILE_JS,
  DashboardHTML: ICON_FILE_HTML,
  RiskChart: ICON_CHART,
  RiskRadarChart: ICON_CHART,
  // Logic / code
  ExtendedCode: ICON_CODE,
  ExtendedExpression: ICON_VARIABLE,
  ExtendedTransport: ICON_SWAP,
  Workflow: ICON_SWAP,
  // Content + status
  TextElement: ICON_BOOK,
  StatusType: ICON_CHECK,
};

const CHART_SET = new Set<string>(CHART_TYPES);

/** Resolve a type to its badge glyph. Charts (Bar/Pie/…) → the bar-chart icon;
 *  everything unmapped → the generic cube. */
export function typeIcon(type?: string): string {
  if (!type) return ICON_CUBE;
  return TYPE_ICON[type] ?? (CHART_SET.has(type) ? ICON_CHART : ICON_CUBE);
}

/** True when we have a real mapping for this type (icon or chart). Unmapped
 *  types render the grey cube + 'OBJ' fallback. */
function isMapped(type?: string): boolean {
  return !!type && (TYPE_ICON[type] !== undefined || CHART_SET.has(type));
}

export interface BadgeOpts {
  /** Compact 18px variant for dense rows (tree, Browse results, references). */
  size?: 'xs';
  /** Sub-badges stacked under the stub (inspect corner label / detail header). */
  sub?: { code?: boolean; ref?: boolean };
}

/**
 * Build a type badge element. Default is the 20px stub; `size: 'xs'` is the
 * compact row variant. Pass `sub` to weld code / reference indicator squares
 * underneath (the inspect-overlay corner label).
 */
/**
 * Wire the panel-wide badge gesture onto a stub badge: click copies `id`
 * (business id by convention) with a green \u2713 flash. Host CSS needs the
 * shared `.bdg-copied` rules (sidepanel.css and the window CSS copies).
 */
export function wireBadgeCopy(badge: HTMLElement, id: () => string): HTMLElement {
  badge.classList.add('bdg-copy');
  const current = () => id();
  badge.title = `${badge.title} \u00b7 click to copy ${current()}`;
  badge.addEventListener('click', (e) => {
    e.stopPropagation();
    const val = current();
    if (!val) return;
    navigator.clipboard?.writeText(val).catch(() => { /* clipboard blocked */ });
    const lbl = badge.querySelector<HTMLElement>('.lbl');
    const orig = lbl?.textContent ?? '';
    if (lbl) lbl.textContent = '\u2713';
    badge.classList.add('bdg-copied');
    setTimeout(() => {
      if (lbl) lbl.textContent = orig;
      badge.classList.remove('bdg-copied');
    }, 700);
  });
  return badge;
}

export function typeBadge(type?: string, opts: BadgeOpts = {}): HTMLElement {
  const mapped = isMapped(type);
  const badge = h('span', {
    class: `bdg${opts.size === 'xs' ? ' xs' : ''}`,
    style: `--c:${getTypeColor(type)}`,
    title: type ?? '',
  },
    h('span', { class: 'tile' }, svg(typeIcon(type))),
    h('span', { class: 'lbl' }, mapped ? getTypeAbbr(type) : 'OBJ'),
  );

  const hasSub = opts.sub && (opts.sub.code || opts.sub.ref);
  if (!hasSub) return badge;

  const row = h('span', { class: 'sbrow' });
  if (opts.sub!.code) {
    row.appendChild(h('span', { class: 'sq code', title: 'Carries Extended Code' }, svg(ICON_CODE)));
  }
  if (opts.sub!.ref) {
    row.appendChild(h('span', { class: 'sq ref', title: 'References other objects' }, svg(ICON_LINK)));
  }
  return h('span', { class: `bdg-stack${opts.size === 'xs' ? ' xs' : ''}` }, badge, row);
}
