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
 *
 * Flow verbs verified live via ec_preview + ec_execute on the example-flow fixtures
 * (t.template_example_flow / InputSet t.50850 / EditPage t.50865 / ButtonGroup t.50858, 2026-07-11 —
 * created + reordered + DELETED test objects in one committed transaction; fixtures restored):
 *   ✓ <InputSet>.add(TextInput|NumberInput|DateInput|BooleanInput|ReferenceInput|ListInput|
 *                    ButtonInput|Label|Action|Validation|ButtonGroup)      [execute-verified for
 *       ButtonInput/Label/Action/Validation/NumberInput; the rest preview-verified same session]
 *   ✓ <EditPage>.add(EditField|EditPageInfo|EditPageButton|EditPageValidation|
 *                    EditPageBreak|EditPageColumnBreak)                    [execute-verified, all 6]
 *   ✓ <ButtonGroup>.add(ButtonInput)                                      [execute-verified]
 *   ✓ moveBefore/moveAfter on InputSet + EditPage children                [execute-verified]
 *   ✓ change(displayOnActionMenu := TRUE/FALSE) round-trip                [execute-verified: true→false→true]
 *   ✗ ChoiceInput does not exist on this instance ("Type ChoiceInput not found") — not in any palette.
 *
 * Unified support-Category landing (FIX, 2026-07-12) — ONE root.portal Category holds a page's new
 * TabSet + InputSets + EditPages together (verified execute, net-zero: created a Category then added a
 * TabSet+Tab, an InputSet, and an EditPage INTO it — the commit log shows all four adds resolved with
 * tsParent=Category / tabParent=TabSet — then rolled the whole transaction back; 0 leftover):
 *   ✓ <Category>.add(TabSet)  ·  <TabSet>.add(Tab)  ·  <Category>.add(InputSet|EditPage)
 * On-demand wire-to-existing children read: t.<inputSetOrEditPage bid>.children() returns the same
 * child rows the main fetch projects (preview-verified on InputSet t.50850 — 12 children, code-presence
 * via output()).
 * These are the verbs ec.ts's flowCreate/flowReorder/flowFlag steps emit (composite adds no longer
 * blocked — the old "compile doesn't emit yet" note below is history for these types).
 */
import type { Guard, LintMsg, LModel, LNode, PlanStep, SaveTarget } from './types';
import { descendantWidgets, descendantVisibleWidgets } from './model';

/** Composite widgets that hold children via `<composite>.add(child)` — NOT the `container :=` binding
 *  a normal widget uses. (Verified live: a child binds to its ButtonContainer parent, not a cell.)
 *  The compiler serves these via flowCreate (`<composite>.add(Child)`) for the flow palettes below;
 *  the layout-side `parentKind === 'widget'` create branch covers direct composite children too. */
export const COMPOSITE_TYPES = new Set([
  'ButtonContainer', 'ButtonGroup', 'InputSet', 'TagList', 'ListPropertySet',
]);

/** Which child types each composite accepts — drives the add picker when a composite is the target.
 *  (`<composite>.add(Child)`; ButtonContainer→ActionButton verified live. Source: page-hosting.md.
 *  InputSet palette extended + fully live-verified 2026-07-11, see the header block.) */
export const COMPOSITE_CHILDREN: Record<string, { key: string; name: string }[]> = {
  ButtonContainer: [{ key: 'ActionButton', name: 'Action Button' }, { key: 'ButtonInput', name: 'Button Input' }, { key: 'MenuButton', name: 'Menu Button' }],
  // ButtonGroup accepts ONLY ButtonInput — ActionButton and MenuButton were both REFUSED live
  // ("Can't add an object of type ActionButton/MenuButton to Button group", t.50858, 2026-07-11).
  // The old page-hosting.md-sourced entries were wrong for this composite.
  ButtonGroup: [{ key: 'ButtonInput', name: 'Button Input' }],
  InputSet: [
    { key: 'TextInput', name: 'Text' }, { key: 'NumberInput', name: 'Number' }, { key: 'DateInput', name: 'Date' },
    { key: 'BooleanInput', name: 'Boolean' }, { key: 'ReferenceInput', name: 'Reference' }, { key: 'ListInput', name: 'List' },
    { key: 'Label', name: 'Label' }, { key: 'ButtonInput', name: 'Button' }, { key: 'ButtonGroup', name: 'Button Group' },
    { key: 'Action', name: 'Action' }, { key: 'Validation', name: 'Validation' },
  ],
  TagList: [{ key: 'Tag', name: 'Tag' }],
};

/** EditPage element palette — EditPage is NOT a grid composite (it lives outside the page, referenced by
 *  a CreateObjectView), so it gets its own map rather than joining COMPOSITE_CHILDREN. All six verbs
 *  execute-verified on t.50865 (2026-07-11). No propertyMapping picker — a new EditField gets name only;
 *  mapping is configured in Inspect (locked decision). */
export const EDITPAGE_CHILDREN: { key: string; name: string }[] = [
  { key: 'EditField', name: 'Edit Field' }, { key: 'EditPageInfo', name: 'Information' },
  { key: 'EditPageButton', name: 'Button' }, { key: 'EditPageValidation', name: 'Validation' },
  { key: 'EditPageBreak', name: 'Page Break' }, { key: 'EditPageColumnBreak', name: 'Column Break' },
];

/** The add palette for a flow container by className — EditPage → EDITPAGE_CHILDREN, composites →
 *  COMPOSITE_CHILDREN. Empty array = no add affordance (unknown container). */
export function flowChildPalette(className: string): { key: string; name: string }[] {
  if (className === 'EditPage') return EDITPAGE_CHILDREN;
  return COMPOSITE_CHILDREN[className] ?? [];
}

const ok: Guard = { ok: true, level: 'ok' };
const warn = (reason: string): Guard => ({ ok: true, level: 'warn', reason });
const info = (reason: string): Guard => ({ ok: true, level: 'info', reason });

/** A tab only appears on the page once a VISIBLE widget resolves to it. Two ways it can be
 *  invisible even though the Tab object exists: no widgets at all, or every widget hidden
 *  (noVisible / hidden on all sizes) — BMP hides the tab in both cases (verified live). */
export function checkTabVisibility(tab: LNode): Guard {
  if (descendantWidgets(tab).length === 0) return warn('this tab has no widgets, so it will not appear on the page until you add one');
  if (descendantVisibleWidgets(tab).length === 0) return warn('every widget on this tab is hidden, so BMP hides the tab until one is shown');
  return ok;
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
  // Tabs BMP hides on the page — normal on shared tabsets, so a neutral scope note, not a
  // warning. Two distinct causes, two distinct fixes (add a widget vs un-hide one), so they
  // get separate lines. ONE line per group with the count, not one per tab.
  const names = (tabs: LNode[]) => tabs.slice(0, 3).map(t => `"${t.name}"`).join(', ')
    + (tabs.length > 3 ? `, +${tabs.length - 3} more` : '');
  const emptyTabs = m.tabs.filter(t => descendantWidgets(t).length === 0);
  const allHiddenTabs = m.tabs.filter(t => descendantWidgets(t).length > 0 && descendantVisibleWidgets(t).length === 0);
  if (emptyTabs.length > 0) {
    out.push({
      level: 'info',
      text: emptyTabs.length === 1
        ? `1 tab (${names(emptyTabs)}) holds no widgets on this page, so BMP hides it until a widget is added.`
        : `${emptyTabs.length} tabs (${names(emptyTabs)}) hold no widgets on this page, so BMP hides them until a widget is added.`,
    });
  }
  if (allHiddenTabs.length > 0) {
    out.push({
      level: 'info',
      text: allHiddenTabs.length === 1
        ? `1 tab (${names(allHiddenTabs)}) has only hidden widgets, so BMP hides it until a widget is shown.`
        : `${allHiddenTabs.length} tabs (${names(allHiddenTabs)}) have only hidden widgets, so BMP hides them until a widget is shown.`,
    });
  }
  // A structural add or delete on an instance carries the same scope note once (not per-step).
  const structuralOp = plan.some(s => s.kind === 'create') ? 'add' : plan.some(s => s.kind === 'delete') ? 'delete' : null;
  if (structuralOp) {
    const g = checkStructuralTarget(target, structuralOp);
    if ((g.level === 'warn' || g.level === 'info') && g.reason) out.push({ level: g.level, text: g.reason });
  }
  // Flow edits staged behind a SHARED reference (an InputSet/EditPage more than one widget on this page
  // points at): the change lands on the shared object, so it appears in EVERY cell that uses it. A real
  // warning, once per shared reference, named. (`shared` comes from the fetch's on-page reference count.)
  const flowKeys = new Set(plan.flatMap(s =>
    s.kind === 'flowCreate' ? [s.parentId] : s.kind === 'flowReorder' ? [s.parentId] : []));
  const warned = new Set<string>();
  for (const p of Object.values(m.flows ?? {})) {
    if (!p.refId || !p.shared || !flowKeys.has(p.refId) || warned.has(p.refId)) continue;
    warned.add(p.refId);
    out.push({ level: 'warn', text: `"${p.refName ?? p.refId}" is shared — changes appear everywhere it is used.` });
  }
  return out;
}
