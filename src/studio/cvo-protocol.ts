/**
 * CVO studio ⇄ sandbox postMessage protocol — the single source of truth for
 * the messages exchanged between the privileged studio page and its sandboxed
 * preview iframe.
 *
 * This module is deliberately DEPENDENCY-FREE: no chrome.* typings, no imports
 * at all. That is what lets the sandbox entry (a separate, locked-down build
 * target) import it without dragging the privileged `lib/types` graph in — the
 * exact reason the two sides used to carry hand-copied, drift-prone duplicates.
 * Keep it that way; if you need a richer type here, inline it.
 */

/** Console levels the sandbox forwards to the studio's console panel. */
export type CvoConsoleLevel = 'log' | 'warn' | 'error' | 'info'

/** A hosted FileResource dependency, identified by rid so the sandbox can both
 *  run it as a global script (UMD libs) AND mint a blob URL to rewrite the CVO's
 *  own `web/download?...rid=<rid>` references to (so dynamic import()/script-src
 *  of that resource resolve in the sandbox instead of 404-ing on the ext origin). */
export interface CvoLib {
  rid: string
  content: string
}

/** studio → sandbox: render this CVO. `data` is the `_data` contract minus
 *  `.element`, which the sandbox attaches. `libs` are hosted-FileResource JS
 *  sources to run before the CVO so their globals are ready. */
export interface CvoRenderRequest {
  type: 'CVO_RENDER'
  /** Monotonic id so late console/errors from a superseded run can be dropped. */
  runId: number
  html: string
  javascript: string
  data: Record<string, unknown>
  libs?: CvoLib[]
}

/** sandbox → studio: a forwarded console call. */
export interface CvoConsoleMessage {
  type: 'CVO_CONSOLE'
  runId: number
  level: CvoConsoleLevel
  text: string
}

/** sandbox → studio: a thrown error / unhandled rejection from the CVO. */
export interface CvoErrorMessage {
  type: 'CVO_ERROR'
  runId: number
  message: string
  stack?: string
  line?: number
  column?: number
}

/** sandbox → studio: terminal signal for one render. */
export interface CvoRenderedMessage {
  type: 'CVO_RENDERED'
  runId: number
  ok: boolean
}

/** sandbox → studio: the one-shot handshake the sandbox posts once it's wired
 *  and ready to receive renders (no runId — it precedes any run). */
export interface CvoSandboxReady {
  type: 'CVO_SANDBOX_READY'
}

/** sandbox → studio: the rendered content height (px), so the studio grows the iframe to fit instead
 *  of clipping it to the pane. Sent after each render AND on later growth (a chart that lays out a tick
 *  later) via a ResizeObserver, so async content isn't cut off. */
export interface CvoHeightMessage {
  type: 'CVO_HEIGHT'
  runId: number
  height: number
}

/** Everything the studio can receive from the sandbox. */
export type CvoSandboxOutbound =
  | CvoConsoleMessage
  | CvoErrorMessage
  | CvoRenderedMessage
  | CvoSandboxReady
  | CvoHeightMessage

/** Narrow an untrusted postMessage payload to a sandbox-outbound message. */
export function isCvoSandboxOutbound(v: unknown): v is CvoSandboxOutbound {
  if (typeof v !== 'object' || v === null) return false
  const t = (v as { type?: unknown }).type
  return t === 'CVO_CONSOLE' || t === 'CVO_ERROR' || t === 'CVO_RENDERED' || t === 'CVO_SANDBOX_READY' || t === 'CVO_HEIGHT'
}
