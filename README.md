# CREV Inspector

Chrome extension for inspecting and working with the Corporater BMP web portal. Reveals hidden object metadata, lets you run Extended Code scripts, and browse object properties — all from within the browser.

## Install

1. Download or clone this repo
2. Open `chrome://extensions` in Chrome
3. Enable **Developer mode** (top right)
4. Click **Load unpacked** and select this directory

## Getting started

### Connect to your BMP server

Open the side panel (click the extension icon) and go to the **Connect** tab. Add a server profile with your BMP URL and credentials. Once connected, the extension can look up live object properties and run scripts.

The connection works through a local bridge that translates between the extension and BMP. The bridge handles authentication and routes two types of commands:

- **Lookup / tree commands** — read object properties, navigate parent-child relationships, search by business ID
- **Extended Code** — run EC scripts against any object in your workspace (preview results before saving)

### Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| **Ctrl+Shift+X** | Toggle inspect mode |
| **Ctrl+Shift+E** | Open Extended Code window (Chrome) |
| **Alt+Shift+E** | Open Extended Code window (Edge) |

> Edge reserves Ctrl+Shift+E for its sidebar, so Alt+Shift+E is used instead. To reassign shortcuts: `chrome://extensions/shortcuts` (Chrome) or `edge://extensions/shortcuts` (Edge).

## Features

### Inspect Mode

Toggle with **Ctrl+Shift+X** or the Inspect button in the side panel. Highlights all BMP objects on the page with colored badges showing their business ID, type abbreviation, and name.

- **Click** a badge to copy the business ID
- **Shift+Click** to copy the template business ID
- **Ctrl+Click** to copy the full namespace reference (e.g., `t.myTemplate`)
- **Double-click** to open the quick inspector popup (identity, code preview, favorite, full view)
- **EC button** on code-bearing objects (Extended, CVO, DashHTML) opens the editor

### Side Panel

Four tabs accessible from the extension's side panel:

#### Connect Tab
- Server profiles: add, switch, and manage BMP connections
- Connection status with auto-detection and health monitoring
- Settings: enrich mode (widgets / all), auto-detect toggle, save target (template / instance)

#### Objects Tab
- All discovered BMP objects in a searchable, sortable table
- Type filter chips for quick filtering
- Pinned favorites (star objects for quick access)
- Recent history (viewed, edited, painted, EC-executed)
- Per-object actions: copy ID (with shift/ctrl modifiers), search references
- Click any object to drill into the detail view

#### Page Tab (Webpage Inspector)
- BMP detection status with confidence percentage
- Context object display: shows the object set via right-click context menu
- Template tree: identity, properties, and expandable sub-objects
- Navigate to full detail view from any tree node

#### Log Tab
- Real-time activity feed (enrichment, lookups, EC executions, errors)
- Timestamped entries with severity levels

### Object Detail View

Click any object to see its full properties:

- **Identity**: type badge, name, business ID, RID, template business ID (with copy buttons)
- **Linked objects**: automatically resolves related objects:
  - **CreateObjectView** -> **EditPage** (via `editPage` property)
  - **InputView** -> **InputSet** (via `inputset` property)
- **Properties table**: all server-side properties with formatted values
- **Script blocks**: inline preview of expression/html/javascript/css code with preview and run buttons
- **Star/favorite** toggle for quick access

### Extended Code Editor

Full-featured code editor window for EC scripts:

- **CodeMirror 6** with EC syntax highlighting, autocompletion, hover docs, and linting
- **Preview** (Ctrl+Enter) — dry-run scripts, see output before committing
- **Run** (Ctrl+Shift+Enter) — execute transactionally (gated: preview must succeed first)
- **Save** (Ctrl+S) — write code back to the object's property on BMP
- **Template/Instance toggle** — switch between editing the template or instance code
- **Property tabs** — switch between expression, html, javascript, css
- **Override indicator** — shows when instance code differs from template
- **Bottom panel**: Output (with table rendering toggle), Variables, Snippets, History
- **Table preview** — EC output with box-drawing tables renders as HTML tables (toggleable)
- **History sparkline** — visual run history with timing and success/failure
- **Block matching** — highlights matching IF/ENDIF, forEach blocks
- **Fold regions** — collapse IF/ENDIF, forEach, and other block structures

### Extended Code Window

Standalone EC console (Ctrl+Shift+E) that auto-detects the current page context:

- Same editor features as the property editor
- Context-aware: knows which BMP object/page you're on
- Quick snippets for genEdit, children walk, property change, search

### Object View

Dedicated window showing comprehensive object details:

- Full property listing with template comparison
- Children tree navigation
- Code properties with syntax highlighting

### Diff

Compare properties between two objects side-by-side:

- Property-by-property diff with highlighting
- Template vs. instance comparison
- Launched via context menu: right-click two objects to compare

### Code Search

Search EC scripts across the BMP object tree:

- Full-text search through all expression/html/javascript properties
- Results grouped by object with match context
- Progress indicator during search
- Click results to navigate to the object detail view

### Paint Format

Copy visual formatting between BMP portal objects:

- **Pick** a source widget's style (click in pick mode)
- **Apply** to target widgets (click targets in apply mode)
- Transfers: headerColor, fontColor, transparency, shadow, headerStyle, borderStyle

### Context Menu

Right-click any inspected BMP object for quick actions:

- Copy RID / business ID / name
- View properties in side panel
- Open in EC editor
- Search code references
- Compare with another object (diff)

### Technical Overlay

Toggle in settings to show rich multi-line badges on objects:

- Type abbreviation + business ID
- Object name
- Truncated RID
- Up to 6 key properties inline

### Badge Enrichment

Badges are enriched from the BMP server automatically:

- **Version-aware**: uses EC `lookup()` on BMP 5.6.3+ or namespace references on older versions
- **Template ID**: always fetched regardless of BMP version
- **Caching**: enrichment results cached across page navigations
- **Incremental**: new objects enriched as they appear (mutation observer)

## Development

```bash
npm install        # install dependencies
npm run build      # build to dist/
npm run dev        # watch mode
npx vitest run     # run tests
```

## Updating

After downloading a new version, go to `chrome://extensions` and click the reload button on the CREV Inspector card.
