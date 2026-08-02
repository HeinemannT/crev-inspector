/**
 * Runtime type-availability for the property pane.
 *
 * The static mixin sets in `pane-schema.ts` (RESPONSIVE_WIDTH_TYPES,
 * HAS_TOOLS_MENU_TYPES, …) were reverse-engineered from decompiled
 * BeanInfo and curated by hand. Every missed type produced a user
 * complaint ("bubble chart doesn't show the Display group") and a
 * patch to extend the relevant Set.
 *
 * This module replaces that hand-maintained ground truth with live
 * introspection: when DetailView opens an object of type X, we ask
 * the SW for X's property schema via FETCH_TYPE_SCHEMA. The response
 * lists every property the type has (system + custom). We keep a
 * per-type Set<propName> here; the property pane consults it via
 * `isPropAvailable(type, propName)` and overrides the hardcoded
 * mixin set when an answer exists.
 *
 * Fallback (no schema yet): the static `availableOn` Set still
 * applies. So the UI is correct from the first render and gets MORE
 * correct (catches missed mixins) as the schema lands.
 *
 * Cache lives in this module — survives DetailView re-renders. SW
 * already caches the schema separately (via type-schema-cache.ts),
 * so re-asking after a profile switch will be cheap.
 */

import type { InspectorMessage, TypeSchemaProp } from '../lib/types';
import { subscribe as subscribeBroadcast } from '../lib/handler-registry';

type SendFn = (msg: InspectorMessage) => void;

/** typeName → set of all property accessors the type carries. */
const cache = new Map<string, Set<string>>();
const propsCache = new Map<string, TypeSchemaProp[]>();
const errors = new Map<string, string>();
/** Types we've fired FETCH_TYPE_SCHEMA for but haven't received a
 *  result. Prevents request floods when DetailView re-renders. */
const inflight = new Set<string>();
/** Subscribers fire when the cache changes — DetailView re-renders
 *  via its own `renderDetail()` path. */
const listeners = new Set<() => void>();
let currentEnvironment: string | null = null;
const keyFor = (type: string, environment = currentEnvironment): string =>
  `${environment ?? 'unknown'}::${type}`;

function switchEnvironment(environment: string | null): void {
  if (environment === currentEnvironment) return;
  currentEnvironment = environment;
  inflight.clear();
  for (const listener of listeners) listener();
}

// Subscribe at module load so FETCH_TYPE_SCHEMA_RESULT lands in our
// cache regardless of which tab is active when the response arrives.
// Without this, switching away from Workshop while a schema fetch is
// in flight would lose the result (Workshop's handleMessage only
// fires while it's the active tab); the inflight flag would stay
// set forever and the schema would never be cached.
subscribeBroadcast('FETCH_TYPE_SCHEMA_RESULT', (msg) => {
  consumeSchemaResult(msg);
});
subscribeBroadcast('FETCH_TYPE_SCHEMAS_RESULT', (msg) => {
  if (msg.type !== 'FETCH_TYPE_SCHEMAS_RESULT') return;
  for (const result of msg.results) {
    consumeSchemaResult({
      type: 'FETCH_TYPE_SCHEMA_RESULT',
      ...result,
      environment: msg.environment,
    });
  }
});
subscribeBroadcast('CONNECTION_STATE', (msg) => {
  if (msg.type === 'CONNECTION_STATE') switchEnvironment(msg.state.environment ?? null);
});
subscribeBroadcast('PROFILE_SWITCHED', (msg) => {
  if (msg.type === 'PROFILE_SWITCHED') switchEnvironment(`switching:${msg.profileId}`);
});

/** Ask the SW to fetch the property schema for `type`. Idempotent. */
export function requestSchema(type: string, send: SendFn): void {
  if (!type) return;
  const key = keyFor(type);
  if (cache.has(key)) return;
  if (inflight.has(key)) return;
  inflight.add(key);
  send({ type: 'FETCH_TYPE_SCHEMA', className: type });
}

/** Request several schemas as one logical job so BMP's serialized command
 * queue is not flooded with overlapping one-shot requests and false timeouts. */
export function requestSchemas(types: readonly string[], send: SendFn): void {
  const missing = [...new Set(types)].filter(type => {
    if (!type) return false;
    const key = keyFor(type);
    return !cache.has(key) && !inflight.has(key);
  });
  if (missing.length === 0) return;
  for (const type of missing) inflight.add(keyFor(type));
  send({ type: 'FETCH_TYPE_SCHEMAS', classNames: missing });
}

/** Internal — invoked by the broadcast subscriber above. */
export function consumeSchemaResult(msg: InspectorMessage): boolean {
  if (msg.type !== 'FETCH_TYPE_SCHEMA_RESULT') return false;
  if (msg.environment && currentEnvironment && msg.environment !== currentEnvironment) return false;
  if (msg.environment && !currentEnvironment) currentEnvironment = msg.environment;
  const key = keyFor(msg.className, msg.environment ?? currentEnvironment);
  inflight.delete(key);
  if (!msg.ok || !msg.props) {
    errors.set(key, msg.error ?? 'Properties unavailable');
    for (const listener of listeners) listener();
    return false;
  }
  const accessors = new Set<string>();
  for (const p of msg.props) accessors.add(p.accessor);
  cache.set(key, accessors);
  propsCache.set(key, msg.props);
  errors.delete(key);
  for (const l of listeners) l();
  return true;
}

/** Render-time gate. Returns true when the property should be shown:
 *  - Schema cached for `type` → schema is authoritative. Show iff the
 *    accessor is in the schema set.
 *  - Schema NOT cached yet → fall back to the static `availableOn` set
 *    (or, if no set was declared on the prop, show by default).
 *
 *  `availableOn === undefined` is the "available everywhere" sentinel
 *  the static catalog uses for props like name / id that exist on
 *  every type. */
export function isPropAvailable(
  type: string | undefined,
  prop: string,
  availableOn?: ReadonlySet<string>,
): boolean {
  if (!type) return false;
  const schema = cache.get(keyFor(type));
  if (schema) return schema.has(prop);
  if (availableOn) return availableOn.has(type);
  return true;
}

export function subscribePaneSchema(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function schemaProps(type: string): TypeSchemaProp[] | undefined {
  return propsCache.get(keyFor(type));
}

export function schemaError(type: string): string | undefined {
  return errors.get(keyFor(type));
}

/** Test hook. */
export function _resetForTests(): void {
  cache.clear();
  propsCache.clear();
  errors.clear();
  inflight.clear();
  listeners.clear();
  currentEnvironment = null;
}
