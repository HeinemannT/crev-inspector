# CREV Inspector

Chrome extension that overlays technical metadata on the Corporater BMP web portal — reveals RIDs, types, business IDs, and code properties that are normally hidden.

## Install

1. Download or clone this repo
2. Open `chrome://extensions` in Chrome
3. Enable **Developer mode** (top right)
4. Click **Load unpacked** and select this directory

## Usage

- **Ctrl+Shift+X** — toggle inspect mode (highlights all BMP objects on the page)
- **Side panel** — click the extension icon to open. Tabs: Objects, Page, Script, Log
- **Connect tab** — configure BMP server URL + credentials for live property access
- **Click any object** — drills into detail view with identity, properties, and scripts
- **Editor** — click Editor on a script block to open a full CodeMirror 6 EC editor
- **Paint** — copy visual formatting (colors, shadow, border) between BMP objects

## Development

```bash
npm install
npm run build    # production build
npm run dev      # watch mode
npm run test     # unit tests
```

After changes, click reload on `chrome://extensions`.
