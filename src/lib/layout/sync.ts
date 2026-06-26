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
import { reconstruct, walk } from './model';
import type { ReconstructCtx } from './model';
import { diff } from './diff';
import { compile } from './ec';
import { validateBusinessId, validateRid } from '../ec-guards';
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
  // tabset root: no parent, no container, no height (6 trailing empties: parent|container|L|M|S|height).
  const root = `${ts}.rid + "|" + ${ts}.id.whenMissing("") + "|" + ${ts}.name.whenMissing("") + "|" + ${ts}.className.whenMissing("") + "||||||"`;
  return [
    `_ts := ${ts}`,
    `_sc := ${sc}`,
    `_r := ""`,
    `_r := _r + "${SEP}" + ${root} + "\\n"`,
    // grid: tabs + containers — parentRid set, containerRid always empty, no chartHeight (trailing |)
    `_ts.descendants().forEach(_n:`,
    `     _r := _r + "${SEP}" + _n.rid + "|" + _n.id.whenMissing("") + "|" + _n.name.whenMissing("") + "|" + _n.className.whenMissing("") + "|" + _n.parent.rid.whenMissing("") + "||" + ${cols('_n')} + "|" + "\\n"`,
    `)`,
    // org model: widgets + composites (recursive). Emit BOTH parent (composite nesting) and
    // container (portal placement). The phantom RESULT placement collapses to empty so a
    // container-less widget falls through to its org parent.
    `_sc.descendants().forEach(_w:`,
    `     _crid := _w.container.rid.whenMissing("")`,
    `     IF _w.container.id.whenMissing("") = "RESULT" THEN`,
    `          _crid := ""`,
    `     ELSE`,
    `          _crid := _crid`,
    `     ENDIF`,
    `     _r := _r + "${SEP}" + _w.rid + "|" + _w.id.whenMissing("") + "|" + _w.name.whenMissing("") + "|" + _w.className.whenMissing("") + "|" + _w.parent.rid.whenMissing("") + "|" + _crid + "|" + ${cols('_w')} + "|" + _w.chartHeight.whenMissing("") + "\\n"`,
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
    `     _out := _out + "direct|" + _probe.rid + "|" + _probe.id.whenMissing("") + "|" + _probe.className.whenMissing("") + "|" + _tsid + "|" + _hasLink`,
    `ENDIF`,
    `_out`,
  ].join('\n');
}

/** Resolve the blueprint context for a viewed object — see `buildContextEc`. Returns null when the
 *  object isn't an editable page (no tabset discoverable, e.g. an empty Direct page with no widgets
 *  to walk from — a Phase-1 limitation). The template/instance blast-radius distinction (`.linkedTo`)
 *  is deferred to Phase 2; Direct pages default to target='template' per the UX default. */
export async function resolvePageContext(io: LayoutIO, rid: string): Promise<BlueprintCtx | null> {
  const res = await io.exec(buildContextEc(rid));
  if (!res.ok || !res.log) return null;
  const line = res.log.split(CTX)[1]?.split('\n', 1)[0]?.trim();
  if (!line) return null;
  const [kind, pRid, pId, pClass, tabsetId, hasLink] = line.split('|');
  if (!pRid || !pId || !tabsetId) return null; // no tabset discoverable → not loadable
  if (kind === 'enterprise') {
    // The page root IS the shared template; every edit hits all linked instances → high blast radius.
    return {
      pageId: pId, pageRid: pRid, pageClass: (pClass || 'EnterpriseTemplate') as BlueprintCtx['pageClass'],
      tabsetId, target: 'template', hasTemplate: true, tabScope: 'withContent',
    };
  }
  if (kind === 'direct') {
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
  const live = await loadModel(io, ctx);
  if (diff(baseline, live.model).length > 0) {
    return { ok: false, noop: false, stale: true, plan, notes, script, model: live.model, baseline: live.baseline,
      error: 'The page changed since you started editing — review the refreshed layout and reapply.' };
  }
  const res = await io.exec(script, true); // commit — the only writing exec in the whole flow
  if (!res.ok) {
    return { ok: false, noop: false, plan, notes, script, error: res.error || 'apply failed' };
  }
  const reloaded = await loadModel(io, ctx);
  return { ok: true, noop: false, plan, notes, script, model: reloaded.model, baseline: reloaded.baseline };
}
