/**
 * The layout fetch wire protocol — the SEP marker and the line parser, shared by the two EC fetches
 * that emit it: `bmp-client.fetchLayoutTree` (the read-only Layout view's single-subtree walk) and
 * `layout/sync.buildFetchEc` (the blueprint editor's merged org+portal fetch). The two EC *emitters*
 * are deliberately different (they fetch different data), but the marker and the field layout are one
 * format, so the parser lives here once. Pure — no I/O.
 *
 * Line layout (pipe-delimited, one node per SEP marker):
 *   rid | businessId | type | parentRid | containerRid | L | M | S | chartHeight | name
 * `name` is the LAST field and free-text (the only user-controlled slot), so it is parsed as the
 * REST of the line — any literal `|` in a name is preserved instead of shifting every field after
 * it. A literal newline in a name degrades to harmless truncation (the first line is taken) rather
 * than dropping the node: the structural fields all precede `name`, so they're never corrupted.
 */
import type { LayoutNode } from './types';

// ── EC fetch wire protocol: three independent channels ride the SAME log, each on its own marker, so
// each parser scans only its own lines and ignores the others. `buildFetchEc`/`buildContextEc` emit them.
export const LAYOUT_SEP = '<<<CREV_LAYOUT>>>'; // layout tree — one node per marker (parseLayoutNodes)
export const CTX_MARKER = '<<<CREV_CTX>>>';    // page-context probe line (resolvePageContext)
export const OVER_MARKER = '<<<CREV_OVER>>>';  // F2 per-widget override flags `bid|prop,…` (parseOverrides)

const numOrUndef = (v: string | undefined): number | undefined => (v && /^-?\d+$/.test(v) ? parseInt(v, 10) : undefined);

/** Parse a SEP-delimited fetch log into the flat wire-node list, de-duped by rid. */
export function parseLayoutNodes(log: string): LayoutNode[] {
  const nodes: LayoutNode[] = [];
  const seen = new Set<string>();
  for (const block of log.split(LAYOUT_SEP)) {
    const line = block.split('\n', 1)[0].trim();
    if (!line) continue;
    const parts = line.split('|');
    // 9 structural fields (rid..chartHeight) then name. Anything past field 9 is name — joined
    // back so a name containing `|` survives intact (the split was only to peel off the structure).
    if (parts.length < 9) continue;
    const [rid, bid, type, parentRid, containerRid, l, m, s, height] = parts;
    const name = parts.length > 9 ? parts.slice(9).join('|') : '';
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
