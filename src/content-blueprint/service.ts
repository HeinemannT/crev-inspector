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
import { BP_RESUME_KEY } from '../lib/blueprint-resume';
import { bp, model } from './state';
import { render } from './view';

type LoadResult = Extract<InspectorMessage, { type: 'LAYOUT_LOAD_RESULT' }>;
type ApplyResult = Extract<InspectorMessage, { type: 'LAYOUT_APPLY_RESULT' }>;
type BlastResult = Extract<InspectorMessage, { type: 'LAYOUT_BLAST_RESULT' }>;
type FlowRefsResult = Extract<InspectorMessage, { type: 'LAYOUT_FLOW_REFS_RESULT' }>;
type FlowRefChildrenResult = Extract<InspectorMessage, { type: 'LAYOUT_FLOW_REF_CHILDREN_RESULT' }>;

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

/** Request the page's layout model and load it into the editor. `prefer` chooses, for a templated
 *  instance, whether to open the shared TEMPLATE (default) or THIS instance. Resolves false when the
 *  page isn't loadable (the caller tears the overlay down). */
export async function loadPage(rid: string, prefer: 'template' | 'instance' = 'template'): Promise<boolean> {
  const g = bp.gen;
  const res = await sendRequest<LoadResult>({ type: 'LAYOUT_LOAD', rid, prefer });
  if (!sameSession(g)) return false; // toggled off (or off-then-on) before the reply arrived
  if (!res?.ok || !res.model || !res.ctx) {
    showToast(`Blueprint: ${res?.error || 'could not load this page'}`, 'error');
    return false;
  }
  rebase(res.model);
  bp.ctx = res.ctx;
  bp.editingTemplate = res.ctx.editingTemplate ?? false;
  bp.env = res.env ?? null;
  const orphans = res.orphans?.length ?? 0;
  if (orphans) showToast(`Blueprint: ${orphans} widget${orphans === 1 ? ' is' : 's are'} bound to this page but placed on no tab or container, so the editor does not show ${orphans === 1 ? 'it' : 'them'}`, 'info');
  render();
  return true;
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

/** Fetch the flow "wire to existing" list for the OPEN flow picker (lean, at picker-open). Stores the
 *  rows on `bp.flowRefList` and re-renders; a reply for a closed/changed picker is dropped. */
export async function fetchFlowRefs(refClass: 'InputSet' | 'EditPage'): Promise<void> {
  const g = bp.gen;
  bp.flowRefList = null; // loading state
  try {
    const res = await sendRequest<FlowRefsResult>({ type: 'LAYOUT_FLOW_REFS', refClass });
    if (!sameSession(g) || !bp.flowPicker?.wireExisting) return;
    bp.flowRefList = res?.ok ? (res.refs ?? []) : [];
    if (!res?.ok) showToast(`Blueprint: could not list existing ${refClass}s: ${res?.error || 'unknown'}`, 'error');
    render();
  } catch {
    if (sameSession(g) && bp.flowPicker?.wireExisting) { bp.flowRefList = []; render(); }
  }
}

/** Bake the ref-children cache into the baseline + present model (read-only projection data, keyed by
 *  ref businessId), so the pure diff/render see a wired existing off-page reference's real contents.
 *  Not a history push — this is not an edit; future edits carry it forward via cloneModel. */
function bakeRefChildren(): void {
  const rec = Object.fromEntries([...bp.flowRefChildren]);
  if (bp.baseline) bp.baseline.flowRefChildren = rec;
  const m = model(); if (m) m.flowRefChildren = rec;
  render();
}

/** Fetch the CURRENT children of an existing off-page InputSet/EditPage the user just wired to, so the
 *  cell shows its real contents instead of the "unknown contents" note. Cached per ref for the session
 *  (re-opening/re-wiring never refetches). Fails soft — on error the cell keeps the honest note. */
export async function fetchFlowRefChildren(refId: string, refClass: string): Promise<void> {
  if (bp.flowRefChildren.has(refId)) { bakeRefChildren(); return; }
  const g = bp.gen;
  bp.flowRefChildrenPending.add(refId); render();
  try {
    const res = await sendRequest<FlowRefChildrenResult>({ type: 'LAYOUT_FLOW_REF_CHILDREN', refId });
    if (!sameSession(g)) return;
    bp.flowRefChildrenPending.delete(refId);
    if (res?.ok) { bp.flowRefChildren.set(refId, { className: refClass, children: res.children ?? [] }); bakeRefChildren(); }
    else render(); // fall back to the honest note (don't hard-error)
  } catch {
    if (sameSession(g)) { bp.flowRefChildrenPending.delete(refId); render(); }
  }
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
  // IMPORTANT: do NOT rebase `res.model` on the success path — reload instead. After a virtual-tabset
  // apply (a "+ Create tabset" that just created the page's first real tabset), the SW's post-apply
  // re-fetch ran against the PRE-apply result-only ctx, so the new tabset isn't discoverable through it
  // and that model is degenerate (empty). Only the fresh loadPage below re-discovers the real tabset.
  // The session RESUMES after the reload: a sessionStorage flag (page-scoped, survives the refresh)
  // tells the fresh content script to ask the SW to re-enable blueprint — with the SAME edit target,
  // so applying to "This instance" doesn't dump the user back into template mode (or, before this,
  // into nothing at all: the off-toggle used to end the session and the user had to re-enter by hand).
  try {
    sessionStorage.setItem(BP_RESUME_KEY, JSON.stringify({
      prefer: bp.editingTemplate ? 'template' : 'instance', t: Date.now(),
    }));
  } catch { /* sandboxed / storage disabled — resume is best-effort */ }
  showToast('Blueprint: changes applied. Refreshing…', 'success');
  sendToSW({ type: 'BLUEPRINT_TOGGLE' }); // flips per-window state off; updates the sidebar toggle
  setTimeout(() => location.reload(), 500);
}
