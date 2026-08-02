import { describe, expect, it } from 'vitest';
import {
  isHistoricalPropertyConfigClass,
  isMasterPropertyDefinition,
  isPropertyConfigClass,
} from '../property-config';

describe('Property configuration classification', () => {
  it('recognizes MethodConfig classes without treating linked applications as masters', () => {
    expect(isPropertyConfigClass('HistoricalNumberMethodConfig')).toBe(true);
    expect(isMasterPropertyDefinition('HistoricalNumberMethodConfig', null)).toBe(true);
    expect(isMasterPropertyDefinition('HistoricalNumberMethodConfig', { rid: '700' })).toBe(false);
    expect(isMasterPropertyDefinition('ListPropertySet', null)).toBe(false);
  });

  it('recognizes historical property configs without a duplicated type list', () => {
    expect(isHistoricalPropertyConfigClass('HistoricalNumberMethodConfig')).toBe(true);
    expect(isHistoricalPropertyConfigClass('HistoricalStatusMethodConfig')).toBe(true);
    expect(isHistoricalPropertyConfigClass('NumberMethodConfig')).toBe(false);
    expect(isHistoricalPropertyConfigClass('EditField')).toBe(false);
  });
});
