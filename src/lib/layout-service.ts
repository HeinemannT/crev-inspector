/**
 * layout-service — the imperative shell: binds the pure layout core (`layout/`) to the live
 * `BmpClient` in the service worker. The core stays I/O-free; this is the ONE place that knows
 * about `executeEc`. Handlers call these; tests exercise the core directly with a fake LayoutIO.
 *
 * Two responsibilities beyond plumbing:
 *  - select transactional vs read-only runs (`commit`), and
 *  - SILENT-ROLLBACK detection: BMP can return a 200 / ok result whose log nonetheless says the
 *    transaction was rolled back (no ERROR logType raised). `parseEcResults` only flips `ok` on an
 *    ERROR entry, so on a committing run we additionally scan the log for rollback markers and
 *    downgrade to failure — otherwise an apply that changed nothing would read as success and the
 *    UI would mark a stale model as saved. (Mirrors the webapp's `useBmpSave` log-scan.)
 */
import type { BmpClient } from './bmp-client';
import type { LayoutIO, BlueprintCtx, LoadResult, ApplyResult } from './layout/sync';
import { loadModel, applyModel, resolvePageContext } from './layout/sync';
import type { LModel } from './layout/types';

/** Log phrases BMP emits when a transaction is discarded without raising an ERROR logType. */
const ROLLBACK_RE = /No changes done due to errors|rolled back|transaction (?:was )?discarded/i;

/** Wrap a BmpClient as a LayoutIO. `commit` → transactional executeEc; committing runs get the
 *  silent-rollback guard. */
export function makeLayoutIO(client: BmpClient): LayoutIO {
  return {
    async exec(code: string, commit = false) {
      const r = await client.executeEc(code, undefined, commit);
      if (commit && r.ok && r.log && ROLLBACK_RE.test(r.log)) {
        return { ok: false, log: r.log, error: 'BMP rolled back the transaction — no changes were committed' };
      }
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
