/**
 * Workspace primer for the chat system prompt (Issue C).
 *
 * On the first chat turn per server, one cheap EC round trip builds a compact
 * map of the top-level organisation entries. Injected into the cached prefix
 * of the chat system prompt so the model has real workspace vocabulary without
 * an automatic whole-workspace scan.
 *
 * The EC expression was verified with ec_preview before shipping. It uses only
 * the pack's verified
 * vocabulary. Degrades gracefully: ordinary probe failures return null and
 * the caller omits the <workspace> block. Cancellation is propagated so it can
 * never become a cacheable negative result.
 */

import type { BmpClient } from '../bmp-client';
import { log } from '../logger';

/** Keep the injected block well under the ~2.5KB budget. */
const PRIMER_CAP = 2400;

/** One bounded EC round trip over root.organisation's immediate children.
 *  Do not use descendants() here: chat startup must stay constant-work on a
 *  workspace with hundreds of thousands of objects. Deeper discovery belongs
 *  to the explicit, capped query_context tool. */
const PRIMER_EC = `_top := root.organisation.children()
_units := ""
_shown := 0
_top.forEach(_u:
     IF _shown < 15 THEN
          _units := _units + _u.name + " (" + _u.id + ", " + _u.className + "); "
     ELSE
          _units := _units
     ENDIF
     _shown := _shown + 1
)
"top-level=" + _top.size() + "\\nunits: " + _units`;

/** Build the workspace primer block, or null if an ordinary probe fails or is
 * empty. Cancellation is rethrown. The returned string is the raw inner text
 * (no wrapper); the prompt builder wraps it in a <workspace> tag. */
export async function buildWorkspacePrimer(client: BmpClient, signal?: AbortSignal): Promise<string | null> {
  try {
    const res = await client.executeEc(PRIMER_EC, undefined, false, signal);
    if (!res.ok || !res.log) return null;
    const body = res.log.replace(/^\s*Result\s*:\s*/i, '').trim();
    if (!body || !body.includes('top-level=')) return null;
    const scope = '\nscope: bounded top-level root.organisation preview only; use query_context for deeper live counts and filters';
    const primer = body + scope;
    return primer.length > PRIMER_CAP ? primer.slice(0, PRIMER_CAP) + '\n…(trimmed)' : primer;
  } catch (e) {
    if (signal?.aborted || (e instanceof DOMException && e.name === 'AbortError')) throw e;
    log.swallow('ai:primer', e);
    return null;
  }
}
