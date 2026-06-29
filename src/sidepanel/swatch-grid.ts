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
import { h } from '../lib/dom';
import type { ColorSetData } from '../lib/types';

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

/** Normalise an RGB string to "r,g,b" so "rgb(255, 0,0)" and "rgb(255,0,0)"
 *  compare equal. Returns '' when no numbers are found. */
function rgbKey(rgb: string): string {
  const m = rgb.match(/\d+/g);
  return m && m.length >= 3 ? `${m[0]},${m[1]},${m[2]}` : '';
}

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
  onPick: (bidName: string) => void;  // receives "<bid> <name>"
}

/** Dense, Photoshop-style square swatch grid for the Style tab. */
export function renderSwatchGrid(opts: SwatchGridOpts): HTMLElement {
  const wrap = h('div', { class: 'sw-grid-wrap' });
  if (opts.sets === null) {
    wrap.appendChild(h('div', { class: 'sw-loading' }, 'Loading colours…'));
    return wrap;
  }
  const groups = resolveSwatchGroups(opts.sets, { q: opts.q, includeBasics: opts.includeBasics });
  if (groups.length === 0) {
    const q = (opts.q ?? '').trim();
    wrap.appendChild(h('div', { class: 'sw-empty' }, q ? `No colours match “${q}”.` : 'No colours found.'));
    return wrap;
  }
  for (const g of groups) {
    wrap.appendChild(h('div', { class: 'sw-group-label' }, g.label));
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
    wrap.appendChild(grid);
  }
  return wrap;
}
