/**
 * G3 — colour data for the blueprint overlay. Style mode needs to turn a widget's CorpoColor LINK
 * (a businessId) into an rgb to tint the cell, and (Stage B) to power the swatch popup. Both come from
 * the same per-profile colour-set list the side panel uses; the overlay pulls it over the one-shot
 * channel (the SW's FETCH_COLOR_SETS handler responds to the sender as well as broadcasting to the panel)
 * and keeps a bid→rgb index. Lazy: fetched the first time style mode opens, cached for the session.
 */
import { sendRequest } from '../lib/messaging';
import type { ColorSetData, InspectorMessage } from '../lib/types';
import { render } from './view';

type ColorSetsResult = Extract<InspectorMessage, { type: 'COLOR_SETS_DATA' }>;

let sets: ColorSetData[] | null = null;
let loading = false;
const rgbByBid = new Map<string, string>();

/** Resolve a CorpoColor businessId → its rgb (e.g. "rgb(255,0,0)"), or null if unknown/unloaded. */
export function colorRgb(bid: string | undefined | null): string | null {
  return bid ? (rgbByBid.get(bid) ?? null) : null;
}

/** The loaded colour sets (folders of swatches) — null until first fetched. For the Stage B popup. */
export function colorSets(): ColorSetData[] | null { return sets; }

/** Fetch the colour sets once (no-op if already loaded or in flight). Re-renders when they land so
 *  style-mode cells pick up their tint. `force` busts the cache (a manual refresh). */
export async function ensureColorSets(force = false): Promise<void> {
  if ((sets !== null && !force) || loading) return;
  loading = true;
  try {
    const res = await sendRequest<ColorSetsResult>({ type: 'FETCH_COLOR_SETS', force });
    sets = res?.sets ?? [];
    rgbByBid.clear();
    for (const s of sets) for (const c of s.colors) rgbByBid.set(c.bid, c.rgb);
    render();
  } catch {
    sets = sets ?? [];
  } finally {
    loading = false;
  }
}
