/**
 * The layout fetch wire protocol — the SEP marker and the line parser, shared by the two EC fetches
 * that emit it: `bmp-client.fetchLayoutTree` (the read-only Layout view's single-subtree walk) and
 * `layout/sync.buildFetchEc` (the blueprint editor's merged org+portal fetch). The two EC *emitters*
 * are deliberately different (they fetch different data), but the marker and the field layout are one
 * format, so the parser lives here once. Pure — no I/O.
 *
 * Line layout (pipe-delimited, one node per SEP marker):
 *   rid | businessId | name | type | parentRid | containerRid | L | M | S | chartHeight
 * The 10th field (chartHeight) is optional — older 9-field emitters parse fine (height undefined).
 */
import type { LayoutNode } from './types';

export const LAYOUT_SEP = '<<<CREV_LAYOUT>>>';

const numOrUndef = (v: string | undefined): number | undefined => (v && /^-?\d+$/.test(v) ? parseInt(v, 10) : undefined);

/** Parse a SEP-delimited fetch log into the flat wire-node list, de-duped by rid. */
export function parseLayoutNodes(log: string): LayoutNode[] {
  const nodes: LayoutNode[] = [];
  const seen = new Set<string>();
  for (const block of log.split(LAYOUT_SEP)) {
    const line = block.split('\n', 1)[0].trim();
    if (!line) continue;
    const parts = line.split('|');
    if (parts.length < 9) continue;
    const [rid, bid, name, type, parentRid, containerRid, l, m, s, height] = parts;
    if (!rid || seen.has(rid)) continue;
    seen.add(rid);
    nodes.push({
      rid,
      businessId: bid || undefined,
      name: name || undefined,
      type: type || 'Unknown',
      parentRid: parentRid || undefined,
      containerRid: containerRid || undefined,
      columnsLargeScreen: numOrUndef(l),
      columnsMediumScreen: numOrUndef(m),
      columnsSmallScreen: numOrUndef(s),
      chartHeight: numOrUndef(height),
    });
  }
  return nodes;
}
