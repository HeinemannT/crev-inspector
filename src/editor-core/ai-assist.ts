/**
 * Shared AI coding-assistant UI, used by both the EC editor and the CVO/Text
 * studio. Owns:
 *   - the invoke COMMAND BAR with a VERB-AT-SEND interaction: one tight row —
 *     sparkle (its tooltip names the model), an instruction input, and two verb
 *     buttons, Edit (⌃↵, outlined) and Ask (↵, solid purple). There is NO mode:
 *     you type first, then pick the intent with the key you press — Enter sends
 *     as Ask, Ctrl/Cmd+Enter sends as Edit. Both buttons are always visible with
 *     their shortcut printed on them.
 *   - Two shells share that exact inner content (buildBarContent):
 *       · INLINE (primary): a CodeMirror block widget injected directly under the
 *         selection's last line (or the cursor line), full editor width, so the
 *         code shifts down and nothing is occluded. A 2px purple gutter bracket
 *         over the target lines is the scope indicator. See ai-inline-bar.ts.
 *       · FLOATING (fallback): the former anchored strip, used when the editor
 *         view is not visible (e.g. the studio's preview-only layout) or absent.
 *     The placeholder communicates scope ("Ask or edit lines a–b…" /
 *     "Ask or edit this script…"); the model name lives only in the sparkle's
 *     tooltip.
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
import { EditorView } from '@codemirror/view'
import type { CodeSurface } from './code-surface'
import { openInlineBar, closeInlineBar } from './ai-inline-bar'
import { isMac } from './platform'
import { h, svg } from '../lib/dom'
import { anchorPopover } from '../lib/popover-anchor'
import { sendFireForget } from '../lib/messaging'
import { fetchAiConfig } from './ai-config'
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
  /** Fallback anchor for the command strip (the sparkle button). */
  anchorEl: () => HTMLElement | null
  /** Full 'editor' context source for the chat envelope — identity + the
   *  current slot's code + selection. Null when no object is loaded. Used by
   *  the Ask handoff so the chat tab lands on the same object. */
  contextSource?: () => AiContextSource | null
}

export interface AiAssist {
  /** Toggle the command strip. */
  open: () => void
  /** Tear down any open strip / pending proposal. */
  close: () => void
  /** True while an edit proposal is awaiting Accept/Reject. */
  hasPendingProposal: () => boolean
  /** Raise the standard merge-diff proposal for externally supplied code (the
   *  chat tab's Apply → AI_APPLY_PROPOSAL). Replaces the whole active slot;
   *  Accept / Reject work exactly like an inline Edit proposal. */
  propose: (code: string) => void
}

/** Hint glyph on the Edit verb button — Ctrl+Enter everywhere, additionally
 *  Cmd+Enter on macOS (shown as ⌘↵ there). Ask is always plain Enter. */
const EDIT_HINT = isMac ? '⌘↵' : '⌃↵'

/** Which shell to use for the invoke bar. Inline (the CodeMirror block widget)
 *  needs a visible editor view; everything else (a hidden view — e.g. the
 *  studio's preview-only layout — or no view at all) falls back to the floating
 *  strip. Pure so the routing is unit-testable. */
export function pickShell(opts: { hasView: boolean; viewVisible: boolean }): 'inline' | 'floating' {
  return opts.hasView && opts.viewVisible ? 'inline' : 'floating'
}

export function createAiAssist(host: AiAssistHost): AiAssist {
  let model = ''
  let activeRequestId: string | null = null
  let answerText = ''
  /** Captured at send time so Accept/Reject act against a stable baseline. */
  let requestBefore = ''
  let requestSelection: AiSelection | null = null

  /** The floating fallback popover (null when inline / closed). */
  let floatingEl: HTMLElement | null = null
  /** True while the inline block-widget bar is mounted. */
  let inlineOpen = false
  /** The active bar's instruction input (either shell), for idempotent refocus. */
  let barInput: HTMLInputElement | null = null
  /** Selection captured at open, restored on Esc. */
  let savedSelection: { anchor: number; head: number } | null = null
  /** Document-level dismiss handlers for the open bar. */
  let dismissCleanup: (() => void) | null = null
  let barEl: HTMLElement | null = null
  let pending = false

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
  /** Open the bar, or — if it's already open — just refocus its input (Ctrl+K
   *  is an idempotent invoke, never a toggle-close). Picks the inline shell when
   *  a visible editor view exists, else the floating fallback. */
  function open(): void {
    if (isBarOpen()) { barInput?.focus(); return }
    void fetchAiConfig().then(c => { model = c.model ?? ''; refreshModelTitle() })
    const view = host.surface()?.view
    const shell = pickShell({ hasView: !!view, viewVisible: !!view && isViewVisible(view) })
    if (shell === 'inline' && view) openInline(view)
    else openFloating()
  }

  const isBarOpen = (): boolean => inlineOpen || !!floatingEl

  /** True when the editor view is actually laid out (not display:none, e.g. the
   *  studio's preview-only pane). offsetParent is null in a hidden subtree. */
  function isViewVisible(view: EditorView): boolean {
    const dom = view.dom
    if (!dom.isConnected) return false
    return dom.offsetParent !== null || dom.getClientRects().length > 0
  }

  /** Placeholder that states the scope: the selected line range, or the whole
   *  script when there is no selection. */
  function scopePlaceholder(): string {
    const lines = selectionLines()
    if (!lines) return 'Ask or edit this script…'
    return lines.from === lines.to
      ? `Ask or edit line ${lines.from}…`
      : `Ask or edit lines ${lines.from}–${lines.to}…`
  }

  /** The shell-agnostic bar content: sparkle (model in its tooltip) · input ·
   *  Edit (⌃↵) · Ask (↵). Enter sends Ask, Ctrl/Cmd+Enter sends Edit; both
   *  buttons always visible. Keystrokes are stopped from reaching CodeMirror.
   *  Shared verbatim by the inline widget and the floating fallback. */
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
      // The bar lives inside the editor DOM (inline shell). Its keystrokes must
      // never fall through to CodeMirror's keymaps.
      e.stopPropagation()
      if (e.key === 'Enter') {
        e.preventDefault()
        if (e.ctrlKey || e.metaKey) send(submitEdit)
        else send(submitAsk)
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

    const editBtn = h('button', {
      class: 'ai-verb ai-verb--edit', type: 'button', title: 'Generate an edit',
      onClick: () => send(submitEdit),
    }, 'Edit', h('span', { class: 'ai-verb-kbd' }, EDIT_HINT))
    const askBtn = h('button', {
      class: 'ai-verb ai-verb--ask', type: 'button', title: 'Ask about the code',
      onClick: () => send(submitAsk),
    }, 'Ask', h('span', { class: 'ai-verb-kbd' }, '↵'))

    const root = h('div', { class: 'ai-inbar', role: 'dialog', 'aria-label': 'AI assistant' },
      h('span', { class: 'ai-inbar-spark', title: model || 'AI assistant' }, svg(ICON_SPARKLE)),
      input, editBtn, askBtn,
    )
    // A verb button may hold focus (Tab); catch Esc at the row too.
    root.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); closeBar({ restoreFocus: true }) }
    })
    return { root, input }
  }

  /** Mount the inline block-widget bar under the selection's last line (or the
   *  cursor line). Draws the scope bracket over the selected lines. */
  function openInline(view: EditorView): void {
    const { doc } = view.state
    const main = view.state.selection.main
    const hasSel = main.from !== main.to
    const startLine = doc.lineAt(main.from)
    let endLine = doc.lineAt(main.to)
    // A line-wise selection ending exactly at the next line's start shouldn't
    // stretch the bracket onto that (empty) trailing line.
    if (hasSel && main.to === endLine.from && endLine.number > startLine.number) {
      endLine = doc.line(endLine.number - 1)
    }
    savedSelection = { anchor: main.anchor, head: main.head }
    const content = buildBarContent()
    barInput = content.input
    inlineOpen = true
    view.dispatch({
      effects: [
        openInlineBar.of({ dom: content.root, pos: endLine.to, from: startLine.from, to: endLine.to, highlight: hasSel }),
        // Bring the bar into view when invoked near the viewport bottom.
        EditorView.scrollIntoView(endLine.to, { y: 'nearest' }),
      ],
    })
    // The widget DOM lands during the view update; focus + remeasure next frame.
    requestAnimationFrame(() => {
      view.requestMeasure()
      content.input.focus()
    })
    installDismiss(content.root)
  }

  /** Fallback floating strip: the shared content in an anchored popover. Used
   *  when the editor view isn't visible (studio preview-only) or is absent. */
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
    content.input.focus()
    installDismiss(pop)
  }

  /** Update the sparkle tooltip once the model name resolves (the only place the
   *  model is surfaced). One bar is open at a time, so a document query is fine. */
  function refreshModelTitle(): void {
    const spark = document.querySelector<HTMLElement>('.ai-inbar-spark')
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

  /** Line numbers of the current selection, or null when there is no selection. */
  function selectionLines(): { from: number; to: number } | null {
    const view = host.surface()?.view
    if (!view) return null
    const sel = view.state.selection.main
    if (sel.from === sel.to) return null
    return { from: view.state.doc.lineAt(sel.from).number, to: view.state.doc.lineAt(sel.to).number }
  }

  /** A transient 0-size element at the selection head, for popover anchoring. */
  function selectionAnchorEl(): HTMLElement | null {
    const view = host.surface()?.view
    if (!view) return null
    const sel = view.state.selection.main
    let coords
    try { coords = view.coordsAtPos(sel.head) } catch { coords = null }
    if (!coords) return null
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

  /** Close whichever shell is open. With `restoreFocus`, hand focus back to the
   *  editor and restore the selection captured at open (Esc). A plain close
   *  (outside click, submit) leaves focus wherever the click landed. */
  function closeBar(opts: { restoreFocus?: boolean } = {}): void {
    const view = host.surface()?.view
    if (inlineOpen) {
      view?.dispatch({ effects: closeInlineBar.of(null) })
      inlineOpen = false
    }
    if (floatingEl) {
      floatingEl.remove()
      floatingEl = null
    }
    removeDismiss()
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
      })
    }
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
    // What we asked the model to revise — the selection when there was one,
    // else the whole document. Used to reject a proposal that merely re-quotes
    // the original (see extractReplyCode) and to detect a genuine no-op.
    const current = requestSelection ? requestSelection.text : requestBefore
    const { code, error } = extractReplyCode(answerText, current)
    if (code == null) { showBarError(error ?? 'The reply did not contain code.'); return }
    const after = composeReplacement(requestBefore, code, requestSelection)
    if (after === requestBefore) { showBarNoChange(); return }
    applyProposal(code)
    showBarAccept()
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
  }

  function acceptProposal(): void {
    host.surface()?.setOverlay([])
    pending = false
    removeBar()
    host.surface()?.focus()
  }

  function rejectProposal(): void {
    const surface = host.surface()
    const view = surface?.view
    if (view) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: requestBefore } })
    surface?.setOverlay([])
    pending = false
    removeBar()
    surface?.focus()
  }

  function clearProposal(): void {
    if (pending) { host.surface()?.setOverlay([]); pending = false }
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

  function close(): void {
    cancelActive()
    closeBar()
    clearProposal()
  }

  return { open, close, hasPendingProposal: () => pending, propose }
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
 *  only when there is no fence and it doesn't read as prose. Kept in sync with
 *  the SW-side extractCodeBlock (this runs in the frame). */
export function extractReplyCode(reply: string, current?: string): { code: string | null; error?: string } {
  const fences = extractFences(reply)
  if (fences.length) {
    let chosen = fences[fences.length - 1]
    if (current != null && chosen === current) {
      for (let i = fences.length - 2; i >= 0; i--) {
        if (fences[i] !== current) { chosen = fences[i]; break }
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
