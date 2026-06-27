# Blueprint Mode — In-Page Layout Builder (design doc)

*Status: validated prototype → spec. Everything here was verified live against the demo
scorecard `4957` ("CREV Demo — Enterprise Risk & Controls", Steadfast Demo org) on
2026-06-26, using the `crev-inspector` extension's direct BMP client + Extended Code.*

Artifacts in this folder:
- `data.js` / `engine.js` / `index.html` — faithful reconstruction prototype (tree + grid).
- `overlay.js` — the live, pixel-aligned mode-B blueprint overlay (palette v2 + tooltip + reflow).
- `live-bp3-tooltip.png`, `live-bp4-resized.png` — the look, live on the real page.

---

## 1. Goal & rules

Let a user **add widgets and shape layout directly on the BMP page they're viewing**, in the
`crev-inspector` Chrome extension — no Config Studio, no separate canvas to reconcile.

Hard rules (from the product owner):
1. **Never assign business ids.** Let BMP generate them; read them back after commit.
2. **Never create a new TabSet.** Add containers into the existing tabs of the page's existing
   TabSet, "where they fit."
3. **English-only, no em dashes, no AI slop** in UI copy (project standard).

The extension already has the load-bearing pieces: a direct BMP binary client + `executeEc`
(`lib/bmp-client.ts`), a DOM scanner that reads `data-rid` / `data-container-rid` / `?tabrid=`
(`lib/dom-scanner.ts`), and a Workshop "Layout" pane that already fetches the layout subtree,
drag-resizes `columnsLargeScreen`, and reorders via `moveBefore`/`moveAfter`
(`sidepanel/tabs/workshop-layout-pane.ts`). Blueprint mode is the *in-page* surface for that.

---

## 2. The layout truth (two models)

A BMP page is split across two object models. This is the fact that drives every decision.

```
ORG / TEMPLATE model  (per page)        PORTAL model  (shared, root.portal → swi_default_tabs)
  Scorecard "the page"                    TabSet
    └─ widgets (CVO, table, chart, …)        └─ Tab
         bound via  .container := cell           └─ Container (row)
                                                      └─ Container (cell, nests arbitrarily)
```

- **Widgets** are page-local (live on the Scorecard). **Tabs/Containers/TabSets** are shared
  (potentially many Scorecards bind to one TabSet).
- A widget binds to a cell via `widget.container := <Container|Tab>`. Its `tab` is **inferred**
  from the cell's parent — never set directly.
- A page's tab strip = the **union** of tabs its widgets resolve to.
- Grid: `columnsLargeScreen` 0..6; siblings summing > 6 wrap; widths are **relative to the
  parent cell** (a span-6 widget in a span-2 cell fills that cell, not the page); nesting nests
  6-col grids. Responsive: `columnsMediumScreen` / `columnsSmallScreen` (default 6 = full width;
  below ~992px everything collapses to full width — why a narrow viewport looks single-column).
- **Height is not in the layout config.** Only `chartHeight` (charts, default ~470px, measured
  466 live) and `URLView.height` exist. Everything else is content-driven and emergent. Height
  is an *output*, never authored.

---

## 3. Reconstruction (model + measurement)

The blueprint is composed from two sources, each authoritative for its half:

```
reconstruct(model)  → structure, widths, EMPTY cells   (the DOM can't show empty/collapsed cells)
measure(DOM rects)  → positions, heights, real content  (the model can't know rendered heights)
        └────────────────► composed, pixel-aligned overlay ◄────────────────┘
```

- `FETCH_LAYOUT_TREE` returns Tab → Container → Container → widget-refs in one round trip.
- Render each node as a 6-col CSS grid; each child spans `clamp(1, columnsLargeScreen, 6)`.
- **Interleave (resolved):** a Tab can hold both containers (portal sort space) and widgets bound
  straight to the tab (widget sort space). These counters don't share an axis. **Verified against
  the live render: containers render first, then tab-bound widgets** ("containers-first"). This
  matches the extension's existing `renderGridNode`.

Verified faithful end-to-end: the reconstruction matches the live render exactly, including
3-level nesting (Side Panel → Detail → widgets), partial rows, and tab-bound widgets.

---

## 4. Interaction mechanics (all verified live, EC)

Reference facts:
- Widgets are `SELECT <Type> WHERE id = "<id>"`. Portal **Containers/TabSets are NOT
  `SELECT`-able but ARE reachable via `t.<id>`** (e.g. `t.5788`).
- `add()` returns the new object → one script can create a box and fill it.
- **Preview id ≠ executed id** (the counter advances on the discarded preview). Always **read the
  id back after commit**; never reference a preview id.
- `output()` is swallowed when writes interleave — build one final string.

| Interaction | EC (verified) | Notes |
|---|---|---|
| Create container | `tab.add(Container, columnsLargeScreen := n)` | no id; BMP assigns; `t.<id>` to reuse |
| Add widget → cell | `sc.add(Type, container := t.<cell>, columnsLargeScreen := n)` | `tab` auto-inferred |
| Add widget → tab | `sc.add(Type, container := t.<tab>, …)` | flows in the tab's grid |
| Resize width | `obj.change(columnsLargeScreen := n)` | container resize = shared warning |
| Resize height | `chart.change(chartHeight := px)` | charts + URLView only |
| Move across cells | `widget.change(container := t.<otherCell>)` | tab re-inferred |
| Reorder siblings | `obj.moveBefore(other)` / `obj.moveAfter(other)` | `sortIndex` is read-only; these are the only way; works for widgets AND containers |
| Nest container | `container.add(Container, …)` | arbitrary depth |
| Delete widget | `widget.delete()` | page-local, safe |
| Delete container | `t.<cell>.delete()` | **⚠ orphans its widgets to the `RESULT` tab** — no cascade, no error |

**The `RESULT`-orphan trap is the single most important safety rule.** Deleting a non-empty
container does not block and does not cascade; the widgets silently reappear in a default
`RESULT` tab. So "delete container" must **re-home widgets to the parent tab first** (or
cascade-delete on explicit confirm), never naive-delete.

Commit strategy: **stage a pending change-set, apply in one EC script, then re-fetch** (reuses the
extension's save→reload pattern and avoids per-edit reload churn). Undo = the computed inverse op.

---

## 5. Overlay architecture (mode B)

The blueprint is drawn over the real render — the "virtual page" *is* the live page.

**Alignment contract (verified 0px delta at 1480px and 1180px):**
- Root: `position:absolute; left:0; top:0; width/height = scroll size`, appended to `body`.
- Every child anchors to `document.body.getBoundingClientRect()` (absorbs body margin; equals
  document coordinates at any scroll). Width from the model; **position + height from the
  measured widget rect** (occupied cells trace reality; empty cells borrow their row band).
- **Never measure during a forced relayout.** A full-page screenshot resizes the viewport →
  reflow → stale overlay. (This was the one alignment bug we hit; it was the screenshot, not the
  overlay.)

**Reflow contract (verified):** a `ResizeObserver(documentElement)` + `window 'resize'` listener
re-render on any viewport change. **Opening the CREV side panel shrinks the window → this tracks
it.** rAF debounce + a `busy` guard prevent the observer self-trigger loop.

**Modes:** one overlay engine, a switch `Off / Inspect / Design`. Inspect = the current read
overlay (pills, click-to-drill). Design (blueprint) = structure + edit. Mutually exclusive so you
don't fat-finger edits while reading. Plates take `pointer-events` only in Design mode.

**Three slot states** (the DOM hides two of them; the model supplies them):
- **Occupied container** — frame around its widgets.
- **Empty container** — a real slot; "drop here" binds a widget to *that* container.
- **Bare grid space** — no container; filling it binds a widget to the tab, or mints a new
  container "where it fits" (per the no-new-TabSet rule, into the existing tab).

---

## 6. Blueprint visual spec

Architectural-drafting language. Real content is **dimmed, not hidden** (kept for context).

- **Scrim** navy `#0B2138` (multiply) → real widgets read as ghosts beneath.
- **Graph paper** 32px fine grid; **6 dashed column guides** + a `COL n` ruler.
- **Widget plates** azure `#82B4DE`; **charts** indigo `#93A7E6` (and only charts get a vertical
  height handle + `px` dimension).
- **Containers** recessive dashed frames with a scope-tinted tab:
  - **local** = CREV purple `#9D7BFF`
  - **shared** = amber `#E0A85A`  (drives the "this affects N pages" warning)
- **Available** (bare space / empty cells) = cyan `#46C9D6`, cross-hatched, with an SVG `+`.
- **Dimension lines**: real SVG lines with arrowheads — horizontal `N / 6` per plate; vertical
  `px` for charts. SVG chevron resize handles. No emoji.
- **Tooltip** (hover): `TYPE · ID · CONTAINER · TAB(id) · TABSET(id) · WIDTH`; container tooltips
  add parent + scope + "dedicated/shared (N pages)"; available zones show free columns + bind
  target.

The `local` vs `shared` decision (purple vs amber) and the tooltip's "N pages" come from a
**live binding-count query**: how many Scorecards bind to the page's TabSet. Dedicated (1) →
container creation is free + clean; shared (>1) → guard creation, never litter.

---

## 7. Safety / ownership model

```
Edit a widget (width/height/move/delete) ............ page-local, always safe
Add a widget / add a container ...................... safe (new objects start unreferenced)
Resize / reorder / rename a SHARED container ........ guarded: "affects N pages" confirm
Delete a non-empty container ........................ re-home widgets first (RESULT-orphan trap)
Anything on a template-backed page .................. warn: edits fan out to N instances
```

Per the rules: container creation goes into the page's existing TabSet ("where it fits"), never a
new TabSet; the dedicated-vs-shared status of that TabSet decides whether creation is free or
guarded.

---

## 8. Phasing

1. **M1 — Blueprint render (read).** Mode switch + overlay + reconstruction + reflow + tooltip.
   No writes. (≈ done as prototype.)
2. **M2 — Width + height edits.** Drag the column unit → `columnsLargeScreen`; chart height
   handle → `chartHeight`. Stage + apply + re-fetch. Shared-container confirm.
3. **M3 — Add.** Empty-cell / bare-space "+ add" → type palette → `sc.add(Type, container := …)`
   (no id) → read back → re-fetch. Container minting "where it fits" when needed.
4. **M4 — Move + delete + reorder.** Re-point `container`; `moveBefore/After`; safe delete with
   re-home. Pending diff + single apply + undo via inverse.

---

## 9. Open questions

- **Binding-count query**: cheapest EC to count Scorecards bound to a TabSet (drives scope tint +
  creation gate). Likely a reverse lookup over the tab's referencing widgets' scorecards.
- **Template-backed pages**: detect instance→template at load and surface the fan-out warning.
- **Move-across-cells gesture**: drag-with-valid-target-highlight vs a "move to cell" picker
  (drop resolution into nested cells is the ambiguous part — likely picker first, drag later).
- **Responsive**: do we expose M/S breakpoints in blueprint mode, or always write sensible
  defaults and edit Large only?

---

## 10. UX design — blueprint as a markup surface

### Edit target (the "what am I editing" signal)

Reuse CREV's existing mechanic, do not reinvent it: `detail-view.ts` already has
`SaveTarget = 'instance' | 'template'`, separate `instanceProps`/`templateProps`, a target
toggle, and `APPLY_OBJECT_CHANGES { target }`. Blueprint mode rides the same path.

The mode chip becomes an **edit-target bar**, always visible:

```
▦ BLUEPRINT    editing ▸ ( INSTANCE | TEMPLATE )    ●3 pending   [Apply] [Discard]
```

- Toggle shown only when the loaded Scorecard has a template (else locked to INSTANCE, exactly
  as detail-view forces `target='instance'` when `state.template` is null).
- **TEMPLATE is the wide-blast-radius mode, so it's AMBIENT, not a per-object badge:** when
  active, the whole sheet gets a thin amber frame and the bar turns amber. You cannot forget
  you are editing the master that fans out to every instance. This is the single, global place
  the template/instance question is asked. (Binding-count, PBAC, lineage are explicitly out.)

### The markup metaphor (works WITHIN "BMP owns the render")

We cannot live-preview the final BMP render, so the blueprint *is* the preview. Edits don't
commit individually — they **annotate the blueprint like markup on a drawing** and accumulate a
pending set:

```
add    → cyan "new" ghost plate + badge
move   → origin faded, SVG arrow to target cell
resize → old span ghosted, arrow, new N/6 dimension
rename → old label struck, new label beside it
delete → plate hatched + strike
```

`Apply` → one EC script for all staged ops → reload → re-measure → annotations clear and the
blueprint snaps to truth. `Discard` drops them. Apply confirm reuses `confirmModal`'s from→to
diff list (the pending-diff), prefixed *"Apply to TEMPLATE — affects all instances"* when
`target==='template'`.

### Gestures (each stages; none commits alone)

| Gesture | How | Within-limit choice |
|---|---|---|
| Select | click plate → glow + handles + compact chip | chip carries necessary free data |
| Resize width | drag right chevron, snap to the column unit; siblings re-flow on the blueprint | the one thing we CAN preview (we own the grid math) |
| Resize height | drag bottom chevron — charts/URLView only → `chartHeight` | |
| Move | select → "move to…" → valid cells highlight → click | picker first (nested-cell drop is ambiguous); drag later |
| Add | click empty/available zone → type palette popover | popover: "add here (binds to tab)" vs "add in a new box" (mints a Container in the current tab; never a new TabSet) |
| Rename | double-click plate label or tab name → inline edit | `change(name:=…)` |
| Delete | select → Del / trash | non-empty container → "re-home N widgets to the tab first?" before staging (RESULT-orphan guard) |
| Reorder | drag the ≡ handle among siblings | `moveBefore/After`; tabs reorder within the page's own tabset |

### Data placement (free + necessary only)

- **Mode bar** → page context once: `Scorecard · Tab · TabSet`.
- **Dimension line** → width `N/6` (inline; not duplicated).
- **Selection chip + slim tooltip** → per-object `name · type · id · container id` only.
- **Plate label** → name + type.

### Palette (no green; amber repurposed)

purple `#9D7BFF` structure · azure/indigo widgets/charts · cyan `#46C9D6` add/available/new ·
amber `#E0A85A` **template-mode ambient only**. Pending ops are op-coded (cyan add, purple
move-arrow, ghost resize, red strike delete).

---

## 11. Build approach

**Browser mockup first, extension second.** Iterate the interaction model + look as an injected
`evaluate_script` overlay (staging faked, no writes) — seconds per iteration, already
pixel-aligned. Freeze the design, then port into the extension and wire to real
`FETCH_LAYOUT_TREE` + `APPLY_OBJECT_CHANGES { target }` + `bmp-client`. The extension is where
correctness/plumbing lives; the mockup is where design lives.

---

## 12. Review findings (2026-06-26)

Two adversarial reviews were run on the pure core and the mockup. Outcomes below.

### Senior-dev code review (pure core)
The reviewer confirmed the load-bearing invariants are CLEAN: create ordering (parent before
child, variable threading), re-home-before-delete, no cross-kind reorder, moveAfter-chain
convergence, immutability, temp-id uniqueness.

Fixed + locked with regression tests (commit b62bb34):
- **P2-A** created nodes dropped M/S responsive widths (only `columnsLargeScreen` emitted). Now
  emitted on `add()`; live-validated.
- **P2-B** a new parent receiving a created child AND a reparented-in existing child got no
  `moveAfter` -> reversed order. Removed the blanket new-parent skip; the natural-order check
  handles it.
- **P2-C** `move(*tab-root*)` resolved the home tab after detach (null) -> widget landed in the
  tabs array. Capture before detach.
- **P3-F** a reparented-away sibling inflated the expected order (spurious no-op moves). Filter
  `survivingBase` by still-same-parent.
- **P3-G** swapping a node with its own descendant orphaned the subtree. Ancestor guard.

Deferred to the load/shell layer (need `chartHeight` + guaranteed `businessId` in the
`FETCH_LAYOUT_TREE` node — a wire-type change):
- **P2-D** `reconstruct` falls back to `rid` as the EC identity when `businessId` is missing;
  `t.<rid>` does not resolve in EC. The load fetch must always supply `businessId`; `ec.ref()`
  should refuse anything that is neither a known temp var nor a real businessId.
- **P3-E** existing `chartHeight` does not round-trip (not in the wire node), so the editor can't
  show or clear an existing height.

### UI/UX review (mockup)
Fixed:
- **Blast-radius signal was inverted** (CRITICAL) — INSTANCE (safe) wore the amber alarm and the
  Apply modal put the scary warning in calm purple. Flipped: TEMPLATE (affects all instances)
  now carries the amber ambient + the prominent modal warning; INSTANCE is calm. (commit pending)

Backlog, ranked (apply during the extension port):
1. **Shared-container scope** — every container renders identical purple; no local/shared tint,
   no "affects N pages" guard. Needs the binding-count query (we deferred it) or a conservative
   "shared, unknown reach" warning.
2. **Swap-on-center is too aggressive** — center (where you grab) = swap is surprising and the
   zone size varies per plate. Make reorder/insert the default; demote swap to an explicit
   affordance. Also: the dropline can imply a row the widget won't land on (re-pack mismatch);
   route same-container reorders through moveBefore/After.
3. **Containers are hard to select** — only the 5px padding ring is clickable, and the label
   appears only after selection. Add persistent low-key container chrome (a clickable name tab).
4. **Surface the honest limits inline** — empty tab won't render until it has a widget;
   non-chart height is content-driven. Both are currently silent (constraints.lint already
   computes the empty-tab case).
5. Smaller: cyan is overloaded (add/selection/drop/primary all cyan); widget-azure vs
   chart-indigo nearly identical (carry the chart distinction with an icon, not hue);
   mode-bar clips "TEMPLATE"; native `confirm()` + Backspace-deletes should be in-app modal +
   explicit affordance; pending-tray per-op remove is unwired; cross-tab move is a blind drop.

---

## 13. Stress test + runtime architecture (2026-06-26)

### Stress (live on demo 4957)
- **Pipeline scales:** an 8-tab / 120-container / 192-widget tree (320 objects, 5-level nesting)
  diffs + compiles in **~8ms** (build 17 / diff 5.9 / compile 1.8). Locked by `scale.test.ts`.
- **BMP execution scales:** an 84-object subset (3 tabs, 30 containers, 51 widgets, **5-level
  variable-threaded nesting**, 8 widget types, M/S widths) executed in **62ms** (~0.7ms/object,
  168 writes) -> a 320-object batch is ~250ms. Well under the 30s EC timeout.
- **Deep variable threading works:** the deepest leaf bound correctly through a 5-level container
  chain, tab auto-inferred.
- **No trash:** create + move produced 0 orphans, no junk folder. **Deleting a Tab cascades its
  container subtree**, but widgets (org-model) orphan to RESULT unless deleted first -> the apply
  order (widgets before containers/tabs) is required. **Idempotent:** re-applying an unchanged
  model emits an empty script; duplicates only arise from naive re-execution, which the
  diff+refetch loop never does.
- Bug found by executing for real: widget `add()` omitted `name` (would land as BMP defaults);
  fixed.

### Runtime architecture — the good news
EC execution and all BMP I/O already run **in the MV3 service worker, off the page main thread**
(`bmp-client.executeEc` -> `bmp-transport` `fetch('/cs/command')`). So a slow/large EC call, the
multi-MB binary response, and Java deserialization **cannot jank or crash the BMP tab**. EC has a
30s timeout + AbortSignal; auth survives SW termination (persisted to `chrome.storage.session`),
reconnect re-auths on wake, and a 401 at Apply is auto-retried with a fresh token. The batch
engine (`layout/diff|ec|edit|history`) is built but **not yet wired** — the blueprint is what
first activates it.

### Top runtime risks for the blueprint (with mitigations)
1. **Wrong-environment Apply on profile switch mid-flight.** `EC_EXECUTE` reads the live mutable
   `ctx.client` with no profile guard; switching dev->prod during a transactional Apply can land
   EC on the wrong env. **Fix:** capture `activeProfileId` (or the specific `BmpClient`) when the
   Apply request is created, re-check before each `executeEc`; disable profile switch while an
   Apply is in flight.
2. **Stale-baseline batch Apply (no refetch-before-apply / version check).** A reorder/reparent/
   delete against a tree that shifted underneath can silently produce the wrong layout. **Fix:**
   refetch + re-diff (or hash-gate the loaded subtree) immediately before commit; surface a "BMP
   changed underneath you" gate.
3. **Render host = the one tab-crash vector.** Injecting 100s of plates into BMP's observed DOM
   would feed the content MutationObserver (its self-filter only ignores `crev-label`/`crev-tooltip`)
   -> runaway on a dense page. **Fix:** host the overlay in an **extension iframe**
   (`content-frame-overlay.ts` pattern) or the side panel, NOT in BMP's DOM. Cap/virtualize plates
   (reuse the existing ~30-row budget / MAX_DEPTH 6). The blueprint owns its own `ResizeObserver`
   guard (the codebase has none today).
4. **SW reaped mid-transactional-Apply** -> partial commit + lost result. **Fix:** a
   `chrome.alarms`/port-ping keepalive for the Apply window, and always reconcile via refetch
   rather than trusting the response.
5. **Global-per-window edit state vs per-tab page context.** The side panel is per-window; editing
   scorecard A then switching browser tab to B leaves A's model active. **Fix:** stamp the model
   with its origin `{tabId, scorecardRid, tabRid}`; block Apply on context drift with a banner.

Net: the I/O architecture is well-suited (SW isolation); the work is concentrated in the
apply-time guards (env + staleness + keepalive) and choosing the iframe/side-panel render host.
