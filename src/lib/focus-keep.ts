/**
 * Preserve focus + caret across a re-render that detaches a persistent <input>.
 *
 * Several panels (Browse, code-search) re-render by wiping a container and
 * reattaching persistent input nodes, which drops focus. Each had grown its own
 * slightly-different capture/restore — and each grew its own bug. This is the
 * single, tested implementation.
 *
 * Restore is by INTENT, not just live focus: a streamed result can re-render and
 * blur the input to <body> a tick before the keystroke-driven render runs, so
 * "is it focused right now?" misses it. "Did the user type here within the last
 * second?" reliably doesn't. But we only reclaim when focus is on that input or
 * has fallen to <body> — never when the user deliberately moved focus to another
 * control, so a recent keystroke can't yank the caret off a button.
 */

/** Window after a keystroke in which a render may still reclaim focus. */
export const FOCUS_INTENT_MS = 1000;

export interface TypingIntent {
  /** The persistent input the user most recently typed in. */
  el: HTMLInputElement | null;
  /** Date.now() of that keystroke. */
  at: number;
}

/**
 * Call BEFORE a render that may detach `intent.el`; invoke the returned
 * `restore()` AFTER. `isAttached` confirms the node is still in the rendered
 * tree (defaults to a document-body check). Caret is read from the persistent
 * node, so it survives even when focus had fallen to <body>.
 */
export function captureTypingFocus(
  intent: TypingIntent,
  isAttached: (el: HTMLElement) => boolean = (el) => document.body.contains(el),
): () => void {
  const { el, at } = intent;
  const active = document.activeElement;
  const eligible = !!el
    && Date.now() - at < FOCUS_INTENT_MS
    && (active === el || active === document.body);
  const selStart = eligible ? el!.selectionStart : null;
  const selEnd = eligible ? el!.selectionEnd : null;
  return () => {
    if (!eligible || !el || !isAttached(el)) return;
    try {
      el.focus({ preventScroll: true });
      if (selStart != null) el.setSelectionRange(selStart, selEnd ?? selStart);
    } catch { /* not all browsers support setSelectionRange on every input type */ }
  };
}
