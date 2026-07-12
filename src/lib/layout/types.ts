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
  // Widget flags (style channel, not paintable). ABSENT = the type lacks the
  // trait (fetch read MISSING) — presence gates the flag's UI.
  showToolMenu?: boolean;   // HasToolsMenu           (default true)
  disableSearch?: boolean;  // HasDisableSearch       (default false)
  // Visibility (the WRITABLE knob — the `visible` boolean is read-only/computed):
  // VISIBLE | NOVISIBLE | ADMINVISIBLEONLY | VISIBLEASPARENTONLY.
  visibility?: string;
  // ScreenSizeVisibility trio — default true; all three false = full ghost.
  shownOnLargeDisplay?: boolean;
  shownOnMediumDisplay?: boolean;
  shownOnSmallDisplay?: boolean;
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
  /** UI-only: the tool auto-named this container for its width ("Col N"). While set, a resize keeps the
   *  name in step; an explicit rename clears it (the user owns the name). Never sent to BMP — the diff
   *  compares only real fields (name/cols/height), so this flag is invisible to compile. */
  autoName?: boolean;
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
  /** the page's display name (from the main fetch). Names the ONE support Category that new
   *  InputSets/EditPages and a virtual tabset land in (falls back to `pageId` when empty). */
  pageName?: string;
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
  /** True when the "+ Create tabset" affordance has STAGED a tabset that BMP doesn't have yet. The
   *  compiler emits `root.portal.add(TabSet …)` for it, so the tabset is created in the SAME apply EC as
   *  its tabs (not an eager pre-commit). `tabsetId` is a temp id until the post-apply reload discovers the
   *  real one. */
  tabsetVirtual?: boolean;
  /** Name for a `tabsetVirtual` tabset ("» New … TabSet"). Only read while tabsetVirtual is true. */
  tabsetName?: string;
  /** Flow projections, keyed by flow-widget businessId. READ-ONLY (identical in baseline & desired) —
   *  never diffed, so a model carrying flows diffs byte-identically to one without (pitfall #1). */
  flows?: Record<string, FlowProjection>;
  /** Staged flow edits, keyed by the flow object's businessId (pitfall #2 dedupe). The ONLY flow state
   *  `flowDiff` compares; empty on a freshly-loaded model, so load → diff is a no-op. */
  flowEdits?: Record<string, FlowEdit>;
  /** On-demand fetched children of an EXISTING off-page InputSet/EditPage the user wired to (the
   *  "wire to existing" picker), keyed by that reference's businessId. READ-ONLY, like `flows` — a
   *  session cache injected when a wired reference has no on-page projection, so its real current
   *  contents render (and staged adds/reorders layer on top) instead of an "unknown contents" note. */
  flowRefChildren?: Record<string, { className: string; rid?: string; children: FlowNode[] }>;
}

// ── Flow projection (blueprint flow editing) ────────────────────────────────────────────────────
// A flow-bearing widget (InputView / CreateObjectView / ActionButton) drives a chain: the reference
// it points at (InputSet / EditPage) and that reference's ordered children, plus — for an ActionButton
// — its action verb and transports. Blueprint projects this READ-ONLY chain inside the widget's cell
// (and, for action-menu buttons, in the top-right tray).
//
// This structure is PARALLEL to `LNode.children` and is NEVER placed in it: `diff.ts` walks children
// and would emit reparent/reorder garbage for flow rows, and `computeRows`/ghost logic assume layout
// nodes (pitfall #1). Projections live in `LModel.flows`, keyed by the flow WIDGET's businessId, so two
// InputViews backed by one InputSet each carry their own projection but resolve to ONE add/reorder
// target. Staged edits live in `LModel.flowEdits`, keyed by the CONTAINER (InputSet/EditPage/ButtonGroup)
// or the action button's businessId — so the same InputSet edited from two cells stages once and
// compiles once (pitfall #2). Neither field participates in the layout diff, so a model that carries
// flow data diffs byte-identically to one that does not.

export type FlowKind = 'inputset' | 'editpage' | 'action' | 'add' | 'navigate' | 'plain';

/** One code-presence dot on a flow row: a property that MAY carry EC, and whether it is set. No code
 *  body is ever fetched — only the boolean (pitfall #3). */
export interface FlowDot { prop: string; set: boolean; }

/** One row in a flow chain — an InputSet field, an EditPage element, or a ButtonGroup child. */
export interface FlowNode {
  /** businessId for existing rows, `new:<n>` for staged adds. */
  id: string;
  /** BMP rid (string — 64-bit). Threaded so a businessId-less row is addressable by `lookup(rid)`. */
  rid?: string;
  className: string;
  name: string;
  /** Small right-aligned caption (propertyMapping, 'rich', 'TRUE', …). Rendered as textContent only. */
  prop?: string;
  required?: boolean;
  /** A page/column break — rendered as a quieter row. */
  isBreak?: boolean;
  /** Code-presence dots (filled = set, hollow = empty). */
  dots?: FlowDot[];
  /** Nested rows (ButtonGroup → ButtonInputs). One level of nesting only (per v6). */
  children?: FlowNode[];
}

/** One transport row under an ACTION button's NotificationTransportGroup (read-only). */
export interface FlowTransport { className: string; name: string; codeSet: boolean; }

/** The projection attached to a flow-bearing widget, keyed by the WIDGET's businessId in `LModel.flows`. */
export interface FlowProjection {
  /** the flow widget's businessId (= its key in LModel.flows). */
  ownerId: string;
  ownerRid?: string;
  /** InputView | CreateObjectView | ActionButton. */
  ownerClass: string;
  /** The widget's own display name — needed for TRAY cards: a menu button has NO layout node, so the
   *  projection is its only name source. Emitted for ActionButtons. */
  ownerName?: string;
  kind: FlowKind;
  // reference band (InputSet / EditPage) — the ADD / REORDER container:
  refId?: string; refRid?: string; refClass?: string; refName?: string;
  /** The reference's PARENT (Category detection): a new set/page created from this page co-locates
   *  into the same Category when one exists (Config Studio's support-folder convention, verified on
   *  the fixture: InputSet t.50850 + EditPage t.50865 live in Category t.50675 under root.portal).
   *  `refParentName` is that Category's display name — the honest "lands in …" label for a co-located
   *  create (rides the FLOW_META channel, free-text-last). */
  refParentClass?: string; refParentId?: string; refParentName?: string;
  /** true when more than one flow widget on this page references `refId` (on-page sharing — a cheap,
   *  honest signal; cross-page sharing is not probed, see sync.ts). */
  shared?: boolean;
  // config band (CreateObjectView):
  createMode?: string;   // ADD | EDITORADD | EDITOREDIT (normalized enum)
  objectType?: string;   // created object display name
  destExpr?: string;     // parentDestinationExpression text
  // action button (tray card):
  actionType?: string;   // ACTION | ADD | NAVIGATE (normalized enum)
  actionGroup?: string;  // ACTION: the NotificationTransportGroup's display name ("Runs <actionGroup>")
  transports?: FlowTransport[];
  addItem?: string;      // ADD button: addable item display name
  navExpr?: string;      // NAVIGATE button: expression text
  displayOnActionMenu?: boolean;
  displayOnAllTabs?: boolean;
  container?: string;    // tab / RESULT binding (tray tab attribution)
  /** the reference's ordered children (flat; one level of nesting via FlowNode.children). */
  children: FlowNode[];
}

/** A staged edit on ONE flow object, keyed by businessId in `LModel.flowEdits` (pitfall #2 dedupe).
 *  For an InputSet/EditPage/ButtonGroup key: `adds` + `order`. For an action-button key: the flag flips.
 *  For a flow WIDGET key: `wireRef` (its inputSet/editPage reference). A TEMP key carrying
 *  `newContainer` IS a staged-new InputSet/EditPage — its `adds`/`order` are the new container's
 *  children, so children stage underneath it before the first Apply. */
export interface FlowEdit {
  /** Newly-added children (type + name only — no property forms in blueprint). */
  adds?: FlowNode[];
  /** Desired full child order (businessIds incl. staged `new:` ids). Absent = unchanged order. */
  order?: string[];
  /** Staged displayOnActionMenu flip (in-grid ↔ action bar). */
  displayOnActionMenu?: boolean;
  /** Staged displayOnAllTabs flip (tray scope). */
  displayOnAllTabs?: boolean;
  /** Staged NAME change on an EXISTING flow object (child / container / reference), keyed by its own
   *  businessId. Compiled to `t.<bid>.change(name := …)`. A staged-ADD's rename mutates the add node's
   *  name in place (name rides the create — no rename step); a staged-NEW container's rename updates
   *  `newContainer.name`. So `rename` only ever carries an EXISTING object's new name. */
  rename?: string;
  /** This (temp-keyed) entry is a staged-new InputSet/EditPage awaiting creation on Apply. */
  newContainer?: { className: 'InputSet' | 'EditPage'; name: string };
  /** Staged reference wire on a flow WIDGET: `<widget>.change(<prop> := <target>)`. `targetId` may be
   *  a staged-new container's temp id (compiled var-to-var) or an existing businessId. `setCreateMode`
   *  also folds `createMode := "EDITORADD"` into the same change() — a COV in ADD mode ignores its
   *  editPage otherwise (change(createMode) round-trip execute-verified on t.50842, 2026-07-12). */
  wireRef?: { prop: 'inputSet' | 'editPage'; targetId: string; targetClass: string; targetName?: string; setCreateMode?: boolean };
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
  // Minimal reorder (one op per displaced item): `moveAfter(afterId)` for the general case, or
  // `moveBefore(beforeId)` for a drag-to-front. Exactly one of afterId/beforeId is set.
  | { kind: 'reorder'; id: string; afterId?: string; beforeId?: string }
  // `rid` is threaded so the EC generator can address a businessId-less node by rid (its node lives
  // only in the baseline, so ec.ts can't recover the rid from the desired model). `name` is the
  // baseline display name, threaded for the same reason — the apply log labels the deletion.
  | { kind: 'delete'; id: string; nodeKind: NodeKind; className: string; rid?: string; name?: string; rehomeTo?: string }
  // ── Flow steps (blueprint flow editing) — emitted by flowDiff, kept out of the layout diff so the
  // layout plan stays byte-identical (pitfall #1). `parentId`/`parentClass` address the composite the
  // child is added into (`<parent>.add(<Class>, name := …)`). `parentRid` threads the rid for the
  // lookup() fallback (pitfall #5). A staged-add node carries a temp id; the compiler captures it in a
  // `_f<k>` var so a later flowReorder can address it.
  // `parentId === '*support*'` = land in the page's ONE support Category: the compiler resolves that
  // Category ONCE per apply (reusing an on-page reference's existing Category, else creating a single
  // `root.portal.add(Category, name := <page display name>)` lazily) and shares it across every
  // support landing — the new virtual tabset AND all new InputSets/EditPages. The fixture convention
  // for InputSets/EditPages (verified live 2026-07-12; EditPage is REFUSED at portal root: "Can't add
  // an object of type EditPage to Portal").
  | { kind: 'flowCreate'; node: FlowNode; parentId: string; parentClass: string; parentRid?: string }
  // Minimal reorder within ONE flow parent: `moveAfter(afterId)` (a prior sibling or a just-created
  // `_ff<k>`) or `moveBefore(beforeId)` for a drag-to-front. `parentId` groups the step for summaries.
  | { kind: 'flowReorder'; id: string; rid?: string; afterId?: string; beforeId?: string; parentId: string }
  // action-button flag flip (displayOnActionMenu / displayOnAllTabs). `id` is the button's businessId.
  | { kind: 'flowFlag'; id: string; rid?: string; className: string; prop: 'displayOnActionMenu' | 'displayOnAllTabs'; value: boolean }
  // rename an EXISTING flow object (child / container / reference): `<obj>.change(name := …)`. `id` is its
  // businessId (staged-add / staged-new renames don't reach here — their name rides the create).
  | { kind: 'flowRename'; id: string; rid?: string; className?: string; name: string }
  // reference wire on a flow widget: `<widget>.change(<prop> := <target>)` (+ createMode := "EDITORADD"
  // when setCreateMode). Emitted AFTER every flow create so a staged-new target's var exists; the
  // widget itself may be a staged layout add (its `_n<k>` var resolves through the same vars map).
  | { kind: 'flowWire'; id: string; rid?: string; prop: 'inputSet' | 'editPage'; targetId: string; targetName?: string; setCreateMode?: boolean };

/** The subject node's model id for any plan step — `create`/`flowCreate` carry it on `node`, every
 *  other kind carries it directly. The one place that knows this shape (call sites used to branch on
 *  `kind === 'create'` and broke whenever a node-carrying kind was added). */
export function planStepId(s: PlanStep): string {
  return s.kind === 'create' || s.kind === 'flowCreate' ? s.node.id : s.id;
}

export interface PlanNote {
  verb: 'create' | 'update' | 'move' | 'reorder' | 'delete';
  text: string;
  ec?: string;
  /** The subject node's model id — lets the pending tray render the SAME rows as the apply log
   *  (deduped to one per node) and wire its per-node revert. */
  id?: string;
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
