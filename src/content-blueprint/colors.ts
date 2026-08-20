/**
 * G3 — colour data for the blueprint overlay. Style mode needs to turn a widget's CorpoColor LINK
 * (a businessId) into an rgb to tint the cell, and (Stage B) to power the swatch popup. Both come from
 * the same per-profile colour-set list the side panel uses; the overlay pulls it over the one-shot
 * channel (the SW's FETCH_COLOR_SETS handler responds to the sender as well as broadcasting to the panel)
 * and keeps a bid→rgb index. Lazy: fetched the first time style mode opens, cached for the session.
 */
import { sendRequest } from '../lib/messaging';
import type { ColorSetData, InspectorMessage } from '../lib/types';
import { WorkspaceColorCatalogue, type ColorCatalogueStatus } from '../lib/workspace-color-catalogue';
import { bp } from './state';
import { render } from './view';

type ColorSetsResult = Extract<InspectorMessage, { type: 'COLOR_SETS_DATA' }>;

const catalogue = new WorkspaceColorCatalogue();

/** Resolve a CorpoColor businessId → its rgb (e.g. "rgb(255,0,0)"), or null if unknown/unloaded. */
export function colorRgb(bid: string | undefined | null): string | null {
  return catalogue.rgb(bid);
}

/** Resolve a CorpoColor businessId → {name, rgb}, or null — for the style toolbar's colour-slot label. */
export function colorInfo(bid: string | undefined | null): { name: string; rgb: string } | null {
  return catalogue.lookup(bid);
}

/** The loaded colour sets (folders of swatches) — null until first fetched. For the Stage B popup. */
export function colorSets(): ColorSetData[] | null { return catalogue.snapshot().sets; }
export function colorSetsStatus(): ColorCatalogueStatus { return catalogue.snapshot().status; }

/** Drop the overlay's cached colours — call on a profile switch / teardown so the next session can't
 *  tint with the previous workspace's bid→rgb map. */
export function resetColorSets(): void {
  catalogue.reset();
}

/** Fetch the colour sets once (no-op if already loaded or in flight). Re-renders when they land so
 *  style-mode cells pick up their tint. `force` busts the cache (a manual refresh). */
export async function ensureColorSets(force = false): Promise<void> {
  const g = bp.gen;
  const changed = await catalogue.load(
    reload => sendRequest<ColorSetsResult>({
      type: 'FETCH_COLOR_SETS',
      ...(reload ? { force: true } : {}),
    }),
    force,
  );
  if (changed && bp.active && bp.gen === g) render();
}
