/**
 * Page-context resolution — the single answer to "what object is BMP rendering
 * right now, in what tab". Combines the three providers by authority so every
 * surface (Page tab, footer, Workshop, editor EC `this`) reads one value and
 * can't drift apart.
 *
 * Providers (see investigation in interceptor.ts):
 *   - URL (`?rid=` / `?tabrid=` + active tab anchor) — explicit deep-link
 *     intent. When present it IS the bound object, so it wins for `rid`.
 *   - Fiber (`webParentRid` / `selectedTabRid`) — the rendered ground truth.
 *     The ONLY source on BMP's custom-routed pages (landing pages have no
 *     `?rid=`). Fills `rid` when the URL is silent; always preferred for
 *     `tabRid` because in-app tab clicks don't update the URL.
 *   - DOM is folded into the URL provider (active tab anchor) for now; a
 *     dedicated low-confidence provider can slot in here later without
 *     touching any consumer.
 *
 * Pure function; no I/O. The fiber half is gathered asynchronously by the
 * interceptor and handed in via `fiber`.
 */

import type { PageContext } from './types';

export interface UrlRids {
  rid?: string;
  tabRid?: string;
  tabName?: string;
}

export interface FiberContext {
  rid?: string;
  tabRid?: string;
}

export function resolvePageContext(url: UrlRids, fiber: FiberContext | null | undefined): PageContext {
  // `rid`: explicit URL deep-link wins; fiber fills the gap on routed pages.
  const rid = url.rid ?? fiber?.rid;
  // `tabRid`: fiber is fresher (tab clicks don't touch the URL); URL is the
  // fallback for a deep-link that pinned `?tabrid=`.
  const tabRid = fiber?.tabRid ?? url.tabRid;
  const source: PageContext['source'] = url.rid ? 'url' : (fiber?.rid ? 'fiber' : 'none');
  return { rid, tabRid, tabName: url.tabName, source };
}
