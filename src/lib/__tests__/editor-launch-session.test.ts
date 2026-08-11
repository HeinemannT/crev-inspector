import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EditorContext } from '../../editor/editor-types';
import { mockChromeStorage } from './chrome-mock';

const context = (rid: string, executionContextRid: string): EditorContext => ({
  environment: 'profile@https://bmp.test',
  instance: { rid, businessId: `widget.${rid}`, type: 'ExtendedTable', name: `Widget ${rid}` },
  template: null,
  instanceCode: { expression: 'output("ok")' },
  templateCode: {},
  overrides: {},
  saveTarget: 'instance',
  property: 'expression',
  executionContextRid,
});

describe('editor launch sessions', () => {
  beforeEach(() => {
    vi.resetModules();
    mockChromeStorage();
    const listeners = new Set<(changes: Record<string, chrome.storage.StorageChange>, area: string) => void>();
    (globalThis.chrome.storage as any).onChanged = {
      addListener: vi.fn((listener) => listeners.add(listener)),
      removeListener: vi.fn((listener) => listeners.delete(listener)),
    };
    const storeSet = globalThis.chrome.storage.session.set.bind(globalThis.chrome.storage.session);
    globalThis.chrome.storage.session.set = vi.fn(async (values: Record<string, unknown>) => {
      const previous = await globalThis.chrome.storage.session.get(Object.keys(values));
      await storeSet(values);
      const changes = Object.fromEntries(Object.entries(values).map(([key, newValue]) => [key, {
        oldValue: previous[key],
        newValue,
      }]));
      for (const listener of listeners) listener(changes, 'session');
    });
  });

  it('isolates overlapping same-RID launches with distinct handoff identities', async () => {
    const {
      beginEditorLaunchSession,
      publishEditorLaunchContext,
    } = await import('../editor-launch-session');

    const first = await beginEditorLaunchSession('42', context('42', '1001'));
    const second = await beginEditorLaunchSession('42', context('42', '2002'));

    expect(first.id).not.toBe(second.id);
    expect(first.storageKey).not.toBe(second.storageKey);
    expect(first.path).not.toBe(second.path);
    expect(first.path).toContain('#42');
    expect(second.path).toContain('#42');

    await publishEditorLaunchContext(first, context('42', '1001'));
    await publishEditorLaunchContext(second, context('42', '2002'));

    const stored = await chrome.storage.session.get([first.storageKey, second.storageKey]);
    expect(stored[first.storageKey]).toMatchObject({
      launchSessionId: first.id,
      executionContextRid: '1001',
      loading: false,
    });
    expect(stored[second.storageKey]).toMatchObject({
      launchSessionId: second.id,
      executionContextRid: '2002',
      loading: false,
    });
  });

  it('validates, consumes, and removes one prepared handoff', async () => {
    const {
      editorSessionStorageKey,
      beginEditorLaunchSession,
      adoptEditorLaunchContext,
      publishEditorLaunchContext,
    } = await import('../editor-launch-session');
    const session = await beginEditorLaunchSession('42', context('42', '1001'));
    await publishEditorLaunchContext(session, context('42', '1001'));

    const consumed = await adoptEditorLaunchContext(session.id, '42');

    expect(consumed).toMatchObject({
      executionContextRid: '1001',
    });
    expect((await chrome.storage.session.get(session.storageKey))[session.storageKey]).toBeUndefined();
    expect((await chrome.storage.session.get(editorSessionStorageKey(session.id)))[editorSessionStorageKey(session.id)]).toMatchObject({
      editorSessionId: session.id,
      executionContextRid: '1001',
    });
  });

  it('joins a preparing handoff and resolves only its matching final context', async () => {
    const {
      adoptEditorLaunchContext,
      beginEditorLaunchSession,
      publishEditorLaunchContext,
    } = await import('../editor-launch-session');
    const session = await beginEditorLaunchSession('42', context('42', '1001'));

    const consuming = adoptEditorLaunchContext(session.id, '42');
    await publishEditorLaunchContext(session, context('42', '1001'));

    await expect(consuming).resolves.toMatchObject({
      executionContextRid: '1001',
    });
  });

  it('restores and updates live editor context without recreating the launch handoff', async () => {
    const {
      adoptEditorLaunchContext,
      beginEditorLaunchSession,
      persistEditorSessionContext,
      publishEditorLaunchContext,
      releaseEditorSessionContext,
      restoreEditorSessionContext,
    } = await import('../editor-launch-session');
    const session = await beginEditorLaunchSession('42', context('42', '1001'));
    await publishEditorLaunchContext(session, context('42', '1001'));
    await adoptEditorLaunchContext(session.id, '42');

    await persistEditorSessionContext(session.id, context('42', '2002'));

    await expect(restoreEditorSessionContext(session.id, '42')).resolves.toMatchObject({
      executionContextRid: '2002',
    });
    expect((await chrome.storage.session.get(session.storageKey))[session.storageKey]).toBeUndefined();

    await releaseEditorSessionContext(session.id);
    await expect(restoreEditorSessionContext(session.id, '42')).resolves.toBeNull();
  });
});
