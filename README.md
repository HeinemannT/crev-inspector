# CREV Inspector

Chrome MV3 extension that overlays technical metadata on the Corporater BMP web portal — reveals RIDs, types, business IDs, and code properties that are normally hidden.

## Install

1. Download or clone this repo
2. Open `chrome://extensions` in Chrome
3. Enable **Developer mode** (top right)
4. Click **Load unpacked** and select this directory

## Features

- **Inspect mode** (Ctrl+Shift+X) — highlights all BMP objects on the page with overlay badges showing RID, type, business ID
- **Side panel** — click the extension icon to open. Five tabs: Connect, Objects, Page, Script, Log
- **Connect tab** — configure BMP server profiles (URL + credentials) for live property lookups and EC execution
- **Objects tab** — browse all discovered objects with search, type filters, sort, pinned favorites, and history
- **Page tab** — shows current BMP page context, detection confidence, and widget list
- **Script tab** — full CodeMirror 6 editor for Extended Code with syntax highlighting, completions, hover docs, line numbers, and Tab indentation. Ctrl+Enter to preview, Shift+Ctrl+Enter to execute
- **Detail view** — click any object to see identity, properties, and script blocks with inline Preview/Run/Editor
- **Paint Format** — copy visual formatting (headerColor, fontColor, transparency, shadow, headerStyle, borderStyle) between BMP objects. Pick source, click targets to apply
- **Editor windows** — full-screen CodeMirror 6 EC editor per object (from detail view or context menu)
- **Extended Code window** (Ctrl+Shift+E) — standalone EC console with page context auto-detected from URL
- **Object View** — dedicated window showing full object properties, template info, and children
- **Diff** — compare properties between two objects or an object and its template
- **Code Search** — search EC scripts across the BMP object tree
- **Context menu** — right-click any inspected object for Copy RID/ID/Name, View Properties, Open Editor, Compare, Search Code
- **Profile switcher** — quick-switch between server profiles via header dropdown
- **Technical overlay** — additional detail overlay mode for inspected elements

## Development

```bash
npm install
npm run build    # production build → copies to repo root for Chrome
npm run clean    # remove built artifacts
npm run dev      # watch mode
npm test         # unit tests (182 specs)
```

After changes, click reload on `chrome://extensions`.

## Architecture

```
src/
├── content.ts              # Content script: DOM scanning, overlays, badges, paint mode
├── content-overlay.css     # Injected styles for overlays and paint banner
├── interceptor.ts          # Network interceptor for BMP detection
├── service-worker.ts       # Background SW: state, ports, commands, context menus
├── lib/                    # Shared modules
│   ├── types.ts            # All message types, BmpObject, settings, paint types
│   ├── message-router.ts   # Unified message handler for content/panel/one-shot
│   ├── paint.ts            # Paint Format: pick source, compare, apply via EC
│   ├── bmp-client.ts       # BMP bridge client (EC execution, property CRUD)
│   ├── connection.ts       # Health polling, auth testing
│   ├── detection.ts        # BMP page detection logic
│   ├── enrichment.ts       # Server-side badge enrichment
│   ├── editor.ts           # Editor/Extended window launcher
│   ├── object-cache.ts     # In-memory object cache with persistence
│   └── ...                 # History, favorites, settings, tab awareness
├── sidepanel/
│   ├── sidepanel.ts        # Main orchestrator: render, tabs, message routing
│   ├── sidepanel.css       # M3 dark theme styles
│   ├── state.ts            # Shared mutable state
│   ├── detail-view.ts      # Object detail view with scripts and EC execution
│   ├── script-cm.ts        # CodeMirror 6 integration for script tab
│   ├── profile-switcher.ts # Quick profile switching overlay
│   └── tabs/               # Tab renderers (connect, objects, page, script, log)
├── editor/                 # Standalone EC editor window
│   └── ec/                 # EC language support (grammar, highlighting, completions, hover)
├── codesearch/             # Code search window
├── diff/                   # Object diff window
└── objectview/             # Object view window
```

Build outputs to `dist/`, then a Vite plugin copies artifacts to the repo root (Chrome loads the extension directly from the repo).
