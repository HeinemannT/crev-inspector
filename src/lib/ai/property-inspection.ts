/**
 * Progressive BMP property inspection for AI tools.
 *
 * The interface stays small: callers provide one object target and up to eight
 * exact accessors. The implementation owns schema validation, reference
 * typing, missing/unset distinction, inheritance source, large-value
 * suppression and model-readable formatting.
 */
import type { TypePropertiesResult } from '../bmp-type-knowledge';
import type { SelectedPropertyRequest, SelectedPropertyValue } from '../ec-query-service';
import type { ObjectReference, TypeSchemaProp } from '../types';
import type { InspectedPropertyData } from './tool-results';

export const MAX_AI_SELECTED_PROPERTIES = 8;
export const MAX_AI_INLINE_PROPERTY_CHARS = 800;
export const MAX_AI_TYPE_PROPERTIES = 50;

export interface PropertyInspectionTarget {
  rid: string;
  type: string;
  hasTemplate: boolean;
  instanceOverrideProps: readonly string[];
}

export interface PropertyInspectionDependencies {
  schema(className: string): Promise<TypePropertiesResult>;
  values(
    rid: string,
    properties: readonly SelectedPropertyRequest[],
    signal?: AbortSignal,
  ): Promise<SelectedPropertyValue[]>;
}

export interface PropertyInspectionResult {
  content: string;
  objects: ObjectReference[];
  unknown: string[];
  properties: InspectedPropertyData[];
  schemaAvailable: boolean;
  schemaError?: string;
}

const PROPERTY_QUERY_STOP_WORDS = new Set(['a', 'an', 'for', 'in', 'of', 'on', 'property', 'setting', 'the', 'to']);

/** Natural requests rarely repeat a BMP label verbatim ("tools toolbar" vs
 * `showToolMenu`). Split camelCase and lightly normalize plurals so one narrow
 * read_type call can retrieve the right candidates without synonym hunting. */
function propertySearchTokens(value: string): string[] {
  const words = value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLocaleLowerCase()
    .match(/[a-z0-9]+/g) ?? [];
  return [...new Set(words
    .filter(word => word.length > 1 && !PROPERTY_QUERY_STOP_WORDS.has(word))
    .map(word => word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word))];
}

function propertyQueryScore(property: TypeSchemaProp, needle: string, queryTokens: readonly string[]): number {
  const values = [property.accessor, property.label, property.description ?? ''];
  if (values.some(value => value.toLocaleLowerCase().includes(needle))) return 100 + queryTokens.length;
  const propertyTokens = new Set(values.flatMap(propertySearchTokens));
  return queryTokens.reduce((score, token) => score + ([...propertyTokens].some(candidate =>
    candidate === token
    || (candidate.length >= 3 && token.length >= 3
      && (candidate.startsWith(token) || token.startsWith(candidate)))) ? 1 : 0), 0);
}

function propertyClass(property: TypeSchemaProp): string {
  return property.propertyConfigClass || property.configClass;
}

/** Reference-like values need identity metadata. Card is a built-in reference
 * whose live application class is not consistent across BMP families. */
export function isReferenceProperty(property: TypeSchemaProp): boolean {
  return property.accessor === 'card' || /Reference/i.test(propertyClass(property));
}

export function searchTypeProperties(
  properties: readonly TypeSchemaProp[],
  query: string,
  cap = MAX_AI_TYPE_PROPERTIES,
): { total: number; shown: TypeSchemaProp[] } {
  const needle = query.trim().toLocaleLowerCase();
  const queryTokens = propertySearchTokens(query);
  const matched = needle
    ? properties
        .map((property, index) => ({ property, index, score: propertyQueryScore(property, needle, queryTokens) }))
        .filter(match => match.score > 0)
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .map(match => match.property)
    : [...properties];
  return { total: matched.length, shown: matched.slice(0, cap) };
}

function propertySource(
  property: SelectedPropertyValue,
  target: PropertyInspectionTarget,
): 'unset' | 'instance' | 'template' {
  if (property.state === 'missing') return 'unset';
  if (target.hasTemplate && !target.instanceOverrideProps.includes(property.accessor)) return 'template';
  return 'instance';
}

function formattedValue(property: SelectedPropertyValue): string {
  if (property.state === 'missing') return '(unset)';
  if (property.reference) {
    const reference = property.reference;
    return `${reference.name || '(unnamed)'} (${reference.type || 'Object'})`
      + `${reference.businessId ? ` bid=${reference.businessId}` : ''} rid=${reference.rid}`;
  }
  if (!property.value) return '""';
  if (property.value.length > MAX_AI_INLINE_PROPERTY_CHARS) {
    return `(${property.value.length} chars; use read_code for the full raw value)`;
  }
  return JSON.stringify(property.value);
}

/** Inspect exact accessors. The schema result is authoritative when available:
 * unknown accessors are reported and never sent into generated EC. If schema
 * discovery is temporarily unavailable, exact user-supplied accessors remain
 * readable as scalar values instead of turning a cache failure into blindness. */
export async function inspectObjectProperties(
  target: PropertyInspectionTarget,
  accessors: readonly string[],
  dependencies: PropertyInspectionDependencies,
  signal?: AbortSignal,
): Promise<PropertyInspectionResult> {
  const selected = [...new Set(accessors.map(accessor => accessor.trim()).filter(Boolean))];
  if (!selected.length) return {
    content: 'No properties requested.',
    objects: [],
    unknown: [],
    properties: [],
    schemaAvailable: true,
  };
  if (selected.length > MAX_AI_SELECTED_PROPERTIES) {
    throw new Error(`At most ${MAX_AI_SELECTED_PROPERTIES} exact properties can be read at once.`);
  }

  const schema = await dependencies.schema(target.type);
  const byAccessor = schema.ok
    ? new Map(schema.props.map(property => [property.accessor, property]))
    : new Map<string, TypeSchemaProp>();
  const unknown = schema.ok ? selected.filter(accessor => !byAccessor.has(accessor)) : [];
  const readable = selected.filter(accessor => !unknown.includes(accessor));
  const requests = readable.map(accessor => ({
    accessor,
    reference: isReferenceProperty(byAccessor.get(accessor) ?? {
      accessor,
      label: accessor,
      configClass: '',
      systemobject: false,
    }),
  }));
  const values = await dependencies.values(target.rid, requests, signal);
  const valueByAccessor = new Map(values.map(value => [value.accessor, value]));
  const lines = ['Selected properties:'];
  const objects: ObjectReference[] = [];
  const properties: InspectedPropertyData[] = [];

  for (const accessor of readable) {
    const descriptor = byAccessor.get(accessor);
    const value = valueByAccessor.get(accessor) ?? { accessor, state: 'missing' as const, value: '' };
    const label = descriptor?.label && descriptor.label !== accessor ? ` "${descriptor.label}"` : '';
    const kind = descriptor ? ` [${propertyClass(descriptor)}]` : '';
    const source = propertySource(value, target);
    lines.push(`  ${accessor}${label}${kind} = ${formattedValue(value)} [source=${source}]`);
    if (value.reference) objects.push(value.reference);
    properties.push({
      accessor,
      ...(descriptor?.label ? { label: descriptor.label } : {}),
      ...(descriptor ? { configClass: propertyClass(descriptor) } : {}),
      state: value.state,
      source,
      ...(value.state === 'value' && !value.reference ? {
        value: value.value.length > MAX_AI_INLINE_PROPERTY_CHARS
          ? value.value.slice(0, MAX_AI_INLINE_PROPERTY_CHARS)
          : value.value,
        valueLength: value.value.length,
        valueTruncated: value.value.length > MAX_AI_INLINE_PROPERTY_CHARS,
      } : {}),
      ...(value.reference ? { referenceRid: value.reference.rid } : {}),
    });
  }
  if (unknown.length) {
    lines.push(`Unknown properties on ${target.type}: ${unknown.join(', ')}. Use read_type with query to find the verified accessor.`);
  }
  if (!schema.ok) {
    lines.push(`Live schema unavailable; exact values were read directly: ${schema.error}`);
  }
  return {
    content: lines.join('\n'),
    objects,
    unknown,
    properties,
    schemaAvailable: schema.ok,
    ...(!schema.ok ? { schemaError: schema.error } : {}),
  };
}
