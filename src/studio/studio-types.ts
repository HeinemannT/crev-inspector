/**
 * Studio — shared context type passed from the SW launcher to the studio
 * page via chrome.storage.local (key `crev_cvo_studio_ctx_<rid>`), mirroring
 * the EC editor's per-RID context handoff.
 *
 * Deliberately leaner than EditorContext: studio objects have no EC execution
 * context and no lookup() concerns — just a small set of code-bearing fields
 * (per StudioMode) for an object that may be a template or an instance.
 */
import type { ObjectIdentity } from '../editor/editor-types'
import type { SaveTarget } from '../lib/types'

/** A studio-editable BMP property (the mode's file list defines the set). */
export type StudioCodeProp = string

export interface StudioContext {
  /** Profile/server identity this editable context was loaded from. */
  environment: string
  /** Which studio mode drives the shell (file list + capabilities). */
  mode: 'cvo' | 'text'
  /** The object being edited. */
  instance: ObjectIdentity
  /** The CVO's template, when the opened object is a linked instance. */
  template: ObjectIdentity | null
  /** Code fields keyed by prop name (per the mode's files) for the instance. */
  instanceCode: Record<string, string>
  /** Same for the template (empty when there's no template). */
  templateCode: Record<string, string>
  /** Which target a save writes to. */
  saveTarget: SaveTarget
  /** Property the open gesture preferred (one of the mode's file props). */
  property?: StudioCodeProp
  /** Default render context for the live-`_data` fetch — the org-rooted object
   *  (scorecard/page) the CVO was being viewed on. The data servlet is gated on
   *  this resolving under an Organisation. Captured by the launcher; editable in
   *  the studio. Undefined when the CVO wasn't opened from a rendered page. */
  renderContextRid?: string
}

export const STUDIO_CTX_PREFIX = 'crev_cvo_studio_ctx_'
