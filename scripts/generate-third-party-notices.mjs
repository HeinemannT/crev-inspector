import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = join(root, 'THIRD-PARTY-NOTICES.md');
const checkOnly = process.argv.includes('--check');
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));

const FALLBACK_LICENSES = {
  MIT: `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`,
};

function formatPerson(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  return [value.name, value.email, value.url].filter(Boolean).join(' ');
}

function packageInfo(installPath, lockMeta) {
  const packageDir = join(root, installPath);
  const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
  const noticeFiles = readdirSync(packageDir)
    .filter(name => /^(licen[cs]e|notice)(\..*)?$/i.test(name))
    .sort((a, b) => a.localeCompare(b));
  const notices = noticeFiles.map(name => ({
    name,
    text: readFileSync(join(packageDir, name), 'utf8').trim(),
  }));
  return {
    name: manifest.name,
    version: lockMeta.version ?? manifest.version,
    license: lockMeta.license ?? manifest.license ?? 'UNKNOWN',
    author: formatPerson(manifest.author),
    notices,
  };
}

const packagesByIdentity = new Map();
for (const [installPath, meta] of Object.entries(lock.packages)) {
  if (!installPath.startsWith('node_modules/') || meta.dev === true) continue;
  const info = packageInfo(installPath, meta);
  const identity = `${info.name}@${info.version}`;
  const existing = packagesByIdentity.get(identity);
  if (!existing || existing.notices.length < info.notices.length) {
    packagesByIdentity.set(identity, info);
  }
}

const packages = [...packagesByIdentity.values()]
  .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));

const sections = new Map();
for (const pkg of packages) {
  if (pkg.notices.length === 0) {
    const fallback = FALLBACK_LICENSES[pkg.license];
    if (!fallback) {
      throw new Error(`${pkg.name}@${pkg.version} declares ${pkg.license} but ships no notice file`);
    }
    const attribution = pkg.author ? `Package metadata attribution: ${pkg.author}\n\n` : '';
    pkg.notices.push({ name: `${pkg.license} fallback`, text: `${attribution}${fallback}` });
  }
  for (const notice of pkg.notices) {
    const key = notice.text.replace(/\r\n/g, '\n');
    const group = sections.get(key) ?? { text: key, packages: [] };
    group.packages.push(`${pkg.name}@${pkg.version} (${notice.name})`);
    sections.set(key, group);
  }
}

const lines = [
  '# Third-Party Notices',
  '',
  'CREV Inspector is proprietary software. It includes third-party components',
  'that remain available under their own licenses. This file is generated from',
  'the production dependency graph locked in `package-lock.json`.',
  '',
  'Regenerate it with `npm run notices`; CI verifies it with `npm run notices:check`.',
  '',
  '## Component inventory',
  '',
  '| Component | Version | Declared license |',
  '|---|---:|---|',
  ...packages.map(pkg => `| ${pkg.name.replace(/\|/g, '\\|')} | ${pkg.version} | ${pkg.license} |`),
  '',
  '## License and notice texts',
  '',
];

for (const section of [...sections.values()].sort((a, b) => a.packages[0].localeCompare(b.packages[0]))) {
  lines.push(`### ${section.packages.join(', ')}`, '', '```text', section.text, '```', '');
}

const generated = `${lines.join('\n').trimEnd()}\n`;
if (checkOnly) {
  let current = '';
  try { current = readFileSync(outputPath, 'utf8'); } catch { /* reported below */ }
  if (current !== generated) {
    console.error('THIRD-PARTY-NOTICES.md is missing or stale. Run npm run notices.');
    process.exitCode = 1;
  }
} else {
  writeFileSync(outputPath, generated, 'utf8');
  console.log(`Wrote THIRD-PARTY-NOTICES.md for ${packages.length} production dependencies.`);
}
