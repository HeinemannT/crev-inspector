/**
 * Shared AI coding-assistant UI, used by both the EC editor and the CVO/Text
 * studio. Owns:
 *   - the invoke COMMAND STRIP (Popover 1): a single row — sparkle, a mode chip
 *     (Ask / Edit, toggled by Tab or click), an instruction input, and an Enter
 *     hint — plus a scope footer stating exactly what code will be sent and to
 *     which model. Anchored near the selection head with a nub (falls back to
 *     the sparkle button when there is no selection).
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
import type { CodeSurface } from './code-surface'
import { h, svg } from '../lib/dom'
import { anchorPopover } from '../lib/popover-anchor'
import { sendFireForget } from '../lib/messaging'
import { fetchAiConfig } from './ai-config'
import { ICON_SPARKLE } from '../lib/icons'
import type { InspectorMessage } from '../lib/types'
import type {
  AiIntent, AiLang, AiObjectContext, AiRequestPayload, AiSelection,
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

/** Remembered across strip opens within a session (per surface). */
let lastIntent: AiIntent = 'ask'

export function createAiAssist(host: AiAssistHost): AiAssist {
  let model = ''
  let activeRequestId: string | null = null
  let answerText = ''
  /** Captured at send time so Accept/Reject act against a stable baseline. */
  let requestBefore = ''
  let requestSelection: AiSelection | null = null

  let popoverEl: HTMLElement | null = null
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

  // ── Invoke command strip ───────────────────────────────────────
  function open(): void {
    if (popoverEl) { closePopover(); return }
    void fetchAiConfig().then(c => { model = c.model ?? ''; updateScope() })
    openStrip()
  }

  function openStrip(): void {
    const fallback = host.anchorEl()
    const view = host.surface()?.view
    if (!fallback && !view) return

    const modechip = h('button', {
      class: 'ai-modechip', type: 'button',
      title: 'Tab toggles Ask / Edit',
    })
    renderModechip(modechip)
    modechip.addEventListener('click', () => { toggleIntent() })

    const input = h('input', {
      class: 'ai-strip-input',
      type: 'text',
      placeholder: placeholderFor(lastIntent),
      autocomplete: 'off',
      spellcheck: 'false',
    }) as HTMLInputElement

    input.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        const v = input.value.trim()
        if (v) submit(lastIntent, v)
      } else if (e.key === 'Tab') {
        e.preventDefault()
        toggleIntent()
      } else if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation(); closePopover()
      }
    })

    const scope = h('div', { class: 'ai-strip-scope' })
    const nub = h('span', { class: 'ai-strip-nub', 'aria-hidden': 'true' })

    const pop = h('div', {
      class: 'ai-strip',
      role: 'dialog',
      'aria-label': 'AI assistant',
      style: 'top:-9999px; left:-9999px;',
    },
      nub,
      h('div', { class: 'ai-strip-row' },
        h('span', { class: 'ai-strip-spark' }, svg(ICON_SPARKLE)),
        modechip,
        input,
        h('span', { class: 'ai-strip-kbd' }, '↵'),
      ),
      scope,
    )
    document.body.appendChild(pop)
    popoverEl = pop
    updateScope()
    anchorStrip(pop)
    input.focus()

    const onDown = (e: MouseEvent) => { if (!pop.contains(e.target as Node)) closePopover() }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closePopover() }
    setTimeout(() => {
      document.addEventListener('mousedown', onDown)
      document.addEventListener('keydown', onKey)
    }, 0)
    ;(pop as HTMLElement & { _cleanup?: () => void })._cleanup = () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }

  function renderModechip(chip: HTMLElement): void {
    chip.textContent = ''
    chip.appendChild(document.createTextNode(lastIntent === 'edit' ? 'Edit' : 'Ask'))
    chip.appendChild(h('span', { class: 'ai-modechip-tab' }, '⇥'))
  }

  function placeholderFor(intent: AiIntent): string {
    return intent === 'edit' ? 'Describe the edit…' : 'Ask about the selection…'
  }

  function toggleIntent(): void {
    lastIntent = lastIntent === 'ask' ? 'edit' : 'ask'
    if (!popoverEl) return
    const chip = popoverEl.querySelector<HTMLElement>('.ai-modechip')
    if (chip) renderModechip(chip)
    const input = popoverEl.querySelector<HTMLInputElement>('.ai-strip-input')
    if (input) { input.placeholder = placeholderFor(lastIntent); input.focus() }
    updateScope()
  }

  /** Line numbers of the current selection, or null when there is no selection. */
  function selectionLines(): { from: number; to: number } | null {
    const view = host.surface()?.view
    if (!view) return null
    const sel = view.state.selection.main
    if (sel.from === sel.to) return null
    return { from: view.state.doc.lineAt(sel.from).number, to: view.state.doc.lineAt(sel.to).number }
  }

  /** Scope footer: exactly what code will be sent + the target model. */
  function updateScope(): void {
    const scope = popoverEl?.querySelector<HTMLElement>('.ai-strip-scope')
    if (!scope) return
    const lines = selectionLines()
    const where = lines
      ? (lines.from === lines.to ? `selection · line ${lines.from}` : `selection · lines ${lines.from}–${lines.to}`)
      : 'whole script'
    scope.textContent = ''
    scope.appendChild(h('b', null, where))
    scope.appendChild(document.createTextNode(' · '))
    scope.appendChild(h('b', null, model || 'AI'))
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

  function closePopover(): void {
    if (!popoverEl) return
    ;(popoverEl as HTMLElement & { _cleanup?: () => void })._cleanup?.()
    popoverEl.remove()
    popoverEl = null
  }

  // ── Submit ─────────────────────────────────────────────────────
  function submit(intent: AiIntent, instruction: string): void {
    if (intent === 'ask') { submitAsk(instruction); return }
    submitEdit(instruction)
  }

  /** Ask hands off to the sidepanel chat tab. The strip closes; the panel opens
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
    closePopover()
  }

  function submitEdit(instruction: string): void {
    const surface = host.surface()
    const view = surface?.view
    if (!surface || !view) return
    cancelActive()
    clearProposal()
    closePopover()

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
    closePopover()
    requestBefore = view.state.doc.toString()
    requestSelection = null
    if (code === requestBefore) { showBarNoChange(); return }
    applyProposal(code)
    showBarAccept()
  }

  function close(): void {
    cancelActive()
    closePopover()
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
