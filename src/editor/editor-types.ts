/**
 * EC Editor — shared types and context helpers.
 * Single source of truth for identity formatting, code access, and target resolution.
 */
import { type SaveTarget } from '../lib/types'

// ── Types ────────────────────────────────────────────────────────

export interface ObjectIdentity {
  rid: string
  businessId: string
  type: string
  name: string
}

export interface EditorContext {
  instance: ObjectIdentity
  template: ObjectIdentity | null
  instanceCode: Record<string, string>
  templateCode: Record<string, string>
  overrides: Record<string, boolean>
  saveTarget: SaveTarget
  property: string | null
  extended?: boolean
  executionContextRid?: string
  /** Resolved identity of the EC execution context (`this`) — the object the
   *  BMP page is currently rendering for. For an enterprise detail page that's
   *  the enterprise instance (e.g. a CeRiskAssessment), NOT the page/template
   *  that `.location` returns. Shown as a header chip so the user can see what
   *  `this` binds to; distinct from `instance` (the widget being edited). */
  executionContext?: ObjectIdentity
  /** Whether BMP supports EC lookup(). False on pre-5.6.3. */
  useLookup?: boolean
  /** One-shot scroll target — when set, the editor jumps to this 1-based
   *  line on first mount and clears the field. Used by Code Search:
   *  clicking a matched line opens the editor and lands the user at the
   *  actual hit instead of line 1. Cleared after consumption so a
   *  subsequent property switch on the same context doesn't re-scroll. */
  scrollToLine?: number
  /** The matched line's TEXT, when the jump came from Code Search. The editor's
   *  body can differ from the search-side body by a few lines (the two paths
   *  reconstruct `output()` independently), so landing on a line NUMBER alone
   *  can miss. When present, the editor locates this text nearest to
   *  `scrollToLine` and lands on the real match instead of silently clamping. */
  scrollToText?: string
}

// ── Label formatting ─────────────────────────────────────────────

/** Format an identity for display.
 *  'short' → businessId or type fallback (e.g. "t.122")
 *  'full'  → "t.122 · My Table" or "ExtendedTable · 1234567890" */
export function formatLabel(obj: ObjectIdentity, style: 'short' | 'full'): string {
  const short = obj.businessId || obj.type || obj.rid
  if (style === 'short') return short
  const name = obj.name || obj.rid
  return obj.businessId
    ? `${obj.businessId} \u00b7 ${name}`
    : `${obj.type || 'Object'} \u00b7 ${name}`
}

// ── Context accessors ────────────────────────────────────────────

/** Get code props for the currently active save target. */
export function getActiveCode(ctx: EditorContext): Record<string, string> {
  if (ctx.saveTarget === 'template' && ctx.template) {
    return ctx.templateCode
  }
  return ctx.instanceCode
}

/** Get identity for the currently active save target. */
export function getActiveIdentity(ctx: EditorContext): ObjectIdentity {
  if (ctx.saveTarget === 'template' && ctx.template) {
    return ctx.template
  }
  return ctx.instance
}

/** Get the RID to pass as EC execution context (`this` for preview/execute).
 *  `executionContextRid` is resolved at open time as: the BMP page's current
 *  `?rid=` (the object the page renders for) → the widget's `.location` →
 *  undefined. This falls back to the widget's own RID only when none of those
 *  resolved. */
export function getExecutionRid(ctx: EditorContext): string | undefined {
  return ctx.executionContextRid ?? ctx.instance.rid
}

/** Get save target info: which RID to write to, the type, and identity for confirmation. */
export function getSaveTarget(ctx: EditorContext): { rid: string; type: string; identity: ObjectIdentity } {
  if (ctx.saveTarget === 'template' && ctx.template) {
    return { rid: ctx.template.rid, type: ctx.template.type, identity: ctx.template }
  }
  return { rid: ctx.instance.rid, type: ctx.instance.type, identity: ctx.instance }
}

// ── Override detection ───────────────────────────────────────────

/** Compare instance vs template code per property. Returns true for properties that differ. */
export function computeOverrides(
  instanceCode: Record<string, string>,
  templateCode: Record<string, string>,
): Record<string, boolean> {
  const overrides: Record<string, boolean> = {}
  for (const prop of Object.keys(instanceCode)) {
    const instVal = instanceCode[prop] ?? ''
    const tmplVal = templateCode[prop] ?? ''
    // Both empty = not overridden. Only flag when both have content and differ,
    // or instance has content but template doesn't.
    if (instVal || tmplVal) {
      overrides[prop] = instVal !== tmplVal
    }
  }
  return overrides
}

// Shared with CodeSurface's load-time jump; canonical home is editor-core.
// Re-exported here so existing editor.ts / test imports keep resolving.
export { pickNearestLine } from '../editor-core/text-nav'
