# CREV Inspector

CREV Inspector is a Chrome side-panel extension for inspecting and changing Corporater BMP without opening Configuration Studio. It labels the objects rendered on a BMP page, opens their real configuration, edits code, and stages visual layout changes.

## Install

1. Download `crev-inspector-x.y.z.zip` from [Releases](https://github.com/HeinemannT/crev-inspector/releases/latest) and unzip it into a stable folder that you will reuse for updates.
2. Open `chrome://extensions/` (Edge: `edge://extensions/`) and enable **Developer mode**.
3. Click **Load unpacked** and select the unzipped folder.
4. Pin CREV Inspector and open your BMP workspace.

Current Chromium browsers are supported (Chrome or Edge 114+).

### Update an unpacked installation

Replace the contents of that same stable folder with the new release, then click **Reload** for CREV Inspector on `chrome://extensions/` (Edge: `edge://extensions/`). Keep the folder path unchanged; loading each release from a different versioned folder creates a separate unpacked installation.

## Connect to BMP

Add the workspace URL under **Connect**, approve Chrome's site-access prompt, and choose the identity used for Configuration Studio commands:

- **Use browser login** runs commands as the user signed into the BMP page and supports SSO.
- **Use stored configuration login** obtains an independent BMP command ticket. The website stays signed in as the portal user, while configuration reads and writes run as the stored account.

Connect shows the verified **Portal** and **Commands** identities separately. Workspace search, live CVO data, downloads, page navigation, and visible portal content retain the portal identity. Configuration lookup, Extended Code, property saves, Paint, and Blueprint use the command identity. A stored command account does not broaden what portal search or live data can see.

## Inspect objects

Turn on **Inspect** from the header or press `Ctrl+Shift+X`. CREV outlines rendered BMP objects and adds a type-coloured ID pill.

<p align="center">
  <img src=".github/readme/inspect-object.png" width="980" alt="A BMP widget outlined by Inspect with its object pill, flow action, and hover card">
</p>

| Gesture | Result |
|---|---|
| Click | Open the object in the side panel; copy buttons copy the primary ID (template when available) |
| Double-click | Open the quick inspector |
| Alt-click | Copy the RID |
| Shift-click | Copy the concrete instance ID |
| Ctrl-click | Copy an instance reference such as `t.some_id` |
| Right-click an element | Use it as the current context |

The object view groups what you can do:

- **Code** lists direct and referenced code properties. Click **Edit** to open the correct editor.
- **Structure** shows parents, children, linked objects, siblings, and supported action or input flows.
- **Info** shows the template ID first when known, while retaining the instance ID, RID, web link, access test, and favourite action.
- **Template / This instance** chooses where a supported property or name change is saved. The instance remains available as an explicit target.

Use the pencil beside a supported object name to rename it. CREV asks for confirmation before saving.

## Edit Extended Code, HTML, and CVOs

The Extended Code editor opens from a code property or with `Ctrl+Shift+E`. It provides EC syntax highlighting, completion, hover documentation, linting, folding, runtime errors, and object-aware suggestions for `t.<id>` references and inferred variables.

<p align="center">
  <img src=".github/readme/extended-code-properties.png" width="920" alt="Extended Code editor with inferred variables and type-specific properties">
</p>

Use **Preview** (`Ctrl+Enter`) before **Run** (`Ctrl+Shift+Enter`). Run stays gated until the current code previews successfully. The lower panel shows structured output, tracked variables, run history, timings, and safe HTML or JSON views when the output supports them.

Text and CVO properties open in their dedicated studios:

- **Text/HTML** previews the stored HTML in an inert, sanitized frame.
- **CVO Studio** edits HTML and JavaScript side by side, supplies live CVO data, manages inputs and hosted resources, and runs the preview in a separate sandbox.

## Rebuild a page in Blueprint

Press `Ctrl+Shift+B` to place Blueprint over the live page. Choose **Template** or **This instance**, then work with the structure BMP actually renders.

<p align="center">
  <img src=".github/readme/blueprint-page.png" width="1000" alt="Blueprint Style mode over a page with an input panel, two chart columns, and a full-width table">
</p>

Blueprint supports:

- adding, moving, reordering, resizing, renaming, and removing supported tabs, containers, and widgets
- editing layout and visual properties without leaving the page
- following InputView to InputSet and CreateObjectView to EditPage
- creating and linking a missing InputSet or EditPage
- inspecting action menus and supported flow chains in place

Changes remain staged. The counter, undo, redo, and discard controls operate on the draft. **Apply** first shows the affected objects, then asks for confirmation before it writes to BMP.

### Edit pages

<p align="center">
  <img src=".github/readme/blueprint-edit-page.png" width="720" alt="Edit Page Blueprint showing three pages, two columns, information blocks, and multiple field types">
</p>

Edit Page Blueprint follows page navigation, page breaks, columns, field order, and the configured form width. Move fields within or between columns and pages, add supported elements, and edit field properties while seeing the rendered form structure.

A CreateObjectView can select an existing EditPage or stage a new one. New EditPages inherit the object class needed to configure their fields immediately.

## Find references, code, and differences

- **Browse** searches by name, type, template ID, instance ID, or RID. Live hits are enriched with both reusable-template and concrete-instance identity when available.
- **Code Search** scans Extended Code across the workspace and opens the exact source property.
- **References** answers "Who references this?" from the current object.
- **Diff** compares RID to RID, instance to template, or two `namespace.businessId` references.

## Use the optional AI assistant

Configure a provider under **Connect → AI Assistant → Set up**. CREV supports Anthropic, OpenAI, DeepSeek, Grok, and custom compatible endpoints.

Use the assistant to:

- explain the selected object, its properties, references, and place in the page
- trace supported widget and action flows
- find workspace objects and return them as hoverable, clickable object chips
- explain, draft, or revise Extended Code using the current editor context
- work through HTML, CVO, and JSON transformation problems

The assistant can inspect workspace context, but code changes remain proposals until you review and save them.

## Shortcuts

| Default | Action |
|---|---|
| `Ctrl+Shift+Y` | Toggle the side panel |
| `Ctrl+Shift+X` | Toggle Inspect |
| `Ctrl+Shift+E` | Open the Extended Code editor |
| `Ctrl+Shift+B` | Toggle Blueprint |

Rebind shortcuts at `chrome://extensions/shortcuts`.

## Privacy

See the [privacy policy](PRIVACY.md) for the data the extension handles and where it is sent.

## License

CREV Inspector is proprietary software. Source availability does not grant permission to use, copy, modify, or redistribute it. See [LICENSE](LICENSE) and [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

## Data and security

- Borrowed tokens and independent command tickets live in `chrome.storage.session` and disappear when the browser closes.
- Stored passwords and AI keys are AES-GCM encrypted in `chrome.storage.local`.
- Stored command login uses BMP's legacy direct-login route over the configured HTTPS connection. BMP places those credentials in that request's query string; use HTTPS and ensure server/proxy access logs are appropriately protected.
- A borrowed token is separate from the token used by the BMP tab.
- HTTP profile URLs show a warning.
- **Reset all state** clears cache, logs, context, and history while keeping profiles and favourites.

## Development

```bash
npm install
npm run typecheck
npm run lint
npm test
npm run build
```

CI runs the same four gates. A `v*.*.*` tag publishes the packaged extension after they pass.

For Chrome DevTools extension QA, run `npm run qa:devtools-package` once and
install the printed directory as an unpacked extension. Normal and watch builds
then refresh that same directory automatically; Chrome's **Reload** button
always picks up the newest successful local build. The Connect footer shows the
loaded build ID beside the manifest version; the same value is available as
`globalThis.__CREV_BUILD_ID__` in the service-worker console.
