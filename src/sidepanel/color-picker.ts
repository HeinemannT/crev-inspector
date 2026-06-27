/**
 * Linked-colour picker popover. BMP widget colours (headerColor / fontColor)
 * are LINKS to CorpoColor objects, not hex — so they're picked from
 * the workspace's colourset list, never typed. The set list is fetched via
 * FETCH_COLOR_SETS and served from a persistent per-profile cache
 * (color-set-cache.ts) — only the first open in a browser session pays the
 * BMP round-trip; the ↻ button forces a reload when colours changed.
 */
import { h, render, svg } from '../lib/dom';
import { ICON_REFRESH } from '../lib/icons';
import type { ColorSetData, InspectorMessage } from '../lib/types';

let cache: ColorSetData[] | null = null;
let onData: (() => void) | null = null;

/** Receive the fetched colour sets (routed from the SW by sidepanel.ts). */
export function onColorSetsData(sets: ColorSetData[]): void {
  cache = sets;
  onData?.();
}

/** Resolve a colour bid → {name, rgb} from the cache (for the current swatch). */
export function lookupColor(bid: string): { name: string; rgb: string } | null {
  if (!cache || !bid) return null;
  for (const s of cache) for (const c of s.colors) if (c.bid === bid) return { name: c.name, rgb: c.rgb };
  return null;
}

interface PickerOpts {
  anchor: HTMLElement;
  /** The currently-linked colour bid (highlights it), or null. */
  currentBid: string | null;
  sendMessage: (m: InspectorMessage) => void;
  /** Receives "<bid> <name>" on pick, or "" when cleared. */
  onPick: (value: string) => void;
}

let closeCurrent: (() => void) | null = null;

export function openColorPicker(opts: PickerOpts): void {
  closeCurrent?.(); // one picker at a time
  let filter = '';

  const root = h('div', { class: 'cp-popover', role: 'dialog', 'aria-label': 'Pick a colour' });
  const backdrop = h('div', { class: 'cp-backdrop' });
  const bodyEl = h('div', { class: 'cp-body' });
  const filterInput = h('input', {
    class: 'cp-filter', type: 'text', placeholder: 'Filter colours…',
    autocomplete: 'off', spellcheck: 'false',
    onInput: (e: Event) => { filter = (e.currentTarget as HTMLInputElement).value; drawBody(); },
  }) as HTMLInputElement;
  // Manual refresh — busts the persistent cache when a colour changed in BMP.
  const refreshBtn = h('button', {
    class: 'cp-refresh', type: 'button', title: 'Reload colours from BMP',
    onClick: () => {
      cache = null;
      drawBody();
      opts.sendMessage({ type: 'FETCH_COLOR_SETS', force: true });
    },
  }, svg(ICON_REFRESH));

  const close = () => {
    document.removeEventListener('keydown', onKey, true);
    backdrop.remove(); root.remove();
    if (onData === drawBody) onData = null;
    if (closeCurrent === close) closeCurrent = null;
  };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };

  function drawBody(): void {
    const q = filter.trim().toLowerCase();
    const items: HTMLElement[] = [];
    if (cache === null) {
      items.push(h('div', { class: 'cp-loading' }, 'Loading colours…'));
    } else {
      let shown = 0;
      for (const set of cache) {
        const cols = set.colors.filter(c => !q || c.name.toLowerCase().includes(q) || c.bid.toLowerCase().includes(q));
        if (cols.length === 0) continue;
        shown += cols.length;
        items.push(h('div', { class: 'cp-set' }, set.name || set.id));
        const grid = h('div', { class: 'cp-grid' });
        for (const c of cols) {
          grid.appendChild(h('button', {
            class: `cp-swatch${c.bid === opts.currentBid ? ' cp-swatch--sel' : ''}`,
            title: `${c.name} · ${c.bid}`,
            onClick: () => { opts.onPick(`${c.bid} ${c.name}`.trim()); close(); },
          },
            h('span', { class: 'cp-swatch-dot', style: `background:${c.rgb}` }),
            h('span', { class: 'cp-swatch-name' }, c.name || c.bid),
          ));
        }
        items.push(grid);
      }
      if (shown === 0) items.push(h('div', { class: 'cp-empty' }, q ? `No colours match “${filter}”.` : 'No colours found.'));
    }
    render(bodyEl, ...items);
    position();
  }

  function position(): void {
    const r = opts.anchor.getBoundingClientRect();
    const w = 260;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
    root.style.width = `${w}px`;
    root.style.left = `${left}px`;
    const hgt = root.offsetHeight || 300;
    root.style.top = `${(r.bottom + 4 + hgt > window.innerHeight - 8) ? Math.max(8, r.top - hgt - 4) : r.bottom + 4}px`;
  }

  // No "clear" action: BMP doesn't unset a colour link via `:= MISSING`
  // (verified — it's a no-op), so we only offer picking a colour to link.
  render(root, h('div', { class: 'cp-head' }, filterInput, refreshBtn), bodyEl);
  document.body.appendChild(backdrop);
  document.body.appendChild(root);
  document.addEventListener('keydown', onKey, true);
  backdrop.addEventListener('click', close);
  closeCurrent = close;
  onData = drawBody;

  drawBody();
  filterInput.focus();
  if (cache === null) opts.sendMessage({ type: 'FETCH_COLOR_SETS' });
}
