/**
 * Sandbox isolation contract.
 *
 * The CVO preview runs arbitrary CVO `javascript` via `new Function(...)`. That
 * is only safe because of the manifest: the page it runs in is an MV3 sandboxed
 * page (a unique OPAQUE origin with no access to chrome.*, extension storage, or
 * the host cookies), and arbitrary eval is forbidden everywhere ELSE. Those are
 * manifest properties, not code properties — a well-meaning manifest edit could
 * silently turn the preview into a privilege-escalation hole with no other test
 * noticing. This test fails loudly if any of those guarantees regresses.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const manifest = JSON.parse(
  readFileSync(new URL('../../../manifest.json', import.meta.url), 'utf8'),
) as {
  sandbox?: { pages?: string[] }
  content_security_policy?: { extension_pages?: string; sandbox?: string }
}

const SANDBOX_PAGE = 'studio/sandbox.html'

describe('CVO sandbox isolation contract', () => {
  it('runs the CVO preview in a declared sandboxed page', () => {
    // The page that evals CVO code MUST be sandboxed → opaque origin → no chrome.*
    expect(manifest.sandbox?.pages ?? []).toContain(SANDBOX_PAGE)
  })

  it('does NOT grant the sandbox same-origin access', () => {
    // `allow-same-origin` would re-join the sandbox to the extension origin,
    // handing CVO code the extension's storage, messaging, and identity. The
    // whole isolation model depends on its ABSENCE.
    const csp = manifest.content_security_policy?.sandbox ?? ''
    expect(csp).toMatch(/\ballow-scripts\b/)
    expect(csp).not.toMatch(/\ballow-same-origin\b/)
  })

  it('forbids arbitrary eval on privileged extension pages', () => {
    // The inverse guarantee: `new Function` / eval is blocked on normal
    // extension pages, so CVO code can ONLY execute inside the sandbox. The
    // privileged CSP must not carry 'unsafe-eval'.
    const csp = manifest.content_security_policy?.extension_pages ?? ''
    expect(csp).toMatch(/script-src[^;]*'self'/)
    expect(csp).not.toMatch(/unsafe-eval/)
  })

  it('keeps the privileged studio page OUT of the sandbox list', () => {
    // studio.html is privileged (chrome.* messaging to the SW); only its
    // preview iframe is sandboxed. If studio.html were sandboxed it would lose
    // the messaging it needs — and if the sandbox page gained privilege the
    // eval guarantee above would be void.
    expect(manifest.sandbox?.pages ?? []).not.toContain('studio/studio.html')
  })
})
