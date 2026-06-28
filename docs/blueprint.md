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
content-blueprint.ts   lifecycle: enable/disable, the @font-face + CSS inject, window listeners
                       (scroll/resize/keydown), the MutationObserver that follows BMP tab switches.
state.ts               the `bp` singleton + constants (LAYER_ID, PALETTE, MOST_USED). DATA ONLY.
view.ts                render() — rebuilds the overlay from `bp` each call; per-element builders, the
                       header tab bar, the toolbar, the add-picker, the move-menu, inline-rename, the
                       page-scroll spacer (ensureScrollRoom), the per-frame pendingCount memo.
view-panels.ts         the chrome panels: command chip (incl. the peek control), apply-preview modal,
                       pending tray, hint bar, create-tabset modal. Pure builders — they never call render().
result.ts              renderResult() — THE canvas: the edited model as a CSS-grid mirror of BMP's
                       6-col model, one tab at a time. cellState() classifies cells for colour.
actions.ts             the controller: each gesture → a pure edit op → bp.history.push → render().
                       mutate() is the one write path. viewTab() drives BMP's real tab. togglePeek().
gestures.ts            pointer-driven drag-to-move/swap/reorder + edge-resize; arms cells via armBox().
geometry.ts            DOM measurement: ridElementMap, unionRect, anchorRect, the button factories.
service.ts             SW I/O (sendRequest): loadPage / applyPage / createTabset; sameSession guard.
content-blueprint.css  the injected stylesheet, scoped to #crev-blueprint-layer.
```

## The canvas (result view)

Blueprint renders the **edited model** as a CSS grid: `grid-template-columns: repeat(6, 1fr)` +
`grid-column: span cols.L`, anchored to the live content box so columns line up with the real page.
It touches none of BMP's DOM, so there's no iframe reload or chart breakage, and staged adds (which
have no live DOM) render in their final position. **One tab at a time** — the header tab bar switches
which, and clicking a tab pill drives BMP's *real* tab (clicks the native `.corpo-tabSet__tab`; the
MutationObserver follows). Fidelity is exact for columns (verified live, ~6/6 within gap rounding);
height is the only approximation (live-measured on the active tab, per-type estimate off it).

Visual language is **line-art cyanotype** — one opaque blue ground, near-white hairlines, drafting
motifs (corner ticks, container dimension lines, hatched add-zones), no fills/shadows/glows. Cells
are pure line-art: a faint type glyph + mono caption. **There are no thumbnails** — the photographic
`captureVisibleTab` thumbnail pipeline (thumbs.ts, the `LAYOUT_CAPTURE` message) was removed; it
fought the aesthetic and added a screenshot round-trip. State is colour-coded through border + icon +
name: **added = green, changed = yellow, moved-only = lighter yellow**; deleted = red in the tray.

**Peek** (the slashed-eye control in the command chip): hover for a transient fade, or click to keep
it sticky — fades the overlay to 0.2 opacity so the real widgets show through. State: `bp.peek` + the
`.bp-peek` class on the layer (render adds the class but never removes it mid-frame, so a transient
hover survives a scroll re-render).

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

**Apply = commit then page reload.** On success `applyPage` (service.ts) toasts, sends
`BLUEPRINT_TOGGLE` (off), and `location.reload()`s — the live BMP grid can only reflow on a real page
load, and we don't want to reopen onto a stale model. Re-activating after reload re-fetches; the
applied edits come back as the new baseline. This is intentional, not a bug.

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
- **Logical vs raw count.** Inserting a widget mid-list compiles to a create + a `moveAfter` chain;
  `summarizeChanges` reports `changes` (logical, headline) and `actions` (raw EC, exposed in the tray
  "N change · M actions" and the apply modal). Don't headline `diff().length`.
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

- **Integrate the live diff view into inspect mode** — the "real page with overlays" role belongs in
  inspect, not as blueprint's no-anchor fallback. Killing it lets the frozen-DOM geometry inference
  (`unionRect`/`anchorRect`/`addGapZones`/`stackY` in geometry.ts/view.ts) be deleted.
- A fully **live-derived** add palette per host (needs the server add-menu command) + **real display
  names**; the curated PALETTE / MOST_USED ship now.
- `constraints.ts` has a test-covered "Phase 2" gesture-gate layer (`checkAddTarget`/`checkHeight`/
  `checkReorder`/`guard`) that isn't wired to the hot path yet — wire it or remove it together.
- Perf: the result canvas rebuilds the whole layer each render (a scroll-time translate-instead-of-
  rebuild path is the next optimisation after the diff memo).
