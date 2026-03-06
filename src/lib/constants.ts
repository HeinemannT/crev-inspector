/** Centralized constants — no more magic numbers scattered across the codebase */

// ── Network timeouts ─────────────────────────────────────────────
export const HEALTH_POLL_INTERVAL = 10_000;
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
export const DETECTION_DEBOUNCE = 2_000;
export const OVERLAY_SYNC_DEBOUNCE = 150;

// ── Service worker ───────────────────────────────────────────────
export const MANUAL_OVERRIDE_DURATION = 30_000;

// ── Side panel ───────────────────────────────────────────────────
export const DISPLAY_LIMIT_STEP = 200;
export const SEARCH_DEBOUNCE = 300;
export const LOOKUP_WATCHDOG_TIMEOUT = 15_000;
