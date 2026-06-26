/**
 * Blueprint ⇄ service-worker I/O. LAYOUT_LOAD / LAYOUT_APPLY are request/response, so they go over
 * the one-shot channel (`sendRequest`) — the SW replies to the sender automatically. (The earlier
 * port + hand-rolled reply-to-content-port routing was only needed because the persistent port
 * routes a handler's `respond` to the PANEL, not back to the content script.) This module owns both
 * the send and the result handling, keeping the controller/view free of transport detail.
 */
import { History } from '../lib/layout/history';
import { sendRequest } from '../lib/messaging';
import { showToast } from '../lib/toast';
import type { InspectorMessage } from '../lib/types';
import { bp, model } from './state';
import { render } from './view';

type LoadResult = Extract<InspectorMessage, { type: 'LAYOUT_LOAD_RESULT' }>;
type ApplyResult = Extract<InspectorMessage, { type: 'LAYOUT_APPLY_RESULT' }>;

/** Request the page's layout model and load it into the editor. Resolves false when the page isn't
 *  loadable (the caller tears the overlay down). */
export async function loadPage(rid: string): Promise<boolean> {
  const res = await sendRequest<LoadResult>({ type: 'LAYOUT_LOAD', rid });
  if (!bp.active) return false; // toggled off before the reply arrived
  if (!res?.ok || !res.model || !res.ctx) {
    showToast(`Blueprint: ${res?.error || 'could not load this page'}`, 'error');
    return false;
  }
  bp.baseline = res.model;
  bp.ctx = res.ctx;
  bp.env = res.env ?? null;
  bp.history = new History(res.model);
  bp.selectedId = null;
  const orphans = res.orphans?.length ?? 0;
  if (orphans) showToast(`Blueprint: ${orphans} widget(s) not on any tab (RESULT)`, 'info');
  render();
  return true;
}

/** Fire the guarded apply and rebase the editor onto the result. */
export async function applyPage(): Promise<void> {
  const m = model();
  if (!bp.ctx || !bp.baseline || !bp.env || !m) return;
  bp.applying = true; render();
  const res = await sendRequest<ApplyResult>({ type: 'LAYOUT_APPLY', env: bp.env, ctx: bp.ctx, baseline: bp.baseline, desired: m });
  if (!bp.active) return;
  bp.applying = false;
  if (res?.stale && res.model) {
    bp.baseline = res.model; bp.history = new History(res.model); bp.selectedId = null;
    showToast('Blueprint: the page changed elsewhere — reloaded. Re-apply your edits.', 'error');
    render(); return;
  }
  if (!res?.ok) { showToast(`Blueprint apply failed: ${res?.error || 'unknown'}`, 'error'); render(); return; }
  if (res.model) { bp.baseline = res.model; bp.history = new History(res.model); bp.selectedId = null; }
  showToast(res.noop ? 'Blueprint: nothing to apply' : 'Blueprint: changes applied', 'success');
  render();
}
