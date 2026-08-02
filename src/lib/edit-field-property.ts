import type { EditFieldPropertyResolution } from './types';

export type EditFieldPropertyRelation =
  | { kind: 'absent' }
  | { kind: 'resolved'; accessor: string; resolution: EditFieldPropertyResolution }
  | { kind: 'unresolved'; accessor: string; error: string };

export function editFieldPropertyRelation(
  type: string,
  propertyMapping: string | undefined,
  resolution: EditFieldPropertyResolution | null | undefined,
  error: string | null | undefined,
): EditFieldPropertyRelation {
  if (type !== 'EditField') return { kind: 'absent' };
  const accessor = propertyMapping?.trim() ?? '';
  if (!accessor) return { kind: 'absent' };
  if (resolution?.accessor === accessor) {
    return { kind: 'resolved', accessor, resolution };
  }
  return {
    kind: 'unresolved',
    accessor,
    error: error || 'Property configuration unresolved',
  };
}
