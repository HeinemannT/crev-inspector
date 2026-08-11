/**
 * Iframe-side helper for the overlay close-request handshake.
 *
 * The host (content-frame-overlay.ts) postMessages CREV_OVERLAY_CLOSE_REQUEST
 * when the user clicks the close button or hits Escape. The iframe replies
 * CREV_OVERLAY_CLOSE_RESPONSE with { ok: boolean }; if ok the host removes
 * the iframe. Pages with dirty state pass a `canClose` predicate that prompts.
 *
 * Two-phase ack:
 *   1. PENDING — sent synchronously when the request arrives. Tells the host
 *      "I heard you, give me time to ask the user." The host clears its
 *      hung-iframe fallback timeout on PENDING and waits indefinitely.
 *   2. RESPONSE — sent when canClose() resolves. Carries the user's answer.
 *
 * Without PENDING the host hit a 1.5s fallback that force-closed the iframe
 * while the "Discard unsaved changes?" modal was still on screen, throwing
 * away the user's edits. The PENDING ack is virtually free (sync postMessage)
 * so it always fires — only when the iframe is genuinely dead (no listener)
 * does the host fall back.
 */

export function installCloseHandshake(
  canClose: () => boolean | Promise<boolean> = () => true,
  onAccepted?: () => void | Promise<void>,
): void {
  async function handleMessage(e: MessageEvent) {
    // Only the parent frame (the content-script overlay host in the BMP page
    // that framed this view) may request close. The overlay is deliberately
    // embedded into the http(s) BMP host page, so the parent is the BMP origin,
    // not the extension origin — this source check, not the CSP, is what keeps
    // an arbitrary framer from driving the close handshake.
    if (e.source !== window.parent) return;
    const msg = e.data as { type?: string } | undefined;
    if (msg?.type !== 'CREV_OVERLAY_CLOSE_REQUEST') return;
    // Phase 1: synchronous "I'm working on it" ack so the host drops
    // its hung-iframe fallback timeout.
    window.parent.postMessage({ type: 'CREV_OVERLAY_CLOSE_PENDING' }, '*');
    let ok = true;
    try {
      ok = await canClose();
    } catch {
      ok = true; // if the predicate throws, default to "ok to close" — don't trap users
    }
    if (ok && onAccepted) {
      try { await onAccepted(); }
      catch { /* Cleanup failure must not trap an otherwise closable frame. */ }
    }
    // Phase 2: final answer with the user's choice.
    window.parent.postMessage({ type: 'CREV_OVERLAY_CLOSE_RESPONSE', ok }, '*');
  }

  window.addEventListener('message', (e: MessageEvent) => { void handleMessage(e); });
}
