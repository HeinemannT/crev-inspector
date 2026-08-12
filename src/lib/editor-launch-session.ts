import type { EditorContext } from '../editor/editor-types';

const STORAGE_PREFIX = 'crev_editor_launch_';
const SESSION_STORAGE_PREFIX = 'crev_editor_session_';
const LAUNCH_STALE_AFTER_MS = 5 * 60_000;
const SESSION_STALE_AFTER_MS = 7 * 24 * 60 * 60_000;

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

type StoredEditorSessionContext = EditorContext & {
  editorSessionId: string;
  editorSessionUpdatedAt: number;
};

const makeSessionId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
};

export const editorLaunchStorageKey = (sessionId: string): string =>
  `${STORAGE_PREFIX}${sessionId}`;

export const editorSessionStorageKey = (sessionId: string): string =>
  `${SESSION_STORAGE_PREFIX}${sessionId}`;

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

async function removeStaleEditorContexts(now: number): Promise<void> {
  try {
    const stored = await chrome.storage.session.get(null);
    const stale = Object.entries(stored)
      .filter(([key, value]) => {
        if (key.startsWith(STORAGE_PREFIX)) {
          const createdAt = (value as Partial<LaunchContext> | undefined)?.launchCreatedAt;
          return typeof createdAt === 'number' && createdAt < now - LAUNCH_STALE_AFTER_MS;
        }
        if (key.startsWith(SESSION_STORAGE_PREFIX)) {
          const updatedAt = (value as Partial<StoredEditorSessionContext> | undefined)?.editorSessionUpdatedAt;
          return typeof updatedAt === 'number' && updatedAt < now - SESSION_STALE_AFTER_MS;
        }
        return false;
      })
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
  await removeStaleEditorContexts(createdAt);
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

/** Discard a prepared handoff that was never adopted because the content
 * layer activated an already-live editor instead of mounting this launch. */
export async function releaseEditorLaunchContext(session: EditorLaunchSession): Promise<void> {
  try { await chrome.storage.session.remove(session.storageKey); }
  catch { /* Stale-launch cleanup is retried on the next launch. */ }
}

function plainEditorContext(value: LaunchContext | StoredEditorSessionContext): EditorContext {
  const {
    launchSessionId: _launchSessionId,
    launchCreatedAt: _launchCreatedAt,
    loading: _loading,
    editorSessionId: _editorSessionId,
    editorSessionUpdatedAt: _editorSessionUpdatedAt,
    ...context
  } = value as LaunchContext & Partial<StoredEditorSessionContext>;
  return context;
}

export async function persistEditorSessionContext(
  sessionId: string,
  context: EditorContext,
): Promise<void> {
  await chrome.storage.session.set({
    [editorSessionStorageKey(sessionId)]: {
      ...context,
      editorSessionId: sessionId,
      editorSessionUpdatedAt: Date.now(),
    } satisfies StoredEditorSessionContext,
  });
}

export async function restoreEditorSessionContext(
  sessionId: string,
  rid: string,
): Promise<EditorContext | null> {
  const storageKey = editorSessionStorageKey(sessionId);
  try {
    const stored = (await chrome.storage.session.get(storageKey))[storageKey] as StoredEditorSessionContext | undefined;
    if (stored?.editorSessionId !== sessionId || stored.instance?.rid !== rid) return null;
    return plainEditorContext(stored);
  } catch {
    return null;
  }
}

export async function releaseEditorSessionContext(sessionId: string): Promise<void> {
  try { await chrome.storage.session.remove(editorSessionStorageKey(sessionId)); }
  catch { /* Browser-session expiry remains the final cleanup floor. */ }
}

/** Adopt exactly one prepared context. The handoff is validated, promoted to
 * a separately-lived editor session, and only then removed. */
export async function adoptEditorLaunchContext(
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
    const finish = (value: LaunchContext | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      void (async () => {
        const context = value ? plainEditorContext(value) : null;
        if (context) {
          try { await persistEditorSessionContext(sessionId, context); }
          catch { /* The adopted in-memory context remains usable. */ }
        }
        try { await chrome.storage.session.remove(storageKey); }
        catch { /* Stale-launch cleanup is retried on the next launch. */ }
        resolve(context);
      })();
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
