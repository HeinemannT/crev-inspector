/**
 * sync.ts — the imperative shell's pure orchestration layer (load + apply).
 *
 * The functional core (model/edit/diff/ec) never talks to BMP. This module is the seam:
 * it builds the EC that FETCHES a page's layout and the EC that APPLIES an edit, but it
 * does the actual I/O through an injected `LayoutIO`, so it stays unit-testable and host
 * agnostic (same code path in the service worker and in tests).
 *
 * The two-model split is handled in ONE fetch round trip:
 *   - grid   (Tab + Container tree)  ← `t.<tabsetId>.descendants()`     (portal model)
 *   - widgets (cells' bound content) ← `lookup(<scorecardRid>).children()` (org model)
 * Both are emitted into a single pipe-delimited list in the exact 9-field wire shape that
 * `reconstruct` already consumes (rid|bid|name|type|parentRid|containerRid|L|M|S), so the
 * model layer needs no changes. Verified live against demo scorecard 4957 on 2026-06-26.
 *
 * Apply is diff → compile → exec → RE-FETCH. We never map temp ids to real rids: the
 * re-fetch is the new source of truth, which also makes apply idempotent (a second apply of
 * an already-applied model diffs to an empty plan).
 */
import { reconstruct } from './model';
import type { ReconstructCtx } from './model';
import { diff } from './diff';
import { compile } from './ec';
import type { LayoutNode as WireNode } from '../types';
import type { LModel, PlanNote, PlanStep } from './types';

/** The single I/O capability sync needs: run an EC program, get its log back. Injected so the
 *  service worker can wire it to `bmp-client.executeEc` while tests pass a fake. */
export interface LayoutIO {
  exec(code: string): Promise<{ ok: boolean; log?: string; error?: string }>;
}

/** What `loadModel`/`applyModel` need beyond the reconstruct ctx: the scorecard rid (for the
 *  `lookup()` of the org-model root) on top of the business ids reconstruct already uses. */
export interface BlueprintCtx extends ReconstructCtx {
  /** org-model root rid — resolved with `lookup(rid)` (always present from page context). */
  scorecardRid: string;
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
  plan: PlanStep[];
  notes: PlanNote[];
  /** The compiled EC (empty string on no-op) — handy for a dry-run preview and for logs. */
  script: string;
  /** Re-fetched model + fresh baseline after a successful apply (absent on failure/no-op). */
  model?: LModel;
  baseline?: LModel;
  error?: string;
}

const SEP = '<<<CREV_LAYOUT>>>';
const BID = /^[A-Za-z0-9_]+$/;   // business ids (may start with a digit)
const RID = /^\d+$/;             // rids are Java longs — digits only

function ecBid(id: string): string {
  if (!BID.test(id)) throw new Error(`unsafe EC business id: ${id}`);
  return id;
}
function ecRid(rid: string): string {
  if (!RID.test(rid)) throw new Error(`unsafe EC rid: ${rid}`);
  return rid;
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
  const sc = `lookup(${ecRid(ctx.scorecardRid)})`;
  // emit(node) with explicit parent/container expressions — the 9 fields reconstruct parses.
  const grid = `${ts}.rid + "|" + ${ts}.id.whenMissing("") + "|" + ${ts}.name.whenMissing("") + "|" + ${ts}.className.whenMissing("") + "|||||"`;
  return [
    `_ts := ${ts}`,
    `_sc := ${sc}`,
    `_r := ""`,
    // tabset root (no parent, no container)
    `_r := _r + "${SEP}" + ${grid} + "\\n"`,
    // grid: tabs + containers, parentRid set
    `_ts.descendants().forEach(_n:`,
    `     _r := _r + "${SEP}" + _n.rid + "|" + _n.id.whenMissing("") + "|" + _n.name.whenMissing("") + "|" + _n.className.whenMissing("") + "|" + _n.parent.rid.whenMissing("") + "||" + _n.columnsLargeScreen.whenMissing("") + "|" + _n.columnsMediumScreen.whenMissing("") + "|" + _n.columnsSmallScreen.whenMissing("") + "\\n"`,
    `)`,
    // widgets: org-model children with a container binding, containerRid set
    `_sc.children().forEach(_w:`,
    `     _r := _r + "${SEP}" + _w.rid + "|" + _w.id.whenMissing("") + "|" + _w.name.whenMissing("") + "|" + _w.className.whenMissing("") + "||" + _w.container.rid.whenMissing("") + "|" + _w.columnsLargeScreen.whenMissing("") + "|" + _w.columnsMediumScreen.whenMissing("") + "|" + _w.columnsSmallScreen.whenMissing("") + "\\n"`,
    `)`,
    `_r`,
  ].join('\n');
}

const numOrUndef = (v: string): number | undefined => (v && /^-?\d+$/.test(v) ? parseInt(v, 10) : undefined);

/** Parse the fetch log into wire nodes, partitioning out container-less widgets as orphans. */
export function parseFetchLog(log: string): { nodes: WireNode[]; orphans: WireNode[] } {
  const nodes: WireNode[] = [];
  const orphans: WireNode[] = [];
  const seen = new Set<string>();
  for (const block of log.split(SEP)) {
    const line = block.split('\n', 1)[0].trim();
    if (!line) continue;
    const parts = line.split('|');
    if (parts.length < 9) continue;
    const [rid, bid, name, type, parentRid, containerRid, l, m, s] = parts;
    if (!rid || seen.has(rid)) continue;
    seen.add(rid);
    const node: WireNode = {
      rid,
      businessId: bid || undefined,
      name: name || undefined,
      type: type || 'Unknown',
      parentRid: parentRid || undefined,
      containerRid: containerRid || undefined,
      columnsLargeScreen: numOrUndef(l),
      columnsMediumScreen: numOrUndef(m),
      columnsSmallScreen: numOrUndef(s),
    };
    // a widget (has neither Tab/Container type) without a container binding → RESULT-tab orphan
    const isGrid = type === 'Tab' || type === 'Container' || type === 'TabSet';
    if (!isGrid && !node.containerRid) orphans.push(node);
    else nodes.push(node);
  }
  return { nodes, orphans };
}

/** Load: fetch the merged layout, reconstruct, and hand back model + an independent baseline. */
export async function loadModel(io: LayoutIO, ctx: BlueprintCtx): Promise<LoadResult> {
  const res = await io.exec(buildFetchEc(ctx));
  if (!res.ok) throw new Error(res.error || 'layout fetch failed');
  const { nodes, orphans } = parseFetchLog(res.log ?? '');
  const model = reconstruct(nodes, ctx);
  const baseline = reconstruct(nodes, ctx); // independent clone — diff target, never mutated
  return { model, baseline, orphans };
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
  const res = await io.exec(script);
  if (!res.ok) {
    return { ok: false, noop: false, plan, notes, script, error: res.error || 'apply failed' };
  }
  const reloaded = await loadModel(io, ctx);
  return { ok: true, noop: false, plan, notes, script, model: reloaded.model, baseline: reloaded.baseline };
}
