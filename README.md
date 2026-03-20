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
| **Ctrl+Shift+E** | Open Extended Code window |

> If a shortcut doesn't work, reassign it at `chrome://extensions/shortcuts`.

## What you can do

- **Inspect mode** — highlights all BMP objects on the page with badges showing their RID, type, and business ID
- **Side panel** — browse discovered objects, search and filter by type, pin favorites, view history
- **Object detail** — click any object to see its identity, properties, and script blocks
- **Extended Code editor** — full editor with syntax highlighting, autocompletion, and hover docs. Run scripts with Ctrl+Enter
- **Extended Code window** — standalone EC console that auto-detects the current page context
- **Object View** — dedicated window showing full properties, template info, and children
- **Diff** — compare properties between two objects, or an object and its template
- **Code Search** — search EC scripts across the BMP object tree
- **Paint Format** — copy visual formatting between BMP objects (colors, borders, shadows)
- **Context menu** — right-click any inspected object to copy RID/ID/name, view properties, open editor, compare, or search code

## Updating

After downloading a new version, go to `chrome://extensions` and click the reload button on the CREV Inspector card.
