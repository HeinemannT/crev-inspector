# Blueprint mode — the in-browser layout editor

Blueprint mode restructures a live BMP page's layout visually — add / resize / rename / move / swap /
delete widgets, manage tabs — previews the exact changes, and commits them to BMP behind safety
guards. It renders an opaque, model-driven wireframe over the page; **geometry comes from the DOM,
every label and edit from a model**.

Works on any **page host**: Scorecard, ModelPage, and enterprise objects (CeIssue/CePolicy/… — the
edit retargets to the linked EnterpriseTemplate). See `skills/bmp-platform/reference/page-hosting.md`.

Toggle it: the sidepanel "⧉ Blueprint" button, the `BLUEPRINT_TOGGLE` message, or **Ctrl+Shift+B**
(`toggle-blueprint` command → `toggleBlueprint()` in handlers/layout.ts). Blueprint and inspect mode
are mutually exclusive — turning one on turns the other off.

## Architecture — functional core / imperative shell / UI

Standalone Edit Pages use the same safety and apply pipeline but a different projection. On a BMP
create/edit route, Blueprint targets the exact rendered `EditPage`, reads only its direct ordered
children, and projects the flat `EditPageBreak` / `EditPageColumnBreak` stream into the step
navigation and responsive form columns BMP actually shows. No nested hierarchy is invented.

```
src/lib/layout/            PURE CORE (no I/O, no DOM) — unit-tested
  types.ts                 LNode / LModel / PlanStep / PageClass
  model.ts                 reconstruct(wire → LModel), tree helpers, owner = container ?? parent
  edit.ts                  pure (model,…) → model ops: resize/setHeight/rename/move/moveInto/swap/
                           insertRelative/add*/remove (immutable — every op returns a NEW model)
  diff.ts                  diff(baseline, desired) → ordered PlanStep[] (create→update→reparent→reorder→delete)
                           + summarizeChanges(plan, desired) → { changes, actions } (logical vs raw EC count)
  ec.ts                    compile(plan, model) → one variable-threaded EC program + human notes
  constraints.ts           what BMP can serve (height, reorder, composites, blast radius); lint() is live
  history.ts               undo/redo over model snapshots; present() CLONES; revision() is a cheap
                           change key (the model object identity is useless for memoisation — it clones)
  sync.ts                  load/apply orchestration over an injected LayoutIO (still pure of bmp-client)
  blast-radius.ts          template fan-out + cross-family shared-container probe (preview warning)

src/lib/layout-service.ts  SHELL (service worker) — binds the core to BmpClient
  makeLayoutIO(client)       LayoutIO adapter + SILENT-ROLLBACK scan on commits
  loadPage / applyPage       resolve context → load, and diff→compile→commit→re-fetch

src/lib/handlers/layout.ts HANDLERS — LAYOUT_LOAD / LAYOUT_APPLY / LAYOUT_CREATE_TABSET / LAYOUT_BLAST
                           + BLUEPRINT_TOGGLE, setBlueprintActive(), toggleBlueprint()
```

The core never imports bmp-client or touches the DOM; the shell owns BMP I/O; the content script owns
rendering + gestures and holds the editable model (it imports the pure ops directly).

### Content-script module map (`src/content-blueprint/`)

The overlay is split state ↔ view ↔ controller. **`actions.ts` mutates `bp` and calls `render()`;
the view modules only READ `bp`.** The actions↔view import cycle is deliberate and init-safe (all
cross-calls happen inside functions, never at module load).

```
content-blueprint.ts   lifecycle: enable/disable (resetState on teardown), the @font-face + CSS inject,
                       window listeners (resize/keydown — scroll is native, see below), the
                       MutationObserver that follows BMP tab switches.
state.ts               the `bp` singleton + constants (STYLE_ID, PALETTE, MOST_USED) + `bp.mode`
                       (layout|style). DATA ONLY. freshState()/resetState() = the per-session field list.
colors.ts              style mode's colour data: fetch the per-profile colour sets once (one-shot
                       channel), keep a bid→rgb ColorSetIndex; colorRgb()/colorSets() feed the cell
                       tints + the swatch popup.
view.ts                render() — rebuilds the overlay from `bp` each call (chrome → result canvas OR a
                       small empty-state when nothing's on screen to anchor → floating chrome); the header
                       tab bar, the toolbar (layout + style), add-picker, move-menu, inline-rename,
                       ensureScrollRoom, pendingCount memo.
view-panels.ts         the chrome panels: command chip (incl. the peek control), apply-preview modal,
                       pending tray, hint bar, create-tabset modal. Pure builders — they never call render().
result.ts              renderResult() — THE canvas: the edited model as a CSS-grid mirror of BMP's real
                       12-track grid (span = cols.L × 2; rows from lib/layout/rows.computeRows — the ONE
                       row engine, live-verified 2026-07-02), ONE tab (the caller-resolved `viewedId`).
                       cellState() colours cells; a full-bleed .bp-canvas-bg backdrop sized to cover
                       every widget on the page.
edit-page-model.ts     one-pass flat stream → rendered page/column projection.
edit-page-result.ts    standalone EditPage form canvas, step navigation, fields, and add/reorder controls.
actions.ts             the controller: each gesture → a pure edit op → bp.history.push → render().
                       mutate() is the one write path. viewTab() drives BMP's real tab. togglePeek().
                       Add flows place via lib/layout/placement.bandInsertIndex (band-legal, toast on remap).
gestures.ts            pointer-driven drag-to-move/swap/reorder; arms cells via armBox(). (Width/height
                       edits go through the column/height controls, not an edge-drag gesture.)
                       edgeness()/nearestEdge() classify a drop; SWAP_ZONE/CONTAINER_NEST_ZONE name the bands.
                       Gap ('avail') drops resolve through lib/layout/placement.resolveGapPlacement — a slot
                       BMP can't render (cross-band) is REFUSED with a visible ✕ + reason, never silently
                       relocated. Edit ops themselves re-normalize to canonical order (containers first)
                       via edit.ts's single choke point, so raw model order always equals render order.
geometry.ts            DOM measurement + placement: ridElementMap, unionRect, anchorRect, widgetRects,
                       the button factories, and placeDoc()/docX/docY (the ONE viewport→document convert).
service.ts             SW I/O (sendRequest): loadPage / applyPage / createTabset; sameSession guard.
content-blueprint.css  the injected stylesheet, scoped to #crev-blueprint-layer.
```

### Coordinate space & scrolling

`#crev-blueprint-layer` is `position:absolute` at the document origin, so the canvas + cards **scroll
natively with the page** — there is no JS scroll-follow (it lagged and painted over BMP's non-sticky
header/tabs). Consequences a new dev must respect:
- Elements anchored to live BMP content are *measured* in viewport space (`getBoundingClientRect`) and
  must be *placed* in document space. **Always** go through `placeDoc()` / `docX` / `docY` (geometry.ts)
  — never write `+ window.scrollX` inline again.
- The floating chrome (header chip, tray, hint, modals, pickers, move-menu) is `position:fixed` in CSS,
  so it stays viewport-pinned regardless of the layer.
- `render()` runs on edit / resize / tab-switch — **not** on scroll. Anything that must track a scroll
  is wrong; fix the document-space placement instead.

## The canvas (result view)

Blueprint renders the **edited model** as a CSS grid: `grid-template-columns: repeat(6, 1fr)` +
`grid-column: span cols.L`, anchored to the live content box so columns line up with the real page.
It touches none of BMP's DOM, so there's no iframe reload or chart breakage, and staged adds (which
have no live DOM) render in their final position. **One tab at a time** — the header tab bar switches
which, and clicking a tab pill drives BMP's *real* tab (clicks the native `.corpo-tabSet__tab`; the
MutationObserver follows). Fidelity is exact for columns (verified live, ~6/6 within gap rounding);
height is the only approximation (live-measured on the active tab, per-type estimate off it).

The tab bar folds **empty tabs** away: a tab with no widgets on this page (in the baseline or the
edited model) is what BMP's portal hides, so a big shared tabset (Risk Register renders through a
~25-tab set with 2 used) would drown the strip. Used/changed/viewed/live tabs render as pills; the
empty rest collapses behind a muted `+N empty` toggle (`bp.unusedTabsOpen`), and expanded empty
pills are ghosted + dashed. Moving or adding a widget onto one makes it "used" immediately.

Visual language is an **architect sketch on white** (the tokens live at the top of
content-blueprint.css): a white canvas with a faint two-tier gray grid (a full-bleed `.bp-canvas-bg`
backdrop behind the cards), tech-navy hairline cards, gray dashed grouping containers, a light
lifted-paper shadow. **CREV purple (#8a3ffc)** is the single interaction accent (hover / selection /
drop / add); state stays semantic — green = new, amber = changed, red = delete, shown as solid filled
pills. Cells are line-art: a faint type glyph + mono caption (no thumbnails — the old `captureVisibleTab`
pipeline was removed). To restyle, edit the `--bp-*` token block; component rules inherit from it.

**Peek** (the slashed-eye control in the command chip): hover for a transient fade, or click to keep
it sticky — fades the overlay to **full transparency** so the real widgets show through. State:
`bp.peek` + the `.bp-peek` class on the layer (render adds the class but never removes it mid-frame, so
a transient hover survives a re-render).

## Style mode (G3)

`bp.mode` toggles the canvas between **layout** (cols / move / rename / add / delete) and **style**
(appearance) — a pure render switch over the SAME loaded model, peer to the instance/template toggle,
flipped from the command chip (`view-panels.ts`). In style mode:
- each cell paints its real appearance — header tint + contrast ink, font colour, shadow, border,
  header-drop, transparency (`result.ts applyStyle`); a cell whose style differs from baseline gets the
  amber `bp-style-dirty` ring.
- the selection toolbar swaps to a **style toolbar** (`view.ts styleToolbar`): header/font colour chips,
  a shadow toggle, header-style + border segmented choices, a transparency stepper. A colour chip opens
  the **swatch popup** — the shared `renderSwatchGrid` (folders = colour sets, searchable, a "None" clear)
  themed for the overlay; picking links the CorpoColor, "None" clears it.
- drag is disabled (style edits appearance, not layout — `gestures.ts` select-only).

Edits stage into `LNode.style` (`edit.setStyle`) with full undo/redo, and apply through the normal
`LAYOUT_APPLY` path: `diff.changedStyle` emits only the fields that moved (absence folded to a BMP
default), folded into the same `t.<bid>.change(...)` as any other update. Colours and scalars are
serialised by the **shared `styleAssignRhs`** (`lib/style-ec.ts`, also used by the side-panel object
apply) so the two "set a style prop" paths can't diverge — colour links → `t.<bid>` (or `""` to clear,
verified live), enums → uppercase strings (`"INSIDE"`/`"LINE"`), shadow → `TRUE`/`FALSE`. The catalog of
style props + their reset literals lives in `lib/style-props.ts`; the NodeStyle↔BMP-prop map in
`lib/layout/types.ts STYLE_NODE_FIELDS`.

(Styling once had a dedicated side-panel tab; it was retired once Style mode landed. The colour fetch
+ `ColorSetIndex` + `swatch-grid.ts` it introduced are shared and live on.)

## Paintbrush (G4)

The style-transfer tool: a **2×2 "paint station"** mounted right of the top bar (mirroring the mode
switch on the left), style mode only. `view-paint.ts` builds it; `bp.brush` holds the state.

- **Brush** (hero) is ONE state-driven cell — Pick and Paint merged: empty → eyedropper; armed-sampling
  → eyedropper + cyan ring; loaded → the held style's mini "chip" + brush glyph + purple armed-fill, with
  a re-pick eyedropper. Armed, `gestures.dragOrSelect` routes a WIDGET click to `brushOnCell` — first
  click captures `node.style`, the rest paint `setStyle(target, maskStyle(held, mask))` (staged · live
  preview · undo · one Apply). Containers/tabs are ignored (no appearance props). The per-cell style
  toolbar is suppressed while armed.
- **Setup** (sliders) edits `bp.brushMask` — the BMP props the brush copies; painting an unstyled source
  clears the masked props (via the verified enum-clear path). `maskStyle` (`lib/layout/types`) is the
  pure patch builder.
- **Save/Load** — the saved-style library: a per-profile `StylePresetStore` in the SW
  (`crev_<profile>_style_presets`, FavoritesManager pattern), reached over LIST/SAVE/DELETE_STYLE_PRESET
  one-shot messages (`content-blueprint/presets.ts`). Colours are workspace-global businessIds, so a
  preset paints onto any scorecard in the workspace. All popups + the shared `styleChip` motif use the
  overlay's `.bp-pick` chrome.

## Flow editing (blueprint flow layer)

Flow-bearing widgets — InputView, CreateObjectView, ActionButton, plus composites placed directly in
the grid (InputSet/ButtonContainer/ButtonGroup) — render their **flow chain inside the result cell**
(visual contract: `experiments/blueprint-flow.html`, v6 FINAL): a config band (createMode /
destination / action verb), a reference band (INS/EPG badge + name + SHARED tag + fold chevron), then
the reference's children as badge-led rows in a strict grid (`drag 14 · lead 38 · name 1fr · prop 110
· dots 30`). Blue dots carry EC **presence** (booleans only — the fetch never reads code bodies);
breaks are quiet rows; a nested ButtonGroup is an indented sub-block. **No property/EC editing here**
— that stays in Inspect (see BUGS.md backlog).

Architecture mirrors the layout split, but as a PARALLEL structure (never in `LNode.children` — the
layout diff stays byte-identical for flow-less models, regression-tested):

```
LModel.flows      read-only projections keyed by flow-WIDGET businessId (from the fetch's
                  FREF/FMET/FCHD/FCPR/FTR wire channels; parseFlows in sync.ts)
LModel.flowEdits  staged edits keyed by the CONTAINER (InputSet/EditPage/ButtonGroup) or the
                  button's businessId — the same InputSet edited from two cells stages ONCE
lib/layout/flow.ts   pure ops (addFlowChild/reorderFlowChild/setActionFlag/addActionButton),
                     effectiveFlowChildren (render = compile order), flowDiff → flowCreate/
                     flowReorder/flowFlag PlanSteps, trayButtons, flowSignature
content-blueprint/result-flow.ts   flowPanel (cell chain) · compositeFlowRows (grid composites,
                     staging via the EXISTING layout pipeline) · actionTray (header cards)
```

Flow steps join the ONE apply plan (`applyModel` composes `diff() + flowDiff()`); the compiler emits
`_ff<k> := <parent>.add(<Type>, name := …)`, `moveAfter` chains, and `change(displayOnActionMenu/
displayOnAllTabs := …)` — all verbs live-verified on the example-flow fixtures (see constraints.ts
header; notably ButtonGroup accepts ONLY ButtonInput — ActionButton/MenuButton were refused live).
The stale + rollback guards compare `flowSignature` alongside the layout diff, so a purely-flow
apply is neither missed nor misread as a rollback.

**Apply safety — BMP Extended Code is NOT atomic** (verified live 2026-07-12 on fixture t.50675: a
mid-script `Could not find type` error left the prior `.add()` committed — child count 4→5). The
`transactional` flag is commit-vs-preview, not rollback-on-error, and a WARNING-level soft failure
returns `ok:true` while dropping a step. So `applyModel` never trusts `res.ok`: after the commit it
re-fetches UNCONDITIONALLY and reconciles the live page against the plan, classifying the outcome as
**full** / **partial** / **none**. Every branch hands back the fresh model + baseline so the editor
rebases onto reality (a stale desired model would re-emit its landed `add()`s and duplicate them on
the next apply). A partial (`ok:false` errored partway, or `ok:true` with warnings) rebases in place
and tells the user to verify + re-apply rather than reporting a clean save. See `memory/bmp-ec-nonatomic`.

**Apply preview — the blast-radius gate blocks Confirm.** The template fan-out / cross-family
shared-container warning is the highest-consequence signal (a container edit on a master rewrites N
live instances), and it comes from an async `rref` walk. `Confirm & apply` is disabled ("Checking
impact…") until that probe resolves — or fails, so a dead probe can't wedge it shut — so a fast click
can never commit ahead of the warning.

**Renaming a flow object** reuses the SAME inline-rename machinery as cells and tabs (a pencil →
`beginRename` → `bp.renameId` → `openPendingRename` makes the matching `[data-bprename]` span
contenteditable; Enter commits, Escape cancels, an outside click commits). Every renameable name span
(result cell, flow row, reference band, staged-new container) carries `data-bprename="<objectId>"`, so
the pending-rename resolves the exact object regardless of selection timing (this also hardens the
selection-toolbar pencil on a freshly-added InputView/COV cell). `doRename` routes a non-layout id to
`renameFlowObject` (flow.ts): a staged-ADD child's rename mutates its add node in place (name rides the
create); a staged-NEW container's updates `newContainer.name` + the wiring label; an EXISTING object
stages `rename` (keyed per object, pitfall #2; cleared when typed back to the original) → `flowDiff`
emits `flowRename` → `t.<bid>.change(name := "…")` (name escaped via `ecStr`; live-verified execute on
an InputSet child + an EditField). `effectiveFlowChildren` overlays staged renames so the row shows the
new name immediately, and `flowChangeCount` counts a rename-only edit so Apply unlocks.

**New references from blueprint**: a reference-less InputView/COV (typically one just staged from the
grid picker) offers "wire to existing…" (a lean SW fetch of the workspace's InputSets/EditPages at
picker-open — `LAYOUT_FLOW_REFS`) and "+ new" (stages a new set/page auto-named after the widget; its
empty child list renders immediately so elements stage underneath before the first Apply).

**Wiring to an EXISTING off-page reference** fetches that reference's real current children on demand
(`LAYOUT_FLOW_REF_CHILDREN` → `t.<bid>.children()`, same child shape as the main projection) and renders
them as the cell's normal (non-staged) rows, so staged adds/reorders layer on top exactly as for an
on-page reference — cached per ref for the session (`bp.flowRefChildren`, baked read-only into the model
so the pure diff/render see it). While the fetch is in flight the cell shows "Loading…"; on failure it
falls back to the "contents unknown" note (never a hard error).

**The support-Category landing (unified).** Everything a page newly creates in the portal — the virtual
tabset from "+ Create tabset", *and* every new InputSet/EditPage — lands in ONE Category per apply,
named after the page's **display name** (`LModel.pageName`, from the fetch; falls back to `pageId`).
The compiler resolves it once (`ec.ts` `ensureSupportCat`): reuse an on-page reference's existing
Category when one exists (co-locate — `flow.existingSupportCategory`, using its `refParentName` for the
label), else create ONE `root.portal.add(Category, name := <page display name>)` and reuse that var for
every landing. `EditPage` at portal root is refused by BMP, so the Category is mandatory — used
uniformly. (Live-verified 2026-07-12: a single Category holds a TabSet+Tab, an InputSet, and an EditPage
together — execute, net-zero.) The wire compiles LAST (`widget.change(inputSet/editPage := <target>)`,
var-to-var when both ends are staged), folding `createMode := "EDITORADD"` into the same change() for an
ADD-mode COV (which otherwise ignores its editPage). A staged-new reference can't be SHARED (unshared
until created) and its whole chain cancels from the band's ✕ or the pending tray.

The **action-menu tray** (header, top-right) shows the viewed tab's `displayOnActionMenu` buttons +
`displayOnAllTabs` ones with an honest "(N on other tabs)" note; ACTION cards expand their read-only
transports inline; ADD/NAVIGATE cards show their verb sentence. Menu buttons are EXCLUDED from the
grid wire (they're not layout); an in-grid button's Placement control (In grid | Action bar) stages
the flip both ways — staged-to-menu cells leave the grid like ghosts, staged-to-grid cards stay in
the tray flagged "TO GRID" until Apply. "Add action" stages a new button born
`displayOnActionMenu := true` bound to the current tab. SHARED references (two widgets on the page
pointing at one InputSet/EditPage) warn in the apply preview: changes appear everywhere it is used.

## Two-model split & context resolution

BMP layout spans two models: the **portal** TabSet → Tab → Container grid, and the **org** model that
owns widgets (a widget binds to its cell via `container`). `sync.resolvePageContext(io, rid)`:
- **Direct** (Scorecard/ModelPage/GRC): owns its widgets; page root = the object; tabset found by
  walking a widget's cell up to the first TabSet ancestor; `tabScope: 'all'`.
- **Enterprise** (`.template` → EnterpriseTemplate): layout lives on the template; page root = the
  **template**; tabset = the shared `default_tabset`; `tabScope: 'withContent'`. Edits hit all
  instances → loud blast-radius warning.

Page root is referenced `t.<id>` (resolves a Scorecard AND a template). Widgets are fetched with
`lookup(<rid>).descendants()` so composites (ButtonContainer → buttons) come along.

**Which rid to load** comes from the same URL ⊕ fiber rule as the Page tab: content.ts registers a
resolver (`setBlueprintRidResolver`) that prefers the address bar's `?rid=` and falls back to the
React-fiber page context (`s.fiberPageContext`, refreshed synchronously via an `EXTRACT_FIBERS`
CustomEvent when the cache is empty). BMP's custom-routed pages — a group's landing page — carry no
`?rid=` at all, so the fiber is the only source there; the old URL-only read made the toggle fail
with "no BMP object on this page". `handlePageNav` uses the same resolver, and only tears down when
the page has genuinely left BMP content behind (no `[data-rid]` elements at all — the fiber can be
transiently blank mid-render).

### The shared Result tab

A scorecard's intrinsic **Result** tab (`t.RESULT`) lives in the SHARED `default_tabset`, not the
page's own tabset — so it renders in the strip but isn't one of the page's tabs. The fetch emits it as
a normal Tab node with its REAL parent (so it slots into the tab list), and keeps its directly-bound
widgets' container binding so they attach to it (they're the page's own objects — editing them is
page-local). `reconstruct` collects tabs from ANY emitted Tab node (not just the page tabset's
children), so the foreign-tabset tab comes along with no special-casing; and `diff` groups reorders by
parent, so a foreign-tabset tab never chains with the page's tabs. The only real special cases are
`isResultTab` (model.ts): the tab pill omits rename/delete (editing the tab edits the shared tabset),
and the apply preview raises a loud blast-radius warning — louder still when the plan adds/moves a
**container** there, since a container on the shared tab appears on every scorecard that uses
`default_tabset`. We deliberately don't pull in `t.RESULT`'s own Row/Column scaffold (a big shared
grid) — the page's widgets bind to the tab directly, so adopting just them mirrors what BMP renders.

## Message flow

```
toggle (button / Ctrl+Shift+B) ─BLUEPRINT_TOGGLE→ SW ─BLUEPRINT_STATE→ content (one-shot, like INSPECT_STATE)
content ─LAYOUT_LOAD {rid}→ SW.loadPage ─LAYOUT_LOAD_RESULT→ content (replies to the SENDER's content port)
content ─LAYOUT_APPLY {env, ctx, baseline, desired}→ SW.applyPage ─LAYOUT_APPLY_RESULT→ content
content ─LAYOUT_CREATE_TABSET {…}→ SW (RESULT-only pages with no tabset)
content ─LAYOUT_BLAST {pageId, containers}→ SW (best-effort blast-radius for the preview modal)
```

The content script holds `baseline` + an edited model (`History`); Apply sends both, the SW is
stateless per request.

**Apply = commit, page reload, auto-resume.** On success `applyPage` (service.ts) toasts, persists a
short-lived resume flag in sessionStorage (`{prefer, t}` — the current template/instance target),
sends `BLUEPRINT_TOGGLE` (off), and `location.reload()`s — the live BMP grid can only reflow on a
real page load, and we don't want to reopen onto a stale model. The fresh content script consumes the
flag on boot, waits for the first `[data-rid]` to paint, and sends `BLUEPRINT_RESUME`; the SW
re-enables blueprint for THAT tab (`setBlueprintActive(windowId, true, tabId)`), and the next
`enableBlueprint` loads with the saved `prefer` — so applying to "This instance" resumes editing the
instance, not the template. While BMP is still mounting, the canvas renders on a **synthetic
content-box frame** (renderResult falls back when no live widget anchors; the guessed frame is never
cached) instead of dead-ending on "no widgets are on screen".

**The apply-preview modal** shows warnings as a full-bleed strip under the header (amber left-accent
rows, hairline-separated — not floating boxes) and the plan as a uniform-height log table:
icon | ACTION | type chip + object | → where | detail | ec, from the structured `PlanNote` fields the
compiler emits (`action/object/objectType/where/detail`; `text` is the fallback). The footer's
**Copy EC** copies the full compiled program (`bp.previewScript`).

## Safety guards (all enforced server-side in the SW)

- **Silent-rollback**: BMP can return ok with a "No changes done due to errors" log and no ERROR
  entry — commits scan the log and downgrade to failure.
- **Stale-baseline**: before committing, re-fetch and `diff` the baseline; if the page drifted, abort
  and hand back the fresh model to rebase (`ApplyResult.stale`).
- **Wrong-env**: load stamps `profileId@serverURL`; apply rejects a mismatch.
- **Blast radius**: template/enterprise edits carry a loud warning in the chip + preview modal.
- **Apply-preview**: Apply always shows the exact EC before committing (never commit blind).
- **Composite guard**: adding into a non-composite widget is refused in both UI and compile.

## Gotchas for future devs

- **`History.present()` clones** — you cannot memoise on the model's object identity. Use
  `history.revision()` (bumps on push/undo/redo/reset). The per-frame `pendingCount` memo in view.ts
  keys on `(baseline identity, revision)`.
- **Minimal reorder.** `lib/layout/reorder.ts` (`minimalReorder(current, desired)`) is the ONE shared
  helper both the layout diff and the flow diff use to emit reorders: the items already in the correct
  relative order — a longest-increasing-subsequence of the desired order by current index — stay put, and
  only the displaced items move, ONE op each (a single drag = one move, not an N-1 cascade). Each move
  anchors to an already-placed neighbour: `moveAfter(<desired predecessor>)`, or `moveBefore(<current
  first>)` for a drag-to-front. The compiler (`ec.ts` `reorder` / `flowReorder`) emits whichever the step
  carries (`afterId` vs `beforeId`). `moveBefore` + a 2-move minimal shuffle are live-verified on the
  fixture InputSet t.50850 (committed [OK], order read back exactly, restored).
- **Logical vs raw count.** Inserting a widget mid-list compiles to a create + one minimal reorder;
  `summarizeChanges` still reports `changes` (logical, headline — a whole reorder groups to ONE, by
  parent) and `actions` (raw EC, exposed in the tray "N change · M actions" and the apply modal). Don't
  headline `diff().length`.
- **Cell selection needs mousedown+mouseup**, not a lone mousedown — `armBox` treats a press as a
  potential drag and only selects on mouseup-without-drag. (Mostly a test-driving gotcha.)
- **The panel is a wireframe, not a pixel overlay** — it sits inside a 12px-padded panel, so absolute
  positions are inset; only column *proportions* match BMP exactly.
- **Scroll spacer**: a tall wireframe (staged adds below the fold, the bottom add-zone) needs a
  body-level spacer (ensureScrollRoom) to extend the document's scroll height — BMP scrolls the
  document, sized to BMP's content. The tab-strip clamp only applies at the top of the page, or it
  freezes the panel mid-scroll.
- **Blueprint ↔ inspect are mutually exclusive** — `toggleBlueprint` turns inspect off first; each
  owns a document-wide overlay + observer and only one should paint at a time. z-orders are disjoint
  (blueprint 2147483600 / inspect 2147483636-647) but never run together anyway.
- **EC string accumulation is quadratic with a huge constant** — every `+` whose operand chain
  includes the big accumulator re-copies AND HTML-sniffs the whole string (BMP's `DetectHtml` runs
  per concat). The fetch EC builds each node's lines in a small local `_l` and touches `_r` once per
  node; the multi-term `_r := _r + a + b + …` original measured 3.8 s on the ~60-node demo page and
  minutes on heavy pages — which is what "blueprint loads forever then fails" was. Layout EC also
  runs with `LAYOUT_EC_TIMEOUT` (120 s) instead of the general 30 s window; when the client aborts,
  BMP logs the run as `Cancelled by user`.

## Running it (e2e rig — chrome-devtools-mcp)

1. `npm run build` (vite's closeBundle copies `dist/` artifacts to the repo root, beside `manifest.json`).
2. `install_extension { path: <repo root> }` (NOT `dist/`). See `memory/chrome-devtools-mcp.md`.
3. Seed a **session** profile from the SW: `chrome.storage.local.set({ crev_settings: { …, profiles:
   [{ id, label, bmpUrl, authMode:'session' }], activeProfileId } })` — borrows the logged-in BMP
   tab's session, no credentials.
4. `reload_extension`, then reload the BMP page (extension reload orphans old content scripts; a fresh
   page-reload re-loads the content bundle). Grab the newest service-worker id after each reload.
5. Activate via the sidepanel Blueprint button, the `BLUEPRINT_STATE {active:true}` message, or
   Ctrl+Shift+B.
6. Drive gestures by dispatching real `MouseEvent`s on `#crev-blueprint-layer` elements (chip buttons
   fire on mousedown; cell select = mousedown+mouseup; drag = mousedown → document mousemove past 6px
   → mouseup). Verify commits with `ec_preview` reading the BMP object by `t.<businessId>`.

## Test coverage

- Pure core + sync + service: `src/lib/layout/__tests__/*` + `src/lib/__tests__/layout-service.test.ts`
  (model/edit/diff/ec/constraints/history/sync, the live-validated EC golden, regressions, a scale
  test, the rollback scan). `result.test.ts` covers the canvas structure (classes/spans), not styles.
- Every EC pattern was validated live (`ec_preview`/`ec_execute`) before shipping; the golden string
  carries the date it was last live-checked.
- UI is validated by the e2e rig above (the content overlay has no headless DOM harness).

## Follow-ups

- **Live-fallback renderer: RETIRED.** The result canvas is the sole editing surface; when it can't
  anchor (nothing on screen) the overlay shows a small empty-state. This deleted the frozen-DOM box
  builders + their `nodeState`/`packRows`/`addGapZones`/`stackY` cluster (~185 lines), and with them the
  `cellState`↔`nodeState` and `packRows`↔`fillGrid` duplication. `unionRect`/`anchorRect` STAY — the
  result canvas anchors with them. (The dead CSS the box builders used is interleaved with live shared
  selectors — a surgical follow-up.)
- A fully **live-derived** add palette per host (needs the server add-menu command) + **real display
  names**; the curated PALETTE / MOST_USED ship now.
- Perf: the result canvas rebuilds the whole layer each render (a scroll-time translate-instead-of-
  rebuild path is the next optimisation after the diff memo).
