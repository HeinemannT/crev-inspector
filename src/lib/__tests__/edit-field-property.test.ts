import { describe, expect, it } from 'vitest';
import { editFieldPropertyRelation } from '../edit-field-property';

const resolution = {
  accessor: 'bucket_1_max',
  property: {
    rid: '700',
    businessId: 'bucket_1_max',
    name: 'Bucket 1 Max',
    type: 'HistoricalNumberMethodConfig',
  },
};

describe('EditField property relation', () => {
  it('normalizes resolved, unresolved, and absent mappings', () => {
    expect(editFieldPropertyRelation('EditField', 'bucket_1_max', resolution, null).kind)
      .toBe('resolved');
    expect(editFieldPropertyRelation('EditField', 'other', resolution, 'Not found')).toEqual({
      kind: 'unresolved',
      accessor: 'other',
      error: 'Not found',
    });
    expect(editFieldPropertyRelation('EditField', '', null, null)).toEqual({ kind: 'absent' });
    expect(editFieldPropertyRelation('TextInput', 'bucket_1_max', resolution, null))
      .toEqual({ kind: 'absent' });
  });
});
