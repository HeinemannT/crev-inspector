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
 * page / Inspect selection (S.context) unless pinned; the editor chip mirrors the
 * last AI_EDITOR_CONTEXT broadcast (an editor/studio open on an object).
 */

import type { Tab, SendFn } from './tab-types';
import type { InspectorMessage, ObjectReference } from '../../lib/types';
import type {
  AiChatTurn, AiChatQuote, AiContextEnvelope, AiContextSource,
} from '../../lib/ai/types';
import { h, svg, statusFlash } from '../../lib/dom';
import { typeBadge } from '../../lib/type-badge';
import { objectChip } from '../../lib/object-chip';
import { ICON_SPARKLE, ICON_X, ICON_COPY, ICON_PIN, ICON_REFRESH, ICON_PENCIL } from '../../lib/icons';
import { sendFireForget, sendRequest } from '../../lib/messaging';
import { showToast } from '../../lib/toast';
import { S } from '../state';
import { renderMarkdown } from './ai-markdown';
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
  /** Divergence tag captured at send time, shown once the reply commits. */
  private pendingTag: string | undefined;

  // ── Context (chips = envelope.sources) ──────────────────────────
  /** Last editor/studio context broadcast, or null when none is open. */
  private editorSource: AiContextSource | null = null;
  /** Frozen selection snapshot when the user pins the selection chip. */
  private pinnedSelection: AiContextSource | null = null;
  private selectionPinned = false;
  /** RIDs the user detached this session (hidden until the source changes). */
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
  private editingMeta: { via?: AiChatTurn['via']; quote?: AiChatQuote } | null = null;
  /** The notice row above the composer, shown only while editing. */
  private noticeEl: HTMLElement | null = null;

  // Chat streams use runtime broadcasts; page context uses the window-scoped
  // panel port so GET_PAGE_INFO resolves against this panel's browser window.
  constructor(send: SendFn) { this.send = send; }

  // ── Tab interface ───────────────────────────────────────────────

  activate(): void {
    // Sync the editor chip for a panel that opened after the editor.
    void sendRequest({ type: 'AI_GET_EDITOR_CONTEXT' }).then(r => {
      if (r?.type === 'AI_EDITOR_CONTEXT') { this.setEditorSource(r.source); }
    });
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
    if (!c?.rid) return null;
    if (c.rid === this.detachedSelectionRid) return null;
    return {
      kind: 'selection',
      object: { rid: c.rid, businessId: c.businessId ?? '', name: c.name ?? '', type: c.type ?? '' },
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
    this.stream = null;
    this.pinnedSelection = null;
    this.selectionPinned = false;
    this.detachedSelectionRid = null;
    this.detachedEditorRid = null;
  }

  // ── Send / stream ───────────────────────────────────────────────

  private submit(text: string, opts: { via?: 'strip'; quote?: AiChatQuote; envelope?: AiContextEnvelope } = {}): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (this.activeRequestId) this.stop();

    const envelope = opts.envelope ?? this.buildEnvelope();
    // history = prior committed turns only; the SW appends this new text.
    const history: AiChatTurn[] = this.transcript.map(d => d.turn);

    const userTurn: AiChatTurn = { role: 'user', text: trimmed };
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
    this.submit(plan.resend.text, { via: plan.resend.via, quote: plan.resend.quote });
  }

  /** Enter editing state for the last user turn: load its text into the
   *  composer and show the notice. The turn + its reply stay visible until the
   *  edit is sent (removal happens in commitEdit). Gated on no active stream. */
  private editLast(): void {
    if (this.activeRequestId) return;
    const plan = prepareEdit(this.transcript.map(d => d.turn));
    if (!plan) return;
    this.editing = true;
    this.editingMeta = { via: plan.draft.via, quote: plan.draft.quote };
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
    this.submit(trimmed, { via: meta?.via, quote: meta?.quote });
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
      el.appendChild(h('div', { class: 'ai-u-via' }, `via Ctrl+K · editor${lines}`));
    }
    if (turn.quote) {
      el.appendChild(h('pre', { class: 'ai-quote' }, turn.quote.code));
    }
    el.appendChild(h('div', { class: 'ai-u-text' }, turn.text));
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
    if (s.text) {
      renderMarkdown(body, s.text, this.markdownOptions(s.objects));
    } else if (!s.tools.length) {
      body.appendChild(h('div', { class: 'ai-status' }, 'Thinking…'));
    }
    el.appendChild(body);
    return el;
  }

  private markdownOptions(objects: readonly ObjectReference[] | undefined) {
    return {
      codeBlock: (lang: string, code: string) => this.buildCodeBlock(lang, code),
      objects,
      objectReference: (object: ObjectReference) => objectChip(object, {
        size: 'xs',
        className: 'ai-answer-object',
        onActivate: () => sendFireForget({ type: 'OPEN_OBJECT_VIEW', rid: object.rid }),
      }),
    };
  }

  /** Committed tool trace: one collapsed "Ran N tools" summary (✓ all ok / ✕
   *  any failed), clickable to reveal the per-call lines. Historical turns start
   *  collapsed; the individual lines stay available on demand. */
  private buildToolGroup(d: DisplayTurn): HTMLElement {
    const trace = d.turn.toolTrace ?? [];
    const anyFailed = trace.some(t => t.ok === false);
    const n = trace.length;
    const tick = anyFailed ? '✕' : '✓';
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
      const tick = t.status === 'pending' ? '·' : t.status === 'ok' ? '✓' : '✕';
      wrap.appendChild(h('div', { class: `ai-tl ai-tl--${t.status}` },
        h('span', { class: 'ai-tl-tick' }, tick),
        h('span', { class: 'ai-tl-name' }, t.name),
        h('span', { class: 'ai-tl-sum' }, t.summary),
      ));
    }
    return wrap;
  }

  // ── Code block (Apply / Preview / Copy + result strip) ──────────

  private buildCodeBlock(lang: string, code: string): HTMLElement {
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
      h('span', { class: 'ai-pv-mark' }, ok ? '✓' : '✕'),
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
    if (ed && sel) ctx.appendChild(h('span', { class: 'ai-divnote' }, '2 contexts'));
  }

  private buildChip(src: AiContextSource, isSelection: boolean): HTMLElement {
    const following = isSelection && !this.selectionPinned;
    const name = src.object.businessId || src.object.name || src.object.rid;
    const sourceWord = src.kind === 'editor'
      ? (src.slot ? `editor · ${src.slot.lang}` : 'editor')
      : null;

    const chip = h('span', { class: `ai-cchip${following ? ' ai-cchip--follow' : ''}` },
      typeBadge(src.object.type, { size: 'xs' }),
      h('span', { class: 'ai-cchip-name' }, name),
      sourceWord ? h('span', { class: 'ai-cchip-src' }, sourceWord) : null,
    );

    if (isSelection) {
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

    const x = h('button', { class: 'ai-cchip-x', title: 'Detach', 'aria-label': 'Detach context' }, svg(ICON_X));
    x.addEventListener('click', () => {
      if (isSelection) { this.detachedSelectionRid = src.object.rid; this.selectionPinned = false; this.pinnedSelection = null; }
      else this.detachedEditorRid = src.object.rid;
      this.refreshChips();
    });
    chip.appendChild(x);
    return chip;
  }
}

/** Collapse a multi-line preview / error into a single trimmed line for the
 *  result strip (the full text is available in BMP; this is a glance). */
function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 160 ? flat.slice(0, 157) + '…' : flat;
}
