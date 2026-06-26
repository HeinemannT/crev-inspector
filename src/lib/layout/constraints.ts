/**
 * Constraints — "what BMP can actually serve", encoded once so the UI and the apply path
 * read the SAME rules. This is the limitations review as data: the UI disables/guards a
 * gesture here, and apply re-checks here, so the blueprint can never promise more than BMP
 * will honor.
 *
 * Serveability verified live via ec_preview on demo scorecard 4957 (2026-06-26):
 *   ✓ resize width (widget+container)        change(columnsLargeScreen)
 *   ✓ height on charts / URLView only        change(chartHeight)
 *   ✓ rename (widget/container/tab)           change(name)
 *   ✓ move/cross-tab (re-point binding)       change(container := …)
 *   ✓ reparent a container                    change(parent := <container>)   [verified]
 *   ✓ reorder siblings (incl. just-created)   moveBefore/moveAfter            [verified on vars]
 *   ✓ add widget (5 types bare) / container / tab   <root>.add(…)             [verified]
 *   ✓ delete                                  delete()  (re-home first)
 */
import { hasHeight } from './model';
import type { Guard, LModel, LNode, NodeKind, SaveTarget } from './types';

/** Widget types that render blank until configured — add places the shell, content is a hand-off. */
export const WIDGET_NEEDS_CONFIG = new Set([
  'CustomVisualization', 'ExtendedTable', 'InputView', 'URLView',
]);

/** Composite widgets that hold children via `<composite>.add(child)` — NOT the `container :=` binding
 *  a normal widget uses. (Verified live: a child binds to its ButtonContainer parent, not a cell.)
 *  Adding INTO one needs a different EC verb that compile doesn't emit yet, so the builder must block
 *  the gesture until composite editing lands (Phase 4). Source: reference/page-hosting.md. */
export const COMPOSITE_TYPES = new Set([
  'ButtonContainer', 'ButtonGroup', 'InputSet', 'TagList', 'ListPropertySet',
]);

const ok: Guard = { ok: true, level: 'ok' };
const warn = (reason: string): Guard => ({ ok: true, level: 'warn', reason });
const forbid = (reason: string): Guard => ({ ok: false, level: 'forbidden', reason });

/** Where can a new widget/container be added? Tabs and Containers are the real cells. Adding into a
 *  WIDGET — a composite (ButtonContainer…) or nonsensically a leaf — isn't serveable by the current
 *  compiler: it would emit `container := <widget>`, which BMP rejects. Block it until composite
 *  editing is wired (Phase 4). */
export function checkAddTarget(parentKind: NodeKind, parentClassName?: string): Guard {
  if (parentKind !== 'widget') return ok;
  return parentClassName && COMPOSITE_TYPES.has(parentClassName)
    ? forbid(`adding into a ${parentClassName} (a composite) isn't supported yet`)
    : forbid('widgets can only be added into a tab or container');
}

/** Height is only authorable on charts and URLView; everything else is content-driven in BMP. */
export function checkHeight(className: string): Guard {
  return hasHeight(className) ? ok : forbid(`${className} has no height property — height is content-driven in BMP`);
}

/** Containers always render before tab-bound widgets, so a widget can't be ordered before a
 *  container in the same tab — BMP would ignore the order and render the container first. */
export function checkReorder(draggedKind: NodeKind, targetKind: NodeKind, before: boolean): Guard {
  if (draggedKind === 'widget' && targetKind === 'container' && before) {
    return forbid('a widget cannot render before a container in the same tab (containers render first)');
  }
  return ok;
}

/** A tab only appears in the page's tab strip once a widget resolves to it; an empty tab is
 *  invisible on the page even though the Tab object exists. */
export function checkTabVisibility(tab: LNode): Guard {
  const hasWidget = (n: LNode): boolean => n.children.some(c => c.kind === 'widget' || hasWidget(c));
  return hasWidget(tab) ? ok : warn('this tab has no widgets, so it will not appear on the page until you add one');
}

/** Structural add/delete with target=instance is unverified in BMP (the instance/template
 *  mechanic is proven for property edits; structure may only live on the template). */
export function checkStructuralTarget(target: SaveTarget, op: 'add' | 'delete'): Guard {
  return target === 'instance'
    ? warn(`structural ${op} on a single instance is unverified — structure usually lives on the template`)
    : ok;
}

/** Tabs and containers are shared portal objects; editing their geometry/identity affects every
 *  page bound to the same TabSet. (Dedicated per-page tabsets avoid this, but we don't assume it.) */
export function checkSharedEdit(nodeKind: NodeKind, op: 'resize' | 'rename' | 'delete' | 'reorder'): Guard {
  if (nodeKind === 'widget') return ok;
  return warn(`${nodeKind}s are shared layout — this ${op} affects every page bound to the same TabSet`);
}

/** Aggregate gate used by the UI before committing a gesture and by apply before executing. */
export type GestureCheck =
  | { type: 'height'; className: string }
  | { type: 'reorder'; draggedKind: NodeKind; targetKind: NodeKind; before: boolean }
  | { type: 'structural'; target: SaveTarget; op: 'add' | 'delete' }
  | { type: 'sharedEdit'; nodeKind: NodeKind; op: 'resize' | 'rename' | 'delete' | 'reorder' };

export function guard(check: GestureCheck): Guard {
  switch (check.type) {
    case 'height': return checkHeight(check.className);
    case 'reorder': return checkReorder(check.draggedKind, check.targetKind, check.before);
    case 'structural': return checkStructuralTarget(check.target, check.op);
    case 'sharedEdit': return checkSharedEdit(check.nodeKind, check.op);
  }
}

/** Whole-model lint surfaced in the Apply preview (warnings the user should see before commit). */
export function lint(m: LModel): string[] {
  const out: string[] = [];
  for (const tab of m.tabs) {
    const v = checkTabVisibility(tab);
    if (v.level === 'warn') out.push(`Tab "${tab.name}": ${v.reason}`);
  }
  return out;
}
