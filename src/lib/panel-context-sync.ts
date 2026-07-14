/**
 * Resolve and publish the context shown by a window's side panel.
 *
 * The current page is the default. A deliberate object click/right-click takes
 * precedence while the user stays on that page. Navigation clears that
 * explicit selection in the tab listeners / detection handler, so the next
 * resolution naturally follows the new page again.
 */

import { getContextRid, type ContextRidEntry } from './context-rid';
import { resolveTabPageContext } from './page-context-resolver';
import { getCtx } from './sw-context';
import { log } from './logger';

/** Select the current pointer without doing a BMP round trip. */
async function selectedEntry(tabId: number): Promise<ContextRidEntry | undefined> {
  const explicit = getContextRid(tabId);
  if (explicit) return explicit;
  const page = await resolveTabPageContext(tabId);
  return page.rid ? { rid: page.rid } : undefined;
}

/** Fill a sparse page pointer with the same identity the Extended window uses:
 *  cache first, then one lightweight live lookup. */
async function enrichEntry(entry: ContextRidEntry): Promise<ContextRidEntry> {
  const ctx = getCtx();
  const cached = ctx.cache?.get(entry.rid);
  let result: ContextRidEntry = {
    rid: entry.rid,
    name: entry.name ?? cached?.name,
    type: entry.type ?? cached?.type,
    businessId: entry.businessId ?? cached?.businessId,
  };
  if (result.name && result.type && result.businessId) return result;
  if (!ctx.client) return result;
  try {
    const live = await ctx.client.lookupIdentity(entry.rid);
    if (live) {
      result = {
        rid: entry.rid,
        name: result.name ?? live.name,
        type: result.type ?? live.type,
        businessId: result.businessId ?? live.businessId,
      };
    }
  } catch (e) {
    log.swallow('panel-context:identity', e);
  }
  return result;
}

/** Resolve the active pointer and enrich its display identity. Exported for the
 *  GET_CONTEXT_RID handler; callers that publish should use the race-safe send
 *  helper below. */
export async function resolvePanelContextForTab(tabId: number): Promise<ContextRidEntry | undefined> {
  const entry = await selectedEntry(tabId);
  return entry ? enrichEntry(entry) : undefined;
}

/** Publish one tab's context to the panel in that tab's window. Re-check the
 *  selected RID after the asynchronous identity lookup so a slow response from
 *  the previous page can never overwrite a newer navigation/click. */
export async function sendPanelContextForTab(tabId: number): Promise<void> {
  const entry = await resolvePanelContextForTab(tabId);
  const latest = await selectedEntry(tabId);
  if (entry?.rid !== latest?.rid) return;
  getCtx().sendToPanelByTab(tabId, {
    type: 'CONTEXT_RID_DATA',
    rid: entry?.rid,
    name: entry?.name,
    objectType: entry?.type,
    businessId: entry?.businessId,
  });
}
