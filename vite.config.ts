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

      // Move sidepanel HTML from src/sidepanel/ to sidepanel/
      const panelSrcHtml = resolve(dist, 'src/sidepanel/sidepanel.html');
      const panelDestDir = resolve(dist, 'sidepanel');
      const panelDestHtml = resolve(panelDestDir, 'sidepanel.html');
      if (existsSync(panelSrcHtml)) {
        if (!existsSync(panelDestDir)) mkdirSync(panelDestDir, { recursive: true });
        let html = readFileSync(panelSrcHtml, 'utf-8');
        html = html.replace(/\.\.\/\.\.\/sidepanel\//g, './');
        html = html.replace(/\.\.\/\.\.\/chunks\//g, '../chunks/');
        html = html.replace(/\.\.\/\.\.\/assets\//g, '../assets/');
        writeFileSync(panelDestHtml, html);
      }

      // Move editor HTML from src/editor/ to editor/
      const editorSrcHtml = resolve(dist, 'src/editor/editor.html');
      const editorDestDir = resolve(dist, 'editor');
      const editorDestHtml = resolve(editorDestDir, 'editor.html');
      if (existsSync(editorSrcHtml)) {
        if (!existsSync(editorDestDir)) mkdirSync(editorDestDir, { recursive: true });
        let html = readFileSync(editorSrcHtml, 'utf-8');
        html = html.replace(/\.\.\/\.\.\/editor\//g, './');
        html = html.replace(/\.\.\/\.\.\/chunks\//g, '../chunks/');
        html = html.replace(/\.\.\/\.\.\/assets\//g, '../assets/');
        writeFileSync(editorDestHtml, html);
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

      // Directories: chunks/, assets/, sidepanel/, editor/
      for (const dir of ['chunks', 'assets', 'sidepanel', 'editor']) {
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
      // content.ts CSS imports are handled by esbuild (bundleContentScript plugin),
      // not Rollup — mark them external to prevent Rollup from failing on them.
      external: (id, importer) => importer === contentEntry && id.endsWith('.css'),
      input: {
        'service-worker': resolve(__dirname, 'src/service-worker.ts'),
        interceptor: resolve(__dirname, 'src/interceptor.ts'),
        content: resolve(__dirname, 'src/content.ts'),
        'sidepanel/sidepanel': resolve(__dirname, 'src/sidepanel/sidepanel.html'),
        'editor/editor': resolve(__dirname, 'src/editor/editor.html'),
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
