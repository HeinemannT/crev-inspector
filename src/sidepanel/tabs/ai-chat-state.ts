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
import type { ObjectReference } from '../../lib/types';
import { mergeObjectReferences } from '../../lib/ai/tools';
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
  objects: ObjectReference[];
  status: StreamStatus;
  /** Present only when status === 'error'. */
  error?: string;
}

export function initStream(objects: readonly ObjectReference[] = []): StreamState {
  return { text: '', tools: [], objects: mergeObjectReferences(objects), status: 'streaming' };
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
      const objects = mergeObjectReferences([...s.objects, ...(ev.objects ?? [])]);
      // Resolve the most recent still-pending call with a matching name.
      const tools = [...s.tools];
      for (let i = tools.length - 1; i >= 0; i--) {
        if (tools[i].name === ev.name && tools[i].status === 'pending') {
          tools[i] = { name: ev.name, summary: ev.summary, status: ev.ok ? 'ok' : 'err' };
          return { ...s, tools, objects };
        }
      }
      // No matching start (shouldn't happen) — record it terminally anyway.
      tools.push({ name: ev.name, summary: ev.summary, status: ev.ok ? 'ok' : 'err' });
      return { ...s, tools, objects };
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
  if (s.objects.length) turn.objects = s.objects;
  return turn;
}

/** Build the `history` array sent on the NEXT AiChatTurn — the prior committed
 *  turns only (the SW appends the new user text itself). This is a pass-through
 *  guard so the tab never accidentally includes the in-flight turn. */
export function priorTurns(transcript: AiChatTurn[]): AiChatTurn[] {
  return transcript.slice();
}

// ── Transcript rewind: Retry + Edit-last-message ─────────────────────
//
// Both mechanics act on the LAST completed exchange: they keep the history
// prefix before the last user turn and re-run that user turn (Retry resends it
// verbatim; Edit loads its text into the composer for revision, then resubmits).
// Because they only ever touch the final turn, nothing later is silently
// discarded — the Cursor failure mode where editing an earlier message wipes
// downstream work cannot occur here (there IS no downstream work to wipe).

export interface RetryPlan {
  /** The history prefix to keep (every turn before the last user turn). */
  turns: AiChatTurn[];
  /** The user turn to resend verbatim — text plus any via/quote metadata. */
  resend: AiChatTurn;
}

export interface EditPlan {
  /** The history prefix to keep (every turn before the last user turn). */
  turns: AiChatTurn[];
  /** The user turn to load into the composer — its text seeds the edit, its
   *  via/quote are reattached when the revised text is resubmitted. */
  draft: AiChatTurn;
}

/** Split a transcript at its last user turn, returning the prefix before it and
 *  the turn itself — but only when that user turn has at least one assistant
 *  turn after it (its reply, or an error line). Returns null when there is no
 *  completed exchange to act on: an empty transcript, a transcript with no user
 *  turn, or one whose last turn is the user's (its reply still in flight — the
 *  mid-stream guard). The returned `turns` is a prefix of the input by
 *  reference-equal turns, so a caller can truncate its own richer transcript to
 *  `turns.length` and preserve display-only metadata on the kept turns. */
function splitAtLastUser(turns: AiChatTurn[]): { turns: AiChatTurn[]; turn: AiChatTurn } | null {
  let u = -1;
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role === 'user') { u = i; break; }
  }
  if (u === -1 || u === turns.length - 1) return null;
  return { turns: turns.slice(0, u), turn: turns[u] };
}

/** Plan a Retry: drop the last reply (and any error line) and resend the same
 *  user turn. Null when there is no reply to regenerate (see splitAtLastUser). */
export function prepareRetry(turns: AiChatTurn[]): RetryPlan | null {
  const s = splitAtLastUser(turns);
  return s ? { turns: s.turns, resend: s.turn } : null;
}

/** Plan an Edit: drop the last user turn AND its reply, seeding the composer
 *  with the user turn's text for revision. Null when there is nothing to edit. */
export function prepareEdit(turns: AiChatTurn[]): EditPlan | null {
  const s = splitAtLastUser(turns);
  return s ? { turns: s.turns, draft: s.turn } : null;
}
