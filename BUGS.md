# CREV Inspector — known bugs / backlog

Running list of confirmed-but-not-yet-fixed issues. Newest on top.

## Open

_None._

## Backlog — Inspect mode improvements

Deliberately kept OUT of Blueprint flow editing (decision 2026-07-11): Blueprint creates/arranges
flow objects; configuring them stays in Inspect. These are the Inspect-side follow-ups:

- **EditField property picker**: `propertyMapping` edited as a dropdown/autocomplete populated live
  from the owning CreateObjectView's `objectType` template (fields of `ceras.default_riskstatement`
  etc.), not a free-text string. Same pattern as the PBAC Architect property autocomplete.
- **HTML-first editing for advanced-mode fields**: `Label.defaultExpression` / `EditPageInfo.expression`
  with `advancedDefault`/`advancedMode` hold an EC expression *returning* an HTML string. Offer an
  "edit as HTML" mode that unwraps the string literal into the editor as HTML (with highlighting)
  and re-wraps/escapes on save; fall back to plain EC when the expression isn't a single literal.
- **Flow-object quick-config pane**: selecting a flow child (input, EditField, transport) in the
  Blueprint flow list opens Inspect on it; the pane should surface the type's 2–3 defining knobs
  (key, required, buttonText, actionType…) at the top instead of the generic property dump.
- Candidate ideas (unreviewed): show/enable expression toggles (`useShowExpression` gates) as
  paired toggle+editor rows; a "test this validation" dry-run button on Validation objects;
  ButtonInput `key` cross-reference check (does any sibling field use it).

## Fixed

### Blueprint Exit (X) does nothing after the SW idle-restarts — FIXED 2026-07-10
- Symptom: open Blueprint, edit for a while, click the ✕ (Exit) in the command chip → nothing happens,
  the overlay stays up. Same for `Ctrl+Shift+B` and the side-panel Blueprint toggle. Other chip buttons
  (undo/redo/tray/discard/apply/peek) were fine.
- Root cause: leaving Blueprint went through `BLUEPRINT_TOGGLE`, whose handler flips the SW's in-memory
  `blueprintActiveByWindow` map. That map is NOT persisted; an MV3 service-worker idle→restart (≈30 s of
  no SW events — trivial to hit mid-edit, since all editing is content-side DOM work) rebuilds it EMPTY.
  `toggleBlueprint` then computes `next = !map.get(wid)` = `!undefined` = **true** and RE-activates
  instead of turning off. The content overlay lives in the content script (survives SW restart), so it
  never went away → "X does nothing".
- Fix: persist `blueprintActiveByWindow` (+ `blueprintTabByWindow`) to `chrome.storage.session`, exactly
  as `inspectActiveByWindow` already was (service-worker.ts:40-45, 167-215). `restoreBlueprintState()`
  runs inside the boot `Promise.all` that gates `settingsReady`, and every handler `await`s
  `settingsReady` — so the map is repopulated BEFORE any toggle/exit handler runs. No reconnect-timing
  race. `ctx.persistBlueprintState()` is called after every mutation (setBlueprintActive, the
  profile-switch clear, the tab-navigate session-end); closed windows are dropped at boot + on
  `windows.onRemoved` so a recycled window id can't inherit stale state.
- Why this over a point-fix: the codebase already had the canonical MV3 pattern for exactly this class
  (inspect). Blueprint just never adopted it. An earlier deterministic-message + content-rehydration
  attempt worked for the ✕ button but was inconsistent with that pattern AND still raced on
  `Ctrl+Shift+B` (the command wakes the SW and can run before the content port rehydrates). Persistence
  fixes all three exit affordances race-free with one pattern.
- Class audit (other in-memory SW toggles): inspect — already persisted (fine). Paint (`paintPhase`) —
  not persisted but fail-safe: SW-reset means "off" and reconnect re-pushes it (paint.ts:29), so it's
  never stuck-on. `technicalOverlay` — global bool, minor. Blueprint was the only stuck-ON case because
  its content init deliberately does NOT re-push state on reconnect (to preserve in-progress edits).
- Tests: `handlers-layout-blueprint.test.ts` — asserts `setBlueprintActive` persists on a real
  transition and skips the persist on a true no-op; the three ctx harnesses gain `persistBlueprintState`.

### Duplicate editor windows + inspect re-opening itself — FIXED 2026-06-19
- Two symptoms, one root cause: re-injection leaked the previous content-script instance.
  `chrome.scripting.executeScript({files:['content.js']})` (fired by `ensureContentScript`
  whenever `contentPorts` is empty, i.e. after every MV3 SW idle→restart) re-runs `content.ts`
  in the SAME isolated world but with FRESH module closures. The old `__crev_content_loaded`
  guard only called `resetContentState()`, which operates on the NEW module's `ContentState` and
  cannot reach the OLD module's closures — so each re-injection stacked another live instance.
- (a) **Two editor windows on EC-button click:** old + new `chrome.runtime.onMessage` listeners
  both received the single `MOUNT_FRAME`, each calling `mountFrameOverlay` against its OWN
  `frames` Map → two overlays, no cross-dedup.
- (b) **Inspect re-opens "after some time":** the orphaned old instance kept a live reconnecting
  port + MutationObserver + `crev_sync_inspect` subscription; on its reconnect the SW re-pushed
  `INSPECT_STATE` and the stale observer re-painted badges out of step with the visible toggle.
- Fix: each instance parks a full `teardown()` on `window.__crev_teardown`; a re-injection runs
  the PREVIOUS instance's teardown (reachable only via `window`) before booting. Teardown disposes
  the port (`ReconnectingPort.destroy()` + `disconnectPort()`), the one-shot message listener,
  the cross-tab storage subscription (`teardownCrossTab()`), the observer, and all lifetime-bound
  document listeners (contextmenu/keydown/click/interceptor now attach with `listenerLifetime.signal`).
  Plus a defensive `mounting` guard in `mountFrameOverlay` closes the `await readBounds` TOCTOU
  window so two same-kind mounts can't both append a host.
- Follow-up (review): the SW's content-port `onDisconnect` deleted `contentPorts` by `tabId`
  WITHOUT an identity check (unlike the panel handler). Since teardown now disconnects the old
  port right before the new instance connects a new port for the same tabId, an out-of-order old
  `onDisconnect` could evict the live new port → `ensureContentScript` re-injects again (loop) and
  `toggleInspect`/`broadcastToContent` miss the tab. Fixed with `if (contentPorts.get(tabId) === port)`.

### Footer context ≠ object-detail; didn't update across workspaces — FIXED 2026-06-01
- Footer chip + Workshop layout context + detail view read from three different sources, and nothing reset on workspace/profile switch (per-tab `contextRid` map + panel state kept workspace-A RIDs).
- Fix: footer now mirrors the detail object (`OBJECT_PANE_DATA`); `PROFILE_SWITCHED` (now also sent on manual switch) resets footer + detail + Workshop context; `clearAllContextRids()` runs on every profile switch.

### Edit ↗ always opened `expression`, ignoring the requested property — FIXED 2026-06-01
- An object with several code fields (ActionButton: `expression` / `afterExpression` / `showExpression`, Label: `defaultExpression`, …) shows an Edit button per field; clicking any opened the editor on `expression`.
- Root cause (not flow-specific): `fetchEditorContext` only fetched `['expression','html','javascript']`, so the requested prop wasn't in the code map → `openEditorWindow` saw the hint had no content and fell back to the first key (`expression`).
- Fix: `fetchEditorContext(rid, extraProps)` includes the caller's requested property (validated); `openEditorWindow` passes `preferredProperty`. Affects every `OPEN_EDITOR` caller.
