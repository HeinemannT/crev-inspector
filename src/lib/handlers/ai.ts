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
import type { AiSettings, InspectorMessage, InspectorSettings } from '../types';
import { saveSettings, snapshotSettings } from '../settings';
import { encrypt, decrypt } from '../crypto';
import { sendFireForget } from '../messaging';
import { streamCompletion, streamChat, testConnection, listModels } from '../ai/client';
import { buildChatSystem } from '../ai/prompt';
import { executeAiTool } from './ai-tools';
import { buildWorkspacePrimer } from './ai-primer';
import { openExtendedWindow } from '../editor';
import { parseCustomProviderJson, resolveProvider } from '../ai/providers';
import { errorMessage, log } from '../logger';
import { reconcileProfileOrigins } from '../site-access';

/** In-flight completions, keyed by requestId — AI_CANCEL aborts them. */
const inflight = new Map<string, AbortController>();

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
  void reconcileProfileOrigins(ctx.settings.profiles.map(p => p.bmpUrl), undefined);
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

/** Workspace primer cache, keyed by server id (envelope.server.id). Built once
 *  per server on the first chat turn; a different active profile keys a
 *  different entry so a profile switch never reuses another server's map.
 *  `null` = the probe ran but failed / was empty (don't re-probe every turn). */
const primerByServer = new Map<string, string | null>();

/** Get (and lazily build + cache) the workspace primer for a server. Degrades
 *  to null on any failure. Cheap after the first turn (one Map lookup). */
async function workspacePrimerFor(serverId: string, signal?: AbortSignal): Promise<string | null> {
  if (primerByServer.has(serverId)) return primerByServer.get(serverId) ?? null;
  const ctx = getCtx();
  if (!ctx.client) return null;
  const primer = await buildWorkspacePrimer(ctx.client, signal);
  primerByServer.set(serverId, primer);
  return primer;
}

register('AI_CHAT_SEND', async (msg) => {
  const ctx = getCtx();
  const rid = msg.requestId;
  const emit = (event: import('../ai/types').AiChatEvent) =>
    sendFireForget({ type: 'AI_CHAT_EVENT', requestId: rid, event });

  const ai = ctx.settings.ai;
  if (!ai?.apiKeyEnc) { emit({ kind: 'error', message: 'No API key configured' }); return; }

  const controller = new AbortController();
  inflight.set(rid, controller);
  try {
    const key = await decrypt(ai.apiKeyEnc);
    const primer = await workspacePrimerFor(msg.envelope.server.id, controller.signal);
    const { system } = buildChatSystem(msg.envelope, primer);
    await streamChat({
      settings: ai,
      apiKey: key,
      system,
      history: msg.history,
      text: msg.text,
      onEvent: emit,
      executeTool: (call, signal) => executeAiTool(call, signal, msg.envelope),
      signal: controller.signal,
    });
    ctx.logActivity('info', `AI chat (${ai.model})`);
  } catch (e) {
    // streamChat handles its own done/error events; this guards decrypt /
    // prompt-build failures before the stream starts.
    if (!controller.signal.aborted) emit({ kind: 'error', message: errorMessage(e) });
  } finally {
    inflight.delete(rid);
  }
});

register('AI_CHAT_CANCEL', (msg) => {
  const controller = inflight.get(msg.requestId);
  if (controller) { controller.abort(); inflight.delete(msg.requestId); }
});

register('AI_PREVIEW_CODE', async (msg, respond) => {
  const ctx = getCtx();
  if (!ctx.client) { respond({ type: 'AI_PREVIEW_RESULT', requestId: msg.requestId, ok: false, resultText: 'Not connected to BMP' }); return; }
  try {
    const res = await ctx.client.executeEc(msg.code, undefined, false);
    respond({
      type: 'AI_PREVIEW_RESULT',
      requestId: msg.requestId,
      ok: res.ok,
      resultText: res.ok ? (res.log ?? '(no output)') : (res.error ?? res.log ?? 'EC error'),
    });
  } catch (e) {
    respond({ type: 'AI_PREVIEW_RESULT', requestId: msg.requestId, ok: false, resultText: errorMessage(e) });
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
// The editor / studio broadcast their open object+slot via chrome.runtime
// .sendMessage — which reaches the sidepanel page directly AND this handler.
// We persist the last value so a panel that opens AFTER the editor can sync
// via AI_GET_EDITOR_CONTEXT. No re-broadcast here (the panel already heard the
// original), just durable state for the late-open case.
let editorContext: import('../ai/types').AiContextSource | null = null;

register('AI_EDITOR_CONTEXT', (msg) => {
  editorContext = msg.source;
});

register('AI_GET_EDITOR_CONTEXT', (_msg, respond) => {
  respond({ type: 'AI_EDITOR_CONTEXT', source: editorContext });
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
