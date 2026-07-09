/**
 * Entry point for content-blueprint.js — the lazily-injected Blueprint layout editor (plans/009).
 * Split out of the always-on content bundle: Blueprint (~150 KB, 58% of the old content.js — the
 * `content-blueprint/*` modules + the shared `lib/layout/*` they pull in) is a Ctrl+Shift+B tool, not
 * something every page load of a granted BMP origin needs. content.ts requests this file via the SW's
 * `chrome.scripting.executeScript` on the tab's FIRST blueprint activation; every activation after
 * that just talks to the already-injected script.
 *
 * Bridge to content.ts: every content script the extension injects into one tab shares ONE
 * ISOLATED-world `window` (confirmed live — plans/009 Phase 0). content.ts can't hand this script a
 * live JS reference any other way (module closures don't cross a separate `chrome.scripting`
 * injection), so:
 *   - the page-rid RESOLVER is a closure content.ts publishes onto `window.__crevBpResolver` — it
 *     closes over content.ts's own ContentState (fiberPageContext), so this script always sees the
 *     current page context by calling through the reference, not by copying a value.
 *   - ACTIVATION is a `crev-bp-cmd` CustomEvent on `document` (mirrors the existing crev-content /
 *     crev-interceptor CustomEvent convention between the MAIN-world interceptor and this ISOLATED
 *     world), with `window.__crevBpPendingEnable` as the fallback for the very first activation — the
 *     command that triggered this script's injection is fired before this file finishes loading and
 *     attaches its listener, so a bare CustomEvent dispatch would be lost on that first race.
 */
import { enableBlueprint, disableBlueprint, setBlueprintRidResolver, setBlueprintResumePrefer } from './content-blueprint';
import { resetColorSets } from './content-blueprint/colors';
import { log } from './lib/logger';

type BlueprintCmd =
  | { cmd: 'enable' }
  | { cmd: 'disable' }
  | { cmd: 'resetColors' }
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
    /** Set by content.ts immediately before requesting this file's injection (first activation only)
     *  — this script's `crev-bp-cmd` listener isn't attached yet when that injection request fires,
     *  so the enable command would otherwise be dropped. Consumed (and cleared) on init; every
     *  activation after that goes through the CustomEvent instead. */
    __crevBpPendingEnable?: boolean;
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

document.addEventListener('crev-bp-cmd', ((event: CustomEvent<BlueprintCmd>) => {
  const detail = event.detail;
  switch (detail.cmd) {
    case 'enable': enableBlueprint(); break;
    case 'disable': disableBlueprint(); break;
    case 'resetColors': resetColorSets(); break;
    case 'setResumePrefer': setBlueprintResumePrefer(detail.prefer); break;
  }
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

// Honor a first-activation request that raced this script's own load.
if (window.__crevBpPendingEnable) {
  window.__crevBpPendingEnable = false;
  enableBlueprint();
}
