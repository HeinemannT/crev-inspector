/** Centralized constants — no more magic numbers scattered across the codebase */

// ── Network timeouts ─────────────────────────────────────────────
export const HEALTH_POLL_INTERVAL = 30_000;
export const HEALTH_TIMEOUT = 5_000;
export const AUTH_TIMEOUT = 10_000;
export const EC_TIMEOUT = 30_000;
/** Blueprint layout fetch/apply EC — walks every widget of a page (plus override + style channels),
 *  which on a heavy live scorecard legitimately outlives the general EC_TIMEOUT. In-flight fetches
 *  keep the MV3 service worker alive, so the longer window is safe. */
export const LAYOUT_EC_TIMEOUT = 120_000;
/** AI layout reads use the lean structural projection and share one short
 * deadline across context resolution + fetch. They must never occupy a bridge
 * slot for Blueprint's two-minute authoring window. */
export const AI_LAYOUT_EC_TIMEOUT = 20_000;
/** Flat workspace-colour enumeration should be sub-second even on large
 * workspaces. Bound a pathological/cold server so the picker can show Retry
 * instead of remaining in an indefinite loading state. */
export const COLOR_SETS_EC_TIMEOUT = 10_000;
/** Workshop's read-only portal skeleton should be tiny and fast. A bounded
 * deadline keeps a pathological shared TabSet from wedging the pane. */
export const LAYOUT_TREE_EC_TIMEOUT = 10_000;
/** Small relationship reads (template resolution and immediate children)
 * should complete quickly. A short bound lets callers distinguish a failed
 * read from a genuine "no template / no children" result and offer Retry. */
export const OBJECT_RELATION_EC_TIMEOUT = 10_000;

// ── Enrichment ───────────────────────────────────────────────────
export const BATCH_CHUNK_SIZE = 25;
export const MAX_PARALLEL = 4;
export const ENRICHMENT_RETRY_DELAY = 15_000;
export const MAX_PERMANENTLY_FAILED = 500;

// ── Object cache ─────────────────────────────────────────────────
export const CACHE_MAX_SIZE = 5_000;
export const CACHE_SAVE_DELAY = 2_000;

// ── Activity log ─────────────────────────────────────────────────
// Ring buffer for the activity feed. 50 was way too tight once we started
// logging edits, EC runs, paint, pins, context-set — a normal session burned
// through it in 2-3 min and the user lost everything beyond. 300 keeps about
// an hour of activity at ~30 KB total which is well below the storage quota.
export const ACTIVITY_MAX = 300;
export const ACTIVITY_PERSIST_DELAY = 500;

// ── Content script ───────────────────────────────────────────────
export const RECONNECT_INITIAL_DELAY = 200;
export const RECONNECT_MAX_DELAY = 10_000;
export const OVERLAY_SYNC_DEBOUNCE = 150;
export const DISCOVERED_RIDS_CAP = 5_000;
export const ACTIVITY_DISPLAY_TIMEOUT = 3_000;
export const FLASH_INVALID_DURATION = 1_500;

// ── Service worker ───────────────────────────────────────────────
export const MANUAL_OVERRIDE_DURATION = 30_000;

// ── History & Favorites ─────────────────────────────────────────
export const HISTORY_MAX = 30;
export const FAVORITES_MAX = 20;
export const HISTORY_SAVE_DELAY = 1_000;

// ── Side panel ───────────────────────────────────────────────────
export const DISPLAY_LIMIT_STEP = 200;
export const SEARCH_DEBOUNCE = 300;
export const LOOKUP_WATCHDOG_TIMEOUT = 15_000;

// ── Diff ─────────────────────────────────────────────────────────
export const COMMON_DIFF_PROPS = [
  'name', 'description', 'sortIndex',
  'headerColor', 'fontColor', 'transparency', 'shadow', 'headerStyle', 'borderStyle',
] as const;

// ── Code Search ──────────────────────────────────────────────────
export const CODE_SEARCH_BATCH_SIZE = 25;
/** Bound the amount of code pulled client-side for one class. A broad search
 *  that exceeds this limit is reported as incomplete instead of silently
 *  returning a prefix (or overflowing EC's string accumulator). */
export const CODE_SEARCH_RID_CAP_PER_TYPE = 500;
/** Flush small RID groups into the main EC result accumulator. BMP can turn
 *  long left-associative concatenation chains into MISSING. */
export const CODE_SEARCH_RID_CHUNK_SIZE = 32;

// ── Script History ───────────────────────────────────────────────
export const SCRIPT_HISTORY_MAX = 10;
