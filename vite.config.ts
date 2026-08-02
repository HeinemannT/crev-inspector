import { defineConfig, normalizePath, type Plugin } from 'vite';
import { resolve } from 'path';
import { copyFileSync, mkdirSync, existsSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'fs';
import { execFileSync } from 'child_process';
import * as esbuild from 'esbuild';

const BUILD_TARGET = 'esnext' as const;
const contentEntry = resolve(__dirname, 'src/content.ts');
const blueprintEntry = resolve(__dirname, 'src/content-blueprint-entry.ts');
const interceptorEntry = resolve(__dirname, 'src/interceptor.ts');
const buildInfoEntry = normalizePath(resolve(__dirname, 'src/lib/build-info.ts'));
const BUILD_ID_TOKEN = '__CREV_BUILD_ID__';

function createBuildId(): string {
  const commit = process.env.GITHUB_SHA?.trim();
  if (commit) return commit.slice(0, 7);
  return `dev-${Date.now().toString(36).slice(-6)}`;
}

/**
 * Bake a compact identity into every runtime build. Unlike manifest.version,
 * this changes for each local watch build, so Chrome DevTools can prove which
 * bundle is actually loaded.
 */
function buildInfoPlugin(): Plugin {
  let buildId = createBuildId();

  return {
    name: 'crev-build-info',
    buildStart() {
      buildId = createBuildId();
    },
    transform(code, id) {
      if (normalizePath(id.split('?')[0]) === buildInfoEntry) {
        return code.replace(BUILD_ID_TOKEN, buildId);
      }
    },
    shouldTransformCachedModule({ id }) {
      return normalizePath(id.split('?')[0]) === buildInfoEntry;
    },
  };
}

/**
 * Content scripts run as classic scripts (not ES modules), so they
 * cannot use `import` statements. Use esbuild to bundle each content
 * entry into a self-contained IIFE that replaces the Vite-generated output.
 *
 * Three classic-script entries share one esbuild pass config:
 *   - content.js            — the always-on inspector bundle (src/content.ts)
 *   - content-blueprint.js  — the lazily-injected Blueprint editor (~150 KB:
 *     content-blueprint/* + lib/layout/* + the ~63 KB CSS via the text loader),
 *     injected on demand on first Ctrl+Shift+B activation (plans/009), NOT
 *     registered for every page load. Keeping it out of content.js is the whole
 *     point of the split — see src/content-blueprint-entry.ts.
 *   - interceptor.js        — registered in Chrome's MAIN world. Registered
 *     content scripts are classic scripts too; leaving Rollup's shared-chunk
 *     import here silently prevents the interceptor from starting.
 */
async function bundleOne(entryPoint: string): Promise<string> {
  const result = await esbuild.build({
    entryPoints: [entryPoint],
    bundle: true,
    write: false,
    format: 'iife',
    minify: true,
    target: BUILD_TARGET,
    loader: { '.css': 'text' },
  });
  return result.outputFiles[0].text;
}

function bundleContentScript(): Plugin {
  return {
    name: 'bundle-content-script',
    async generateBundle(_options, bundle) {
      const contentEntryChunk = bundle['content.js'];
      if (contentEntryChunk && contentEntryChunk.type === 'chunk') {
        contentEntryChunk.code = await bundleOne(contentEntry);
      }
      const interceptorEntryChunk = bundle['interceptor.js'];
      if (interceptorEntryChunk && interceptorEntryChunk.type === 'chunk') {
        interceptorEntryChunk.code = await bundleOne(interceptorEntry);
      }
      // content-blueprint.js has no Rollup input (it's content-only, never imported by an ES-module
      // page), so emit it directly as an asset rather than patching an existing chunk.
      this.emitFile({
        type: 'asset',
        fileName: 'content-blueprint.js',
        source: await bundleOne(blueprintEntry),
      });
    },
  };
}

/** Recursively copy a directory */
function copyDirSync(src: string, dest: string) {
  if (!existsSync(src)) return;
  if (!existsSync(dest)) mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const srcPath = resolve(src, entry.name);
    const destPath = resolve(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Post-build: fix HTML paths in dist/, then copy built artifacts to
 * the project root so Chrome can load the extension directly from it.
 * manifest.json and icons/ already live at root (source files).
 */
function extensionPlugin(): Plugin {
  return {
    name: 'chrome-extension',
    closeBundle() {
      const dist = resolve(__dirname, 'dist');
      const root = resolve(__dirname);

      // --- Fix HTML paths in dist/ ---
      //
      // Rollup writes each entry HTML to dist/src/<name>/<name>.html with
      // ../../<name>/, ../../chunks/, ../../assets/ references (relative
      // to the source location). We move each to dist/<name>/<name>.html
      // and rewrite the references to be relative to the new location.
      // All seven entry points share the same rewrite pattern — one helper
      // instead of seven near-identical 8-line blocks.
      // Most surfaces are one html per dir (dir === file); studio is the
      // exception — two pages (studio + the sandboxed sandbox) share studio/ —
      // so entries are {dir,file}.
      const HTML_ENTRIES: Array<{ dir: string; file: string }> = [
        { dir: 'sidepanel', file: 'sidepanel' },
        { dir: 'editor', file: 'editor' },
        { dir: 'objectview', file: 'objectview' },
        { dir: 'diff', file: 'diff' },
        { dir: 'codesearch', file: 'codesearch' },
        { dir: 'studio', file: 'studio' },
        { dir: 'studio', file: 'sandbox' },
      ];
      for (const { dir, file } of HTML_ENTRIES) {
        const srcHtml = resolve(dist, `src/${dir}/${file}.html`);
        const destDir = resolve(dist, dir);
        const destHtml = resolve(destDir, `${file}.html`);
        if (!existsSync(srcHtml)) continue;
        if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });
        let html = readFileSync(srcHtml, 'utf-8');
        // Self-folder reference: `../../foo/` → `./`
        html = html.replace(new RegExp(`\\.\\.\\/\\.\\.\\/${dir}\\/`, 'g'), './');
        // Shared chunks + assets, one level up
        html = html.replace(/\.\.\/\.\.\/chunks\//g, '../chunks/');
        html = html.replace(/\.\.\/\.\.\/assets\//g, '../assets/');
        writeFileSync(destHtml, html);
      }

      // Clean up src/ directory in dist
      if (existsSync(resolve(dist, 'src'))) {
        rmSync(resolve(dist, 'src'), { recursive: true, force: true });
      }

      // --- Copy built artifacts from dist/ to project root ---

      // Top-level JS files
      for (const file of ['content.js', 'content-blueprint.js', 'interceptor.js', 'service-worker.js']) {
        const src = resolve(dist, file);
        if (existsSync(src)) copyFileSync(src, resolve(root, file));
      }

      // Directories: chunks/, assets/, sidepanel/, editor/, objectview/, …
      for (const dir of ['chunks', 'assets', 'sidepanel', 'editor', 'objectview', 'diff', 'codesearch', 'studio']) {
        const src = resolve(dist, dir);
        if (existsSync(src)) copyDirSync(src, resolve(root, dir));
      }

      // Chrome keeps an unpacked extension pinned to the directory originally
      // selected in chrome://extensions. Once qa:devtools-package has created
      // that stable temp directory, refresh it after every normal/watch build
      // so Chrome's Reload button always picks up the newest local manifest and
      // bundles. On CI and fresh checkouts the directory does not exist, so the
      // helper exits without creating local QA state.
      execFileSync(
        process.execPath,
        [resolve(root, 'scripts/prepare-devtools-package.mjs'), '--if-present'],
        { stdio: 'inherit' },
      );
    },
  };
}

export default defineConfig({
  base: '',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: BUILD_TARGET,
    minify: true,
    modulePreload: false,
    rollupOptions: {
      // CSS imported anywhere in the content-script bundle (content.ts or a src/content* module it
      // pulls in, e.g. content-blueprint) is handled by esbuild (bundleContentScript plugin) with the
      // '.css':'text' loader — mark it external so the Rollup pass doesn't try to resolve it.
      external: (id, importer) => id.endsWith('.css') && !!importer && importer.includes('/content'),
      input: {
        'service-worker': resolve(__dirname, 'src/service-worker.ts'),
        interceptor: resolve(__dirname, 'src/interceptor.ts'),
        content: resolve(__dirname, 'src/content.ts'),
        'sidepanel/sidepanel': resolve(__dirname, 'src/sidepanel/sidepanel.html'),
        'editor/editor': resolve(__dirname, 'src/editor/editor.html'),
        'objectview/objectview': resolve(__dirname, 'src/objectview/objectview.html'),
        'diff/diff': resolve(__dirname, 'src/diff/diff.html'),
        'codesearch/codesearch': resolve(__dirname, 'src/codesearch/codesearch.html'),
        'studio/studio': resolve(__dirname, 'src/studio/studio.html'),
        // Sandboxed page (manifest sandbox.pages) — runs arbitrary CVO code.
        'studio/sandbox': resolve(__dirname, 'src/studio/sandbox.html'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name].js',
        assetFileNames: 'assets/[name].[ext]',
      },
    },
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  plugins: [buildInfoPlugin(), bundleContentScript(), extensionPlugin()],
});
