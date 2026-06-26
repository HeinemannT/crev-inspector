import { defineConfig, type Plugin } from 'vite';
import { resolve } from 'path';
import { copyFileSync, mkdirSync, existsSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'fs';
import * as esbuild from 'esbuild';

const BUILD_TARGET = 'esnext' as const;
const contentEntry = resolve(__dirname, 'src/content.ts');

/**
 * Content scripts run as classic scripts (not ES modules), so they
 * cannot use `import` statements. Use esbuild to bundle content.ts
 * into a self-contained IIFE that replaces the Vite-generated output.
 */
function bundleContentScript(): Plugin {
  return {
    name: 'bundle-content-script',
    async generateBundle(_options, bundle) {
      const result = await esbuild.build({
        entryPoints: [contentEntry],
        bundle: true,
        write: false,
        format: 'iife',
        minify: true,
        target: BUILD_TARGET,
        loader: { '.css': 'text' },
      });
      const entry = bundle['content.js'];
      if (entry && entry.type === 'chunk') {
        entry.code = result.outputFiles[0].text;
      }
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
      for (const file of ['content.js', 'interceptor.js', 'service-worker.js']) {
        const src = resolve(dist, file);
        if (existsSync(src)) copyFileSync(src, resolve(root, file));
      }

      // Directories: chunks/, assets/, sidepanel/, editor/, objectview/, …
      for (const dir of ['chunks', 'assets', 'sidepanel', 'editor', 'objectview', 'diff', 'codesearch', 'studio']) {
        const src = resolve(dist, dir);
        if (existsSync(src)) copyDirSync(src, resolve(root, dir));
      }
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
  plugins: [bundleContentScript(), extensionPlugin()],
});
