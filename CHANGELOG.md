# Changelog

## 0.12.0 — 2026-04-02

### Upgrade Package

#### Enrichment
- **Version-aware `batchEnrich`** — uses `resolveRef()` internally, returns `templateBusinessId` on all BMP versions (removed binary-only fallback path)
- **Simplified enrichment pipeline** — removed `useEc` routing branch, always uses single `batchEnrich` code path

#### Badge System
- **Shift-click template copy** — works on all BMP versions; shows "No template" with dimmed badge when unavailable
- **Badge tooltip** — shows copy modifier hints (click/shift/ctrl/double-click)
- **Search button removed from badges** — moved to Objects tab; badges show EC button only for code-bearing types
- **Dead CSS cleanup** — removed `.crev-action-btn` class

#### Objects Tab
- **Search references button** — per-row magnifying glass icon next to copy button, sends `SEARCH_REFERENCES`

#### Editor Readability Overhaul
- **Font sizes bumped** — output, toolbar, bottom bar, tables all increased from `--text-xs` (10px) to `--text-sm`/`--text-base`
- **Contrast improved** — `--text-muted` (#707070, 3.5:1) replaced with `--text-secondary` (#b0b0b0, 7:1) throughout editor
- **Property tabs and target toggle** — inactive state bumped from muted to secondary
- **Drag handle** — increased visibility (opacity 0.4→0.5, color bumped)

#### Table Preview
- **Toggle button** — "Table" button in editor bottom bar, defaults ON, renders box-drawing tables as HTML
- **Unclosed table handling** — partial EC output flushes accumulated rows
- **Cell improvements** — hover title on `<td>`, empty cells render as non-breaking space

#### Tab Emptying Fix
- **Page tab** — `activate()` no longer clears data before requesting fresh
- **Objects tab** — `CACHE_DATA` guard prevents empty response from wiping list
- **Sidepanel render guard** — `document.body.contains(panel)` check before rendering

#### Webpage Inspector (replaces Page tab)
- **Context object** — shows identity, location breadcrumb (namespace root path), and properties
- **Template tree** — lazy-loaded children via `FETCH_CHILDREN`, expandable properties per node
- **Widgets list** — retained from old Page tab, shows detected page widgets
- **Detection card** — compact BMP detection status
- **Context RID lifecycle** — cleared on page navigation, extracted to `context-rid.ts` module
- **FULL_LOOKUP parallelized** — object lookup + template resolution run concurrently
- **Template children** — tree shows template's children (config hierarchy), not instance's

#### Keyboard Shortcuts
- **Edge compatibility** — `Alt+Shift+E` for Extended Code window on Windows (Edge reserves `Ctrl+Shift+E`)

#### Code Quality
- **Shared `formatValue()`** — extracted from detail-view.ts and page-tab.ts into utils.ts
- **18 new tests** — shift-click fallback, CACHE_DATA guard, batchEnrich error path, context-rid module, page tab message handling (race conditions, stale responses)

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
