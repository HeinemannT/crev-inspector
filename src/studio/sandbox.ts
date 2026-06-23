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
 * The render core (freshRoot / runCvo / installConsoleCapture) is exported and
 * exercised by sandbox-runtime.test.ts; the module body below is the thin
 * postMessage shell that wires those to the embedder.
 *
 * Network (real feeds, FileResource libraries) is NOT wired here yet: the
 * keystone runs against a mock `_data` and offline CVOs. When live data lands,
 * the sandbox will request it from the studio (which relays to the SW), never
 * fetching BMP directly — it has neither the cookies nor the origin to.
 */

// ── Messages (mirrored, by hand, in studio.ts — sandbox can't import the
//    privileged types module without dragging chrome.* typings in) ──────────
export interface RenderRequest {
  type: 'CVO_RENDER'
  /** Monotonic id so late console/errors from a superseded run can be ignored. */
  runId: number
  html: string
  javascript: string
  /** The mock (later: real) `_data`, minus `.element` which we attach here. */
  data: Record<string, unknown>
  /** Hosted FileResource libraries (decoded JS source) to run BEFORE the CVO,
   *  so their globals (e.g. `echarts`) are ready — mirrors the portal loading
   *  them same-origin. The studio fetches these via the SW. */
  libs?: string[]
}

export type OutboundMessage =
  | { type: 'CVO_CONSOLE'; runId: number; level: 'log' | 'warn' | 'error' | 'info'; text: string }
  | { type: 'CVO_ERROR'; runId: number; message: string; stack?: string; line?: number; column?: number }
  | { type: 'CVO_RENDERED'; runId: number; ok: boolean }

export type Emit = (msg: OutboundMessage) => void

/** Serialise a console argument compactly for the studio's console strip. */
export function fmtArg(a: unknown): string {
  if (typeof a === 'string') return a
  if (a instanceof Error) return a.stack || a.message
  try { return JSON.stringify(a) } catch { return String(a) }
}

/** Inject hosted libraries as classic <script> elements (global-scope eval, so
 *  UMD globals like `echarts` attach to window) BEFORE the CVO runs. Tagged
 *  `data-cvo-lib` so they can be cleared + re-injected when the set changes. */
export function injectLibs(doc: Document, libs: string[]): void {
  for (const lib of libs) {
    const s = doc.createElement('script')
    s.setAttribute('data-cvo-lib', '')
    s.textContent = lib
    doc.head.appendChild(s)
  }
}

/** Replace the render container wholesale so teardown is total — no stale
 *  nodes, listeners, or `dataset` guard flags survive between runs. */
export function freshRoot(doc: Document): HTMLElement {
  const old = doc.getElementById('cvo-root')
  if (old) old.remove()
  const root = doc.createElement('div')
  root.id = 'cvo-root'
  doc.body.appendChild(root)
  return root
}

/** Run one CVO into `root`: reproduce the `_data` contract (`.element` = root),
 *  inject the html, then run the javascript with `_data` in scope. Reports a
 *  thrown error (the silent-blank-widget failure, surfaced) and the terminal
 *  CVO_RENDERED. Console capture is installed separately (see below) so it also
 *  catches async logs after this returns. */
export function runCvo(root: HTMLElement, req: RenderRequest, emit: Emit): void {
  const runId = req.runId
  // `_data` is provided as a parameter — equivalent to BMP's eval-with-_data-
  // in-scope for any code that reads the global, but scoped to this call so
  // top-level `var`s don't leak between runs.
  const data = { ...req.data, element: root }

  try {
    // innerHTML deliberately does NOT execute inline <script> or inline event
    // handlers in the html — this matches BMP (dangerouslySetInnerHTML) and is
    // the intended threat model: all behaviour comes from the `javascript` field
    // run below. Do NOT "fix" this by switching to a method that runs inline
    // scripts (insertAdjacentHTML/range.createContextualFragment + script eval).
    root.innerHTML = req.html
  } catch (e) {
    emit({ type: 'CVO_ERROR', runId, message: `Failed to set html: ${(e as Error).message}` })
  }

  if (req.javascript.trim()) {
    try {
      // A function body legally allows the IIFE-or-not shapes CVOs use.
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const run = new Function('_data', req.javascript)
      run(data)
    } catch (e) {
      const err = e as Error
      emit({ type: 'CVO_ERROR', runId, message: err.message, stack: err.stack })
      emit({ type: 'CVO_RENDERED', runId, ok: false })
      return
    }
  }
  emit({ type: 'CVO_RENDERED', runId, ok: true })
}

/** Forward the sandbox's console to the studio so a CVO's logs/warnings are
 *  visible. Permanent (not scoped to one run) so async logs are caught too;
 *  `getRunId` tags each line with the live run so superseded output can be
 *  dropped upstream. Returns a restore fn (used by tests). */
export function installConsoleCapture(emit: Emit, getRunId: () => number): () => void {
  const levels = ['log', 'warn', 'error', 'info'] as const
  const originals = levels.map(l => console[l])
  levels.forEach((level, i) => {
    console[level] = (...args: unknown[]) => {
      originals[i](...args)
      emit({ type: 'CVO_CONSOLE', runId: getRunId(), level, text: args.map(fmtArg).join(' ') })
    }
  })
  return () => { levels.forEach((level, i) => { console[level] = originals[i] }) }
}

// ── Module shell: wire the render core to the embedder over postMessage ─────
// Skipped under test (no parent embedder); the exports above are tested directly.
if (typeof window !== 'undefined' && window.parent !== window) {
  let currentRunId = 0
  const post: Emit = msg => parent.postMessage(msg, '*')

  installConsoleCapture(post, () => currentRunId)

  window.addEventListener('error', ev => {
    post({ type: 'CVO_ERROR', runId: currentRunId, message: ev.message || 'Uncaught error', stack: ev.error?.stack, line: ev.lineno, column: ev.colno })
  })
  window.addEventListener('unhandledrejection', ev => {
    const reason = (ev as PromiseRejectionEvent).reason
    post({ type: 'CVO_ERROR', runId: currentRunId, message: reason instanceof Error ? reason.message : `Unhandled rejection: ${fmtArg(reason)}`, stack: reason instanceof Error ? reason.stack : undefined })
  })

  // Inject hosted libs only when the set changes — the iframe gets many renders
  // (one per edit) but the deps rarely change; re-parsing a 1 MB lib each
  // keystroke would be wasteful.
  let libsFingerprint = ''
  const maybeInjectLibs = (libs: string[]) => {
    const fp = libs.length + ':' + libs.reduce((n, l) => n + l.length, 0)
    if (fp === libsFingerprint) return
    document.querySelectorAll('script[data-cvo-lib]').forEach(s => s.remove())
    injectLibs(document, libs)
    libsFingerprint = fp
  }

  window.addEventListener('message', ev => {
    if (ev.source !== parent) return
    const msg = ev.data as RenderRequest | undefined
    if (msg && msg.type === 'CVO_RENDER') {
      currentRunId = msg.runId
      // Libs first (sync <script> execution defines globals), then the CVO.
      maybeInjectLibs(msg.libs ?? [])
      runCvo(freshRoot(document), msg, post)
    }
  })

  // Tell the studio we're ready (it may have queued a render before this ran).
  parent.postMessage({ type: 'CVO_SANDBOX_READY' }, '*')
}
