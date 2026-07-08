/**
 * Swatch grid — the colour-palette model shared by the linked-colour picker
 * popover and the Style tab's inline Colours section.
 *
 * BMP widget colours are LINKS to CorpoColor objects (never hex), and the
 * workspace groups them into CorpoColorSets. So the natural shape is folders
 * (sets) of swatches (colours): {@link resolveSwatchGroups} turns the fetched
 * {@link ColorSetData}[] into that shape, applies a name/bid filter, and — when
 * asked — prepends an always-present "Basics" group (white / black / greys).
 *
 * A Basics swatch is only *applyable* if the workspace actually owns a CorpoColor
 * with that RGB (you can't link to a colour object that doesn't exist), so each
 * Basics entry resolves to a real bid by RGB match — or is marked display-only.
 *
 * Rendering is split per surface (the popover shows name rows; the Style tab
 * shows a dense Photoshop-style square grid) — only the data model is shared, so
 * neither surface constrains the other's layout.
 */
import { h, svg } from './dom';
import { ICON_CHEVRON } from './icons';
import { rgbKey } from './color-util';
import type { ColorSetData } from './types';

export interface Swatch {
  bid: string;       // CorpoColor business id ('' when display-only)
  name: string;
  rgb: string;       // CSS colour, e.g. "rgb(255,0,0)"
  applyable: boolean; // false → shown but can't be linked (no matching CorpoColor)
}

export interface SwatchGroup {
  label: string;
  swatches: Swatch[];
}

/** Universal defaults surfaced regardless of what coloursets the workspace
 *  defines. RGB is the match key against real CorpoColor objects. */
export const BASIC_COLORS: ReadonlyArray<{ name: string; rgb: string }> = [
  { name: 'White',      rgb: 'rgb(255,255,255)' },
  { name: 'Light grey', rgb: 'rgb(204,204,204)' },
  { name: 'Grey',       rgb: 'rgb(128,128,128)' },
  { name: 'Dark grey',  rgb: 'rgb(64,64,64)' },
  { name: 'Black',      rgb: 'rgb(0,0,0)' },
];

function matches(q: string, name: string, bid: string): boolean {
  if (!q) return true;
  return name.toLowerCase().includes(q) || bid.toLowerCase().includes(q);
}

/** Build the folder→swatch model from the fetched colour sets. */
export function resolveSwatchGroups(
  sets: ColorSetData[],
  opts: { q?: string; includeBasics?: boolean } = {},
): SwatchGroup[] {
  const q = (opts.q ?? '').trim().toLowerCase();
  const groups: SwatchGroup[] = [];

  if (opts.includeBasics) {
    // Resolve each basic to a real CorpoColor (by RGB) so it can be linked;
    // unmatched basics stay visible but display-only.
    const byRgb = new Map<string, { bid: string; name: string }>();
    for (const set of sets) for (const c of set.colors) {
      const k = rgbKey(c.rgb);
      if (k && !byRgb.has(k)) byRgb.set(k, { bid: c.bid, name: c.name });
    }
    const basics: Swatch[] = [];
    for (const b of BASIC_COLORS) {
      const hit = byRgb.get(rgbKey(b.rgb));
      if (!matches(q, b.name, hit?.bid ?? '')) continue;
      basics.push({
        bid: hit?.bid ?? '',
        name: b.name,
        rgb: b.rgb,
        applyable: !!hit,
      });
    }
    if (basics.length) groups.push({ label: 'Basics', swatches: basics });
  }

  for (const set of sets) {
    const swatches = set.colors
      .filter(c => matches(q, c.name, c.bid))
      .map(c => ({ bid: c.bid, name: c.name, rgb: c.rgb, applyable: true }));
    if (swatches.length) groups.push({ label: set.name || set.id, swatches });
  }
  return groups;
}

export interface SwatchGridOpts {
  sets: ColorSetData[] | null;        // null → still loading
  q?: string;
  currentBid: string | null;          // highlight the linked colour
  includeBasics?: boolean;
  expanded: ReadonlySet<string>;      // labels of the open folders (ignored while searching)
  onToggle: (label: string) => void;  // folder header clicked
  onPick: (bidName: string) => void;  // receives "<bid> <name>"
  onClear?: () => void;               // when set, a "None" cell clears the link (verified: `:= ""` unsets)
}

/** Collapsible, searchable swatch folders (one per colour set) for the Style
 *  tab. Workspaces carry hundreds of colours, so folders are collapsed by
 *  default — each header previews a few of its colours so it's identifiable
 *  while closed. A live filter narrows swatches and force-opens every folder
 *  that still has a match (so search results are always visible). */
export function renderSwatchGrid(opts: SwatchGridOpts): HTMLElement {
  const wrap = h('div', { class: 'sw-grid-wrap' });
  if (opts.sets === null) {
    wrap.appendChild(h('div', { class: 'sw-loading' }, 'Loading colours…'));
    return wrap;
  }
  const q = (opts.q ?? '').trim();
  const groups = resolveSwatchGroups(opts.sets, { q, includeBasics: opts.includeBasics });
  if (groups.length === 0) {
    wrap.appendChild(h('div', { class: 'sw-empty' }, q ? `No colours match “${q}”.` : 'No colours found.'));
    return wrap;
  }
  // A "None" cell clears the colour link (only when searching isn't filtering it out). BMP unsets a
  // colour with `:= ""` (verified live) — so this is a real clear, not a no-op.
  if (opts.onClear && !q) {
    wrap.appendChild(h('button', {
      class: `sw-clear${!opts.currentBid ? ' sw-clear--sel' : ''}`,
      type: 'button', title: 'No color: clear the link', 'aria-label': 'No colour',
      onClick: opts.onClear,
    }, h('span', { class: 'sw-clear-chip' }), h('span', null, 'None')));
  }
  const searching = q !== '';
  for (const g of groups) {
    const open = searching || opts.expanded.has(g.label);
    wrap.appendChild(folder(g, open, searching, opts));
  }
  return wrap;
}

function folder(g: SwatchGroup, open: boolean, searching: boolean, opts: SwatchGridOpts): HTMLElement {
  // A few preview dots so a collapsed folder is still identifiable by colour.
  const preview = h('span', { class: 'sw-folder-preview', 'aria-hidden': 'true' },
    ...g.swatches.slice(0, 6).map(s => h('span', { class: 'sw-folder-dot', style: `background:${s.rgb}` })));
  const header = h('button', {
    class: `sw-folder-head${open ? ' open' : ''}`,
    type: 'button',
    'aria-expanded': open ? 'true' : 'false',
    // While searching the folders are forced open, so the toggle is inert.
    onClick: searching ? undefined : () => opts.onToggle(g.label),
  },
    h('span', { class: 'sw-folder-chevron' }, svg(ICON_CHEVRON)),
    h('span', { class: 'sw-folder-name' }, g.label),
    open ? null : preview,
    h('span', { class: 'sw-folder-count' }, String(g.swatches.length)),
  );
  const body = open ? swatchCells(g, opts) : null;
  return h('div', { class: 'sw-folder' }, header, body);
}

function swatchCells(g: SwatchGroup, opts: SwatchGridOpts): HTMLElement {
  const grid = h('div', { class: 'sw-cells' });
  for (const s of g.swatches) {
    const selected = s.applyable && s.bid === opts.currentBid;
    const title = s.applyable
      ? `${s.name} · ${s.bid}`
      : `${s.name} — no matching workspace colour to link`;
    grid.appendChild(h('button', {
      class: `sw-cell${selected ? ' sw-cell--sel' : ''}${s.applyable ? '' : ' sw-cell--disabled'}`,
      type: 'button',
      title,
      'aria-label': s.name,
      disabled: s.applyable ? undefined : 'true',
      style: `--sw: ${s.rgb}`,
      onClick: s.applyable ? () => opts.onPick(`${s.bid} ${s.name}`.trim()) : undefined,
    }));
  }
  return grid;
}
