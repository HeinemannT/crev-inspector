/**
 * editor-core / CodeSurface — the multi-slot CodeMirror editing engine shared
 * by the EC editor and the CVO studio.
 *
 * A "slot" is one editable document (keyed by an app string — e.g. a CVO's
 * `html`/`javascript`, or the editor's `instance:expression`). The surface owns
 * exactly one live EditorView and, for every slot, the loaded (BMP) text plus
 * the user's working text, cursor, scroll, and dirty flag. Switching slots
 * swaps the doc in place when the language family is unchanged, else rebuilds
 * the view — so a template⇄instance switch (same language) keeps selection and
 * scroll without a reflow, while html→javascript rebuilds with the right
 * grammar.
 *
 * The app supplies the per-slot extension set (base scaffold + language + its
 * own keymap/listeners/linters) via `buildExtensions`; the surface adds line
 * wrapping and its own change/cursor listener on top. Dirty is computed here
 * (doc ≠ loaded text) and pushed back through `onDirtyChange` — Save/Discard
 * are `markSaved()` / `discard()`, so the app needn't track an "original" copy.
 */
import { EditorState, Compartment, Annotation, type Extension, type TransactionSpec } from '@codemirror/state'
import { EditorView, type ViewUpdate } from '@codemirror/view'
import { pickNearestLine } from './text-nav'

/** Tags the transaction CodeSurface uses to swap a slot's document in place, so
 *  app-supplied update listeners can tell a programmatic slot-swap from a real
 *  user edit (and skip preview/dirty/stale reactions accordingly). */
export const programmaticSwap = Annotation.define<boolean>()

/** True when `update` carries CodeSurface's programmatic-swap annotation — i.e.
 *  the docChange came from `activate()`, not the user typing. App listeners
 *  passed via `buildExtensions` should early-return on this. */
export function isProgrammaticSwap(update: ViewUpdate): boolean {
  return update.transactions.some(t => t.annotation(programmaticSwap) === true)
}

export interface CodeSlot {
  /** App-chosen identity, unique per editable document. */
  key: string
  /** Language family — drives swap-vs-rebuild and the grammar in buildExtensions. */
  lang: string
  /** The loaded (BMP) text for this slot. */
  code: string
}

export interface CodeSurfaceCallbacks {
  /** Full extension list for a slot: base scaffold + language + app keymap /
   *  listeners / linters. The surface appends wrapping + its own listener. */
  buildExtensions: (slot: CodeSlot) => Extension[]
  /** Whether two language families can swap-in-place (default: identical). */
  sameLangFamily?: (a: string, b: string) => boolean
  /** Fired when the ACTIVE slot's dirty state flips. */
  onDirtyChange?: (dirty: boolean) => void
  /** Fired after a slot is (re)loaded into the view — seed trackers, clear
   *  stale markers, etc. */
  onAfterLoad?: (view: EditorView, slot: CodeSlot) => void
  /** Fired on cursor/selection change (1-based line + column). */
  onCursor?: (line: number, col: number) => void
}

interface SlotState {
  lang: string
  /** Loaded (BMP) value — Discard target + dirty baseline. */
  loaded: string
  /** Last live text (kept for inactive slots so textFor() is accurate). */
  text: string
  selection: { anchor: number; head: number }
  scrollTop: number
  dirty: boolean
}

export class CodeSurface {
  private _view: EditorView | null = null
  private slots = new Map<string, SlotState>()
  private activeKey: string | null = null
  private currentLang = ''
  private wrap = false
  private readonly wrapCompartment = new Compartment()
  /** Reconfigurable slot for transient overlay extensions (the AI edit
   *  merge-diff). Empty by default; the AI assist reconfigures it with a
   *  `unifiedMergeView` while a proposal is pending, then clears it. */
  private readonly overlayCompartment = new Compartment()

  /** `getParent` is resolved on every (re)build / reattach rather than captured
   *  once — apps re-render their shell, which replaces the editor container. */
  constructor(private readonly getParent: () => HTMLElement | null, private readonly cb: CodeSurfaceCallbacks) {}

  /** Register (or refresh) the set of editable slots. New keys are seeded from
   *  `code`; existing keys have their loaded baseline + working text reset to
   *  `code` (a fresh load from BMP), clearing dirty. If a re-seeded key is the
   *  ACTIVE slot with a live view, the view's doc is replaced too, so state and
   *  view never diverge. Does not change which slot is active — call activate()
   *  after. (Typically called once at load, before the first activate().) */
  setSlots(slots: CodeSlot[]): void {
    for (const s of slots) {
      this.slots.set(s.key, {
        lang: s.lang,
        loaded: s.code,
        text: s.code,
        selection: { anchor: 0, head: 0 },
        scrollTop: 0,
        dirty: false,
      })
      if (s.key === this.activeKey && this._view && this._view.state.doc.toString() !== s.code) {
        this._view.dispatch({
          changes: { from: 0, to: this._view.state.doc.length, insert: s.code },
          annotations: programmaticSwap.of(true),
        })
      }
    }
  }

  /** Re-seed slots from a fresh BMP fetch after a save (the save→reload pattern):
   *  updates each slot's loaded baseline + working text and clears dirty. For
   *  the ACTIVE slot, also replaces the live doc so the view shows the
   *  server-canonical value. Use this instead of markSaved() when the caller has
   *  re-read from BMP (the safe path: a save that doesn't reload can act on a
   *  stale baseline). */
  reloadSlots(slots: CodeSlot[]): void {
    this.setSlots(slots)   // re-seeds baselines/text/dirty + syncs the active view
    if (this.activeKey) this.cb.onDirtyChange?.(this.isDirty(this.activeKey))
  }

  /** Make `key` the active slot, swapping the doc in place when the language
   *  family is unchanged or rebuilding the view otherwise. */
  activate(key: string, opts?: { scrollToLine?: number; scrollToText?: string }): void {
    const slot = this.slots.get(key)
    if (!slot) return
    if (this.activeKey && this.activeKey !== key) this.stash()
    const cs: CodeSlot = { key, lang: slot.lang, code: slot.text }

    const sameFamily = this.cb.sameLangFamily ?? ((a, b) => a === b)
    if (!this._view || !sameFamily(slot.lang, this.currentLang)) {
      this.rebuild(cs)
    } else {
      this.swapDoc(cs)
    }
    this.activeKey = key
    this.currentLang = slot.lang
    if (opts?.scrollToLine || opts?.scrollToText) this.jumpTo(opts.scrollToLine ?? 1, opts.scrollToText)
    this.cb.onAfterLoad?.(this._view!, cs)
  }

  private rebuild(slot: CodeSlot): void {
    const parent = this.getParent()
    if (!parent) return
    this._view?.destroy()
    const state = EditorState.create({
      doc: slot.code,
      extensions: [
        ...this.cb.buildExtensions(slot),
        this.wrapCompartment.of(this.wrap ? EditorView.lineWrapping : []),
        this.overlayCompartment.of([]),
        EditorView.updateListener.of(u => this.onUpdate(u)),
      ],
    })
    this._view = new EditorView({ state, parent })
    this.restoreNav(slot.code)
    this._view.focus()
  }

  private swapDoc(slot: CodeSlot): void {
    const view = this._view!
    // Annotated so both our own onUpdate and app-supplied listeners can tell
    // this is a programmatic slot-swap, not a user edit.
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: slot.code },
      scrollIntoView: false,
      annotations: programmaticSwap.of(true),
    })
    this.restoreNav(slot.code)
    this._view!.focus()
  }

  /** Restore the stashed cursor + scroll for the active slot, when the stashed
   *  text still matches the loaded body. */
  private restoreNav(code: string): void {
    const st = this.activeKey ? this.slots.get(this.activeKey) : undefined
    const view = this._view
    if (!view) return
    if (st && st.text === code) {
      const len = view.state.doc.length
      const anchor = Math.min(st.selection.anchor, len)
      const head = Math.min(st.selection.head, len)
      view.dispatch({ selection: { anchor, head } })
      requestAnimationFrame(() => { if (view.scrollDOM) view.scrollDOM.scrollTop = st.scrollTop })
    }
  }

  private onUpdate(u: ViewUpdate): void {
    if ((u.selectionSet || u.docChanged) && this.cb.onCursor) {
      const pos = u.state.selection.main.head
      const line = u.state.doc.lineAt(pos)
      this.cb.onCursor(line.number, pos - line.from + 1)
    }
    if (!u.docChanged || isProgrammaticSwap(u)) return
    const st = this.activeKey ? this.slots.get(this.activeKey) : undefined
    if (!st) return
    st.text = u.state.doc.toString()
    const nowDirty = st.text !== st.loaded
    if (nowDirty !== st.dirty) {
      st.dirty = nowDirty
      this.cb.onDirtyChange?.(nowDirty)
    }
  }

  /** Write the live view's text + cursor + scroll into the active slot's cache
   *  (so a switch away preserves them and textFor() stays accurate). */
  stash(): void {
    if (!this._view || !this.activeKey) return
    const st = this.slots.get(this.activeKey)
    if (!st) return
    st.text = this._view.state.doc.toString()
    const sel = this._view.state.selection.main
    st.selection = { anchor: sel.anchor, head: sel.head }
    st.scrollTop = this._view.scrollDOM?.scrollTop ?? 0
  }

  /** Live text for a slot — the view's doc when active, else the cached text. */
  textFor(key: string): string {
    if (key === this.activeKey && this._view) return this._view.state.doc.toString()
    return this.slots.get(key)?.text ?? ''
  }

  /** Active slot's current text. */
  getDoc(): string {
    return this._view?.state.doc.toString() ?? ''
  }

  /** Selected text if any, else the whole active document. */
  getRunCode(): string {
    if (!this._view) return ''
    const { from, to } = this._view.state.selection.main
    return from !== to ? this._view.state.doc.sliceString(from, to) : this._view.state.doc.toString()
  }

  isDirty(key?: string): boolean {
    if (key) return this.slots.get(key)?.dirty ?? false
    for (const st of this.slots.values()) if (st.dirty) return true
    return false
  }

  /** Baseline-move only: the slot's current text becomes the loaded baseline and
   *  dirty clears — it does NOT re-read from BMP. Fine when the saved value is
   *  authoritative (a plain string write). When BMP may have transformed the
   *  value, prefer reloadSlots() with a fresh fetch. For a NON-active key the
   *  baseline moves to the slot's last-stashed text, so the caller must have
   *  stashed (or saved the active slot) first; otherwise it could pin a stale
   *  baseline. */
  markSaved(key = this.activeKey): void {
    if (!key) return
    const st = this.slots.get(key)
    if (!st) return
    st.loaded = key === this.activeKey && this._view ? this._view.state.doc.toString() : st.text
    st.text = st.loaded
    if (st.dirty) { st.dirty = false; if (key === this.activeKey) this.cb.onDirtyChange?.(false) }
  }

  /** Revert the active slot to its loaded (BMP) value. */
  discard(): void {
    if (!this._view || !this.activeKey) return
    const st = this.slots.get(this.activeKey)
    if (!st) return
    this._view.dispatch({ changes: { from: 0, to: this._view.state.doc.length, insert: st.loaded } })
    st.text = st.loaded
    if (st.dirty) { st.dirty = false; this.cb.onDirtyChange?.(false) }
    this._view.focus()
  }

  insertAtCursor(text: string): void {
    if (!this._view) return
    const { from, to } = this._view.state.selection.main
    this._view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } })
    this._view.focus()
  }

  /** Replace the active slot's whole document (e.g. after formatting). Goes
   *  through a normal transaction, so it lands in the undo history and marks the
   *  slot dirty. No-op when the text is unchanged. */
  replaceActive(text: string): void {
    if (!this._view) return
    const cur = this._view.state.doc.toString()
    if (cur === text) return
    this._view.dispatch({ changes: { from: 0, to: cur.length, insert: text } })
    this._view.focus()
  }

  /** Jump to a line, or to the occurrence of `text` NEAREST to `line` (the hint).
   *  Nearest-match — not first-match — so duplicate lines (a lone `}`, repeated
   *  `"id"`) resolve to the intended hit even when the body is a few lines off
   *  from the caller's line number (e.g. a code-search jump). */
  jumpTo(line: number, text?: string): void {
    const view = this._view
    if (!view) return
    requestAnimationFrame(() => {
      const doc = view.state.doc
      let target = Math.max(1, Math.min(line, doc.lines))
      if (text) {
        const best = pickNearestLine(i => doc.line(i).text, doc.lines, text, line)
        if (best > 0) target = best
      }
      const l = doc.line(target)
      view.dispatch({ selection: { anchor: l.from, head: l.from }, effects: EditorView.scrollIntoView(l.from, { y: 'center' }) })
      view.focus()
    })
  }

  setWrap(wrap: boolean): void {
    this.wrap = wrap
    this._view?.dispatch({ effects: this.wrapCompartment.reconfigure(wrap ? EditorView.lineWrapping : []) })
  }

  /** Reconfigure the transient overlay slot (pass `[]` to clear). Used by the
   *  AI edit flow to layer a `unifiedMergeView` over the live doc, then remove
   *  it on accept/reject. */
  setOverlay(ext: Extension): void {
    this._view?.dispatch({ effects: this.overlayCompartment.reconfigure(ext) })
  }

  /** Re-attach the view's DOM into the (current) parent after the app re-rendered
   *  its shell, which detaches it. A detached-then-reattached view needs a
   *  remeasure (its layout cache is stale), so do it here. No-op when already
   *  attached or no parent yet. */
  reattach(): void {
    const parent = this.getParent()
    if (this._view && parent && this._view.dom.parentElement !== parent) {
      parent.appendChild(this._view.dom)
      this._view.requestMeasure()
    }
  }

  focus(): void { this._view?.focus() }

  /** The live EditorView, for app-specific extensions that need it directly
   *  (hover, var highlight, runtime-error markers, history-load dispatch).
   *  Null before the first activate(). Prefer the surface's own methods for
   *  lifecycle; this is the escape hatch for read-only / feature dispatches. */
  get view(): EditorView | null { return this._view }

  /** Passthrough for app feature code that needs to dispatch against the live
   *  view without holding its own reference. No-op when there's no view. */
  dispatch(spec: TransactionSpec): void { this._view?.dispatch(spec) }

  get current(): string | null { return this.activeKey }

  destroy(): void {
    this._view?.destroy()
    this._view = null
    this.slots.clear()
    this.activeKey = null
  }
}
