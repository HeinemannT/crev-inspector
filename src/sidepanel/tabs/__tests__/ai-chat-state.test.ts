/**
 * Tests for the chat-stream reducer: text accumulation, tool start/end pairing,
 * and the terminal semantics the SW contract guarantees — exactly one `done`
 * OR one `error`, and a cancel that produces NEITHER (the tab marks it locally
 * via cancelStream). Late events after a terminal state must be ignored.
 */
import { describe, it, expect } from 'vitest';
import {
  initStream, reduceStream, cancelStream, isTerminal, toAssistantTurn, toolTraceOf,
  prepareRetry, prepareEdit,
} from '../ai-chat-state';
import type { AiChatEvent, AiChatTurn } from '../../../lib/ai/types';

const user = (text: string): AiChatTurn => ({ role: 'user', text });
const assistant = (text: string): AiChatTurn => ({ role: 'assistant', text });
/** The inline error line commitStream appends when a turn errors. */
const errorLine = (text = '⚠ Something went wrong.'): AiChatTurn => ({ role: 'assistant', text });

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

describe('prepareRetry', () => {
  it('drops the reply and resends the same user turn (normal exchange)', () => {
    const u = user('count risks');
    const plan = prepareRetry([u, assistant('here you go')]);
    expect(plan).not.toBeNull();
    expect(plan!.turns).toEqual([]);
    expect(plan!.resend).toBe(u); // exact object — via/quote preserved
  });

  it('keeps the history prefix before the last user turn', () => {
    const turns = [user('q0'), assistant('a0'), user('q1'), assistant('a1')];
    const plan = prepareRetry(turns);
    expect(plan!.turns).toEqual([turns[0], turns[1]]);
    expect(plan!.resend).toBe(turns[2]);
  });

  it('applies to an errored exchange (partial reply + error line removed)', () => {
    const u = user('bad code');
    const plan = prepareRetry([u, assistant('trying…'), errorLine()]);
    expect(plan!.turns).toEqual([]);
    expect(plan!.resend).toBe(u);
  });

  it('applies when the reply is only an error line', () => {
    const u = user('bad code');
    const plan = prepareRetry([u, errorLine('⚠ rate limited')]);
    expect(plan!.resend).toBe(u);
  });

  it('preserves via/quote metadata on a strip turn', () => {
    const u: AiChatTurn = { role: 'user', text: 'fix', via: 'strip', quote: { code: 'x := 1', lines: '12' } };
    const plan = prepareRetry([u, assistant('done')]);
    expect(plan!.resend.via).toBe('strip');
    expect(plan!.resend.quote).toEqual({ code: 'x := 1', lines: '12' });
  });

  it('no-ops on an empty transcript', () => {
    expect(prepareRetry([])).toBeNull();
  });

  it('no-ops mid-stream (last turn is the user, reply not yet committed)', () => {
    expect(prepareRetry([user('q0'), assistant('a0'), user('q1')])).toBeNull();
  });

  it('no-ops when there is no user turn at all', () => {
    expect(prepareRetry([assistant('orphan')])).toBeNull();
  });
});

describe('prepareEdit', () => {
  it('drops the last user turn and its reply, seeding the draft (normal)', () => {
    const u = user('count risks');
    const plan = prepareEdit([u, assistant('here you go')]);
    expect(plan!.turns).toEqual([]);
    expect(plan!.draft).toBe(u);
  });

  it('keeps the history prefix before the edited turn', () => {
    const turns = [user('q0'), assistant('a0'), user('q1'), assistant('a1')];
    const plan = prepareEdit(turns);
    expect(plan!.turns).toEqual([turns[0], turns[1]]);
    expect(plan!.draft).toBe(turns[2]);
  });

  it('applies to an errored exchange', () => {
    const u = user('bad code');
    const plan = prepareEdit([u, errorLine()]);
    expect(plan!.draft).toBe(u);
  });

  it('preserves via/quote metadata so the quoted code stays attached', () => {
    const u: AiChatTurn = { role: 'user', text: 'fix', via: 'strip', quote: { code: 'y := 2', lines: '3-4' } };
    const plan = prepareEdit([u, assistant('done')]);
    expect(plan!.draft.text).toBe('fix');
    expect(plan!.draft.via).toBe('strip');
    expect(plan!.draft.quote).toEqual({ code: 'y := 2', lines: '3-4' });
  });

  it('no-ops on an empty transcript', () => {
    expect(prepareEdit([])).toBeNull();
  });

  it('no-ops mid-stream (last turn is the user)', () => {
    expect(prepareEdit([user('q0'), assistant('a0'), user('q1')])).toBeNull();
  });

  it('does not mutate the input transcript', () => {
    const turns = [user('q'), assistant('a')];
    const snapshot = [...turns];
    prepareEdit(turns);
    expect(turns).toEqual(snapshot);
  });
});
