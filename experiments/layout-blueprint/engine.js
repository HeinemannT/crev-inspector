/**
 * Blueprint reconstruction engine.
 *
 * Input:  the flat NODES array (tabs + containers + widgets, each with a parent/binding,
 *         a width span L, and a sortIndex in its own model's sibling space).
 * Output: a tree of tabs → (containers | widgets), nested arbitrarily, ordered for render.
 *
 * The faithful render model (verified against BMP's own grid in layout-reference.md):
 *   every node that has children is a 6-column grid; each child occupies `grid-column:
 *   span L` (L clamped 1..6, with L=0 meaning hidden at this breakpoint). Children whose
 *   spans overflow 6 wrap to the next row. Widths are therefore RELATIVE to the parent
 *   cell — a span-6 widget inside a span-2 container fills that 2-col-wide container, not
 *   the page. Nesting just nests grids; no absolute math needed.
 *
 * The one genuine ambiguity: a Tab can hold BOTH containers (portal sort space) and
 * widgets bound straight to the tab (org/widget sort space). Those two counters don't
 * share an axis, so their interleaving must be chosen. `interleave` selects the strategy;
 * the right answer is settled by diffing against the live BMP render.
 */

/** Build a children-by-parent index. Widgets are keyed under their `container` binding;
 *  layout nodes under their `.parent`. (Both are just `node.parent` in our data shape.) */
function indexChildren(nodes) {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const kids = new Map();
  for (const n of nodes) {
    if (!n.parent) continue;
    if (!kids.has(n.parent)) kids.set(n.parent, []);
    kids.get(n.parent).push(n);
  }
  return { byId, kids };
}

/** Order a node's children for render.
 *  - All-same-kind (all widgets, or all containers): plain sortIndex ascending — unambiguous.
 *  - Mixed (containers + tab-bound widgets under a Tab): apply the chosen strategy, because
 *    the two sortIndex values come from different counters and can't be compared directly. */
function orderChildren(children, interleave) {
  const containers = children.filter(c => c.kind === 'container').sort((a, b) => a.sort - b.sort);
  const widgets = children.filter(c => c.kind === 'widget').sort((a, b) => a.sort - b.sort);
  if (!containers.length || !widgets.length) {
    // No ambiguity — single space. Sort the union by its own sort.
    return [...children].sort((a, b) => a.sort - b.sort);
  }
  switch (interleave) {
    case 'widgets-first': return [...widgets, ...containers];
    case 'merge-by-sort':
      // Naive: pretend both sort axes are comparable. Almost certainly WRONG, kept as a
      // visible control so the failure mode is obvious when diffed against BMP.
      return [...children].sort((a, b) => a.sort - b.sort);
    case 'containers-first':
    default:
      return [...containers, ...widgets];
  }
}

/** Recursively build the render tree from a node id. */
function buildNode(id, ctx, depth) {
  const node = ctx.byId.get(id);
  const rawKids = ctx.kids.get(id) || [];
  const ordered = orderChildren(rawKids, ctx.interleave);
  return {
    ...node,
    depth,
    children: ordered.map(k => buildNode(k.id, ctx, depth + 1)),
  };
}

/**
 * Reconstruct the blueprint.
 * @param nodes      flat NODES
 * @param tabsetId   the TabSet id (tabs are its direct children)
 * @param opts.interleave  'containers-first' | 'widgets-first' | 'merge-by-sort'
 * @returns { tabs: TreeNode[] }  one entry per Tab, in tab-strip order
 */
export function reconstruct(nodes, tabsetId, opts = {}) {
  const interleave = opts.interleave || 'containers-first';
  const { byId, kids } = indexChildren(nodes);
  const ctx = { byId, kids, interleave };
  const tabs = (kids.get(tabsetId) || [])
    .filter(n => n.kind === 'tab')
    .sort((a, b) => a.sort - b.sort)
    .map(t => buildNode(t.id, ctx, 0));
  return { tabs };
}

/** Analyse one grid level: pack its children into rows of 6 and report fit/overflow/gaps.
 *  This is the "infer the layout" part — it tells us where BMP would wrap and where a row
 *  is left partially empty, which is exactly what a faithful blueprint must show. */
export function analyzeRows(children) {
  const rows = [];
  let row = [];
  let used = 0;
  for (const c of children) {
    const span = clampSpan(c.L);
    if (used + span > 6 && row.length) {
      rows.push({ cells: row, used });
      row = [];
      used = 0;
    }
    row.push(c);
    used += span;
  }
  if (row.length) rows.push({ cells: row, used });
  return rows.map(r => ({ ...r, gap: 6 - r.used }));
}

/** Clamp a width span for rendering. L=0 means "hidden at this breakpoint" in BMP, but for
 *  a structural blueprint we still show it as a 1-wide ghost so it doesn't vanish silently. */
export function clampSpan(L) {
  if (L == null) return 6;
  if (L === 0) return 1;
  return Math.max(1, Math.min(6, L));
}

/** Walk the tree and collect human-readable inferences / warnings about the layout —
 *  partial rows, hidden cells, deep nesting, mixed tab children. Surfaced in the UI so the
 *  experiment makes the model's assumptions visible instead of hiding them. */
export function inferNotes(tabs) {
  const notes = [];
  const visit = (node) => {
    if (node.children.length) {
      const rows = analyzeRows(node.children);
      rows.forEach((r, i) => {
        if (r.gap > 0 && r.cells.length) {
          notes.push({
            level: 'info',
            scope: `${node.type} "${node.name}"`,
            msg: `row ${i + 1} fills ${r.used}/6 — ${r.gap} column${r.gap > 1 ? 's' : ''} of empty space on the right`,
          });
        }
      });
      const hasContainers = node.children.some(c => c.kind === 'container');
      const hasWidgets = node.children.some(c => c.kind === 'widget');
      if (node.kind === 'tab' && hasContainers && hasWidgets) {
        notes.push({
          level: 'warn',
          scope: `Tab "${node.name}"`,
          msg: `mixes ${node.children.filter(c => c.kind === 'container').length} container(s) with ${node.children.filter(c => c.kind === 'widget').length} directly-bound widget(s) — interleave order is inferred, verify against live render`,
        });
      }
    }
    if (node.depth >= 2 && node.kind === 'container') {
      notes.push({ level: 'info', scope: `Container "${node.name}"`, msg: `nested ${node.depth} levels deep` });
    }
    node.children.forEach(visit);
  };
  tabs.forEach(visit);
  return notes;
}
