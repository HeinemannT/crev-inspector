import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const distDir = join(repoRoot, 'dist');
const manifestPath = join(repoRoot, 'manifest.json');
const iconsDir = join(repoRoot, 'icons');
const grantHostAccess = process.argv.includes('--grant-host');

for (const requiredPath of [distDir, manifestPath, iconsDir]) {
  if (!existsSync(requiredPath)) {
    throw new Error(`Missing ${requiredPath}. Run npm run build first.`);
  }
}

const packageDir = mkdtempSync(join(tmpdir(), 'crev-inspector-devtools-'));

cpSync(distDir, packageDir, { recursive: true });
cpSync(iconsDir, join(packageDir, 'icons'), { recursive: true });
cpSync(manifestPath, join(packageDir, 'manifest.json'));

if (grantHostAccess) {
  const qaManifestPath = join(packageDir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(qaManifestPath, 'utf8'));
  const optionalHosts = Array.isArray(manifest.optional_host_permissions)
    ? manifest.optional_host_permissions
    : [];
  const requiredHosts = Array.isArray(manifest.host_permissions)
    ? manifest.host_permissions
    : [];

  manifest.host_permissions = [...new Set([...requiredHosts, ...optionalHosts])];
  delete manifest.optional_host_permissions;
  writeFileSync(qaManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

process.stdout.write(
  [
    `Chrome DevTools package: ${packageDir}`,
    `Manifest: ${basename(manifestPath)}`,
    grantHostAccess
      ? 'Host access: promoted in the temporary manifest only'
      : 'Host access: request normally in Chrome',
  ].join('\n') + '\n',
);
