/**
 * Authoritative BMP type knowledge.
 *
 * Callers ask for properties, property batches, list/tag options, or the
 * concrete class behind a root category. This module owns the recipe:
 * validation, canonical class discovery, persistent caching, reference-help
 * fallback, environment safety, negative-cache policy, and in-flight
 * coalescing.
 */

import type { TypeOptionSet, TypeSchemaProp } from './types';
import { ID_SPACE_PREFIXES } from './ec-grammar';
import { ENVIRONMENT_CHANGED_ERROR, environmentToken } from './environment';
import { getCtx } from './sw-context';
import * as persistentSchemaCache from './type-schema-cache';

export type TypePropertiesResult =
  | { ok: true; props: TypeSchemaProp[]; canonical: string }
  | { ok: false; error: string };

export type TypeOptionsResult =
  | { ok: true; options: TypeOptionSet[] }
  | { ok: false; error: string };

export type RootCategoryResult =
  | { ok: true; className?: string }
  | { ok: false; error: string };

export interface TypePropertiesRequest {
  className: string;
  refresh?: boolean;
  exampleRef?: string;
}

export interface TypeKnowledgeBatchResult {
  environment: string;
  results: Array<
    | { className: string; ok: true; props: TypeSchemaProp[]; canonical: string }
    | { className: string; ok: false; error: string }
  >;
}

export interface BmpTypeKnowledge {
  properties(request: TypePropertiesRequest): Promise<TypePropertiesResult>;
  propertiesFor(classNames: readonly string[]): Promise<TypeKnowledgeBatchResult>;
  options(className: string, refresh?: boolean): Promise<TypeOptionsResult>;
  rootCategory(category: string): Promise<RootCategoryResult>;
  clear(): Promise<void>;
}

interface EcResult {
  ok: boolean;
  log?: string;
  error?: string;
  hasError?: boolean;
}

export interface TypeKnowledgeSource {
  execute(code: string): Promise<EcResult>;
}

export interface TypeKnowledgeCache {
  load(): Promise<void>;
  get(environment: string, className: string): TypeSchemaProp[] | null;
  getCanonical(environment: string, className: string): string | undefined;
  set(
    environment: string,
    className: string,
    props: TypeSchemaProp[],
    canonicalClassName: string,
  ): void;
  loadRootCategories(): Promise<void>;
  getRootCategory(environment: string, category: string): string | null | undefined;
  setRootCategory(environment: string, category: string, className: string | null): void;
  clear(): Promise<void>;
}

export interface TypeKnowledgeDependencies {
  environment(): string;
  source: TypeKnowledgeSource;
  cache: TypeKnowledgeCache;
}

const VALID_CLASS_NAME = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
const VALID_ROOT_CATEGORY = /^[a-z][A-Za-z0-9]{0,63}$/;
const VALID_CANONICAL_CLASS = /^[A-Z][A-Za-z0-9]+$/;
const GENERIC_SYSTEM_PROPERTIES = new Set([
  'rid', 'id', 'name', 'description', 'parent', 'model', 'self', 'sortIndex',
  'className', 'available', 'showExpression', 'useShowExpression',
]);

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Enumerate property configs plus BMP's canonical fully-qualified class id.
 * `c.get(X.name)` is deliberately case-insensitive; linkedTo.id is the real
 * accessor, while linkedTo.rid/id/className preserve master-property identity. */
function schemaEc(className: string): string {
  return [
    `_cls := c.get(${className}.name)`,
    '_out := "__canon__|||" + _cls.id.whenMissing("") + "\\n"',
    '_kids := _cls.children()',
    '_kids.forEach(_k:',
    '     _out := _out + _k.linkedTo.id + "|||" + _k.name + "|||" + _k.className + "|||" + _k.systemobject + "|||" + _k.linkedTo.rid + "|||" + _k.linkedTo.id + "|||" + _k.linkedTo.className + "\\n"',
    ')',
    '_out',
  ].join('\n');
}

function parseSchema(log: string): { props: TypeSchemaProp[]; canonical?: string } {
  const props: TypeSchemaProp[] = [];
  let canonical: string | undefined;
  for (const line of log.split('\n')) {
    const parts = line.split('|||');
    if (parts.length === 2 && parts[0] === '__canon__') {
      canonical = parts[1].trim().split('.').pop() || undefined;
      continue;
    }
    if (parts.length < 4) continue;
    const [accessor, label, configClass, sysFlag, propertyRid, propertyId, propertyConfigClass] = parts;
    if (!accessor || !configClass) continue;
    props.push({
      accessor: accessor.trim(),
      label: label.trim(),
      configClass: configClass.trim(),
      systemobject: sysFlag.trim() === 'true',
      ...(propertyRid?.trim() ? { propertyRid: propertyRid.trim() } : {}),
      ...(propertyId?.trim() ? { propertyId: propertyId.trim() } : {}),
      ...(propertyConfigClass?.trim() ? { propertyConfigClass: propertyConfigClass.trim() } : {}),
    });
  }
  return { props, canonical };
}

function parseReferenceHelp(log: string): TypeSchemaProp[] {
  const props: TypeSchemaProp[] = [];
  const seen = new Set<string>();
  for (const line of log.split('\n')) {
    const match = /^\|\s*\.([A-Za-z_][A-Za-z0-9_]*)\s*\|\s*([^|]*)\|\s*([^|]*)\|?/.exec(line);
    if (!match || seen.has(match[1])) continue;
    seen.add(match[1]);
    props.push({
      accessor: match[1],
      label: match[2].trim(),
      description: match[3].trim() || undefined,
      configClass: 'Property',
      systemobject: GENERIC_SYSTEM_PROPERTIES.has(match[1]),
    });
  }
  return props;
}

function safeConcreteObjectRef(ref: string | undefined): string | null {
  if (!ref) return null;
  const match = /^([a-z]{1,6})\.([A-Za-z0-9_]+)$/.exec(ref);
  if (!match || match[1] === 'o' || !ID_SPACE_PREFIXES.has(match[1])) return null;
  return ref;
}

/** Enumerate fixed t.<id> values. Only ListMethodConfig,
 * HistoricalListMethodConfig, and TagMethodConfig own these sets; status,
 * boolean, and reference properties use different value models. The strict
 * list/tag branch matters because reading the wrong set accessor throws in EC. */
function optionsEc(className: string): string {
  return [
    `_cls := c.get(${className}.name)`,
    '_out := ""',
    '_kids := _cls.children()',
    '_kids.forEach(_k:',
    '     _cn := _k.className',
    '     _kind := ""',
    '     IF _cn = "ListMethodConfig" OR _cn = "HistoricalListMethodConfig" THEN',
    '          _kind := "list"',
    '     ELSE',
    '          IF _cn = "TagMethodConfig" THEN',
    '               _kind := "tag"',
    '          ELSE',
    '               _kind := ""',
    '          ENDIF',
    '     ENDIF',
    '     IF _kind != "" THEN',
    '          IF _kind = "list" THEN',
    '               _set := _k.listPropertySet',
    '          ELSE',
    '               _set := _k.tagList',
    '          ENDIF',
    '          _out := _out + "__prop__|||" + _k.linkedTo.id + "|||" + _kind + "\\n"',
    '          _set.children().forEach(_i:',
    '               _out := _out + "__opt__|||" + _i.id + "|||" + _i.name.whenMissing(_i.id) + "\\n"',
    '          )',
    '     ELSE',
    '          _out := _out',
    '     ENDIF',
    ')',
    '_out',
  ].join('\n');
}

function parseOptions(log: string): TypeOptionSet[] {
  const sets: TypeOptionSet[] = [];
  let current: TypeOptionSet | null = null;
  for (const line of log.split('\n')) {
    const parts = line.split('|||');
    if (parts[0] === '__prop__' && parts.length === 3) {
      current = { accessor: parts[1].trim(), multi: parts[2].trim() === 'tag', items: [] };
      sets.push(current);
    } else if (parts[0] === '__opt__' && parts.length >= 3 && current) {
      const id = parts[1].trim();
      if (id) current.items.push({ ref: `t.${id}`, name: parts.slice(2).join('|||').trim() });
    }
  }
  return sets.filter(set => set.items.length > 0);
}

function rootCategoryEc(category: string): string {
  return `root.${category}.children().first().className.whenMissing("")`;
}

function parseRootCategory(log: string): string | undefined {
  const value = log.trim().split('\n')[0]?.trim() ?? '';
  return VALID_CANONICAL_CLASS.test(value) ? value : undefined;
}

export function createBmpTypeKnowledge(deps: TypeKnowledgeDependencies): BmpTypeKnowledge {
  const propertyLoads = new Map<string, Promise<TypePropertiesResult>>();
  const optionLoads = new Map<string, Promise<TypeOptionsResult>>();
  const rootCategoryLoads = new Map<string, Promise<RootCategoryResult>>();
  const optionCache = new Map<string, TypeOptionSet[]>();
  let generation = 0;
  let clearPromise: Promise<void> | null = null;

  const waitForClear = async (): Promise<void> => {
    if (clearPromise) await clearPromise;
  };

  const staleError = (environment: string, requestGeneration: number): string | null => {
    if (deps.environment() !== environment) return ENVIRONMENT_CHANGED_ERROR;
    return generation === requestGeneration ? null : 'Type knowledge was reset';
  };

  const validate = (className: string): string | null => {
    const trimmed = className.trim();
    return VALID_CLASS_NAME.test(trimmed) ? null : `Invalid class name: ${className}`;
  };

  const properties = async (request: TypePropertiesRequest): Promise<TypePropertiesResult> => {
    await waitForClear();
    const className = request.className.trim();
    const validationError = validate(className);
    if (validationError) return { ok: false, error: validationError };
    const environment = deps.environment();
    const requestGeneration = generation;

    if (!request.refresh) {
      try {
        await deps.cache.load();
        const stale = staleError(environment, requestGeneration);
        if (stale) return { ok: false, error: stale };
        const cached = deps.cache.get(environment, className);
        if (cached) {
          return {
            ok: true,
            props: cached,
            canonical: deps.cache.getCanonical(environment, className) ?? className,
          };
        }
      } catch (error) {
        return { ok: false, error: errorText(error) };
      }
    }

    const concreteRef = safeConcreteObjectRef(request.exampleRef);
    const key = `${environment}::${className.toLowerCase()}::${concreteRef ?? ''}`;
    const existing = propertyLoads.get(key);
    if (existing) return existing;

    const load = (async (): Promise<TypePropertiesResult> => {
      const result = await deps.source.execute(schemaEc(className));
      const stale = staleError(environment, requestGeneration);
      if (stale) return { ok: false, error: stale };
      const parsed = result.ok ? parseSchema(result.log ?? '') : { props: [] as TypeSchemaProp[] };
      let { props } = parsed;
      const canonical = parsed.canonical ?? className;
      if (props.length === 0 && concreteRef) {
        const help = await deps.source.execute(`help(${concreteRef})`);
        const helpStale = staleError(environment, requestGeneration);
        if (helpStale) return { ok: false, error: helpStale };
        if (help.ok) props = parseReferenceHelp(help.log ?? '');
      }
      if (props.length === 0) {
        return {
          ok: false,
          error: result.ok
            ? 'No properties returned (unknown class?)'
            : result.error || result.log || 'EC execution failed',
        };
      }
      deps.cache.set(environment, className, props, canonical);
      return { ok: true, props, canonical };
    })();
    propertyLoads.set(key, load);
    try {
      return await load;
    } catch (error) {
      return { ok: false, error: errorText(error) };
    } finally {
      if (propertyLoads.get(key) === load) propertyLoads.delete(key);
    }
  };

  const propertiesFor = async (classNames: readonly string[]): Promise<TypeKnowledgeBatchResult> => {
    const environment = deps.environment();
    const unique = new Set<string>();
    for (const className of classNames) {
      const trimmed = className.trim();
      if (trimmed) unique.add(trimmed);
    }
    const results: TypeKnowledgeBatchResult['results'] = [];
    for (const className of unique) {
      if (deps.environment() !== environment) {
        results.push({ className, ok: false, error: ENVIRONMENT_CHANGED_ERROR });
        continue;
      }
      const result = await properties({ className });
      results.push(result.ok
        ? { className, ok: true, props: result.props, canonical: result.canonical }
        : { className, ok: false, error: result.error });
    }
    return { environment, results };
  };

  const options = async (rawClassName: string, refresh = false): Promise<TypeOptionsResult> => {
    await waitForClear();
    const className = rawClassName.trim();
    const validationError = validate(className);
    if (validationError) return { ok: false, error: validationError };
    const environment = deps.environment();
    const requestGeneration = generation;
    const key = `${environment}::${className.toLowerCase()}`;
    if (!refresh) {
      const cached = optionCache.get(key);
      if (cached) return { ok: true, options: cached };
    }
    const existing = optionLoads.get(key);
    if (existing) return existing;

    const load = (async (): Promise<TypeOptionsResult> => {
      const result = await deps.source.execute(optionsEc(className));
      const stale = staleError(environment, requestGeneration);
      if (stale) return { ok: false, error: stale };
      if (!result.ok) {
        return { ok: false, error: result.error || result.log || 'EC execution failed' };
      }
      const parsed = parseOptions(result.log ?? '');
      optionCache.set(key, parsed);
      return { ok: true, options: parsed };
    })();
    optionLoads.set(key, load);
    try {
      return await load;
    } catch (error) {
      return { ok: false, error: errorText(error) };
    } finally {
      if (optionLoads.get(key) === load) optionLoads.delete(key);
    }
  };

  const rootCategory = async (rawCategory: string): Promise<RootCategoryResult> => {
    await waitForClear();
    const category = rawCategory.trim();
    if (!VALID_ROOT_CATEGORY.test(category)) {
      return { ok: false, error: `Invalid root category: ${rawCategory}` };
    }
    const environment = deps.environment();
    const requestGeneration = generation;
    try {
      await deps.cache.loadRootCategories();
      const stale = staleError(environment, requestGeneration);
      if (stale) return { ok: false, error: stale };
      const cached = deps.cache.getRootCategory(environment, category);
      if (cached !== undefined) {
        return cached === null ? { ok: true } : { ok: true, className: cached };
      }
    } catch (error) {
      return { ok: false, error: errorText(error) };
    }

    const key = `${environment}::${category}`;
    const existing = rootCategoryLoads.get(key);
    if (existing) return existing;

    const load = (async (): Promise<RootCategoryResult> => {
      const result = await deps.source.execute(rootCategoryEc(category));
      const stale = staleError(environment, requestGeneration);
      if (stale) return { ok: false, error: stale };
      if (!result.ok) {
        // An EC error is a definitive negative answer. Cache it so editor
        // scans do not repeat the same command on every keystroke. Transport
        // failures stay retryable and are deliberately not cached.
        if (result.hasError) {
          deps.cache.setRootCategory(environment, category, null);
          return { ok: true };
        }
        return { ok: false, error: result.error || result.log || 'EC execution failed' };
      }
      const className = parseRootCategory(result.log ?? '');
      deps.cache.setRootCategory(environment, category, className ?? null);
      return className ? { ok: true, className } : { ok: true };
    })();
    rootCategoryLoads.set(key, load);
    try {
      return await load;
    } catch (error) {
      return { ok: false, error: errorText(error) };
    } finally {
      if (rootCategoryLoads.get(key) === load) rootCategoryLoads.delete(key);
    }
  };

  const clear = async (): Promise<void> => {
    generation += 1;
    propertyLoads.clear();
    optionLoads.clear();
    rootCategoryLoads.clear();
    optionCache.clear();
    const work = deps.cache.clear();
    clearPromise = work;
    try { await work; }
    finally {
      if (clearPromise === work) clearPromise = null;
    }
  };

  return { properties, propertiesFor, options, rootCategory, clear };
}

const productionCache: TypeKnowledgeCache = {
  load: persistentSchemaCache.load,
  get: persistentSchemaCache.get,
  getCanonical: persistentSchemaCache.getCanonical,
  set: persistentSchemaCache.set,
  loadRootCategories: persistentSchemaCache.loadRootCache,
  getRootCategory: persistentSchemaCache.getRoot,
  setRootCategory: persistentSchemaCache.setRoot,
  clear: persistentSchemaCache.clear,
};

export const bmpTypeKnowledge = createBmpTypeKnowledge({
  environment: () => environmentToken(getCtx()),
  source: {
    execute: async code => {
      const client = getCtx().client;
      if (!client) return { ok: false, error: 'Not connected' };
      return client.executeEc(code, undefined, false);
    },
  },
  cache: productionCache,
});
