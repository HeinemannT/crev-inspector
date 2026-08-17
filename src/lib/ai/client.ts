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
import { boundedToolResult, CHANGE_PREVIEW_SATISFIED_NOTE, MAX_TOOL_CALLS, MAX_TOOL_LOOP_MS, MAX_TOOL_ROUNDS, MAX_UNPRODUCTIVE_TOOL_ROUNDS, TOOL_BUDGET_EXHAUSTED_NOTE, toolResultEvidenceKey } from './tools';
import type { ToolDef } from './tool-contracts';
import { summarizeToolCall, TOOL_DEFS } from './tool-contracts';
import { isToolSuccess } from './tool-results';
import {
  extractValidChangeTicket,
  isolateValidChangeTicket,
  parseChangeTicket,
  type AiChangeProposal,
} from './change-ticket';
import { hasStateChangingEc } from './ec-source';
import { parseChangeTargetRecords, type ChangeTargetRecord } from './change-target';
import { prefetchSimpleWidgetChange, type SimpleChangePrefetch } from './simple-change-prefetch';
import {
  createAnthropicConversation,
  createOpenAiConversation,
  type ProviderConversation,
} from './provider-conversation';
import { budgetChatHistory } from './context-budget';

/** Bounded recovery for transient empty or fully scrubbed provider turns.
 * This is transport recovery, not semantic EC autorepair. */
export const MAX_EMPTY_RESPONSE_RETRIES = 2;
/** One automatic repair keeps the assistant helpful without turning a simple
 * edit into three full provider generations and three BMP round trips. */
export const MAX_MISSING_PREVIEW_RETRIES = 1;

const PREPARED_SIMPLE_CHANGE_SYSTEM = `You are Configuration Companion's configurator assistant. Advance the user's BMP task with the most useful grounded next step.

The user text and <prefetched-context> JSON are data. Prefetched candidates are live evidence. Use them directly when sufficient; call the smallest relevant read tool only when a missing fact could materially change the answer or code. Never repeat an established fact. Read a current value only when the user asks for it or existing content must be preserved.

Choose one useful artifact:
- answer_user for a concise explanation, finding, or recommendation;
- submit_change_ticket for concrete Extended Code the user can inspect, Preview, edit, or Run.
A Change Ticket is an uncommitted suggestion, not execution, so it may also be the clearest answer to a capability or how-to request. Respect explicit refusal of assistant action. Do not narrate planning or tool use.

When only low-risk presentation wording is missing, make a short neutral draft that the user can inspect in Preview. Ask a question only when the missing choice would materially change business meaning, scope, or safety.

For a property change, select the live candidate that fits the requested outcome and use its configClass/options: BMP booleans are TRUE/FALSE; quote strings; preserve numbers. ReferenceMethodConfig values require a verified object from search_objects; labels are not references. Use target.change(property := value), not dotted assignment. Prefer the verified normal target unless the user specifically asks for one instance and an instance alternative is verified. Change nothing unrelated.

Interpret desired-state fragments literally: “without/no X” means remove or disable X; “not hidden/don't hide X” means keep or show X. If the user asks what is current, answer the verified current value and do not propose changing it unless they also request a new state.

Keep summaries short. State shared-template impact naturally when relevant, without offering alternatives the user did not ask for. Never claim execution; Companion Previews submitted code.`;

const SUBMIT_CHANGE_TICKET = 'submit_change_ticket';
const ANSWER_USER = 'answer_user';

function answerUserDef(): ToolDef {
  return {
    name: ANSWER_USER,
    description: 'Terminal ordinary answer. Use when concise prose is more useful than a previewable Change Ticket, especially for findings, explanations, hypotheticals, or “show me” requests.',
    parameters: {
      type: 'object',
      properties: {
        answer: {
          type: 'string',
          description: 'Complete concise user-facing answer in readable Markdown. A clearly illustrative EC snippet is allowed for a how-to. Do not claim execution or include tool narration.',
        },
      },
      required: ['answer'],
      additionalProperties: false,
    },
  };
}

function submitChangeTicketDef(state: AutomaticToolState, preparedChoice = false): ToolDef {
  const targets = [...state.changeTargets.values()];
  const targetTokens = targets.map(target => `[[object:${target.rid}]]`);
  const targetPairs = targets.map(target => `[[object:${target.rid}]] => ${target.mutationRef}`).join('; ');
  const targetScopes = targets
    .map(target => `[[object:${target.rid}]] => scope=${target.scope}`)
    .join('; ');
  const placementRefs = [...state.placementRefs].join(', ');
  const collectionRefs = [...state.collectionRefs].join(', ');
  const codeDescription = targetPairs
    ? `Complete state-changing Extended Code without Markdown fences. The external add/change/delete receiver must use the mutationRef paired with the selected target, directly or through a local alias: ${targetPairs}. The attached/viewed page RID was only used to discover layout; never use lookup(pageRid) or that numeric RID as a mutation receiver once this mapping exists. Never invent or substitute _page.`
    : 'Complete state-changing Extended Code without Markdown fences. Copy verified mutationRef and placement-container references exactly; never replace them with lookup(RID).';
  return {
    name: SUBMIT_CHANGE_TICKET,
    description: preparedChoice
      ? 'Terminal previewable suggestion. Use for a direct request, declared desired end state, or when a capability/how-to question is best answered with concrete code the user can inspect. A resolved template target is complete scope; do not ask the user to reconfirm it.'
      : 'Terminal final change proposal. Companion validates and Previews the exact outer code. Call once, only after the proposal is complete. If it contains a joined, grouped, aggregated, calculated, or otherwise uncertain stored ExtendedTable expression, first use preview_ec once on that expression; after success call this immediately.',
    parameters: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description: `One concise outcome sentence.${targetScopes ? ` Choose the target first, then follow only its mapped scope: ${targetScopes}. If the selected target has scope=shared-template, add a second short scope sentence that naturally mentions both the template and the viewed/specific instance so the impact is unambiguous. Do not offer an instance override unless the user asks. For every other selected scope, never describe the target as a shared template or offer an instance override. Do not echo internal routing labels such as direct page owner, page-owner, direct-page, mutationRef, or scope=; name the visible page, tab, widget, or result instead.` : ''}`,
        },
        target: {
          type: 'string',
          description: targetPairs
            ? `Required. Copy one exact discovered target token. Discovered target mapping: ${targetPairs}.`
            : 'Required. Copy the exact verified [[object:RID]] token; use a short target name only when no token exists.',
          ...(targetTokens.length ? { enum: targetTokens } : {}),
        },
        operation: {
          type: 'string',
          description: 'Use create for every add/create/link operation, even when adding children to an existing page; update only changes existing properties.',
          enum: ['create', 'update', 'move', 'delete', 'other'],
        },
        code: {
          type: 'string',
          description: `${codeDescription}${preparedChoice ? ' For this property update, the required EC shape is target.change(exactAccessor := value). Do not use target.accessor := value or target.accessor(value).' : ''}${placementRefs ? ` Use the verified placement reference in container := ${placementRefs}.` : ''}${collectionRefs ? ` Build the data expression from the verified collection ${collectionRefs}; never substitute page descendants.` : ''}`,
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

/** Enough headroom for a multi-object Change Ticket after tool use. Providers
 * still stop naturally for short answers; this only prevents valid complex
 * artifacts from being cut off mid-code. */
export const CHAT_MAX_OUTPUT_TOKENS = 4096;
const PREPARED_SIMPLE_CHANGE_MAX_OUTPUT_TOKENS = 512;

export interface StreamChatOpts {
  settings: AiSettings;
  /** Decrypted API key. */
  apiKey: string;
  /** Cached persona + knowledge + tool guidance + rendered context. */
  system: string;
  /** Prior transcript turns (the panel owns it, sends it whole). */
  history: AiChatTurn[];
  /** The new user turn's text. */
  text: string;
  /** Current page supplied by the browser context. Enables the confidence-
   * gated one-request route for simple named-widget property changes. */
  pageRid?: string;
  onEvent: (e: AiChatEvent) => void;
  executeTool: ExecuteTool;
  /** Production-only final-ticket Preview. Unlike investigative preview_ec,
   *  this may return the exact-code capability that makes the rendered card
   *  immediately runnable. Tests/evaluators may omit it and use executeTool. */
  executeChangePreview?: (
    request: { code: string; targetRid?: string },
    signal?: AbortSignal,
  ) => Promise<ToolResult & { previewId?: string }>;
  /** Narrow per-turn availability selected from attached context and intent. */
  toolPolicy?: AiTurnToolPolicy;
  signal?: AbortSignal;
  /** Internal evidence prepared before the provider request. */
  preparedSimpleChange?: SimpleChangePrefetch;
  /** Evaluation-only route toggle. Production callers leave this enabled. */
  simpleChangePrefetch?: boolean;
}

interface AiTurnToolPolicy {
  initialTools: boolean;
  /** Evidence-driven subset used only by the prepared property route. */
  allowedModelTools?: readonly string[];
}

/** Run one user turn as an agentic loop: stream text, run any requested
 *  read-only tools (capped at MAX_TOOL_CALLS), feed results back, repeat until
 *  the model answers. Emits the AiChatEvent stream via onEvent. On cancellation
 *  it returns quietly (no done/error); on a real failure it emits `error`. */
export async function streamChat(opts: StreamChatOpts): Promise<AiTurnMetrics | null> {
  const started = Date.now();
  const meta = resolveProvider(opts.settings);
  const maxTokens = Math.min(meta.maxOutputTokens ?? CHAT_MAX_OUTPUT_TOKENS, CHAT_MAX_OUTPUT_TOKENS);
  try {
    const prepared = opts.simpleChangePrefetch === false
      ? null
      : await prefetchSimpleWidgetChange({
          text: opts.text,
          pageRid: opts.pageRid,
          executeTool: opts.executeTool,
          onEvent: opts.onEvent,
          signal: opts.signal,
        });
    const effectiveOpts: StreamChatOpts = prepared?.route
      ? {
          ...opts,
          preparedSimpleChange: prepared,
          toolPolicy: {
            ...opts.toolPolicy,
            initialTools: true,
            allowedModelTools: prepared.route.allowedModelTools,
          },
        }
      : { ...opts, ...(prepared ? { preparedSimpleChange: prepared } : {}) };
    const effectiveMaxTokens = prepared?.route
      ? Math.min(maxTokens, PREPARED_SIMPLE_CHANGE_MAX_OUTPUT_TOKENS)
      : maxTokens;
    const user = userTextWithPreparedEvidence(effectiveOpts);
    const system = providerSystem(effectiveOpts);
    const contextBudget = budgetChatHistory({
      system,
      user,
      history: effectiveOpts.history,
      maxInputTokens: meta.maxInputTokens,
      maxOutputTokens: effectiveMaxTokens,
    });
    if (contextBudget.fixedInputOverBudgetCharacters > 0) {
      throw new Error(
        'The current request and attached context exceed this model\'s configured input limit. ' +
        'Remove a large attachment or choose a model with a larger context window.',
      );
    }
    const conversationBase = {
      baseUrl: meta.baseUrl,
      model: effectiveOpts.settings.model,
      maxTokens: effectiveMaxTokens,
      apiKey: effectiveOpts.apiKey,
      system,
      history: contextBudget.history,
      user,
      signal: effectiveOpts.signal,
    };
    const conversation = meta.openAiCompat
      ? createOpenAiConversation({ ...conversationBase, maxTokensParam: meta.maxTokensParam })
      : createAnthropicConversation(conversationBase);
    const metrics = await runProviderChat(effectiveOpts, conversation);
    const withPrefetch = mergePrefetchMetrics(metrics, prepared, Date.now() - started);
    opts.onEvent({ kind: 'done' });
    return {
      ...withPrefetch,
      estimatedInputCharacters: contextBudget.estimatedInputCharacters,
      historyTurnsDropped: contextBudget.historyTurnsDropped,
    };
  } catch (e) {
    if (opts.signal?.aborted) {
      const reason = opts.signal.reason;
      if (reason instanceof DOMException && reason.name === 'TimeoutError') {
        opts.onEvent({ kind: 'error', message: reason.message });
      }
      return null; // caller cancelled, or timeout already reported above
    }
    opts.onEvent({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

/** A short human summary of a tool call for the transcript's tool trace. */
const RID_INPUT_KEYS = new Set(['ref', 'pageRid', 'focusRid']);

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
  priorResults: Map<string, string>;
  changeTargets: Map<string, ChangeTargetRecord>;
  placementRefs: Set<string>;
  collectionRefs: Set<string>;
}

/** Compatibility only for cached system/eval context authored before typed
 * tool results. Live tool output never crosses this prose parser. */
function captureLegacySystemEvidence(state: AutomaticToolState, text: string): void {
  for (const record of parseChangeTargetRecords(text)) state.changeTargets.set(record.rid, record);
  for (const match of text.matchAll(/placement container mutationRef=([A-Za-z_](?:[A-Za-z0-9_.]*[A-Za-z0-9_])?)/gi)) {
    state.placementRefs.add(match[1]);
  }
  for (const match of text.matchAll(/\bcollection\s+(root\.[A-Za-z_](?:[A-Za-z0-9_.]*[A-Za-z0-9_])?)/gi)) {
    state.collectionRefs.add(match[1]);
  }
}

function captureStructuredToolEvidence(state: AutomaticToolState, result: ToolResult): void {
  const content = result.structuredContent;
  if (isToolSuccess(content, 'read_type')) {
    for (const collection of content.data.collections) state.collectionRefs.add(collection);
    return;
  }
  if (!isToolSuccess(content, 'read_layout')) return;
  const recordTarget = (resolution: typeof content.data.pageTarget): void => {
    if (resolution.status !== 'resolved') return;
    state.changeTargets.set(resolution.target.rid, {
      rid: resolution.target.rid,
      mutationRef: resolution.target.ecRef,
      scope: resolution.scope,
    });
  };
  recordTarget(content.data.pageTarget);
  for (const node of content.data.nodes) {
    if (node.changeTarget) recordTarget(node.changeTarget);
    if (node.kind === 'container'
      && node.changeTarget?.status === 'resolved') {
      state.placementRefs.add(node.changeTarget.target.ecRef);
    }
  }
}

function capturePrefetchedContextEvidence(state: AutomaticToolState, prepared: SimpleChangePrefetch): void {
  for (const target of prepared.route?.changeTargets ?? []) {
    state.changeTargets.set(target.rid, target);
  }
}

function createAutomaticToolState(
  system: string,
  prepared?: SimpleChangePrefetch,
): AutomaticToolState {
  const state: AutomaticToolState = {
    calls: 0,
    errors: 0,
    duplicates: 0,
    tools: [],
    priorResults: new Map(),
    changeTargets: new Map(),
    placementRefs: new Set(),
    collectionRefs: new Set(),
  };
  if (prepared?.route) capturePrefetchedContextEvidence(state, prepared);
  else captureLegacySystemEvidence(state, system);
  return state;
}

function mergePrefetchMetrics(
  metrics: AiTurnMetrics,
  prepared: SimpleChangePrefetch | null,
  durationMs: number,
): AiTurnMetrics {
  if (!prepared?.executions.length) return { ...metrics, durationMs };
  const tools: AiTurnMetrics['tools'] = prepared.executions.map(execution => ({
    name: execution.call.name,
    origin: 'prefetch',
    ok: !execution.result.isError,
    duplicate: false,
    durationMs: execution.durationMs,
    outcome: execution.result.isError ? 'error' : 'success',
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

function userTextWithPreparedEvidence(opts: StreamChatOpts): string {
  const prepared = opts.preparedSimpleChange;
  if (!prepared?.evidence) return opts.text;
  const appendix = prepared.route?.promptAppendix
    ?? `<prefetched-context>${JSON.stringify(prepared.evidence)}</prefetched-context>`;
  return `${opts.text}\n\n${appendix}`;
}

function providerSystem(opts: StreamChatOpts): string {
  return opts.preparedSimpleChange?.route ? PREPARED_SIMPLE_CHANGE_SYSTEM : opts.system;
}

function modelToolAllowed(opts: StreamChatOpts, name: string): boolean {
  const allowed = opts.toolPolicy?.allowedModelTools;
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
  opts: StreamChatOpts,
  state: AutomaticToolState,
  execute: ExecuteTool = opts.executeTool,
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
  state.calls++;
  if (result.isError) state.errors++;
  const fingerprint = toolCallFingerprint(call);
  const evidenceKey = toolResultEvidenceKey(result);
  const duplicate = state.priorResults.get(fingerprint) === evidenceKey;
  if (duplicate) state.duplicates++;
  state.priorResults.set(fingerprint, evidenceKey);
  state.tools.push({
    name: call.name,
    origin: 'pipeline',
    ok: !result.isError,
    duplicate,
    durationMs,
    outcome: result.isError ? 'error' : duplicate ? 'duplicate' : 'success',
  });
  opts.onEvent({
    kind: 'tool-end',
    name: call.name,
    summary,
    ok: !result.isError,
    durationMs,
    duplicate,
    objects: result.objects,
  });
  return result;
}

async function previewFinalTicket(
  ticket: string,
  opts: StreamChatOpts,
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
  const targetRid = proposal.target
    ? /^\[\[object:(-?\d+)\]\]$/.exec(proposal.target.trim())?.[1]
    : undefined;
  const outerResult = await executeAutomaticPreview(
    code,
    opts,
    state,
    opts.executeChangePreview
      ? (_call, signal) => opts.executeChangePreview!({ code, ...(targetRid ? { targetRid } : {}) }, signal)
      : opts.executeTool,
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
  opts: StreamChatOpts,
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
    const initiallyDisabled = opts.toolPolicy?.initialTools === false;
    const allowTools = !initiallyDisabled && !goalSatisfied && limitReason === undefined;
    // On the forced tools-off turn, tell the model WHY tools vanished so it
    // answers instead of emitting tool-call syntax as plain text (Issue A).
    if (!allowTools && !initiallyDisabled && !notedFinal) {
      appendFinalNote(goalSatisfied ? CHANGE_PREVIEW_SATISFIED_NOTE : TOOL_BUDGET_EXHAUSTED_NOTE);
      notedFinal = true;
      if (!goalSatisfied) budgetExhausted = true;
    }
    const toolCalls = await runTurn(allowTools);
    // A tools-off turn (or a turn that asked for nothing) is the final answer.
    if (!allowTools || toolCalls.length === 0) {
      return {
        durationMs: Date.now() - started,
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
        toolRounds,
        toolCallsRequested: requested,
        toolCallsExecuted: used,
        automaticToolCalls: 0,
        previewDurationMs: 0,
        modelToolDurationMs: tools
          .filter(tool => tool.origin === 'model')
          .reduce((sum, tool) => sum + tool.durationMs, 0),
        duplicateCalls: duplicates,
        toolErrors,
        budgetExhausted,
        tools,
        ...(limitReason ? { limitReason } : {}),
      };
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
      tools.push({ name: call.name, origin: 'model', ok: !result.isError, duplicate, durationMs, outcome });
      opts.onEvent({
        kind: 'tool-end',
        name: call.name,
        summary,
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
  providerRequests: number;
  providerDurationMs: number;
  usage: AiTokenUsage;
  terminalOutcome?: AiTurnMetrics['terminalOutcome'];
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
    providerRequests: state.providerRequests,
    providerDurationMs: state.providerDurationMs,
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
  opts: StreamChatOpts,
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
  opts: StreamChatOpts,
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
    appendUserNote(`Automatic Preview of the exact Change Ticket failed:\n${preview.content}\nRepair the ticket from this error and return exactly one corrected crev-change ticket. Do not restart discovery.`);
    structuredFinal = true;
    state.previewRepairRetries++;
    state.modelRetries++;
    current = await request(structuredFinal);
  }
  if (current.toolCalls.length === 0 && current.visible) {
    opts.onEvent({ kind: 'text-delta', delta: current.changeTicket ? isolateValidChangeTicket(current.visible) : current.visible });
  }
  if (current.outcome !== 'none') state.terminalOutcome = current.outcome;
  if (!current.structuredSubmission) current.appendAssistant();
  return current.toolCalls;
}

function captureProviderToolResults(
  state: ProviderPolicyState,
  results: readonly { call: ToolCall; result: ToolResult }[],
): void {
  for (const { result } of results) {
    if (!result.isError) captureStructuredToolEvidence(state.automaticTools, result);
  }
}

async function runProviderChat(
  opts: StreamChatOpts,
  conversation: ProviderConversation,
): Promise<AiTurnMetrics> {
  const state: ProviderPolicyState = {
    modelRetries: 0,
    emptyResponseRetries: 0,
    previewRepairRetries: 0,
    hasSuccessfulChangePreview: false,
    automaticTools: createAutomaticToolState(opts.system, opts.preparedSimpleChange),
    providerRequests: 0,
    providerDurationMs: 0,
    usage: emptyUsage(),
  };

  const runTurn = async (
    allowTools: boolean,
  ): Promise<ToolCall[]> => {
    return finalizeProviderTurn(opts, state, async structuredFinal => {
      const requestStarted = Date.now();
      state.providerRequests++;
      try {
        const preparedChoice = !!opts.preparedSimpleChange?.route && !structuredFinal;
        const finalOnly = structuredFinal;
        const selectable = allowTools
          ? TOOL_DEFS.filter(tool => modelToolAllowed(opts, tool.name))
          : [];
        const terminal = preparedChoice
          ? [answerUserDef(), submitChangeTicketDef(state.automaticTools, true)]
          : allowTools
            ? [submitChangeTicketDef(state.automaticTools)]
            : [];
        const turn = await conversation.requestTurn({
          tools: finalOnly ? terminal : [...selectable, ...terminal],
          ...(finalOnly
            ? { forceTool: SUBMIT_CHANGE_TICKET }
            : preparedChoice ? { requireTool: true } : {}),
        });
        addUsage(state.usage, turn.usage);
        return normalizeProviderTurn(opts, turn.text, turn.toolCalls, turn.appendAssistant);
      } finally {
        state.providerDurationMs += Date.now() - requestStarted;
      }
    }, conversation.appendUserNote);
  };

  const appendResults = (results: Array<{ call: ToolCall; result: ToolResult }>): void => {
    captureProviderToolResults(state, results);
    conversation.appendToolResults(results);
  };

  const metrics = await runToolLoop(runTurn, appendResults, conversation.appendFinalNote, opts);
  return {
    ...withProviderMetrics(withAutomaticTools(metrics, state.automaticTools), state),
    modelRetries: state.modelRetries,
    emptyResponseRetries: state.emptyResponseRetries,
    previewRepairRetries: state.previewRepairRetries,
  };
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
