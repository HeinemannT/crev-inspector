/**
 * Locks the manifest CSP `frame-ancestors` directive in place.
 *
 * The extension's privileged pages (editor/*, diff/*, objectview/*,
 * codesearch/*, studio/*) are declared `web_accessible_resources` for
 * `<all_urls>`, so any web origin can load them in an iframe. Without
 * `frame-ancestors 'self'` on the `extension_pages` CSP, those pages are
 * open to clickjacking. This test fails if the directive is ever removed
 * or accidentally applied to the `sandbox` CSP (which governs the opaque-
 * origin studio/sandbox.html CVO runner and must NOT restrict framing the
 * same way, since it is framed by studio/studio.html via the manifest
 * sandbox mechanism).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function readManifest(): Record<string, unknown> {
  const raw = readFileSync(join(__dirname, '../../..', 'manifest.json'), 'utf8');
  return JSON.parse(raw);
}

describe('manifest CSP frame-ancestors', () => {
  it('extension_pages CSP contains frame-ancestors \'self\'', () => {
    const manifest = readManifest();
    const csp = manifest.content_security_policy as { extension_pages: string; sandbox: string };
    expect(csp.extension_pages).toContain("frame-ancestors 'self'");
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
