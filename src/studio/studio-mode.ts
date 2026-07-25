/**
 * Studio modes — the seam that makes the studio shell reusable across
 * BMP types whose "source" is a small set of code-bearing properties.
 *
 * A mode declares WHAT is edited (the file list: BMP property + label +
 * icon + language) and WHICH capabilities the shell lights up. Everything
 * else — the CodeSurface engine, file switch, split layout, save pipeline
 * with verify-reconcile, download bundle, dirty guards — is shared.
 *
 * Current modes:
 *  - `cvo` (CustomVisualization): html + javascript, executed live in the
 *    sandbox iframe against mock/live `_data`, with Inputs/Deps panels.
 *  - `text` (TextElement): text + longText, both HTML bodies. Preview is a
 *    static document (no JS to run) that mirrors BMP's widget rendering:
 *    `text` inline, `longText` behind the native SHOW MORE toggle. BMP
 *    sanitizes both properties ON SAVE (strict whitelist — no radius /
 *    gradients / shadows / transforms), so a save re-reads the stored value
 *    and reports what BMP rewrote — expected behavior, not a rollback.
 */
import { ICON_FILE_HTML, ICON_FILE_JS } from '../lib/icons'
import type { CodeLang } from '../editor-core/cm-scaffold'
import { buildInertHtmlDocument } from '../preview/inert-html'

export interface StudioFile {
  /** BMP property name (the save target and slot key). */
  prop: string
  /** File-switch label. */
  label: string
  /** File-switch icon (ICON_* path constant). */
  icon: string
  /** Syntax layer for the editor slot. */
  lang: CodeLang
}

export interface StudioMode {
  key: 'cvo' | 'text'
  /** Noun for titles ("CVO studio" / "Text studio"). */
  title: string
  /** Files in switch-strip order. The first is the default active file. */
  files: readonly StudioFile[]
  /**
   * True = the preview EXECUTES the source in the sandbox (JS + `_data`
   * machinery: mock/live toggle, Inputs and Deps panels, CVO console
   * relay). False = the preview is a static document built by
   * `buildPreviewDoc` — still debounced, width-testable, and re-rendered
   * on edit, but with none of the execution chrome.
   */
  hasSandbox: boolean
  /**
   * Save verify-reconcile wording. BMP can rewrite a saved value server-side;
   * 'rollback' treats a difference as an error (CVO: HTTP 200 with a silent
   * in-script rollback), 'sanitizer' as expected cleaning (TextElement).
   */
  rewriteSemantics: 'rollback' | 'sanitizer'
  /** Static preview builder (modes with hasSandbox=false). */
  buildPreviewDoc?: (code: Record<string, string>) => string
}

/**
 * Static preview for TextElement: BMP's widget container defaults
 * (Lato 12px #343536 on white — see skills/bmp-platform cvo-design-strategy)
 * with `text` rendered inline and `longText` under a SHOW MORE toggle,
 * exactly how the portal presents the pair. The shared inert renderer removes
 * active content locally; BMP still applies its stricter whitelist on save,
 * and the save path reports what BMP rewrote.
 */
function buildTextElementPreview(code: Record<string, string>): string {
  const text = code['text'] ?? ''
  const long = code['longText'] ?? ''
  const details = long.trim()
    ? `<details class="te-details">
  <summary><span class="te-more">SHOW MORE</span><span class="te-less">SHOW LESS</span></summary>
  <div class="te-long">${long}</div>
</details>`
    : ''
  return buildInertHtmlDocument({
    html: `<div class="te-text">${text}</div>${details}`,
    contentCss: `
  .te-details { margin-top: 10px; }
  .te-details summary {
    display: inline-block;
    color: #565758;
    cursor: pointer;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: .3px;
    list-style: none;
  }
  .te-details summary::-webkit-details-marker { display: none; }
  .te-details summary:hover { color: #343536; }
  .te-less { display: none; }
  .te-details[open] .te-more { display: none; }
  .te-details[open] .te-less { display: inline; }
  .te-long { margin-top: 4px; }`,
  })
}

const CVO_MODE: StudioMode = {
  key: 'cvo',
  title: 'CVO studio',
  files: [
    { prop: 'html', label: 'HTML', icon: ICON_FILE_HTML, lang: 'html' },
    { prop: 'javascript', label: 'JavaScript', icon: ICON_FILE_JS, lang: 'javascript' },
  ],
  hasSandbox: true,
  rewriteSemantics: 'rollback',
}

const TEXT_MODE: StudioMode = {
  key: 'text',
  title: 'Text studio',
  files: [
    { prop: 'text', label: 'Text', icon: ICON_FILE_HTML, lang: 'html' },
    { prop: 'longText', label: 'Long text', icon: ICON_FILE_HTML, lang: 'html' },
  ],
  hasSandbox: false,
  rewriteSemantics: 'sanitizer',
  buildPreviewDoc: buildTextElementPreview,
}

export const STUDIO_MODES: Record<StudioMode['key'], StudioMode> = {
  cvo: CVO_MODE,
  text: TEXT_MODE,
}

/** Types whose code opens in the studio rather than the floating editor —
 *  the single routing predicate every open-gesture site consults. */
export const STUDIO_TYPES: ReadonlySet<string> = new Set(['CustomVisualization', 'TextElement'])

export function hasStudio(type: string | undefined): boolean {
  return !!type && STUDIO_TYPES.has(type)
}

/** Mode for a BMP type. Unknown types fall back to CVO (the studio's origin);
 *  callers should route only `hasStudio` types here. */
export function modeForType(type: string | undefined): StudioMode {
  return type === 'TextElement' ? TEXT_MODE : CVO_MODE
}

/** Union of every mode's props — the launcher fetches these in ONE EC round
 *  trip before it knows the object's type; absent props come back empty. */
export const ALL_STUDIO_PROPS: readonly string[] =
  [...new Set(Object.values(STUDIO_MODES).flatMap(m => m.files.map(f => f.prop)))]
