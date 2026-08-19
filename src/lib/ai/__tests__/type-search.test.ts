import { describe, expect, it } from 'vitest';
import { rowTypeSearchQueries } from '../type-search';

describe('rowTypeSearchQueries', () => {
  it('recovers a transposed CeRiskAssessment class spelling', () => {
    expect(rowTypeSearchQueries('ceRskiassessments')).toEqual([
      'ceRskiassessments',
      'risk assessment',
      'rskiassessments',
    ]);
  });

  it('keeps a clean business phrase stable and bounded', () => {
    expect(rowTypeSearchQueries('risk assessment')).toEqual(['risk assessment']);
  });
});
