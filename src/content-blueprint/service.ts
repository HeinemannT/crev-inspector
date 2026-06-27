/**
 * Blueprint ⇄ service-worker I/O. LAYOUT_LOAD / LAYOUT_APPLY are request/response, so they go over
 * the one-shot channel (`sendRequest`) — the SW replies to the sender automatically. (The earlier
 * port + hand-rolled reply-to-content-port routing was only needed because the persistent port
 * routes a handler's `respond` to the PANEL, not back to the content script.) This module owns both
 * the send and the result handling, keeping the controller/view free of transport detail.
 */
import { History } from '../lib/layout/history';
import { sendRequest } from '../lib/messaging';
import { sendToSW } from '../lib/content-port';
import { showToast } from '../lib/toast';
import type { InspectorMessage } from '../lib/types';
import type { LModel } from '../lib/layout/types';
import { bp, model } from './state';
import { ridElementMap } from './geometry';
import { captureViewportNow } from './thumbs';
import { render } from './view';

type LoadResult = Extract<InspectorMessage, { type: 'LAYOUT_LOAD_RESULT' }>;
type CreateTabsetResult = Extract<InspectorMessage, { type: 'LAYOUT_CREATE_TABSET_RESULT' }>;
type ApplyResult = Extract<InspectorMessage, { type: 'LAYOUT_APPLY_RESULT' }>;
type BlastResult = Extract<InspectorMessage, { type: 'LAYOUT_BLAST_RESULT' }>;

/** Adopt `m` as the new baseline: fresh history, clear selection. The single point where the editor
 *  rebases onto an authoritative server model (initial load + post-apply + stale-reload). */
function rebase(m: LModel): void {
  bp.baseline = m;
  bp.history = new History(m);
  bp.selectedId = null;
}

/** True if the session we started this I/O for is still the live one. A reply that arrives after the
 *  overlay was toggled off — or off-then-on (a new session, higher `gen`) — must not mutate state. */
const sameSession = (g: number): boolean => bp.active && bp.gen === g;

/** Request the page's layout model and load it into the editor. Resolves false when the page isn't
 *  loadable (the caller tears the overlay down). */
export async function loadPage(rid: string): Promise<boolean> {
  const g = bp.gen;
  const res = await sendRequest<LoadResult>({ type: 'LAYOUT_LOAD', rid });
  if (!sameSession(g)) return false; // toggled off (or off-then-on) before the reply arrived
  // RESULT-only page with no tabset → keep the overlay up and show the create-tabset prompt.
  if (res?.ok && res.needsTabset) {
    bp.needsTabset = res.needsTabset;
    bp.env = res.env ?? null;
    render();
    return true;
  }
  if (!res?.ok || !res.model || !res.ctx) {
    showToast(`Blueprint: ${res?.error || 'could not load this page'}`, 'error');
    return false;
  }
  rebase(res.model);
  bp.ctx = res.ctx;
  bp.env = res.env ?? null;
  const orphans = res.orphans?.length ?? 0;
  if (orphans) showToast(`Blueprint: ${orphans} widget(s) not placed on any tab`, 'info');
  // Grab the initial viewport's widget thumbnails BEFORE the first render paints the opaque result
  // panel — there's no panel to hide yet, so the capture is flicker-free and the thumbnails are ready
  // for the first paint. Best-effort: render regardless. (Later scroll-in widgets capture via the
  // debounced scheduleThumbs, which does briefly hide the panel.)
  try { await captureViewportNow(ridElementMap()); } catch { /* thumbnails are best-effort */ }
  if (!sameSession(g)) return false;
  render();
  return true;
}

/** Create a dedicated tabset for a RESULT-only page (the create-tabset prompt's confirm), then adopt
 *  the freshly-loaded model. */
export async function createTabset(name: string): Promise<void> {
  const page = bp.needsTabset;
  if (!page || bp.creatingTabset) return;
  const g = bp.gen;
  bp.creatingTabset = true; render();
  const res = await sendRequest<CreateTabsetResult>({ type: 'LAYOUT_CREATE_TABSET', page, name });
  if (!sameSession(g)) return;
  bp.creatingTabset = false;
  if (!res?.ok || !res.model || !res.ctx) {
    showToast(`Blueprint: ${res?.error || 'could not create a tabset'}`, 'error');
    render();
    return;
  }
  bp.needsTabset = null;
  rebase(res.model);
  bp.ctx = res.ctx;
  bp.env = res.env ?? null;
  showToast('Blueprint: tabset created. You can now arrange this page.', 'success');
  render();
}

/** Best-effort blast-radius probe for the open apply-preview. Stores the result on `bp.blast` and
 *  re-renders so the modal can show the warnings; silent on failure (the modal just omits them). The
 *  reply is dropped unless it's still the same session, the preview is open, AND it's for the LATEST
 *  preview (`seq`) — a slow walk for an earlier preview must not overwrite a newer one's result. */
export async function fetchBlast(seq: number, pageId: string, containers: { id: string; rid?: string }[]): Promise<void> {
  const g = bp.gen;
  try {
    const res = await sendRequest<BlastResult>({ type: 'LAYOUT_BLAST', pageId, containers });
    if (!sameSession(g) || !bp.preview || bp.blastSeq !== seq) return;
    bp.blast = { fanout: res?.fanout ?? null, blast: res?.blast ?? null };
    render();
  } catch { /* fail silent — no blast warning */ }
}

/** Fire the guarded apply and rebase the editor onto the result. */
export async function applyPage(): Promise<void> {
  const m = model();
  if (!bp.ctx || !bp.baseline || !bp.env || !m) return;
  const g = bp.gen;
  bp.applying = true; render();
  const res = await sendRequest<ApplyResult>({ type: 'LAYOUT_APPLY', env: bp.env, ctx: bp.ctx, baseline: bp.baseline, desired: m });
  if (!sameSession(g)) return;
  bp.applying = false;
  if (res?.stale && res.model) {
    rebase(res.model);
    showToast('Blueprint: the page changed elsewhere, so it was reloaded. Re-apply your edits.', 'error');
    render(); return;
  }
  if (!res?.ok) { showToast(`Blueprint apply failed: ${res?.error || 'unknown'}`, 'error'); render(); return; }
  if (res.noop) { if (res.model) rebase(res.model); showToast('Blueprint: nothing to apply', 'info'); render(); return; }
  // Committed. The live grid can only reflow on a real page load — so refresh to show the new layout,
  // and turn blueprint OFF (SW state + sidebar toggle + overlay) so we don't reopen onto a stale model.
  showToast('Blueprint: changes applied. Refreshing…', 'success');
  sendToSW({ type: 'BLUEPRINT_TOGGLE' }); // flips per-window state off; updates the sidebar toggle
  setTimeout(() => location.reload(), 500);
}
