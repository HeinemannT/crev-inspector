import type { EditorContext } from '../editor/editor-types';

const STORAGE_PREFIX = 'crev_editor_launch_';
const STALE_AFTER_MS = 5 * 60_000;

export interface EditorLaunchSession {
  id: string;
  rid: string;
  storageKey: string;
  path: string;
  createdAt: number;
}

type LaunchContext = EditorContext & {
  launchSessionId: string;
  launchCreatedAt: number;
  loading: boolean;
};

const makeSessionId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
};

export const editorLaunchStorageKey = (sessionId: string): string =>
  `${STORAGE_PREFIX}${sessionId}`;

const launchContext = (
  session: EditorLaunchSession,
  context: EditorContext,
  loading: boolean,
): LaunchContext => ({
  ...context,
  launchSessionId: session.id,
  launchCreatedAt: session.createdAt,
  loading,
});

async function removeStaleLaunches(now: number): Promise<void> {
  try {
    const stored = await chrome.storage.session.get(null);
    const stale = Object.entries(stored)
      .filter(([key, value]) => key.startsWith(STORAGE_PREFIX)
        && typeof (value as Partial<LaunchContext> | undefined)?.launchCreatedAt === 'number'
        && (value as LaunchContext).launchCreatedAt < now - STALE_AFTER_MS)
      .map(([key]) => key);
    if (stale.length > 0) await chrome.storage.session.remove(stale);
  } catch {
    // Session storage is an optimization around launch handoff. A failed
    // cleanup must not block opening the editor.
  }
}

/** Start one cold editor handoff. Resource identity is deliberately absent:
 * several launch sessions may address the same draft-preserving editor. */
export async function beginEditorLaunchSession(
  rid: string,
  placeholder: EditorContext,
): Promise<EditorLaunchSession> {
  const createdAt = Date.now();
  await removeStaleLaunches(createdAt);
  const id = makeSessionId();
  const session: EditorLaunchSession = {
    id,
    rid,
    storageKey: editorLaunchStorageKey(id),
    path: `editor/editor.html?launch=${encodeURIComponent(id)}#${encodeURIComponent(rid)}`,
    createdAt,
  };
  await chrome.storage.session.set({
    [session.storageKey]: launchContext(session, placeholder, true),
  });
  return session;
}

export async function publishEditorLaunchContext(
  session: EditorLaunchSession,
  context: EditorContext,
): Promise<void> {
  if (context.instance.rid !== session.rid) {
    throw new Error(`Editor launch ${session.id} prepared the wrong RID`);
  }
  await chrome.storage.session.set({
    [session.storageKey]: launchContext(session, context, false),
  });
}

export async function failEditorLaunchContext(
  session: EditorLaunchSession,
  placeholder: EditorContext,
  message: string,
): Promise<void> {
  await chrome.storage.session.set({
    [session.storageKey]: launchContext(session, {
      ...placeholder,
      loadError: message,
    }, false),
  });
}

/** Consume exactly one prepared context. The session id and RID are both
 * validated before the iframe adopts it, then the handoff is removed. */
export async function consumeEditorLaunchContext(
  sessionId: string,
  rid: string,
  timeoutMs = 20_000,
): Promise<EditorContext | null> {
  const storageKey = editorLaunchStorageKey(sessionId);
  return new Promise((resolve) => {
    let settled = false;
    let latest: LaunchContext | null = null;
    const cleanup = () => {
      clearTimeout(timeout);
      chrome.storage.onChanged.removeListener(onChanged);
    };
    const finish = (value: EditorContext | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      void chrome.storage.session.remove(storageKey);
      resolve(value);
    };
    const accept = (value: LaunchContext | undefined) => {
      if (!value) return;
      if (value.launchSessionId !== sessionId || value.instance?.rid !== rid) {
        finish(null);
        return;
      }
      latest = value;
      if (!value.loading) finish(value);
    };
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => {
      if (areaName !== 'session') return;
      accept(changes[storageKey]?.newValue as LaunchContext | undefined);
    };
    const timeout = setTimeout(() => {
      finish(latest
        ? { ...latest, loading: false, loadError: 'Timed out while loading editor context' }
        : null);
    }, timeoutMs);

    chrome.storage.onChanged.addListener(onChanged);
    void chrome.storage.session.get(storageKey).then(result => {
      accept(result[storageKey] as LaunchContext | undefined);
    }).catch(() => finish(null));
  });
}
