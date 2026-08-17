/**
 * One owner for the AI Change Ticket artifact and its lifecycle.
 *
 * Parsing, response isolation, presentation state, Preview capability, and
 * single-use Run consumption live here. Provider, service-worker, and DOM code
 * are adapters; none of them may reinterpret the ticket contract.
 */

export type AiChangeOperation = 'create' | 'update' | 'move' | 'delete' | 'other';

export interface AiChangeProposal {
  summary: string;
  target: string;
  operation: AiChangeOperation;
  language: 'extended';
  code: string;
}

export type ChangeTicketPhase = 'idle' | 'previewing' | 'ready' | 'running' | 'done' | 'error';

export interface ChangeTicketState {
  previewId?: string;
  statusText: string;
  phase: ChangeTicketPhase;
}

const OPERATIONS: ReadonlySet<string> = new Set(['create', 'update', 'move', 'delete', 'other']);
const HEADER_KEYS: ReadonlySet<string> = new Set(['summary', 'target', 'operation', 'language']);
const MAX_SUMMARY = 140;
const MAX_TARGET = 180;
const CHANGE_FENCE = /```crev-change\s*\n([\s\S]*?)```/gi;
const WHOLE_CHANGE_FENCE = /^```crev-change\s*\n([\s\S]*?)```\s*$/i;

function cleanHeaderValue(value: string, max: number): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Return the lossless BMP rid from an exact object target token. */
export function changeTicketTargetRid(target: string): string | null {
  return /^\[\[object:(-?\d+)\]\]$/u.exec(target.trim())?.[1] ?? null;
}

/** Parse the body of one `crev-change` fence. */
export function parseChangeProposal(body: string): AiChangeProposal | null {
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  const divider = lines.findIndex(line => line.trim() === '---');
  if (divider < 1) return null;

  const header = new Map<string, string>();
  for (const line of lines.slice(0, divider)) {
    const match = /^([a-z][a-z-]*):\s*(.*)$/i.exec(line.trim());
    if (!match) return null;
    const key = match[1].toLowerCase();
    if (!HEADER_KEYS.has(key) || header.has(key)) return null;
    header.set(key, match[2]);
  }

  const summary = cleanHeaderValue(header.get('summary') ?? '', MAX_SUMMARY);
  const language = header.get('language')?.trim().toLowerCase();
  const operationValue = header.get('operation')?.trim().toLowerCase() ?? 'other';
  const code = lines.slice(divider + 1).join('\n').trim();
  if (!summary || language !== 'extended' || !OPERATIONS.has(operationValue) || !code) return null;

  const target = cleanHeaderValue(header.get('target') ?? '', MAX_TARGET);
  if (!target) return null;
  if (target.includes('[[object:') && changeTicketTargetRid(target) === null) return null;
  return {
    summary,
    target,
    operation: operationValue as AiChangeOperation,
    language: 'extended',
    code,
  };
}

/** Parse a complete, standalone ticket. */
export function parseChangeTicket(ticket: string): AiChangeProposal | null {
  const match = WHOLE_CHANGE_FENCE.exec(ticket);
  return match ? parseChangeProposal(match[1]) : null;
}

/** Return exactly one structurally valid ticket from a provider response. */
export function extractValidChangeTicket(text: string): string | null {
  const matches = [...text.matchAll(CHANGE_FENCE)];
  if (matches.length !== 1 || !parseChangeProposal(matches[0][1])) return null;
  return `\`\`\`crev-change\n${matches[0][1].trim()}\n\`\`\``;
}

export function isolateValidChangeTicket(text: string): string {
  return extractValidChangeTicket(text) ?? text;
}

export interface ChangePreviewScope {
  profileId: string;
  serverUrl: string;
  actor: string;
}

/** Target identity shown on the card when Preview was issued. It is stored
 * with the exact code as receipt context, not re-derived from EC syntax. */
export interface ChangeTicketTargetContext {
  rid: string;
  businessId?: string;
}

interface PreviewedChangeTicket {
  readonly code: string;
  readonly scope: ChangePreviewScope;
  readonly previewResult: string;
  readonly target?: ChangeTicketTargetContext;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export type ConsumeChangePreviewResult =
  | { ok: true; code: string; previewResult: string; issuedAt: number; target?: ChangeTicketTargetContext }
  | { ok: false; reason: 'missing' | 'expired' | 'scope-changed' };

type Now = () => number;
type MakeId = () => string;

function sameScope(a: ChangePreviewScope, b: ChangePreviewScope): boolean {
  return a.profileId === b.profileId && a.serverUrl === b.serverUrl && a.actor === b.actor;
}

/** Previewed tickets remain exact-code, environment-bound, short-lived, and
 * single-use. Verification-only previews never enter this lifecycle. */
export class ChangeTicketLifecycle {
  private readonly previewed = new Map<string, PreviewedChangeTicket>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: Now = Date.now,
    private readonly makeId: MakeId = () => crypto.randomUUID(),
  ) {}

  issue(
    code: string,
    scope: ChangePreviewScope,
    previewResult: string,
    target?: ChangeTicketTargetContext,
  ): string {
    const issuedAt = this.now();
    const previewId = this.makeId();
    this.previewed.set(previewId, Object.freeze({
      code,
      scope: Object.freeze({ ...scope }),
      previewResult,
      ...(target ? { target: Object.freeze({ ...target }) } : {}),
      issuedAt,
      expiresAt: issuedAt + this.ttlMs,
    }));
    return previewId;
  }

  consume(previewId: string, scope: ChangePreviewScope): ConsumeChangePreviewResult {
    const entry = this.previewed.get(previewId);
    this.previewed.delete(previewId);
    if (!entry) return { ok: false, reason: 'missing' };
    if (entry.expiresAt < this.now()) return { ok: false, reason: 'expired' };
    if (!sameScope(entry.scope, scope)) return { ok: false, reason: 'scope-changed' };
    return {
      ok: true,
      code: entry.code,
      previewResult: entry.previewResult,
      issuedAt: entry.issuedAt,
      ...(entry.target ? { target: entry.target } : {}),
    };
  }
}
