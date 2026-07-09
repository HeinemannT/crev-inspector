# CREV Inspector — agent notes

## What this is

A Manifest V3 Chrome/Edge extension (TypeScript, vanilla DOM + CodeMirror 6, no framework)
that overlays technical metadata — object IDs, widget types, layout structure — on the
Corporater BMP web portal, and gives developers a side-panel toolkit (property editor,
Extended Code workbench, layout/Blueprint editor) instead of round-tripping through Config
Studio. See `ARCHITECTURE.md` for the component map and message-passing details.

## Build / test / run

- `npm run build` — Vite build. `closeBundle` in `vite.config.ts` then copies the built
  `content.js`, `service-worker.js`, `interceptor.js` and per-window bundle dirs from `dist/`
  back to the **repo root**, next to the source `manifest.json` and `icons/`. Load-unpacked
  target in `chrome://extensions` is the **repo root**, not `dist/`.
- `npm test` — `vitest run`. Fast, no live BMP needed. **Excludes integration tests**
  (`vitest.config.ts` has `exclude: ['src/**/integration/**']`).
- `npm run test:integration` — separate suite (`vitest.integration.config.ts`) covering the
  wire-protocol round-trip against a **live BMP**. Not run by `npm test` or CI's default gate;
  don't assume the binary protocol is exercised unless this was run explicitly.
- `npx tsc --noEmit` — typecheck. `tsconfig.json` is `strict: true`, `noUnusedLocals: true`.
- `npm run lint` — `eslint src` (flat config, `eslint.config.js`). Async-safety rules
  (`no-floating-promises`, `no-misused-promises`) are `warn`-only pending a ratchet to `error`
  with `--max-warnings 0`. CI runs this step (`.github/workflows/ci.yml`).

## Invariants that bite

- **BMP rids are Java `long` (64-bit)** — they exceed `Number.MAX_SAFE_INTEGER`. Always treat
  them as strings in TS/JS, never numbers (see how `src/studio/dep-detect.ts` extracts them).
- **No `content_scripts` key in `manifest.json`** (`grep -c content_scripts manifest.json` → 0).
  The extension ships with zero host permissions; nothing is injected until a site is granted
  (`src/lib/site-access.ts`). Once granted, `content.js` (ISOLATED, `document_idle`) and
  `interceptor.js` (MAIN world, `document_start`) are registered dynamically via
  `chrome.scripting.registerContentScripts` for that origin's future page loads, plus an
  immediate `chrome.scripting.executeScript` into the tab that was just granted. SW-restart /
  inspect-activation re-injection goes through `ensureContentScript()`
  (`src/lib/content-script-injection.ts`).
- **Release tag must match `manifest.json` version.** Pushing `v*.*.*` triggers
  `.github/workflows/release.yml`, which hard-fails if the tag's base version (suffix stripped)
  doesn't equal `manifest.json.version`. Bump the manifest and tag together.
- **Integration tests are the only check on the wire-protocol contract** and require
  `CREV_INTEGRATION=1` + a live BMP — `npm test` alone gives no signal on that path.
- **Credential-at-rest is obfuscation, not confidentiality.** Stored passwords are AES-GCM
  encrypted (`src/lib/crypto.ts`), but the key is derived from `chrome.runtime.id` — the
  extension's public ID — so it stops casual disk inspection, not someone with the storage
  dump. Minted auth tokens (JWT/refresh) live only in `chrome.storage.session`
  (`src/lib/bmp-auth.ts`), cleared when the browser closes.
- **Overlay positioning lives inline, not in the stylesheet.** Injected elements
  (`.crev-outline`, `.crev-label`, toast, tooltip, paint banner, snap-ghost, the floating
  editor host) set their critical `position`/`z-index` inline in JS — the CSS files are
  cosmetic only. A broken comment in `content-overlay.css`/`content-blueprint.css` has
  silently dropped these into page flow before; `src/lib/__tests__/css-integrity.test.ts`
  locks the load-bearing rules against that regression.
- Public repo — no secrets in commits.

## Where knowledge lives

- `ARCHITECTURE.md` — component map, message-passing catalog, content-script lifecycle.
  (Local file, gitignored under "Internal docs" — not in the public repo history.)
- `BUGS.md` — known bugs / backlog, newest on top.
- `docs/blueprint.md` — Blueprint (layout builder) architecture, safety model, e2e test rig.
- `docs/cvo-dev-handover.md` — using this extension as a CVO development tool.
- `plans/` — advisor-generated implementation plans for specific improvements.
