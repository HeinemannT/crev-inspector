/**
 * G3 — colour data for the blueprint overlay. Style mode needs to turn a widget's CorpoColor LINK
 * (a businessId) into an rgb to tint the cell, and (Stage B) to power the swatch popup. Both come from
 * the same per-profile colour-set list the side panel uses; the overlay pulls it over the one-shot
 * channel (the SW's FETCH_COLOR_SETS handler responds to the sender as well as broadcasting to the panel)
 * and keeps a bid→rgb index. Lazy: fetched the first time style mode opens, cached for the session.
 */
import { sendRequest } from '../lib/messaging';
import { ColorSetIndex } from '../lib/color-index';
import type { ColorSetData, InspectorMessage } from '../lib/types';
import { bp } from './state';
import { render } from './view';

type ColorSetsResult = Extract<InspectorMessage, { type: 'COLOR_SETS_DATA' }>;

let sets: ColorSetData[] | null = null;
let loading = false;
const index = new ColorSetIndex();

/** Resolve a CorpoColor businessId → its rgb (e.g. "rgb(255,0,0)"), or null if unknown/unloaded. */
export function colorRgb(bid: string | undefined | null): string | null {
  return index.rgb(bid);
}

/** Resolve a CorpoColor businessId → {name, rgb}, or null — for the style toolbar's colour-slot label. */
export function colorInfo(bid: string | undefined | null): { name: string; rgb: string } | null {
  return index.lookup(bid);
}

/** The loaded colour sets (folders of swatches) — null until first fetched. For the Stage B popup. */
export function colorSets(): ColorSetData[] | null { return sets; }

/** Drop the overlay's cached colours — call on a profile switch / teardown so the next session can't
 *  tint with the previous workspace's bid→rgb map. */
export function resetColorSets(): void {
  sets = null;
  index.clear();
}

/** Fetch the colour sets once (no-op if already loaded or in flight). Re-renders when they land so
 *  style-mode cells pick up their tint. `force` busts the cache (a manual refresh). */
export async function ensureColorSets(force = false): Promise<void> {
  if ((sets !== null && !force) || loading) return;
  const g = bp.gen;
  loading = true;
  try {
    const res = await sendRequest<ColorSetsResult>({ type: 'FETCH_COLOR_SETS', force });
    sets = res?.sets ?? [];
    index.load(sets);
    if (bp.active && bp.gen === g) render(); // session guard — don't render into a torn-down/newer session
  } catch {
    sets = sets ?? [];
  } finally {
    loading = false;
  }
}
