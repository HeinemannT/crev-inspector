import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(__dirname, '../../..');

describe('Chrome DevTools package contract', () => {
  it('keeps one safe temp package that normal builds refresh', () => {
    const prepareScript = readFileSync(
      join(repoRoot, 'scripts/prepare-devtools-package.mjs'),
      'utf8',
    );
    const viteConfig = readFileSync(join(repoRoot, 'vite.config.ts'), 'utf8');

    expect(prepareScript).toContain("createHash('sha256')");
    expect(prepareScript).toContain("relative(tempRoot, packageDir)");
    expect(prepareScript).toContain('Refusing to replace package outside the temp directory');
    expect(prepareScript).toContain("process.argv.includes('--if-present')");
    expect(prepareScript).toContain('.crev-devtools-package.json');
    expect(viteConfig).toContain("'scripts/prepare-devtools-package.mjs'), '--if-present'");
  });

  it('has a single supported live extension path', () => {
    const packageJson = JSON.parse(
      readFileSync(join(repoRoot, 'package.json'), 'utf8'),
    ) as {
      scripts: Record<string, string>;
      devDependencies: Record<string, string>;
    };

    expect(packageJson.scripts['qa:devtools-package']).toBeTruthy();
    expect(packageJson.scripts['browser:open']).toBeUndefined();
    expect(packageJson.scripts['test:extension-load']).toBeUndefined();
    expect(packageJson.devDependencies.playwright).toBeUndefined();
  });
});
