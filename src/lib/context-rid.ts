/**
 * Context RID tracking — maps tab IDs to the last right-clicked BMP object.
 * Used by context menus and the Webpage Inspector tab.
 */

export interface ContextRidEntry {
  rid: string;
  name?: string;
  type?: string;
  businessId?: string;
}

const contextRidMap = new Map<number, ContextRidEntry>();

export function setContextRid(tabId: number, entry: ContextRidEntry): void {
  contextRidMap.set(tabId, entry);
}

export function getContextRid(tabId: number): ContextRidEntry | undefined {
  return contextRidMap.get(tabId);
}

/** Drop only the user's explicit object selection for a tab. Page navigation
 *  uses this before adopting the newly rendered page context; the tab-lifecycle
 *  delete below intentionally clears both stores. */
export function clearContextRid(tabId: number): void {
  contextRidMap.delete(tabId);
}

export function deleteContextRid(tabId: number): void {
  contextRidMap.delete(tabId);
  pageContextMap.delete(tabId);
}

/** Wipe all per-tab context-rid state. Used by the panel "Reset all state"
 *  action so a poisoned context can't survive the user's reset gesture. */
export function clearAllContextRids(): void {
  contextRidMap.clear();
  pageContextMap.clear();
}

// ── Page context (the object BMP is rendering, per tab) ──────────────
//
// Distinct from contextRidMap: that's the user's last RIGHT-CLICK (explicit
// pin); this is the page's bound object, resolved by the content script
// (URL ⊕ React fiber) and reported via PAGE_CONTEXT. The SW caches it so the
// footer (GET_CONTEXT_RID) and the editor's EC `this` (getCurrentPageRid) can
// read the bound object on BMP's custom-routed pages where the URL is blank.
// Right-click context still wins where both exist.

export interface PageContextEntry {
  rid?: string;
  tabRid?: string;
}

const pageContextMap = new Map<number, PageContextEntry>();

export function setPageContext(tabId: number, entry: PageContextEntry): void {
  if (entry.rid || entry.tabRid) pageContextMap.set(tabId, entry);
  else pageContextMap.delete(tabId);
}

export function getPageContext(tabId: number): PageContextEntry | undefined {
  return pageContextMap.get(tabId);
}

/** Drop the cached page context for a tab — called on SPA navigation so a
 *  stale bound object can't outlive the route change (the fresh PAGE_CONTEXT
 *  re-populates it within a round-trip). */
export function deletePageContext(tabId: number): void {
  pageContextMap.delete(tabId);
}
