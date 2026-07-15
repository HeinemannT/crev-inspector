/** Bundle and run the production agent-loop benchmark with Vite-style ?raw support. */
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

const outfile = join(here, 'out', 'run-agent-bench.bundle.mjs');
await build({
  entryPoints: [join(here, 'run-agent-bench.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile,
  plugins: [rawPlugin],
  logLevel: 'warning',
});
process.env.BENCH_DIR = here;
await import(pathToFileURL(outfile).href);
