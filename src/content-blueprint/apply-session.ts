import { diff, summarizeChanges } from '../lib/layout/diff';
import { compile } from '../lib/layout/ec';
import { findFlowContainer, flowDiff } from '../lib/layout/flow';
import { cloneModel, findNode, isTempId } from '../lib/layout/model';
import {
  portableIdPatternError,
  portableIdRequests,
  type PortableIdConfig,
  type PortableIdPlan,
  type PortableIdRequest,
} from '../lib/layout/portable-ids';
import type { LModel, PlanNote, PlanStep } from '../lib/layout/types';
import type { BlueprintCtx } from '../lib/layout/sync';
import type { ContainerBlast, FlowContainerBlast, InstanceFanout } from '../lib/layout/blast-radius';
import type { InspectorMessage } from '../lib/types';

type ApplyRequest = Extract<InspectorMessage, { type: 'LAYOUT_APPLY' }>;
type ApplyResponse = Extract<InspectorMessage, { type: 'LAYOUT_APPLY_RESULT' }>;

export interface ApplyImpact {
  fanout: InstanceFanout | null;
  blast: ContainerBlast | null;
  flowBlast: FlowContainerBlast | null;
}

export interface ApplyReview {
  readonly env: string;
  readonly ctx: BlueprintCtx;
  readonly baseline: LModel;
  readonly desired: LModel;
  readonly plan: readonly PlanStep[];
  readonly notes: readonly PlanNote[];
  readonly script: string;
  readonly changes: number;
  readonly actions: number;
  readonly portableIds?: PortableIdPlan;
  readonly impact: { status: 'checking' } | { status: 'ready'; value: ApplyImpact };
}

export type ApplyResolution =
  | { kind: 'applied'; message: string }
  | { kind: 'noop'; model?: LModel }
  | { kind: 'stale'; model: LModel; message: string; notes: PlanNote[] }
  | { kind: 'partial'; model: LModel; message: string; notes: PlanNote[] }
  | { kind: 'failed'; model?: LModel; message: string; notes: PlanNote[] }
  | { kind: 'unverified'; commitReportedOk: boolean | null; message: string }
  | { kind: 'cancelled' };

export type ApplySessionState =
  | { phase: 'preparing' }
  | { phase: 'empty' }
  | { phase: 'blocked'; message: string }
  | { phase: 'review'; review: ApplyReview }
  | { phase: 'applying'; review: ApplyReview }
  | { phase: 'settled'; resolution: ApplyResolution }
  | { phase: 'cancelled' };

export interface ApplySessionInput {
  env: string;
  ctx: BlueprintCtx;
  baseline: LModel;
  desired: LModel;
  idConfig: PortableIdConfig;
  /** Preparation may outlive its Blueprint page/history generation. */
  isCurrent(): boolean;
}

export interface ApplySessionIO {
  preflightPortableIds(requests: PortableIdRequest[]): Promise<{ ok: boolean; portableIds?: PortableIdPlan; error?: string }>;
  assessImpact(request: {
    pageId: string;
    containers: { id: string; rid?: string }[];
    flowContainers: { id: string; rid?: string; className: 'InputSet' | 'EditPage' }[];
  }): Promise<ApplyImpact>;
  apply(request: ApplyRequest): Promise<ApplyResponse | undefined>;
}

export interface ApplySession {
  readonly state: ApplySessionState;
  confirm(): Promise<ApplyResolution>;
  cancel(): void;
}

function touchedContainers(plan: readonly PlanStep[], model: LModel): { id: string; rid?: string }[] {
  const touched = new Map<string, { id: string; rid?: string }>();
  for (const step of plan) {
    if (step.kind === 'create' || step.kind === 'flowCreate' || step.kind === 'flowReorder'
      || step.kind === 'flowFlag' || step.kind === 'flowRename' || step.kind === 'flowProperty'
      || step.kind === 'flowDelete') continue;
    const node = findNode(model, step.id)?.node;
    const kind = step.kind === 'reparent' || step.kind === 'delete' ? step.nodeKind : node?.kind;
    if (kind === 'container' && !isTempId(step.id)) touched.set(step.id, { id: step.id, rid: node?.rid });
  }
  return [...touched.values()];
}

function touchedFlowContainers(
  plan: readonly PlanStep[],
  model: LModel,
): { id: string; rid?: string; className: 'InputSet' | 'EditPage' }[] {
  const touched = new Map<string, { id: string; rid?: string; className: 'InputSet' | 'EditPage' }>();
  for (const step of plan) {
    const parentId = step.kind === 'flowCreate' || step.kind === 'flowReorder'
      || step.kind === 'flowDelete' || step.kind === 'flowProperty' ? step.parentId : null;
    if (!parentId || isTempId(parentId)) continue;
    const container = findFlowContainer(model, parentId);
    if (!container || (container.className !== 'InputSet' && container.className !== 'EditPage')) continue;
    touched.set(parentId, {
      id: parentId,
      ...(container.rid ? { rid: container.rid } : {}),
      className: container.className,
    });
  }
  return [...touched.values()];
}

function resolution(response: ApplyResponse | undefined): ApplyResolution {
  if (response?.unverified) {
    return {
      kind: 'unverified',
      commitReportedOk: response.ok,
      message: response.error || 'Blueprint: applied, but the result could not be verified — refreshing.',
    };
  }
  if (response?.stale && response.model) {
    return {
      kind: 'stale', model: response.model,
      message: response.error || 'The page changed elsewhere, so it was reloaded. Re-apply your edits.',
      notes: response.notes ?? [],
    };
  }
  if (response?.partial && response.model) {
    return {
      kind: 'partial', model: response.model,
      message: response.error || 'Some changes may not have applied. The layout was refreshed — check and re-apply what is missing.',
      notes: response.notes ?? [],
    };
  }
  if (!response?.ok) {
    return {
      kind: 'failed', ...(response?.model ? { model: response.model } : {}),
      message: response?.error || 'Apply failed.', notes: response?.notes ?? [],
    };
  }
  if (response.noop) return { kind: 'noop', ...(response.model ? { model: response.model } : {}) };
  return { kind: 'applied', message: 'Blueprint: changes applied. Refreshing…' };
}

/**
 * One immutable Blueprint review-to-commit attempt. The session owns all asynchronous ordering and
 * constructs the commit from the exact models used for its preview; callers only present its state.
 */
export function createApplySession(
  source: ApplySessionInput,
  io: ApplySessionIO,
  onChange: () => void,
): ApplySession {
  const input = {
    env: source.env,
    ctx: { ...source.ctx },
    baseline: cloneModel(source.baseline),
    desired: cloneModel(source.desired),
    idConfig: { ...source.idConfig },
    isCurrent: source.isCurrent,
  };
  let state: ApplySessionState = { phase: 'preparing' };
  let cancelled = false;
  let commit: Promise<ApplyResolution> | null = null;

  const transition = (next: ApplySessionState): void => {
    if (cancelled && next.phase !== 'cancelled') return;
    state = next;
    onChange();
  };

  const prepare = async (): Promise<void> => {
    const plan = [...diff(input.baseline, input.desired), ...flowDiff(input.baseline, input.desired)];
    if (!plan.length) { transition({ phase: 'empty' }); return; }

    let portableIds: PortableIdPlan = {};
    const usePortableIds = input.idConfig.enabled
      && (input.ctx.target === 'template' || input.ctx.surface === 'edit-page');
    if (usePortableIds) {
      const patternError = portableIdPatternError(input.idConfig.pattern);
      if (patternError) { transition({ phase: 'blocked', message: `Blueprint IDs: ${patternError}` }); return; }
      const requests = portableIdRequests(plan, input.desired, input.idConfig.pattern);
      if (requests.length) {
        let result: Awaited<ReturnType<ApplySessionIO['preflightPortableIds']>>;
        try {
          result = await io.preflightPortableIds(requests);
        } catch {
          result = { ok: false, error: 'Could not check generated IDs.' };
        }
        if (cancelled || !input.isCurrent()) { cancel(); return; }
        if (!result.ok || !result.portableIds) {
          transition({ phase: 'blocked', message: `Blueprint IDs: ${result.error || 'collision check failed.'}` });
          return;
        }
        portableIds = result.portableIds;
      }
    }

    if (cancelled || !input.isCurrent()) { cancel(); return; }
    let compiled: ReturnType<typeof compile>;
    try {
      compiled = compile(plan, input.desired, portableIds);
    } catch (error) {
      transition({ phase: 'blocked', message: `Blueprint: ${error instanceof Error ? error.message : 'could not compile the staged changes.'}` });
      return;
    }
    const { script, notes } = compiled;
    const summary = summarizeChanges(plan, input.desired);
    const review: ApplyReview = {
      env: input.env,
      ctx: input.ctx,
      baseline: input.baseline,
      desired: input.desired,
      plan,
      notes,
      script,
      changes: summary.changes,
      actions: notes.length,
      ...(Object.keys(portableIds).length ? { portableIds } : {}),
      impact: { status: 'checking' },
    };
    transition({ phase: 'review', review });
    try {
      const impact = await io.assessImpact({
        pageId: input.ctx.pageId,
        containers: touchedContainers(plan, input.desired),
        flowContainers: touchedFlowContainers(plan, input.desired),
      });
      if (cancelled || !input.isCurrent()) { cancel(); return; }
      transition({ phase: 'review', review: { ...review, impact: { status: 'ready', value: impact } } });
    } catch {
      if (cancelled || !input.isCurrent()) { cancel(); return; }
      transition({
        phase: 'review',
        review: {
          ...review,
          impact: { status: 'ready', value: { fanout: null, blast: null, flowBlast: null } },
        },
      });
    }
  };

  const cancel = (): void => {
    if (cancelled) return;
    cancelled = true;
    state = { phase: 'cancelled' };
    onChange();
  };

  const confirm = (): Promise<ApplyResolution> => {
    if (commit) return commit;
    if (state.phase !== 'review' || state.review.impact.status === 'checking' || cancelled || !input.isCurrent()) {
      return Promise.resolve({ kind: 'cancelled' });
    }
    const review = state.review;
    transition({ phase: 'applying', review });
    commit = io.apply({
      type: 'LAYOUT_APPLY',
      env: review.env,
      ctx: review.ctx,
      baseline: review.baseline,
      desired: review.desired,
      ...(review.portableIds ? { portableIds: review.portableIds } : {}),
    }).then(resolution, () => ({
      kind: 'unverified' as const,
      commitReportedOk: null,
      message: 'Blueprint: the apply result could not be verified — refreshing.',
    })).then(result => {
      // Once the command has been sent, its resolution is authoritative for
      // this session. `isCurrent` gates preparation/confirmation, but must not
      // strand an accepted commit in `applying` if surrounding UI state moves.
      if (!cancelled) transition({ phase: 'settled', resolution: result });
      return result;
    });
    return commit;
  };

  const session: ApplySession = {
    get state() { return state; },
    confirm,
    cancel,
  };
  queueMicrotask(() => { void prepare(); });
  return session;
}
