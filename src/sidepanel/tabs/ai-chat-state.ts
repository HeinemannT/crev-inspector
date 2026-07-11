/**
 * Pure state machine for one streaming AI chat reply. The AI tab owns a
 * transcript of committed turns plus (while a request is in flight) one
 * `StreamState` that accumulates text-delta / tool-start / tool-end events.
 *
 * Terminal semantics mirror the SW contract exactly:
 *   - exactly one `done`  → status 'done'
 *   - exactly one `error` → status 'error'
 *   - a cancel produces NEITHER event; the tab calls `cancelStream` locally.
 *
 * Kept dependency-free (no DOM) so the reducer is unit-testable in isolation.
 */

import type { AiChatEvent, AiChatTurn, AiChatToolTrace } from '../../lib/ai/types';
import { scrubToolMarkup } from '../../lib/ai/scrub';

export type ToolStatus = 'pending' | 'ok' | 'err';

export interface ToolLine {
  name: string;
  summary: string;
  status: ToolStatus;
}

export type StreamStatus = 'streaming' | 'done' | 'error' | 'cancelled';

export interface StreamState {
  text: string;
  tools: ToolLine[];
  status: StreamStatus;
  /** Present only when status === 'error'. */
  error?: string;
}

export function initStream(): StreamState {
  return { text: '', tools: [], status: 'streaming' };
}

/** Apply one streaming event, returning a NEW state (never mutates the input).
 *  Events after a terminal state are ignored — the contract guarantees exactly
 *  one terminal event, but a late duplicate must not corrupt the transcript. */
export function reduceStream(s: StreamState, ev: AiChatEvent): StreamState {
  if (s.status !== 'streaming') return s;
  switch (ev.kind) {
    case 'text-delta':
      return { ...s, text: s.text + ev.delta };
    case 'tool-start':
      return { ...s, tools: [...s.tools, { name: ev.name, summary: ev.summary, status: 'pending' }] };
    case 'tool-end': {
      // Resolve the most recent still-pending call with a matching name.
      const tools = [...s.tools];
      for (let i = tools.length - 1; i >= 0; i--) {
        if (tools[i].name === ev.name && tools[i].status === 'pending') {
          tools[i] = { name: ev.name, summary: ev.summary, status: ev.ok ? 'ok' : 'err' };
          return { ...s, tools };
        }
      }
      // No matching start (shouldn't happen) — record it terminally anyway.
      tools.push({ name: ev.name, summary: ev.summary, status: ev.ok ? 'ok' : 'err' });
      return { ...s, tools };
    }
    case 'done':
      return { ...s, status: 'done' };
    case 'error':
      return { ...s, status: 'error', error: ev.message };
  }
}

/** Mark an in-flight stream cancelled (no terminal event will arrive). */
export function cancelStream(s: StreamState): StreamState {
  if (s.status !== 'streaming') return s;
  return { ...s, status: 'cancelled' };
}

/** True once the stream reached any terminal state. */
export function isTerminal(s: StreamState): boolean {
  return s.status !== 'streaming';
}

/** Display summaries of the tools a reply ran, for the committed transcript.
 *  `ok` is carried so the collapsed turn summary can show ✓/✕ and each expanded
 *  line its own tick. Only an explicit error marks a call failed — a still
 *  pending call (e.g. from a cancelled turn) counts as ok. */
export function toolTraceOf(s: StreamState): AiChatToolTrace[] {
  return s.tools.map(t => ({ name: t.name, summary: t.summary, ok: t.status !== 'err' }));
}

/** Freeze a finished stream into an assistant transcript turn. Cancelled and
 *  errored streams still commit whatever text streamed so the thread keeps a
 *  record; the caller decides whether to append the error line separately. */
export function toAssistantTurn(s: StreamState): AiChatTurn {
  // Belt-and-suspenders: the SW already scrubs DSML tool markup from the
  // stream, but scrub the committed text too so a marker that split exactly on
  // a chunk boundary can never persist into the transcript (and get replayed to
  // the model on the next turn).
  const turn: AiChatTurn = { role: 'assistant', text: scrubToolMarkup(s.text) };
  const trace = toolTraceOf(s);
  if (trace.length) turn.toolTrace = trace;
  return turn;
}

/** Build the `history` array sent on the NEXT AiChatTurn — the prior committed
 *  turns only (the SW appends the new user text itself). This is a pass-through
 *  guard so the tab never accidentally includes the in-flight turn. */
export function priorTurns(transcript: AiChatTurn[]): AiChatTurn[] {
  return transcript.slice();
}
