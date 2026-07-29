import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(__dirname, '../../..');

function pngDimensions(path: string): { width: number; height: number } {
  const bytes = readFileSync(path);
  expect(bytes.subarray(1, 4).toString('ascii')).toBe('PNG');
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
}

describe('CREV Inspector icon assets', () => {
  it('provides every manifest PNG at its declared dimensions', () => {
    const manifest = JSON.parse(readFileSync(join(repoRoot, 'manifest.json'), 'utf8')) as {
      icons: Record<string, string>;
    };
    for (const [size, relativePath] of Object.entries(manifest.icons)) {
      const path = join(repoRoot, relativePath);
      expect(existsSync(path), relativePath).toBe(true);
      expect(pngDimensions(path)).toEqual({ width: Number(size), height: Number(size) });
    }
  });

  it('keeps the side panel on the canonical SVG source', () => {
    const svgPath = join(repoRoot, 'icons/crev-inspector.svg');
    const sidePanelSource = readFileSync(join(repoRoot, 'src/sidepanel/sidepanel.ts'), 'utf8');

    expect(existsSync(svgPath)).toBe(true);
    expect(readFileSync(svgPath, 'utf8')).toContain('aria-label="CREV Inspector"');
    expect(sidePanelSource).toContain("icons/crev-inspector.svg");
    expect(existsSync(join(repoRoot, 'scripts/generate-logo-v5.mjs'))).toBe(false);
  });
});
