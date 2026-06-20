/**
 * SW-side page-context resolution.
 *
 * The content script resolves page context with `resolvePageContext()` (the
 * pure rule in page-context.ts) from the DOM URL + the React fiber. The SW has
 * no DOM, but the same question — "what object is this tab rendering" — is
 * asked by the footer (GET_CONTEXT_RID), the editor's EC execution `this`
 * (getCurrentPageRid), and the Extended Code console.
 *
 * This module answers it with the SAME rule, fed by the SW's two inputs: the
 * per-tab fiber cache (populated from the content script's PAGE_CONTEXT) and
 * the tab's address-bar `?rid=`/`?tabrid=`. One implementation, so the SW
 * surfaces can't drift from the Page tab.
 */

import { getPageContext } from './context-rid';
import { resolvePageContext, type UrlRids } from './page-context';
import type { PageContext } from './types';

/** Read the tab's `?rid=` / `?tabrid=` from the address bar. The SW has no
 *  active-tab-anchor (that's a DOM signal the content script folds in), so this
 *  is the URL provider's SW half. Only BMP-shaped rids (Java long: digits,
 *  optionally negative) pass — a foreign tab whose URL carries `?rid=foo` must
 *  not bind a coincidental object or break `BigInt()` downstream. */
async function urlRidsForTab(tabId: number): Promise<UrlRids> {
  try {
    if (typeof chrome === 'undefined' || !chrome.tabs?.get) return {};
    const tab = await chrome.tabs.get(tabId);
    if (!tab?.url) return {};
    const p = new URL(tab.url).searchParams;
    const rid = p.get('rid');
    const tabRid = p.get('tabrid') ?? p.get('tabRid');
    return {
      rid: rid && /^-?\d+$/.test(rid) ? rid : undefined,
      tabRid: tabRid && /^-?\d+$/.test(tabRid) ? tabRid : undefined,
    };
  } catch {
    return {};
  }
}

/** The bound object + active tab for a given tab, via the shared priority rule
 *  (URL deep-link wins for `rid`; fiber fills the gap and owns `tabRid`).
 *  Defensive: never throws. */
export async function resolveTabPageContext(tabId: number): Promise<PageContext> {
  const fiber = getPageContext(tabId) ?? null;
  const url = await urlRidsForTab(tabId);
  return resolvePageContext(url, fiber);
}
