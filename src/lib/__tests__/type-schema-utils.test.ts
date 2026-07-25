import { describe, expect, it } from 'vitest';
import type { TypeSchemaProp } from '../types';
import { intersectTypeSchemas } from '../type-schema-utils';

function prop(accessor: string, label = accessor): TypeSchemaProp {
  return { accessor, label, configClass: 'TextMethodConfig', systemobject: false };
}

describe('intersectTypeSchemas', () => {
  it('keeps first-schema metadata for accessors shared by every type', () => {
    const shared = intersectTypeSchemas([
      [prop('name', 'Service name'), prop('owner', 'Service owner'), prop('serviceOnly')],
      [prop('owner', 'Asset owner'), prop('name', 'Asset name'), prop('assetOnly')],
    ]);
    expect(shared).toEqual([
      prop('name', 'Service name'),
      prop('owner', 'Service owner'),
    ]);
  });

  it('does not alias a single input schema and handles no schemas', () => {
    const schema = [prop('name')];
    expect(intersectTypeSchemas([])).toEqual([]);
    expect(intersectTypeSchemas([schema])).toEqual(schema);
    expect(intersectTypeSchemas([schema])).not.toBe(schema);
  });
});
