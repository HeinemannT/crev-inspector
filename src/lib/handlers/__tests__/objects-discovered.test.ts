/**
 * OBJECTS_DISCOVERED handler — defence-in-depth rid-shape filter (plan 016).
 * content.ts's crev-interceptor listener already shape-validates
 * (lib/validate-inbound.ts), but this handler is reachable from other
 * message paths too, so it must never trust `msg.objects` verbatim at the
 * cache write site: a forged non-rid-shaped entry must never reach
 * `cache.putAll`.
 */
import { describe, it, expect, vi } from 'vitest';
import { mockChromeStorage } from '../../__tests__/chrome-mock';
import { setSwContext } from '../../sw-context';

function makeHandlerCtx(overrides: any = {}) {
  const panelMessages: any[] = [];
  const activities: Array<{ level: string; message: string }> = [];
  const ctx: any = {
    cache: { get: vi.fn(() => null), put: vi.fn(), putAll: vi.fn(), size: 0 },
    logActivity: vi.fn((level: string, message: string) => activities.push({ level, message })),
    sendToPanel: vi.fn((msg: any) => panelMessages.push(msg)),
    _panelMessages: panelMessages,
    _activities: activities,
    ...overrides,
  };
  return ctx;
}

describe('OBJECTS_DISCOVERED handler', () => {
  it('filters non-rid-shaped entries before cache.putAll', async () => {
    mockChromeStorage();
    const ctx = makeHandlerCtx();
    setSwContext(ctx);

    const { getHandler } = await import('../../handler-registry');
    await import('../objects');
    const entry = getHandler('OBJECTS_DISCOVERED');
    expect(entry).toBeDefined();

    const real = { rid: '8639152947620', name: 'Real', source: 'fiber', discoveredAt: 1, updatedAt: 1 };
    const forged = { rid: '1', name: 'Forged (spoofed cache poison)', source: 'fiber', discoveredAt: 1, updatedAt: 1 };

    await entry!(
      { type: 'OBJECTS_DISCOVERED', objects: [real, forged] } as any,
      () => {},
      { isOneShot: true },
    );

    expect(ctx.cache.putAll).toHaveBeenCalledTimes(1);
    expect(ctx.cache.putAll).toHaveBeenCalledWith([real]);
    expect(ctx._activities.at(-1)?.message).toBe('Found 1 object');
  });

  it('passes through a fully well-formed batch untouched', async () => {
    mockChromeStorage();
    const ctx = makeHandlerCtx();
    setSwContext(ctx);

    const { getHandler } = await import('../../handler-registry');
    await import('../objects');
    const entry = getHandler('OBJECTS_DISCOVERED');

    const objects = [
      { rid: '8639152947620', source: 'fiber', discoveredAt: 1, updatedAt: 1 },
      { rid: '1234567890123', source: 'fiber', discoveredAt: 1, updatedAt: 1 },
    ];

    await entry!({ type: 'OBJECTS_DISCOVERED', objects } as any, () => {}, { isOneShot: true });

    expect(ctx.cache.putAll).toHaveBeenCalledWith(objects);
    expect(ctx._activities.at(-1)?.message).toBe('Found 2 objects');
  });
});
