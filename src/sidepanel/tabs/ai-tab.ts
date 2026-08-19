/**
 * AI chat tab — a tool-using conversation grounded in the workspace context
 * (the Inspect selection and any open editor / studio). Session-lived: the
 * transcript lives in this instance and dies when the panel closes.
 *
 * Wiring:
 *   - send:   AI_CHAT_SEND { requestId, text, history, envelope } (fire-forget)
 *   - stream: AI_CHAT_EVENT broadcasts routed here by sidepanel.ts via
 *             chrome.runtime.onMessage (the panel's port does NOT carry these).
 *   - cancel: AI_CHAT_CANCEL { requestId }
 *   - block Preview / Fix it: AI_PREVIEW_CODE → AI_PREVIEW_RESULT (one-shot)
 *   - block Apply: AI_APPLY_PROPOSAL { code, target:{rid, slot} } (fire-forget)
 *   - handoff: sidepanel calls submitHandoff() with the strip's message.
 *
 * Context chips = envelope.sources, 1:1. The object chip follows the current
 * page / Inspect selection (S.context) unless pinned; the editor chip mirrors
 * the editor/studio hosted by this Chrome window's active BMP tab.
 */

import type { Tab, SendFn } from './tab-types';
import type { InspectorMessage, ObjectReference } from '../../lib/types';
import type {
  AiChatTurn, AiChatQuote, AiContextEnvelope, AiContextSource,
} from '../../lib/ai/types';
import { h, svg, statusFlash } from '../../lib/dom';
import { confirmModal } from '../../lib/modal';
import { typeBadge } from '../../lib/type-badge';
import { objectChip } from '../../lib/object-chip';
import { ICON_SPARKLE, ICON_X, ICON_COPY, ICON_PIN, ICON_REFRESH, ICON_PENCIL, ICON_CHECK, ICON_CHECK_CIRCLE, ICON_X_CIRCLE, ICON_CODE, ICON_CODE_BLOCK, ICON_EYE, ICON_PLAY, ICON_ARROW_SQUARE_IN, ICON_SWAP, ICON_TERMINAL_WINDOW, ICON_CARET_DOWN, ICON_INFO } from '../../lib/icons';
import {
  changeTicketTargetRid,
  parseChangeProposal,
  type AiChangeProposal,
  type ChangeTicketState,
} from '../../lib/ai/change-ticket';
import { parsePreviewReceipt, type PreviewReceiptEvent } from '../../lib/ai/preview-receipt';
import { scrubModelReasoning } from '../../lib/ai/scrub';
import { sendFireForget, sendRequest } from '../../lib/messaging';
import { showToast } from '../../lib/toast';
import { S } from '../state';
import { renderInlineMarkdown, renderMarkdown } from './ai-markdown';
import {
  type StreamState, initStream, reduceStream, cancelStream, isTerminal,
  toAssistantTurn, prepareRetry, prepareEdit,
} from './ai-chat-state';

/** One committed transcript turn plus display-only meta the canonical
 *  AiChatTurn doesn't carry (the divergence tag). */
interface DisplayTurn {
  turn: AiChatTurn;
  /** "using editor · <bid>" — set on assistant turns produced with 2 sources. */
  contextTag?: string;
  /** View-only: whether the committed tool trace is expanded. Historical turns
   *  render collapsed by default; the flag persists an explicit expand across
   *  re-renders. */
  toolsExpanded?: boolean;
}

export class AiTab implements Tab {
  private container: HTMLElement | null = null;
  private send: SendFn;

  // ── Conversation ────────────────────────────────────────────────
  private transcript: DisplayTurn[] = [];
  private stream: StreamState | null = null;
  private activeRequestId: string | null = null;
  /** Interactive artifact state is keyed by exact scripts, so a normal chat
   * rerender cannot silently discard a successful preview or run result. */
  private changeTickets = new Map<string, ChangeTicketState>();
  /** Divergence tag captured at send time, shown once the reply commits. */
  private pendingTag: string | undefined;

  // ── Context (chips = envelope.sources) ──────────────────────────
  /** Editor/studio context for this window's active BMP tab, or null. */
  private editorSource: AiContextSource | null = null;
  /** Frozen selection snapshot when the user pins the selection chip. */
  private pinnedSelection: AiContextSource | null = null;
  /** The viewed page remains the default while a user-selected object acts as
   * an override. Keep its best-known identity so detaching that override can
   * reveal the webpage again without a lookup or prompt-layer workaround. */
  private webpageSelection: AiContextSource | null = null;
  private selectionPinned = false;
  /** RIDs the user detached this session (hidden until the source changes).
   *  Selection detaches apply only to explicit object overrides: the viewed
   *  page is the invariant fallback and cannot itself be detached. */
  private detachedSelectionRid: string | null = null;
  private detachedEditorRid: string | null = null;

  // ── Persistent composer nodes (reused across renders) ───────────
  private textarea: HTMLTextAreaElement | null = null;
  private threadEl: HTMLElement | null = null;
  /** Footer context cell — holds the chips, or the no-context hint. */
  private ctxEl: HTMLElement | null = null;
  private streamReplyEl: HTMLElement | null = null;
  private draft = '';
  private escHandler: ((e: KeyboardEvent) => void) | null = null;

  // ── Edit-last-message state ─────────────────────────────────────
  /** True while the composer holds the last user turn for revision. */
  private editing = false;
  /** The original user turn's via/quote, reattached when the edit resubmits. */
  private editingMeta: { via?: AiChatTurn['via']; quote?: AiChatQuote; objects?: ObjectReference[] } | null = null;
  /** The notice row above the composer, shown only while editing. */
  private noticeEl: HTMLElement | null = null;

  // Chat streams use runtime broadcasts; page context uses the window-scoped
  // panel port so GET_PAGE_INFO resolves against this panel's browser window.
  constructor(send: SendFn) { this.send = send; }

  // ── Tab interface ───────────────────────────────────────────────

  activate(): void {
    // The panel port carries its window identity, so the SW can answer with the
    // active tab's editor without consulting another Chrome window.
    this.send({ type: 'AI_GET_EDITOR_CONTEXT' });
    this.send({ type: 'GET_PAGE_INFO' });
    // Esc cancels the edit-last-message state first, then an active stream.
    if (!this.escHandler) {
      this.escHandler = (e: KeyboardEvent) => {
        if (e.key !== 'Escape') return;
        if (this.editing) { e.preventDefault(); this.cancelEditing(); return; }
        if (this.activeRequestId) { e.preventDefault(); this.stop(); }
      };
      document.addEventListener('keydown', this.escHandler);
    }
  }

  deactivate(): void {
    if (this.escHandler) { document.removeEventListener('keydown', this.escHandler); this.escHandler = null; }
  }

  handleMessage(msg: InspectorMessage): boolean {
    switch (msg.type) {
      case 'AI_CHAT_EVENT':
        this.onChatEvent(msg);
        return false;
      case 'AI_EDITOR_CONTEXT':
        this.setEditorSource(msg.source);
        return false;
      // Selection / context follows these — re-render the chips + suggestions.
      case 'CONTEXT_RID_DATA':
      case 'OBJECT_PANE_DATA':
      case 'SELECT_OBJECT':
      case 'PAGE_INFO':
      case 'PROFILE_SWITCHED':
        // A profile switch invalidates the whole conversation's grounding.
        if (msg.type === 'PROFILE_SWITCHED') this.resetForProfile();
        return true;
      case 'SETTINGS_DATA':
      case 'AI_CONFIG_CHANGED':
        return true;
      default:
        return false;
    }
  }

  findObject(): null { return null; }

  // ── External hooks (called from sidepanel.ts) ───────────────────

  /** The panel's selection context changed or was enriched (SELECT_OBJECT
   *  fires with sparse identity; OBJECT_PANE_DATA upgrades it with the
   *  authoritative type/name/businessId). Re-render the chips so the badge
   *  picks up the real type instead of staying on the grey fallback. A pinned
   *  selection adopts the enriched identity of the SAME object (rid match)
   *  when its snapshot was taken sparse — pinning freezes WHICH object is
   *  attached, not a half-loaded view of it. */
  contextChanged(): void {
    const c = S.context;
    if (c && c.rid === S.page?.rid) {
      this.webpageSelection = this.sourceForObject(c);
    }
    if (c && c.rid !== this.detachedSelectionRid) this.detachedSelectionRid = null;
    if (this.pinnedSelection && c?.rid === this.pinnedSelection.object.rid
        && !this.pinnedSelection.object.type && c.type) {
      this.pinnedSelection = {
        ...this.pinnedSelection,
        object: { rid: c.rid, businessId: c.businessId ?? '', name: c.name ?? '', type: c.type },
      };
    }
    if (this.container) this.refreshChips();
  }

  /** Live editor/studio context broadcast. Null when no editor is open. */
  setEditorSource(source: AiContextSource | null): void {
    this.editorSource = source;
    // A different object clears a stale detach.
    if (source && source.object.rid !== this.detachedEditorRid) this.detachedEditorRid = null;
    if (this.container) this.refreshChips();
  }

  /** One streaming event for the in-flight reply (routed by sidepanel). */
  onChatEvent(msg: Extract<InspectorMessage, { type: 'AI_CHAT_EVENT' }>): void {
    if (msg.requestId !== this.activeRequestId || !this.stream) return;
    if (msg.event.kind === 'change-preview-ready') {
      this.changeTickets.set(msg.event.code, {
        statusText: msg.event.resultText,
        phase: 'ready',
        previewId: msg.event.previewId,
      });
    } else if (msg.event.kind === 'change-preview-failed') {
      this.changeTickets.set(msg.event.code, {
        statusText: msg.event.resultText,
        phase: 'error',
      });
    }
    this.stream = reduceStream(this.stream, msg.event);
    this.paintStream();
    if (isTerminal(this.stream)) this.commitStream();
  }

  /** Command-strip handoff: switch is done by the shell; submit as a turn.
   *  The strip's envelope carries only the editor source (and no server id) —
   *  we ADOPT that source as the editor chip and rebuild the envelope from the
   *  chips, so the turn gets the active profile's server plus any live
   *  selection chip (chips = envelope, 1:1). */
  submitHandoff(text: string, quote: AiChatQuote | undefined, envelope: AiContextEnvelope): void {
    const ed = envelope.sources.find(s => s.kind === 'editor');
    if (ed) { this.editorSource = ed; this.detachedEditorRid = null; }
    this.submit(text, { via: 'strip', quote });
  }

  // ── Context resolution ──────────────────────────────────────────

  private selectionSource(): AiContextSource | null {
    if (this.selectionPinned && this.pinnedSelection) return this.pinnedSelection;
    const c = S.context;
    if (c?.rid && c.rid !== this.detachedSelectionRid) {
      const source = this.sourceForObject(c);
      if (c.rid === S.page?.rid) this.webpageSelection = source;
      return source;
    }

    // An explicitly selected object is only an override. Detaching it exposes
    // the page that was already carried independently in the envelope. A page
    // can initially be RID-only; later canonical context enrichment upgrades
    // this cached source through contextChanged().
    const pageRid = S.page?.rid;
    if (!pageRid) return null;
    if (this.webpageSelection?.object.rid === pageRid) return this.webpageSelection;
    this.webpageSelection = {
      kind: 'selection',
      object: { rid: pageRid, businessId: '', name: '', type: '' },
    };
    return this.webpageSelection;
  }

  private sourceForObject(object: ObjectReference): AiContextSource {
    return {
      kind: 'selection',
      object: {
        rid: object.rid,
        businessId: object.businessId ?? '',
        name: object.name ?? '',
        type: object.type ?? '',
      },
    };
  }

  private activeEditorSource(): AiContextSource | null {
    if (!this.editorSource) return null;
    if (this.editorSource.object.rid === this.detachedEditorRid) return null;
    return this.editorSource;
  }

  private activeServer(): { id: string; url: string } {
    const p = S.settings.profiles.find(pp => pp.id === S.settings.activeProfileId);
    return { id: p?.id ?? '', url: p?.bmpUrl ?? '' };
  }

  /** Assemble the envelope from the currently attached chips (editor first). */
  private buildEnvelope(): AiContextEnvelope {
    const sources: AiContextSource[] = [];
    const ed = this.activeEditorSource();
    const sel = this.selectionSource();
    if (ed) sources.push(ed);
    if (sel) sources.push(sel);
    return { v: 1, server: this.activeServer(), ...(S.page ? { page: { ...S.page } } : {}), sources };
  }

  /** Divergence tag naming the source a reply used. Only meaningful with 2
   *  sources attached — states the FIRST-listed source (editor precedes
   *  selection). Honest + deterministic; documented in the handoff report. */
  private tagFor(env: AiContextEnvelope): string | undefined {
    if (env.sources.length < 2) return undefined;
    const s = env.sources[0];
    const bid = s.object.businessId || s.object.name || s.object.rid;
    return `using ${s.kind} · ${bid}`;
  }

  private model(): string { return S.settings.ai?.model ?? 'AI'; }

  private resetForProfile(): void {
    this.stop();
    this.cancelEditing();
    this.transcript = [];
    this.changeTickets.clear();
    this.stream = null;
    this.pinnedSelection = null;
    this.webpageSelection = null;
    this.selectionPinned = false;
    this.detachedSelectionRid = null;
    this.detachedEditorRid = null;
  }

  // ── Send / stream ───────────────────────────────────────────────

  private submit(text: string, opts: { via?: 'strip'; quote?: AiChatQuote; envelope?: AiContextEnvelope; objects?: ObjectReference[] } = {}): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (this.activeRequestId) this.stop();

    const envelope = opts.envelope ?? this.buildEnvelope();
    // history = prior committed turns only; the SW appends this new text.
    const history: AiChatTurn[] = this.transcript.map(d => d.turn);

    const userTurn: AiChatTurn = { role: 'user', text: trimmed };
    const userObjects = opts.objects ?? envelope.sources.map(source => source.object);
    if (userObjects.length) userTurn.objects = userObjects;
    if (opts.via) userTurn.via = opts.via;
    if (opts.quote) userTurn.quote = opts.quote;
    this.transcript.push({ turn: userTurn });

    this.pendingTag = this.tagFor(envelope);
    this.stream = initStream(envelope.sources.map(source => source.object));
    this.activeRequestId = crypto.randomUUID();
    this.draft = '';
    if (this.textarea) this.textarea.value = '';

    this.renderThread();
    this.updateSendButton();

    sendFireForget({ type: 'AI_CHAT_SEND', requestId: this.activeRequestId, text: trimmed, history, envelope });
  }

  private stop(): void {
    if (!this.activeRequestId) return;
    sendFireForget({ type: 'AI_CHAT_CANCEL', requestId: this.activeRequestId });
    if (this.stream) this.stream = cancelStream(this.stream);
    this.commitStream();
  }

  /** Commit the finished in-flight stream into the transcript. */
  private commitStream(): void {
    if (!this.stream) return;
    const s = this.stream;
    const turn = toAssistantTurn(s);
    const display: DisplayTurn = { turn };
    if (this.pendingTag) display.contextTag = this.pendingTag;
    // Only keep an assistant turn with actual content OR a tool trace; an
    // immediate error before any text becomes an inline error line instead.
    const empty = !turn.text.trim() && !(turn.toolTrace && turn.toolTrace.length);
    if (!empty) this.transcript.push(display);
    if (s.status === 'error') {
      this.transcript.push({ turn: { role: 'assistant', text: `⚠ ${s.error ?? 'Something went wrong.'}` } });
    }
    this.stream = null;
    this.activeRequestId = null;
    this.pendingTag = undefined;
    this.streamReplyEl = null;
    this.renderThread();
    this.updateSendButton();
  }

  // ── Retry + Edit-last-message ───────────────────────────────────

  /** Unified send trigger (button click / Enter). Routes an in-flight request
   *  to Stop, an active edit to the edit-resubmit, and otherwise a normal send. */
  private onSend(): void {
    if (this.activeRequestId) { this.stop(); return; }
    const text = this.textarea?.value ?? '';
    if (this.editing) { this.commitEdit(text); return; }
    this.submit(text);
  }

  /** Regenerate the last reply: drop it (with any error line) and resend the
   *  same user turn. The envelope rebuilds from the current chips, so tool
   *  traces from the removed reply are gone with it. Gated on no active stream. */
  private retryLast(): void {
    if (this.activeRequestId) return;
    const plan = prepareRetry(this.transcript.map(d => d.turn));
    if (!plan) return;
    this.cancelEditing();
    // Truncate our richer transcript to the plan prefix (kept turns keep their
    // display metadata); submit() re-pushes the user turn + rebuilds history.
    this.transcript = this.transcript.slice(0, plan.turns.length);
    this.submit(plan.resend.text, { via: plan.resend.via, quote: plan.resend.quote, objects: plan.resend.objects });
  }

  /** Enter editing state for the last user turn: load its text into the
   *  composer and show the notice. The turn + its reply stay visible until the
   *  edit is sent (removal happens in commitEdit). Gated on no active stream. */
  private editLast(): void {
    if (this.activeRequestId) return;
    const plan = prepareEdit(this.transcript.map(d => d.turn));
    if (!plan) return;
    this.editing = true;
    this.editingMeta = { via: plan.draft.via, quote: plan.draft.quote, objects: plan.draft.objects };
    this.draft = plan.draft.text;
    if (this.textarea) {
      this.textarea.value = plan.draft.text;
      this.textarea.focus();
      this.textarea.setSelectionRange(plan.draft.text.length, plan.draft.text.length);
    }
    this.syncEditNotice();
  }

  /** Resubmit the edited last message: remove the old user turn and its reply,
   *  then submit the revised text as a fresh turn (via/quote preserved so a
   *  quoted code region stays attached). Empty text keeps editing active. */
  private commitEdit(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    const meta = this.editingMeta;
    const plan = prepareEdit(this.transcript.map(d => d.turn));
    if (plan) this.transcript = this.transcript.slice(0, plan.turns.length);
    this.editing = false;
    this.editingMeta = null;
    this.syncEditNotice();
    this.submit(trimmed, { via: meta?.via, quote: meta?.quote, objects: meta?.objects });
  }

  /** Leave editing without sending — restore the composer to empty/normal. */
  private cancelEditing(): void {
    if (!this.editing) return;
    this.editing = false;
    this.editingMeta = null;
    this.draft = '';
    if (this.textarea) this.textarea.value = '';
    this.syncEditNotice();
  }

  private syncEditNotice(): void {
    if (this.noticeEl) this.noticeEl.hidden = !this.editing;
  }

  /** Index of the last user turn in the transcript, or -1. */
  private lastUserIndex(): number {
    for (let i = this.transcript.length - 1; i >= 0; i--) {
      if (this.transcript[i].turn.role === 'user') return i;
    }
    return -1;
  }

  // ── Tab render ──────────────────────────────────────────────────

  render(container: HTMLElement): void {
    this.container = container;
    container.textContent = '';
    const thread = h('div', { class: 'ai-thread', role: 'log', 'aria-live': 'polite' });
    this.threadEl = thread;
    this.renderThread();
    container.appendChild(thread);
    container.appendChild(this.buildComposer());
    this.scrollToEnd();
  }

  private renderThread(): void {
    const thread = this.threadEl;
    if (!thread) return;
    thread.textContent = '';
    this.streamReplyEl = null;

    if (this.transcript.length === 0 && !this.stream) {
      thread.appendChild(this.buildEmptyState());
      return;
    }

    // Retry sits on the last assistant turn, Edit on the last user turn — both
    // only when the thread is idle (no active/streaming request).
    const idle = !this.stream && !this.activeRequestId;
    const turns = this.transcript.map(d => d.turn);
    const retryTarget = idle && prepareRetry(turns) ? this.transcript.length - 1 : -1;
    const editTarget = idle && prepareEdit(turns) ? this.lastUserIndex() : -1;

    this.transcript.forEach((d, i) => {
      thread.appendChild(d.turn.role === 'user'
        ? this.buildUserTurn(d.turn, i === editTarget)
        : this.buildAssistantTurn(d, i === retryTarget));
    });
    if (this.stream) {
      const el = this.buildStreamReply();
      this.streamReplyEl = el;
      thread.appendChild(el);
    }
    this.scrollToEnd();
  }

  /** Live update the in-flight reply nodes without a full thread rebuild. */
  private paintStream(): void {
    if (!this.stream) return;
    if (!this.streamReplyEl) { this.renderThread(); return; }
    const fresh = this.buildStreamReply();
    this.streamReplyEl.replaceWith(fresh);
    this.streamReplyEl = fresh;
    this.scrollToEnd();
  }

  private scrollToEnd(): void {
    const t = this.threadEl;
    if (t) t.scrollTop = t.scrollHeight;
  }

  // ── Turn builders ───────────────────────────────────────────────

  private buildUserTurn(turn: AiChatTurn, editable = false): HTMLElement {
    const el = h('div', { class: `ai-u${editable ? ' ai-u--editable' : ''}` });
    if (editable) el.title = 'Click to edit and resend this message';
    if (turn.via === 'strip') {
      const lines = turn.quote?.lines ? ` · lines ${turn.quote.lines}` : '';
      el.appendChild(h('div', { class: 'ai-u-via' }, `via editor${lines}`));
    }
    if (turn.quote) {
      el.appendChild(h('pre', { class: 'ai-quote' }, turn.quote.code));
    }
    const text = h('div', { class: 'ai-u-text' });
    renderInlineMarkdown(text, turn.text, this.markdownOptions(turn.objects ?? []));
    // Object chips remain independently clickable inside the otherwise click-to-edit last user turn.
    text.addEventListener('click', event => {
      if ((event.target as Element | null)?.closest('.object-chip')) event.stopPropagation();
    });
    el.appendChild(text);
    if (editable) {
      const edit = h('button', {
        class: 'ai-u-edit',
        title: 'Edit and resend',
        'aria-label': 'Edit this message',
      }, svg(ICON_PENCIL));
      edit.addEventListener('click', (e) => { e.stopPropagation(); this.editLast(); });
      el.appendChild(edit);
      el.addEventListener('click', () => this.editLast());
    }
    return el;
  }

  private buildAssistantTurn(d: DisplayTurn, retryable = false): HTMLElement {
    const el = h('div', { class: 'ai-a' });
    if (d.turn.toolTrace && d.turn.toolTrace.length) {
      el.appendChild(this.buildToolGroup(d));
    }
    if (d.contextTag) {
      el.appendChild(h('div', { class: 'ai-a-tag' }, h('span', { class: 'ai-a-pip' }), d.contextTag));
    }
    const body = h('div', { class: 'ai-a-body' });
    renderMarkdown(body, d.turn.text, this.markdownOptions(d.turn.objects));
    el.appendChild(body);
    if (retryable) {
      const retry = h('button', {
        class: 'ai-a-retry',
        title: 'Retry this reply',
        'aria-label': 'Retry this reply',
      }, svg(ICON_REFRESH));
      retry.addEventListener('click', () => this.retryLast());
      el.appendChild(h('div', { class: 'ai-a-actions' }, retry));
    }
    return el;
  }

  private buildStreamReply(): HTMLElement {
    const s = this.stream!;
    const el = h('div', { class: 'ai-a' });
    if (s.tools.length) el.appendChild(this.buildToolTrace(s.tools));
    if (this.pendingTag) el.appendChild(h('div', { class: 'ai-a-tag' }, h('span', { class: 'ai-a-pip' }), this.pendingTag));
    const body = h('div', { class: 'ai-a-body' });
    const visibleText = scrubModelReasoning(s.text);
    if (visibleText) {
      renderMarkdown(body, visibleText, this.markdownOptions(s.objects));
    } else if (!s.tools.length) {
      body.appendChild(h('div', { class: 'ai-status' }, 'Thinking…'));
    }
    el.appendChild(body);
    return el;
  }

  private markdownOptions(objects: readonly ObjectReference[] | undefined) {
    return {
      codeBlock: (lang: string, code: string) => this.buildCodeBlock(lang, code, objects),
      objects,
      objectReference: (object: ObjectReference) => objectChip(object, {
        size: 'xs',
        className: 'ai-answer-object',
        onActivate: () => sendFireForget({ type: 'OPEN_OBJECT_VIEW', rid: object.rid }),
      }),
    };
  }

  /** Committed tool trace: one collapsed "Ran N tools" activity summary. A
   *  failed call that a later call to the same tool recovers does not turn the
   *  whole completed turn red; the failed line remains visible on expansion. */
  private buildToolGroup(d: DisplayTurn): HTMLElement {
    const trace = d.turn.toolTrace ?? [];
    const anyFailed = trace.some((tool, index) => tool.ok === false
      && !trace.slice(index + 1).some(later => later.name === tool.name && later.ok !== false));
    const n = trace.length;
    const tick = svg(anyFailed ? ICON_X_CIRCLE : ICON_CHECK_CIRCLE);
    const detail = this.buildToolTrace(
      trace.map(t => ({ name: t.name, summary: t.summary, status: t.ok === false ? 'err' as const : 'ok' as const })),
    );
    detail.classList.add('ai-tg-detail');

    const group = h('div', { class: `ai-tg${d.toolsExpanded ? ' ai-tg--open' : ''}` });
    const summary = h('button', {
      class: `ai-tg-sum${anyFailed ? ' ai-tg-sum--err' : ''}`,
      'aria-expanded': d.toolsExpanded ? 'true' : 'false',
      title: 'Show tool calls',
    },
      h('span', { class: 'ai-tg-tick' }, tick),
      h('span', { class: 'ai-tg-label' }, `Ran ${n} tool${n === 1 ? '' : 's'}`),
    );
    summary.addEventListener('click', () => {
      d.toolsExpanded = !d.toolsExpanded;
      group.classList.toggle('ai-tg--open', d.toolsExpanded);
      summary.setAttribute('aria-expanded', d.toolsExpanded ? 'true' : 'false');
    });
    group.appendChild(summary);
    group.appendChild(detail);
    return group;
  }

  private buildToolTrace(tools: { name: string; summary: string; status: 'pending' | 'ok' | 'err' }[]): HTMLElement {
    const wrap = h('div', { class: 'ai-tools' });
    for (const t of tools) {
      const tick = t.status === 'pending' ? '·' : svg(t.status === 'ok' ? ICON_CHECK_CIRCLE : ICON_X_CIRCLE);
      wrap.appendChild(h('div', { class: `ai-tl ai-tl--${t.status}` },
        h('span', { class: 'ai-tl-tick' }, tick),
        h('span', { class: 'ai-tl-name' }, t.name),
        h('span', { class: 'ai-tl-sum' }, t.summary),
      ));
    }
    return wrap;
  }

  // ── Code block (Apply / Preview / Copy + result strip) ──────────

  private buildCodeBlock(
    lang: string,
    code: string,
    objects?: readonly ObjectReference[],
  ): HTMLElement {
    if (lang.trim().toLowerCase() === 'crev-change') {
      const proposal = parseChangeProposal(code);
      if (proposal) return this.buildChangeTicket(proposal, objects);
    }
    const canApply = !!this.activeEditorSource();
    const pre = h('pre', { class: 'ai-cb-pre' }, code);

    const copyBtn = h('button', { class: 'ai-cb-btn', title: 'Copy code' }, svg(ICON_COPY), ' Copy');
    copyBtn.addEventListener('click', () => {
      navigator.clipboard?.writeText(code).then(() => statusFlash('Code copied')).catch(() => { /* blocked */ });
    });

    const previewBtn = h('button', { class: 'ai-cb-btn', title: 'Dry-run this code against BMP' }, 'Preview');

    // Primary action depends on whether an editor is attached:
    //  - editor chip present → Apply (replace the open slot) + Insert (add at
    //    the cursor); both land behind the merge-diff review
    //  - no editor chip      → Open in editor (launch a free-script editor
    //    preloaded with this code, so the user isn't stuck copy-only)
    let primaryBtn: HTMLElement;
    // The extra Insert button, only when an editor is attached.
    let insertBtn: HTMLElement | null = null;
    if (canApply) {
      const applyBtn = h('button', {
        class: 'ai-cb-btn ai-cb-apply',
        title: 'Replace the open script',
      }, 'Apply');
      applyBtn.addEventListener('click', () => {
        const ed = this.activeEditorSource();
        if (!ed?.slot) { showToast('Open an editor on the object first', 'info'); return; }
        sendFireForget({ type: 'AI_APPLY_PROPOSAL', code, target: { rid: ed.object.rid, slot: ed.slot.name } });
        statusFlash('Sent to editor');
      });
      primaryBtn = applyBtn;

      insertBtn = h('button', {
        class: 'ai-cb-btn',
        title: 'Insert at the cursor',
      }, 'Insert');
      insertBtn.addEventListener('click', () => {
        const ed = this.activeEditorSource();
        if (!ed?.slot) { showToast('Open an editor on the object first', 'info'); return; }
        sendFireForget({ type: 'AI_INSERT_AT_CURSOR', code, target: { rid: ed.object.rid, slot: ed.slot.name } });
        statusFlash('Inserted at cursor');
      });
    } else {
      const openBtn = h('button', {
        class: 'ai-cb-btn ai-cb-apply',
        title: 'Open the Extended Code editor preloaded with this code',
      }, 'Open in editor');
      openBtn.addEventListener('click', () => {
        sendFireForget({ type: 'AI_OPEN_IN_EDITOR', code });
        statusFlash('Opening editor');
      });
      primaryBtn = openBtn;
    }

    const header = h('div', { class: 'ai-cb-h' },
      h('span', { class: 'ai-cb-lang' }, lang || 'code'),
      primaryBtn,
    );
    if (insertBtn) header.appendChild(insertBtn);
    header.appendChild(previewBtn);
    header.appendChild(copyBtn);

    const block = h('div', { class: 'ai-cb' }, header, pre);

    previewBtn.addEventListener('click', () => {
      void this.runPreview(code, block, previewBtn);
    });

    return block;
  }

  /** Compact interactive artifact for mutating EC. The source never renders in
   * chat: Preview, Run and editor launch are the complete surface. */
  private buildChangeTicket(
    proposal: AiChangeProposal,
    objects?: readonly ObjectReference[],
  ): HTMLElement {
    const key = proposal.code;
    let ticketState = this.changeTickets.get(key);
    if (!ticketState) {
      ticketState = { statusText: 'Not previewed', phase: 'idle' };
      this.changeTickets.set(key, ticketState);
    }
    const isPreviewing = ticketState.phase === 'previewing';
    const isRunning = ticketState.phase === 'running';
    const previewPhase = ticketState.phase === 'ready' || ticketState.phase === 'running' || ticketState.phase === 'done'
      ? 'success'
      : ticketState.phase === 'error'
        ? 'error'
        : ticketState.phase;
    const previewContent = isPreviewing
      ? [h('span', { class: 'ai-change-spinner', 'aria-hidden': 'true' }), 'Previewing…']
      : previewPhase === 'success'
        ? [svg(ICON_REFRESH), 'Preview again']
        : previewPhase === 'error'
          ? [svg(ICON_X), 'Retry preview']
          : [svg(ICON_EYE), 'Preview'];
    const previewBtn = h('button', {
      class: `ai-change-btn ai-change-preview ai-change-preview--${previewPhase}`,
      disabled: isPreviewing || isRunning,
    }, ...previewContent) as HTMLButtonElement;
    const runBtn = h('button', {
      class: 'ai-change-btn ai-change-run',
      disabled: ticketState.phase !== 'ready' || !ticketState.previewId,
    }, svg(ICON_PLAY), isRunning ? 'Running…' : 'Run') as HTMLButtonElement;
    const openBtn = h('button', { class: 'ai-change-btn ai-change-editor' },
      svg(ICON_CODE),
      h('span', { class: 'ai-change-editor-long' }, 'Open in editor'),
      h('span', { class: 'ai-change-editor-short' }, 'Editor'),
    ) as HTMLButtonElement;

    const target = proposal.target ? this.renderChangeTarget(proposal.target, objects) : null;
    const state = ticketState.phase === 'ready' && ticketState.statusText
      ? this.buildPreviewReceipt(ticketState.statusText)
      : ticketState.phase !== 'idle' && ticketState.phase !== 'previewing' && ticketState.statusText
        ? h('div', {
          class: `ai-change-state ai-change-state--${ticketState.phase === 'error' ? 'error' : 'success'}`,
          role: ticketState.phase === 'error' ? 'alert' : 'status',
        },
          svg(ticketState.phase === 'error' ? ICON_X : ICON_CHECK),
          h('span', null, ticketState.statusText),
        )
        : null;

    const ticket = h('div', { class: 'ai-change', 'data-operation': proposal.operation },
      h('div', { class: 'ai-change-header' },
        h('div', { class: 'ai-change-kicker' },
          h('span', { class: 'ai-change-sparkle', 'aria-hidden': 'true' }, svg(ICON_SPARKLE)),
          h('span', null, 'AI suggestion'),
        ),
        target,
      ),
      h('div', { class: 'ai-change-summary' }, proposal.summary),
      h('div', { class: 'ai-change-actions' }, previewBtn, openBtn, runBtn),
      state,
    );
    ticket.classList.toggle('ai-change--error', ticketState.phase === 'error');
    ticket.classList.toggle('ai-change--ready', ticketState.phase === 'ready');
    ticket.classList.toggle('ai-change--done', ticketState.phase === 'done');

    openBtn.addEventListener('click', () => {
      sendFireForget({ type: 'AI_OPEN_IN_EDITOR', code: proposal.code });
      statusFlash('Opening editor');
    });

    previewBtn.addEventListener('click', () => {
      ticketState = { statusText: '', phase: 'previewing' };
      this.changeTickets.set(key, ticketState);
      runBtn.disabled = true;
      previewBtn.disabled = true;
      previewBtn.textContent = 'Previewing…';
      const requestId = crypto.randomUUID();
      void sendRequest({
        type: 'AI_PREVIEW_CHANGE',
        requestId,
        proposal,
        ...this.verifiedChangeTarget(proposal.target, objects),
      }).then(result => {
        if (result?.type !== 'AI_PREVIEW_CHANGE_RESULT') {
          this.changeTickets.set(key, { statusText: 'Preview failed', phase: 'error' });
          this.renderThread();
          return;
        }
        this.changeTickets.set(key, {
          statusText: result.resultText,
          phase: result.ok && result.runnable && result.previewId ? 'ready' : 'error',
          previewId: result.previewId,
        });
        this.renderThread();
      });
    });

    runBtn.addEventListener('click', () => {
      if (!ticketState?.previewId) return;
      const previewId = ticketState.previewId;
      void confirmModal({
        title: 'Run this previewed change?',
        body: proposal.summary,
        confirmLabel: 'Run',
        confirmVariant: proposal.operation === 'delete' ? 'danger' : 'accent',
      }).then(confirmed => {
        if (!confirmed) return;
        ticketState = { statusText: '', phase: 'running' };
        this.changeTickets.set(key, ticketState);
        runBtn.disabled = true;
        previewBtn.disabled = true;
        runBtn.replaceChildren(svg(ICON_PLAY), 'Running…');
        const requestId = crypto.randomUUID();
        void sendRequest({ type: 'AI_RUN_CHANGE', requestId, previewId }).then(result => {
          if (result?.type !== 'AI_RUN_CHANGE_RESULT') {
            this.changeTickets.set(key, { statusText: 'Run failed', phase: 'error' });
            this.renderThread();
            return;
          }
          this.changeTickets.set(key, {
            statusText: result.resultText,
            phase: result.ok ? 'done' : 'error',
          });
          this.renderThread();
        });
      });
    });

    return ticket;
  }

  private buildPreviewReceipt(text: string): HTMLElement {
    const receipt = parsePreviewReceipt(text);
    const panel = h('div', { class: 'ai-change-receipt-panel' });
    panel.hidden = true;
    for (const event of receipt.events) panel.appendChild(this.buildPreviewEvent(event));

    const caret = h('span', { class: 'ai-change-disclosure-caret', 'aria-hidden': 'true' }, svg(ICON_CARET_DOWN));
    const toggle = h('button', {
      class: 'ai-change-receipt-toggle',
      type: 'button',
      'aria-expanded': 'false',
    },
      h('span', { class: 'ai-change-receipt-check', 'aria-hidden': 'true' }, svg(ICON_CHECK)),
      h('span', { class: 'ai-change-receipt-label' }, 'Previewed'),
      h('span', { class: 'ai-change-receipt-summary', title: receipt.summary }, `· ${receipt.summary}`),
      caret,
    ) as HTMLButtonElement;
    toggle.addEventListener('click', () => {
      const open = panel.hidden;
      panel.hidden = !open;
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      caret.classList.toggle('ai-change-disclosure-caret--open', open);
    });

    const rawPanel = h('pre', { class: 'ai-change-raw-output' }, receipt.raw || '(no output)');
    rawPanel.hidden = false;
    const rawCaret = h('span', { class: 'ai-change-disclosure-caret', 'aria-hidden': 'true' }, svg(ICON_CARET_DOWN));
    const rawToggle = h('button', {
      class: 'ai-change-raw-toggle',
      type: 'button',
      'aria-expanded': 'true',
    },
      h('span', { class: 'ai-change-raw-icon', 'aria-hidden': 'true' }, svg(ICON_TERMINAL_WINDOW)),
      `Raw output · ${receipt.rawLineCount} ${receipt.rawLineCount === 1 ? 'line' : 'lines'}`,
      rawCaret,
    ) as HTMLButtonElement;
    rawCaret.classList.add('ai-change-disclosure-caret--open');
    rawToggle.addEventListener('click', () => {
      const open = rawPanel.hidden;
      rawPanel.hidden = !open;
      rawToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      rawCaret.classList.toggle('ai-change-disclosure-caret--open', open);
    });
    const copy = h('button', {
      class: 'ai-change-raw-copy',
      type: 'button',
      title: 'Copy raw output',
      'aria-label': 'Copy raw output',
    }, svg(ICON_COPY)) as HTMLButtonElement;
    copy.addEventListener('click', () => {
      navigator.clipboard?.writeText(receipt.raw).then(() => {
        copy.replaceChildren(svg(ICON_CHECK));
        copy.title = 'Copied';
        copy.setAttribute('aria-label', 'Copied');
        setTimeout(() => {
          copy.replaceChildren(svg(ICON_COPY));
          copy.title = 'Copy raw output';
          copy.setAttribute('aria-label', 'Copy raw output');
        }, 1200);
      }).catch(() => { /* clipboard may be blocked */ });
    });
    panel.appendChild(h('div', { class: 'ai-change-raw-row' }, rawToggle, copy));
    panel.appendChild(rawPanel);

    return h('div', { class: 'ai-change-receipt', role: 'status' }, toggle, panel);
  }

  private buildPreviewEvent(event: PreviewReceiptEvent): HTMLElement {
    if (event.kind === 'write') {
      const object = this.splitPreviewIdentity(event.object);
      return this.previewEventRow(ICON_PENCIL, object.name, `${event.property} → ${event.value}`, object.id);
    }
    if (event.kind === 'move') {
      const object = this.splitPreviewIdentity(event.object);
      const target = this.splitPreviewIdentity(event.target);
      return this.previewEventRow(
        event.relation === 'into' ? ICON_ARROW_SQUARE_IN : ICON_SWAP,
        object.name,
        `${event.relation} ${target.name}`,
        object.id,
      );
    }
    if (event.kind === 'generated') {
      const code = h('pre', { class: 'ai-change-event-code' }, event.code);
      code.hidden = true;
      const caret = h('span', { class: 'ai-change-disclosure-caret', 'aria-hidden': 'true' }, svg(ICON_CARET_DOWN));
      const row = h('button', {
        class: 'ai-change-event ai-change-event--generated',
        type: 'button',
        title: event.code,
        'aria-expanded': 'false',
      },
        h('span', { class: 'ai-change-event-icon', 'aria-hidden': 'true' }, svg(ICON_CODE_BLOCK)),
        h('span', { class: 'ai-change-event-primary' }, event.action === 'create' ? 'Creation script' : 'Edit script'),
        h('span', { class: 'ai-change-event-detail' }, event.target ?? 'Generated Extended Code'),
        caret,
      ) as HTMLButtonElement;
      row.addEventListener('click', () => {
        const open = code.hidden;
        code.hidden = !open;
        row.setAttribute('aria-expanded', open ? 'true' : 'false');
        caret.classList.toggle('ai-change-disclosure-caret--open', open);
      });
      return h('div', { class: 'ai-change-event-group' }, row, code);
    }
    return this.previewEventRow(ICON_INFO, 'Result', event.text);
  }

  private previewEventRow(icon: string, primary: string, detail: string, id?: string): HTMLElement {
    return h('div', { class: 'ai-change-event', title: [id, primary, detail].filter(Boolean).join(' · ') },
      h('span', { class: 'ai-change-event-icon', 'aria-hidden': 'true' }, svg(icon)),
      h('span', { class: 'ai-change-event-primary' }, primary),
      id ? h('span', { class: 'ai-change-event-id' }, id) : null,
      h('span', { class: 'ai-change-event-detail' }, detail),
    );
  }

  private splitPreviewIdentity(value: string): { id?: string; name: string } {
    const match = /^(\S+)\s+(.+)$/u.exec(value.trim());
    return match ? { id: match[1], name: match[2] } : { name: value.trim() };
  }

  private verifiedChangeTarget(
    target: string | undefined,
    objects?: readonly ObjectReference[],
  ): { expectedTarget: { rid: string; businessId?: string } } | Record<string, never> {
    const rid = target ? changeTicketTargetRid(target) ?? undefined : undefined;
    if (!rid) return {};
    const object = objects?.find(candidate => candidate.rid === rid);
    if (!object) return {};
    return {
      expectedTarget: {
        rid: object.rid,
        ...(object.businessId ? { businessId: object.businessId } : {}),
      },
    };
  }

  /** A verified target is represented by its normal BMP type badge only. The
   *  object-chip hover preview retains the full name / ID context without
   *  repeating that metadata inside the compact suggestion card. */
  private renderChangeTarget(
    target: string,
    objects?: readonly ObjectReference[],
  ): HTMLElement | null {
    const rid = changeTicketTargetRid(target);
    const object = rid
      ? objects?.find(candidate => candidate.rid === rid)
      : undefined;

    if (object) {
      const label = object.name || object.businessId || `Object ${object.rid}`;
      const chip = objectChip(object, {
        size: 'xs',
        showId: false,
        className: 'ai-change-target-object',
        onActivate: () => sendFireForget({ type: 'OPEN_OBJECT_VIEW', rid: object.rid }),
      });
      chip.querySelector('.object-chip-label')?.remove();
      chip.querySelector('.object-chip-id')?.remove();
      const identity = [object.type, label, object.businessId, object.rid]
        .filter((value, index, values) => value && values.indexOf(value) === index)
        .join(' · ');
      chip.title = identity;
      chip.setAttribute('aria-label', `Target: ${identity}`);

      return h('div', { class: 'ai-change-target' },
        chip,
      );
    }

    return null;
  }

  private async runPreview(code: string, block: HTMLElement, btn: HTMLElement): Promise<void> {
    block.querySelector('.ai-pv')?.remove();
    btn.textContent = 'Preview…';
    const requestId = crypto.randomUUID();
    const r = await sendRequest({ type: 'AI_PREVIEW_CODE', requestId, code });
    btn.textContent = 'Preview';
    if (r?.type !== 'AI_PREVIEW_RESULT') {
      block.appendChild(this.buildPreviewStrip(false, 'No response from BMP'));
      return;
    }
    block.appendChild(this.buildPreviewStrip(r.ok, r.resultText));
  }

  private buildPreviewStrip(ok: boolean, text: string): HTMLElement {
    const strip = h('div', { class: `ai-pv ${ok ? 'ai-pv--ok' : 'ai-pv--err'}` },
      h('span', { class: 'ai-pv-mark' }, svg(ok ? ICON_CHECK_CIRCLE : ICON_X_CIRCLE)),
      h('span', { class: 'ai-pv-text' }, ok ? `preview · ${oneLine(text)}` : oneLine(text)),
    );
    if (!ok) {
      const fix = h('button', { class: 'ai-pv-fix' }, 'Fix it');
      fix.addEventListener('click', () => {
        this.submit(`Preview failed: ${text}. Fix the code.`);
      });
      strip.appendChild(fix);
    }
    return strip;
  }

  // ── Empty state ─────────────────────────────────────────────────

  private buildEmptyState(): HTMLElement {
    return h('div', { class: 'ai-empty' },
      h('span', { class: 'ai-empty-icon' }, svg(ICON_SPARKLE)),
      h('div', { class: 'ai-empty-title' }, 'Ask about your workspace'),
      h('div', { class: 'ai-empty-sub' }, 'Answers can read objects, types and layouts, search code, and preview EC. The conversation lasts until the panel closes.'),
    );
  }

  private contextName(): string | null {
    const sel = this.selectionSource();
    const ed = this.activeEditorSource();
    const src = sel ?? ed;
    if (!src) return null;
    return src.object.businessId || src.object.name || null;
  }

  // ── Composer + chips ────────────────────────────────────────────

  private buildComposer(): HTMLElement {
    if (!this.textarea) {
      const ta = h('textarea', {
        class: 'ai-composer-input',
        rows: '2',
        autocomplete: 'off',
        spellcheck: 'false',
      }) as HTMLTextAreaElement;
      ta.value = this.draft;
      ta.addEventListener('input', () => { this.draft = ta.value; });
      ta.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          this.onSend();
        }
      });
      this.textarea = ta;
    }
    this.textarea.placeholder = this.placeholder();

    // Edit notice — hidden until editLast() shows it. Sits above the input.
    const cancel = h('button', { class: 'ai-edit-cancel', type: 'button' }, 'Cancel');
    cancel.addEventListener('click', () => this.cancelEditing());
    const notice = h('div', { class: 'ai-edit-notice', hidden: true },
      h('span', { class: 'ai-edit-notice-text' },
        'Editing your last message. The previous reply will be replaced.'),
      cancel,
    );
    this.noticeEl = notice;
    this.syncEditNotice();

    // Footer: [ context chips / no-context hint ] … [ model ] [ Send ] on one
    // centered flex row. Context is the footer's main content; the model name is
    // subordinate, immediately left of Send.
    const ctx = h('div', { class: 'ai-composer-ctx' });
    this.ctxEl = ctx;
    this.fillContext(ctx);

    const foot = h('div', { class: 'ai-composer-foot' },
      ctx,
      h('span', { class: 'ai-composer-model' }, this.model()),
      this.buildSendButton(),
    );

    return h('div', { class: 'ai-composer' }, notice, this.textarea, foot);
  }

  private placeholder(): string {
    const n = this.contextName();
    return n ? `Message about ${n}…` : 'Message…';
  }

  private buildSendButton(): HTMLElement {
    const streaming = !!this.activeRequestId;
    const btn = h('button', {
      class: `ai-send${streaming ? ' ai-send--stop' : ''}`,
      title: streaming ? 'Stop generating' : 'Send (Enter)',
    }, streaming ? 'Stop' : 'Send');
    btn.addEventListener('click', () => this.onSend());
    return btn;
  }

  private updateSendButton(): void {
    const foot = this.container?.querySelector('.ai-composer-foot');
    const old = foot?.querySelector('.ai-send');
    if (foot && old) old.replaceWith(this.buildSendButton());
  }

  private refreshChips(): void {
    if (!this.ctxEl) return;
    this.fillContext(this.ctxEl);
    if (this.textarea) this.textarea.placeholder = this.placeholder();
    // Re-render the empty state when context toggles while the thread is empty.
    if (this.transcript.length === 0 && !this.stream) this.renderThread();
  }

  /** Fill the footer context cell: the attached chips, or a quiet hint when no
   *  object/editor is attached. The empty-state copy already says the chat is
   *  not saved, so the footer carries context only. */
  private fillContext(ctx: HTMLElement): void {
    ctx.textContent = '';
    const ed = this.activeEditorSource();
    const sel = this.selectionSource();
    if (!ed && !sel) {
      ctx.classList.add('ai-composer-ctx--empty');
      ctx.appendChild(h('span', { class: 'ai-composer-hint' }, 'No context. Select an object or open an editor.'));
      return;
    }
    ctx.classList.remove('ai-composer-ctx--empty');
    if (ed) ctx.appendChild(this.buildChip(ed, false));
    if (sel) ctx.appendChild(this.buildChip(sel, true));
  }

  private buildChip(src: AiContextSource, isSelection: boolean): HTMLElement {
    const name = src.object.businessId || src.object.name || src.object.rid;
    const editor = src.kind === 'editor';
    // The identity text already names the object, so repeat only the type
    // glyph in this constrained composer control. Default webpage context
    // gets the Page role marker without changing its real BMP type in the
    // envelope sent to the model.
    const visualType = isSelection && src.object.rid === S.page?.rid
      ? 'Page'
      : src.object.type;
    const editorTitle = `Extended Code editor context · ${name}`;
    const chip = editor
      ? h('span', {
        class: 'ai-cchip ai-cchip--editor',
        title: editorTitle,
        'aria-label': editorTitle,
      }, h('span', { class: 'ai-cchip-editor-icon', 'aria-hidden': 'true' }, svg(ICON_CODE)))
      : h('span', { class: 'ai-cchip' },
        typeBadge(visualType, { size: 'xs', iconOnly: true }),
        h('span', { class: 'ai-cchip-name' }, name),
      );

    const isPageFallback = isSelection && src.object.rid === S.page?.rid;

    if (isSelection && !isPageFallback) {
      const pin = h('button', {
        class: `ai-cchip-pin${this.selectionPinned ? ' on' : ''}`,
        title: this.selectionPinned ? 'Unpin to follow the selection again' : 'Pin to freeze this context',
        'aria-label': 'Pin context',
      }, svg(ICON_PIN));
      pin.addEventListener('click', () => {
        if (this.selectionPinned) { this.selectionPinned = false; this.pinnedSelection = null; }
        else { this.selectionPinned = true; this.pinnedSelection = this.selectionSource(); }
        this.refreshChips();
      });
      chip.appendChild(pin);
    }

    if (!isPageFallback) {
      const x = h('button', { class: 'ai-cchip-x', title: 'Detach', 'aria-label': 'Detach context' }, svg(ICON_X));
      x.addEventListener('click', () => {
        if (isSelection) { this.detachedSelectionRid = src.object.rid; this.selectionPinned = false; this.pinnedSelection = null; }
        else this.detachedEditorRid = src.object.rid;
        this.refreshChips();
      });
      chip.appendChild(x);
    }
    return chip;
  }
}

/** Collapse a multi-line preview / error into a single trimmed line for the
 *  result strip (the full text is available in BMP; this is a glance). */
function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 160 ? flat.slice(0, 157) + '…' : flat;
}
