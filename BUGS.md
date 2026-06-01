# CREV Inspector — known bugs / backlog

Running list of confirmed-but-not-yet-fixed issues. Newest on top.

## Open

_None._

## Fixed

### Footer context ≠ object-detail; didn't update across workspaces — FIXED 2026-06-01
- Footer chip + Workshop layout context + detail view read from three different sources, and nothing reset on workspace/profile switch (per-tab `contextRid` map + panel state kept workspace-A RIDs).
- Fix: footer now mirrors the detail object (`OBJECT_PANE_DATA`); `PROFILE_SWITCHED` (now also sent on manual switch) resets footer + detail + Workshop context; `clearAllContextRids()` runs on every profile switch.

### Edit ↗ always opened `expression`, ignoring the requested property — FIXED 2026-06-01
- An object with several code fields (ActionButton: `expression` / `afterExpression` / `showExpression`, Label: `defaultExpression`, …) shows an Edit button per field; clicking any opened the editor on `expression`.
- Root cause (not flow-specific): `fetchEditorContext` only fetched `['expression','html','javascript']`, so the requested prop wasn't in the code map → `openEditorWindow` saw the hint had no content and fell back to the first key (`expression`).
- Fix: `fetchEditorContext(rid, extraProps)` includes the caller's requested property (validated); `openEditorWindow` passes `preferredProperty`. Affects every `OPEN_EDITOR` caller.
