# crev-inspector 0.51 — project plan

All items below ship together in **0.51** (no release until the whole set lands).
Ordering optimizes for a coherent end result, not quick wins: get the **model**
right, then **targeting**, then the big **styling** feature, then chrome polish.

Status legend: ☐ todo · ◐ in progress · ☑ done

---

## Phase 1 — Blueprint model & rendering correctness (foundation)

Everything visual — including the styling preview in Phase 4 — rests on the
model accurately reflecting the real page. These three share the
fetch→model→render pipeline (`lib/layout/sync.ts`, `content-blueprint/result.ts`,
`view.ts`), so they're done together to avoid rework.

### D. Model/template containers + ButtonContainer (needs live RE)
- **Symptom:** On the crev demo *enterprise risk & controls* scorecard, a
  "test buttons" ButtonContainer shows the container but not its buttons; a
  container `t.455` created in the Result tab lives in the **model/template**
  (not a shared web-item container) and isn't recognized — its table +
  create-object widget don't render as inside it; container is 3-wide but
  children show 6-wide.
- **Decided width model (Q-D, authoritative — corrects existing code):** a
  container is a **scaled 6-col sub-grid**; a model/template container is **the
  same as a shared-web-item (SWI) container** — no special-casing. A child's
  visual width = `container_cols × child_cols / 6`: a 6-wide widget in a 3-wide
  container renders **3 wide**; a 3-wide widget in a 1-wide container renders
  **0.5 wide**. The blueprint must **mirror BMP exactly**.
- **NOTE — re-verify and likely fix:** `edit.ts:50-52` claims "a widget keeps
  its width in the dest's OWN 6-col grid… width-2 container holds 6/6 widgets"
  i.e. widths NOT relative to container. That contradicts the decided model —
  re-RE live and correct the model/edit/diff logic if the stored vs rendered
  width handling is wrong.
- **Where:** `lib/layout/constraints.ts:34-49` (composite types: ButtonContainer/
  ButtonGroup/InputSet hold children via `.add`, not `container :=`);
  `lib/layout/model.ts:33-43` (`ownerOf`); fetch in `lib/layout/sync.ts`
  (membership not picking these up); `result.ts:152-216` (`fillGrid`/`cell` —
  nested `.bp-rcont` sub-grid already exists for SWI containers).
- **Work:** the core fix is **recognition/membership** — extend the fetch EC so
  ButtonContainer/ButtonGroup children and model/template-level containers bind
  to their container exactly like SWI containers, so the existing nested-sub-grid
  rendering naturally applies the container-relative width. Reconcile the stored
  vs visual width with the decided model.
- **Prereq:** live RE against `t.455` / `t.4957` to confirm the ownership model
  and the stored-vs-rendered width semantics.

### A. Result tab as a normal tab + create-tabset in the bar
- **Symptom:** Result tab is shown everywhere even when empty; a RESULT-only page
  pops a modal telling you to create a tabset.
- **Where:** `lib/layout/model.ts:30-31` (`RESULT_TAB_ID`/`isResultTab`);
  `sync.ts:108-121` (Result emitted explicitly, always first);
  `view.ts:624-667` (tab bar, `.shared` pill); `view-panels.ts:177-203`
  (`createTabsetModal` — the popup); `sync.ts:232-277` (`NeedsTabset` detection).
- **Work:** (1) only surface the Result tab when it actually has widgets — model
  it like any other tab. (2) Replace the modal with a "+ new tabset" affordance
  rendered in the normal tab bar; reuse the existing create-tabset EC
  (`sync.ts:291-299`).

### B. Canvas vertical sizing on tab switch (tall ExtendedTable bug)
- **Symptom:** Switching to a tab whose real widget (e.g. ExtendedTable) is much
  taller than our wireframe leaves the canvas too short — the real table peeks
  out below the backdrop.
- **Where:** `result.ts:116-135` (`widgetHeight`: authored > live > estimate,
  capped 520px; off-screen tabs use low `estimateHeight` estimates);
  canvas/backdrop height frozen at render (`result.ts:254,274`); "no re-render on
  scroll / stale height" fragility noted by the map.
- **Work:** after a tab switch, re-measure live widget heights once BMP renders
  the new tab and grow the backdrop to cover; reconcile with the 520px cap.

---

## Phase 2 — Editing robustness

### C. Graceful browser back/forward while editing
- **Symptom:** Browser "back" to a previous tab while editing leaves the blueprint
  overlay stranded.
- **Where:** lifecycle in `content-blueprint.ts:42-100` (enable/disable),
  MutationObserver on rid changes; no `popstate` handling.
- **Work (Q-C decided — graceful teardown only):** detect navigation
  (popstate/route change) and fail gracefully — clean teardown + reload onto the
  new page. Unsaved staged edits on the old page are lost (same as a reload
  today). No state-persistence in 0.51.

---

## Phase 3 — Template / Instance targeting

### F. Instance ↔ template toggle (DECIDED — "Model A", template-default)

**Architecture (live-verified on 4957 / crev_demo_complex):**
- The **grid (tabs + containers) is SHARED** between instance and template — the
  same objects (e.g. container `cont_crev_demo_enterprise_7` rid is referenced by
  both the instance widget 4961 and the template widget 4901).
- The **template defines base widgets**; an instance either OVERRIDES a widget
  (its own object, `linkedTo` the template's, in the shared container — overrides
  width/position/name) or ADDS local widgets (no `linkedTo`).
- Rendering shows the instance's override where present, else the template's base.
- Content (name/config) inherits via `linkedTo`; **layout (container/width) is
  per-instance** (4961 = width 2, template 4901 = width 3).
- No built-in `isInherited`/`isDefault` flag — override = `linkedTo` present AND
  `widget.prop ≠ widget.linkedTo.prop`.

**Why "edit instance, save to template" (Model B) was rejected:** it needs
per-widget `linkedTo` redirection in compile (add/delete/move/resize each), can't
handle local widgets, and suffers override-shadowing (saving to the template
shows no change on the very instance you're looking at). Higher cost, worse UX.

**Chosen — Model A, template-default (cheap: reuses load→edit→apply on a
different rid; no compile changes):**
- **Default = Template view:** opens editing the template's layout (base widgets
  in the shared grid). Edits hit the template → propagate. `target='template'`.
- **Toggle `[Template | This instance]`** in the hovering scorecard bar; reloads
  the chosen rid, preserving the instance↔template pair. Reuses the C reload.
- **Clean surfacing:** the bar clearly states what you're editing — "Template
  (affects all instances)" vs "This instance (page-local)".
- **Instance view:** shows this page's widgets (overrides + local), with the blue
  reset arrows (see below).
- Enterprise objects: always template, no toggle (unchanged).
- **Work:** `buildContextEc` surfaces the linked template rid+id; bp tracks
  `pageInstanceRid`/`pageTemplateRid`/`editingTemplate`; toggle UI in the chrome;
  template-mode warning (E). Open-on-template = resolve instance probe → load
  template.

**Reset arrows (instance view only):** an overridden inherited property shows a
blue Phosphor **ArrowUDownLeft** revert arrow — the arrow IS both the indicator
and the control; clicking it stages a reset that compiles to `.reset(<prop>)`
(verified live: `t.4961.reset(columnsLargeScreen)` reverts 2→3). Whole-widget
`.reset()` also available. Local widgets (no `linkedTo`) get no arrow.
- **Build order:** F1 = toggle + template-default + clean labels + E warning;
  F2 = override detection in the fetch + reset arrows.

### E. Redesign the "shared template affects all instances" warning
- **Symptom:** warning is badly done and can break alignment.
- **Where:** `view-panels.ts:79` (text), `:25-29` (`warnRow` builder),
  `.bp-modal-warn` CSS.
- **Work:** restyle/reposition so it can't disturb layout; fold into the F
  template-mode UX (a persistent "editing the shared template" cue in the bar +
  the redesigned apply-preview warning).

---

## Phase 4 — Styling via blueprint (headline feature, iterative)

Reuse: `color-picker.ts`, `color-set-cache.ts`, `fetchColorSets`
(`bmp-client.ts:1398`), `applyObjectChanges` `_o.change(...)`
(`bmp-client.ts:1330-1393`), `property-editors.ts`, `pane-schema.ts` style props
(shadow/headerStyle/borderStyle/transparency/showToolMenu/disableSearch/
headerColor/fontColor), `APPLY_OBJECT_CHANGES` handler
(`handlers/objects.ts:828-857`).

- **G1 — Styling tab scaffold ☑ (built, then retired in G3 Stage C):** a
  side-panel Style tab with Colors / Properties / Visibility sections. It
  proved the shared property model (swatch grid, `buildChangesPayload`) but was
  superseded by in-canvas Style mode — see Stage C below. The reusable pieces
  (`swatch-grid.ts`, `pane-edit.ts`, the colour-clear fix) live on; the tab
  itself is gone.
- **G2 — Paintbrush ☑:** copy a captured style set onto other objects
  (`content-paint.ts` / `lib/paint.ts` / `handlers/paint.ts`); respects the
  Phase 3 instance/template target.
- **G3 — Blueprint Style mode ☑ (Q-G decided — IN 0.51):** evolved past a
  read-only preview into a full **mode toggle** (layout ⇄ style), peer to the
  instance/template toggle. In style mode the wireframe paints each cell's
  real appearance (`result.ts applyStyle`) AND becomes editable:
  - **Stage A** — the mode switch + render path (cells show colours, shadow,
    border, header-drop, transparency).
  - **Stage B** — live editing: a per-cell appearance toolbar (header/font
    colour chips, shadow, header-style, border, transparency) + a searchable
    CorpoColor swatch popup; edits stage into `LNode.style` with undo/redo and
    apply through `LAYOUT_APPLY` via the shared `styleAssignRhs` (so the
    blueprint apply and any side-panel apply can't diverge). EC verified live.
  - **Stage C** — retire the G1 sidebar Style tab now that styling lives on the
    canvas.
- **G4 — Blueprint paintbrush ☑ (beyond the original plan, shipped in 0.51):** a
  2×2 "paint station" right of the top bar — one state-driven Pick/Paint brush,
  a Setup prop-mask, and a per-profile saved-style library (Save/Load) that
  paints across scorecards. The proper, staged in-canvas successor to the live
  sidebar paintbrush (G2). Built on the single-sourced style catalog + the
  verified enum-clear fix.

---

## Phase 5 — Sidepanel chrome cleanup (decoupled polish, intentionally last)

- **H1.** Connection/status strip only on the **Connect** tab — it's added
  unconditionally at `sidepanel.ts:447`; gate it per-tab. Redundant with the
  header elsewhere.
- **H2.** Remove the redundant green "connected" light shown before the Inspect
  tab content (exact element to confirm — see Q-H2: header dot
  `sidepanel.ts:326-329` vs the status strip vs `workshop-ctx-dot`
  `workshop-layout-pane.ts:465-468`).
- **H3.** Remove the "Auto-detected from page URL…" hint cleanly
  (`workshop-layout-pane.ts:500-505`).
- **H4.** Connect tab: move **Maintenance** (`connect-tab.ts:181-217`) **under**
  the guidance/reference card (`:221`); **verify the update logic**
  (`lib/version-check.ts` — GitHub `releases/latest`, 24h cache, semver
  `isNewer`).

---

## Decisions

- **Q-D (containers): RESOLVED — mirror BMP exactly.** Container = scaled 6-col
  sub-grid; model/template container == SWI container (no special-casing); child
  visual width = `container_cols × child_cols / 6`. Re-verify and correct the
  `edit.ts` width-relativity claim during RE.
- **Q-C (back button): RESOLVED — graceful teardown only.** No state persistence.
- **Q-G (styling preview): RESOLVED — all of G (incl. G3 preview) in 0.51.**
- **Q-H2 (which green light):** open — will confirm via a live side-panel
  screenshot during Phase 5 (likely the header connected-dot at
  `sidepanel.ts:326-329`).
