import { rmSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GENERATED_ROOT_DIRECTORIES, GENERATED_ROOT_FILES } from './build-output-paths.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const generatedPaths = ['dist', ...GENERATED_ROOT_FILES, ...GENERATED_ROOT_DIRECTORIES];

for (const generatedPath of generatedPaths) {
  const target = resolve(repositoryRoot, generatedPath);
  const pathFromRoot = relative(repositoryRoot, target);
  const escapesRoot = pathFromRoot === '..'
    || pathFromRoot.startsWith(`..${sep}`)
    || isAbsolute(pathFromRoot);

  if (!pathFromRoot || escapesRoot) {
    throw new Error(`Refusing to remove unsafe build-output path: ${target}`);
  }

  rmSync(target, { recursive: true, force: true });
}
