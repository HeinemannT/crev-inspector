# CREV Inspector — Design System

## Identity

**ctools-inspired minimal.** Dark only. Self-hosted Inter (body) + system monospace (code). Catppuccin Mocha for the EC editor (base aligned to extension surfaces). Purple accent `#ba0ffe` sparingly — primary actions, active states, never decoration. Phosphor Bold icons (12px). Comfortable density.

A branded utility tool — professional, breathable, premium. Not a debug tool, not a prototype.

## Foundations

### Color Tokens

Single file: `src/styles/tokens.css`. No duplication. Every color referenced by variable, never hardcoded.

```
Surface scale (darkest → lightest):
  --surface-0:    #111111    page background
  --surface-1:    #1a1a1a    panels, sidepanel body
  --surface-2:    #252525    cards, elevated containers
  --surface-3:    #333333    hover states, active surfaces
  --surface-4:    #444444    borders, dividers (subtle)

Text scale:
  --text-1:       #e4e4e4    primary text (softened for reduced eye strain)
  --text-2:       #b0b0b0    secondary text, labels
  --text-3:       #707070    muted text, hints, timestamps
  --text-disabled:#505050    disabled text

Accent:
  --accent:       #ba0ffe    primary purple (buttons, active states, links)
  --accent-dim:   #8a3ffc    muted purple (badges, subtle indicators)
  --accent-bg:    #2a1a3e    purple background tint (selected rows, active tabs)

Semantic:
  --success:      #42be65    green (connected, ok, passed)
  --warning:      #f1c21b    yellow (warnings, caution)
  --danger:       #fa4d56    red (errors, destructive actions, failed)
  --info:         #78a9ff    blue (informational)

Type badge colors (kept from BMP type system):
  --type-org:     #4589ff
  --type-sc:      #08bdba
  --type-tbl:     #33b1ff
  --type-cvo:     #be95ff
  --type-page:    #42be65
  --type-risk:    #fa4d56
  etc. (existing TYPE_COLORS in types.ts — these stay)

Overlay-specific (for content injection):
  --overlay-bg:   rgba(0, 0, 0, 0.6)     badge background
  --overlay-glass:rgba(255, 255, 255, 0.08) glass tint
  --overlay-border:rgba(255, 255, 255, 0.12) subtle border
```

### Typography

```
Font stacks:
  --font-body:    'Inter', system-ui, -apple-system, sans-serif  (self-hosted woff2, 4 weights)
  --font-mono:    'SF Mono', 'Cascadia Code', Consolas, ui-monospace, monospace  (system only)

Inter is self-hosted (src/assets/fonts/, 96KB total for 400/500/600/700).
No CDN dependency — works offline. No custom mono font — system fonts are excellent at 10-11px.

Size scale (4px-based):
  --text-xs:      10px    badges, timestamps, meta
  --text-sm:      11px    secondary labels, table cells
  --text-base:    12px    body text, inputs, buttons
  --text-lg:      13px    section titles, toolbar labels
  --text-xl:      14px    page headings

Weight:
  --weight-normal:  400
  --weight-medium:  500
  --weight-semi:    600
  --weight-bold:    700

Line height:
  --leading-tight:  1.2    badges, compact rows
  --leading-normal: 1.4    body text
  --leading-relaxed:1.6    paragraphs, descriptions
```

### Spacing Scale (4px grid)

```
  --space-1:  4px     micro gaps (badge padding, icon margins)
  --space-2:  8px     standard gap (between elements, card padding)
  --space-3:  12px    section padding, group margins
  --space-4:  16px    panel padding, large gaps
  --space-5:  20px    page margins
  --space-6:  24px    section separators
```

### Border Radius

```
  --radius-sm:  2px     micro (tags, chips, inline badges)
  --radius-md:  4px     standard (buttons, inputs, cards)
  --radius-lg:  8px     containers (panels, tooltips, popovers)
```

2px is the signature radius — sharp but not harsh. Matches ctools.

### Elevation (Shadows)

```
  --shadow-1:   0 1px 2px rgba(0,0,0,0.3)                 badges, chips
  --shadow-2:   0 2px 8px rgba(0,0,0,0.4)                 dropdowns, tooltips
  --shadow-3:   0 4px 16px rgba(0,0,0,0.5)                popovers, modals
  --shadow-4:   0 8px 32px rgba(0,0,0,0.6)                windows, dialogs
```

### Transitions

```
  --duration-fast:    100ms    micro interactions (hover, focus)
  --duration-normal:  150ms    state changes (tab switch, toggle)
  --duration-slow:    250ms    entrance/exit (panels, toasts)

  --ease-default:     cubic-bezier(0.4, 0, 0.2, 1)  standard
  --ease-decelerate:  cubic-bezier(0, 0, 0.2, 1)    entrance
  --ease-accelerate:  cubic-bezier(0.4, 0, 1, 1)    exit
```

All animations respect `prefers-reduced-motion`:
```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
```

---

## Components

### Buttons

One base class, modifiers for variant and size.

```
.btn                    base: transparent bg, border, text-2 color
.btn-accent             accent border + text, fills accent on hover
.btn-danger             danger border + text, fills on hover
.btn-success            success border + text, fills on hover
.btn-small              text-xs, compact padding
.btn-wide               full-width, generous padding
```

All buttons: `border-radius: var(--radius-md)`, `transition: var(--duration-fast)`, `:focus-visible` ring.

### Inputs

```
.input                  surface-2 bg, surface-4 border, text-1 color
.input:focus            accent border, subtle accent glow
.input--invalid         danger border
.input--sm              text-sm, compact
```

Checkboxes: custom styled (not just `accent-color`). Toggle switches for boolean settings.

### Badges / Type Tags

```
.badge                  inline-flex, radius-sm, text-xs, weight-semi
.badge--type            colored bg from type system (existing colors)
.badge--status          success/warning/danger bg
.badge--count           surface-3 bg, text-3 color (numeric counts)
```

### Tables

```
.table                  full width, border-collapse
.table th               text-3, weight-semi, uppercase tracking
.table tr:hover         surface-3 bg
.table tr:nth-child(even) surface-1 bg (stripe)
.table td               text-base, text-2 color
```

Sticky headers. Horizontal scroll on overflow.

### Cards

```
.card                   surface-2 bg, surface-4 border, radius-md, space-2 padding
.card--elevated         shadow-2
.card--interactive      hover → surface-3, cursor pointer
```

### Toolbar

```
.toolbar                surface-1 bg, surface-4 border-bottom, space-2 padding
.toolbar__group         flex, gap space-1
.toolbar__spacer        flex: 1
.toolbar__label         text-sm, text-3, uppercase tracking
```

---

## Surfaces

### Side Panel

```
┌─ Header ─────────────────────────────────┐
│ ◈ CREV  ● Steadfast         [🎨] [▣]   │  surface-1, branded
├─ Tabs ───────────────────────────────────┤
│ Connect   Objects   Page   Log           │  horizontal, underline indicator
│              ━━━━━━━                     │  2px accent on active
├─ Status Strip ───────────────────────────┤
│ Connected · BMP 5.6.7 · 14ms            │  conditional, text-xs
├─ Content ────────────────────────────────┤
│                                          │  surface-0, scrollable
│  (tab content or detail view)            │  comfortable density
│                                          │  8-12px padding per row
├─ Status Bar ─────────────────────────────┤
│ ● Connected    Latest activity    [123]  │  surface-1, text-xs
└──────────────────────────────────────────┘
```

**Header:** `◈ CREV` tiny logo mark (12px icon) + brand text in text-3 (muted). Status dot + profile name in text-1. Paint and Inspect icon buttons right-aligned. Surface-1 bg, 1px border-bottom.

**Tabs:** Horizontal text tabs, full panel width. Active tab: text-1 color + 2px accent underline. Inactive: text-3 color. Font: text-sm, no uppercase (clean, not shouty). Phosphor icons inline at 12px for each tab (optional — text-only is cleaner at this width).

**Density:** Comfortable. 13px base text. 8-12px row padding. Generous gaps between sections. Breathable, premium feel.

### Overlay Badges (injected into BMP page)

```
  ┌──────────┐
  │  t.122   │  ← ID badge: glass bg, type-colored left border, text-xs
  └──────────┘
  [EC] [⌕]     ← action strip: surface-0/0.6 bg, radius-sm, micro buttons
```

Badge design:
- Background: `rgba(0,0,0,0.6)` with `backdrop-filter: blur(8px)` — glass effect
- Left border: 2px solid type-color (instead of full background fill)
- Text: white, text-xs, weight-semi
- No full-color background — too loud. The left border communicates type.

Action strip:
- Same glass bg, slightly darker
- Micro buttons (text-xs, 1px border, radius-sm)
- Visible but not prominent

### EC Editor Window

**Theme:** Catppuccin Mocha — warm dark with pastel syntax. Matches Cortex editor. The editor is the one surface that intentionally differs from the panel (slightly warmer, richer).

```
┌─ CM Container ───────────────────────────┐  Catppuccin Mocha: #1e1e2e bg
│                                          │  Keywords: #cba6f7 (mauve)
│  (editor with Catppuccin Mocha theme)    │  Strings: #f9e2af (yellow)
│                                          │  Methods: #89b4fa (blue)
├─ Toolbar ────────────────────────────────┤  surface-1, border-top
│ [Preview ▶] [Run ▶] [Save]  t.122·expr  │  Phosphor icons in buttons
│                          Ln 1, Col 1     │
├─ Drag Handle ────────────────────────────┤  surface-3, 2px height
├─ Bottom Panel ───────────────────────────┤  surface-1
│  (output / vars / snippets / history)    │
├─ Bottom Bar ─────────────────────────────┤  surface-0, border-top
│ ✕ Clear  ↩ Wrap    𝑥 Vars  {} Snip  ◔ H │  ghost buttons, Phosphor icons
└──────────────────────────────────────────┘
```

Toolbar and bottom panels use the panel token system (surface-0/1), not Catppuccin. Only the CodeMirror editing area uses Catppuccin. This creates a subtle visual distinction: "this is where you write code" vs "this is the tool chrome."

### Quick Inspector Popup (contextual mini-panel)

Double-click a badge → a preview card appears near the badge, showing identity + first properties + actions.

```
┌───────────────────────────────────────┐  surface-2, shadow-3, radius-lg
│ [TBL] Revenue Table              [★] │  type badge + name + star
│ t.122  →  tmpl t.100                 │  text-sm, mono, text-2
│ description: Revenue by region...    │  text-sm, text-3, truncated
├───────────────────────────────────────┤  1px border, surface-4
│ [⧉ Copy]   [✎ Editor]   [↗ View]   │  Phosphor icons + text, ghost buttons
└───────────────────────────────────────┘
```

Key differences from current:
- Shows 1-2 properties below identity (a preview, not just name/ID)
- Copy button uses unified copy strategy (shift/ctrl modifiers)
- Phosphor icons for actions instead of text-only buttons
- Star button moved to top-right (less prominent)
- Wider card: max-width 340px (from 320px)

---

## Implementation Architecture

### File Structure

```
src/styles/
  tokens.css          ← single source of truth for ALL tokens
  base.css            ← reset, typography, scrollbars, reduced-motion
  components.css      ← buttons, inputs, badges, tables, cards, toolbar

src/sidepanel/
  sidepanel.css       ← imports tokens + base + components, adds layout-specific styles

src/editor/
  editor.css          ← imports tokens + base + components, adds editor-specific styles

src/content-overlay.css ← imports tokens (via build), adds overlay-specific styles

src/objectview/objectview.css  ← imports tokens + components
src/diff/diff.css              ← imports tokens + components
src/codesearch/codesearch.css  ← imports tokens + components
```

Each page CSS file:
1. `@import` shared tokens + base + components
2. Add only layout-specific and page-specific rules
3. Zero token re-definitions
4. Zero inline styles in corresponding JS

### Migration Rules

1. **No `style.cssText` in TypeScript.** Use CSS classes + `setProperty('--var', value)` for dynamic values (type colors).
2. **No hardcoded hex colors in CSS.** Everything via `var()`.
3. **No `!important`.** Fix cascade with proper specificity or `:where()`.
4. **No duplicate token definitions.** One file, imported everywhere.
5. **Every interactive element gets `:focus-visible`.** Ring: `2px solid var(--accent)`, offset 2px.
6. **Every animation respects `prefers-reduced-motion`.**

### Inline Style Elimination

Current inline styles and their CSS replacements:

| File | Inline style | Replace with |
|------|-------------|--------------|
| `bmpObjectHover.ts` | 9× `style.cssText` | `.hover-tooltip`, `.hover-badge`, `.hover-rid` classes |
| `content-tooltip.ts` | `style: \`background:${color}\`` | `style.setProperty('--type-color', color)` + CSS `.crev-tt-type { background: var(--type-color); }` |
| `detail-view.ts` | `style: \`background:${color}\`` | Same pattern: CSS var for dynamic type color |
| `objectview.ts` | `style: \`background:${color}\`` | Same pattern |
| `quick-inspector.ts` | Hardcoded colors in `style.cssText` | CSS classes |

Dynamic type colors (which vary per object) use a single pattern:
```typescript
el.style.setProperty('--type-color', getTypeColor(obj.type));
```
```css
.type-badge { background: var(--type-color); }
```

---

## Accessibility

### Focus Management
- All interactive elements: `:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }`
- Tab order follows visual order
- Escape closes popovers/modals

### Reduced Motion
- Global rule disables animations when `prefers-reduced-motion: reduce`
- Shimmer loading replaced with static dim state
- Toast entrance/exit instant

### Contrast
- All text on surfaces meets WCAG AA (4.5:1 for normal text, 3:1 for large)
- `--text-3` (#707070) on `--surface-0` (#111111) = 4.7:1 ✓
- Danger/success/warning colors pass on dark surfaces

### Screen Reader
- Icon-only buttons get `aria-label`
- Status indicators get `aria-live="polite"`
- Tab bar uses `role="tablist"` / `role="tab"`

---

## What Changes Visually

### Before → After

**Side panel header:**
- Before: Anonymous `[dot] Profile Name [paint] [inspect]` — could be any tool
- After: `◈ CREV ● Steadfast [🎨][▣]` — branded utility, small logo mark, Phosphor icon buttons

**Side panel tabs:**
- Before: Full background fill on active tab, mixed padding, no clear hierarchy
- After: 2px accent underline, text-1/text-3 contrast, breathable spacing. Active state is subtle but clear.

**Overlay badges:**
- Before: Full type-colored opaque background — loud, dominates the page
- After: Glass `rgba(0,0,0,0.6)` + `backdrop-filter: blur(8px)` + 2px left border in type color. Subtle presence, the color accent tells the type without shouting.

**Quick inspector:**
- Before: Dark card with text buttons, just identity
- After: Contextual mini-panel: identity + 1-2 property previews + Phosphor icon action buttons. A real preview, not just a label.

**Buttons:**
- Before: 13+ variants, inconsistent padding and hover behaviors
- After: 6 variants from one base, Phosphor icons, consistent hover transitions, focus-visible rings

**Typography:**
- Before: 10-13px mixed, system-ui, no hierarchy
- After: Inter 13px comfortable base, Geist Mono for code, defined xs/sm/base/lg/xl scale

**Editor:**
- Before: One Dark theme (blue-tinted grays), inconsistent with panel
- After: Catppuccin Mocha (warm pastels), panel chrome stays in tool tokens. The editing area feels distinct — "this is where you write."

**Colors:**
- Before: M3 tokens defined 4 times + hardcoded hex + inline styles
- After: Single `tokens.css`, zero inline styles, zero hardcoded colors

**Density:**
- Before: Mixed — some areas cramped (10px), others spacious (14px). No system.
- After: Comfortable throughout — 13px base, 8-12px row padding, generous gaps. Breathable, premium.

**Icons:**
- Before: Unicode emoji (⭐, ✕, ⟳), system text, inconsistent sizes
- After: Phosphor icons — fill ≤12px, regular ≥13px. Consistent visual weight across all surfaces.

**Overall feel:**
- Before: "Dark theme prototype, 2023 — grew organically"
- After: "Branded precision tool, 2026 — comfortable, intentional, polished"
