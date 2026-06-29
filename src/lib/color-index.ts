/**
 * O(1) businessId → {name, rgb} lookup over a colour-set list. One implementation for every realm:
 * the side-panel picker and the blueprint overlay each hold their OWN instance (separate JS contexts,
 * can't share memory — that part is correct), but they no longer each hand-roll the lookup (the picker
 * used an O(n) linear scan; the overlay a bespoke Map). `clear()` gives each a clean reset point for
 * profile switches.
 */
import type { ColorSetData } from './types';

export interface ColorRef { name: string; rgb: string }

export class ColorSetIndex {
  private byBid = new Map<string, ColorRef>();

  constructor(sets?: ColorSetData[] | null) {
    if (sets) this.load(sets);
  }

  /** Rebuild the index from a fresh colour-set list (replaces any prior contents). */
  load(sets: ColorSetData[]): void {
    this.byBid.clear();
    for (const set of sets) for (const c of set.colors) this.byBid.set(c.bid, { name: c.name, rgb: c.rgb });
  }

  clear(): void { this.byBid.clear(); }

  lookup(bid: string | null | undefined): ColorRef | null {
    return bid ? (this.byBid.get(bid) ?? null) : null;
  }

  rgb(bid: string | null | undefined): string | null {
    return this.lookup(bid)?.rgb ?? null;
  }
}
