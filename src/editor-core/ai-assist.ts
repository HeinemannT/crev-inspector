/**
 * Shared AI coding-assistant UI, used by both the EC editor and the CVO/Text
 * studio. Owns:
 *   - a compact, mouse-first prompt anchored to the current selection (or the
 *     toolbar AI button when the editor is hidden). It never inserts a full-width
 *     row into CodeMirror. The popover is viewport-clamped and re-anchors when
 *     the EC overlay window or the Studio HTML-preview split is resized.
 *   - one labelled toolbar entry point (plus Mod+K). A mouse selection still
 *     scopes the request, but selecting text never creates another button.
 *   - explicit result verbs: “Suggest change” keeps the edit in this editor;
 *     “Ask in sidebar” names the cross-surface handoff before it occurs.
 *   - Ask: hands off to the sidepanel AI chat tab (AI_CHAT_HANDOFF). The old
 *     floating answer panel is RETIRED — answers now live in the chat thread.
 *   - Edit: a `@codemirror/merge` unifiedMergeView overlaid on the live editor,
 *     with an Accept (purple) / Reject bar. Unchanged.
 *
 * Edit streaming mirrors Code Search: the request is fire-and-forget
 * (AI_REQUEST); replies arrive as AI_CHUNK / AI_DONE / AI_ERROR broadcasts keyed
 * by requestId. Only one request is in flight per surface. The API key never
 * reaches this code; it stays in the SW.
 */

import { unifiedMergeView } from '@codemirror/merge'
import type { Extension } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import type { CodeSurface } from './code-surface'
import { h, svg } from '../lib/dom'
import { anchorPopover } from '../lib/popover-anchor'
import { sendFireForget } from '../lib/messaging'
import { fetchAiConfig } from './ai-config'
import { scrubToolMarkup } from '../lib/ai/scrub'
import { ICON_SPARKLE } from '../lib/icons'
import type { InspectorMessage } from '../lib/types'
import type {
  AiLang, AiObjectContext, AiRequestPayload, AiSelection,
  AiContextSource, AiContextEnvelope, AiChatQuote,
} from '../lib/ai/types'

export interface AiAssistHost {
  /** The live editing surface (may be null before first mount). */
  surface: () => CodeSurface | null
  /** Language family of the active slot. */
  lang: () => AiLang
  /** Object grounding for the prompt (Edit path). */
  context: () => AiObjectContext
  /** Toolbar anchor for the compact prompt. */
  anchorEl: () => HTMLElement | null
  /** Full 'editor' context source for the chat envelope — identity + the
   *  current slot's code + selection. Null when no object is loaded. Used by
   *  the Ask handoff so the chat tab lands on the same object. */
  contextSource?: () => AiContextSource | null
}

export interface AiAssist {
  /** Open or focus the compact prompt. */
  open: () => void
  /** Tear down the prompt and pending proposal. */
  close: () => void
  /** True while an edit proposal is awaiting Accept/Reject. */
  hasPendingProposal: () => boolean
  /** Raise the standard merge-diff proposal for externally supplied code (the
   *  chat tab's Apply → AI_APPLY_PROPOSAL). Replaces the whole active slot;
   *  Accept / Reject work exactly like an inline Edit proposal. */
  propose: (code: string) => void
  /** Insert externally supplied code at the current cursor (the chat tab's
   *  Insert → AI_INSERT_AT_CURSOR). Additive, not a slot replace, but still
   *  behind the standard merge-diff Accept/Reject so nothing lands unreviewed. */
  insertAtCursor: (code: string) => void
}

export function createAiAssist(host: AiAssistHost): AiAssist {
  let model = ''
  let activeRequestId: string | null = null
  let answerText = ''
  /** Captured at send time so Accept/Reject act against a stable baseline. */
  let requestBefore = ''
  let requestSelection: AiSelection | null = null

  /** The compact prompt popover. */
  let floatingEl: HTMLElement | null = null
  /** The active prompt input, for idempotent refocus. */
  let barInput: HTMLInputElement | null = null
  /** Selection captured at open, restored on Esc. */
  let savedSelection: { anchor: number; head: number } | null = null
  /** Document-level dismiss handlers for the open bar. */
  let dismissCleanup: (() => void) | null = null
  /** Resize/scroll observers that keep the prompt attached to its anchor. */
  let positionCleanup: (() => void) | null = null
  let geometryRaf = 0
  let barEl: HTMLElement | null = null
  let pending = false
  /** Code currently staged behind an Accept/Reject bar. Guards against the
   *  duplicate delivery of an external Apply/Insert (the panel message reaches
   *  this page directly AND is re-broadcast by the SW). */
  let stagedCode: string | null = null

  // ── Streaming reply plumbing (Edit only) ───────────────────────
  chrome.runtime.onMessage.addListener((msg: InspectorMessage) => {
    if (msg.type !== 'AI_CHUNK' && msg.type !== 'AI_DONE' && msg.type !== 'AI_ERROR') return
    if (msg.requestId !== activeRequestId) return
    if (msg.type === 'AI_CHUNK') {
      answerText += msg.delta
    } else if (msg.type === 'AI_DONE') {
      activeRequestId = null
      finishEdit()
    } else {
      activeRequestId = null
      showBarError(msg.message)
    }
  })

  // ── Invoke command bar (verb-at-send) ──────────────────────────
  /** Open the prompt, or refocus it when already open. */
  function open(): void {
    if (isBarOpen()) { barInput?.focus(); return }
    void fetchAiConfig().then(c => { model = c.model ?? ''; refreshModelTitle() })
    openFloating()
  }

  const isBarOpen = (): boolean => !!floatingEl

  /** True when the editor view is actually laid out (not display:none, e.g. the
   *  studio's preview-only pane). offsetParent is null in a hidden subtree. */
  function isViewVisible(view: EditorView): boolean {
    const dom = view.dom
    if (!dom.isConnected) return false
    return dom.offsetParent !== null || dom.getClientRects().length > 0
  }

  /** The selected range is shown separately, so the placeholder stays plain. */
  function scopePlaceholder(): string {
    return 'Describe a change or ask about this code…'
  }

  function scopeLabel(): string {
    const lines = selectionLines()
    if (!lines) return 'Whole script'
    return lines.from === lines.to ? `Line ${lines.from} selected` : `Lines ${lines.from}–${lines.to} selected`
  }

  /** Mouse-first prompt content. Enter follows the primary “Suggest change”
   *  action; questions deliberately use the visibly labelled sidebar button. */
  function buildBarContent(): { root: HTMLElement; input: HTMLInputElement } {
    const input = h('input', {
      class: 'ai-inbar-input', type: 'text',
      placeholder: scopePlaceholder(), autocomplete: 'off', spellcheck: 'false',
    }) as HTMLInputElement
    const send = (fn: (instruction: string) => void): void => {
      const v = input.value.trim()
      if (v) fn(v)
    }
    input.addEventListener('keydown', (e: KeyboardEvent) => {
      e.stopPropagation()
      if (e.key === 'Enter') {
        e.preventDefault()
        send(submitEdit)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        closeBar({ restoreFocus: true })
      }
    })
    // Keep the rest of the input's key/edit events out of CodeMirror too.
    const stop = (e: Event): void => e.stopPropagation()
    input.addEventListener('keyup', stop)
    input.addEventListener('keypress', stop)
    input.addEventListener('beforeinput', stop)

    const askBtn = h('button', {
      class: 'ai-action ai-action--secondary', type: 'button', title: 'Continue this question in the AI sidebar',
      onClick: () => send(submitAsk),
    }, 'Ask in sidebar')
    const editBtn = h('button', {
      class: 'ai-action ai-action--primary', type: 'button', title: 'Generate a reviewable edit',
      onClick: () => send(submitEdit),
    }, 'Suggest change')

    const root = h('div', { class: 'ai-prompt' },
      h('div', { class: 'ai-prompt-input' },
        h('span', { class: 'ai-prompt-spark', title: model || 'AI assistant' }, svg(ICON_SPARKLE)),
        input,
      ),
      h('div', { class: 'ai-prompt-footer' },
        h('span', { class: 'ai-prompt-scope' }, scopeLabel()),
        h('div', { class: 'ai-prompt-actions' }, askBtn, editBtn),
      ),
    )
    // A verb button may hold focus (Tab); catch Esc at the row too.
    root.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); closeBar({ restoreFocus: true }) }
    })
    return { root, input }
  }

  /** Compact popover anchored to the selection, falling back to the toolbar. */
  function openFloating(): void {
    const view = host.surface()?.view
    if (!host.anchorEl() && !view) return
    if (view) { const m = view.state.selection.main; savedSelection = { anchor: m.anchor, head: m.head } }
    const content = buildBarContent()
    barInput = content.input
    const nub = h('span', { class: 'ai-strip-nub', 'aria-hidden': 'true' })
    const pop = h('div', {
      class: 'ai-strip', role: 'dialog', 'aria-label': 'AI assistant',
      style: 'top:-9999px; left:-9999px;',
    }, nub, content.root)
    document.body.appendChild(pop)
    floatingEl = pop
    anchorStrip(pop)
    installPositionTracking()
    content.input.focus()
    installDismiss(pop)
  }

  /** Update the sparkle tooltip once the model name resolves (the only place the
   *  model is surfaced). One bar is open at a time, so a document query is fine. */
  function refreshModelTitle(): void {
    const spark = document.querySelector<HTMLElement>('.ai-prompt-spark')
    if (spark) spark.title = model || 'AI assistant'
  }

  /** Document-level dismissers: an outside click closes the bar (unless an edit
   *  is generating), Esc closes it and restores the editor. Clicks inside the
   *  bar keep it. */
  function installDismiss(rootEl: HTMLElement): void {
    removeDismiss()
    const onDown = (e: MouseEvent): void => {
      if (rootEl.contains(e.target as Node)) return
      if (activeRequestId) return // don't dismiss mid-generation
      closeBar()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.preventDefault(); closeBar({ restoreFocus: true }) }
    }
    setTimeout(() => {
      document.addEventListener('mousedown', onDown)
      document.addEventListener('keydown', onKey)
    }, 0)
    dismissCleanup = () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }

  function removeDismiss(): void {
    dismissCleanup?.()
    dismissCleanup = null
  }

  function scheduleGeometry(): void {
    if (geometryRaf) return
    geometryRaf = requestAnimationFrame(() => {
      geometryRaf = 0
      if (floatingEl) anchorStrip(floatingEl)
    })
  }

  /** Window resize covers the containing Companion overlay. ResizeObserver also
   *  catches Studio's draggable code/HTML-preview split, which changes the
   *  editor pane without necessarily changing the iframe viewport. */
  function installPositionTracking(): void {
    removePositionTracking()
    const onGeometry = (): void => scheduleGeometry()
    window.addEventListener('resize', onGeometry)
    document.addEventListener('scroll', onGeometry, true)
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(onGeometry)
    const view = host.surface()?.view
    if (view) {
      observer?.observe(view.scrollDOM)
      if (view.dom.parentElement) observer?.observe(view.dom.parentElement)
    }
    const toolbarAnchor = host.anchorEl()
    if (toolbarAnchor) observer?.observe(toolbarAnchor)
    positionCleanup = () => {
      window.removeEventListener('resize', onGeometry)
      document.removeEventListener('scroll', onGeometry, true)
      observer?.disconnect()
    }
  }

  function removePositionTracking(): void {
    positionCleanup?.()
    positionCleanup = null
  }

  /** Line numbers of the current selection, or null when there is no selection. */
  function selectionLines(): { from: number; to: number } | null {
    const view = host.surface()?.view
    if (!view) return null
    const sel = view.state.selection.main
    if (sel.from === sel.to) return null
    return { from: view.state.doc.lineAt(sel.from).number, to: view.state.doc.lineAt(sel.to).number }
  }

  /** A transient anchor at the end of a visible selection. Cursor-only requests
   *  use the stable toolbar button instead of covering the current line. */
  function selectionAnchorEl(): HTMLElement | null {
    const view = host.surface()?.view
    if (!view || !isViewVisible(view)) return null
    const sel = view.state.selection.main
    if (sel.empty) return null
    let coords
    try { coords = view.coordsAtPos(sel.to) } catch { coords = null }
    if (!coords) return null
    const editorRect = view.dom.getBoundingClientRect()
    if (coords.bottom < editorRect.top || coords.top > editorRect.bottom) return null
    const el = document.createElement('div')
    el.style.cssText = `position:fixed; left:${coords.left}px; top:${coords.top}px; width:1px; height:${Math.max(1, coords.bottom - coords.top)}px; pointer-events:none;`
    document.body.appendChild(el)
    return el
  }

  /** Anchor the strip near the selection head (fallback: sparkle button). The
   *  nub points up at the anchor; it is hidden when the strip is clamped away
   *  from the anchor (flipped above, or slid horizontally so the nub would
   *  detach). All four viewport edges are handled by anchorPopover's clamp. */
  function anchorStrip(pop: HTMLElement): void {
    const selAnchor = selectionAnchorEl()
    const anchor = selAnchor ?? host.anchorEl()
    if (!anchor) return
    const ar = anchor.getBoundingClientRect()
    anchorPopover(pop, anchor)
    const pr = pop.getBoundingClientRect()
    const nub = pop.querySelector<HTMLElement>('.ai-strip-nub')
    if (nub) {
      // Attached = directly below the anchor (not flipped above, not pinned to
      // the top edge because the anchor scrolled off-screen). 12px tolerance
      // covers the 6px anchor gap plus sub-pixel rounding.
      const below = pr.top >= ar.bottom - 2 && pr.top - ar.bottom <= 12
      const nubLeft = ar.left + ar.width / 2 - pr.left // anchor centre in strip space
      if (below && nubLeft >= 12 && nubLeft <= pr.width - 12) {
        nub.style.display = ''
        nub.style.left = `${nubLeft}px`
      } else {
        nub.style.display = 'none'
      }
    }
    selAnchor?.remove()
  }

  /** Close the prompt. With `restoreFocus`, hand focus back to the
   *  editor and restore the selection captured at open (Esc). A plain close
   *  (outside click, submit) leaves focus wherever the click landed. */
  function closeBar(opts: { restoreFocus?: boolean } = {}): void {
    const view = host.surface()?.view
    if (floatingEl) {
      floatingEl.remove()
      floatingEl = null
    }
    removeDismiss()
    removePositionTracking()
    barInput = null
    const sel = savedSelection
    savedSelection = null
    // Restore selection + focus on the next frame, not synchronously. closeBar
    // usually runs from inside the bar input's own key handler; dispatching a
    // selection change from within that DOM event can re-enter the view update
    // (a mid-write selectionchange). A frame later the caret lands cleanly and
    // nothing user-visible is delayed.
    if (opts.restoreFocus && view) {
      const v = view
      requestAnimationFrame(() => {
        if (sel) v.dispatch({ selection: sel })
        v.focus()
        scheduleGeometry()
      })
    } else scheduleGeometry()
  }

  // ── Submit ─────────────────────────────────────────────────────
  /** Ask hands off to the sidepanel chat tab. The bar closes; the panel opens
   *  on the AI tab and submits the question with the quoted selection. The
   *  envelope's server is left empty here — the panel fills in the active
   *  profile before submitting the turn. */
  function submitAsk(instruction: string): void {
    const view = host.surface()?.view
    let quote: AiChatQuote | undefined
    if (view) {
      const sel = view.state.selection.main
      if (sel.from !== sel.to) {
        const code = view.state.doc.sliceString(sel.from, sel.to)
        const lines = selectionLines()
        quote = { code, lines: lines ? (lines.from === lines.to ? String(lines.from) : `${lines.from}–${lines.to}`) : undefined }
      }
    }
    const source = host.contextSource?.() ?? null
    const envelope: AiContextEnvelope = { v: 1, server: { id: '', url: '' }, sources: source ? [source] : [] }
    sendFireForget({ type: 'AI_CHAT_HANDOFF', text: instruction, quote, envelope })
    closeBar()
  }

  function submitEdit(instruction: string): void {
    const surface = host.surface()
    const view = surface?.view
    if (!surface || !view) return
    cancelActive()
    clearProposal()
    closeBar()

    const sel = view.state.selection.main
    const code = view.state.doc.toString()
    const selection: AiSelection | null = sel.from !== sel.to
      ? { from: sel.from, to: sel.to, text: view.state.doc.sliceString(sel.from, sel.to) }
      : null

    const requestId = crypto.randomUUID()
    activeRequestId = requestId
    answerText = ''
    requestBefore = code
    requestSelection = selection

    const payload: AiRequestPayload = {
      requestId, intent: 'edit', lang: host.lang(), code, selection, instruction, context: host.context(),
    }
    showBarGenerating()
    sendFireForget({ type: 'AI_REQUEST', payload })
  }

  function cancelActive(): void {
    if (!activeRequestId) return
    sendFireForget({ type: 'AI_CANCEL', requestId: activeRequestId })
    activeRequestId = null
  }

  // ── Edit: diff bar + merge overlay ─────────────────────────────
  function finishEdit(): void {
    const outcome = resolveEdit(answerText, requestBefore, requestSelection)
    switch (outcome.kind) {
      case 'error': showBarError(outcome.message); return
      case 'no-change': showBarNoChange(); return
      case 'whole-doc-choice': showBarWholeDoc(outcome.replacement); return
      case 'proposal': applyProposal(outcome.replacement); showBarAccept(); return
    }
  }

  function applyProposal(replacement: string): void {
    const surface = host.surface()
    const view = surface?.view
    if (!surface || !view) return
    const before = requestBefore
    const after = composeReplacement(before, replacement, requestSelection)
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: after } })
    const overlay: Extension = unifiedMergeView({
      original: before,
      mergeControls: false,
      gutter: true,
      syntaxHighlightDeletions: false,
    })
    surface.setOverlay(overlay)
    pending = true
    stagedCode = replacement
  }

  function acceptProposal(): void {
    host.surface()?.setOverlay([])
    pending = false
    stagedCode = null
    removeBar()
    host.surface()?.focus()
  }

  function rejectProposal(): void {
    const surface = host.surface()
    const view = surface?.view
    if (view) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: requestBefore } })
    surface?.setOverlay([])
    pending = false
    stagedCode = null
    removeBar()
    surface?.focus()
  }

  function clearProposal(): void {
    if (pending) { host.surface()?.setOverlay([]); pending = false }
    stagedCode = null
    removeBar()
  }

  // ── Bar (edit status / accept-reject / error) ──────────────────
  function ensureBar(): HTMLElement {
    if (!barEl) {
      barEl = h('div', { class: 'ai-bar', role: 'status' })
      document.body.appendChild(barEl)
    }
    return barEl
  }

  function removeBar(): void {
    barEl?.remove()
    barEl = null
  }

  function showBarGenerating(): void {
    const bar = ensureBar()
    bar.className = 'ai-bar'
    bar.replaceChildren(
      h('span', { class: 'ai-bar-icon' }, svg(ICON_SPARKLE)),
      h('span', { class: 'ai-bar-text' }, 'Generating edit…'),
      h('button', { class: 'btn btn-ghost btn-small', onClick: () => { cancelActive(); removeBar() } }, 'Stop'),
    )
  }

  function showBarAccept(): void {
    const bar = ensureBar()
    bar.className = 'ai-bar'
    bar.replaceChildren(
      h('span', { class: 'ai-bar-icon' }, svg(ICON_SPARKLE)),
      h('span', { class: 'ai-bar-text' }, 'AI proposed a change'),
      h('div', { class: 'ai-bar-actions' },
        h('button', { class: 'btn btn-accent btn-small', onClick: acceptProposal }, 'Accept'),
        h('button', { class: 'btn btn-ghost btn-small', onClick: rejectProposal }, 'Reject'),
      ),
    )
  }

  /** The model returned a whole-script rewrite for a partial-selection scope
   *  (see detectWholeDocRewrite). Splicing that into the selection would
   *  duplicate the body, so instead of a silent corruption we offer a choice:
   *  apply the rewrite against the FULL document (same merge-diff flow), or
   *  reject. No proposal is staged until the user chooses Apply. */
  function showBarWholeDoc(code: string): void {
    const bar = ensureBar()
    bar.className = 'ai-bar'
    bar.replaceChildren(
      h('span', { class: 'ai-bar-icon' }, svg(ICON_SPARKLE)),
      h('span', { class: 'ai-bar-text' }, 'The model rewrote the whole script'),
      h('div', { class: 'ai-bar-actions' },
        h('button', {
          class: 'btn btn-accent btn-small', title: 'Propose the rewrite against the whole script',
          onClick: () => {
            // Re-scope the pending proposal to the full document, then run the
            // standard merge-diff Accept/Reject against it.
            requestSelection = null
            if (code === requestBefore) { showBarNoChange(); return }
            applyProposal(code)
            showBarAccept()
          },
        }, 'Apply to whole script'),
        h('button', { class: 'btn btn-ghost btn-small', onClick: () => removeBar() }, 'Reject'),
      ),
    )
  }

  /** Quiet bar state for when the final proposal equals the current code (the
   *  model returned no real change). No merge overlay, no Accept/Reject — an
   *  honest "nothing to do" that the user can dismiss (auto-clears too). */
  function showBarNoChange(): void {
    pending = false
    const bar = ensureBar()
    bar.className = 'ai-bar'
    bar.replaceChildren(
      h('span', { class: 'ai-bar-icon' }, svg(ICON_SPARKLE)),
      h('span', { class: 'ai-bar-text' }, 'No changes proposed'),
      h('button', { class: 'btn btn-ghost btn-small', onClick: () => removeBar() }, 'Dismiss'),
    )
    const b = bar
    setTimeout(() => { if (barEl === b) removeBar() }, 4000)
  }

  function showBarError(message: string): void {
    const bar = ensureBar()
    bar.className = 'ai-bar ai-bar--err'
    bar.replaceChildren(
      h('span', { class: 'ai-bar-text ai-status--err' }, message),
      h('button', { class: 'btn btn-ghost btn-small', onClick: () => removeBar() }, 'Dismiss'),
    )
  }

  /** External proposal (AI_APPLY_PROPOSAL from the chat tab): replace the whole
   *  active slot with `code` behind the standard merge-diff Accept/Reject. */
  function propose(code: string): void {
    const view = host.surface()?.view
    if (!view) return
    // Duplicate delivery guard: the panel's chrome.runtime.sendMessage reaches
    // this page directly AND the SW re-broadcasts it. If the same code is
    // already staged as the pending proposal, the second arrival must not
    // clear the Accept/Reject bar (it would silently auto-accept).
    if (pending && view.state.doc.toString() === code) return
    cancelActive()
    clearProposal()
    closeBar()
    requestBefore = view.state.doc.toString()
    requestSelection = null
    if (code === requestBefore) { showBarNoChange(); return }
    applyProposal(code)
    showBarAccept()
  }

  /** External insertion (AI_INSERT_AT_CURSOR from the chat tab): splice `code`
   *  at the current cursor as a zero-width edit, behind the same merge-diff
   *  Accept/Reject. Apply = replace slot (propose); Insert = add at cursor. */
  function insertAtCursor(code: string): void {
    const view = host.surface()?.view
    if (!view) return
    // Duplicate delivery guard (see stagedCode): the same message reaches this
    // page directly AND via the SW re-broadcast. Ignore an identical staged code.
    if (pending && stagedCode === code) return
    cancelActive()
    clearProposal()
    closeBar()
    const before = view.state.doc.toString()
    const pos = view.state.selection.main.head
    requestBefore = before
    // A zero-width "selection" at the cursor turns composeReplacement into an
    // insertion, reusing the exact splice + no-op detection the edit path uses.
    requestSelection = { from: pos, to: pos, text: '' }
    if (!code) { showBarNoChange(); return }
    applyProposal(code)
    showBarAccept()
  }

  function close(): void {
    cancelActive()
    closeBar()
    clearProposal()
    if (geometryRaf) cancelAnimationFrame(geometryRaf)
    geometryRaf = 0
  }

  return { open, close, hasPendingProposal: () => pending, propose, insertAtCursor }
}

// ── Edit-reply parsing (pure, shared with tests) ─────────────────

/** Compose the full document a replacement would produce — used both to apply
 *  an edit proposal and to detect a no-op (result byte-identical to the
 *  original). A selection scopes the replacement; otherwise it is the whole
 *  document. Exported for tests. */
export function composeReplacement(before: string, replacement: string, selection: AiSelection | null): string {
  return selection
    ? before.slice(0, selection.from) + replacement + before.slice(selection.to)
    : replacement
}

/** Every fenced code block's inner text, in document order. */
function extractFences(reply: string): string[] {
  const re = /```[^\n]*\n([\s\S]*?)```/g
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(reply)) !== null) out.push(m[1].replace(/\n$/, ''))
  return out
}

/** Pull the code out of an edit reply. With multiple fenced blocks, prefer the
 *  LAST one — on "fix this" instructions models often quote the broken original
 *  first and the corrected code second. If the chosen block is byte-identical to
 *  the code we sent (`current`), fall back to the last block that differs; a
 *  same-as-input block is not a real proposal. Falls back to the whole reply
 *  only when there is no fence and it doesn't read as prose. This frame-side
 *  function is the sole production owner of editor reply resolution. */
export function extractReplyCode(reply: string, current?: string): { code: string | null; error?: string } {
  // A DSML tool-markup leak (some providers emit their tool-call DSL as plain
  // text when the tool budget is spent) must never be spliced into the doc.
  // Scrub first so fence extraction sees clean text. Harmless for clean replies.
  reply = scrubToolMarkup(reply)
  const fences = extractFences(reply)
  if (fences.length) {
    let chosen = fences[fences.length - 1]
    // Skip a trailing EMPTY fence (whitespace-only). Splicing "" would silently
    // delete the selection — or WIPE the whole document on a whole-script scope,
    // one Accept away. Prefer the last non-empty block; if every fence is empty,
    // report no code rather than propose an erasure.
    if (chosen.trim() === '') {
      const nonEmpty = [...fences].reverse().find(f => f.trim() !== '')
      if (nonEmpty === undefined) return { code: null, error: 'The reply did not contain code.' }
      chosen = nonEmpty
    }
    if (current != null && chosen === current) {
      for (let i = fences.length - 2; i >= 0; i--) {
        if (fences[i] !== current && fences[i].trim() !== '') { chosen = fences[i]; break }
      }
    }
    return { code: chosen }
  }
  const trimmed = reply.trim()
  if (!trimmed) return { code: null, error: 'The reply was empty.' }
  if (looksLikeProse(trimmed)) return { code: null, error: 'The reply did not contain code.' }
  return { code: trimmed }
}

function looksLikeProse(text: string): boolean {
  const s = text.trim()
  if (!s) return true
  if (/^(here('s| is)\b|the\s|this\s|sure\b|i\s|to\s|note\b|you\s|sorry\b)/i.test(s)) return true
  const codeSignals = /[{};]|:=|=>|\bforEach\b|\bSELECT\b|\bfunction\b|<\/?[a-z]|\bconst\b|\blet\b|\breturn\b/i.test(s)
  const sentences = s.split(/[.!?](\s|$)/).filter(Boolean).length
  return !codeSignals && sentences >= 2
}

// ── Whole-doc-rewrite detection for scoped edits ─────────────────
//
// The CONFIRMED failure: the user selects a couple of lines and asks for a
// change that logically touches the whole script ("rename X everywhere"). The
// model helpfully returns the ENTIRE rewritten script. If we splice that whole
// script into the 2-line selection range, we duplicate the body — the diff is
// honest but the result is useless. This detects that case so the UI can offer
// "apply to the whole script" instead of silently corrupting the selection.
//
// Only ever fires for a PARTIAL selection (a whole-script scope already targets
// the full doc, so a full-length reply is exactly right). Two cheap signals,
// with a guard so it never fires when the selection already IS most of the doc:
//
//   Guard   — selection covers >= 50% of the document's lines → never fire
//             (a full-length reply is expected; this is the "selection IS most
//             of the doc" case the heuristic must NOT touch).
//   Signal A — the reply reproduces document text that lies OUTSIDE the
//             selection (the normalized leading and/or trailing context, when
//             that context is non-trivial: >= 12 normalized chars). If the model
//             echoed code we did not ask it to touch, it rewrote the whole doc.
//   Signal B — the reply is nearly as long as the whole document (>= 90% of its
//             lines) while the selection is only a small slice of it.
//
// Normalization collapses runs of whitespace and trims, so reflowed indentation
// or a reformatted body still matches. Thresholds are deliberately conservative:
// a false negative just falls back to the honest splice-and-diff path.
const WHOLE_DOC_MIN_CONTEXT = 12
const WHOLE_DOC_SELECTION_MAX_FRACTION = 0.5
const WHOLE_DOC_LINE_RATIO = 0.9

function normWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

function countLines(s: string): number {
  if (s === '') return 0
  return s.split('\n').length
}

export function detectWholeDocRewrite(before: string, replacement: string, selection: AiSelection | null): boolean {
  if (!selection || selection.from === selection.to) return false
  const docLines = countLines(before)
  if (docLines === 0) return false
  const selLines = countLines(selection.text)

  // Guard: the selection already covers most of the document — a full-length
  // reply is expected, so the heuristic must not fire.
  if (selLines / docLines >= WHOLE_DOC_SELECTION_MAX_FRACTION) return false

  const body = normWhitespace(replacement)

  // Signal A: the reply echoes out-of-selection context (leading and/or
  // trailing document text). Non-trivial context only.
  const leading = normWhitespace(before.slice(0, selection.from))
  const trailing = normWhitespace(before.slice(selection.to))
  if (leading.length >= WHOLE_DOC_MIN_CONTEXT && body.includes(leading)) return true
  if (trailing.length >= WHOLE_DOC_MIN_CONTEXT && body.includes(trailing)) return true

  // Signal B: the reply is nearly the whole document by line count.
  if (countLines(replacement) >= WHOLE_DOC_LINE_RATIO * docLines) return true

  return false
}

// ── Edit-outcome resolver (pure, shared with tests) ──────────────

/** The full decision an edit reply produces, independent of DOM. finishEdit()
 *  is a thin consumer of this; the interaction matrix drives it directly so the
 *  document is provably never silently corrupted. */
export type EditOutcome =
  | { kind: 'error'; message: string }
  | { kind: 'no-change' }
  /** Splice `replacement` into the selection (or replace the whole doc when the
   *  scope had no selection). `after` is the resulting document. */
  | { kind: 'proposal'; replacement: string; after: string }
  /** The model rewrote the whole script for a partial-selection scope. The UI
   *  must NOT splice into the selection; it offers "apply to whole script",
   *  which proposes `replacement` as the FULL document. */
  | { kind: 'whole-doc-choice'; replacement: string; wholeDocAfter: string }

/** Resolve a raw edit reply against the captured baseline + scope. Pure. */
export function resolveEdit(reply: string, before: string, selection: AiSelection | null): EditOutcome {
  const current = selection ? selection.text : before
  const { code, error } = extractReplyCode(reply, current)
  if (code == null) return { kind: 'error', message: error ?? 'The reply did not contain code.' }
  if (detectWholeDocRewrite(before, code, selection)) {
    return { kind: 'whole-doc-choice', replacement: code, wholeDocAfter: code }
  }
  const after = composeReplacement(before, code, selection)
  if (after === before) return { kind: 'no-change' }
  return { kind: 'proposal', replacement: code, after }
}
