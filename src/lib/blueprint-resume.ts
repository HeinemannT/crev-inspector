/**
 * sessionStorage key for the post-apply Blueprint resume flag. Written by
 * content-blueprint/service.ts (applyPage, right before it reloads the page — the live grid can only
 * reflow on a real load) and read by content.ts on boot (content.ts is always-on; Blueprint isn't —
 * see plans/009). Kept in its own tiny module rather than defined in content-blueprint/service.ts so
 * content.ts can read the constant WITHOUT statically pulling the ~150 KB Blueprint editor (and its
 * `lib/layout/*` dependency) into the always-on content bundle.
 */
export const BP_RESUME_KEY = 'crev_bp_resume';
