/**
 * CVO Studio — shared context type passed from the SW launcher to the studio
 * page via chrome.storage.local (key `crev_cvo_studio_ctx_<rid>`), mirroring
 * the EC editor's per-RID context handoff.
 *
 * Deliberately leaner than EditorContext: a CVO has no EC execution context
 * and no lookup() concerns — it's just the two code fields (html/javascript)
 * for an object that may be a template or an instance.
 */
import type { ObjectIdentity } from '../editor/editor-types'
import type { SaveTarget } from '../lib/types'

export type StudioCodeProp = 'html' | 'javascript'

export interface StudioContext {
  /** The CVO being edited. */
  instance: ObjectIdentity
  /** The CVO's template, when the opened object is a linked instance. */
  template: ObjectIdentity | null
  /** Code fields keyed by prop name (html / javascript) for the instance. */
  instanceCode: Record<string, string>
  /** Same for the template (empty when there's no template). */
  templateCode: Record<string, string>
  /** Which target a save writes to. */
  saveTarget: SaveTarget
  /** Property the open gesture preferred (html / javascript). */
  property?: StudioCodeProp
  /** Default render context for the live-`_data` fetch — the org-rooted object
   *  (scorecard/page) the CVO was being viewed on. The data servlet is gated on
   *  this resolving under an Organisation. Captured by the launcher; editable in
   *  the studio. Undefined when the CVO wasn't opened from a rendered page. */
  renderContextRid?: string
}

export const STUDIO_CTX_PREFIX = 'crev_cvo_studio_ctx_'
