/**
 * Blueprint ⇄ service-worker I/O. LAYOUT_LOAD / LAYOUT_APPLY are request/response, so they go over
 * the one-shot channel (`sendRequest`) — the SW replies to the sender automatically. (The earlier
 * port + hand-rolled reply-to-content-port routing was only needed because the persistent port
 * routes a handler's `respond` to the PANEL, not back to the content script.) This module owns both
 * the send and the result handling, keeping the controller/view free of transport detail.
 */
import { History } from '../lib/layout/history';
import { sendRequest, sendRequestBounded } from '../lib/messaging';
import { sendToSW } from '../lib/content-port';
import { showToast } from '../lib/toast';
import type { InspectorMessage } from '../lib/types';
import type { LModel } from '../lib/layout/types';
import type { FlowRefListItem } from '../lib/layout/sync';
import { BP_RESUME_KEY } from '../lib/blueprint-resume';
import { bp } from './state';
import { render } from './view';
import type { ApplyResolution, ApplySessionIO } from './apply-session';

type LoadResult = Extract<InspectorMessage, { type: 'LAYOUT_LOAD_RESULT' }>;
type BlastResult = Extract<InspectorMessage, { type: 'LAYOUT_BLAST_RESULT' }>;
type FlowRefsResult = Extract<InspectorMessage, { type: 'LAYOUT_FLOW_REFS_RESULT' }>;
type FlowRefChildrenResult = Extract<InspectorMessage, { type: 'LAYOUT_FLOW_REF_CHILDREN_RESULT' }>;
type TypeSchemasResult = Extract<InspectorMessage, { type: 'FETCH_TYPE_SCHEMAS_RESULT' }>;
type PortableIdPreflightResult = Extract<InspectorMessage, { type: 'LAYOUT_PORTABLE_ID_PREFLIGHT_RESULT' }>;

/** Adopt `m` as the new baseline: fresh history, clear selection. The single point where the editor
 *  rebases onto an authoritative server model (initial load + post-apply + stale-reload). */
function rebase(m: LModel): void {
  bp.baseline = m;
  bp.history = new History(m);
  bp.selectedId = null;
  // Drop the on-demand wired-ref children cache: after a rebase onto freshly-fetched content (a partial
  // apply, or a stale-guard reload), the cached children of an off-page InputSet/EditPage may be stale
  // (e.g. an add that landed under it). model() re-injects this cache every read, and fetchFlowRefChildren
  // early-returns on a cache hit, so a stale entry would otherwise persist. Clearing forces a re-fetch.
  bp.flowRefChildren.clear();
  bp.flowRefChildrenPending.clear();
}

/** True if the session we started this I/O for is still the live one. A reply that arrives after the
 *  overlay was toggled off — or off-then-on (a new session, higher `gen`) — must not mutate state. */
const sameSession = (g: number): boolean => bp.active && bp.gen === g;

/** Fill EditPage property catalogues from the same authoritative schema path used by Object View
 * and EC autocomplete. Requests are deduplicated across standalone and embedded surfaces. */
export async function fetchEditPageSchemas(types: readonly string[]): Promise<void> {
  const missing = [...new Set(types)].filter(type =>
    type && !bp.editPageSchemas.has(type) && !bp.editPageSchemaPending.has(type),
  );
  if (!missing.length) return;
  const g = bp.gen;
  for (const type of missing) {
    bp.editPageSchemaPending.add(type);
    bp.editPageSchemaErrors.delete(type);
  }
  try {
    const response = await sendRequestBounded<TypeSchemasResult>(
      { type: 'FETCH_TYPE_SCHEMAS', classNames: missing },
      { timeoutMs: Math.max(15_000, missing.length * 10_000) },
    );
    if (!sameSession(g) || (bp.env && response.environment !== bp.env)) return;
    const byType = new Map(response.results.map(result => [result.className, result]));
    for (const type of missing) {
      const result = byType.get(type);
      if (result?.ok && result.props) bp.editPageSchemas.set(type, result.props);
      else bp.editPageSchemaErrors.set(type, result?.error || 'Property details unavailable');
    }
  } catch {
    if (sameSession(g)) {
      for (const type of missing) bp.editPageSchemaErrors.set(type, 'Property details unavailable');
    }
  } finally {
    if (sameSession(g)) {
      for (const type of missing) bp.editPageSchemaPending.delete(type);
    }
  }
  if (sameSession(g)) render();
}

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
  if (res.ctx.surface === 'edit-page') bp.mode = 'layout';
  bp.editingTemplate = res.ctx.editingTemplate ?? false;
  bp.env = res.env ?? null;
  const editPageTypes = [
    ...(res.model.editPageTypes ?? []),
    ...Object.values(res.model.flows ?? {})
      .filter(flow => flow.ownerClass === 'CreateObjectView' && flow.refClass === 'EditPage')
      .flatMap(flow => flow.objectTypeClass ? [flow.objectTypeClass] : []),
  ];
  void fetchEditPageSchemas(editPageTypes);
  const orphans = res.orphans?.length ?? 0;
  if (orphans) showToast(`Blueprint: ${orphans} widget${orphans === 1 ? ' is' : 's are'} bound to this page but placed on no tab or container, so the editor does not show ${orphans === 1 ? 'it' : 'them'}`, 'info');
  render();
  return true;
}

/** Best-effort blast-radius probe used by the Apply Session production adapter. */
async function assessImpact(
  pageId: string,
  containers: { id: string; rid?: string }[],
  flowContainers: {
    id: string;
    rid?: string;
    className: 'InputSet' | 'EditPage';
  }[],
): Promise<{ fanout: BlastResult['fanout']; blast: BlastResult['blast']; flowBlast: BlastResult['flowBlast'] }> {
  const res = await sendRequest<BlastResult>({ type: 'LAYOUT_BLAST', pageId, containers, flowContainers });
  return {
    fanout: res?.fanout ?? null,
    blast: res?.blast ?? null,
    flowBlast: res?.flowBlast ?? null,
  };
}

async function preflightPortableIds(
  requests: Parameters<ApplySessionIO['preflightPortableIds']>[0],
): ReturnType<ApplySessionIO['preflightPortableIds']> {
  try {
    const response = await sendRequestBounded<PortableIdPreflightResult>(
      { type: 'LAYOUT_PORTABLE_ID_PREFLIGHT', requests },
      { timeoutMs: 15_000 },
    );
    return response ?? { ok: false, error: 'No response while checking generated IDs.' };
  } catch {
    return { ok: false, error: 'Could not check generated IDs.' };
  }
}

/** Production adapter for the Apply Session's three existing service-worker messages. */
export const applySessionIO: ApplySessionIO = {
  preflightPortableIds,
  assessImpact: request => assessImpact(request.pageId, request.containers, request.flowContainers),
  apply: request => sendRequest(request),
};

/** Fetch the flow "wire to existing" list for the OPEN flow picker (lean, at picker-open). Stores the
 *  rows on `bp.flowRefList` and re-renders; a reply for a closed/changed picker is dropped. */
/** Session cache of the wire-to-existing lists, keyed by refClass. The InputSet/EditPage sets only
 *  change when one is CREATED — which happens on Apply → page reload → fresh content script (this cache
 *  is gone) — so caching for the session is safe and skips re-running the SELECT on every picker open.
 *  Mirrors the colour-set cache (colors.ts). Cleared on a profile switch and on a manual sidebar Reset
 *  (resetFlowRefsCache, driven by RESET_OVERLAY_CACHES). */
const flowRefsCache = new Map<'InputSet' | 'EditPage', FlowRefListItem[]>();

/** Drop the cached wire-to-existing lists so the next picker-open re-fetches. Called on profile switch
 *  and on a manual sidebar Reset — the two points where the workspace's InputSets may have changed. */
export function resetFlowRefsCache(): void { flowRefsCache.clear(); }

export async function fetchFlowRefs(refClass: 'InputSet' | 'EditPage'): Promise<void> {
  const cached = flowRefsCache.get(refClass);
  if (cached) { bp.flowRefList = cached; render(); return; } // served from the session cache
  const g = bp.gen;
  bp.flowRefList = null; // loading state
  try {
    const res = await sendRequest<FlowRefsResult>({ type: 'LAYOUT_FLOW_REFS', refClass });
    if (!sameSession(g) || !bp.flowPicker?.wireExisting) return;
    const refs = res?.ok ? (res.refs ?? []) : [];
    if (res?.ok) flowRefsCache.set(refClass, refs); // cache only a successful list
    bp.flowRefList = refs;
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
  // model() injects bp.flowRefChildren on every read now, so surfacing the fetched children is just a
  // re-render — no need to (ineffectively) patch a transient present() clone or the baseline.
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

/** Translate a settled Apply Session into the existing Blueprint presentation and navigation effects. */
export function presentApplyResolution(result: ApplyResolution): void {
  bp.applySession = null;
  bp.applyOutcome = null;
  if (result.kind === 'cancelled') { render(); return; }
  if (result.kind === 'stale' || result.kind === 'partial' || result.kind === 'failed') {
    if (result.model) rebase(result.model);
    bp.applyOutcome = { kind: result.kind, message: result.message, notes: result.notes };
    render();
    return;
  }
  if (result.kind === 'noop') {
    if (result.model) rebase(result.model);
    showToast('Blueprint: nothing to apply', 'info');
    render();
    return;
  }
  if (result.kind === 'unverified') {
    stashResume();
    showToast(result.message, result.commitReportedOk ? 'success' : 'error');
  } else {
    stashResume();
    showToast(result.message, 'success');
  }
  sendToSW({ type: 'BLUEPRINT_TOGGLE' });
  setTimeout(() => location.reload(), 500);
}

/** Persist a page-scoped resume flag so the fresh content script re-enables blueprint after a reload,
 *  keeping the SAME edit target (template vs instance). Best-effort — storage may be disabled. Shared by
 *  the success reload and the D4 unverified reload. */
function stashResume(): void {
  bp.reloading = true; // both reload paths call this first — tells onBeforeUnload the imminent reload is intentional
  try {
    sessionStorage.setItem(BP_RESUME_KEY, JSON.stringify({
      prefer: bp.editingTemplate ? 'template' : 'instance', t: Date.now(),
    }));
  } catch { /* sandboxed / storage disabled — resume is best-effort */ }
}
