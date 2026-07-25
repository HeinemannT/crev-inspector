/**
 * Entry point for content-blueprint.js — the lazily-injected Blueprint layout editor.
 * Split out of the always-on content bundle: Blueprint (~150 KB, 58% of the old content.js — the
 * `content-blueprint/*` modules + the shared `lib/layout/*` they pull in) is a Ctrl+Shift+B tool, not
 * something every page load of a granted BMP origin needs. content.ts requests this file via the SW's
 * `chrome.scripting.executeScript` on the tab's FIRST blueprint activation; every activation after
 * that just talks to the already-injected script.
 *
 * Bridge to content.ts: every content script the extension injects into one tab shares ONE
 * ISOLATED-world `window` (confirmed in live browser testing). content.ts can't hand this script a
 * live JS reference any other way (module closures don't cross a separate `chrome.scripting`
 * injection), so:
 *   - the page-rid RESOLVER is a closure content.ts publishes onto `window.__crevBpResolver` — it
 *     closes over content.ts's own ContentState (fiberPageContext), so this script always sees the
 *     current page context by calling through the reference, not by copying a value.
 *   - ACTIVATION is a `crev-bp-cmd` CustomEvent on `document` (mirrors the existing crev-content /
 *     crev-interceptor CustomEvent convention between the MAIN-world interceptor and this ISOLATED
 *     world). Commands issued before this file attaches its listener are buffered in
 *     `window.__crevBpPendingCmds`, then drained in order on initialization.
 */
import { enableBlueprint, disableBlueprint, setBlueprintRidResolver, setBlueprintResumePrefer } from './content-blueprint';
import { resetColorSets } from './content-blueprint/colors';
import { resetFlowRefsCache } from './content-blueprint/service';
import { log } from './lib/logger';

type BlueprintCmd =
  | { cmd: 'enable' }
  | { cmd: 'disable' }
  | { cmd: 'resetOverlayCaches' }
  | { cmd: 'setResumePrefer'; prefer: 'template' | 'instance' };

declare global {
  interface Window {
    /** Published by content.ts — resolves "what BMP object is this page showing", same URL ⊕ fiber
     *  rule as the Page tab. Read once at init; the reference itself stays live (content.ts's closure
     *  reads fresh ContentState on every call), so re-reading it here per-call isn't needed. */
    __crevBpResolver?: () => string | undefined;
    /** One-shot edit-target override for the NEXT enable, set by content.ts's post-apply resume
     *  before this script has necessarily loaded — consumed (and cleared) on init. */
    __crevBpResumePrefer?: 'template' | 'instance';
    /** True once THIS script has attached its `crev-bp-cmd` listener. content.ts reads it to decide
     *  whether to dispatch a command live or buffer it in `__crevBpPendingCmds`. */
    __crevBpEntryReady?: boolean;
    /** Order-preserving buffer of commands content.ts issued before the listener existed (the very
     *  first activation, whose injection request fires before this file finishes loading). Drained in
     *  order on init below; every command after that flows live through the CustomEvent. */
    __crevBpPendingCmds?: BlueprintCmd[];
    /** Re-injection guard (mirrors `window.__crev_content_loaded` in content.ts) — a second
     *  chrome.scripting.executeScript into the same tab re-runs this file with a FRESH module scope
     *  (a new `bp` singleton, new resize/keydown/mutation listeners), so the previous instance must
     *  tear itself down first or its listeners leak and double-fire. */
    __crevBpEntryLoaded?: boolean;
    __crevBpEntryTeardown?: () => void;
  }
}

// Lifetime for THIS instance's document listener. A re-injection (executeScript re-runs this file in
// the same isolated world with a FRESH module scope + its own `bp` singleton) must detach the
// previous instance's listener — otherwise both fire on the next command and two independent editors
// enable at once. The previous instance's teardown, parked on window, aborts this controller.
const cmdLifetime = new AbortController();

/** Shape-guard for the `crev-bp-cmd` detail. `document` is shared with the page's own
 *  MAIN-world scripts (same mechanism that lets the interceptor talk to content.ts), so a
 *  compromised/XSS'd page could dispatch a forged event here — validate before acting.
 *  This channel has no apply path (a layout commit needs baseline+desired supplied by the
 *  side panel — see handlers/layout.ts), so a forged well-formed command is bounded to
 *  UI-state redress; shape-validation (allowlist of the four known shapes) is proportionate
 *  — see plan 016's SEC-02 scope note for why a nonce handshake isn't warranted here. */
function parseBlueprintCmd(detail: unknown): BlueprintCmd | null {
  if (typeof detail !== 'object' || detail === null) return null;
  const d = detail as Record<string, unknown>;
  if (d.cmd === 'enable' || d.cmd === 'disable' || d.cmd === 'resetOverlayCaches') {
    return { cmd: d.cmd };
  }
  if (d.cmd === 'setResumePrefer' && (d.prefer === 'template' || d.prefer === 'instance')) {
    return { cmd: 'setResumePrefer', prefer: d.prefer };
  }
  return null;
}

function handleCmd(detail: BlueprintCmd): void {
  switch (detail.cmd) {
    case 'enable': enableBlueprint(); break;
    case 'disable': disableBlueprint(); break;
    case 'resetOverlayCaches': resetColorSets(); resetFlowRefsCache(); break;
    case 'setResumePrefer': setBlueprintResumePrefer(detail.prefer); break;
  }
}

document.addEventListener('crev-bp-cmd', ((event: CustomEvent) => {
  const detail = parseBlueprintCmd(event.detail);
  if (detail) handleCmd(detail);
}) as EventListener, { signal: cmdLifetime.signal });

function teardown(): void {
  cmdLifetime.abort();
  disableBlueprint();
}

// Re-injection guard — see window.__crevBpEntryLoaded above.
if (window.__crevBpEntryLoaded) {
  try { window.__crevBpEntryTeardown?.(); } catch (e) { log.swallow('contentBlueprint:teardownPrev', e); }
}
window.__crevBpEntryLoaded = true;
window.__crevBpEntryTeardown = teardown;

if (window.__crevBpResolver) setBlueprintRidResolver(window.__crevBpResolver);

// Resume-prefer must land BEFORE the pending-enable check below — enableBlueprint() reads it
// synchronously at call time (see content-blueprint.ts's `resumePrefer` one-shot).
if (window.__crevBpResumePrefer) {
  setBlueprintResumePrefer(window.__crevBpResumePrefer);
  window.__crevBpResumePrefer = undefined;
}

// Drain any commands content.ts buffered before this listener existed (the first-injection window),
// in the order they were issued, then let subsequent commands flow live. Snapshot + clear the queue
// and flip the ready flag BEFORE replaying, so a command that arrives mid-drain is dispatched live
// (through the already-attached listener above) rather than lost or double-run — an on→off toggle
// that raced injection therefore ends in the user's LAST intent, not a hardcoded enable.
const pendingCmds = window.__crevBpPendingCmds ?? [];
window.__crevBpPendingCmds = undefined;
window.__crevBpEntryReady = true;
for (const cmd of pendingCmds) handleCmd(cmd);
