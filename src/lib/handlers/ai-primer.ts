/**
 * Workspace primer for the chat system prompt (Issue C).
 *
 * On the first chat turn per server, one cheap EC round trip builds a compact
 * map of the live workspace's SHAPE — object counts by class, the top-level
 * organisation units, and the most-used templates. Injected into the cached
 * prefix of the chat system prompt so the model stops guessing class names
 * (e.g. `descendants(Risk)` — there is no Risk class; risks are template-built
 * Task / Scorecard objects) and confusing one object kind for another.
 *
 * Every EC expression here was battle-tested with ec_preview against the live
 * Steadfast workspace before shipping. It uses only the pack's verified
 * vocabulary (no lambda filters, no JS methods): `.map(prop)` group-by,
 * `.as(prop)`, `.distinct()`, `.sortReverse()`, `.substring()`, `.indexOf()`,
 * and the linkedTo→template resolution. Degrades gracefully: any failure
 * returns null and the caller simply omits the <workspace> block.
 */

import type { BmpClient } from '../bmp-client';
import { log } from '../logger';

/** Keep the injected block well under the ~2.5KB budget. */
const PRIMER_CAP = 2400;

/** One EC round trip returning three labelled lines: class counts, top-level
 *  org units, and most-used templates. Uses a single descendants() scan reused
 *  across all three sections. */
const PRIMER_EC = `_all := root.organisation.descendants()
_byClass := _all.map(className)
_classLines := LIST()
_all.as(className).distinct().forEach(_c:
     _classLines := _classLines.union(LIST(str(100000 + _byClass.get(_c).size()) + "|" + _c))
)
_cl := ""
_i := 0
_classLines.sortReverse().forEach(_ln:
     IF _i < 12 THEN
          _bar := _ln.indexOf("|")
          _cl := _cl + _ln.substring(_bar + 1, _ln.size()) + "=" + (num(_ln.substring(0, _bar)) - 100000) + ", "
     ELSE
          _cl := _cl
     ENDIF
     _i := _i + 1
)
_units := ""
_j := 0
root.organisation.children().forEach(_u:
     IF _j < 15 THEN
          _units := _units + _u.name + " (" + _u.id + ", " + _u.className + "); "
     ELSE
          _units := _units
     ENDIF
     _j := _j + 1
)
_templates := LIST()
_all.forEach(_o:
     _t := _o.linkedTo
     IF _t = MISSING THEN _t := _o.template ENDIF
     IF _t != MISSING THEN _templates := _templates.union(LIST(_t)) ENDIF
)
_byId := _templates.map(id)
_tlines := LIST()
_templates.as(id).distinct().forEach(_d:
     _g := _byId.get(_d)
     _tlines := _tlines.union(LIST(str(100000 + _g.size()) + "|" + _g.first().name + " (" + _d + ")"))
)
_tp := ""
_k := 0
_tlines.sortReverse().forEach(_ln:
     IF _k < 12 THEN
          _bar := _ln.indexOf("|")
          _tp := _tp + _ln.substring(_bar + 1, _ln.size()) + " x" + (num(_ln.substring(0, _bar)) - 100000) + "; "
     ELSE
          _tp := _tp
     ENDIF
     _k := _k + 1
)
"objects=" + _all.size() + "\\nclasses: " + _cl + "\\nunits: " + _units + "\\ntemplates(" + _templates.as(id).distinct().size() + " distinct): " + _tp`;

/** Build the workspace primer block, or null if the probe fails / is empty.
 *  Never throws. The returned string is the raw inner text (no wrapper); the
 *  prompt builder wraps it in a <workspace> tag. */
export async function buildWorkspacePrimer(client: BmpClient, signal?: AbortSignal): Promise<string | null> {
  try {
    const res = await client.executeEc(PRIMER_EC, undefined, false, signal);
    if (!res.ok || !res.log) return null;
    const body = res.log.replace(/^\s*Result\s*:\s*/i, '').trim();
    if (!body || !body.includes('objects=')) return null;
    return body.length > PRIMER_CAP ? body.slice(0, PRIMER_CAP) + '\n…(trimmed)' : body;
  } catch (e) {
    log.swallow('ai:primer', e);
    return null;
  }
}
