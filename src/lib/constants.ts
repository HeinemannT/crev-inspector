/** Centralized constants — no more magic numbers scattered across the codebase */

// ── Network timeouts ─────────────────────────────────────────────
export const HEALTH_POLL_INTERVAL = 30_000;
export const HEALTH_TIMEOUT = 5_000;
export const AUTH_TIMEOUT = 10_000;
export const EC_TIMEOUT = 30_000;

// ── Enrichment ───────────────────────────────────────────────────
export const BATCH_CHUNK_SIZE = 25;
export const MAX_PARALLEL = 4;
export const ENRICHMENT_RETRY_DELAY = 15_000;
export const MAX_PERMANENTLY_FAILED = 500;

// ── Object cache ─────────────────────────────────────────────────
export const CACHE_MAX_SIZE = 5_000;
export const CACHE_SAVE_DELAY = 2_000;

// ── Activity log ─────────────────────────────────────────────────
export const ACTIVITY_MAX = 50;
export const ACTIVITY_PERSIST_DELAY = 500;

// ── Content script ───────────────────────────────────────────────
export const RECONNECT_INITIAL_DELAY = 200;
export const RECONNECT_MAX_DELAY = 10_000;
export const OVERLAY_SYNC_DEBOUNCE = 150;
export const DISCOVERED_RIDS_CAP = 5_000;

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

// ── Script History ───────────────────────────────────────────────
export const SCRIPT_HISTORY_MAX = 10;
