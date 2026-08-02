import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockChromeStorage } from '../../__tests__/chrome-mock';
import { setSwContext } from '../../sw-context';

const RID = '8123456789012345678';

describe('SELECT_OBJECT handler', () => {
  beforeEach(() => {
    mockChromeStorage();
    (globalThis.chrome as typeof chrome).tabs.query = vi.fn();
    (globalThis.chrome as typeof chrome).sidePanel = {
      open: vi.fn(async () => undefined),
    } as unknown as typeof chrome.sidePanel;
  });

  it('opens detail without retargeting context or starting BMP lookups', async () => {
    const panelMessages: unknown[] = [];
    const client = {
      lookupIdentity: vi.fn(),
      resolveTemplate: vi.fn(),
      fetchChildren: vi.fn(),
    };
    setSwContext({
      client,
      hasPanel: true,
      cache: { get: vi.fn(() => ({ rid: RID, name: 'Risk subtype' })) },
      sendToPanel: vi.fn(message => panelMessages.push(message)),
    } as any);

    const { getHandler } = await import('../../handler-registry');
    await import('../objects');
    const handler = getHandler('SELECT_OBJECT');
    const responses: unknown[] = [];

    await handler!(
      { type: 'SELECT_OBJECT', rid: RID, openPanel: true },
      response => responses.push(response),
      { senderTabId: 42, isOneShot: true },
    );

    expect(responses).toEqual([{ type: 'SELECT_OBJECT', rid: RID }]);
    expect(panelMessages).toEqual([{ type: 'SELECT_OBJECT', rid: RID }]);
    expect(panelMessages).not.toContainEqual(expect.objectContaining({ type: 'CONTEXT_RID_DATA' }));
    expect(client.lookupIdentity).not.toHaveBeenCalled();
    expect(client.resolveTemplate).not.toHaveBeenCalled();
    expect(client.fetchChildren).not.toHaveBeenCalled();
    expect(chrome.tabs.query).not.toHaveBeenCalled();
    expect(chrome.sidePanel.open).toHaveBeenCalledWith({ tabId: 42 });
  });
});

describe('FETCH_OBJECT_PANE handler', () => {
  it('coalesces duplicate RID reads instead of launching overlapping BMP commands', async () => {
    let release: ((value: null) => void) | undefined;
    const request = new Promise<null>(resolve => {
      release = resolve;
    });
    const fetchObjectPane = vi.fn(() => request);
    setSwContext({ client: { fetchObjectPane } } as any);

    const { getHandler } = await import('../../handler-registry');
    await import('../objects');
    const handler = getHandler('FETCH_OBJECT_PANE')!;
    const responses: unknown[] = [];

    const first = handler(
      { type: 'FETCH_OBJECT_PANE', rid: RID },
      response => responses.push(response),
      { isOneShot: true },
    );
    const second = handler(
      { type: 'FETCH_OBJECT_PANE', rid: RID },
      response => responses.push(response),
      { isOneShot: true },
    );

    expect(fetchObjectPane).toHaveBeenCalledTimes(1);
    release?.(null);
    await Promise.all([first, second]);
    expect(responses).toHaveLength(2);
    expect(responses).toEqual([
      expect.objectContaining({ type: 'OBJECT_PANE_DATA', rid: RID, error: 'Object not found' }),
      expect.objectContaining({ type: 'OBJECT_PANE_DATA', rid: RID, error: 'Object not found' }),
    ]);
  });
});
