# TODO

Low-priority follow-ups (not blocking).

- **Access Trace scroll — make it precise.** `rerender()` currently preserves the
  body scroll on *every* re-render (fixes the expand-jumps-to-top complaint). The
  "proper" version would preserve scroll only on expand/collapse and reset to the
  top on new content (a fresh trace / action change / subject change). No real
  downside to the proper version — it's just a `keepScroll` flag threaded through
  the rerender callers. Current behaviour is fine; the only edge it gets slightly
  wrong is restoring the old scroll position after re-tracing with a different
  action instead of scrolling to top. (`src/sidepanel/access-trace.ts:rerender`)

- **editor.ts vars-filter focus** — still uses the older `varsFilterRefocus`
  pattern. Not buggy (it captures the caret before its synchronous render), so
  migrating to `captureTypingFocus` (`src/lib/focus-keep.ts`) is consistency-only,
  and would require making that input a persistent node first.
