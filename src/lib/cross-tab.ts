/**
 * Cross-tab synchronization via localStorage storage events.
 * The `storage` event only fires in OTHER tabs (built-in browser behavior).
 */

type SyncHandler = (data: unknown) => void;

const handlers = new Map<string, SyncHandler[]>();

/** Broadcast data to other tabs on the given channel */
export function broadcast(channel: string, data: unknown) {
  try {
    localStorage.setItem(channel, JSON.stringify({ data, ts: Date.now() }));
  } catch {
    // localStorage may be unavailable (e.g. in incognito)
  }
}

/** Register a handler for sync events from other tabs */
export function onSync(channel: string, handler: SyncHandler) {
  let list = handlers.get(channel);
  if (!list) {
    list = [];
    handlers.set(channel, list);
  }
  list.push(handler);
}

// Single global listener that dispatches to registered handlers
function onStorageEvent(e: StorageEvent) {
  if (!e.key || !e.newValue) return;
  const list = handlers.get(e.key);
  if (!list || list.length === 0) return;
  try {
    const parsed = JSON.parse(e.newValue);
    for (const handler of list) {
      handler(parsed.data);
    }
  } catch {
    // Ignore malformed data
  }
}
window.addEventListener('storage', onStorageEvent);

/** Detach the global storage listener and drop all registered handlers.
 *  Called by the content-script re-injection teardown so a stale instance's
 *  onSync subscriptions don't keep re-rendering overlays alongside the
 *  fresh instance (each re-injection otherwise leaks a new closure over its
 *  own ContentState). */
export function teardownCrossTab(): void {
  window.removeEventListener('storage', onStorageEvent);
  handlers.clear();
}
