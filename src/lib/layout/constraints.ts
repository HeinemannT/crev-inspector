/**
 * Constraints — "what BMP can actually serve", encoded once as data. How they're enforced:
 *
 *  - LIVE pre-commit gate: `lint()` runs over the whole model + plan and its warnings render in the
 *    Apply-preview modal (empty-tab-won't-appear, structural-edit-on-an-instance scope note). This is
 *    the one path a user sees before committing. `checkTabVisibility`/`checkStructuralTarget` feed it.
 *  - Gesture affordance (enforced inline, not here): the builder simply doesn't OFFER an illegal
 *    gesture — "+ Add" appears only on tabs/containers/composites, height only on charts — so a
 *    leaf-add or bad reorder is unreachable by construction. `COMPOSITE_TYPES`/`COMPOSITE_CHILDREN`
 *    drive that affordance in the picker/gestures.
 *
 * (A per-gesture `guard()`/`check*` layer once lived here as data for a future single-source gate; it
 * was never wired and was removed — the affordance + lint above are the real enforcement.)
 *
 * Serveability verified live via ec_preview on demo scorecard 4957 (2026-06-26):
 *   ✓ resize width (widget+container)        change(columnsLargeScreen)
 *   ✓ height on charts / URLView only        change(chartHeight)
 *   ✓ rename (widget/container/tab)           change(name)
 *   ✓ move/cross-tab (re-point binding)       change(container := …)
 *   ✓ reparent a container → container        change(parent := <container>)   [verified]
 *   ✓ reparent a container → tab              change(parent := <tab>)         [verified 2026-06-27:
 *       moved cont_crev_demo_enterprise_4 Overview→Risk Register via parent:=t.4904, accepted]
 *   ✓ reorder siblings (incl. just-created)   moveBefore/moveAfter            [verified on vars]
 *   ✓ add widget (5 types bare) / container / tab   <root>.add(…)             [verified]
 *   ✓ delete                                  delete()  (re-home first)
 */
import type { Guard, LintMsg, LModel, LNode, PlanStep, SaveTarget } from './types';

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

/** Which child types each composite accepts — drives the add picker when a composite is the target.
 *  (`<composite>.add(Child)`; ButtonContainer→ActionButton verified live. Source: page-hosting.md.) */
export const COMPOSITE_CHILDREN: Record<string, { key: string; name: string }[]> = {
  ButtonContainer: [{ key: 'ActionButton', name: 'Action Button' }, { key: 'ButtonInput', name: 'Button Input' }, { key: 'MenuButton', name: 'Menu Button' }],
  ButtonGroup: [{ key: 'ActionButton', name: 'Action Button' }, { key: 'MenuButton', name: 'Menu Button' }],
  InputSet: [{ key: 'BooleanInput', name: 'Boolean' }, { key: 'DateInput', name: 'Date' }, { key: 'NumberInput', name: 'Number' }, { key: 'TextInput', name: 'Text' }, { key: 'ListInput', name: 'List' }, { key: 'ReferenceInput', name: 'Reference' }],
  TagList: [{ key: 'Tag', name: 'Tag' }],
};

const ok: Guard = { ok: true, level: 'ok' };
const warn = (reason: string): Guard => ({ ok: true, level: 'warn', reason });
const info = (reason: string): Guard => ({ ok: true, level: 'info', reason });

/** A tab only appears in the page's tab strip once a widget resolves to it; an empty tab is
 *  invisible on the page even though the Tab object exists. */
export function checkTabVisibility(tab: LNode): Guard {
  const hasWidget = (n: LNode): boolean => n.children.some(c => c.kind === 'widget' || hasWidget(c));
  return hasWidget(tab) ? ok : warn('this tab has no widgets, so it will not appear on the page until you add one');
}

/** Structural add/delete on a single instance is verified to work (live add+delete on demo scorecard
 *  4957, 2026-06-27 — the object persisted under the instance and deleted cleanly). It's not a
 *  warning, just a scope note: the change lands on THIS instance, not a shared template. (Container/
 *  tab blast-radius is covered separately by checkSharedEdit / the shared-template warning.) */
export function checkStructuralTarget(target: SaveTarget, op: 'add' | 'delete'): Guard {
  return target === 'instance'
    ? info(`This ${op} applies directly to this instance, not a shared template.`)
    : ok;
}

/** Whole-model + plan lint surfaced in the Apply preview — what a user should see before commit.
 *  This is the live pre-commit gate (`previewModal` renders these). Each message carries a severity
 *  so the modal can distinguish a real warning (empty tab won't appear) from a neutral scope note
 *  (structural change applies to this instance). The shared-template blast-radius warning is shown
 *  separately by the modal. */
export function lint(m: LModel, target: SaveTarget, plan: PlanStep[]): LintMsg[] {
  const out: LintMsg[] = [];
  for (const tab of m.tabs) {
    const v = checkTabVisibility(tab);
    if (v.level === 'warn' && v.reason) out.push({ level: 'warn', text: `Tab "${tab.name}": ${v.reason}` });
  }
  // A structural add or delete on an instance carries the same scope note once (not per-step).
  const structuralOp = plan.some(s => s.kind === 'create') ? 'add' : plan.some(s => s.kind === 'delete') ? 'delete' : null;
  if (structuralOp) {
    const g = checkStructuralTarget(target, structuralOp);
    if ((g.level === 'warn' || g.level === 'info') && g.reason) out.push({ level: g.level, text: g.reason });
  }
  return out;
}
