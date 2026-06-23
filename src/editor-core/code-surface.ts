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
import { EditorState, Compartment, type Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

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
  private view: EditorView | null = null
  private slots = new Map<string, SlotState>()
  private activeKey: string | null = null
  private currentLang = ''
  private programmaticSwap = false
  private wrap = false
  private readonly wrapCompartment = new Compartment()

  /** `getParent` is resolved on every (re)build / reattach rather than captured
   *  once — apps re-render their shell, which replaces the editor container. */
  constructor(private readonly getParent: () => HTMLElement | null, private readonly cb: CodeSurfaceCallbacks) {}

  /** Register (or refresh) the set of editable slots. New keys are seeded from
   *  `code`; existing keys have their loaded baseline + text reset to `code`
   *  (a fresh load from BMP), clearing dirty. Does not change which slot is
   *  active — call activate() after. */
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
    }
  }

  /** Make `key` the active slot, swapping the doc in place when the language
   *  family is unchanged or rebuilding the view otherwise. */
  activate(key: string, opts?: { scrollToLine?: number; scrollToText?: string }): void {
    const slot = this.slots.get(key)
    if (!slot) return
    if (this.activeKey && this.activeKey !== key) this.stash()
    const cs: CodeSlot = { key, lang: slot.lang, code: slot.text }

    const sameFamily = this.cb.sameLangFamily ?? ((a, b) => a === b)
    if (!this.view || !sameFamily(slot.lang, this.currentLang)) {
      this.rebuild(cs)
    } else {
      this.swapDoc(cs)
    }
    this.activeKey = key
    this.currentLang = slot.lang
    if (opts?.scrollToLine || opts?.scrollToText) this.jumpTo(opts.scrollToLine ?? 1, opts.scrollToText)
    this.cb.onAfterLoad?.(this.view!, cs)
  }

  private rebuild(slot: CodeSlot): void {
    const parent = this.getParent()
    if (!parent) return
    this.view?.destroy()
    const state = EditorState.create({
      doc: slot.code,
      extensions: [
        ...this.cb.buildExtensions(slot),
        this.wrapCompartment.of(this.wrap ? EditorView.lineWrapping : []),
        EditorView.updateListener.of(u => this.onUpdate(u)),
      ],
    })
    this.view = new EditorView({ state, parent })
    this.restoreNav(slot.code)
    this.view.focus()
  }

  private swapDoc(slot: CodeSlot): void {
    const view = this.view!
    this.programmaticSwap = true
    try {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: slot.code }, scrollIntoView: false })
    } finally {
      this.programmaticSwap = false
    }
    this.restoreNav(slot.code)
    this.view!.focus()
  }

  /** Restore the stashed cursor + scroll for the active slot, when the stashed
   *  text still matches the loaded body. */
  private restoreNav(code: string): void {
    const st = this.activeKey ? this.slots.get(this.activeKey) : undefined
    const view = this.view
    if (!view) return
    if (st && st.text === code) {
      const len = view.state.doc.length
      const anchor = Math.min(st.selection.anchor, len)
      const head = Math.min(st.selection.head, len)
      view.dispatch({ selection: { anchor, head } })
      requestAnimationFrame(() => { if (view.scrollDOM) view.scrollDOM.scrollTop = st.scrollTop })
    }
  }

  private onUpdate(u: import('@codemirror/view').ViewUpdate): void {
    if ((u.selectionSet || u.docChanged) && this.cb.onCursor) {
      const pos = u.state.selection.main.head
      const line = u.state.doc.lineAt(pos)
      this.cb.onCursor(line.number, pos - line.from + 1)
    }
    if (!u.docChanged || this.programmaticSwap) return
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
    if (!this.view || !this.activeKey) return
    const st = this.slots.get(this.activeKey)
    if (!st) return
    st.text = this.view.state.doc.toString()
    const sel = this.view.state.selection.main
    st.selection = { anchor: sel.anchor, head: sel.head }
    st.scrollTop = this.view.scrollDOM?.scrollTop ?? 0
  }

  /** Live text for a slot — the view's doc when active, else the cached text. */
  textFor(key: string): string {
    if (key === this.activeKey && this.view) return this.view.state.doc.toString()
    return this.slots.get(key)?.text ?? ''
  }

  /** Active slot's current text. */
  getDoc(): string {
    return this.view?.state.doc.toString() ?? ''
  }

  /** Selected text if any, else the whole active document. */
  getRunCode(): string {
    if (!this.view) return ''
    const { from, to } = this.view.state.selection.main
    return from !== to ? this.view.state.doc.sliceString(from, to) : this.view.state.doc.toString()
  }

  isDirty(key?: string): boolean {
    if (key) return this.slots.get(key)?.dirty ?? false
    for (const st of this.slots.values()) if (st.dirty) return true
    return false
  }

  /** Mark the active slot saved: its current text becomes the loaded baseline,
   *  dirty clears. Call after a successful BMP write. */
  markSaved(key = this.activeKey): void {
    if (!key) return
    const st = this.slots.get(key)
    if (!st) return
    st.loaded = key === this.activeKey && this.view ? this.view.state.doc.toString() : st.text
    st.text = st.loaded
    if (st.dirty) { st.dirty = false; if (key === this.activeKey) this.cb.onDirtyChange?.(false) }
  }

  /** Revert the active slot to its loaded (BMP) value. */
  discard(): void {
    if (!this.view || !this.activeKey) return
    const st = this.slots.get(this.activeKey)
    if (!st) return
    this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: st.loaded } })
    st.text = st.loaded
    if (st.dirty) { st.dirty = false; this.cb.onDirtyChange?.(false) }
    this.view.focus()
  }

  insertAtCursor(text: string): void {
    if (!this.view) return
    const { from, to } = this.view.state.selection.main
    this.view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } })
    this.view.focus()
  }

  jumpTo(line: number, text?: string): void {
    const view = this.view
    if (!view) return
    requestAnimationFrame(() => {
      const doc = view.state.doc
      let target = Math.max(1, Math.min(line, doc.lines))
      if (text) {
        for (let i = 1; i <= doc.lines; i++) {
          if (doc.line(i).text.includes(text)) { target = i; break }
        }
      }
      const l = doc.line(target)
      view.dispatch({ selection: { anchor: l.from, head: l.from }, effects: EditorView.scrollIntoView(l.from, { y: 'center' }) })
      view.focus()
    })
  }

  setWrap(wrap: boolean): void {
    this.wrap = wrap
    this.view?.dispatch({ effects: this.wrapCompartment.reconfigure(wrap ? EditorView.lineWrapping : []) })
  }

  /** Re-attach the view's DOM into the (current) parent after the app re-rendered
   *  its shell, which detaches it. No-op when already attached or no parent yet. */
  reattach(): void {
    const parent = this.getParent()
    if (this.view && parent && this.view.dom.parentElement !== parent) parent.appendChild(this.view.dom)
  }

  focus(): void { this.view?.focus() }

  get current(): string | null { return this.activeKey }

  destroy(): void {
    this.view?.destroy()
    this.view = null
    this.slots.clear()
    this.activeKey = null
  }
}
