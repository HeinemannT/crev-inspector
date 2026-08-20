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
  /** Backend execution time. */
  durationMs?: number;
  /** True when an identical request returned the same evidence again. */
  duplicate?: boolean;
}

/** Provider-reported usage for one or more model requests. Zero means the
 * provider did not report the field; it is never estimated in production. */
export interface AiTokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

/** Network timing for one provider request. `firstByteMs` ends when fetch
 * resolves with response headers; `firstOutputMs` ends at the first streamed
 * text or tool-use delta. */
export interface AiProviderTiming {
  firstByteMs: number;
  firstOutputMs?: number;
}

/** Machine-readable turn telemetry for prompt/tool evaluation. Tool inputs and
 * provider-facing results are retained under the same bounds used for model
 * context, so failed and inefficient turns can be reconstructed exactly. */
export interface AiTurnMetrics {
  durationMs: number;
  /** Configured model id sent on each provider request. */
  requestedModel?: string;
  /** Concrete response model ids in provider-request order. Routers can
   * resolve successive requests to different models. Missing entries mean the
   * provider did not report an id before interruption. */
  resolvedModels?: string[];
  /** Provider requests include discovery, final submission, and repair turns. */
  providerRequests: number;
  providerDurationMs: number;
  /** Initial provider request only, so retries and tool loops do not blur
   * perceived time-to-first-response. */
  providerFirstByteMs?: number;
  providerFirstOutputMs?: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  /** Dependency-free estimate used to bound the initial provider transcript. */
  estimatedInputCharacters?: number;
  /** Oldest whole transcript turns omitted to respect the configured context. */
  historyTurnsDropped?: number;
  /** Final provider-selected semantic outcome. Structured outcomes are
   * preferred; text remains for ordinary non-prefetched answers. */
  terminalOutcome?: 'answer' | 'change' | 'text' | 'timeout' | 'cancelled' | 'error';
  /** Last active pipeline phase. Failed turns use this to distinguish prompt
   * preparation, provider latency, model tools, and final-ticket Preview. */
  terminalPhase?: 'preparation' | 'provider' | 'model-tool' | 'preview' | 'complete';
  /** Exact terminal error retained locally for failed evaluation traces. */
  terminalError?: string;
  /** Provider turns retried because they returned neither text nor tools. */
  modelRetries: number;
  /** Subset of modelRetries caused by empty, fully scrubbed, or structurally
   * invalid final output. */
  emptyResponseRetries: number;
  /** Subset of modelRetries caused by a genuine automatic BMP Preview error. */
  previewRepairRetries: number;
  toolRounds: number;
  toolCallsRequested: number;
  toolCallsExecuted: number;
  /** Tool calls initiated deterministically by the pipeline rather than by the
   * model. Currently this is the exact final Change Ticket Preview. */
  automaticToolCalls: number;
  /** Live reads performed before the first provider request for an
   * unambiguous simple-change route. */
  prefetchedToolCalls?: number;
  /** Sum of deterministic evidence-prefetch wall time. */
  prefetchDurationMs?: number;
  /** Sum of deterministic final/expression Preview wall time. */
  previewDurationMs: number;
  /** Exact deterministic final-ticket Preview attempts. Bounded by the repair
   * policy, so this cannot grow with the general tool loop. */
  previewAttempts?: Array<{
    code: string;
    resultText: string;
    ok: boolean;
    durationMs: number;
    operation?: string;
    target?: string;
    line?: number;
  }>;
  /** Sum of model-selected BMP tool execution time. */
  modelToolDurationMs: number;
  /** Repeated identical requests that returned unchanged evidence. They are
   * executed normally; evaluation decides whether the repetition was useful. */
  duplicateCalls: number;
  toolErrors: number;
  budgetExhausted: boolean;
  /** Argument/result-free trajectory for effectiveness scoring. `outcome`
   * distinguishes backend failure, repeated requests with unchanged evidence,
   * and distinct calls that returned evidence already seen earlier in the turn. */
  tools: Array<{
    name: string;
    summary: string;
    input: Record<string, unknown>;
    /** Exact bounded provider-facing result JSON. */
    result: string;
    origin: 'model' | 'pipeline' | 'prefetch';
    ok: boolean;
    duplicate: boolean;
    durationMs: number;
    outcome: 'success' | 'error' | 'duplicate' | 'repeated-evidence';
    /** Convenient direct failure text; `result` remains the canonical trace. */
    error?: string;
  }>;
  limitReason?: 'calls' | 'rounds' | 'time' | 'stagnation';
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
  /** Verified identities cited by this turn. Display-only and never inferred
   *  from prose. User turns receive only identities from their attached context. */
  objects?: ObjectReference[];
}

/** Streaming events the chat orchestrator emits as it runs one user turn.
 *  The SW forwards each as an AI_CHAT_EVENT broadcast keyed by requestId
 *  (the exact primitive AI_CHUNK uses). */
export type AiChatEvent =
  | { kind: 'text-delta'; delta: string }
  | { kind: 'tool-start'; name: string; summary: string }
  | { kind: 'tool-end'; name: string; summary: string; ok: boolean; durationMs?: number; duplicate?: boolean; objects?: ObjectReference[] }
  /** The deterministic final-ticket Preview already produced the exact-code,
   *  scope-bound capability consumed by Run. This is UI state, not transcript
   *  content and is never replayed to the provider. */
  | { kind: 'change-preview-ready'; code: string; resultText: string; previewId: string }
  /** The bounded repair attempt also failed. Preserve the proposal as a
   * non-runnable card so its code and BMP error remain available. */
  | { kind: 'change-preview-failed'; code: string; resultText: string }
  | { kind: 'done' }
  | { kind: 'error'; message: string };
