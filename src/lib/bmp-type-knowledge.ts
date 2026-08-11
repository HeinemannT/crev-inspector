/**
 * Authoritative BMP type knowledge.
 *
 * Callers ask for properties, property batches, or list/tag options. This
 * module owns the recipe: validation, canonical class discovery, persistent
 * schema caching, reference-help fallback, environment safety, option caching,
 * and in-flight coalescing.
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
}

interface EcResult {
  ok: boolean;
  log?: string;
  error?: string;
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
}

export interface TypeKnowledgeDependencies {
  environment(): string;
  source: TypeKnowledgeSource;
  cache: TypeKnowledgeCache;
}

const VALID_CLASS_NAME = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
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

export function createBmpTypeKnowledge(deps: TypeKnowledgeDependencies): BmpTypeKnowledge {
  const propertyLoads = new Map<string, Promise<TypePropertiesResult>>();
  const optionLoads = new Map<string, Promise<TypeOptionsResult>>();
  const optionCache = new Map<string, TypeOptionSet[]>();

  const validate = (className: string): string | null => {
    const trimmed = className.trim();
    return VALID_CLASS_NAME.test(trimmed) ? null : `Invalid class name: ${className}`;
  };

  const properties = async (request: TypePropertiesRequest): Promise<TypePropertiesResult> => {
    const className = request.className.trim();
    const validationError = validate(className);
    if (validationError) return { ok: false, error: validationError };
    const environment = deps.environment();

    if (!request.refresh) {
      try {
        await deps.cache.load();
        if (deps.environment() !== environment) {
          return { ok: false, error: ENVIRONMENT_CHANGED_ERROR };
        }
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
      if (deps.environment() !== environment) return { ok: false, error: ENVIRONMENT_CHANGED_ERROR };
      const parsed = result.ok ? parseSchema(result.log ?? '') : { props: [] as TypeSchemaProp[] };
      let { props } = parsed;
      const canonical = parsed.canonical ?? className;
      if (props.length === 0 && concreteRef) {
        const help = await deps.source.execute(`help(${concreteRef})`);
        if (deps.environment() !== environment) return { ok: false, error: ENVIRONMENT_CHANGED_ERROR };
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
    const className = rawClassName.trim();
    const validationError = validate(className);
    if (validationError) return { ok: false, error: validationError };
    const environment = deps.environment();
    const key = `${environment}::${className.toLowerCase()}`;
    if (!refresh) {
      const cached = optionCache.get(key);
      if (cached) return { ok: true, options: cached };
    }
    const existing = optionLoads.get(key);
    if (existing) return existing;

    const load = (async (): Promise<TypeOptionsResult> => {
      const result = await deps.source.execute(optionsEc(className));
      if (deps.environment() !== environment) return { ok: false, error: ENVIRONMENT_CHANGED_ERROR };
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

  return { properties, propertiesFor, options };
}

const productionCache: TypeKnowledgeCache = {
  load: persistentSchemaCache.load,
  get: persistentSchemaCache.get,
  getCanonical: persistentSchemaCache.getCanonical,
  set: persistentSchemaCache.set,
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
