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
import type { LayoutIO, BlueprintCtx, LoadResult, ApplyResult } from './layout/sync';
import { loadModel, applyModel, resolvePageContext } from './layout/sync';
import type { LModel } from './layout/types';
import { validateBusinessId } from './ec-guards';
import {
  buildInstanceFanoutEc, parseInstanceFanout,
  buildContainerBlastEc, parseContainerBlast,
  type InstanceFanout, type ContainerBlast,
} from './layout/blast-radius';

/** Wrap a BmpClient as a LayoutIO. `commit` → transactional executeEc. */
export function makeLayoutIO(client: BmpClient): LayoutIO {
  return {
    async exec(code: string, commit = false) {
      const r = await client.executeEc(code, undefined, commit);
      return { ok: r.ok, log: r.log, error: r.error };
    },
  };
}

/** Resolve context + load the page model for a viewed object rid. Returns null ctx when the object
 *  isn't an editable page (no tabset discoverable). */
export async function loadPage(client: BmpClient, rid: string): Promise<{ ctx: BlueprintCtx; load: LoadResult } | null> {
  const io = makeLayoutIO(client);
  const ctx = await resolvePageContext(io, rid);
  if (!ctx) return null;
  const load = await loadModel(io, ctx);
  return { ctx, load };
}

/** Apply an edit: diff baseline→desired, compile, commit, re-fetch. The ctx must be the one
 *  `loadPage` returned for this page (it carries the page root + tabset + tab scope). */
export async function applyPage(client: BmpClient, ctx: BlueprintCtx, baseline: LModel, desired: LModel): Promise<ApplyResult> {
  return applyModel(makeLayoutIO(client), baseline, desired, ctx);
}

/** Apply-preview blast radius (best-effort; an `rref` walk can be slow, so callers fail silently).
 *  (A) fan-out: is `pageId` a template master + how many instances inherit. (B) shared-structure:
 *  for the touched container businessIds, which template-families OUTSIDE this page's own use them.
 *  Returns nulls rather than throwing — the preview just omits the warning if BMP is slow/unhappy. */
export async function loadBlastRadius(
  client: BmpClient, pageId: string, containerBids: string[],
): Promise<{ fanout: InstanceFanout | null; blast: ContainerBlast | null }> {
  const io = makeLayoutIO(client);
  let fanout: InstanceFanout | null = null;
  let blast: ContainerBlast | null = null;
  try {
    const fan = await io.exec(buildInstanceFanoutEc(`t.${validateBusinessId(pageId)}`));
    if (fan.ok && fan.log) fanout = parseInstanceFanout(fan.log);
  } catch { /* fail silent — no fan-out warning */ }
  const refs = containerBids.filter(b => { try { validateBusinessId(b); return true; } catch { return false; } });
  if (fanout && refs.length) {
    try {
      const res = await io.exec(buildContainerBlastEc(refs.map(b => `t.${b}`)));
      if (res.ok && res.log) blast = parseContainerBlast(res.log, fanout.ownFamilyKey);
    } catch { /* fail silent — no shared-structure warning */ }
  }
  return { fanout, blast };
}
