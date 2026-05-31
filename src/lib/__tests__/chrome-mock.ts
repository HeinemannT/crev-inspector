import { vi } from 'vitest';

/** Read helper that mirrors chrome.storage.* — supports string,
 *  string[], object (defaults), or null (return all). */
function readShape(store: Record<string, any>, key: string | string[] | Record<string, unknown> | null) {
  if (key === null || key === undefined) {
    return { ...store };
  }
  if (Array.isArray(key)) {
    const out: Record<string, any> = {};
    for (const k of key) out[k] = store[k];
    return out;
  }
  if (typeof key === 'object') {
    const out: Record<string, any> = { ...key };
    for (const k of Object.keys(key)) if (k in store) out[k] = store[k];
    return out;
  }
  return { [key]: store[key] };
}

/** Set up a minimal chrome.* global mock for service worker tests */
export function mockChromeStorage() {
  const store: Record<string, any> = {};
  const localStore: Record<string, any> = {};
  globalThis.chrome = {
    storage: {
      session: {
        get: vi.fn(async (key: any) => readShape(store, key)),
        set: vi.fn(async (obj: Record<string, any>) => { Object.assign(store, obj); }),
        remove: vi.fn(async (key: string | string[]) => {
          const keys = Array.isArray(key) ? key : [key];
          for (const k of keys) delete store[k];
        }),
      },
      local: {
        get: vi.fn(async (key: any) => readShape(localStore, key)),
        set: vi.fn(async (obj: Record<string, any>) => { Object.assign(localStore, obj); }),
        remove: vi.fn(async (key: string | string[]) => {
          const keys = Array.isArray(key) ? key : [key];
          for (const k of keys) delete localStore[k];
        }),
      },
    },
    action: {
      setBadgeText: vi.fn(async () => {}),
      setBadgeBackgroundColor: vi.fn(async () => {}),
    },
    tabs: { query: vi.fn() },
    runtime: { lastError: null },
  } as any;
  return store;
}
