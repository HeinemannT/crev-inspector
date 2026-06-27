# Blueprint mode — the in-browser layout builder

Blueprint mode lets you restructure a live BMP page's layout visually — add / resize / rename /
move / delete widgets, manage tabs — preview the exact changes, and commit them to BMP with safety
guards. It renders an overlay pixel-aligned to the real page; geometry comes from the DOM, every
label and edit from a model.

Works on any **page host**: Scorecard, ModelPage, and enterprise objects (CeIssue/CePolicy/… — the
edit is retargeted to the linked EnterpriseTemplate). See `skills/bmp-platform/reference/
page-hosting.md` for the platform model.

## Architecture — functional core / imperative shell / UI

```
src/lib/layout/            PURE CORE (no I/O, no DOM) — unit-tested
  types.ts                 LNode / LModel / PlanStep / PageClass
  model.ts                 reconstruct(wire → LModel), tree helpers, owner = container ?? parent
  edit.ts                  pure (model,…) → model ops: resize/setHeight/rename/move/add*/remove
  diff.ts                  diff(baseline, desired) → ordered PlanStep[] (create→update→reparent→reorder→delete)
  ec.ts                    compile(plan, model) → one variable-threaded EC program + human notes
  constraints.ts           what BMP can serve (height, reorder, composites, blast radius)
  history.ts               undo/redo over model snapshots
  sync.ts                  load/apply orchestration over an injected LayoutIO (still pure of bmp-client)

src/lib/layout-service.ts  SHELL (service worker) — binds the core to BmpClient
  makeLayoutIO(client)       LayoutIO adapter + SILENT-ROLLBACK scan on commits
  loadPage / applyPage       resolve context → load, and diff→compile→commit→re-fetch

src/lib/handlers/layout.ts HANDLERS — LAYOUT_LOAD / LAYOUT_APPLY / BLUEPRINT_TOGGLE
src/content-blueprint.ts   UI — the content-script overlay (render + gestures + edit controls)
```

The core never imports bmp-client or touches the DOM; the shell owns BMP I/O; the content script
owns rendering + gestures and holds the editable model (it imports the pure ops directly).

## Two-model split & context resolution

BMP layout spans two models: the **portal** TabSet → Tab → Container grid, and the **org** model
that owns widgets (a widget binds to its cell via `container`). `sync.resolvePageContext(io, rid)`
classifies a viewed object:
- **Direct** (Scorecard/ModelPage/GRC): owns its widgets; page root = the object; tabset discovered
  by walking a widget's cell up to the first TabSet ancestor; `tabScope: 'all'`.
- **Enterprise** (`.template` → EnterpriseTemplate): layout lives on the template; page root = the
  **template**; tabset = the shared `default_tabset`; `tabScope: 'withContent'` (keep only tabs the
  template's widgets use). Edits hit all instances → loud blast-radius warning.

The page root is referenced as `t.<id>` (resolves a Scorecard AND a template; `SELECT
EnterpriseTemplate` does not). Widgets are fetched with `lookup(<rid>).descendants()` so composites
(ButtonContainer → buttons) come along.

## Message flow

```
sidepanel button ─BLUEPRINT_TOGGLE→ SW ─BLUEPRINT_STATE→ content (one-shot, like INSPECT_STATE)
content ─LAYOUT_LOAD {rid}→ SW.loadPage ─LAYOUT_LOAD_RESULT→ content (replies to the SENDER's
                                                                       content port, not the panel)
content ─LAYOUT_APPLY {env, ctx, baseline, desired}→ SW.applyPage ─LAYOUT_APPLY_RESULT→ content
```

The content script holds `baseline` + an edited model (`History`); Apply sends both, the SW is
stateless per request.

## Safety guards (all enforced server-side in the SW)

- **Silent-rollback**: BMP can return ok with a "No changes done due to errors" log and no ERROR
  entry — committing runs scan the log and downgrade to failure.
- **Stale-baseline**: before committing, re-fetch and `diff` against the baseline; if the page
  drifted, abort and hand back the fresh model to rebase (`ApplyResult.stale`).
- **Wrong-env**: load stamps `profileId@serverURL`; apply rejects a mismatch.
- **Blast radius**: template/enterprise edits carry a loud warning in the chip + preview modal.
- **Apply-preview**: Apply always shows the exact EC before committing (never commit blind).
- **Composite guard**: adding into a non-composite widget is refused in both the UI and compile.

## Running it (e2e test rig — chrome-devtools-mcp)

1. Build: `npm run build` (vite's closeBundle copies `dist/` artifacts to the repo root, alongside
   `manifest.json`).
2. `install_extension { path: <repo root> }` (NOT `dist/`). See `memory/chrome-devtools-mcp.md`.
3. Seed a connection from the SW (`evaluate_script { serviceWorkerId }`):
   `chrome.storage.local.set({ crev_settings: { …, profiles: [{ id, label, bmpUrl, bmpUser:'',
   bmpPass:'', authMode:'session' }], activeProfileId } })` — a **session** profile borrows the
   logged-in BMP tab's session (no credentials needed).
4. `reload_extension`, reload the BMP page (extension reload orphans old content scripts).
5. `trigger_extension_action` opens the sidepanel → Inspect tab → set a Tab/Scorecard context →
   the "⧉" Blueprint button (Workshop Layout section header).
6. The overlay loads on the BMP tab. Drive gestures by dispatching real `MouseEvent`/`KeyboardEvent`
   on the `#crev-blueprint-layer` elements; verify commits with `ec_preview`.

## Test coverage

- Pure core + sync + service: `src/lib/layout/__tests__/*` + `src/lib/__tests__/layout-service.test.ts`
  (model/edit/diff/ec/constraints/history/sync, the live-validated EC golden, regressions, a 320-
  object scale test, the rollback scan).
- Every EC pattern was validated live (`ec_preview`/`ec_execute`) before shipping; the golden string
  carries the date it was last live-checked.
- UI is validated by the e2e rig above (the content overlay has no headless DOM harness).

## The canvas: result view

Blueprint opens **straight onto the result canvas** — the edited model laid out as a CSS-grid mirror
of BMP's 6-col model (final positions, real heights, all tabs), which is the single surface you edit
on (honest drop targets: you drop where you see it land). Each cell shows a **thumbnail** of the real
widget (SW `captureVisibleTab` → per-rid crop in `thumbs.ts`; off-screen / inactive-tab widgets fall
back to a Phosphor type icon + watermark), so the wireframe is recognisable as the page itself. The
old **live diff-over-frozen-grid view** is now only a fallback for a page the result view can't anchor
to; it carries the stale-drop-target hazard and exists to be **retired into inspect mode** (the
"see the real page with overlays" role belongs there, not as a second editor) — see follow-ups.

## Status & follow-ups

Phases 1–4 complete (engine, safety, full interactive UI, composite editing); result-canvas + widget
thumbnails shipped. Remaining:
- **Integrate the live view into inspect mode** — move the real-page-with-overlays role to the
  existing inspect overlay and drop the live editing path from blueprint entirely (it's currently only
  a no-anchor fallback). Kills the stale-drop-target hazard and lets the frozen-DOM geometry inference
  (`unionRect`/`anchorRect`/`addGapZones`/`stackY`) be deleted.
- A fully **live-derived** add palette per host (needs the server add-menu command, not yet confirmed
  over the bridge) and **real display names** (the `#L#<key>.typename` localization bundle) — the
  curated palette ships now.
- An automated in-extension e2e harness; telemetry beyond the activity-log audit of applied EC.
