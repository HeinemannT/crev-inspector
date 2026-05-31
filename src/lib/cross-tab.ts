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
window.addEventListener('storage', (e) => {
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
});
