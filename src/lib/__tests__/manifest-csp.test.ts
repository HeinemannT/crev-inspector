/**
 * Locks the manifest CSP `frame-ancestors` directive in place.
 *
 * The extension's privileged pages (editor/*, diff/*, objectview/*,
 * codesearch/*, studio/*) are declared `web_accessible_resources` for
 * `<all_urls>` and are deliberately embedded as floating iframes INTO the
 * granted BMP host page (see `content-frame-overlay.ts` — the overlay's
 * parent frame is the BMP origin, an http(s) web page, NOT the extension
 * origin). Because of that topology the directive must permit http(s)
 * ancestors: a bare `frame-ancestors 'self'` blocks the overlays and the
 * user sees a grey "refused to connect" frame (0.6.2 regression). The
 * directive therefore reads `'self' https: http:` — still blocking
 * data:/blob:/filesystem: and cross-extension framers, while allowing the
 * web-page-frames-extension-page embedding the product depends on. The real
 * anti-abuse gate for these pages is that they are inert without a valid
 * content-script message handshake, not the CSP.
 *
 * This test fails if the directive regresses to bare `'self'` (which
 * re-breaks the overlays) or is accidentally applied to the `sandbox` CSP
 * (which governs the opaque-origin studio/sandbox.html CVO runner and must
 * NOT restrict framing, since it is framed by studio/studio.html via the
 * manifest sandbox mechanism).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function readManifest(): Record<string, unknown> {
  const raw = readFileSync(join(__dirname, '../../..', 'manifest.json'), 'utf8');
  return JSON.parse(raw);
}

describe('manifest CSP frame-ancestors', () => {
  it('declares the Chromium floor required by AbortSignal.any', () => {
    const manifest = readManifest();
    expect(manifest.minimum_chrome_version).toBe('116');
  });

  it('extension_pages CSP permits http(s) ancestors so overlays embed in the BMP host page', () => {
    const manifest = readManifest();
    const csp = manifest.content_security_policy as { extension_pages: string; sandbox: string };
    expect(csp.extension_pages).toContain('frame-ancestors');
    expect(csp.extension_pages).toContain("frame-ancestors 'self' https: http:");
  });

  it('extension_pages frame-ancestors is NOT bare \'self\' (would break the overlay iframes)', () => {
    const manifest = readManifest();
    const csp = manifest.content_security_policy as { extension_pages: string; sandbox: string };
    // A bare `frame-ancestors 'self'` (no scheme source) blocks embedding the
    // privileged pages into the http(s) BMP host page. Guard against that.
    expect(csp.extension_pages).not.toMatch(/frame-ancestors 'self'\s*(?:;|$)/);
  });

  it('sandbox CSP does NOT contain frame-ancestors', () => {
    const manifest = readManifest();
    const csp = manifest.content_security_policy as { extension_pages: string; sandbox: string };
    expect(csp.sandbox).not.toContain('frame-ancestors');
  });

  it('web_accessible_resources still lists the privileged pages (regression guard)', () => {
    const manifest = readManifest();
    const war = manifest.web_accessible_resources as Array<{ resources: string[]; matches: string[] }>;
    const resources = war.flatMap((entry) => entry.resources);
    for (const expected of ['editor/*', 'diff/*', 'objectview/*', 'codesearch/*', 'studio/*']) {
      expect(resources).toContain(expected);
    }
  });
});
