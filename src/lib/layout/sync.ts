/**
 * sync.ts — the imperative shell's pure orchestration layer (load + apply).
 *
 * The functional core (model/edit/diff/ec) never talks to BMP. This module is the seam:
 * it builds the EC that FETCHES a page's layout and the EC that APPLIES an edit, but it
 * does the actual I/O through an injected `LayoutIO`, so it stays unit-testable and host
 * agnostic (same code path in the service worker and in tests).
 *
 * The two-model split is handled in ONE fetch round trip:
 *   - grid   (Tab + Container tree)  ← `t.<tabsetId>.descendants()`        (portal model)
 *   - widgets + composites           ← `lookup(<pageRid>).descendants()` (org model)
 * Both are emitted into a single pipe-delimited list in the exact 9-field wire shape that
 * `reconstruct` already consumes (rid|bid|name|type|parentRid|containerRid|L|M|S).
 *
 * `descendants()` (not `children()`) on the org side is deliberate: a composite widget like
 * ButtonContainer nests its child buttons one level deeper (the button's `parent` is the
 * ButtonContainer, not the scorecard), and `children()` would miss them. `descendants()` was
 * verified to return ONLY layout objects — no config sub-objects (expressions, table columns)
 * leak in. A widget's phantom RESULT placement is mapped to an empty containerRid so it falls
 * through to its org parent. Verified live against demo scorecard 4957 on 2026-06-26.
 *
 * Apply is diff → compile → exec → RE-FETCH. We never map temp ids to real rids: the
 * re-fetch is the new source of truth, which also makes apply idempotent (a second apply of
 * an already-applied model diffs to an empty plan).
 */
import { reconstruct, walk, RESULT_TAB_ID } from './model';
import type { ReconstructCtx } from './model';
import { diff } from './diff';
import { flowDiff, flowSignature } from './flow';
import { compile } from './ec';
import { validateBusinessId, validateRid } from '../ec-guards';
import { LAYOUT_SEP, CTX_MARKER, OVER_MARKER, STYLE_MARKER,
  FLOW_REF_MARKER, FLOW_META_MARKER, FLOW_CHILD_MARKER, FLOW_CPROP_MARKER, FLOW_TR_MARKER,
  parseLayoutNodes } from '../layout-wire';
import { enumMember } from '../color-util';
import { normalizeBmpEnum, FLOW_DOT_SLOTS, FLOW_DOT_PROPS } from '../widget-metadata';
import type { LayoutNode as WireNode } from '../types';
import { OVERRIDABLE_PROPS } from './types';
import type { LModel, PlanNote, PlanStep, NodeStyle, FlowProjection, FlowNode, FlowKind } from './types';

/** The single I/O capability sync needs: run an EC program, get its log back. Injected so the
 *  service worker can wire it to `bmp-client.executeEc` while tests pass a fake. `commit` selects
 *  a transactional (writing) run — the fetch/probe paths leave it false (read-only), apply sets it
 *  true. The adapter is also where silent-rollback detection lives (see layout-service). */
export interface LayoutIO {
  exec(code: string, commit?: boolean): Promise<{ ok: boolean; log?: string; error?: string }>;
}

/** What `loadModel`/`applyModel` need beyond the reconstruct ctx: the scorecard rid (for the
 *  `lookup()` of the org-model root) on top of the business ids reconstruct already uses. */
export interface BlueprintCtx extends ReconstructCtx {
  /** org-model root rid — resolved with `lookup(rid)` (always present from page context). */
  pageRid: string;
}

export interface LoadResult {
  model: LModel;
  /** A second, independent clone to diff against — editing mutates `model`, never `baseline`. */
  baseline: LModel;
  /** Widgets whose `.container` is missing — BMP would render them on the phantom RESULT tab.
   *  Surfaced (not dropped) so the UI can warn instead of silently hiding objects. */
  orphans: WireNode[];
}

export interface ApplyResult {
  ok: boolean;
  /** True when the desired model equalled the baseline — nothing was executed. */
  noop: boolean;
  /** True when the live page drifted from the baseline since load (someone else edited it). Nothing
   *  was committed; `model`/`baseline` carry the FRESH live state so the UI can rebase the edits. */
  stale?: boolean;
  plan: PlanStep[];
  notes: PlanNote[];
  /** The compiled EC (empty string on no-op) — handy for a dry-run preview and for logs. */
  script: string;
  /** Re-fetched model + fresh baseline after a successful apply (or the fresh live state on stale). */
  model?: LModel;
  baseline?: LModel;
  error?: string;
}

const SEP = LAYOUT_SEP;   // layout wire marker
const CTX = CTX_MARKER;   // page-context probe marker
const OVER = OVER_MARKER; // F2 per-widget override channel marker
const STYLE = STYLE_MARKER; // G3 per-widget style channel marker
// Shared EC id/rid sanitisation (the same guards the other EC generators use).
const ecBid = validateBusinessId;
const ecRid = validateRid;

/** The shared, system-wide tabset that enterprise-object pages render their template into.
 *  (Verified live: an EnterpriseTemplate's widgets bind to Tabs/Containers under `default_tabset`,
 *  not a dedicated per-page tabset.) */
export const DEFAULT_TABSET = 'default_tabset';

/** Flow projection (blueprint flow editing): the EC that emits one flow child row. Operates on loop var
 *  `v` (`_c` for a direct child, `_cc` for a ButtonGroup grandchild), owned by widget-id expr `owner`,
 *  nested under `parentBid` ("" for a direct child). Code-presence is read through `output(...)` so a
 *  code-bearing prop is NEVER evaluated (bare `.expression` would RUN it) — only its raw text is
 *  inspected for emptiness. Every free-text field (name, caption) is emitted LAST on its line. */
function flowChildEmit(v: string, owner: string, parentBid: string): string[] {
  return [
    `          _ck := ${v}.className.whenMissing("")`,
    `          _cbrk := "0"`,
    `          IF _ck = "EditPageBreak" THEN _cbrk := "1" ELSE _cbrk := _cbrk ENDIF`,
    `          IF _ck = "EditPageColumnBreak" THEN _cbrk := "1" ELSE _cbrk := _cbrk ENDIF`,
    `          _creq := "0"`,
    `          IF output(${v}.required.whenMissing("")) = "true" THEN _creq := "1" ELSE _creq := _creq ENDIF`,
    `          _dots := ""`,
    ...FLOW_DOT_SLOTS.map(s => `          IF output(${v}.${s}.whenMissing("")) <> "" THEN _dots := _dots + "1," ELSE _dots := _dots + "0," ENDIF`),
    `          _l := _l + "${FLOW_CHILD_MARKER}" + ${owner} + "|" + ${parentBid} + "|" + ${v}.id.whenMissing("") + "|" + ${v}.rid + "|" + _ck + "|" + _creq + "|" + _cbrk + "|" + _dots + "|" + ${v}.name.whenMissing("") + "\\n"`,
    `          _cap := ""`,
    `          IF _ck = "EditField" THEN _cap := ${v}.propertyMapping.whenMissing("") ELSE _cap := _cap ENDIF`,
    `          IF _ck = "Label" THEN IF ${v}.textInputType.whenMissing("") = "RICH" THEN _cap := "rich" ELSE _cap := _cap ENDIF ELSE _cap := _cap ENDIF`,
    `          IF _cap <> "" THEN _l := _l + "${FLOW_CPROP_MARKER}" + ${owner} + "|" + ${v}.id.whenMissing("") + "|" + _cap + "\\n" ELSE _l := _l ENDIF`,
  ];
}

/** Flow projection EC for the current org-loop widget `_w` (already known to be a flow-bearing type).
 *  Resolves its reference (InputSet/EditPage), verb (createMode/actionType), the reference's ordered
 *  children (one level of ButtonGroup nesting), and — for an ACTION button — its transports. Appends
 *  everything to the small per-node accumulator `_l` (chunked flush handles the perf invariant). */
function buildFlowEmit(): string[] {
  const owner = '_w.id.whenMissing("")';
  return [
    `     _fkind := "plain"`,
    `     _fref := MISSING`,
    `     IF _cn = "InputView" THEN`,
    `          _fref := _w.inputSet`,
    `          _fkind := "inputset"`,
    `     ELSE`,
    `          _fref := _fref`,
    `     ENDIF`,
    `     IF _cn = "CreateObjectView" THEN`,
    `          _fref := _w.editPage`,
    `          _fkind := "editpage"`,
    `     ELSE`,
    `          _fref := _fref`,
    `     ENDIF`,
    // BMP validates an ActionType comparison string against the bare member (ACTION/ADD/EDIT/NAVIGATE),
    // NOT the stringified "ActionType.add" — so compare on the bare member here. (The emitted value below
    // still stringifies to "ActionType.add"; the parser normalizes it.)
    `     _atype := _w.actionType.whenMissing("")`,
    `     IF _cn = "ActionButton" THEN`,
    `          IF _atype = "ADD" THEN _fkind := "add" ELSE _fkind := _fkind ENDIF`,
    `          IF _atype = "NAVIGATE" THEN _fkind := "navigate" ELSE _fkind := _fkind ENDIF`,
    `          IF _atype = "ACTION" THEN _fkind := "action" ELSE _fkind := _fkind ENDIF`,
    `     ELSE`,
    `          _fkind := _fkind`,
    `     ENDIF`,
    `     _frefId := _fref.id.whenMissing("")`,
    `     _l := _l + "${FLOW_REF_MARKER}" + ${owner} + "|" + _w.rid + "|" + _cn + "|" + _fkind + "|" + _frefId + "|" + _fref.rid.whenMissing("") + "|" + _fref.className.whenMissing("") + "|" + _w.createMode.whenMissing("") + "|" + _atype + "|" + _w.displayOnActionMenu.whenMissing("") + "|" + _w.displayOnAllTabs.whenMissing("") + "|" + _w.container.id.whenMissing("") + "|" + _fref.name.whenMissing("") + "\\n"`,
    `     IF _cn = "CreateObjectView" THEN`,
    `          _l := _l + "${FLOW_META_MARKER}" + ${owner} + "|objectType|" + _w.objectType.whenMissing("") + "\\n"`,
    `          _l := _l + "${FLOW_META_MARKER}" + ${owner} + "|destExpr|" + output(_w.parentDestinationExpression.whenMissing("")) + "\\n"`,
    `     ELSE`,
    `          _l := _l`,
    `     ENDIF`,
    `     IF _fkind = "navigate" THEN`,
    `          _l := _l + "${FLOW_META_MARKER}" + ${owner} + "|navExpr|" + output(_w.expression.whenMissing("")) + "\\n"`,
    `     ELSE`,
    `          _l := _l`,
    `     ENDIF`,
    `     IF _fkind = "add" THEN`,
    `          _ai := ""`,
    `          _w.addableItems.forEach(_a:`,
    `               IF _ai = "" THEN _ai := _a.name.whenMissing("") ELSE _ai := _ai ENDIF`,
    `          )`,
    `          _l := _l + "${FLOW_META_MARKER}" + ${owner} + "|addItem|" + _ai + "\\n"`,
    `          _l := _l + "${FLOW_META_MARKER}" + ${owner} + "|destExpr|" + output(_w.parentDestinationExpression.whenMissing("")) + "\\n"`,
    `     ELSE`,
    `          _l := _l`,
    `     ENDIF`,
    // The button's own name — a MENU button has no layout node (no SEP line), so the tray card's
    // title must come from the projection.
    `     IF _cn = "ActionButton" THEN`,
    `          _l := _l + "${FLOW_META_MARKER}" + ${owner} + "|ownerName|" + _w.name.whenMissing("") + "\\n"`,
    `     ELSE`,
    `          _l := _l`,
    `     ENDIF`,
    `     IF _fkind = "action" THEN`,
    `          _l := _l + "${FLOW_META_MARKER}" + ${owner} + "|actionGroup|" + _w.actionObject.name.whenMissing("") + "\\n"`,
    `          _w.actionObject.children().forEach(_tr:`,
    `               _tset := "0"`,
    `               IF output(_tr.expression.whenMissing("")) <> "" THEN _tset := "1" ELSE _tset := _tset ENDIF`,
    `               _l := _l + "${FLOW_TR_MARKER}" + ${owner} + "|" + _tset + "|" + _tr.className.whenMissing("") + "|" + _tr.name.whenMissing("") + "\\n"`,
    `          )`,
    `     ELSE`,
    `          _l := _l`,
    `     ENDIF`,
    // NOTE the loop var is `_fc` / `_fcc` — NOT `_c`, which is the org loop's chunk accumulator. A
    // collision there silently clobbered every prior widget's output (caught live 2026-07-11).
    `     IF _frefId <> "" THEN`,
    `          _fref.children().forEach(_fc:`,
    ...flowChildEmit('_fc', owner, '""'),
    `               IF _fc.className.whenMissing("") = "ButtonGroup" THEN`,
    `                    _fc.children().forEach(_fcc:`,
    ...flowChildEmit('_fcc', owner, '_fc.id.whenMissing("")'),
    `                    )`,
    `               ELSE`,
    `                    _l := _l`,
    `               ENDIF`,
    `          )`,
    `     ELSE`,
    `          _l := _l`,
    `     ENDIF`,
  ];
}

/**
 * Build the merged-fetch EC. Emits, one per line after a `SEP` marker, every layout node in
 * the 9-field wire shape. Grid nodes carry `parentRid`; widget nodes carry `containerRid`; the
 * tabset root is emitted explicitly (descendants() excludes the root) so reconstruct can anchor
 * the tab list to it. Widgets with no container binding are emitted with an empty containerRid —
 * `parseFetchLog` routes those to `orphans`.
 */
export function buildFetchEc(ctx: BlueprintCtx): string {
  const ts = `t.${ecBid(ctx.tabsetId)}`;
  const sc = `lookup(${ecRid(ctx.pageRid)})`;
  const cols = (v: string) => `${v}.columnsLargeScreen.whenMissing("") + "|" + ${v}.columnsMediumScreen.whenMissing("") + "|" + ${v}.columnsSmallScreen.whenMissing("")`;
  // Field order (see layout-wire.ts): rid|bid|type|parent|container|L|M|S|height|name. `name` is LAST
  // and free-text, so a `|` in a name can't shift the structural fields. EVERY emit line ends with the
  // raw name as the final field.
  // tabset root: no parent, no container, no height (5 empties: parent|container|L|M|S), then height empty, then name.
  const root = `${ts}.rid + "|" + ${ts}.id.whenMissing("") + "|" + ${ts}.className.whenMissing("") + "|||||" + "|" + "|" + ${ts}.name.whenMissing("")`;
  // org model: widgets + composites (recursive). Emit BOTH parent (composite nesting) and container
  // (portal placement). A widget bound to the Result tab keeps that binding so it attaches to the Result
  // tab node. Skip ActionButtons flagged displayOnActionMenu — BMP renders those in the page's action
  // MENU, not the grid, so they're not part of the editable layout. Shared by both fetch shapes.
  // PERFORMANCE INVARIANT (live-measured 2026-07-02, tightened 2026-07-06): every `+` whose operand
  // chain includes the big accumulator `_r` re-copies AND HTML-sniffs (DetectHtml regex) the whole
  // string — so a multi-term `_r := _r + a + b + …` costs one full-accumulator pass PER TERM, and the
  // fetch goes quadratic with a huge constant (a ~2000-line build measured 52s; small-first, ~8s).
  // Rules: (1) build each node's lines in the SMALL local `_l`; (2) append `_l` to the mid-size chunk
  // `_c` and flush `_c` into `_r` only every 16 nodes — touching `_r` once per node cost 5.6s on a
  // 258-node scorecard (each touch copies+sniffs the whole ~37KB accumulator); chunked flushing
  // processes ~8x fewer accumulator bytes. Measured 2026-07-06: sc_cvo_demo fetch 5561ms before.
  //
  // F2 override channel: for an inherited widget (linkedTo a template counterpart), emit a separate
  // `<OVER>bid|prop,...` line listing the props whose value differs from the template — the parser picks
  // these up independently of the layout wire (they sit on a different marker, so parseLayoutNodes skips
  // them). Empty for local widgets and for template-mode loads (the template's widgets have no linkedTo).
  const overEmit = [
    `          _lt := _w.linkedTo`,
    `          IF _lt.rid.whenMissing("") <> "" THEN`,
    `               _ovr := ""`,
    ...OVERRIDABLE_PROPS.map(p =>
      `               IF _w.${p}.whenMissing("") <> _lt.${p}.whenMissing("") THEN _ovr := _ovr + "${p}," ELSE _ovr := _ovr ENDIF`),
    `               IF _ovr <> "" THEN _l := _l + "${OVER}" + _w.id.whenMissing("") + "|" + _ovr + "\\n" ELSE _l := _l ENDIF`,
    `          ELSE`,
    `               _l := _l`,
    `          ENDIF`,
  ];
  // G3 style channel: per widget, emit its current appearance on a distinct marker (parsed by
  // parseStyles, independent of the layout wire). Colours are CorpoColor LINKS, so we emit the colour's
  // businessId (`.id`) — resolved to rgb client-side via the colour-set cache — not a value. `.id` on a
  // MISSING colour chains to MISSING → whenMissing("") → "" (same safe pattern as the override channel).
  const styleEmit = [
    `          _l := _l + "${STYLE}" + _w.id.whenMissing("") + "|" + _w.headerColor.id.whenMissing("") + "|" + _w.fontColor.id.whenMissing("") + "|" + _w.shadow.whenMissing("") + "|" + _w.headerStyle.whenMissing("") + "|" + _w.borderStyle.whenMissing("") + "|" + _w.transparency.whenMissing("") + "|" + _w.visibility.whenMissing("") + "|" + _w.showToolMenu.whenMissing("") + "|" + _w.disableSearch.whenMissing("") + "|" + _w.shownOnLargeDisplay.whenMissing("") + "|" + _w.shownOnMediumDisplay.whenMissing("") + "|" + _w.shownOnSmallDisplay.whenMissing("") + "\\n"`,
  ];
  const orgLoop = [
    `_c := ""`,
    `_i := 0`,
    `_sc.descendants().forEach(_w:`,
    `     _cn := _w.className.whenMissing("")`,
    `     _l := ""`,
    // An action-menu ActionButton (displayOnActionMenu) is NOT part of the editable GRID — BMP renders it
    // in the page's action MENU, not a cell — so it gets no SEP widget line (it stays out of the layout
    // model, like a ghost). But we DO still project its flow below (the tray reads that). Every other
    // widget (incl. an in-grid ActionButton) emits its normal grid line.
    `     _isMenuAB := "0"`,
    `     IF _cn = "ActionButton" THEN`,
    `          IF _w.displayOnActionMenu.whenMissing(false) = true THEN _isMenuAB := "1" ELSE _isMenuAB := _isMenuAB ENDIF`,
    `     ELSE`,
    `          _isMenuAB := _isMenuAB`,
    `     ENDIF`,
    `     IF _isMenuAB = "0" THEN`,
    `          _l := "${SEP}" + _w.rid + "|" + _w.id.whenMissing("") + "|" + _cn + "|" + _w.parent.rid.whenMissing("") + "|" + _w.container.rid.whenMissing("") + "|" + ${cols('_w')} + "|" + _w.chartHeight.whenMissing("") + "|" + _w.name.whenMissing("") + "\\n"`,
    // The override channel only means anything for INSTANCE loads (a template's widgets have no
    // linkedTo, so every check would compare a widget against MISSING and emit nothing). Skipping it
    // for template-target loads drops ~2·|OVERRIDABLE_PROPS| property reads per widget — a real win
    // on heavy pages, where the fetch EC is the slow half of opening the blueprint.
    ...(ctx.target === 'template' ? [] : overEmit),
    ...styleEmit,
    `     ELSE`,
    `          _l := _l`,
    `     ENDIF`,
    // Flow projection for a flow-bearing widget (both in-grid and action-menu). Rides the same _l.
    `     IF _cn = "InputView" OR _cn = "CreateObjectView" OR _cn = "ActionButton" THEN`,
    ...buildFlowEmit(),
    `     ELSE`,
    `          _l := _l`,
    `     ENDIF`,
    `     _c := _c + _l`,
    `     _i := _i + 1`,
    `     IF _i > 15 THEN`,
    `          _r := _r + _c`,
    `          _c := ""`,
    `          _i := 0`,
    `     ELSE`,
    `          _r := _r`,
    `     ENDIF`,
    `)`,
    `_r := _r + _c`,
  ];
  // RESULT-only page (no dedicated tabset): emit ONLY the Result tab node (NOT default_tabset's shared
  // Row/Column scaffold — that belongs to every scorecard) plus the page's own org widgets, which bind to
  // it. Crucially we do NOT walk default_tabset.descendants() here, or the shared scaffold would leak in
  // and the page's widgets would render under empty generic Rows. (Verified live: scorecard 462.)
  if (ctx.resultOnly) {
    return [
      `_sc := ${sc}`,
      `_r := ""`,
      `_res := t.${RESULT_TAB_ID}`,
      `_r := _r + "${SEP}" + _res.rid + "|${RESULT_TAB_ID}|Tab|" + _res.parent.rid.whenMissing("") + "||||||" + _res.name.whenMissing("Result") + "\\n"`,
      ...orgLoop,
      `_r`,
    ].join('\n');
  }
  return [
    `_ts := ${ts}`,
    `_sc := ${sc}`,
    `_r := ""`,
    `_r := _r + "${SEP}" + ${root} + "\\n"`,
    // The scorecard's intrinsic "Result" tab lives in the SHARED default_tabset, not this page's tabset,
    // so `_ts.descendants()` below never reaches it. Emit it here (with its REAL parent) when it's a
    // different tabset, so it's just another Tab node in the list — reconstruct collects tabs by kind.
    // Emitted first so it leads the strip (as BMP shows it). Its widgets bind to the tab directly and
    // come through the org loop unchanged; we don't pull in its shared Row/Column scaffold. NOTE: diff's
    // index() parents all tabs under this page's tabsetId, so the Result tab is NOT auto-isolated by
    // parent — diff.ts excludes it from the tab reorder group explicitly (see isResultTab there), and
    // the UI blocks its rename/delete. Don't assume the foreign parent protects it.
    `_res := t.${RESULT_TAB_ID}`,
    `IF _res.className.whenMissing("") = "Tab" AND _res.parent.rid.whenMissing("") != _ts.rid THEN`,
    `     _r := _r + "${SEP}" + _res.rid + "|${RESULT_TAB_ID}|Tab|" + _res.parent.rid.whenMissing("") + "||||||" + _res.name.whenMissing("Result") + "\\n"`,
    `ELSE`,
    `     _r := _r`,
    `ENDIF`,
    // grid: tabs + containers — parentRid set, containerRid always empty, no chartHeight.
    // Same small-first rule as the org loop: line into `_l`, ONE `_r` touch per node.
    `_c := ""`,
    `_i := 0`,
    `_ts.descendants().forEach(_n:`,
    `     _l := "${SEP}" + _n.rid + "|" + _n.id.whenMissing("") + "|" + _n.className.whenMissing("") + "|" + _n.parent.rid.whenMissing("") + "||" + ${cols('_n')} + "|" + "|" + _n.name.whenMissing("") + "\\n"`,
    `     _c := _c + _l`,
    `     _i := _i + 1`,
    `     IF _i > 15 THEN`,
    `          _r := _r + _c`,
    `          _c := ""`,
    `          _i := 0`,
    `     ELSE`,
    `          _r := _r`,
    `     ENDIF`,
    `)`,
    `_r := _r + _c`,
    ...orgLoop,
    `_r`,
  ].join('\n');
}

/** Parse the merged-fetch log into wire nodes — the shared layout wire parser (see layout-wire.ts). */
export const parseFetchLog = parseLayoutNodes;

/** Parse the F2 override channel (`<OVER>bid|prop,prop` lines) into a businessId → prop-names map. It
 *  rides the same log as the layout wire but on a distinct marker, so the two parsers read it
 *  independently (parseLayoutNodes only looks at SEP blocks). */
export function parseOverrides(log: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const block of (log || '').split(OVER).slice(1)) {
    const [bid, props] = (block.split('\n', 1)[0] ?? '').trim().split('|');
    const list = (props ?? '').split(',').filter(Boolean);
    if (bid && list.length) map.set(bid, list);
  }
  return map;
}

/** Parse the G3 style channel (`<STYLE>bid|hcBid|fcBid|shadow|headerStyle|borderStyle|transparency|
 *  visibility|showToolMenu|disableSearch|shownL|shownM|shownS`) into a businessId → NodeStyle map. Rides
 *  the same log on its own marker (parseLayoutNodes/parseOverrides ignore it). Only non-empty fields are
 *  kept — for the flag props an EMPTY field means the type lacks the trait, so absence doubles as the
 *  UI gate. `visibility` is an enum (BMP stringifies "Visibillity.novisible" → enumMember → NOVISIBLE). */
export function parseStyles(log: string): Map<string, NodeStyle> {
  const map = new Map<string, NodeStyle>();
  const bool = (v: string | undefined): boolean | undefined =>
    v === 'true' || v === 'TRUE' ? true : v === 'false' || v === 'FALSE' ? false : undefined;
  for (const block of (log || '').split(STYLE).slice(1)) {
    const [bid, hc, fc, shadow, headerStyle, borderStyle, transp, vis, tools, dSearch, shL, shM, shS] = (block.split('\n', 1)[0] ?? '').trim().split('|');
    if (!bid) continue;
    const s: NodeStyle = {};
    if (hc) s.headerColorBid = hc;
    if (fc) s.fontColorBid = fc;
    if (shadow === 'true' || shadow === 'TRUE') s.shadow = true;
    else if (shadow === 'false' || shadow === 'FALSE') s.shadow = false;
    // BMP stringifies enums prefixed + lowercased ("HeaderStyle.inside", "BorderStyle.line"); enumMember
    // reduces to the bare uppercase member → "INSIDE" / "LINE" / "NONE" (a bare value passes through).
    if (headerStyle) s.headerStyle = enumMember(headerStyle);
    if (borderStyle) s.borderStyle = enumMember(borderStyle);
    if (transp && /^-?\d+$/.test(transp)) s.transparency = parseInt(transp, 10);
    if (vis) s.visibility = enumMember(vis);
    const t = bool(tools); if (t !== undefined) s.showToolMenu = t;
    const d = bool(dSearch); if (d !== undefined) s.disableSearch = d;
    const l = bool(shL); if (l !== undefined) s.shownOnLargeDisplay = l;
    const m2 = bool(shM); if (m2 !== undefined) s.shownOnMediumDisplay = m2;
    const s3 = bool(shS); if (s3 !== undefined) s.shownOnSmallDisplay = s3;
    if (Object.keys(s).length) map.set(bid, s);
  }
  return map;
}

/** First line of a marker block (everything before the first newline), or '' — the shared "one record
 *  per marker occurrence" reader used by every flow channel below. */
const firstLine = (block: string): string => (block.split('\n', 1)[0] ?? '').trim();

/** Parse the flow channels (FLOW_REF / FLOW_META / FLOW_CHILD / FLOW_CPROP / FLOW_TR) into a
 *  businessId → FlowProjection map, keyed by the flow WIDGET's businessId. Each channel rides the same
 *  fetch log on its own marker (the layout / override / style parsers ignore these lines). `shared` is
 *  computed AFTER parsing, client-side, from on-page reference counts — cheap and honest; cross-page
 *  sharing is not probed (rref does not index editPage/inputSet references — verified 2026-07-11). */
export function parseFlows(log: string): Map<string, FlowProjection> {
  const map = new Map<string, FlowProjection>();
  // FLOW_REF — one per flow widget. Fields: owner|ownerRid|ownerClass|kind|refId|refRid|refClass|
  // createMode|actionType|dOAM|dOAT|container|<refName> (refName last, free text).
  for (const block of (log || '').split(FLOW_REF_MARKER).slice(1)) {
    const parts = firstLine(block).split('|');
    if (parts.length < 12) continue;
    const [owner, ownerRid, ownerClass, kind, refId, refRid, refClass, createMode, actionType, dOAM, dOAT, container] = parts;
    if (!owner) continue;
    const refName = parts.length > 12 ? parts.slice(12).join('|') : '';
    const proj: FlowProjection = {
      ownerId: owner, ownerClass: ownerClass || '', kind: (kind || 'plain') as FlowKind,
      ...(ownerRid ? { ownerRid } : {}),
      ...(refId ? { refId } : {}), ...(refRid ? { refRid } : {}), ...(refClass ? { refClass } : {}),
      ...(refName ? { refName } : {}),
      ...(createMode ? { createMode: normalizeBmpEnum(createMode) } : {}),
      ...(actionType ? { actionType: normalizeBmpEnum(actionType) } : {}),
      ...(dOAM ? { displayOnActionMenu: dOAM === 'true' } : {}),
      ...(dOAT ? { displayOnAllTabs: dOAT === 'true' } : {}),
      ...(container ? { container } : {}),
      children: [],
    };
    map.set(owner, proj);
  }
  // FLOW_META — owner|field|<value> (value last). Fills the free-text config fields.
  for (const block of (log || '').split(FLOW_META_MARKER).slice(1)) {
    const parts = firstLine(block).split('|');
    if (parts.length < 3) continue;
    const [owner, field] = parts;
    const value = parts.slice(2).join('|');
    const p = map.get(owner);
    if (!p || !value) continue;
    if (field === 'objectType') p.objectType = value;
    else if (field === 'destExpr') p.destExpr = value;
    else if (field === 'addItem') p.addItem = value;
    else if (field === 'navExpr') p.navExpr = value;
    else if (field === 'actionGroup') p.actionGroup = value;
    else if (field === 'ownerName') p.ownerName = value;
  }
  // FLOW_CHILD — owner|parentChildBid|childBid|childRid|childClass|required|isBreak|dotsCsv|<name>.
  // A record with a non-empty parentChildBid nests under the FlowNode of that bid (a ButtonGroup); the
  // ButtonGroup row is always emitted before its grandchildren, so its node already exists here.
  const byChildBid = new Map<string, FlowNode>(); // per-owner lookup for nesting (bids are page-unique)
  for (const block of (log || '').split(FLOW_CHILD_MARKER).slice(1)) {
    const parts = firstLine(block).split('|');
    if (parts.length < 9) continue;
    const [owner, parentBid, childBid, childRid, childClass, req, brk, dotsCsv] = parts;
    const name = parts.slice(8).join('|');
    const p = map.get(owner);
    if (!p || !childBid) continue;
    const slotBits = (dotsCsv || '').split(',');
    const dots = (FLOW_DOT_PROPS[childClass] ?? []).map(prop => ({
      prop, set: slotBits[FLOW_DOT_SLOTS.indexOf(prop)] === '1',
    }));
    const node: FlowNode = {
      id: childBid, className: childClass || '', name: name || childBid,
      ...(childRid ? { rid: childRid } : {}),
      ...(req === '1' ? { required: true } : {}),
      ...(brk === '1' ? { isBreak: true } : {}),
      ...(dots.length ? { dots } : {}),
    };
    byChildBid.set(childBid, node);
    if (parentBid) {
      const parent = byChildBid.get(parentBid);
      (parent ? (parent.children ??= []) : p.children).push(node);
    } else {
      p.children.push(node);
    }
  }
  // FLOW_CPROP — owner|childBid|<caption> (caption last).
  for (const block of (log || '').split(FLOW_CPROP_MARKER).slice(1)) {
    const parts = firstLine(block).split('|');
    if (parts.length < 3) continue;
    const childBid = parts[1];
    const caption = parts.slice(2).join('|');
    const node = byChildBid.get(childBid);
    if (node && caption) node.prop = caption;
  }
  // FLOW_TR — owner|codeSet|trClass|<transportName>. Read-only transport rows for an ACTION card.
  for (const block of (log || '').split(FLOW_TR_MARKER).slice(1)) {
    const parts = firstLine(block).split('|');
    if (parts.length < 4) continue;
    const [owner, codeSet, trClass] = parts;
    const trName = parts.slice(3).join('|');
    const p = map.get(owner);
    if (!p) continue;
    (p.transports ??= []).push({ className: trClass || '', name: trName || trClass || '', codeSet: codeSet === '1' });
  }
  // On-page sharing: a reference used by more than one flow widget on this page is SHARED.
  const refCount = new Map<string, number>();
  for (const p of map.values()) if (p.refId) refCount.set(p.refId, (refCount.get(p.refId) ?? 0) + 1);
  for (const p of map.values()) if (p.refId && (refCount.get(p.refId) ?? 0) > 1) p.shared = true;
  return map;
}

/** Orphans = widget-ish nodes the reconstruct couldn't place (their owner wasn't a layout node
 *  — typically the scorecard itself, i.e. a widget left on the phantom RESULT tab). Found by
 *  connectivity, AFTER reconstruct, so composite children (placed under their ButtonContainer)
 *  are correctly NOT counted. The tabset root and the grid types are never orphans. */
function findOrphans(nodes: readonly WireNode[], model: LModel): WireNode[] {
  const placed = new Set<string>();
  walk(model, n => { if (n.rid) placed.add(n.rid); });
  return nodes.filter(n =>
    n.type !== 'TabSet' && n.type !== 'Tab' && n.type !== 'Container' && !placed.has(n.rid));
}

/**
 * Build the context probe. Classifies a viewed object into the blueprint root + tabset:
 *  - ENTERPRISE: the object carries a `.template` ref to an EnterpriseTemplate. The instance owns
 *    no widgets (layout is `resolveTemplate().getCard()`), so the page root is the TEMPLATE and the
 *    tabset is the shared `default_tabset`. We key on `.template` ONLY — a Scorecard *instance* has
 *    a `.linkedTo` template too (SharedWebItems reuse) but still owns its own widgets, so `.linkedTo`
 *    must NOT trigger the enterprise path.
 *  - DIRECT: a WebParent that owns its widgets (Scorecard/ModelPage/GRC object). The page root is the
 *    object itself; its tabset is DISCOVERED by walking a widget's cell up to the first TabSet
 *    ancestor (the page exposes no direct `.tabSet`).
 * Emits one line: `<CTX>enterprise|<rid>|<id>|<class>|default_tabset`  OR
 *                 `<CTX>direct|<rid>|<id>|<class>|<tabsetId>`.  (Validated live 2026-06-26.)
 */
/** EC that walks `_a` up its parent chain looking for the first TabSet (recording its id in `_tsid`).
 *  Depth 6 covers a tab + ~5 levels of nested containers — generous vs. real pages (demo's deepest is 3). */
function buildTabsetWalkEc(): string[] {
  const lines: string[] = [];
  for (let i = 0; i < 6; i++) {
    lines.push(`     IF _a.className.whenMissing("") = "TabSet" THEN _tsid := _a.id ELSE _tsid := _tsid ENDIF`);
    lines.push(`     _a := _a.parent`);
  }
  return lines;
}

export function buildContextEc(rid: string): string {
  // Direct branch: find the first child that is actually PLACED (a real, non-RESULT container),
  // then walk that cell up to the first TabSet ancestor. Both guard against the cheap failure
  // modes — an unplaced first child, or deep container nesting.
  return [
    `_probe := lookup(${ecRid(rid)})`,
    // Org redirect: on an Organisation rid, BMP renders its linked enterprise template (caught by the
    // `.template` line below, via the enterprise branch) or, failing that, its first Scorecard/ModelPage
    // child. Resolve that landing page here so Blueprint targets what's actually on screen, not the org
    // container (loading which would walk the whole subtree). First-match pattern mirrors `_cellFound`.
    `IF _probe.className.whenMissing("") = "Organisation" THEN`,
    `     IF _probe.template.rid.whenMissing("") = "" THEN`,
    `          _found := "no"`,
    `          _probe.children().forEach(_c:`,
    `               IF _found = "no" THEN`,
    `                    _cn := _c.className.whenMissing("")`,
    `                    _isPage := "no"`,
    `                    IF _cn = "Scorecard" THEN _isPage := "yes" ELSE _isPage := _isPage ENDIF`,
    `                    IF _cn = "ModelPage" THEN _isPage := "yes" ELSE _isPage := _isPage ENDIF`,
    `                    IF _isPage = "yes" THEN`,
    `                         _probe := _c`,
    `                         _found := "yes"`,
    `                    ELSE`,
    `                         _found := _found`,
    `                    ENDIF`,
    `               ELSE`,
    `                    _found := _found`,
    `               ENDIF`,
    `          )`,
    `     ELSE`,
    `          _probe := _probe`,
    `     ENDIF`,
    `ENDIF`,
    `_tmpl := _probe.template`,
    `_tr := _tmpl.rid.whenMissing("")`,
    `_out := "${CTX}"`,
    `IF _tr <> "" THEN`,
    `     _out := _out + "enterprise|" + _tmpl.rid + "|" + _tmpl.id.whenMissing("") + "|" + _tmpl.className.whenMissing("") + "|${DEFAULT_TABSET}"`,
    `ELSE`,
    `     _cellFound := "no"`,
    `     _cell := _probe`,
    `     _probe.children().forEach(_ch:`,
    `          IF _cellFound = "no" THEN`,
    `               _cc := _ch.container.id.whenMissing("")`,
    `               IF _cc <> "" THEN`,
    `                    IF _cc <> "RESULT" THEN`,
    `                         _cell := _ch.container`,
    `                         _cellFound := "yes"`,
    `                    ELSE`,
    `                         _cellFound := _cellFound`,
    `                    ENDIF`,
    `               ELSE`,
    `                    _cellFound := _cellFound`,
    `               ENDIF`,
    `          ELSE`,
    `               _cellFound := _cellFound`,
    `          ENDIF`,
    `     )`,
    `     _tsid := ""`,
    `     _a := _cell`,
    ...buildTabsetWalkEc(),
    // linkedTo: this instance reuses a template (SharedWebItems). Surface the template's rid + id so the
    // UI can toggle to (and default to) editing the shared template. hasLink drives whether the toggle
    // shows at all.
    `     _link := _probe.linkedTo.rid.whenMissing("")`,
    `     _ltid := _probe.linkedTo.id.whenMissing("")`,
    `     _hasLink := "n"`,
    `     IF _link <> "" THEN _hasLink := "y" ELSE _hasLink := _hasLink ENDIF`,
    // widget count: when no tabset was discovered, this separates an empty/non-page object (0 → not
    // loadable) from a page whose widgets sit on the phantom RESULT tab with no tabset (>0 → we can
    // offer to create one). Without a tabset the object's children are exactly those RESULT widgets.
    `     _wn := 0`,
    `     _probe.children().forEach(_ch:`,
    `          _wn := _wn + 1`,
    `     )`,
    `     _out := _out + "direct|" + _probe.rid + "|" + _probe.id.whenMissing("") + "|" + _probe.className.whenMissing("") + "|" + _tsid + "|" + _hasLink + "|" + output(_wn) + "|" + _link + "|" + _ltid`,
    `ENDIF`,
    `_out`,
  ].join('\n');
}

/** The decoded context-probe line. Keyed by NAME so the emit order in `buildContextEc` and the read here
 *  can't silently drift (the old positional destructure broke whenever a field was inserted/appended). */
interface ContextProbe {
  kind: 'enterprise' | 'direct';
  pageRid: string; pageId: string; pageClass: string; tabsetId: string;
  hasLink: boolean; widgetCount: number;
  templateRid?: string; templateId?: string; // linked template (SharedWebItems), direct branch only
}

/** Decode the single `<CTX>` probe line. Both branches share the leading fields; `direct` carries the
 *  trailing link/template fields (absent → undefined). Returns null when the structural fields are blank. */
function parseContextProbe(line: string): ContextProbe | null {
  const [kind, pRid, pId, pClass, tabsetId, hasLink, wcount, tplRid, tplId] = line.split('|');
  if ((kind !== 'enterprise' && kind !== 'direct') || !pRid || !pId) return null;
  return {
    kind, pageRid: pRid, pageId: pId, pageClass: pClass || '', tabsetId: tabsetId || '',
    hasLink: hasLink === 'y', widgetCount: Number(wcount ?? '0'),
    ...(tplRid ? { templateRid: tplRid } : {}), ...(tplId ? { templateId: tplId } : {}),
  };
}

/** Resolve the blueprint context for a viewed object — see `buildContextEc`. Returns:
 *   - a BlueprintCtx with a discovered tabset (a normal page), or
 *   - a BlueprintCtx flagged `resultOnly` for a direct page that owns widgets but has no dedicated
 *     tabset (loaded through default_tabset + withContent — its widgets sit on the shared Result tab),
 *   - null when it's not an editable page (no tabset AND no widgets, or the probe failed).
 *  The template/instance blast-radius distinction (`.linkedTo`) is recorded via hasTemplate. */
export async function resolvePageContext(io: LayoutIO, rid: string): Promise<BlueprintCtx | null> {
  const res = await io.exec(buildContextEc(rid));
  if (!res.ok || !res.log) return null;
  const line = res.log.split(CTX)[1]?.split('\n', 1)[0]?.trim();
  const p = line ? parseContextProbe(line) : null;
  if (!p) return null;
  // An Organisation only reaches here when it has NO landing page: buildContextEc redirects an org rid
  // to its linked template or first Scorecard/ModelPage child (what BMP actually renders), but an org
  // with neither stays an Organisation. It's not a Blueprint target (loading it would walk the whole
  // subtree), so refuse it — a harmless no-op rather than an org-wide read/edit.
  if (p.pageClass === 'Organisation') return null;
  if (p.kind === 'enterprise') {
    if (!p.tabsetId) return null;
    // The page root IS the shared template; every edit hits all linked instances → high blast radius.
    return {
      pageId: p.pageId, pageRid: p.pageRid, pageClass: (p.pageClass || 'EnterpriseTemplate') as BlueprintCtx['pageClass'],
      tabsetId: p.tabsetId, target: 'template', hasTemplate: true, tabScope: 'withContent',
    };
  }
  // direct: an object that owns its own widgets. Linked template (if any) surfaced so the UI can toggle.
  const tpl = p.hasLink && p.templateRid ? { templateRid: p.templateRid, templateId: p.templateId ?? '' } : {};
  if (!p.tabsetId) {
    // No dedicated tabset. If the object still owns widgets (they sit on the shared Result tab), load it
    // through default_tabset — withContent keeps only the Result tab — and flag it `resultOnly` so the UI
    // offers a "+ Create tabset" affordance (which stages a virtual tabset — see edit.createTabset).
    // An object with no widgets isn't a page.
    return p.widgetCount > 0
      ? {
          pageId: p.pageId, pageRid: p.pageRid, pageClass: (p.pageClass || 'Scorecard') as BlueprintCtx['pageClass'],
          tabsetId: DEFAULT_TABSET, target: 'instance', hasTemplate: p.hasLink,
          // ...tpl carries templateRid/templateId. Without it a result-only INSTANCE lost its
          // template link, so loadPage's `prefer:'template'` redirect never fired and the toggle
          // silently stayed on the instance — every created tab then landed on the instance.
          tabScope: 'withContent', resultOnly: true, ...tpl,
        }
      : null;
  }
  // Owns its widgets → editing is INSTANCE-scoped (low blast radius). hasTemplate records that a linked
  // template exists (the instance reuses it); the default edit target is chosen by the caller's `prefer`.
  return {
    pageId: p.pageId, pageRid: p.pageRid, pageClass: (p.pageClass || 'Scorecard') as BlueprintCtx['pageClass'],
    tabsetId: p.tabsetId, target: 'instance', hasTemplate: p.hasLink, tabScope: 'all', ...tpl,
  };
}

/** Load: fetch the merged layout, reconstruct, and hand back model + an independent baseline. */
export async function loadModel(io: LayoutIO, ctx: BlueprintCtx): Promise<LoadResult> {
  const res = await io.exec(buildFetchEc(ctx));
  if (!res.ok) throw new Error(res.error || 'layout fetch failed');
  const log = res.log ?? '';
  const nodes = parseFetchLog(log);
  const overrides = parseOverrides(log); // F2: per-widget overridden props (instance view → reset arrows)
  const styles = parseStyles(log);       // G3: per-widget current appearance (style mode rendering)
  const flows = parseFlows(log);         // flow projections keyed by flow-widget businessId (read-only)
  const model = reconstruct(nodes, ctx, overrides, styles, flows);
  const baseline = reconstruct(nodes, ctx, overrides, styles, flows); // independent clone — diff target, never mutated
  return { model, baseline, orphans: findOrphans(nodes, model) };
}

/**
 * Apply: diff baseline→desired, compile to one EC program, execute, then RE-FETCH to rebuild
 * the model (real rids replace temp ids; the fresh baseline makes the next apply idempotent).
 * An empty diff short-circuits to a no-op so the UI can disable Apply when nothing changed.
 */
export async function applyModel(io: LayoutIO, baseline: LModel, desired: LModel, ctx: BlueprintCtx): Promise<ApplyResult> {
  // Layout steps + flow steps join ONE plan → ONE compiled EC program → one commit. flowDiff reads only
  // `desired.flowEdits` (staged by businessId), so the layout portion is byte-identical with or without
  // flow data (pitfall #1) and a flow edit staged from two cells compiles once (pitfall #2).
  const layoutPlan = diff(baseline, desired);
  const plan = [...layoutPlan, ...flowDiff(baseline, desired)];
  const { script, notes } = compile(plan, desired);
  if (!plan.length || !script) {
    return { ok: true, noop: true, plan, notes, script: '' };
  }
  // Stale-baseline guard: re-fetch live and confirm the page hasn't drifted from the baseline the
  // user started editing. If someone else changed it, committing our diff could clobber their work
  // (our reorders/deletes reference rids that may have moved). Abort and hand back the fresh state.
  // This narrows but can't close the window: a concurrent edit landing between this fetch and the
  // exec below isn't caught — BMP gives us no cross-call transaction, so the check is best-effort.
  // Flow drift is checked via the projection signature (flow rows live outside the layout diff).
  const live = await loadModel(io, ctx);
  if (diff(baseline, live.model).length > 0 || flowSignature(live.model) !== flowSignature(baseline)) {
    return { ok: false, noop: false, stale: true, plan, notes, script, model: live.model, baseline: live.baseline,
      error: 'The page changed since you started editing. Review the refreshed layout and reapply.' };
  }
  const res = await io.exec(script, true); // commit — the only writing exec in the whole flow
  if (!res.ok) {
    return { ok: false, noop: false, plan, notes, script, error: res.error || 'apply failed' };
  }
  const reloaded = await loadModel(io, ctx);
  // Silent-rollback guard (structural, not log-scraping). The commit is transactional — all steps land
  // or none do — so after a SUCCESSFUL apply of a non-empty plan the re-fetched page MUST differ from
  // the baseline. If it still matches, BMP discarded the transaction and returned ok with no ERROR
  // (the "200 but nothing changed" case). Catch it here rather than letting the UI mark an unchanged
  // page as saved. A reworded/localized rollback message can't slip past this the way a regex could.
  // A PURELY-flow apply changes no layout node, so the layout diff alone would misread success as a
  // rollback — the flow signature covers that half (adds/reorders/flag flips all change it).
  const layoutLanded = diff(baseline, reloaded.model).length > 0;
  const flowLanded = flowSignature(reloaded.model) !== flowSignature(baseline);
  if (!layoutLanded && !flowLanded) {
    return { ok: false, noop: false, plan, notes, script, model: reloaded.model, baseline: reloaded.baseline,
      error: 'BMP discarded the changes. The page is unchanged; reload the page and try again.' };
  }
  return { ok: true, noop: false, plan, notes, script, model: reloaded.model, baseline: reloaded.baseline };
}
