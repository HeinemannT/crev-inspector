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

// The studio ⇄ sandbox message contract lives in cvo-protocol.ts — one
// dependency-free module both sides import, so the shapes can't drift.
import type { CvoLib, CvoRenderRequest, CvoSandboxOutbound } from './cvo-protocol'

/** Local alias kept for readability in this file's render core. */
export type RenderRequest = CvoRenderRequest
export type Emit = (msg: CvoSandboxOutbound) => void

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

/** A fetched lib paired with the blob URL minted for it (see rewriteDownloadUrls). */
export interface SandboxLib extends CvoLib {
  blobUrl: string
}

/** Rewrite a CVO's own `web/download?...&rid=<rid>` references to the blob URL
 *  of the fetched lib content, for every lib by rid. CVOs load hosted resources
 *  with a RELATIVE url (the portal resolves it under /<workspace>/); in the
 *  sandbox that same url resolves under the extension origin and 404s — fatally
 *  so for a dynamic `import()`, which a global <script> injection can't satisfy.
 *  Rewriting to a same-content blob URL makes both import() and <script src>
 *  resolve. Matches a contiguous url token (no quotes/space/parens) so it works
 *  whether the url is absolute (`/web/download?...`) or relative (`web/...`).
 *
 *  Known gap: a url assembled at runtime (`import("web/download?rid=" + ridVar)`)
 *  has no literal token to rewrite, so it still 404s — the lib is fetched (the
 *  rid is found via the bootstrap-global shape) but the import can't be redirected.
 *  Documented consumers use a literal url, so this is out of the blast radius. */
export function rewriteDownloadUrls(text: string, libs: SandboxLib[]): string {
  let out = text
  for (const lib of libs) {
    const re = new RegExp(
      `[^"'\`()\\s]*\\bweb/download\\?[^"'\`()\\s]*\\brid=${lib.rid}\\b[^"'\`()\\s]*`,
      'g',
    )
    out = out.replace(re, lib.blobUrl)
  }
  return out
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
  // keystroke would be wasteful. Each lib is both run as a global <script> (for
  // UMD globals) and given a blob URL so the CVO's own download-url references
  // can be rewritten to it (so dynamic import()/script-src resolve — see
  // rewriteDownloadUrls). Blob URLs are revoked when the set changes.
  //
  // Both paths are needed: innerHTML never runs the rewritten <script src=blob>,
  // so the global injection is the only thing that executes a script-src lib;
  // the blob is for import(). A CVO that BOTH script-srcs and import()s the same
  // lib therefore evals it twice — harmless for idempotent UMD, but a lib with
  // global side effects (customElements.define) would throw on the 2nd eval.
  // That both-ways shape is rare; accepted over the complexity of deduping.
  let libsFingerprint = ''
  let sandboxLibs: SandboxLib[] = []
  const maybeInjectLibs = (libs: CvoLib[]) => {
    const fp = libs.map(l => `${l.rid}:${l.content.length}`).join(';')
    if (fp === libsFingerprint) return
    sandboxLibs.forEach(l => URL.revokeObjectURL(l.blobUrl))
    document.querySelectorAll('script[data-cvo-lib]').forEach(s => s.remove())
    sandboxLibs = libs.map(l => ({
      ...l,
      blobUrl: URL.createObjectURL(new Blob([l.content], { type: 'text/javascript' })),
    }))
    injectLibs(document, sandboxLibs.map(l => l.content))
    libsFingerprint = fp
  }

  window.addEventListener('message', ev => {
    if (ev.source !== parent) return
    const msg = ev.data as RenderRequest | undefined
    if (msg && msg.type === 'CVO_RENDER') {
      currentRunId = msg.runId
      // Libs first (sync <script> execution defines globals), then the CVO with
      // its download-url references rewritten to the libs' blob URLs.
      maybeInjectLibs(msg.libs ?? [])
      const req: RenderRequest = {
        ...msg,
        html: rewriteDownloadUrls(msg.html, sandboxLibs),
        javascript: rewriteDownloadUrls(msg.javascript, sandboxLibs),
      }
      runCvo(freshRoot(document), req, post)
    }
  })

  // Tell the studio we're ready (it may have queued a render before this ran).
  parent.postMessage({ type: 'CVO_SANDBOX_READY' }, '*')
}
