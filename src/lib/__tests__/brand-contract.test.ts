import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(__dirname, '../../..');
const read = (path: string): string => readFileSync(join(repoRoot, path), 'utf8');

describe('Configuration Companion brand contract', () => {
  it('uses one public product and repository identity', () => {
    const publicSurface = [
      'manifest.json',
      'package.json',
      'README.md',
      'PRIVACY.md',
      'LICENSE',
      'THIRD-PARTY-NOTICES.md',
      '.github/workflows/release.yml',
      'src/sidepanel/sidepanel.html',
      'src/sidepanel/sidepanel.ts',
      'src/sidepanel/tabs/connect-tab.ts',
      'src/lib/version-check.ts',
      'src/lib/ai/editor-prompt.ts',
      'src/lib/ai/sidebar-prompt.ts',
    ].map(read).join('\n');

    expect(publicSurface).toContain('Configuration Companion');
    expect(publicSurface).toContain('HeinemannT/configuration-companion');
    expect(publicSurface).not.toContain('CREV Inspector');
    expect(publicSurface).not.toContain('HeinemannT/crev-inspector');
    expect(publicSurface).not.toContain('crev-inspector-${VERSION}.zip');
    expect(publicSurface).not.toContain('crev.theinemann.de');
    expect(publicSurface).not.toContain('Open developer tools');
  });

  it('preserves established technical and persisted CREV contracts', () => {
    expect(read('src/content-overlay-style.ts')).toContain("'crev-inspector-styles'");
    expect(read('src/lib/logger.ts')).toContain("'[CREV]'");
    expect(read('src/lib/handlers/studio.ts')).toContain("'CREV Studio Assets'");
    expect(read('src/lib/settings.ts')).toContain('crev_settings');
    expect(read('scripts/prepare-devtools-package.mjs')).toContain('crev-inspector-devtools-');
  });
});
