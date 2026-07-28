import { describe, expect, it } from 'vitest';
import { activityObject, activityObjectLabel, boundedActivityDetail, ecActivityDetail } from '../activity-format';

describe('activity formatting', () => {
  it('keeps useful BMP output while dropping noisy warning entries', () => {
    expect(ecActivityDetail({
      ok: true,
      log: 'warning\nupdated',
      outputEntries: [
        { logType: 'WARNING', message: 'Routine BMP warning', result: false },
        { logType: 'SHOW_RESULT', message: 'Updated 12 objects', result: false },
        { logType: 'SHOW_RESULT', message: 'done', result: true },
      ],
    })).toBe('SHOW_RESULT: Updated 12 objects\nRESULT: done');
  });

  it('does not retain warning-only success output', () => {
    expect(ecActivityDetail({
      ok: true,
      outputEntries: [
        { logType: 'WARNING', message: 'Routine BMP warning', result: false },
      ],
    })).toBeUndefined();
  });

  it('does not reintroduce structured warnings through a failed result log', () => {
    expect(ecActivityDetail({
      ok: false,
      log: 'Routine BMP warning',
      outputEntries: [
        { logType: 'WARNING', message: 'Routine BMP warning', result: false },
      ],
    })).toBeUndefined();
  });

  it('bounds persisted response text', () => {
    const detail = boundedActivityDetail('x'.repeat(5_000));
    expect(detail?.length).toBeLessThan(4_100);
    expect(detail).toContain('output truncated');
  });

  it('prefers human identity over a numeric RID', () => {
    const object = activityObject('98357', {
      name: 'Risk Register',
      businessId: 'sc_risk_register',
      type: 'ModelPage',
    });
    expect(activityObjectLabel(object, '98357')).toBe('Risk Register');
    expect(object).toEqual({
      rid: '98357',
      name: 'Risk Register',
      businessId: 'sc_risk_register',
      type: 'ModelPage',
    });
  });
});
