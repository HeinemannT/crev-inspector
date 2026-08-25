import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openSidePanelFromCommand } from '../side-panel-command';

describe('openSidePanelFromCommand', () => {
  const query = vi.fn();
  const open = vi.fn();

  beforeEach(() => {
    query.mockReset();
    open.mockReset();
    vi.stubGlobal('chrome', {
      tabs: { query },
      sidePanel: { open },
    });
  });

  it('opens Companion on the tab supplied by the command event', async () => {
    open.mockResolvedValue(undefined);

    await expect(openSidePanelFromCommand({ id: 42 })).resolves.toBe(true);

    expect(query).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith({ tabId: 42 });
  });

  it('falls back to the active tab in the last-focused window', async () => {
    query.mockResolvedValue([{ id: 84 }]);
    open.mockResolvedValue(undefined);

    await expect(openSidePanelFromCommand()).resolves.toBe(true);

    expect(query).toHaveBeenCalledWith({ active: true, lastFocusedWindow: true });
    expect(open).toHaveBeenCalledWith({ tabId: 84 });
  });

  it('does nothing when Chrome has no active tab', async () => {
    query.mockResolvedValue([]);

    await expect(openSidePanelFromCommand()).resolves.toBe(false);
    expect(open).not.toHaveBeenCalled();
  });
});
