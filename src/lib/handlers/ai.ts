/**
 * AI coding-assistant handlers.
 *
 * Config CRUD (get/save/remove), the connection test, and model listing are
 * one-shot request/response. A completion (AI_REQUEST) is fire-and-forget: the
 * reply streams back as AI_CHUNK / AI_DONE / AI_ERROR broadcasts keyed by
 * requestId (the same broadcast primitive Code Search uses), and AI_CANCEL
 * aborts an in-flight request.
 *
 * The API key lives ONLY in the service worker — stored AES-GCM encrypted in
 * settings.ai.apiKeyEnc, decrypted here on the way to a provider request, never
 * sent to a UI surface.
 */

import { register } from '../handler-registry';
import { getCtx } from '../sw-context';
import type { AiSettings, InspectorMessage, InspectorSettings, ObjectReference } from '../types';
import { saveSettings, snapshotSettings } from '../settings';
import { encrypt, decrypt } from '../crypto';
import { sendFireForget } from '../messaging';
import { streamCompletion, streamChat, testConnection, listModels } from '../ai/client';
import { buildChatSystem } from '../ai/sidebar-prompt';
import { executeAiTool } from './ai-tools';
import { buildWorkspacePrimer } from './ai-primer';
import { openExtendedWindow } from '../editor';
import { parseCustomProviderJson, resolveProvider } from '../ai/providers';
import { errorMessage, log } from '../logger';
import { reconcileProfileOrigins } from '../site-access';
import { ChangeTicketLifecycle, type ChangePreviewScope, type ChangeTicketTargetContext } from '../ai/change-ticket';
import type { ToolResult } from '../ai/tools';
import type { BmpClient } from '../bmp-client';
import {
  editorContextForTab,
  isCurrentEditorContext,
  storeEditorContext,
} from '../ai/editor-context';

/** In-flight completions, keyed by requestId — AI_CANCEL aborts them. */
const inflight = new Map<string, AbortController>();
export const AI_CHAT_DEADLINE_MS = 45_000;

const CHANGE_PREVIEW_TTL_MS = 10 * 60_000;
/** Capabilities deliberately live only in SW memory. An MV3 restart
 * invalidates them, forcing a fresh Preview before any Run. */
const changePreviews = new ChangeTicketLifecycle(CHANGE_PREVIEW_TTL_MS);

function changePreviewScope(client: BmpClient | null = getCtx().client): ChangePreviewScope | null {
  const ctx = getCtx();
  if (!client?.commandUser) return null;
  return {
    profileId: ctx.settings.activeProfileId,
    serverUrl: client.serverUrl,
    actor: client.commandUser,
  };
}

function ecResultText(result: { log?: string; error?: string }, fallback: string): string {
  return result.error ?? result.log ?? fallback;
}

/** One implementation for both generation-time validation and the card's
 * explicit Preview action. Successful final-change Preview issues the same
 * exact-code, environment-bound capability consumed by Run. */
async function previewChangeCode(
  code: string,
  expectedTarget?: ChangeTicketTargetContext,
  signal?: AbortSignal,
): Promise<ToolResult & { previewId?: string }> {
  const ctx = getCtx();
  const clientAtStart = ctx.client;
  if (!clientAtStart) return { content: 'Not connected to BMP', isError: true };
  const profileAtStart = ctx.settings.activeProfileId;
  const serverAtStart = clientAtStart.serverUrl;
  const trimmed = code.trim();
  if (!trimmed) return { content: 'The proposal contains no Extended Code.', isError: true };
  try {
    const result = signal
      ? await clientAtStart.executeEc(trimmed, undefined, false, signal)
      : await clientAtStart.executeEc(trimmed, undefined, false);
    if (!result.ok || result.hasWarning) {
      return {
        content: result.hasWarning
          ? `Preview returned a warning: ${ecResultText(result, 'Review the code before running.')}`
          : ecResultText(result, 'Preview failed.'),
        isError: true,
      };
    }
    const current = getCtx();
    if (current.client !== clientAtStart
      || current.settings.activeProfileId !== profileAtStart
      || clientAtStart.serverUrl !== serverAtStart) {
      return { content: 'The BMP connection changed during Preview. Preview again.', isError: true };
    }
    const scope = changePreviewScope(clientAtStart);
    if (!scope) {
      return { content: 'The command identity could not be verified. Reconnect and Preview again.', isError: true };
    }
    const content = ecResultText(result, 'Preview successful');
    return {
      content,
      isError: false,
      previewId: changePreviews.issue(trimmed, scope, content, expectedTarget),
    };
  } catch (error) {
    return { content: errorMessage(error), isError: true };
  }
}

function aiConfig(): AiSettings | undefined {
  return getCtx().settings.ai;
}

register('AI_GET_CONFIG', (_msg, respond) => {
  const ai = aiConfig();
  respond({ type: 'AI_CONFIG_DATA', configured: !!ai?.apiKeyEnc, provider: ai?.provider, model: ai?.model, customProvider: ai?.customProvider });
});

register('AI_SAVE_CONFIG', async (msg, respond) => {
  const ctx = getCtx();
  try {
    const prev = ctx.settings.ai;
    // Keep the existing key when the panel only changes provider/model.
    let apiKeyEnc = prev?.apiKeyEnc ?? '';
    if (msg.apiKey) apiKeyEnc = await encrypt(msg.apiKey);
    if (msg.provider === 'custom' && !prev?.customProvider) throw new Error('Import custom provider JSON first');
    const ai: AiSettings = {
      provider: msg.provider,
      model: msg.model,
      apiKeyEnc,
      ...(prev?.customProvider ? { customProvider: prev.customProvider } : {}),
    };
    resolveProvider(ai); // validate provider/model before persisting
    ctx.settings = { ...ctx.settings, ai };
    await saveSettings();
    snapshotSettings();
    await reconcileProfileOrigins(ctx.settings.profiles.map(p => p.bmpUrl), ai);
    respond({ type: 'AI_CONFIG_SAVED', ok: true, configured: !!apiKeyEnc, provider: ai.provider, model: ai.model, customProvider: ai.customProvider });
    // Notify open editor / studio surfaces so the assistant appears live.
    sendFireForget({ type: 'AI_CONFIG_CHANGED', configured: !!apiKeyEnc, provider: ai.provider, model: ai.model, customProvider: ai.customProvider });
  } catch (e) {
    respond({ type: 'AI_CONFIG_SAVED', ok: false, configured: !!aiConfig()?.apiKeyEnc, error: errorMessage(e) });
  }
});

register('AI_SAVE_CUSTOM_PROVIDER', async (msg, respond) => {
  const ctx = getCtx();
  try {
    const parsed = parseCustomProviderJson(msg.json);
    const prev = ctx.settings.ai;
    let apiKeyEnc = prev?.provider === 'custom' ? prev.apiKeyEnc : '';
    if (parsed.apiKey) apiKeyEnc = await encrypt(parsed.apiKey);
    if (!apiKeyEnc) throw new Error('apiKey is required when adding a custom provider');
    const model = parsed.provider.models.find(item => item.toolCalling)?.id ?? parsed.provider.models[0].id;
    const ai: AiSettings = { provider: 'custom', model, apiKeyEnc, customProvider: parsed.provider };
    resolveProvider(ai);
    ctx.settings = { ...ctx.settings, ai };
    await saveSettings();
    snapshotSettings();
    await reconcileProfileOrigins(ctx.settings.profiles.map(p => p.bmpUrl), ai);
    respond({ type: 'AI_CONFIG_SAVED', ok: true, configured: true, provider: 'custom', model, customProvider: parsed.provider });
    sendFireForget({ type: 'AI_CONFIG_CHANGED', configured: true, provider: 'custom', model, customProvider: parsed.provider });
  } catch (e) {
    respond({ type: 'AI_CONFIG_SAVED', ok: false, configured: !!aiConfig()?.apiKeyEnc, error: errorMessage(e) });
  }
});

register('AI_REMOVE_CONFIG', async (_msg, respond) => {
  const ctx = getCtx();
  const next = { ...ctx.settings };
  delete (next as Partial<InspectorSettings>).ai;
  ctx.settings = next;
  await saveSettings();
  snapshotSettings();
  await reconcileProfileOrigins(ctx.settings.profiles.map(p => p.bmpUrl), undefined);
  respond({ type: 'AI_CONFIG_SAVED', ok: true, configured: false });
  // Notify open editor / studio surfaces so the assistant disappears live.
  sendFireForget({ type: 'AI_CONFIG_CHANGED', configured: false });
});

register('AI_TEST', async (_msg, respond) => {
  const ctx = getCtx();
  const ai = aiConfig();
  if (!ai?.apiKeyEnc) { respond({ type: 'AI_TEST_RESULT', ok: false, error: 'No API key configured' }); return; }
  try {
    const key = await decrypt(ai.apiKeyEnc);
    const started = Date.now();
    const res = await testConnection(ai, key);
    const ms = Date.now() - started;
    // Persist the outcome (key-free) so the Connect tab's AI card can render
    // READY + latency after a reload. Survives in the session snapshot.
    ctx.settings = { ...ctx.settings, ai: { ...ai, lastTest: { ok: res.ok, ms, at: Date.now() } } };
    await saveSettings();
    snapshotSettings();
    respond({ type: 'AI_TEST_RESULT', ok: res.ok, model: ai.model, ms, error: res.error });
  } catch (e) {
    respond({ type: 'AI_TEST_RESULT', ok: false, error: errorMessage(e) });
  }
});

register('AI_LIST_MODELS', async (msg, respond) => {
  const ai = aiConfig();
  if (!ai?.apiKeyEnc) { respond({ type: 'AI_MODELS_RESULT', ok: false, error: 'No API key configured' }); return; }
  let meta;
  try { meta = resolveProvider({ ...ai, provider: msg.provider }); }
  catch (e) { respond({ type: 'AI_MODELS_RESULT', ok: false, error: errorMessage(e) }); return; }
  if (!meta.openAiCompat) {
    respond({ type: 'AI_MODELS_RESULT', ok: false, error: 'Model listing is not available for this provider' });
    return;
  }
  try {
    const key = await decrypt(ai.apiKeyEnc);
    // Probe against the provider the panel is asking about, using the stored
    // model as a placeholder (listModels ignores it).
    const models = await listModels({ ...ai, provider: msg.provider }, key);
    respond({ type: 'AI_MODELS_RESULT', ok: true, models });
  } catch (e) {
    respond({ type: 'AI_MODELS_RESULT', ok: false, error: errorMessage(e) });
  }
});

register('AI_REQUEST', async (msg) => {
  const ctx = getCtx();
  const { payload } = msg;
  const rid = payload.requestId;
  const broadcast = (m: InspectorMessage) => sendFireForget(m);

  const ai = ctx.settings.ai;
  if (!ai?.apiKeyEnc) { broadcast({ type: 'AI_ERROR', requestId: rid, message: 'No API key configured' }); return; }

  const controller = new AbortController();
  inflight.set(rid, controller);
  try {
    const key = await decrypt(ai.apiKeyEnc);
    await streamCompletion({
      settings: ai,
      apiKey: key,
      payload,
      signal: controller.signal,
      onChunk: (delta) => broadcast({ type: 'AI_CHUNK', requestId: rid, delta }),
    });
    broadcast({ type: 'AI_DONE', requestId: rid });
    ctx.logActivity('info', `AI ${payload.intent} (${ai.model})`);
  } catch (e) {
    // A caller-initiated abort is not an error — the UI already reset.
    if (controller.signal.aborted) {
      log.debug('handler:ai', `AI request ${rid} aborted`);
    } else {
      broadcast({ type: 'AI_ERROR', requestId: rid, message: errorMessage(e) });
      ctx.logActivity('warn', `AI ${payload.intent} failed`, errorMessage(e));
    }
  } finally {
    inflight.delete(rid);
  }
});

register('AI_CANCEL', (msg) => {
  const controller = inflight.get(msg.requestId);
  if (controller) { controller.abort(); inflight.delete(msg.requestId); }
});

// ── Chat (tool-using conversation) ───────────────────────────────

const PRIMER_SUCCESS_TTL_MS = 10 * 60_000;
const PRIMER_FAILURE_TTL_MS = 30_000;
interface CachedPrimer { value: string | null; expiresAt: number }
/** Cache by complete live environment identity, not only editable profile id. */
const primerByServer = new Map<string, CachedPrimer>();
const primerInflightByServer = new Map<string, Promise<string | null>>();

/** Get (and lazily build + cache) the workspace primer for a server. Degrades
 *  to null on any failure. Cheap after the first turn (one Map lookup). */
async function workspacePrimerFor(serverId: string, signal?: AbortSignal): Promise<string | null> {
  const cached = primerByServer.get(serverId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  if (cached) primerByServer.delete(serverId);
  const pending = primerInflightByServer.get(serverId);
  if (pending) return pending;
  const ctx = getCtx();
  if (!ctx.client) return null;
  const request = buildWorkspacePrimer(ctx.client, signal).then(primer => {
    primerByServer.set(serverId, {
      value: primer,
      expiresAt: Date.now() + (primer ? PRIMER_SUCCESS_TTL_MS : PRIMER_FAILURE_TTL_MS),
    });
    return primer;
  });
  primerInflightByServer.set(serverId, request);
  try {
    return await request;
  } finally {
    if (primerInflightByServer.get(serverId) === request) primerInflightByServer.delete(serverId);
  }
}

register('AI_CHAT_SEND', async (msg) => {
  const ctx = getCtx();
  const rid = msg.requestId;
  const emit = (event: import('../ai/types').AiChatEvent) =>
    sendFireForget({ type: 'AI_CHAT_EVENT', requestId: rid, event });

  const ai = ctx.settings.ai;
  if (!ai?.apiKeyEnc) { emit({ kind: 'error', message: 'No API key configured' }); return; }

  const controller = new AbortController();
  const timeoutReason = new DOMException(
    'The AI request exceeded 45 seconds and was stopped. Nothing was executed.',
    'TimeoutError',
  );
  const deadline = setTimeout(() => controller.abort(timeoutReason), AI_CHAT_DEADLINE_MS);
  let streamStarted = false;
  inflight.set(rid, controller);
  try {
    const key = await decrypt(ai.apiKeyEnc);
    const primerEnvironment = [
      msg.envelope.server.id,
      ctx.client?.serverUrl ?? msg.envelope.server.url,
      ctx.client?.username ?? '',
    ].join('\u0000');
    const primer = await workspacePrimerFor(primerEnvironment, controller.signal);
    const { system } = buildChatSystem(msg.envelope, primer);
    const knownObjects = new Map<string, ObjectReference>(
      msg.envelope.sources.map(source => [source.object.rid, source.object]),
    );
    streamStarted = true;
    const metrics = await streamChat({
      settings: ai,
      apiKey: key,
      system,
      history: msg.history,
      text: msg.text,
      pageRid: msg.envelope.page?.rid,
      onEvent: emit,
      executeTool: async (call, signal) => {
        const result = await executeAiTool(call, signal, msg.envelope);
        result.objects?.forEach(object => knownObjects.set(object.rid, object));
        return result;
      },
      executeChangePreview: ({ code, targetRid }, signal) => {
        const target = targetRid ? knownObjects.get(targetRid) : undefined;
        return previewChangeCode(code, targetRid ? {
          rid: targetRid,
          ...(target?.businessId ? { businessId: target.businessId } : {}),
        } : undefined, signal);
      },
      signal: controller.signal,
    });
    if (metrics) {
      ctx.logActivity(
        metrics.toolErrors ? 'warn' : 'info',
        `AI chat (${ai.model})`,
        JSON.stringify(metrics),
        { category: 'system', action: 'ai-eval-trace', durationMs: metrics.durationMs },
      );
    }
  } catch (e) {
    // streamChat handles its own done/error events; this guards decrypt /
    // prompt-build failures before the stream starts.
    if (!controller.signal.aborted) emit({ kind: 'error', message: errorMessage(e) });
    else if (!streamStarted && controller.signal.reason === timeoutReason) {
      emit({ kind: 'error', message: timeoutReason.message });
    }
  } finally {
    clearTimeout(deadline);
    inflight.delete(rid);
  }
});

register('AI_CHAT_CANCEL', (msg) => {
  const controller = inflight.get(msg.requestId);
  if (controller) { controller.abort(); inflight.delete(msg.requestId); }
});

register('AI_PREVIEW_CODE', async (msg, respond) => {
  const ctx = getCtx();
  if (!ctx.client) { respond({ type: 'AI_PREVIEW_RESULT', requestId: msg.requestId, purpose: 'verification', ok: false, resultText: 'Not connected to BMP' }); return; }
  try {
    const res = await ctx.client.executeEc(msg.code, undefined, false);
    respond({
      type: 'AI_PREVIEW_RESULT',
      requestId: msg.requestId,
      purpose: 'verification',
      ok: res.ok && !res.hasWarning,
      resultText: res.hasWarning
        ? `Preview returned a warning: ${res.log ?? res.error ?? 'Review the code.'}`
        : res.ok ? (res.log ?? '(no output)') : (res.error ?? res.log ?? 'EC error'),
    });
  } catch (e) {
    respond({ type: 'AI_PREVIEW_RESULT', requestId: msg.requestId, purpose: 'verification', ok: false, resultText: errorMessage(e) });
  }
});

register('AI_PREVIEW_CHANGE', async (msg, respond) => {
  const reply = (
    ok: boolean,
    resultText: string,
    previewId?: string,
    runnable = false,
  ) => respond({
    type: 'AI_PREVIEW_CHANGE_RESULT',
    requestId: msg.requestId,
    purpose: 'change',
    ok,
    resultText,
    previewId,
    runnable,
  });
  const result = await previewChangeCode(msg.proposal.code, msg.expectedTarget);
  reply(!result.isError, result.content, result.previewId, !result.isError && !!result.previewId);
});

register('AI_RUN_CHANGE', async (msg, respond) => {
  const ctx = getCtx();
  const reply = (ok: boolean, resultText: string, partial?: boolean) => respond({
    type: 'AI_RUN_CHANGE_RESULT', requestId: msg.requestId, ok, resultText, ...(partial ? { partial } : {}),
  });
  const clientAtStart = ctx.client;
  if (!clientAtStart) { reply(false, 'Not connected to BMP'); return; }
  const scope = changePreviewScope(clientAtStart);
  if (!scope) { reply(false, 'Not connected to BMP'); return; }
  const preview = changePreviews.consume(msg.previewId, scope);
  if (!preview.ok && (preview.reason === 'missing' || preview.reason === 'expired')) {
    reply(false, 'Preview expired. Preview the change again before running.');
    return;
  }
  if (!preview.ok) {
    reply(false, 'The active environment changed. Preview the change again.');
    return;
  }
  try {
    const execution = await clientAtStart.executeEc(preview.code, undefined, true);
    if (!execution.ok || execution.hasWarning) {
      const detail = execution.hasWarning
        ? `Run returned a warning: ${ecResultText(execution, 'Read back the affected objects before retrying.')}`
        : ecResultText(execution, 'Run failed. Read back the affected objects before retrying.');
      ctx.logActivity('error', 'AI Change Ticket run needs review', detail, { category: 'execution', action: 'ai-change-run' });
      reply(false, detail, true);
      return;
    }
    const detail = ecResultText(execution, 'Executed successfully.');
    ctx.logActivity('success', 'AI Change Ticket executed', detail, { category: 'execution', action: 'ai-change-run' });
    reply(true, detail);
  } catch (e) {
    const detail = errorMessage(e);
    ctx.logActivity('error', 'AI Change Ticket run failed', detail, { category: 'execution', action: 'ai-change-run' });
    reply(false, detail, true);
  }
});

register('AI_APPLY_PROPOSAL', (msg) => {
  // Relay to the open editor/studio surface (a separate page from the panel),
  // which shows the standard merge-diff proposal for target { rid, slot }.
  sendFireForget(msg);
});

register('AI_INSERT_AT_CURSOR', (msg) => {
  // Relay to the open editor/studio surface, which inserts the code at its
  // cursor behind the standard merge-diff proposal for target { rid, slot }.
  sendFireForget(msg);
});

register('AI_OPEN_IN_EDITOR', (msg, _respond, meta) => {
  // Chat "Open in editor" (no editor chip attached): launch the Extended Code
  // editor in free-script mode preloaded with the block's code, mounted on the
  // panel window's active BMP tab (same target rule as OPEN_EXTENDED).
  //
  // Limitation (documented): if a free-script editor is ALREADY open, this
  // opens a second one — the SW cannot cheaply detect a scratch editor (it
  // broadcasts no object identity, so AI_EDITOR_CONTEXT stays null for it).
  // The attached-editor case is already covered by the code block's Apply
  // button (AI_APPLY_PROPOSAL → propose()); this action only shows when NO
  // editor chip is attached.
  openExtendedWindow(undefined, { tabId: meta.senderTabId, windowId: meta.panelWindowId }, msg.code)
    .catch(e => log.swallow('ai:openInEditor', e));
});

// ── Editor context (drives the chat tab's 'editor' chip) ─────────
// Editor frames are hosted by BMP tabs. Store their context per tab and route
// only the ACTIVE tab's value to the side panel attached to that Chrome window.
// The request/response message types are intentionally distinct: a raw
// chrome.runtime message from one editor must never update every open panel.
register('AI_EDITOR_CONTEXT_UPDATE', async (msg, _respond, meta) => {
  const tabId = meta.senderTabId;
  if (tabId == null) return;
  const generation = storeEditorContext(tabId, msg.source);
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!isCurrentEditorContext(tabId, generation) || !tab.active || tab.windowId == null) return;
    getCtx().sendToPanelByWindow(tab.windowId, {
      type: 'AI_EDITOR_CONTEXT',
      source: editorContextForTab(tabId),
    });
  } catch (e) {
    log.swallow('ai:editorContextUpdate', e);
  }
});

register('AI_GET_EDITOR_CONTEXT', async (_msg, respond, meta) => {
  if (meta.panelWindowId == null) {
    respond({ type: 'AI_EDITOR_CONTEXT', source: null });
    return;
  }
  try {
    const active = await chrome.tabs.query({ active: true, windowId: meta.panelWindowId });
    respond({ type: 'AI_EDITOR_CONTEXT', source: editorContextForTab(active[0]?.id) });
  } catch (e) {
    log.swallow('ai:getEditorContext', e);
    respond({ type: 'AI_EDITOR_CONTEXT', source: null });
  }
});

register('AI_CHAT_HANDOFF', (msg, _respond, meta) => {
  const ctx = getCtx();
  // Open the side panel on the sender's tab (same gesture as SELECT_OBJECT
  // openPanel). No-op when already open; the forwarded message survives panel
  // startup via pendingPanelMessages.
  if (meta.senderTabId != null) {
    chrome.sidePanel.open({ tabId: meta.senderTabId }).catch(e => log.swallow('ai:handoff:open', e));
  }
  ctx.sendToPanel(msg);
});
