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

function parseEditPageFields(value: unknown): EditPageContext['fields'] | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 500) return null;
  const fields: NonNullable<EditPageContext['fields']> = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) return null;
    const raw = entry as Record<string, unknown>;
    for (const key of ['key', 'pageIndex', 'columnIndex'] as const) {
      const index = raw[key];
      if (index !== undefined && (
        typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= 10_000
      )) return null;
    }
    if (
      raw.kind !== undefined
      && raw.kind !== 'field'
      && raw.kind !== 'info'
    ) return null;
    for (const key of ['propertyRef', 'objectRef', 'displayName'] as const) {
      const text = raw[key];
      if (text !== undefined && (typeof text !== 'string' || text.length > 500)) return null;
    }
    if (raw.objectRef !== undefined && !isRidShaped(raw.objectRef)) return null;
    fields.push({
      kind: raw.kind as 'field' | 'info' | undefined,
      key: raw.key as number | undefined,
      propertyRef: raw.propertyRef as string | undefined,
      objectRef: raw.objectRef as string | undefined,
      displayName: raw.displayName as string | undefined,
      pageIndex: raw.pageIndex as number | undefined,
      columnIndex: raw.columnIndex as number | undefined,
    });
  }
  return fields;
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
    const fields = parseEditPageFields(raw.fields);
    if (fields === null) return null;
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
        ...(fields === undefined ? {} : { fields }),
      },
    };
  }

  if (d.type === 'BMP_SIGNALS_RESULT') {
    if (!Array.isArray(d.signals) || !d.signals.every(s => typeof s === 'string')) return null;
    return { type: 'BMP_SIGNALS_RESULT', signals: d.signals as string[] };
  }

  return null;
}
