/**
 * Provider-agnostic orchestrator used by the SW handler. Builds the prompt,
 * picks the dialect, streams, and supports AbortController cancellation. The
 * decrypted API key is passed in by the handler and never stored here.
 */

import type { AiChatEvent, AiChatTurn, AiRequestPayload, AiSettings, AiTokenUsage, AiTurnMetrics } from './types';
import { resolveProvider } from './providers';
import { buildEditorPrompt } from './editor-prompt';
import { streamAnthropic } from './anthropic';
import { streamOpenAiCompat, listModels as listOpenAiModels } from './openai-compat';
import type { ExecuteTool, ToolCall, ToolResult } from './tools';
import { boundedToolResult, CHANGE_PREVIEW_SATISFIED_NOTE, MAX_TOOL_CALLS, MAX_TOOL_LOOP_MS, MAX_TOOL_ROUNDS, MAX_UNPRODUCTIVE_TOOL_ROUNDS, TOOL_BUDGET_EXHAUSTED_NOTE, toolResultEvidenceKey, toolResultForModel } from './tools';
import type { ToolDef } from './tool-contracts';
import { summarizeToolCall, TOOL_DEFS } from './tool-contracts';
import {
  changeTicketTargetRid,
  extractValidChangeTicket,
  isolateValidChangeTicket,
  parseChangeTicket,
  type AiChangeProposal,
} from './change-ticket';
import { hasStateChangingEc } from './ec-source';
import type { PageContextPrefetch } from './page-context-prefetch';
import {
  createAnthropicConversation,
  createOpenAiConversation,
  type ProviderConversation,
} from './provider-conversation';
import { CHAT_MAX_OUTPUT_TOKENS, prepareAiTurn, type PreparedAiTurn } from './turn-preparation';
import { VERIFIED_OBJECT_ANSWER_HINT } from './object-output-contract';

export { CHAT_MAX_OUTPUT_TOKENS };

/** Bounded recovery for transient empty or fully scrubbed provider turns.
 * This is transport recovery, not semantic EC autorepair. */
export const MAX_EMPTY_RESPONSE_RETRIES = 2;
/** One automatic repair keeps the assistant helpful without turning a simple
 * edit into three full provider generations and three BMP round trips. */
export const MAX_MISSING_PREVIEW_RETRIES = 1;

const SUBMIT_CHANGE_TICKET = 'submit_change_ticket';
const ANSWER_USER = 'answer_user';

function answerUserDef(): ToolDef {
  return {
    name: ANSWER_USER,
    description: 'Terminal prose answer for findings, explanations, hypotheticals, and data requests. Do not use for a concrete requested configuration change.',
    parameters: {
      type: 'object',
      properties: {
        answer: {
          type: 'string',
          description: `Complete concise Markdown answer. ${VERIFIED_OBJECT_ANSWER_HINT} An illustrative EC snippet is allowed. No execution claims or tool narration.`,
        },
      },
      required: ['answer'],
      additionalProperties: false,
    },
  };
}

function submitChangeTicketDef(preparedChoice = false): ToolDef {
  const baseDescription = preparedChoice
    ? 'Terminal previewable change. Use for a direct request or declared desired state. A resolved template target is complete scope; do not request reconfirmation.'
    : 'Terminal function call. After evidence is complete, invoke this actual API tool as the next action; never type, narrate, or imitate its name/arguments in text. Companion validates and Previews the exact outer code. Preview only an uncertain deferred expression first.';
  return {
    name: SUBMIT_CHANGE_TICKET,
    description: baseDescription,
    parameters: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description: 'Visible outcome under 140 characters; mention shared-template impact only when relevant. Name visible objects, not internal fields.',
        },
        target: {
          type: 'string',
          description: 'Exact [[object:RID]] for the mutation owner, or exact supplied symbolic target. For a page add this is pageTemplateRid/pageOwnerRid, never viewedRid, container, or sibling. No bare RID or lookup(...).',
        },
        operation: {
          type: 'string',
          description: 'create for add/create/link; update only for changing existing properties.',
          enum: ['create', 'update', 'move', 'delete', 'other'],
        },
        code: {
          type: 'string',
          description: `Complete state-changing EC, without fences/placeholders. Preserve an exact supplied receiver. For a RID target use lookup("RID") with the RID quoted. A new widget is pageReceiver.add(Type,...); container is only a named placement argument and a sibling only a later move anchor. Never add to viewedRid/container/sibling, invent _page, or substitute page descendants. Use verified collections exactly.${preparedChoice ? ' Use receiver.change(exactAccessor := value), not dotted assignment.' : ''}`,
        },
      },
      required: ['summary', 'target', 'operation', 'code'],
      additionalProperties: false,
    },
  };
}

function ticketFromSubmission(call: ToolCall | undefined): string | null {
  if (!call || call.name !== SUBMIT_CHANGE_TICKET) return null;
  const summary = typeof call.input.summary === 'string' ? call.input.summary.trim() : '';
  const target = typeof call.input.target === 'string' ? call.input.target.trim() : '';
  const operation = typeof call.input.operation === 'string' ? call.input.operation : '';
  const code = typeof call.input.code === 'string' ? call.input.code.trim() : '';
  if (!summary || /[\r\n]/.test(summary)
    || !target || /[\r\n]/.test(target)
    || !['create', 'update', 'move', 'delete', 'other'].includes(operation)
    || !code || /```/.test(code)) return null;
  return [
    '```crev-change',
    `summary: ${summary}`,
    ...(target ? [`target: ${target}`] : []),
    `operation: ${operation}`,
    'language: extended',
    '---',
    code,
    '```',
  ].join('\n');
}

function answerFromSubmission(call: ToolCall | undefined): string | null {
  if (!call || call.name !== ANSWER_USER) return null;
  const answer = typeof call.input.answer === 'string' ? call.input.answer.trim() : '';
  return answer && answer.length <= 12_000 ? answer : null;
}

export interface StreamCompletionOpts {
  settings: AiSettings;
  /** Decrypted API key. */
  apiKey: string;
  payload: AiRequestPayload;
  onChunk: (delta: string) => void;
  signal?: AbortSignal;
}

export async function streamCompletion(opts: StreamCompletionOpts): Promise<{ text: string }> {
  const meta = resolveProvider(opts.settings);
  const { system, user } = buildEditorPrompt(opts.payload);
  if (meta.openAiCompat) {
    return streamOpenAiCompat({
      baseUrl: meta.baseUrl,
      model: opts.settings.model,
      maxTokens: meta.maxOutputTokens,
      maxTokensParam: meta.maxTokensParam,
      apiKey: opts.apiKey,
      system,
      user,
      signal: opts.signal,
      onChunk: opts.onChunk,
    });
  }
  return streamAnthropic({
    baseUrl: meta.baseUrl,
    model: opts.settings.model,
    maxTokens: meta.maxOutputTokens,
    apiKey: opts.apiKey,
    system,
    user,
    signal: opts.signal,
    onChunk: opts.onChunk,
  });
}

// ── Chat orchestrator (tool loop, both dialects) ─────────────────

export interface StreamChatOpts {
  settings: AiSettings;
  /** Decrypted API key. */
  apiKey: string;
  /** Stable cached persona + knowledge + tool guidance. */
  system: string;
  /** Volatile selected-object/source context for the current user turn. */
  context?: string;
  /** Production seam for loading the server-scoped primer only after the
   * compact prepared route has been ruled out. */
  loadFullPrompt?: () => Promise<{ system: string; context?: string }>;
  /** Prior transcript turns (the panel owns it, sends it whole). */
  history: AiChatTurn[];
  /** The new user turn's text. */
  text: string;
  /** Current page supplied by the browser context. Enables the confidence-
   * gated one-request path for simple named-widget property changes. */
  pageRid?: string;
  /** Evaluation/diagnostic seam. Production leaves prefetch enabled. */
  simpleChangePrefetch?: boolean;
  /** Evaluation/diagnostic seam. `false` hides discovery tools on the initial
   * turn while retaining the typed terminal Change Ticket tool. */
  toolPolicy?: { initialTools: boolean };
  onEvent: (e: AiChatEvent) => void;
  executeTool: ExecuteTool;
  /** Production-only final-ticket Preview. Unlike investigative preview_ec,
   *  this may return the exact-code capability that makes the rendered card
   *  immediately runnable. Tests/evaluators may omit it and use executeTool. */
  executeChangePreview?: (
    request: { code: string; targetRid?: string },
    signal?: AbortSignal,
  ) => Promise<ToolResult & { previewId?: string }>;
  signal?: AbortSignal;
}

interface EffectiveStreamChatOpts extends StreamChatOpts {
  turn: PreparedAiTurn;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function emptyTurnMetrics(durationMs = 0): AiTurnMetrics {
  return {
    durationMs,
    providerRequests: 0,
    providerDurationMs: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    modelRetries: 0,
    emptyResponseRetries: 0,
    previewRepairRetries: 0,
    toolRounds: 0,
    toolCallsRequested: 0,
    toolCallsExecuted: 0,
    automaticToolCalls: 0,
    previewDurationMs: 0,
    modelToolDurationMs: 0,
    duplicateCalls: 0,
    toolErrors: 0,
    budgetExhausted: false,
    tools: [],
  };
}

class InterruptedTurnError extends Error {
  constructor(
    error: unknown,
    readonly metrics: AiTurnMetrics,
    readonly phase: NonNullable<AiTurnMetrics['terminalPhase']>,
  ) {
    super(errorText(error));
    this.name = 'InterruptedTurnError';
  }
}

function parsedErrorLine(message: string): number | undefined {
  const match = message.match(/\bline\s+(\d+)\b/i);
  return match ? Number(match[1]) : undefined;
}

function toolEventSummary(summary: string, result: ToolResult): string {
  if (!result.isError) return summary;
  const detail = result.content.replace(/\s+/g, ' ').trim();
  return detail ? `${summary} · ${detail.slice(0, 240)}` : summary;
}

/** Run one user turn as an agentic loop: stream text, run any requested
 *  read-only tools (capped at MAX_TOOL_CALLS), feed results back, repeat until
 *  the model answers. Emits the AiChatEvent stream via onEvent. Every terminal
 *  path returns metrics; cancellation remains quiet in the UI while timeout and
 *  failure emit `error`. */
export async function streamChat(opts: StreamChatOpts): Promise<AiTurnMetrics> {
  const started = Date.now();
  const meta = resolveProvider(opts.settings);
  let turn: PreparedAiTurn | undefined;
  try {
    turn = await prepareAiTurn({
      system: opts.system,
      context: opts.context,
      loadFullPrompt: opts.loadFullPrompt,
      history: opts.history,
      text: opts.text,
      pageRid: opts.pageRid,
      prefetchEnabled: opts.simpleChangePrefetch !== false,
      maxInputTokens: meta.maxInputTokens,
      maxOutputTokens: meta.maxOutputTokens,
      onEvent: opts.onEvent,
      executeTool: opts.executeTool,
      signal: opts.signal,
    });
    const effectiveOpts: EffectiveStreamChatOpts = {
      ...opts,
      turn,
    };
    const conversationBase = {
      baseUrl: meta.baseUrl,
      model: effectiveOpts.settings.model,
      maxTokens: turn.maxOutputTokens,
      apiKey: effectiveOpts.apiKey,
      system: turn.system,
      history: turn.history,
      user: turn.user,
      signal: effectiveOpts.signal,
    };
    const conversation = meta.openAiCompat
      ? createOpenAiConversation({ ...conversationBase, maxTokensParam: meta.maxTokensParam })
      : createAnthropicConversation(conversationBase);
    const metrics = await runProviderChat(effectiveOpts, conversation);
    const withPrefetch = mergePrefetchMetrics(metrics, turn.prefetch, Date.now() - started);
    opts.onEvent({ kind: 'done' });
    return {
      ...withPrefetch,
      estimatedInputCharacters: turn.estimatedInputCharacters,
      historyTurnsDropped: turn.historyTurnsDropped,
      terminalPhase: 'complete',
    };
  } catch (error) {
    const interrupted = error instanceof InterruptedTurnError ? error : null;
    const reason = opts.signal?.aborted ? opts.signal.reason : error;
    const timeout = reason instanceof DOMException && reason.name === 'TimeoutError';
    const cancelled = !!opts.signal?.aborted && !timeout;
    const message = timeout
      ? reason.message
      : cancelled
        ? errorText(reason ?? 'Cancelled')
        : errorText(error);
    if (opts.signal?.aborted) {
      if (timeout) opts.onEvent({ kind: 'error', message });
    } else {
      opts.onEvent({ kind: 'error', message });
    }
    const partial = mergePrefetchMetrics(
      interrupted?.metrics ?? emptyTurnMetrics(),
      turn?.prefetch ?? null,
      Date.now() - started,
    );
    return {
      ...partial,
      ...(turn ? {
        estimatedInputCharacters: turn.estimatedInputCharacters,
        historyTurnsDropped: turn.historyTurnsDropped,
      } : {}),
      terminalOutcome: timeout ? 'timeout' : cancelled ? 'cancelled' : 'error',
      terminalPhase: interrupted?.phase ?? (turn ? 'provider' : 'preparation'),
      terminalError: message,
    };
  }
}

/** A short human summary of a tool call for the transcript's tool trace. */
const RID_INPUT_KEYS = new Set(['ref', 'pageRid', 'focusRid', 'exampleRid']);

/** Models occasionally serialize small RIDs as JSON numbers despite the
 * schema. Coerce only safe integers at the boundary; unsafe 64-bit values stay
 * invalid because their digits may already have lost precision. */
function normalizeRidInputs(call: ToolCall): ToolCall {
  let input: Record<string, unknown> | undefined;
  for (const [key, value] of Object.entries(call.input)) {
    if (!RID_INPUT_KEYS.has(key) || typeof value !== 'number' || !Number.isSafeInteger(value)) continue;
    input ??= { ...call.input };
    input[key] = String(value);
  }
  return input ? { ...call, input } : call;
}

interface AutomaticToolState {
  calls: number;
  errors: number;
  duplicates: number;
  tools: AiTurnMetrics['tools'];
  previewAttempts: NonNullable<AiTurnMetrics['previewAttempts']>;
  priorResults: Map<string, string>;
}

function createAutomaticToolState(): AutomaticToolState {
  return {
    calls: 0,
    errors: 0,
    duplicates: 0,
    tools: [],
    previewAttempts: [],
    priorResults: new Map(),
  };
}

function mergePrefetchMetrics(
  metrics: AiTurnMetrics,
  prepared: PageContextPrefetch | null,
  durationMs: number,
): AiTurnMetrics {
  if (!prepared?.executions.length) return { ...metrics, durationMs };
  const tools: AiTurnMetrics['tools'] = prepared.executions.map(execution => ({
    name: execution.call.name,
    summary: summarizeToolCall(execution.call),
    input: execution.call.input,
    result: toolResultForModel(execution.result, execution.call.name),
    origin: 'prefetch',
    ok: !execution.result.isError,
    duplicate: false,
    durationMs: execution.durationMs,
    outcome: execution.result.isError ? 'error' : 'success',
    ...(execution.result.isError ? { error: execution.result.content } : {}),
  }));
  return {
    ...metrics,
    durationMs,
    toolCallsRequested: metrics.toolCallsRequested + tools.length,
    toolCallsExecuted: metrics.toolCallsExecuted + tools.length,
    prefetchedToolCalls: tools.length,
    prefetchDurationMs: tools.reduce((sum, tool) => sum + tool.durationMs, 0),
    toolErrors: metrics.toolErrors + tools.filter(tool => !tool.ok).length,
    tools: [...tools, ...metrics.tools],
  };
}

function modelToolAllowed(opts: EffectiveStreamChatOpts, name: string): boolean {
  const allowed = opts.turn.allowedModelTools;
  return !allowed || allowed.includes(name);
}

function proposalFromTicket(ticket: string): AiChangeProposal | null {
  return parseChangeTicket(ticket);
}

/** Preview the exact code hidden behind the final card. This is deterministic
 * pipeline validation, not another model-planning step: successful code is
 * shown immediately; only a real BMP error is returned to the model. */
async function executeAutomaticPreview(
  code: string,
  opts: EffectiveStreamChatOpts,
  state: AutomaticToolState,
  execute: ExecuteTool = opts.executeTool,
  audit?: Pick<AiChangeProposal, 'operation' | 'target'>,
): Promise<ToolResult & { previewId?: string }> {
  const call: ToolCall = {
    id: `crev-auto-preview-${state.calls + 1}`,
    name: 'preview_ec',
    input: { code },
  };
  const summary = summarizeToolCall(call);
  opts.onEvent({ kind: 'tool-start', name: call.name, summary });
  const started = Date.now();
  const result = await execute(call, opts.signal);
  const durationMs = Date.now() - started;
  const line = result.isError ? parsedErrorLine(result.content) : undefined;
  state.calls++;
  if (result.isError) state.errors++;
  const fingerprint = toolCallFingerprint(call);
  const evidenceKey = toolResultEvidenceKey(result);
  const duplicate = state.priorResults.get(fingerprint) === evidenceKey;
  if (duplicate) state.duplicates++;
  state.priorResults.set(fingerprint, evidenceKey);
  state.tools.push({
    name: call.name,
    summary,
    input: call.input,
    result: toolResultForModel(result, call.name),
    origin: 'pipeline',
    ok: !result.isError,
    duplicate,
    durationMs,
    outcome: result.isError ? 'error' : duplicate ? 'duplicate' : 'success',
    ...(result.isError ? { error: result.content } : {}),
  });
  state.previewAttempts.push({
    code,
    resultText: result.content,
    ok: !result.isError,
    durationMs,
    ...(audit?.operation ? { operation: audit.operation } : {}),
    ...(audit?.target ? { target: audit.target } : {}),
    ...(line !== undefined ? { line } : {}),
  });
  opts.onEvent({
    kind: 'tool-end',
    name: call.name,
    summary: toolEventSummary(summary, result),
    ok: !result.isError,
    durationMs,
    duplicate,
    objects: result.objects,
  });
  return result;
}

async function previewFinalTicket(
  ticket: string,
  opts: EffectiveStreamChatOpts,
  state: AutomaticToolState,
): Promise<ToolResult> {
  const proposal = proposalFromTicket(ticket);
  const code = proposal?.code;
  if (!code) {
    return {
      content: 'The Change Ticket must contain complete Extended Code.',
      isError: true,
    };
  }
  const targetRid = proposal.target ? changeTicketTargetRid(proposal.target) ?? undefined : undefined;
  const outerResult = await executeAutomaticPreview(
    code,
    opts,
    state,
    opts.executeChangePreview
      ? (_call, signal) => opts.executeChangePreview!({ code, ...(targetRid ? { targetRid } : {}) }, signal)
      : opts.executeTool,
    proposal,
  );
  if (!outerResult.isError && outerResult.previewId) {
    opts.onEvent({
      kind: 'change-preview-ready',
      code,
      resultText: outerResult.content,
      previewId: outerResult.previewId,
    });
  }
  return outerResult;
}

function withAutomaticTools(metrics: AiTurnMetrics, state: AutomaticToolState): AiTurnMetrics {
  const previewDurationMs = state.tools.reduce((sum, tool) => sum + tool.durationMs, 0);
  return {
    ...metrics,
    toolCallsRequested: metrics.toolCallsRequested + state.calls,
    toolCallsExecuted: metrics.toolCallsExecuted + state.calls,
    automaticToolCalls: state.calls,
    previewDurationMs,
    duplicateCalls: metrics.duplicateCalls + state.duplicates,
    toolErrors: metrics.toolErrors + state.errors,
    tools: [...metrics.tools, ...state.tools],
    ...(state.previewAttempts.length ? { previewAttempts: [...state.previewAttempts] } : {}),
  };
}

/** The shared tool loop, driven by two dialect closures. `runTurn` streams one
 *  provider turn (appending the assistant message to its own message array) and
 *  returns the tool calls it requested; `appendResults` records the tool
 *  results for the next turn. */
async function runToolLoop(
  runTurn: (
    allowTools: boolean,
  ) => Promise<ToolCall[]>,
  appendResults: (results: Array<{ call: ToolCall; result: ToolResult }>) => void,
  appendFinalNote: (note: string) => void,
  opts: EffectiveStreamChatOpts,
  onProgress: (metrics: AiTurnMetrics) => void,
  onPhase: (phase: NonNullable<AiTurnMetrics['terminalPhase']>) => void,
): Promise<AiTurnMetrics> {
  const started = Date.now();
  let used = 0;
  let toolRounds = 0;
  let requested = 0;
  let duplicates = 0;
  let toolErrors = 0;
  let budgetExhausted = false;
  let unproductiveRounds = 0;
  let limitReason: AiTurnMetrics['limitReason'];
  let notedFinal = false;
  let goalSatisfied = false;
  const tools: AiTurnMetrics['tools'] = [];
  const priorResults = new Map<string, string>();
  const successfulEvidence = new Set<string>();
  const snapshot = (): AiTurnMetrics => ({
    ...emptyTurnMetrics(Date.now() - started),
    toolRounds,
    toolCallsRequested: requested,
    toolCallsExecuted: used,
    modelToolDurationMs: tools
      .filter(tool => tool.origin === 'model')
      .reduce((sum, tool) => sum + tool.durationMs, 0),
    duplicateCalls: duplicates,
    toolErrors,
    budgetExhausted,
    tools: [...tools],
    ...(limitReason ? { limitReason } : {}),
  });
  onProgress(snapshot());
  // Final change validation belongs to the terminal submission path below.
  // preview_ec remains available for genuinely independent read-only probes,
  // such as evaluating a deferred table expression against live rows.
  for (;;) {
    if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const elapsed = Date.now() - started;
    if (used >= MAX_TOOL_CALLS) limitReason = 'calls';
    else if (toolRounds >= MAX_TOOL_ROUNDS) limitReason = 'rounds';
    else if (elapsed >= MAX_TOOL_LOOP_MS) limitReason = 'time';
    else if (unproductiveRounds >= MAX_UNPRODUCTIVE_TOOL_ROUNDS) limitReason = 'stagnation';
    const allowTools = !goalSatisfied && limitReason === undefined;
    // On the forced tools-off turn, tell the model WHY tools vanished so it
    // answers instead of emitting tool-call syntax as plain text (Issue A).
    if (!allowTools && !notedFinal) {
      appendFinalNote(goalSatisfied ? CHANGE_PREVIEW_SATISFIED_NOTE : TOOL_BUDGET_EXHAUSTED_NOTE);
      notedFinal = true;
      if (!goalSatisfied) budgetExhausted = true;
    }
    onPhase('provider');
    const toolCalls = await runTurn(allowTools);
    // A tools-off turn (or a turn that asked for nothing) is the final answer.
    if (!allowTools || toolCalls.length === 0) {
      const metrics = snapshot();
      onProgress(metrics);
      return metrics;
    }
    toolRounds++;
    requested += toolCalls.length;
    const results: Array<{ call: ToolCall; result: ToolResult }> = [];
    let productiveRound = false;
    for (const requestedCall of toolCalls) {
      const call = normalizeRidInputs(requestedCall);
      if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const summary = summarizeToolCall(call);
      opts.onEvent({ kind: 'tool-start', name: call.name, summary });
      let result: ToolResult;
      let durationMs = 0;
      const fingerprint = toolCallFingerprint(call);
      const prior = priorResults.get(fingerprint);
      if (used >= MAX_TOOL_CALLS) {
        budgetExhausted = true;
        result = { content: TOOL_BUDGET_EXHAUSTED_NOTE, isError: true };
      } else {
        used++;
        const callStarted = Date.now();
        onPhase('model-tool');
        result = boundedToolResult(await opts.executeTool(call, opts.signal));
        durationMs = Date.now() - callStarted;
      }
      const evidenceKey = toolResultEvidenceKey(result);
      const duplicate = prior !== undefined && prior === evidenceKey;
      if (duplicate) duplicates++;
      priorResults.set(fingerprint, evidenceKey);
      if (result.isError) toolErrors++;
      const repeatedEvidence = !result.isError && successfulEvidence.has(evidenceKey);
      if (!result.isError) successfulEvidence.add(evidenceKey);
      if (!result.isError && !repeatedEvidence) productiveRound = true;
      const outcome: AiTurnMetrics['tools'][number]['outcome'] = result.isError
        ? 'error'
        : duplicate
          ? 'duplicate'
          : repeatedEvidence
            ? 'repeated-evidence'
            : 'success';
      tools.push({
        name: call.name,
        summary,
        input: call.input,
        result: toolResultForModel(result, call.name),
        origin: 'model',
        ok: !result.isError,
        duplicate,
        durationMs,
        outcome,
        ...(result.isError ? { error: result.content } : {}),
      });
      onProgress(snapshot());
      opts.onEvent({
        kind: 'tool-end',
        name: call.name,
        summary: toolEventSummary(summary, result),
        ok: !result.isError,
        durationMs,
        duplicate,
        objects: result.objects,
      });
      results.push({ call, result });
    }
    unproductiveRounds = productiveRound ? 0 : unproductiveRounds + 1;
    appendResults(results);
    if (results.some(({ call, result }) => call.name === 'preview_ec'
        && !result.isError
        && typeof call.input.code === 'string'
        && hasStateChangingEc(call.input.code))) {
      goalSatisfied = true;
    }
  }
}

/** Stable across provider key ordering so semantically identical calls share
 *  one backend result. Tool call ids are deliberately excluded. */
function toolCallFingerprint(call: ToolCall): string {
  const stable = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
    if (value && typeof value === 'object') {
      return `{${Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
        .join(',')}}`;
    }
    return JSON.stringify(value);
  };
  return `${call.name}:${stable(call.input)}`;
}

interface ProviderPolicyState {
  modelRetries: number;
  emptyResponseRetries: number;
  previewRepairRetries: number;
  hasSuccessfulChangePreview: boolean;
  automaticTools: AutomaticToolState;
  requestedModel: string;
  resolvedModels: string[];
  providerRequests: number;
  providerDurationMs: number;
  providerFirstByteMs?: number;
  providerFirstOutputMs?: number;
  usage: AiTokenUsage;
  terminalOutcome?: AiTurnMetrics['terminalOutcome'];
  phase: NonNullable<AiTurnMetrics['terminalPhase']>;
}

function emptyUsage(): AiTokenUsage {
  return { inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 };
}

function addUsage(target: AiTokenUsage, usage: AiTokenUsage): void {
  target.inputTokens += usage.inputTokens;
  target.cachedInputTokens += usage.cachedInputTokens;
  target.cacheWriteTokens += usage.cacheWriteTokens;
  target.outputTokens += usage.outputTokens;
  target.reasoningTokens += usage.reasoningTokens;
}

function withProviderMetrics(metrics: AiTurnMetrics, state: ProviderPolicyState): AiTurnMetrics {
  return {
    ...metrics,
    requestedModel: state.requestedModel,
    ...(state.resolvedModels.length > 0 ? { resolvedModels: state.resolvedModels } : {}),
    providerRequests: state.providerRequests,
    providerDurationMs: state.providerDurationMs,
    ...(state.providerFirstByteMs !== undefined ? { providerFirstByteMs: state.providerFirstByteMs } : {}),
    ...(state.providerFirstOutputMs !== undefined ? { providerFirstOutputMs: state.providerFirstOutputMs } : {}),
    inputTokens: state.usage.inputTokens,
    cachedInputTokens: state.usage.cachedInputTokens,
    cacheWriteTokens: state.usage.cacheWriteTokens,
    outputTokens: state.usage.outputTokens,
    reasoningTokens: state.usage.reasoningTokens,
    ...(state.terminalOutcome ? { terminalOutcome: state.terminalOutcome } : {}),
  };
}

interface NormalizedProviderTurn {
  toolCalls: ToolCall[];
  structuredSubmission: boolean;
  changeTicket: boolean;
  outcome: 'answer' | 'change' | 'text' | 'none';
  visible: string;
  appendAssistant: () => void;
}

function normalizeProviderTurn(
  state: AutomaticToolState,
  clean: string,
  calls: readonly ToolCall[],
  appendAssistant: () => void,
): NormalizedProviderTurn {
  const submission = calls.find(call => call.name === SUBMIT_CHANGE_TICKET);
  const answerSubmission = calls.find(call => call.name === ANSWER_USER);
  const conflictingTerminals = !!submission && !!answerSubmission;
  const submittedTicket = ticketFromSubmission(submission);
  const submittedAnswer = answerFromSubmission(answerSubmission);
  const terminalRequested = !!submission || !!answerSubmission;
  const toolCalls = terminalRequested
    ? []
    : calls.filter(call => call.name !== SUBMIT_CHANGE_TICKET && call.name !== ANSWER_USER);
  const extractedTicket = submittedTicket ?? extractValidChangeTicket(clean) ?? undefined;
  const validTicket = extractedTicket;
  const visible = conflictingTerminals
    ? ''
    : validTicket ?? submittedAnswer ?? clean;
  return {
    toolCalls,
    structuredSubmission: terminalRequested,
    changeTicket: !!validTicket,
    outcome: validTicket ? 'change' : submittedAnswer ? 'answer' : clean.trim() ? 'text' : 'none',
    visible,
    appendAssistant,
  };
}

/** Shared retry, ticket-finalization, Preview-repair, and transcript policy.
 * Dialect closures only perform one provider request and append user notes. */
async function finalizeProviderTurn(
  opts: EffectiveStreamChatOpts,
  state: ProviderPolicyState,
  request: (structuredFinal: boolean) => Promise<NormalizedProviderTurn>,
  appendUserNote: (note: string) => void,
): Promise<ToolCall[]> {
  let structuredFinal = false;
  let current = await request(structuredFinal);
  while (!current.visible.trim() && current.toolCalls.length === 0) {
    if (state.modelRetries >= MAX_EMPTY_RESPONSE_RETRIES) {
      throw new Error(`The model returned no usable answer ${MAX_EMPTY_RESPONSE_RETRIES + 1} times. Try the request again.`);
    }
    appendUserNote('Your previous response was malformed, truncated, or empty. Reconsider the original request and evidence, then choose the correct terminal answer or change artifact. Preserve the requested outcome and do not restart discovery unless evidence is genuinely missing.');
    structuredFinal = false;
    state.modelRetries++;
    state.emptyResponseRetries++;
    current = await request(structuredFinal);
  }
  while (current.changeTicket
    && current.visible.trim()
    && current.toolCalls.length === 0
    && !state.hasSuccessfulChangePreview) {
    const ticket = extractValidChangeTicket(current.visible);
    state.phase = 'preview';
    const preview = ticket
      ? await previewFinalTicket(ticket, opts, state.automaticTools)
      : { content: 'The Change Ticket is malformed.', isError: true };
    if (!preview.isError) {
      state.hasSuccessfulChangePreview = true;
      break;
    }
    if (!current.structuredSubmission) current.appendAssistant();
    if (state.previewRepairRetries >= MAX_MISSING_PREVIEW_RETRIES) {
      const failed = ticket ? proposalFromTicket(ticket) : null;
      if (failed?.code) {
        opts.onEvent({
          kind: 'change-preview-failed',
          code: failed.code,
          resultText: preview.content,
        });
      }
      break;
    }
    const failed = ticket ? proposalFromTicket(ticket) : null;
    const repairEvidence = {
      operation: failed?.operation,
      target: failed?.target,
      attemptedCode: failed?.code,
      error: preview.content,
      ...(parsedErrorLine(preview.content) !== undefined
        ? { line: parsedErrorLine(preview.content) }
        : {}),
    };
    appendUserNote(`Automatic Preview failed. Repair only this ticket from the structured evidence below, then return exactly one corrected crev-change ticket. Do not restart discovery.\n<preview-failure>${JSON.stringify(repairEvidence)}</preview-failure>`);
    structuredFinal = true;
    state.previewRepairRetries++;
    state.modelRetries++;
    const failedTurn = current;
    const repaired = await request(structuredFinal);
    if (!repaired.changeTicket) {
      if (repaired.outcome === 'none') state.emptyResponseRetries++;
      current = failedTurn;
      if (failed?.code) {
        opts.onEvent({
          kind: 'change-preview-failed',
          code: failed.code,
          resultText: preview.content,
        });
      }
      break;
    }
    current = repaired;
  }
  if (current.toolCalls.length === 0 && current.visible) {
    opts.onEvent({ kind: 'text-delta', delta: current.changeTicket ? isolateValidChangeTicket(current.visible) : current.visible });
  }
  if (current.outcome !== 'none') state.terminalOutcome = current.outcome;
  if (!current.structuredSubmission) current.appendAssistant();
  return current.toolCalls;
}

async function runProviderChat(
  opts: EffectiveStreamChatOpts,
  conversation: ProviderConversation,
): Promise<AiTurnMetrics> {
  const state: ProviderPolicyState = {
    modelRetries: 0,
    emptyResponseRetries: 0,
    previewRepairRetries: 0,
    hasSuccessfulChangePreview: false,
    automaticTools: createAutomaticToolState(),
    requestedModel: opts.settings.model,
    resolvedModels: [],
    providerRequests: 0,
    providerDurationMs: 0,
    usage: emptyUsage(),
    phase: 'provider',
  };
  let partialMetrics = emptyTurnMetrics();
  const completeMetrics = (metrics: AiTurnMetrics): AiTurnMetrics => ({
    ...withProviderMetrics(withAutomaticTools(metrics, state.automaticTools), state),
    modelRetries: state.modelRetries,
    emptyResponseRetries: state.emptyResponseRetries,
    previewRepairRetries: state.previewRepairRetries,
  });

  const runTurn = async (
    allowTools: boolean,
  ): Promise<ToolCall[]> => {
    return finalizeProviderTurn(opts, state, async structuredFinal => {
      const requestStarted = Date.now();
      state.providerRequests++;
      state.phase = 'provider';
      try {
        const preparedChoice = !!opts.turn.prefetch?.providerPlan && !structuredFinal;
        const finalOnly = structuredFinal;
        const selectable = allowTools && opts.toolPolicy?.initialTools !== false
          ? TOOL_DEFS.filter(tool => modelToolAllowed(opts, tool.name))
          : [];
        const terminal = preparedChoice
          ? [answerUserDef(), submitChangeTicketDef(true)]
          : allowTools
            ? [submitChangeTicketDef()]
            : [];
        const turn = await conversation.requestTurn({
          tools: finalOnly ? terminal : [...selectable, ...terminal],
          ...(finalOnly
            ? { forceTool: SUBMIT_CHANGE_TICKET }
            : preparedChoice ? { requireTool: true } : {}),
        });
        state.providerFirstByteMs ??= turn.timing.firstByteMs;
        if (turn.timing.firstOutputMs !== undefined) {
          state.providerFirstOutputMs ??= turn.timing.firstOutputMs;
        }
        if (turn.resolvedModel) state.resolvedModels.push(turn.resolvedModel);
        addUsage(state.usage, turn.usage);
        return normalizeProviderTurn(state.automaticTools, turn.text, turn.toolCalls, turn.appendAssistant);
      } finally {
        state.providerDurationMs += Date.now() - requestStarted;
      }
    }, conversation.appendUserNote);
  };

  const appendResults = (results: Array<{ call: ToolCall; result: ToolResult }>): void => {
    conversation.appendToolResults(results);
  };

  try {
    const metrics = await runToolLoop(
      runTurn,
      appendResults,
      conversation.appendFinalNote,
      opts,
      metrics => { partialMetrics = metrics; },
      phase => { state.phase = phase; },
    );
    return completeMetrics(metrics);
  } catch (error) {
    throw new InterruptedTurnError(error, completeMetrics(partialMetrics), state.phase);
  }
}

/** One-shot "does this key work" probe. Sends a tiny request and reports
 *  success/failure with the provider's error message. */
export async function testConnection(settings: AiSettings, apiKey: string, signal?: AbortSignal): Promise<{ ok: boolean; error?: string }> {
  const meta = resolveProvider(settings);
  const user = 'Reply with the single word: OK';
  try {
    let got = '';
    const onChunk = (d: string) => { got += d; };
    if (meta.openAiCompat) {
      await streamOpenAiCompat({
        baseUrl: meta.baseUrl,
        model: settings.model,
        maxTokens: meta.maxOutputTokens,
        maxTokensParam: meta.maxTokensParam,
        apiKey,
        system: '',
        user,
        signal,
        onChunk,
      });
    } else {
      await streamAnthropic({ baseUrl: meta.baseUrl, model: settings.model, maxTokens: meta.maxOutputTokens, apiKey, system: '', user, signal, onChunk });
    }
    return { ok: got.length > 0 };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** List models for an OpenAI-compatible provider. Throws for Anthropic (no
 *  listing endpoint — callers use the static suggestion list). */
export async function listModels(settings: AiSettings, apiKey: string, signal?: AbortSignal): Promise<string[]> {
  const meta = resolveProvider(settings);
  if (!meta.openAiCompat) throw new Error('Model listing is not available for this provider');
  return listOpenAiModels(meta.baseUrl, apiKey, signal);
}
