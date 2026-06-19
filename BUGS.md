# CREV Inspector — known bugs / backlog

Running list of confirmed-but-not-yet-fixed issues. Newest on top.

## Open

_None._

## Fixed

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
