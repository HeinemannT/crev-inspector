/**
 * AI coding-assistant types. Shared by the service-worker provider layer, the
 * message union, and the editor/studio UI. No runtime imports — pure types +
 * a couple of literal unions — so any surface can depend on it cheaply.
 */
import type { ObjectIdentity, ObjectReference } from '../types';

export type AiProviderId = 'anthropic' | 'openai' | 'deepseek' | 'grok' | 'custom';
export type AiApiType = 'openai' | 'anthropic';
export type AiMaxTokensParam = 'max_tokens' | 'max_completion_tokens';

export interface AiCustomModel {
  id: string;
  name: string;
  /** API base URL. The selected dialect appends its standard endpoint path. */
  url: string;
  toolCalling: boolean;
  vision?: boolean;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  /** OpenAI-compatible request field used when maxOutputTokens is set.
   * Defaults to the current Chat Completions field, max_completion_tokens. */
  maxTokensParam?: AiMaxTokensParam;
}

/** Sanitized custom-provider catalogue. The imported plaintext apiKey is
 *  deliberately not part of this persisted shape. */
export interface AiCustomProvider {
  name: string;
  vendor: string;
  apiType: AiApiType;
  models: AiCustomModel[];
}

/** Editor language family the request targets. */
export type AiLang = 'extended' | 'html' | 'javascript';

export type AiIntent = 'ask' | 'edit';

/** Persisted AI configuration (stored inside `crev_settings.ai`). The key is
 *  stored AES-GCM encrypted; it is decrypted in the service worker only, on the
 *  way to a provider request. */
export interface AiSettings {
  provider: AiProviderId;
  model: string;
  /** Encrypted API key (never plaintext at rest, never sent to a UI surface). */
  apiKeyEnc: string;
  /** One optional user-authored provider catalogue. Its key lives in
   *  apiKeyEnc, never in this JSON-shaped metadata. */
  customProvider?: AiCustomProvider;
  /** Last connection-test outcome — persisted (key-free) so the Connect tab's
   *  AI card can render READY + latency after a reload. Cleared on any config
   *  save (a new provider/model/key invalidates a prior test). */
  lastTest?: { ok: boolean; ms: number; at: number };
}

export interface AiChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** One sibling code property on the same object, truncated for context. */
export interface AiOtherSlot {
  name: string;
  code: string;
}

/** Volatile per-request grounding about the object being edited. Goes in the
 *  user message (after the cached persona + knowledge prefix). */
export interface AiObjectContext {
  objectType?: string;
  businessId?: string;
  name?: string;
  templateBusinessId?: string;
  /** The property being edited (e.g. `expression`, `html`, `javascript`). */
  slotName?: string;
  /** Other code properties on the object, truncated. */
  otherSlots?: AiOtherSlot[];
  /** CVO mode only: a truncated `_data` JSON sample so the model knows the shape. */
  dataSample?: string;
}

export interface AiSelection {
  from: number;
  to: number;
  text: string;
}

/** The request the editor/studio sends to the SW to run one completion. */
export interface AiRequestPayload {
  requestId: string;
  intent: AiIntent;
  lang: AiLang;
  /** Full text of the slot being edited. */
  code: string;
  /** Selected range, or null when there is no selection. */
  selection: AiSelection | null;
  instruction: string;
  context: AiObjectContext;
  /** Shared context vocabulary (chip = source). Optional so the existing
   *  one-shot strip path is unaffected; the chat path always carries it. */
  envelope?: AiContextEnvelope;
}

// ── Shared context envelope (chips 1:1) ──────────────────────────────
// Pointers, not payloads: the envelope carries identity + open code; the
// model dereferences everything else with read-only tools. Built once by
// context.ts, consumed by both the command strip and the chat tab.

/** One attached context source — mirrors exactly one composer chip. */
export interface AiContextSource {
  /** `editor` = an open editor/studio slot (carries code). `selection` =
   *  the object currently selected in the Inspect flow (identity only). */
  kind: 'editor' | 'selection';
  object: ObjectIdentity & { templateBusinessId?: string };
  /** The open code slot — editor kind only. */
  slot?: {
    name: string;
    lang: AiLang;
    code: string;
    selection?: { from: number; to: number };
  };
}

/** The full attached context for a request. `sources` is 0..2 and mirrors
 *  the composer chips exactly. Version-stamped so a stored/relayed envelope
 *  can be migrated if the shape ever changes. */
export interface AiContextEnvelope {
  v: 1;
  server: { id: string; url: string };
  /** Live browser page independently of the selected Inspect object. tabRid is
   * refreshed on BMP SPA tab switches and can scope read_layout. */
  page?: { rid: string; tabRid?: string; tabName?: string };
  sources: AiContextSource[];
}

// ── Chat transcript + streaming events ───────────────────────────────

/** A quoted code region carried into a chat turn (from the command strip's
 *  Ask, or a user paste). `lines` is a human label like "12–20". */
export interface AiChatQuote {
  code: string;
  lines?: string;
}

/** One display summary of a tool the assistant ran during a turn. Kept for
 *  the transcript's quiet tool trace — NOT replayed to the provider on the
 *  next user turn (tool call details are not persisted across turns). */
export interface AiChatToolTrace {
  name: string;
  summary: string;
  /** Whether the call succeeded. Drives the ✓/✕ on the collapsed turn summary
   *  and each expanded line. Absent (legacy) is treated as success. */
  ok?: boolean;
}

/** One transcript turn. The panel owns the transcript and sends it whole on
 *  each AI_CHAT_SEND; the SW reconstructs provider messages from it. */
export interface AiChatTurn {
  role: 'user' | 'assistant';
  text: string;
  /** Set when the turn came in via the editor command strip's Ask. */
  via?: 'strip';
  quote?: AiChatQuote;
  /** Display-only trace of tools the assistant ran on this turn. */
  toolTrace?: AiChatToolTrace[];
  /** Verified identities cited by this answer. Display-only and never inferred
   *  from the assistant's prose. */
  objects?: ObjectReference[];
}

/** Streaming events the chat orchestrator emits as it runs one user turn.
 *  The SW forwards each as an AI_CHAT_EVENT broadcast keyed by requestId
 *  (the exact primitive AI_CHUNK uses). */
export type AiChatEvent =
  | { kind: 'text-delta'; delta: string }
  | { kind: 'tool-start'; name: string; summary: string }
  | { kind: 'tool-end'; name: string; summary: string; ok: boolean; objects?: ObjectReference[] }
  | { kind: 'done' }
  | { kind: 'error'; message: string };
