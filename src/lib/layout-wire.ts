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

/** AI structure-only provenance: instanceBid|templateRid|templateBid|templateClass|templateName. */
export const LINK_MARKER = '<<<CREV_LINK>>>';

// ── EC fetch wire protocol: three independent channels ride the SAME log, each on its own marker, so
// each parser scans only its own lines and ignores the others. `buildFetchEc`/`buildContextEc` emit them.
export const LAYOUT_SEP = '<<<CREV_LAYOUT>>>'; // layout tree — one node per marker (parseLayoutNodes)
export const PAGE_MARKER = '<<<CREV_PAGE>>>';  // page display name — support-Category naming (parsePageName)
export const CTX_MARKER = '<<<CREV_CTX>>>';    // page-context probe line (resolvePageContext)
export const OVER_MARKER = '<<<CREV_OVER>>>';  // F2 per-widget override flags `bid|prop,…` (parseOverrides)
export const STYLE_MARKER = '<<<CREV_STY>>>';  // G3 per-widget styling `bid|hcBid|fcBid|shadow|headerStyle|borderStyle|transparency` (parseStyles)
/** DescriptionView enterprise property source: `widgetBid|[CeIssue, CeTask]`.
 *  Kept off the shared layout row because Workshop also consumes that stable wire shape. */
export const DESCRIPTION_VIEW_TYPES_MARKER = '<<<CREV_DVT>>>';
/** Blueprint-only DescriptionView authoring payload. The marker line carries the widget id and is
 *  followed by that widget's `genedit()` statement; `sortVisibility` cannot be enumerated directly
 *  in EC because BMP exposes it as a Java array rather than an EC List. */
export const DESCRIPTION_VIEW_PROPERTIES_MARKER = '<<<CREV_DVP>>>';
/** Blueprint-only tab provenance/order channel: `tabRid|tabsetBid|sortIndex`.
 *  Kept separate from LAYOUT_SEP because that shared ten-field wire is also consumed by Workshop. */
export const TAB_META_MARKER = '<<<CREV_TAB>>>';
// Flow projection (blueprint flow editing) — four channels, each one flow-widget or flow-row per line,
// every free-text field placed LAST (see parseFlows in sync.ts). buildFetchEc emits them inside the org loop.
export const FLOW_REF_MARKER = '<<<CREV_FREF>>>';   // one per flow widget: owner|ownerRid|ownerClass|kind|refId|refRid|refClass|createMode|actionType|dOAM|dOAT|container|refParentClass|refParentId|<refName>
export const FLOW_LIST_MARKER = '<<<CREV_FLST>>>';  // workspace ref list (wire-to-existing picker): bid|rid|class|catName|<name>
export const FLOW_META_MARKER = '<<<CREV_FMET>>>';  // owner|field|<value> — objectType / destExpr / addItem / navExpr (free text last)
export const FLOW_CHILD_MARKER = '<<<CREV_FCHD>>>'; // owner|parentChildBid|childBid|childRid|childClass|required|isBreak|dotsCsv|<childName>
export const FLOW_CPROP_MARKER = '<<<CREV_FCPR>>>'; // owner|childBid|<propCaption> (free text last)
export const FLOW_TR_MARKER = '<<<CREV_FTR>>>';     // owner|codeSet|trClass|<transportName>

/** All layout channels share this prefix. User-controlled text is guarded
 *  before it enters the wire so it can never manufacture another record
 *  marker. EC has no general string-replace primitive; wildcard comparison is
 *  its supported containment check, so the whole exotic value is replaced
 *  with an explicit sentinel. Parentheses are required around an IF used as an
 *  RHS expression. */
export function safeWireTextEc(expression: string): string {
  return `(IF ${expression} = "*<<<CREV_*" THEN "[reserved CREV marker]" ELSE ${expression} ENDIF)`;
}

/** Read records only when the marker begins a wire line. Older parsers split
 *  the entire log at every marker occurrence, so a marker embedded in a name
 *  could become a phantom record. The emitter-side sanitizer above prevents
 *  new collisions; this line framing is the parser-side backstop. */
export function markerLines(log: string, marker: string): string[] {
  const lines: string[] = [];
  for (const raw of (log || '').split(/\r?\n/)) {
    let line = raw.trimStart();
    if (line.startsWith('Result :')) line = line.slice('Result :'.length).trimStart();
    if (line.startsWith(marker)) lines.push(line.slice(marker.length).trim());
  }
  return lines;
}

const numOrUndef = (v: string | undefined): number | undefined => (v && /^-?\d+$/.test(v) ? parseInt(v, 10) : undefined);

/** Parse a SEP-delimited fetch log into the flat wire-node list, de-duped by rid. */
export function parseLayoutNodes(log: string): LayoutNode[] {
  const nodes: LayoutNode[] = [];
  const seen = new Set<string>();
  for (const line of markerLines(log, LAYOUT_SEP)) {
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
