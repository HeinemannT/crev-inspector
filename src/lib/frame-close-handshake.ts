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

export function installCloseHandshake(canClose: () => boolean | Promise<boolean> = () => true): void {
  window.addEventListener('message', async (e: MessageEvent) => {
    // Only the parent frame (the content-script overlay host) may request close.
    // Defense in depth on top of manifest CSP frame-ancestors 'self'.
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
    // Phase 2: final answer with the user's choice.
    window.parent.postMessage({ type: 'CREV_OVERLAY_CLOSE_RESPONSE', ok }, '*');
  });
}
