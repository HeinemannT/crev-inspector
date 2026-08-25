import { describe, expect, it } from 'vitest';
import { CHART_TYPES } from '../../lib/type-registry';
import { CHART_PALETTE, PALETTE } from '../state';

describe('Blueprint add palette', () => {
  it('offers every supported chart type exactly once', () => {
    const chartGroup = PALETTE.find(group => group.group === 'Charts');
    const keys = chartGroup?.items.map(item => item.key) ?? [];

    expect(keys).toEqual([...CHART_TYPES]);
    expect(new Set(keys).size).toBe(keys.length);
    expect(CHART_PALETTE.find(item => item.key === 'RiskChart')?.name).toBe('Risk Chart');
    expect(CHART_PALETTE.find(item => item.key === 'RiskRadarChart')?.name).toBe('Risk Radar Chart');
  });
});
