/**
 * Pure policy for choosing the BMP object a page change must mutate.
 *
 * Layout discovery owns facts; this module owns policy. Keeping the decision
 * here prevents read_layout formatting, prompt prose, Preview, and evals from
 * each inventing a slightly different definition of "the target".
 */

export type RequestedChangeScope = 'default' | 'shared-template' | 'instance-only';
export type ChangeTargetScope =
  | 'shared-template'
  | 'instance-only'
  | 'enterprise-template'
  | 'direct-page'
  | 'shared-portal';
export type ChangeTargetImpact = 'all-linked-instances' | 'one-page' | 'all-portal-consumers';

export interface ChangeTargetIdentity {
  rid: string;
  businessId: string;
  type: string;
  name?: string;
  /** Exact executable reference supplied by discovery. */
  ecRef: string;
}

export interface ChangeTargetPageFacts {
  /** Object in the browser URL / attached page context. */
  viewed: ChangeTargetIdentity;
  /** Object that actually owns rendered page widgets. */
  owner: ChangeTargetIdentity;
  /** Shared Scorecard master linked from a direct instance, when present. */
  linkedTemplate?: ChangeTargetIdentity;
}

export type ChangeTargetSubject =
  | { kind: 'page'; page: ChangeTargetPageFacts }
  | {
      kind: 'widget';
      page: ChangeTargetPageFacts;
      instance: ChangeTargetIdentity;
      linkedTemplate?: ChangeTargetIdentity;
    }
  | { kind: 'portal-structure'; page: ChangeTargetPageFacts; object: ChangeTargetIdentity };

export type ChangeTargetReason =
  | 'linked-page-default'
  | 'explicit-instance-override'
  | 'inherited-widget-default'
  | 'local-widget-only'
  | 'enterprise-template-owner'
  | 'direct-page-owner'
  | 'portal-structure-is-shared'
  | 'shared-template-unavailable'
  | 'enterprise-instance-cannot-own-widgets'
  | 'portal-structure-has-no-instance-scope';

export interface ResolvedChangeTarget {
  status: 'resolved';
  target: ChangeTargetIdentity;
  scope: ChangeTargetScope;
  impact: ChangeTargetImpact;
  reason: ChangeTargetReason;
  /** A valid opt-in alternative; absence means the requested subject has no local equivalent. */
  alternative?: Omit<ResolvedChangeTarget, 'status' | 'alternative'>;
}

export interface UnavailableChangeTarget {
  status: 'unavailable';
  reason: ChangeTargetReason;
  message: string;
}

export type ChangeTargetResolution = ResolvedChangeTarget | UnavailableChangeTarget;

export interface ChangeTargetRecord {
  rid: string;
  mutationRef: string;
  scope: ChangeTargetScope;
}

/** Parse the compact target records emitted by formatChangeTarget(). */
export function parseChangeTargetRecords(text: string): ChangeTargetRecord[] {
  const records: ChangeTargetRecord[] = [];
  const pattern = /target=\[\[object:(-?\d+)\]\]\s+mutationRef=([A-Za-z_][A-Za-z0-9_.]*)\s+scope=(shared-template|instance-only|enterprise-template|direct-page|shared-portal)\b/gi;
  for (const match of text.matchAll(pattern)) {
    records.push({
      rid: match[1],
      mutationRef: match[2],
      scope: match[3].toLowerCase() as ChangeTargetScope,
    });
  }
  return records;
}

function resolved(
  target: ChangeTargetIdentity,
  scope: ChangeTargetScope,
  impact: ChangeTargetImpact,
  reason: ChangeTargetReason,
  alternative?: ResolvedChangeTarget['alternative'],
): ResolvedChangeTarget {
  return { status: 'resolved', target, scope, impact, reason, ...(alternative ? { alternative } : {}) };
}

/** Resolve the mutation target from verified structural facts, never names. */
export function resolveChangeTarget(
  subject: ChangeTargetSubject,
  requestedScope: RequestedChangeScope = 'default',
): ChangeTargetResolution {
  if (subject.kind === 'portal-structure') {
    if (requestedScope === 'instance-only') {
      return {
        status: 'unavailable',
        reason: 'portal-structure-has-no-instance-scope',
        message: 'Tabs, TabSets, and Containers are shared portal objects; this object has no instance-only mutation target.',
      };
    }
    return resolved(subject.object, 'shared-portal', 'all-portal-consumers', 'portal-structure-is-shared');
  }

  if (subject.kind === 'widget') {
    if (subject.linkedTemplate) {
      if (requestedScope === 'instance-only') {
        return resolved(subject.instance, 'instance-only', 'one-page', 'explicit-instance-override');
      }
      return resolved(
        subject.linkedTemplate,
        'shared-template',
        'all-linked-instances',
        'inherited-widget-default',
        {
          target: subject.instance,
          scope: 'instance-only',
          impact: 'one-page',
          reason: 'explicit-instance-override',
        },
      );
    }
    if (requestedScope === 'shared-template') {
      return {
        status: 'unavailable',
        reason: 'shared-template-unavailable',
        message: 'This widget has no verified linked template counterpart.',
      };
    }
    return resolved(subject.instance, 'instance-only', 'one-page', 'local-widget-only');
  }

  const { page } = subject;
  const enterpriseOwned = page.owner.rid !== page.viewed.rid;
  if (enterpriseOwned) {
    if (requestedScope === 'instance-only') {
      return {
        status: 'unavailable',
        reason: 'enterprise-instance-cannot-own-widgets',
        message: 'The viewed enterprise instance does not own page widgets; its EnterpriseTemplate is the configuration owner.',
      };
    }
    return resolved(page.owner, 'enterprise-template', 'all-linked-instances', 'enterprise-template-owner');
  }

  if (page.linkedTemplate) {
    if (requestedScope === 'instance-only') {
      return resolved(page.viewed, 'instance-only', 'one-page', 'explicit-instance-override');
    }
    return resolved(
      page.linkedTemplate,
      'shared-template',
      'all-linked-instances',
      'linked-page-default',
      {
        target: page.viewed,
        scope: 'instance-only',
        impact: 'one-page',
        reason: 'explicit-instance-override',
      },
    );
  }

  if (requestedScope === 'shared-template') {
    return {
      status: 'unavailable',
      reason: 'shared-template-unavailable',
      message: 'No linked template was verified for this page.',
    };
  }
  return resolved(page.owner, 'direct-page', 'one-page', 'direct-page-owner');
}

/** Single source for the compact machine-readable routing vocabulary in tool output. */
export function formatChangeTarget(resolution: ChangeTargetResolution, label = 'Default configuration target'): string {
  if (resolution.status === 'unavailable') return `${label}: unavailable reason=${resolution.reason}; ${resolution.message}`;
  const target = resolution.target;
  return `${label}: target=[[object:${target.rid}]] mutationRef=${target.ecRef} scope=${resolution.scope} impact=${resolution.impact} reason=${resolution.reason}`;
}

/** Prompt contract generated from the same policy vocabulary used by read_layout. */
export const CHANGE_TARGET_PROMPT_CONTRACT = `<change-target-policy>
Treat read_layout's target records as authoritative; never choose scope from a name or from the first RID shown.
- For an explicit local, this-copy, or instance-only request, call read_layout with changeScope="instance-only". Otherwise omit changeScope. For adding a widget, use the Requested/Default page-owner target. For changing an existing widget, use that widget row's change-target. Do not substitute an alternative or put the page-owner RID on a widget ticket.
- Every record separates target=[[object:RID]] for the Change Ticket badge from mutationRef=... for executable EC. Put only the exact target token in the target header. Copy mutationRef byte-for-byte into the executable EC and use it for the external add/change/delete receiver (directly or through a local alias); never replace it with lookup(RID), a token RID, or another namespace. Once this record exists, the attached/viewed pageRid is discovery identity only: never use lookup(pageRid) as a mutation receiver.
- scope=shared-template is the normal target for linked pages and inherited widgets.
- scope=instance-only is valid only when the user explicitly asks for a local/instance-only override, or when read_layout says reason=local-widget-only.
- scope=enterprise-template is the only page-widget owner for a viewed Ce* enterprise instance.
- scope=shared-portal means the Tab, TabSet, or Container itself is globally shared; describing it as instance-only is incorrect.
- If routing is unavailable, explain the missing evidence or unsupported scope; do not guess a mutation target.
For scope=shared-template, add a brief, natural note that explicitly contrasts the template with the viewed/specific instance. Do not append a fixed sentence or offer an instance override unless the user asks.
For every other scope, do not describe the target as a shared template or offer an instance override; describe only the requested visible outcome. Never echo internal routing labels such as "direct page owner", "page-owner", mutationRef, or scope= into the user-facing summary.
</change-target-policy>`;
