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

export function deleteContextRid(tabId: number): void {
  contextRidMap.delete(tabId);
}
