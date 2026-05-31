# CREV Inspector

A Chrome side-panel extension for working with **Corporater BMP** the way developers want to, not the way the stock UI allows. Every BMP widget on the page gets a coloured pill showing its real ID. Click it to open a typed property editor, an Extended Code workbench, or a layout reorder tool. No round-trip through Config Studio.

<p align="center">
  <img src="https://github.com/user-attachments/assets/a12828c4-97be-4d9d-94e4-505e6f05067c" width="540" alt="Type-pill overlay on a BMP scorecard">
</p>

> Full feature walkthrough (what it is, install, how it works, every feature): [`docs/walkthrough.html`](docs/walkthrough.html) — open in a browser.

## Features

- **Type-pill overlay.** Every widget on the BMP page gets a coloured ID badge. Click to open it in the side panel, double-click for a quick inspector, right-click to set context.
- **Object inspector.** Type-aware detail view covering identity, properties, references, code fields, and flow chain. Edits flow back to BMP via Extended Code.
- **Extended Code editor.** Floating CodeMirror window for any EC-bearing property, with preview / execute, run history, tracked variables, hover docs, inline runtime errors, and syntax help. The Vars + Properties panel infers the type of every `_v := SELECT X` and lets you click to insert any property.
- **Layout editor.** Drag tabs and containers to reorder, resize by dragging, preview the grid at L/M/S breakpoints, and jump from a preview cell to its tree row and back.
- **Diff & compare.** Pick any two objects (RID vs RID, instance vs template, or `ns.bid` references) and see exactly which properties changed.
- **Multi-window + profiles.** Per-window inspect state, panel routing, and per-server profiles that auto-switch on the BMP URL prefix.

## Install

Download `crev-inspector-x.y.z.zip` from [Releases](https://github.com/HeinemannT/crev-inspector/releases) and unzip it. Open `chrome://extensions/`, turn on **Developer mode**, choose **Load unpacked**, and pick the unzipped folder. Pin it to the toolbar. The Connect tab shows a banner when a new version is available.

## Shortcuts

| Default | Action |
|---|---|
| `Ctrl+Shift+Y` | Toggle side panel (this window) |
| `Ctrl+Shift+X` | Toggle inspect overlays (this window) |
| `Ctrl+Shift+E` | Open Extended Code editor |

Rebind at `chrome://extensions/shortcuts`.

## Pill click modifiers

| Click | Result |
|---|---|
| Plain | Open in side panel |
| Double-click | Quick inspector |
| Alt-click | Copy RID |
| Shift-click | Copy template business ID |
| Ctrl-click | Copy `t.someBid` reference |

## Gallery

<table>
  <tr>
    <td width="50%" align="center">
      <img src="https://github.com/user-attachments/assets/e9800091-843d-4c5f-b556-c80a4595e34f" width="320" alt="Object inspector">
      <br><sub><b>Object inspector</b>: typed property editor in the side panel</sub>
    </td>
    <td width="50%" align="center">
      <img src="https://github.com/user-attachments/assets/a262acab-b346-4f11-a097-c9f1c1774178" width="420" alt="Extended Code editor with Vars + Properties panel">
      <br><sub><b>Extended Code editor</b>: Vars panel plus click-to-insert properties</sub>
    </td>
  </tr>
  <tr>
    <td colspan="2" align="center">
      <img src="https://github.com/user-attachments/assets/a6493475-9e46-43ba-8338-929643e35865" width="640" alt="Extended Code preview / execute">
      <br><sub><b>Preview &amp; execute</b>: dry-run, output panel, run history</sub>
    </td>
  </tr>
  <tr>
    <td colspan="2" align="center">
      <img src="https://github.com/user-attachments/assets/c8e00440-86cb-4bca-8a02-c2fa5600d72c" width="720" alt="Diff &amp; compare">
      <br><sub><b>Diff &amp; compare</b>: side-by-side property comparison</sub>
    </td>
  </tr>
</table>

## Security

Passwords are AES-GCM encrypted at rest in `chrome.storage.local`. HTTP profile URLs trigger an inline warning. "Reset all state" wipes the cache, log, and history while keeping profiles and favourites.

## Development

```bash
npm install
npm run build           # outputs to dist/ and mirrors to the repo root for "Load unpacked"
npm run dev             # vite watch
npx vitest run
```

Pushing a `v*.*.*` tag triggers `.github/workflows/release.yml`, which runs verify, test, build, package, and release.
