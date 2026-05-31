/**
 * Tests for the handler + broadcast registry.
 */
import { describe, it, expect, vi } from 'vitest';
import { subscribe, dispatchBroadcast, register, getHandler } from '../handler-registry';
import type { InspectorMessage } from '../types';

describe('handler-registry — request handlers', () => {
  it('register + getHandler round-trips a single type', () => {
    const handler = vi.fn();
    register('TEST_TYPE_A', handler);
    expect(getHandler('TEST_TYPE_A')).toBe(handler);
  });

  it('register accepts a list of types and binds the same handler to each', () => {
    const handler = vi.fn();
    register(['TEST_TYPE_B', 'TEST_TYPE_C'], handler);
    expect(getHandler('TEST_TYPE_B')).toBe(handler);
    expect(getHandler('TEST_TYPE_C')).toBe(handler);
  });

  it('returns undefined for unknown types', () => {
    expect(getHandler('NOT_A_REAL_TYPE')).toBeUndefined();
  });

  it('later registration replaces the earlier handler', () => {
    const first = vi.fn();
    const second = vi.fn();
    register('TEST_TYPE_REPLACE', first);
    register('TEST_TYPE_REPLACE', second);
    expect(getHandler('TEST_TYPE_REPLACE')).toBe(second);
  });
});

describe('handler-registry — broadcast subscribers', () => {
  it('subscribe + dispatchBroadcast delivers the message to one listener', () => {
    const listener = vi.fn();
    subscribe('BCAST_A', listener);
    const msg = { type: 'BCAST_A' } as unknown as InspectorMessage;
    const count = dispatchBroadcast(msg);
    expect(count).toBe(1);
    expect(listener).toHaveBeenCalledWith(msg);
  });

  it('delivers to multiple listeners for the same type', () => {
    const a = vi.fn();
    const b = vi.fn();
    subscribe('BCAST_MULTI', a);
    subscribe('BCAST_MULTI', b);
    dispatchBroadcast({ type: 'BCAST_MULTI' } as unknown as InspectorMessage);
    expect(a).toHaveBeenCalled();
    expect(b).toHaveBeenCalled();
  });

  it('does not deliver to subscribers of other types', () => {
    const target = vi.fn();
    const other = vi.fn();
    subscribe('BCAST_ME', target);
    subscribe('BCAST_NOT_ME', other);
    dispatchBroadcast({ type: 'BCAST_ME' } as unknown as InspectorMessage);
    expect(target).toHaveBeenCalledOnce();
    expect(other).not.toHaveBeenCalled();
  });

  it('returns 0 when no subscribers exist', () => {
    const count = dispatchBroadcast({ type: 'NOBODY_LISTENING' } as unknown as InspectorMessage);
    expect(count).toBe(0);
  });

  it('a thrown listener does not block subsequent listeners', () => {
    const a = vi.fn(() => { throw new Error('boom'); });
    const b = vi.fn();
    subscribe('BCAST_THROWS', a);
    subscribe('BCAST_THROWS', b);
    expect(() => dispatchBroadcast({ type: 'BCAST_THROWS' } as unknown as InspectorMessage)).not.toThrow();
    expect(b).toHaveBeenCalled();
  });

  it('unsubscribe function removes the listener', () => {
    const listener = vi.fn();
    const unsub = subscribe('BCAST_UNSUB', listener);
    unsub();
    dispatchBroadcast({ type: 'BCAST_UNSUB' } as unknown as InspectorMessage);
    expect(listener).not.toHaveBeenCalled();
  });

  it('subscribing to multiple types attaches the same listener to each', () => {
    const listener = vi.fn();
    subscribe(['BCAST_X', 'BCAST_Y'], listener);
    dispatchBroadcast({ type: 'BCAST_X' } as unknown as InspectorMessage);
    dispatchBroadcast({ type: 'BCAST_Y' } as unknown as InspectorMessage);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
