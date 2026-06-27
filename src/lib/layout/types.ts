/**
 * Layout-builder domain types — the model the blueprint editor operates on.
 *
 * Deliberately decoupled from the wire `LayoutNode` (src/lib/types.ts): only `model.ts`
 * knows the wire shape, everything else speaks these types. That anti-corruption layer is
 * what lets the whole edit/diff/ec core stay pure and unit-testable.
 */

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
  /** Column span per breakpoint (1..6, 0 = hidden). L is always set; M/S optional. */
  cols: { L: number; M?: number; S?: number };
  /** Authored height in px — charts (`chartHeight`) and URLView only. Undefined = content-driven. */
  height?: number;
  children: LNode[];
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
}

/** One step of an apply plan (the diff between baseline and desired). */
export type PlanStep =
  | { kind: 'create'; node: LNode; parentId: string; parentKind: NodeKind }
  | { kind: 'update'; id: string; className: string; cols?: Partial<Record<Breakpoint, number>>; name?: string; height?: number }
  | { kind: 'reparent'; id: string; nodeKind: NodeKind; toParentId: string; toParentKind: NodeKind }
  // afterId is always a real same-kind sibling — diff anchors group[0] and reorders the rest after
  // their predecessor, so "move to first" never needs a null (it falls out of reordering the others).
  | { kind: 'reorder'; id: string; afterId: string }
  // `rid` is threaded so the EC generator can address a businessId-less node by rid (its node lives
  // only in the baseline, so ec.ts can't recover the rid from the desired model).
  | { kind: 'delete'; id: string; nodeKind: NodeKind; className: string; rid?: string; rehomeTo?: string };

export interface PlanNote {
  verb: 'create' | 'update' | 'move' | 'reorder' | 'delete';
  text: string;
  ec?: string;
}

/** A constraint verdict for a candidate gesture. */
export interface Guard {
  ok: boolean;
  /** 'forbidden' = BMP can't serve it, block; 'warn' = serveable but has side effects. */
  level: 'ok' | 'warn' | 'forbidden';
  reason?: string;
}
