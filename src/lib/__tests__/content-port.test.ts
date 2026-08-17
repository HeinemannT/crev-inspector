import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InspectorMessage } from '../types';

const mocks = vi.hoisted(() => ({
  queue: [] as InspectorMessage[],
  sendMessage: vi.fn(async () => undefined),
}));

vi.mock('../reconnecting-port', () => ({
  createReconnectingPort: vi.fn((opts: {
    enqueueOnDisconnect?: (queue: InspectorMessage[], msg: InspectorMessage) => void;
  }) => ({
    send: (msg: InspectorMessage) => {
      opts.enqueueOnDisconnect?.(mocks.queue, msg);
      return false;
    },
    destroy: vi.fn(),
  })),
}));

describe('content port disconnected delivery', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.queue.length = 0;
    mocks.sendMessage.mockClear();
    (globalThis as any).chrome = { runtime: { sendMessage: mocks.sendMessage } };
  });

  it('uses one-shot fallback without also replay-queueing state signals', async () => {
    const port = await import('../content-port');
    port.connectPort();
    port.sendToSW({
      type: 'DETECTION_RESULT', isBmp: true, confidence: 1, signals: [],
    });

    expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
    expect(mocks.queue).toHaveLength(0);
  });

  it('still queues mergeable discovery traffic for reconnect', async () => {
    const port = await import('../content-port');
    port.connectPort();
    port.sendToSW({
      type: 'OBJECTS_DISCOVERED',
      objects: [{
        rid: '9007199254740993', type: 'Label', source: 'dom', discoveredAt: 1, updatedAt: 1,
      }],
    });

    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect(mocks.queue).toHaveLength(1);
    expect(mocks.queue[0]?.type).toBe('OBJECTS_DISCOVERED');
  });
});
