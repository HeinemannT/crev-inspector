/**
 * Tests for the chat-stream reducer: text accumulation, tool start/end pairing,
 * and the terminal semantics the SW contract guarantees — exactly one `done`
 * OR one `error`, and a cancel that produces NEITHER (the tab marks it locally
 * via cancelStream). Late events after a terminal state must be ignored.
 */
import { describe, it, expect } from 'vitest';
import {
  initStream, reduceStream, cancelStream, isTerminal, toAssistantTurn, toolTraceOf,
} from '../ai-chat-state';
import type { AiChatEvent } from '../../../lib/ai/types';

function run(events: AiChatEvent[]) {
  let s = initStream();
  for (const ev of events) s = reduceStream(s, ev);
  return s;
}

describe('reduceStream', () => {
  it('accumulates text deltas in order', () => {
    const s = run([
      { kind: 'text-delta', delta: 'Hello ' },
      { kind: 'text-delta', delta: 'world' },
    ]);
    expect(s.text).toBe('Hello world');
    expect(s.status).toBe('streaming');
  });

  it('tracks tool start → end with ok/err status', () => {
    const s = run([
      { kind: 'tool-start', name: 'read_object', summary: 'v_impact' },
      { kind: 'tool-end', name: 'read_object', summary: 'v_impact · 6 properties', ok: true },
      { kind: 'tool-start', name: 'preview_ec', summary: 'dry run' },
      { kind: 'tool-end', name: 'preview_ec', summary: 'syntax error', ok: false },
    ]);
    expect(s.tools).toEqual([
      { name: 'read_object', summary: 'v_impact · 6 properties', status: 'ok' },
      { name: 'preview_ec', summary: 'syntax error', status: 'err' },
    ]);
  });

  it('resolves the most recent pending call when the same tool runs twice', () => {
    const s = run([
      { kind: 'tool-start', name: 'search', summary: 'a' },
      { kind: 'tool-start', name: 'search', summary: 'b' },
      { kind: 'tool-end', name: 'search', summary: 'b done', ok: true },
    ]);
    expect(s.tools[0].status).toBe('pending');
    expect(s.tools[1]).toEqual({ name: 'search', summary: 'b done', status: 'ok' });
  });

  it('one done event terminates the stream', () => {
    const s = run([{ kind: 'text-delta', delta: 'x' }, { kind: 'done' }]);
    expect(s.status).toBe('done');
    expect(isTerminal(s)).toBe(true);
  });

  it('one error event terminates with the message', () => {
    const s = run([{ kind: 'error', message: 'rate limited' }]);
    expect(s.status).toBe('error');
    expect(s.error).toBe('rate limited');
    expect(isTerminal(s)).toBe(true);
  });

  it('ignores events after a terminal state (late duplicate done/error)', () => {
    const done = run([{ kind: 'text-delta', delta: 'a' }, { kind: 'done' }]);
    const after = reduceStream(reduceStream(done, { kind: 'text-delta', delta: 'b' }), { kind: 'error', message: 'x' });
    expect(after).toBe(done); // same object, untouched
    expect(after.text).toBe('a');
    expect(after.status).toBe('done');
  });

  it('does not mutate the input state', () => {
    const s0 = initStream();
    const s1 = reduceStream(s0, { kind: 'text-delta', delta: 'x' });
    expect(s0.text).toBe('');
    expect(s1.text).toBe('x');
  });
});

describe('cancelStream (no terminal event arrives)', () => {
  it('marks a streaming state cancelled and freezes it', () => {
    const s = cancelStream(run([{ kind: 'text-delta', delta: 'partial' }]));
    expect(s.status).toBe('cancelled');
    expect(isTerminal(s)).toBe(true);
    // Any stray late event is ignored.
    expect(reduceStream(s, { kind: 'done' })).toBe(s);
  });

  it('is a no-op on an already-terminal stream', () => {
    const done = run([{ kind: 'done' }]);
    expect(cancelStream(done)).toBe(done);
  });
});

describe('toAssistantTurn', () => {
  it('freezes text + display tool trace into a transcript turn', () => {
    const s = run([
      { kind: 'tool-start', name: 'read_object', summary: 'x' },
      { kind: 'tool-end', name: 'read_object', summary: 'x · ok', ok: true },
      { kind: 'text-delta', delta: 'Answer.' },
      { kind: 'done' },
    ]);
    expect(toAssistantTurn(s)).toEqual({
      role: 'assistant',
      text: 'Answer.',
      toolTrace: [{ name: 'read_object', summary: 'x · ok', ok: true }],
    });
  });

  it('omits toolTrace when no tools ran', () => {
    const s = run([{ kind: 'text-delta', delta: 'hi' }, { kind: 'done' }]);
    expect(toAssistantTurn(s)).toEqual({ role: 'assistant', text: 'hi' });
    expect(toolTraceOf(s)).toEqual([]);
  });

  it('carries per-call ok status into the trace (✕ on a failed call)', () => {
    const s = run([
      { kind: 'tool-start', name: 'read_object', summary: 'a' },
      { kind: 'tool-end', name: 'read_object', summary: 'a · ok', ok: true },
      { kind: 'tool-start', name: 'preview_ec', summary: 'b' },
      { kind: 'tool-end', name: 'preview_ec', summary: 'b · syntax error', ok: false },
      { kind: 'done' },
    ]);
    expect(toolTraceOf(s)).toEqual([
      { name: 'read_object', summary: 'a · ok', ok: true },
      { name: 'preview_ec', summary: 'b · syntax error', ok: false },
    ]);
  });

  it('keeps partial text from a cancelled stream', () => {
    const s = cancelStream(run([{ kind: 'text-delta', delta: 'part' }]));
    expect(toAssistantTurn(s).text).toBe('part');
  });
});
