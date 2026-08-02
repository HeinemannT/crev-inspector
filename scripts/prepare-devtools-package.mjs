import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
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

// Keep one package path per checkout. Chrome's Reload button keeps pointing at
// this directory, while every QA build replaces its contents with the newest
// dist output. A random mkdtemp path would freeze Chrome on an obsolete copy
// after the next build.
const checkoutKey = createHash('sha256')
  .update(repoRoot.toLowerCase())
  .digest('hex')
  .slice(0, 10);
const tempRoot = resolve(tmpdir());
const packageDir = resolve(tempRoot, `crev-inspector-devtools-${checkoutKey}`);
const packageRelative = relative(tempRoot, packageDir);
if (!packageRelative || packageRelative.startsWith('..') || isAbsolute(packageRelative)) {
  throw new Error(`Refusing to replace package outside the temp directory: ${packageDir}`);
}
rmSync(packageDir, { recursive: true, force: true });
mkdirSync(packageDir, { recursive: true });

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
    'Package path: stable for this checkout; rebuild, then use Chrome Reload',
    `Manifest: ${basename(manifestPath)}`,
    grantHostAccess
      ? 'Host access: promoted in the temporary manifest only'
      : 'Host access: request normally in Chrome',
  ].join('\n') + '\n',
);
