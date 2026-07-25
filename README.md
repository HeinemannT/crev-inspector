# CREV Inspector

CREV Inspector is a Chrome side-panel extension for inspecting and changing Corporater BMP without opening Configuration Studio. It labels the objects rendered on a BMP page, opens their real configuration, edits code, and stages visual layout changes.

## Install

1. Download `crev-inspector-x.y.z.zip` from [Releases](https://github.com/HeinemannT/crev-inspector/releases/latest) and unzip it.
2. Open `chrome://extensions/` (Edge: `edge://extensions/`) and enable **Developer mode**.
3. Click **Load unpacked** and select the unzipped folder.
4. Pin CREV Inspector and open your BMP workspace.

Current Chromium browsers are supported (Chrome or Edge 114+).

## Connect to BMP

Sign in to BMP with an account that has Configuration Access (normally an administrator or configurator), then add the workspace URL under **Connect** and approve Chrome's site-access prompt. CREV normally borrows the active browser session; stored credentials are an optional fallback.

## Inspect objects

Turn on **Inspect** from the header or press `Ctrl+Shift+X`. CREV outlines rendered BMP objects and adds a type-coloured ID pill.

<p align="center">
  <img src="docs/images/inspect-object.png" width="980" alt="A BMP widget outlined by Inspect with its object pill, flow action, and hover card">
</p>

| Gesture | Result |
|---|---|
| Click | Open the object in the side panel |
| Double-click | Open the quick inspector |
| Alt-click | Copy the RID |
| Shift-click | Copy the template business ID |
| Ctrl-click | Copy a reference such as `t.some_id` |
| Right-click an element | Use it as the current context |

The object view groups what you can do:

- **Code** lists direct and referenced code properties. Click **Edit** to open the correct editor.
- **Structure** shows parents, children, linked objects, siblings, and supported action or input flows.
- **Info** shows the type, business ID, RID, web link, access test, and favourite action.
- **instance / template** chooses where a supported property or name change is saved.

Use the pencil beside a supported object name to rename it. CREV asks for confirmation before saving.

## Edit Extended Code, HTML, and CVOs

The Extended Code editor opens from a code property or with `Ctrl+Shift+E`. It provides EC syntax highlighting, completion, hover documentation, linting, folding, runtime errors, and object-aware suggestions for `t.<id>` references and inferred variables.

<p align="center">
  <img src="docs/images/extended-code-properties.png" width="920" alt="Extended Code editor with inferred variables and type-specific properties">
</p>

Use **Preview** (`Ctrl+Enter`) before **Run** (`Ctrl+Shift+Enter`). Run stays gated until the current code previews successfully. The lower panel shows structured output, tracked variables, run history, timings, and safe HTML or JSON views when the output supports them.

Text and CVO properties open in their dedicated studios:

- **Text/HTML** previews the stored HTML in an inert, sanitized frame.
- **CVO Studio** edits HTML and JavaScript side by side, supplies live CVO data, manages inputs and hosted resources, and runs the preview in a separate sandbox.

## Rebuild a page in Blueprint

Press `Ctrl+Shift+B` to place Blueprint over the live page. Choose **Template** or **This instance**, then work with the structure BMP actually renders.

<p align="center">
  <img src="docs/images/blueprint-page.png" width="1000" alt="Blueprint showing a three-page EditPage with two columns, information blocks, and multiple field types">
</p>

Blueprint supports:

- adding, moving, reordering, resizing, renaming, and removing supported tabs, containers, and widgets
- editing layout and visual properties without leaving the page
- following InputView to InputSet and CreateObjectView to EditPage
- creating and linking a missing InputSet or EditPage
- inspecting action menus and supported flow chains in place

Changes remain staged. The counter, undo, redo, and discard controls operate on the draft. **Apply** first shows the affected objects, then asks for confirmation before it writes to BMP.

### Edit pages

Edit Page Blueprint follows page navigation, page breaks, columns, field order, and the configured form width. Move fields within or between columns and pages, add supported elements, and edit field properties while seeing the rendered form structure.

A CreateObjectView can select an existing EditPage or stage a new one. New EditPages inherit the object class needed to configure their fields immediately.

## Find references, code, and differences

- **Browse** searches cached objects by RID, business ID, or name.
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

## Data and security

- Borrowed tokens live in `chrome.storage.session` and disappear when the browser closes.
- Stored passwords and AI keys are AES-GCM encrypted in `chrome.storage.local`.
- A borrowed token is separate from the token used by the BMP tab.
- HTTP profile URLs show a warning.
- **Reset all state** clears cache, logs, context, and history while keeping profiles and favourites.

The detailed [feature walkthrough](docs/walkthrough.html) covers the remaining controls and states.

## Development

```bash
npm install
npm run typecheck
npm run lint
npm test
npm run build
```

CI runs the same four gates. A `v*.*.*` tag publishes the packaged extension after they pass.
