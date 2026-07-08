/**
 * layout-service — the imperative shell: binds the pure layout core (`layout/`) to the live
 * `BmpClient` in the service worker. The core stays I/O-free; this is the ONE place that knows
 * about `executeEc`. Handlers call these; tests exercise the core directly with a fake LayoutIO.
 *
 * One responsibility beyond plumbing: select transactional vs read-only runs (`commit`).
 *
 * SILENT-ROLLBACK detection lives in `applyModel` (sync.ts), not here. BMP can return a 200 / ok
 * result whose transaction was nonetheless discarded with no ERROR logType. Rather than scrape the
 * log for rollback phrases (brittle — a reworded or localized message slips past), `applyModel`
 * re-fetches after the commit and confirms the page actually changed: a transactional commit is
 * all-or-nothing, so an unchanged page after a non-empty plan IS the rollback. That structural check
 * supersedes the old regex.
 */
import type { BmpClient } from './bmp-client';
import { LAYOUT_EC_TIMEOUT } from './constants';
import type { LayoutIO, BlueprintCtx, NeedsTabset, LoadResult, ApplyResult } from './layout/sync';
import { loadModel, applyModel, resolvePageContext, createTabsetAndLoad } from './layout/sync';
import type { LModel } from './layout/types';
import { validateBusinessId, validateRid } from './ec-guards';
import { log } from './logger';
import {
  buildInstanceFanoutEc, parseInstanceFanout,
  buildContainerBlastEc, parseContainerBlast,
  type InstanceFanout, type ContainerBlast,
} from './layout/blast-radius';

/** Wrap a BmpClient as a LayoutIO. `commit` → transactional executeEc. Layout runs get the wide
 *  LAYOUT_EC_TIMEOUT: the fetch walks every widget of the page (plus override + style channels),
 *  which on a heavy live scorecard legitimately outlives the general 30s EC window. */
/** Per-exec timings collector. Pass an operation-local array so the load/apply
 *  breakdown in the activity log is attributable (call count × duration) without
 *  DevTools. It MUST be operation-local, not a module global: the service worker
 *  interleaves async handlers at every await, so a shared array would let a
 *  concurrent LOAD/APPLY/BLAST wipe or cross-contaminate another op's timings.
 *  Defaults to a throwaway array for callers that don't report timings. */
export function makeLayoutIO(client: BmpClient, timings: string[] = []): LayoutIO {
  return {
    async exec(code: string, commit = false) {
      const t0 = Date.now();
      const r = await client.executeEc(code, undefined, commit, undefined, LAYOUT_EC_TIMEOUT);
      const line = `${Date.now() - t0}ms (commit=${commit}, ${code.length}ch → ${r.log?.length ?? 0}ch)`;
      timings.push(line);
      log.debug('layout:exec', line);
      return { ok: r.ok, log: r.log, error: r.error };
    },
  };
}

/** The outcome of resolving + loading a page: a loaded editor model (possibly flagged `resultOnly`
 *  when the page has no dedicated tabset), or null (not an editable page). */
export type LoadPageResult =
  | { kind: 'page'; ctx: BlueprintCtx; load: LoadResult }
  | null;

/** Resolve context + load the page model for a viewed object rid. A page with no dedicated tabset is
 *  loaded through default_tabset (its widgets on the shared Result tab) and flagged `resultOnly`.
 *
 *  Template default: when the viewed object is an INSTANCE that reuses a linkedTo template
 *  (SharedWebItems), `prefer='template'` (the default) loads the SHARED TEMPLATE's layout instead —
 *  editing it propagates to all instances. The returned ctx carries the toggle state (editingTemplate +
 *  instanceId/templateId) so the chrome can offer [Template | This instance] and reload with
 *  `prefer='instance'` to edit just this page. */
export async function loadPage(client: BmpClient, rid: string, prefer: 'template' | 'instance' = 'template', timings: string[] = []): Promise<LoadPageResult> {
  const io = makeLayoutIO(client, timings);
  const ctx = await resolvePageContext(io, rid);
  if (!ctx) return null;
  if (prefer === 'template' && ctx.templateRid && ctx.templateId) {
    // Redirect to the shared template's own layout, remembering the instance for the toggle + labels.
    const tctx = await resolvePageContext(io, ctx.templateRid);
    if (tctx) {
      const merged: BlueprintCtx = {
        ...tctx, target: 'template', editingTemplate: true,
        templateRid: ctx.templateRid, templateId: ctx.templateId, instanceId: ctx.pageId,
      };
      return { kind: 'page', ctx: merged, load: await loadModel(io, merged) };
    }
    // Template didn't resolve — fall through to editing the instance.
  }
  // Editing the instance directly (or no template). Keep the template info on the ctx so the chrome can
  // still show the toggle and switch to the template.
  const instCtx: BlueprintCtx = { ...ctx, editingTemplate: false, instanceId: ctx.pageId };
  return { kind: 'page', ctx: instCtx, load: await loadModel(io, instCtx) };
}

/** Create a dedicated tabset for a RESULT-only page (moving its widgets onto it), then load it. */
export async function createTabset(client: BmpClient, page: NeedsTabset): Promise<{ ctx: BlueprintCtx; load: LoadResult } | null> {
  return createTabsetAndLoad(makeLayoutIO(client), page);
}

/** Apply an edit: diff baseline→desired, compile, commit, re-fetch. The ctx must be the one
 *  `loadPage` returned for this page (it carries the page root + tabset + tab scope). */
export async function applyPage(client: BmpClient, ctx: BlueprintCtx, baseline: LModel, desired: LModel, timings: string[] = []): Promise<ApplyResult> {
  return applyModel(makeLayoutIO(client, timings), baseline, desired, ctx);
}

/** Apply-preview blast radius (best-effort; an `rref` walk can be slow, so callers fail silently).
 *  (A) fan-out: is `pageId` a template master + how many instances inherit. (B) shared-structure:
 *  for the touched container businessIds, which template-families OUTSIDE this page's own use them.
 *  Returns nulls rather than throwing — the preview just omits the warning if BMP is slow/unhappy. */
export async function loadBlastRadius(
  client: BmpClient, pageId: string, containers: { id: string; rid?: string }[],
): Promise<{ fanout: InstanceFanout | null; blast: ContainerBlast | null }> {
  const io = makeLayoutIO(client);
  let fanout: InstanceFanout | null = null;
  let blast: ContainerBlast | null = null;
  try {
    const fan = await io.exec(buildInstanceFanoutEc(`t.${validateBusinessId(pageId)}`));
    if (fan.ok && fan.log) fanout = parseInstanceFanout(fan.log);
  } catch (e) { log.debug('blast:fanout', e); } // fail silent — no fan-out warning
  // Build a ref per container. A businessId-less container (id === rid) must be addressed by
  // lookup(<rid>), NOT t.<rid> — the same H2 trap the EC compiler avoids (an all-digit rid slips past
  // the businessId validator and t.<rid> doesn't resolve). Invalid entries are dropped.
  const refs = containers.flatMap(c => {
    try {
      return [c.rid && c.id === c.rid ? `lookup(${validateRid(c.rid)})` : `t.${validateBusinessId(c.id)}`];
    } catch { return []; }
  });
  if (fanout && refs.length) {
    try {
      const res = await io.exec(buildContainerBlastEc(refs));
      if (res.ok && res.log) blast = parseContainerBlast(res.log, fanout.ownFamilyKey);
    } catch (e) { log.debug('blast:container', e); } // fail silent — no shared-structure warning
  }
  return { fanout, blast };
}
