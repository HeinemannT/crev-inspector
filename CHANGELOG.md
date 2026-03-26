# Changelog

## 0.12.0 — 2026-03-26

### Design System
- **Self-hosted Inter font** — 4 weights (96KB), no CDN dependency, works offline
- **System monospace** — SF Mono / Cascadia Code / Consolas (no custom mono font)
- **Catppuccin Mocha editor theme** — replaces oneDark, base aligned to extension surfaces (#1a1a1a)
- **21 Phosphor Bold icons** — centralized in `src/lib/icons.ts`, replaces all emoji/unicode icon buttons
- **Unified button system** — `.btn-accent/danger/success/small/wide` in components.css, single source
- **Token-based font sizes** — all sidepanel/editor font sizes use `var(--text-xs)` through `var(--text-xl)`
- **Softer text-1** — #e4e4e4 (from #f0f0f0) for reduced eye strain
- **Subtle outline** — 1px at 35% opacity with rounded corners (from 2px solid)
- **Glass badge flash** — backdrop-filter disabled during copy/pick feedback for clear color
- **Type-tinted detail headers** — subtle gradient in object's type color (8% opacity)
- **WCAG-compliant tab badges** — surface-4/text-1 meets AA contrast at 10px
- **Proper disabled buttons** — filled surface + text-disabled + cursor not-allowed (from opacity hack)

### Features
- **Code preview in Quick Inspector** — first 2 lines of expression, faded with gradient mask
- **EC syntax comments** — tuned to Catppuccin overlay0 (#6c7086) for readability on warm background

### Architecture
- **Router-level settingsReady gate** — all handlers guaranteed loaded settings on SW wake
- **rebuildClient serialization** — prevents concurrent profile switch races
- **Cache profile isolation** — switching guard prevents cross-profile data leaks
- **Cache flush after enrichment** — survives SW suspension
- **Panel message queue** — 6 critical message types buffered during port disconnect
- **Health timer idempotent restart** — survives SW suspension
- **Settings save serialization** — prevents lost concurrent writes
- **Panel reconnect robustness** — removed getURL check that failed on suspended SW

### Bug Fixes
- Duplicate `type` key in HOVER_LOOKUP/RESOLVE responses (message discriminant overwritten)
- Destructured `label` shadowing in content overlay copy handler
- Legacy --md-* token references fully removed (252 → 0)
- Dead CSS classes removed (kv-table, unused BEM button variants)
- Off-palette colors aligned to token system

### Removed
- `@codemirror/theme-one-dark` dependency
- Google Fonts CDN import
- Geist Mono from font stack
- All emoji/unicode icon characters

## 0.11.2

### Features
- Enterprise template resolution (.template fallback for CeIssue, CeRiskAssessment, etc.)
- Namespace-aware resolveRef (pre-5.6.3 support for 80+ className→prefix mappings)
- BMP object hover in EC editor (lookup(RID), ns.bid patterns)
- Structured EC output (color-coded lines, table detection)
- History sparkline, variables panel, version-aware snippets
- Reference search ("Who references this?")
- Linked object badges (InputView→InputSet, CreateObjectView→EditPage)
- Unified copy strategy (click=ID, shift=template, ctrl=namespace.ref)

### Architecture
- 4-phase refactor: ContentState, Tab components, handler registry, message router
- Password encryption at rest (AES-GCM)
- Session snapshots for instant panel boot
