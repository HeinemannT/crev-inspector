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
import { compile } from './ec';
import { validateBusinessId, validateRid, formatEcLiteral } from '../ec-guards';
import { LAYOUT_SEP, parseLayoutNodes } from '../layout-wire';
import type { LayoutNode as WireNode } from '../types';
import type { LModel, PlanNote, PlanStep } from './types';

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

const SEP = LAYOUT_SEP;          // shared wire marker (see layout-wire.ts)
const CTX = '<<<CREV_CTX>>>';
// Shared EC id/rid sanitisation (the same guards the other EC generators use).
const ecBid = validateBusinessId;
const ecRid = validateRid;

/** The shared, system-wide tabset that enterprise-object pages render their template into.
 *  (Verified live: an EnterpriseTemplate's widgets bind to Tabs/Containers under `default_tabset`,
 *  not a dedicated per-page tabset.) */
export const DEFAULT_TABSET = 'default_tabset';

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
    `_ts.descendants().forEach(_n:`,
    `     _r := _r + "${SEP}" + _n.rid + "|" + _n.id.whenMissing("") + "|" + _n.className.whenMissing("") + "|" + _n.parent.rid.whenMissing("") + "||" + ${cols('_n')} + "|" + "|" + _n.name.whenMissing("") + "\\n"`,
    `)`,
    // org model: widgets + composites (recursive). Emit BOTH parent (composite nesting) and container
    // (portal placement). A widget bound to the Result tab keeps that binding so it attaches to the tab
    // emitted above; a widget on the phantom RESULT placement of a no-tabset page still resolves to an
    // org parent and is pruned as an orphan there.
    // Skip ActionButtons flagged displayOnActionMenu — BMP renders those in the page's action MENU, not
    // in the grid, so they're not part of the editable layout (showing them would invent a phantom cell).
    `_sc.descendants().forEach(_w:`,
    `     IF _w.className.whenMissing("") = "ActionButton" AND _w.displayOnActionMenu.whenMissing(false) = true THEN`,
    `          _r := _r`,
    `     ELSE`,
    `          _r := _r + "${SEP}" + _w.rid + "|" + _w.id.whenMissing("") + "|" + _w.className.whenMissing("") + "|" + _w.parent.rid.whenMissing("") + "|" + _w.container.rid.whenMissing("") + "|" + ${cols('_w')} + "|" + _w.chartHeight.whenMissing("") + "|" + _w.name.whenMissing("") + "\\n"`,
    `     ENDIF`,
    `)`,
    `_r`,
  ].join('\n');
}

/** Parse the merged-fetch log into wire nodes — the shared layout wire parser (see layout-wire.ts). */
export const parseFetchLog = parseLayoutNodes;

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
/** Depth of the cell→TabSet ancestor walk in the Direct branch. 6 covers a tab + up to ~5 levels
 *  of nested containers — generous vs. real pages (the demo's deepest is 3). */
const TABSET_WALK_DEPTH = 6;

export function buildContextEc(rid: string): string {
  // Direct branch: find the first child that is actually PLACED (a real, non-RESULT container),
  // then walk that cell up to the first TabSet ancestor. Both guard against the cheap failure
  // modes — an unplaced first child, or deep container nesting.
  const walk: string[] = [];
  for (let i = 0; i < TABSET_WALK_DEPTH; i++) {
    walk.push(`     IF _a.className.whenMissing("") = "TabSet" THEN _tsid := _a.id ELSE _tsid := _tsid ENDIF`);
    walk.push(`     _a := _a.parent`);
  }
  return [
    `_probe := lookup(${ecRid(rid)})`,
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
    ...walk,
    // hasLink: does this instance reuse a template (SharedWebItems)? Drives whether the UI can offer
    // "edit at template level"; the default edit target stays the instance (it owns its widgets).
    `     _link := _probe.linkedTo.rid.whenMissing("")`,
    `     _hasLink := "n"`,
    `     IF _link <> "" THEN _hasLink := "y" ELSE _hasLink := _hasLink ENDIF`,
    // widget count: when no tabset was discovered, this separates an empty/non-page object (0 → not
    // loadable) from a page whose widgets sit on the phantom RESULT tab with no tabset (>0 → we can
    // offer to create one). Without a tabset the object's children are exactly those RESULT widgets.
    `     _wn := 0`,
    `     _probe.children().forEach(_ch:`,
    `          _wn := _wn + 1`,
    `     )`,
    `     _out := _out + "direct|" + _probe.rid + "|" + _probe.id.whenMissing("") + "|" + _probe.className.whenMissing("") + "|" + _tsid + "|" + _hasLink + "|" + output(_wn)`,
    `ENDIF`,
    `_out`,
  ].join('\n');
}

/** A page whose widgets sit on the phantom RESULT tab with no TabSet — not loadable as-is, but we can
 *  offer to create a tabset for it (see `buildCreateTabsetEc`). Carries what that needs. */
export interface NeedsTabset {
  needsTabset: true;
  pageRid: string;
  pageId: string;
  pageClass: BlueprintCtx['pageClass'];
}

/** Resolve the blueprint context for a viewed object — see `buildContextEc`. Returns:
 *   - a BlueprintCtx when the page has a discoverable tabset (loadable),
 *   - a NeedsTabset when it's a direct page with RESULT widgets but no tabset (createable),
 *   - null when it's not an editable page (no tabset AND no widgets, or the probe failed).
 *  The template/instance blast-radius distinction (`.linkedTo`) is recorded via hasTemplate. */
export async function resolvePageContext(io: LayoutIO, rid: string): Promise<BlueprintCtx | NeedsTabset | null> {
  const res = await io.exec(buildContextEc(rid));
  if (!res.ok || !res.log) return null;
  const line = res.log.split(CTX)[1]?.split('\n', 1)[0]?.trim();
  if (!line) return null;
  const [kind, pRid, pId, pClass, tabsetId, hasLink, wcount] = line.split('|');
  if (!pRid || !pId) return null;
  if (kind === 'enterprise') {
    if (!tabsetId) return null;
    // The page root IS the shared template; every edit hits all linked instances → high blast radius.
    return {
      pageId: pId, pageRid: pRid, pageClass: (pClass || 'EnterpriseTemplate') as BlueprintCtx['pageClass'],
      tabsetId, target: 'template', hasTemplate: true, tabScope: 'withContent',
    };
  }
  if (kind === 'direct') {
    if (!tabsetId) {
      // No tabset discovered. If the object still owns widgets (on the RESULT tab), it's a createable
      // page; otherwise it's empty / not a page.
      return Number(wcount ?? '0') > 0
        ? { needsTabset: true, pageRid: pRid, pageId: pId, pageClass: (pClass || 'Scorecard') as BlueprintCtx['pageClass'] }
        : null;
    }
    // The object owns its widgets → editing is INSTANCE-scoped (low blast radius). hasTemplate just
    // records that a linked template exists (the instance reuses it), so the UI can optionally offer
    // template-level edits later; the default target stays the instance.
    return {
      pageId: pId, pageRid: pRid, pageClass: (pClass || 'Scorecard') as BlueprintCtx['pageClass'],
      tabsetId, target: 'instance', hasTemplate: hasLink === 'y', tabScope: 'all',
    };
  }
  return null;
}

/** Type guard: did the resolve land on the "needs a tabset" case? */
export function isNeedsTabset(r: BlueprintCtx | NeedsTabset | null): r is NeedsTabset {
  return !!r && (r as NeedsTabset).needsTabset === true;
}

/**
 * EC that creates a dedicated tabset for a RESULT-only page and moves its widgets onto it:
 *   root.portal → Category "<name>" → TabSet "<name>" → Tab "Main", then every RESULT widget is
 *   re-pointed (container := the new Tab). The Category is a recognisable folder a configurator can
 *   relocate later; BMP autogenerates all ids. Emits `<sep>tsId|tabId|movedCount` for the caller to
 *   build the load context. Verified mechanic live 2026-06-27 (create + bind + ancestor-walk finds it).
 */
export function buildCreateTabsetEc(pageRid: string, name: string): string {
  const sc = `lookup(${ecRid(pageRid)})`;
  const nm = `"${formatEcLiteral(name)}"`;
  return [
    `_sc := ${sc}`,
    `_cat := root.portal.add(Category, name := ${nm})`,
    `_ts := _cat.add(TabSet, name := ${nm})`,
    `_tab := _ts.add(Tab, name := "Main", columnsLargeScreen := 6)`,
    `_n := 0`,
    `_sc.children().forEach(_w:`,
    `     _wc := _w.container.id.whenMissing("RESULT")`,
    `     IF _wc = "RESULT" THEN`,
    `          _w.change(container := _tab)`,
    `          _n := _n + 1`,
    `     ELSE`,
    `          _w := _w`,
    `     ENDIF`,
    `)`,
    `"${SEP}" + _ts.id + "|" + _tab.id + "|" + output(_n)`,
  ].join('\n');
}

/** Run the create-tabset EC, then load the page through its new tabset. Returns the loaded model +
 *  the ctx (so apply/edit works immediately), or null on failure. */
export async function createTabsetAndLoad(io: LayoutIO, page: NeedsTabset, name: string): Promise<{ ctx: BlueprintCtx; load: LoadResult } | null> {
  const res = await io.exec(buildCreateTabsetEc(page.pageRid, name), true); // commit — creates + rebinds
  if (!res.ok || !res.log) return null;
  const row = res.log.split(SEP)[1]?.split('\n', 1)[0]?.trim();
  const tabsetId = row?.split('|')[0];
  if (!tabsetId) return null;
  const ctx: BlueprintCtx = {
    pageId: page.pageId, pageRid: page.pageRid, pageClass: page.pageClass,
    tabsetId, target: 'instance', hasTemplate: false, tabScope: 'all',
  };
  const load = await loadModel(io, ctx);
  return { ctx, load };
}

/** Load: fetch the merged layout, reconstruct, and hand back model + an independent baseline. */
export async function loadModel(io: LayoutIO, ctx: BlueprintCtx): Promise<LoadResult> {
  const res = await io.exec(buildFetchEc(ctx));
  if (!res.ok) throw new Error(res.error || 'layout fetch failed');
  const nodes = parseFetchLog(res.log ?? '');
  const model = reconstruct(nodes, ctx);
  const baseline = reconstruct(nodes, ctx); // independent clone — diff target, never mutated
  return { model, baseline, orphans: findOrphans(nodes, model) };
}

/**
 * Apply: diff baseline→desired, compile to one EC program, execute, then RE-FETCH to rebuild
 * the model (real rids replace temp ids; the fresh baseline makes the next apply idempotent).
 * An empty diff short-circuits to a no-op so the UI can disable Apply when nothing changed.
 */
export async function applyModel(io: LayoutIO, baseline: LModel, desired: LModel, ctx: BlueprintCtx): Promise<ApplyResult> {
  const plan = diff(baseline, desired);
  const { script, notes } = compile(plan, desired);
  if (!plan.length || !script) {
    return { ok: true, noop: true, plan, notes, script: '' };
  }
  // Stale-baseline guard: re-fetch live and confirm the page hasn't drifted from the baseline the
  // user started editing. If someone else changed it, committing our diff could clobber their work
  // (our reorders/deletes reference rids that may have moved). Abort and hand back the fresh state.
  // This narrows but can't close the window: a concurrent edit landing between this fetch and the
  // exec below isn't caught — BMP gives us no cross-call transaction, so the check is best-effort.
  const live = await loadModel(io, ctx);
  if (diff(baseline, live.model).length > 0) {
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
  if (diff(baseline, reloaded.model).length === 0) {
    return { ok: false, noop: false, plan, notes, script, model: reloaded.model, baseline: reloaded.baseline,
      error: 'BMP discarded the changes. The page is unchanged; reload the page and try again.' };
  }
  return { ok: true, noop: false, plan, notes, script, model: reloaded.model, baseline: reloaded.baseline };
}
