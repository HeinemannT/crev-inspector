/**
 * Layout-builder domain types — the model the blueprint editor operates on.
 *
 * Deliberately decoupled from the wire `LayoutNode` (src/lib/types.ts): only `model.ts`
 * knows the wire shape, everything else speaks these types. That anti-corruption layer is
 * what lets the whole edit/diff/ec core stay pure and unit-testable.
 */

import { STYLE_PROPS } from '../style-props';

export type Breakpoint = 'L' | 'M' | 'S';
export type NodeKind = 'tab' | 'container' | 'widget';
export type SaveTarget = 'instance' | 'template';

/** The BMP "page" classes whose layout this builder edits. A page host is any type implementing
 *  the `WebParent` interface (decompiled: `model/model/webelem/WebParent.java`, which extends
 *  `HasTabChildren`) — they ALL share one containment shape: a portal TabSet of Tabs/Containers
 *  + org-model widgets keyed to a cell via `container`. So the pipeline is page-type-agnostic;
 *  `pageClass` is consumed only by the apply's `SELECT <class>`, and the addable-widget palette
 *  is a function of (model space, host class) — not a per-class branch here.
 *
 *  This list is the COMMON subset; the full WebParent family also includes Perspective,
 *  StrategicObjective, Policy/Asset/Procedure, ControlMeasure, Incident, RiskEvent, Section,
 *  RiskAssessment, Milestone/Task, ActionPlan/Program/Audit/Project, BPMN pages, etc.
 *
 *  NOT a page host: `EnterpriseTemplate` (decompiled: it does NOT implement WebParent — its
 *  children are EnterpriseTemplateElement field-definitions, a different containment family).
 *  Editing an enterprise *template definition* is out of scope for this TabSet+widget model. */
export type PageClass =
  | 'Scorecard' | 'ModelPage' | 'Page' | 'Perspective' | 'Indicator' | 'Kpi'
  | 'Issue' | 'Incident' | 'ControlMeasure' | 'RiskAssessment'
  | (string & {});

/** F2 — the single source of truth for the editable scalar properties an instance can override on its
 *  linked template (and reset). Drives, in lockstep: the fetch's override-detection EC (sync.ts), the
 *  reset allowlist in the EC compiler (ec.ts), and the revert-arrow labels (result.ts). Add a prop here
 *  and the whole chain picks it up. BMP property names. */
export const OVERRIDABLE_PROPS = ['columnsLargeScreen', 'name', 'chartHeight'] as const;

/** G3 — a widget's appearance, read from the fetch and (in style mode) staged for edit. Colours are
 *  CorpoColor LINKS, stored as the colour's businessId (resolved to rgb client-side via the colour-set
 *  cache); the rest are scalar BMP props. All optional — absent = BMP default / not set. */
export interface NodeStyle {
  headerColorBid?: string;
  fontColorBid?: string;
  shadow?: boolean;
  headerStyle?: string;   // INSIDE | OUTSIDE | NONE
  borderStyle?: string;   // LINE | NONE
  transparency?: number;  // 0..100
}

/** G3 — maps each NodeStyle field to its BMP property name + the "unset/default" value the diff treats
 *  as absence. DERIVED from the single style catalog (`STYLE_PROPS`) so the two can't drift: diff compares
 *  each field (absent → `def`) and ec.ts hands the changed (prop, value) to `styleAssignRhs`. Add a prop
 *  to STYLE_PROPS (with its nodeKey/def) and load + diff + apply pick it up. */
export const STYLE_NODE_FIELDS: ReadonlyArray<{
  key: keyof NodeStyle;
  prop: string;
  def: string | number | boolean;
}> = STYLE_PROPS.map(p => ({ key: p.nodeKey as keyof NodeStyle, prop: p.prop, def: p.def }));

/** The appearance props that changed `base → desired` as `(BMP prop, value)` pairs, with each field's
 *  absence folded to its BMP default. Shared by BOTH apply paths so they can't drift: diff uses it for an
 *  existing node's edits (base = its baseline style), and the EC compiler uses it for a NEWLY-created
 *  widget (base = undefined, so every non-default styled field is emitted as a follow-up `.change()` on
 *  the new object — a create step has no baseline, so its style would otherwise be silently dropped). */
export function styleAssignments(
  base: NodeStyle | undefined,
  desired: NodeStyle | undefined,
): { prop: string; value: string | number | boolean }[] {
  const out: { prop: string; value: string | number | boolean }[] = [];
  for (const f of STYLE_NODE_FIELDS) {
    const av = base?.[f.key] ?? f.def;
    const bv = desired?.[f.key] ?? f.def;
    if (av !== bv) out.push({ prop: f.prop, value: bv });
  }
  return out;
}

/** G4 — the appearance patch the paintbrush applies to a target: for each BMP prop in `mask`, the held
 *  source value, folding an ABSENT source value to that prop's default — so painting an unstyled source
 *  CLEARS the masked props on the target (the verified "reset where the source has none" rule). */
export function maskStyle(held: NodeStyle, mask: ReadonlySet<string>): Partial<NodeStyle> {
  const out: Record<string, string | number | boolean> = {};
  for (const f of STYLE_PROPS) {
    if (mask.has(f.prop)) out[f.nodeKey] = (held as Record<string, string | number | boolean | undefined>)[f.nodeKey] ?? f.def;
  }
  return out as Partial<NodeStyle>;
}

/** A node in the editable layout tree.
 *  Tree parentage means different things by kind: a widget's parent is the cell it BINDS to
 *  (`container :=`); a container's/tab's parent is its STRUCTURAL parent. `kind` disambiguates. */
export interface LNode {
  /** Stable identity: BMP businessId for existing objects, `new:<n>` for staged adds. */
  id: string;
  /** BMP rid (kept as a string — 64-bit, exceeds JS safe-int). Absent for staged adds. */
  rid?: string;
  kind: NodeKind;
  /** BMP className: Tab | Container | CustomVisualization | ExtendedTable | … */
  className: string;
  name: string;
  /** Column span per breakpoint (1..6). 0 is class-dependent (live-verified 2026-07-02): a widget
   *  renders full width (= 6); a container renders as a ~1-track auto cell — see rows.trackSpan.
   *  L is always set; M/S optional. */
  cols: { L: number; M?: number; S?: number };
  /** Authored height in px — charts (`chartHeight`) and URLView only. Undefined = content-driven. */
  height?: number;
  children: LNode[];
  /** F2 — instance view only: BMP property names whose value OVERRIDES the linked template (this widget
   *  is inherited via `linkedTo` and its value differs). Drives the blue revert arrows. From the fetch. */
  overrides?: string[];
  /** F2 — staged resets: BMP property names the user has marked to revert to the template (`.reset(p)`).
   *  Subset of `overrides`. Staged like any edit (mutated in the model → undo/redo), applied on Apply. */
  resets?: string[];
  /** G3 — the widget's current appearance (from the fetch); mutated in style mode to stage style edits. */
  style?: NodeStyle;
}

/** The whole page being edited (a Scorecard, ModelPage, or Enterprise template). */
export interface LModel {
  /** org-model root that owns widgets (`<page>.add(Widget …)`) — the Scorecard/ModelPage/etc. */
  pageId: string;
  pageRid?: string;
  /** the page's BMP class — only consumed by the apply `SELECT <class>`; fetch uses `lookup(rid)`. */
  pageClass: PageClass;
  /** portal-model root that owns tabs (`<tabset>.add(Tab)`). */
  tabsetId: string;
  /** the page's tabs, each holding containers + tab-bound widgets (containers-first order). */
  tabs: LNode[];
  target: SaveTarget;
  hasTemplate: boolean;
  /** True when the page has no dedicated tabset (its widgets sit on the shared Result tab). The UI
   *  shows a "+ Create tabset" affordance in the tab bar so the configurator can organise the page. */
  resultOnly?: boolean;
}

/** One step of an apply plan (the diff between baseline and desired). */
export type PlanStep =
  | { kind: 'create'; node: LNode; parentId: string; parentKind: NodeKind }
  // A `null` col/height means CLEARED (the value was set in the baseline and is unset in the target).
  // diff carries it so the stale-guard sees a concurrent server-side clear as drift; ec.ts does not
  // emit it (BMP has no verified clear verb — `:= MISSING` is a no-op on these fields).
  // `resetProps` (F2) = BMP property names to revert to the linked template via `.reset(p)` — emitted
  // alongside (or instead of) value changes; the value itself is unchanged when only a reset is staged.
  // `styleAssign` (G3) = changed appearance props (headerColor/shadow/…) folded into the same `.change()`;
  // colour links carry the bid as the value ('' = clear), scalars carry the typed value. ec.ts maps each
  // via `styleAssignRhs`.
  | { kind: 'update'; id: string; className: string; cols?: Partial<Record<Breakpoint, number | null>>; name?: string; height?: number | null; resetProps?: string[]; styleAssign?: { prop: string; value: string | number | boolean }[] }
  | { kind: 'reparent'; id: string; nodeKind: NodeKind; toParentId: string; toParentKind: NodeKind }
  // afterId is always a real same-kind sibling — diff anchors group[0] and reorders the rest after
  // their predecessor, so "move to first" never needs a null (it falls out of reordering the others).
  | { kind: 'reorder'; id: string; afterId: string }
  // `rid` is threaded so the EC generator can address a businessId-less node by rid (its node lives
  // only in the baseline, so ec.ts can't recover the rid from the desired model). `name` is the
  // baseline display name, threaded for the same reason — the apply log labels the deletion.
  | { kind: 'delete'; id: string; nodeKind: NodeKind; className: string; rid?: string; name?: string; rehomeTo?: string };

export interface PlanNote {
  verb: 'create' | 'update' | 'move' | 'reorder' | 'delete';
  text: string;
  ec?: string;
  /** Structured columns for the apply-log table (view-panels.previewModal). `text` stays the
   *  single-sentence fallback; these split it into uniform, scannable fields. */
  action?: 'Add' | 'Style' | 'Change' | 'Reset' | 'Move' | 'Reorder' | 'Delete';
  /** The affected object's display name. */
  object?: string;
  /** Its BMP className (Tab / Container / DescriptionView / …) — drives the type chip. */
  objectType?: string;
  /** Destination / context name, already human (the container or tab it lands in / moves to). */
  where?: string;
  /** Compact qualifier: "6/6", "headerColor, shadow", "→ \"New name\"", "420px". */
  detail?: string;
}

/** A constraint verdict for a candidate gesture. */
export interface Guard {
  ok: boolean;
  /** 'forbidden' = BMP can't serve it, block; 'warn' = serveable but has side effects;
   *  'info' = serveable, no side effects, just a scope note worth surfacing (no warning weight). */
  level: 'ok' | 'info' | 'warn' | 'forbidden';
  reason?: string;
}

/** A pre-commit lint message + its severity, so the Apply modal can render warnings (triangle) and
 *  neutral scope notes (info) differently. */
export interface LintMsg {
  level: 'warn' | 'info';
  text: string;
}
