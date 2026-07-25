import type { TypeSchemaProp } from './types';

/** Return the first schema's properties whose accessors exist in every schema.
 *  The first schema remains authoritative for labels and property metadata. */
export function intersectTypeSchemas(schemas: readonly TypeSchemaProp[][]): TypeSchemaProp[] {
  if (schemas.length === 0) return [];
  if (schemas.length === 1) return [...schemas[0]];
  const sharedAccessors = schemas.slice(1).map(schema =>
    new Set(schema.map(prop => prop.accessor)),
  );
  return schemas[0].filter(prop =>
    sharedAccessors.every(accessors => accessors.has(prop.accessor)),
  );
}
