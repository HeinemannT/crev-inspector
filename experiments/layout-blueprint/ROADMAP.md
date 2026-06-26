# Blueprint Mode — production roadmap

From "verified core" to a production in-browser layout builder for BMP pages. Each phase ships
something usable. After each phase: reflect, readjust, review before starting the next.

## State

| Layer | State |
|-------|-------|
| Functional core (`src/lib/layout/{types,model,edit,diff,ec,constraints,history}`) | done, tested, golden live-validated |
| `sync` (load / apply / enterprise resolution) | done, injected IO, tested |
| Page coverage (Scorecard / ModelPage / WebParent + Enterprise via template) | verified live |
| Knowledge (`skills/bmp-platform/reference/page-hosting.md`) | done |
| Imperative shell (IO→bmp-client, message handler, context resolution) | **Phase 1** |
| Safety rails (5 §13 risks, rollback detection, blast radius) | **Phase 2** |
| Interactive on-page UI | **Phase 3** |
| Palette / composites / display names | **Phase 4** |
| Hardening & rollout | **Phase 5** |

## Phase 1 — Headless apply path

Load→edit→apply against live BMP with NO UI; testable in isolation.
- IO adapter: `LayoutIO.exec` → `bmp-client.executeEc`; `LAYOUT_LOAD` / `LAYOUT_APPLY` handlers.
- `resolvePageContext(io, rid)`: Direct vs Enterprise; resolve `{pageRid, pageId, tabsetId, tabScope, target}`. Enterprise solved; **Direct tabset discovery** is the open bit (widget→tab→tabset walk).
- Rollback detection: BMP returns HTTP 200 + empty error on in-script rollback — scan the log (the `useBmpSave` pattern). Apply must fail loudly.
- **DoD**: dev harness loads any real page → applies an edit → re-fetch shows it; idempotent re-apply = no-op; forced failure reports cleanly.

## Phase 2 — Safety rails

Before any mutation UI.
- 5 §13 risks: wrong-env apply, stale baseline, render-host feedback loop, SW reaped mid-apply, per-window state.
- Blast radius: template/enterprise edits hit all instances — explicit, loud confirm.
- Permissions/PBAC: no edit affordance where the user can't write.
- **DoD**: mid-edit env switch blocks apply; concurrent external change detected; template/enterprise edits gated.

## Phase 3 — Interactive on-page UI

Port mockup → content-script overlay over the live DOM. Shippable sub-milestones:
1. read-only overlay (pixel-aligned) → 2. select+resize → 3. drag-drop (move/swap/insert) →
4. add/delete/rename → 5. tab management → 6. apply-preview modal → 7. undo/redo + responsive.
- **DoD**: full edit session on a real page, faithful, applies correctly, honors save→reload.

## Phase 4 — Palette & composites

- Live add-palette per `(host, model)`; real display names (localization); searchable picker.
- Composite-add compile branch (`bc.add(child)`) + constraint guard.
- **DoD**: add any valid widget on any host; composites work; palette matches BMP's add menu.

## Phase 5 — Hardening & rollout

Integration tests vs live BMP, e2e in-extension; applied-EC audit log + telemetry; large-page +
shared-tabset perf; a11y/keyboard/error UX; feature flag + staged rollout; docs.

## Sequencing

1 → 2 → 3 strict (no mutation UI before safety). 4 parallels late 3. 5 continuous.
First internal alpha = Phases 1–2 + milestones 3.1–3.3 (select/resize/drag with safe apply).

## Production bar (every phase)

Every generated EC pattern live-validated before ship; apply idempotent + re-fetch-authoritative;
no wrong-env/stale-baseline apply; rollback never read as success; pure core stays pure; knowledge
flows back to `skills/`.
