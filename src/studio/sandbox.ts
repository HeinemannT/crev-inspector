/**
 * CVO Studio — sandbox runtime.
 *
 * Runs inside an MV3 *sandboxed* page (manifest `sandbox.pages`): a unique
 * opaque origin with NO access to chrome.* or the privileged extension. It is
 * the only place arbitrary CVO code is evaluated. It receives a render request
 * from the studio page (its embedder) over postMessage, reproduces BMP's CVO
 * contract — one global `_data` whose `.element` is the container div — runs
 * the CVO's html + javascript, and reports console output / thrown errors back.
 *
 * Each render starts from a fresh container (drop + rebuild), so a re-run can't
 * stack listeners or leak DOM the way re-evaluating in a live page would. That
 * clean teardown is the whole reason for normalising every CVO — bundle-shaped
 * or inline — into this one harness.
 *
 * Network (real feeds, FileResource libraries) is NOT wired here yet: the
 * keystone runs against a mock `_data` and offline CVOs. When live data lands,
 * the sandbox will request it from the studio (which relays to the SW), never
 * fetching BMP directly — it has neither the cookies nor the origin to.
 */

// ── Messages (mirrored, by hand, in studio.ts — sandbox can't import the
//    privileged types module without dragging chrome.* typings in) ──────────
interface RenderRequest {
  type: 'CVO_RENDER'
  /** Monotonic id so late console/errors from a superseded run can be ignored. */
  runId: number
  html: string
  javascript: string
  /** The mock (later: real) `_data`, minus `.element` which we attach here. */
  data: Record<string, unknown>
}

type OutboundMessage =
  | { type: 'CVO_CONSOLE'; runId: number; level: 'log' | 'warn' | 'error' | 'info'; text: string }
  | { type: 'CVO_ERROR'; runId: number; message: string; stack?: string; line?: number; column?: number }
  | { type: 'CVO_RENDERED'; runId: number; ok: boolean }

let currentRunId = 0

function post(msg: OutboundMessage): void {
  // The embedder is the studio page; '*' is safe because the payload carries no
  // secrets and the sandbox only ever has one embedder.
  parent.postMessage(msg, '*')
}

/** Serialise a console argument compactly for the studio's console strip. */
function fmtArg(a: unknown): string {
  if (typeof a === 'string') return a
  if (a instanceof Error) return a.stack || a.message
  try { return JSON.stringify(a) } catch { return String(a) }
}

/** Container we render each CVO into. Replaced wholesale per run so teardown is
 *  total — no stale nodes, listeners, or `dataset` guard flags survive. */
function freshRoot(): HTMLElement {
  const old = document.getElementById('cvo-root')
  if (old) old.remove()
  const root = document.createElement('div')
  root.id = 'cvo-root'
  document.body.appendChild(root)
  return root
}

function render(req: RenderRequest): void {
  currentRunId = req.runId
  const runId = req.runId
  const root = freshRoot()

  // Reproduce the CVO contract: a single `_data` global whose `.element` is the
  // container. html is injected first (BMP uses dangerouslySetInnerHTML), then
  // javascript runs with `_data` in scope.
  const data = { ...req.data, element: root }

  try {
    root.innerHTML = req.html
  } catch (e) {
    post({ type: 'CVO_ERROR', runId, message: `Failed to set html: ${(e as Error).message}` })
  }

  if (req.javascript.trim()) {
    try {
      // `_data` is provided as a parameter — equivalent to BMP's eval-with-_data
      // -in-scope for any code that reads the global, but scoped to this call so
      // top-level `var`s don't leak between runs. A function body legally allows
      // the IIFE-or-not shapes CVOs use.
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const run = new Function('_data', req.javascript)
      run(data)
    } catch (e) {
      const err = e as Error
      post({ type: 'CVO_ERROR', runId, message: err.message, stack: err.stack })
      post({ type: 'CVO_RENDERED', runId, ok: false })
      return
    }
  }
  post({ type: 'CVO_RENDERED', runId, ok: true })
}

// ── Console + error capture ────────────────────────────────────────────────
// Forward the sandbox's console to the studio so a CVO's logs/warnings are
// visible, and turn the silent-blank-widget failure (a thrown CVO) into a
// surfaced error. Guarded by runId so a stale async log from a superseded run
// is tagged and can be dropped upstream.
;(['log', 'warn', 'error', 'info'] as const).forEach(level => {
  const orig = console[level].bind(console)
  console[level] = (...args: unknown[]) => {
    orig(...args)
    post({ type: 'CVO_CONSOLE', runId: currentRunId, level, text: args.map(fmtArg).join(' ') })
  }
})

window.addEventListener('error', ev => {
  post({
    type: 'CVO_ERROR',
    runId: currentRunId,
    message: ev.message || 'Uncaught error',
    stack: ev.error?.stack,
    line: ev.lineno,
    column: ev.colno,
  })
})

window.addEventListener('unhandledrejection', ev => {
  const reason = ev.reason
  post({
    type: 'CVO_ERROR',
    runId: currentRunId,
    message: reason instanceof Error ? reason.message : `Unhandled rejection: ${fmtArg(reason)}`,
    stack: reason instanceof Error ? reason.stack : undefined,
  })
})

window.addEventListener('message', ev => {
  // Only the embedder (studio page) drives renders. Sandbox has one parent.
  if (ev.source !== parent) return
  const msg = ev.data as RenderRequest | undefined
  if (msg && msg.type === 'CVO_RENDER') render(msg)
})

// Tell the studio we're ready to receive renders (it may have a request queued
// before this script ran).
parent.postMessage({ type: 'CVO_SANDBOX_READY' }, '*')
