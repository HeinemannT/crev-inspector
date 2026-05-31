/**
 * Deterministic text serialization of BMP object properties for diff comparison.
 *
 * Output is fed into CodeMirror's MergeView side-by-side editor — making it
 * readable means designing it for the diff view, NOT just dumping a key:value
 * list. The v0.22 format:
 *
 *   ─── identity ───
 *   type:         Page
 *   name:         My Issues
 *   rid:          5137...
 *   businessId:   pg_my_issues
 *
 *   ─── layout ───
 *   width:        (unset)
 *   height:       (unset)
 *
 *   ─── display ───
 *   columnsLargeScreen:    6
 *   showToolMenu:          true
 *
 *   ─── visibility ───
 *   visible:      true
 *
 *   ─── other ───
 *   sortIndex:    5
 *
 *   ─── code: expression ───
 *   SELECT CeIssue
 *   ─── end expression ───
 *
 * Properties group by category (layout / display / visibility / other) so the
 * merge view's `collapseUnchanged` setting can fold runs of equal lines into
 * "12 unchanged lines" markers — and the user's eye lands on the section
 * where the actual change lives instead of having to scan a 200-line blob.
 */

/** Property category map. The order of keys here is the order sections
 *  render in. Identity is implicit — built from the identity argument. */
const CATEGORY_PROPS: Record<string, readonly string[]> = {
  layout: ['width', 'height'],
  display: [
    'columnsLargeScreen', 'columnsMediumScreen', 'columnsSmallScreen',
    'showToolMenu', 'disableSearch', 'shadow', 'headerStyle', 'borderStyle',
    'transparency',
  ],
  appearance: ['headerColor', 'bgColor', 'fontColor'],
  visibility: [
    'visible', 'shownOnLargeDisplay', 'shownOnMediumDisplay', 'shownOnSmallDisplay',
  ],
  columns: ['columnWidths'],
};

/** Build the inverse map: prop → category. Anything not listed falls under
 *  "other". Computed once at module load — set lookup is O(1) per prop. */
const PROP_TO_CATEGORY: Record<string, string> = (() => {
  const out: Record<string, string> = {};
  for (const [cat, props] of Object.entries(CATEGORY_PROPS)) {
    for (const p of props) out[p] = cat;
  }
  return out;
})();

/** Render `key: value` rows with the colon-column aligned so adjacent rows
 *  read as a table. Padded to the longest key in the group + 2. Caps at 28
 *  so a single weirdly-long prop name doesn't shove the value columns far
 *  to the right. */
function renderRows(rows: Array<[string, string]>): string[] {
  if (rows.length === 0) return [];
  const widest = Math.min(28, Math.max(...rows.map(([k]) => k.length)));
  return rows.map(([k, v]) => `${k}:${' '.repeat(Math.max(1, widest - k.length + 2))}${v}`);
}

/** Section header — em-dash bracketed lowercase label. Same string on both
 *  sides of the diff so MergeView aligns the bands and can collapse equal
 *  regions inside them. */
function sectionHeader(label: string): string {
  return `─── ${label} ───`;
}

export function serializeForDiff(
  identity: { name?: string; type?: string; rid: string; businessId?: string },
  props: Record<string, string>,
  codeProps: string[],
): string {
  const lines: string[] = [];

  // Identity section — derived fields, not part of props
  lines.push(sectionHeader('identity'));
  const idRows: Array<[string, string]> = [];
  if (identity.type) idRows.push(['type', identity.type]);
  idRows.push(['name', identity.name ?? 'unnamed']);
  idRows.push(['rid', identity.rid]);
  if (identity.businessId) idRows.push(['businessId', identity.businessId]);
  lines.push(...renderRows(idRows));
  lines.push('');

  // Group simple props by category — code props are deferred to their own
  // section so they get a fenced block with full multi-line content.
  const codePropSet = new Set(codeProps);
  const byCategory: Record<string, Array<[string, string]>> = {};
  for (const [key, value] of Object.entries(props)) {
    if (!value) continue;
    if (codePropSet.has(key)) continue;
    const cat = PROP_TO_CATEGORY[key] ?? 'other';
    (byCategory[cat] ??= []).push([key, value]);
  }

  // Emit sections in CATEGORY_PROPS key order; "other" always last. Each
  // section internally sorts alphabetically for deterministic diffs.
  const orderedCats = [...Object.keys(CATEGORY_PROPS), 'other'];
  for (const cat of orderedCats) {
    const rows = byCategory[cat];
    if (!rows || rows.length === 0) continue;
    rows.sort((a, b) => a[0].localeCompare(b[0]));
    lines.push(sectionHeader(cat));
    lines.push(...renderRows(rows));
    lines.push('');
  }

  // Code props — each its own section with the full body inline so the
  // merge view's word-level diff shows exactly which lines changed.
  for (const key of codeProps) {
    const value = props[key];
    if (!value) continue;
    lines.push(sectionHeader(`code: ${key}`));
    lines.push(value);
    lines.push(sectionHeader(`end ${key}`));
    lines.push('');
  }

  // Trailing blank lines look messy in the diff — strip down to one.
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}
