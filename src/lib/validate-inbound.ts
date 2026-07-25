/**
 * Shape guard for the `crev-interceptor` CustomEvent boundary (plan 016).
 *
 * `interceptor.ts` runs in the page's MAIN world, sharing `document` with the
 * page's own scripts. A compromised or XSS'd BMP page can dispatch
 * `document.dispatchEvent(new CustomEvent('crev-interceptor', { detail }))`
 * indistinguishable from the real interceptor — the listener in `content.ts`
 * had no validation, so a forged payload could poison the shared object
 * cache (`OBJECTS_DISCOVERED`) or pin an attacker-chosen rid as the page's
 * bound object (`PAGE_CONTEXT`).
 *
 * `parseInterceptorMessage` is an ALLOWLIST: only the known `type`s survive,
 * with well-formed fields. Anything else — an unknown `type`, a non-object
 * `detail`, malformed fields — returns `null` and the caller drops the
 * event. A new message `type` added to the interceptor must be added here
 * too, or it will be silently dropped (see plan 016 maintenance notes).
 *
 * Pure function, no I/O — trivially unit-testable.
 */
import type { BmpObject, EditPageContext } from './types';
import { isRidShaped } from './rid-shape';

// Re-exported so existing importers (`handlers/objects.ts`) keep a stable path;
// the definition lives once in `rid-shape.ts`, shared with the MAIN-world producer.
export { isRidShaped };

export type InterceptorMsg =
  | { type: 'OBJECTS_DISCOVERED'; objects: BmpObject[] }
  | { type: 'PAGE_CONTEXT'; rid?: string; tabRid?: string }
  | { type: 'EDIT_PAGE_CONTEXT'; context?: EditPageContext }
  | { type: 'BMP_SIGNALS_RESULT'; signals: string[] };

function hasRidShapedRid(v: unknown): v is { rid: string } {
  return typeof v === 'object' && v !== null && isRidShaped((v as { rid?: unknown }).rid);
}

export function parseInterceptorMessage(detail: unknown): InterceptorMsg | null {
  if (typeof detail !== 'object' || detail === null) return null;
  const d = detail as Record<string, unknown>;

  if (d.type === 'OBJECTS_DISCOVERED') {
    if (!Array.isArray(d.objects)) return null;
    // Defence in depth: drop any entry whose rid isn't rid-shaped rather
    // than rejecting the whole batch — a forged entry mixed into an
    // otherwise-real discovery batch shouldn't poison the legitimate ones.
    const objects = d.objects.filter(hasRidShapedRid) as unknown as BmpObject[];
    return { type: 'OBJECTS_DISCOVERED', objects };
  }

  if (d.type === 'PAGE_CONTEXT') {
    const rid = d.rid;
    const tabRid = d.tabRid;
    if (rid !== undefined && !isRidShaped(rid)) return null;
    if (tabRid !== undefined && !isRidShaped(tabRid)) return null;
    return { type: 'PAGE_CONTEXT', rid: rid as string | undefined, tabRid: tabRid as string | undefined };
  }

  if (d.type === 'EDIT_PAGE_CONTEXT') {
    if (d.context === undefined) return { type: 'EDIT_PAGE_CONTEXT' };
    if (typeof d.context !== 'object' || d.context === null) return null;
    const raw = d.context as Record<string, unknown>;
    if (!isRidShaped(raw.editPageRid)) return null;
    for (const field of ['initializerRid', 'templateRid', 'webParentRid', 'parentRid', 'objectRid'] as const) {
      if (raw[field] !== undefined && !isRidShaped(raw[field])) return null;
    }
    if (raw.objectName !== undefined && typeof raw.objectName !== 'string') return null;
    if (raw.objectType !== undefined && typeof raw.objectType !== 'string') return null;
    return {
      type: 'EDIT_PAGE_CONTEXT',
      context: {
        editPageRid: raw.editPageRid,
        initializerRid: raw.initializerRid as string | undefined,
        templateRid: raw.templateRid as string | undefined,
        webParentRid: raw.webParentRid as string | undefined,
        parentRid: raw.parentRid as string | undefined,
        objectRid: raw.objectRid as string | undefined,
        objectName: raw.objectName as string | undefined,
        objectType: raw.objectType as string | undefined,
      },
    };
  }

  if (d.type === 'BMP_SIGNALS_RESULT') {
    if (!Array.isArray(d.signals) || !d.signals.every(s => typeof s === 'string')) return null;
    return { type: 'BMP_SIGNALS_RESULT', signals: d.signals as string[] };
  }

  return null;
}
