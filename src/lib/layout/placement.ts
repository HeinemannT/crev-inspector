/**
 * Slot placement — turns "put this node into that row gap" intents into band-legal insertions.
 *
 * BMP renders a parent's children as ONE ordered sequence — containers first, then tab-bound
 * widgets — flowing continuously through the 12-track grid (live-verified 2026-07-02: a widget
 * joins the last container row when it fits). A visual slot is therefore reachable only for a
 * node whose band allows it to render there. This module is the single place that decides:
 * the drag layer uses `resolveGapPlacement` (strict — an unreachable slot refuses the drop,
 * with the reason), the add-picker flows use `bandInsertIndex` (best-effort — an illegal slot
 * remaps to the nearest legal position, flagged so the caller can explain).
 */
import type { LNode, NodeKind } from './types';

const isContainerKind = (k: NodeKind): boolean => k === 'container';

export type GapPlacement =
  | { ok: true; mode: 'after'; targetId: string }
  | { ok: true; mode: 'into' }
  | { ok: false; reason: string };

/** Resolve a DROP into a row gap anchored after `anchorId` (undefined = an unanchored gap/add
 *  zone → append). `children` is the gap's parent's children (canonical or raw — only kinds and
 *  the last-container position matter). */
export function resolveGapPlacement(children: LNode[], anchorId: string | undefined, kind: NodeKind): GapPlacement {
  if (!anchorId) return { ok: true, mode: 'into' };
  const anchor = children.find(c => c.id === anchorId);
  if (!anchor) return { ok: true, mode: 'into' };
  if (isContainerKind(anchor.kind) === isContainerKind(kind)) return { ok: true, mode: 'after', targetId: anchorId };
  if (!isContainerKind(kind)) {
    // Widget into a container-anchored gap: reachable ONLY off the LAST container — the widget
    // then leads the widget band and the flow continues on that very row. Off any earlier
    // container the slot sits between containers, where a widget can never render.
    const lastContainer = [...children].reverse().find(c => c.kind === 'container');
    if (lastContainer?.id === anchorId) return { ok: true, mode: 'after', targetId: anchorId };
    return { ok: false, reason: 'widgets render after all containers — this slot sits between containers' };
  }
  // Container into a widget-anchored gap: containers always render before every widget.
  return { ok: false, reason: 'containers render before widgets — drop it beside a container instead' };
}

/** Band-correct insertion INDEX for the add flows: after `afterId` when that slot is band-legal,
 *  else the nearest legal position (widget → head of the widget band, container → end of the
 *  container band). `remapped` is true when the slot was illegal and the index moved. Assumes
 *  canonical children (containers first) — which every model in the editor is. */
export function bandInsertIndex(children: LNode[], afterId: string | undefined, kind: NodeKind): { index: number; remapped: boolean } {
  const boundary = children.filter(c => c.kind === 'container').length; // first widget position
  const bandEnd = isContainerKind(kind) ? boundary : children.length;
  if (!afterId) return { index: bandEnd, remapped: false };
  const at = children.findIndex(c => c.id === afterId);
  if (at < 0) return { index: bandEnd, remapped: false };
  const sameBand = isContainerKind(children[at].kind) === isContainerKind(kind);
  if (sameBand) return { index: at + 1, remapped: false };
  // Cross-band anchor → nearest legal: both cases land AT the band boundary (a widget there leads
  // the widget band; a container there ends the container band). Widget-after-LAST-container is
  // the one legal cross-band slot (the flow really continues there), so it isn't a remap.
  return { index: boundary, remapped: !(!isContainerKind(kind) && at === boundary - 1) };
}
