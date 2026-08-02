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
const syncIfPresent = process.argv.includes('--if-present');

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

// `npm run build` and Vite watch builds use this mode. The first explicit
// `qa:devtools-package` call creates the stable directory; every later build
// refreshes the same directory Chrome already has installed.
if (syncIfPresent && !existsSync(packageDir)) {
  process.exit(0);
}

// Preserve the temporary required-host promotion across automatic rebuilds.
// Older package directories predate the marker, so infer their mode from the
// installed manifest once and write the marker below for future rebuilds.
let effectiveGrantHostAccess = grantHostAccess;
if (syncIfPresent && !grantHostAccess) {
  const packageMarkerPath = join(packageDir, '.crev-devtools-package.json');
  const installedManifestPath = join(packageDir, 'manifest.json');
  if (existsSync(packageMarkerPath)) {
    try {
      const marker = JSON.parse(readFileSync(packageMarkerPath, 'utf8'));
      effectiveGrantHostAccess = marker.grantHostAccess === true;
    } catch {
      // A damaged marker should not block a build; fall back to the manifest.
    }
  }
  if (!effectiveGrantHostAccess && existsSync(installedManifestPath)) {
    try {
      const installedManifest = JSON.parse(readFileSync(installedManifestPath, 'utf8'));
      const requiredHosts = Array.isArray(installedManifest.host_permissions)
        ? installedManifest.host_permissions
        : [];
      const optionalHosts = Array.isArray(installedManifest.optional_host_permissions)
        ? installedManifest.optional_host_permissions
        : [];
      effectiveGrantHostAccess = requiredHosts.length > 0 && optionalHosts.length === 0;
    } catch {
      // The fresh source manifest below remains the safe default.
    }
  }
}

rmSync(packageDir, { recursive: true, force: true });
mkdirSync(packageDir, { recursive: true });

cpSync(distDir, packageDir, { recursive: true });
cpSync(iconsDir, join(packageDir, 'icons'), { recursive: true });
cpSync(manifestPath, join(packageDir, 'manifest.json'));

if (effectiveGrantHostAccess) {
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

writeFileSync(
  join(packageDir, '.crev-devtools-package.json'),
  `${JSON.stringify({ grantHostAccess: effectiveGrantHostAccess }, null, 2)}\n`,
);

const manifestVersion = JSON.parse(readFileSync(manifestPath, 'utf8')).version;
if (syncIfPresent) {
  process.stdout.write(
    `Chrome DevTools package refreshed: ${packageDir} (v${manifestVersion})\n`,
  );
  process.exit(0);
}

process.stdout.write(
  [
    `Chrome DevTools package: ${packageDir}`,
    'Package path: stable for this checkout; future builds refresh it automatically',
    `Manifest: ${basename(manifestPath)}`,
    effectiveGrantHostAccess
      ? 'Host access: promoted in the temporary manifest only'
      : 'Host access: request normally in Chrome',
  ].join('\n') + '\n',
);
