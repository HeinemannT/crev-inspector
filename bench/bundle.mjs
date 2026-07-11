/**
 * Bundle + run bench/build-prompts.ts with esbuild, resolving Vite-style
 * `?raw` imports (the knowledge packs) via a tiny plugin. Usage:
 *
 *   node bench/bundle.mjs
 */
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

const rawPlugin = {
  name: 'vite-raw',
  setup(b) {
    b.onResolve({ filter: /\?raw$/ }, args => ({
      path: resolve(args.resolveDir, args.path.replace(/\?raw$/, '')),
      namespace: 'raw',
    }));
    b.onLoad({ filter: /.*/, namespace: 'raw' }, args => ({
      contents: readFileSync(args.path, 'utf8'),
      loader: 'text',
    }));
  },
};

const outfile = join(here, 'out', 'build-prompts.bundle.mjs');
await build({
  entryPoints: [join(here, 'build-prompts.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile,
  plugins: [rawPlugin],
  logLevel: 'warning',
});
process.env.BENCH_DIR = here;
await import(pathToFileURL(outfile).href);
