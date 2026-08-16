import { describe, expect, it } from 'vitest';
import { EcQueryService } from '../../ec-query-service';
import { bridgePreview, buildDiscoveryEc, integrationTarget, parseDiscoveryRows } from './config';

describe('selected property EC against live BMP', () => {
  it('reads scalar and reference-shaped properties from a real CeRiskAssessment', async () => {
    const target = integrationTarget();
    const objects = parseDiscoveryRows(await bridgePreview(target, buildDiscoveryEc('CeRiskAssessment')));
    const object = objects.find(candidate => /^[A-Za-z0-9_]+$/.test(candidate.businessId));
    expect(object, 'Steadfast needs at least one addressable CeRiskAssessment').toBeDefined();
    if (!object) return;

    let wireLog = '';
    const service = new EcQueryService(async code => {
      try {
        wireLog = await bridgePreview(target, code);
        return { ok: true, log: wireLog };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }, async rid => `lookup(${rid})`, []);

    const values = await service.fetchSelectedProperties(object.rid, [
      { accessor: 'name', reference: false },
      { accessor: 'card', reference: true },
    ]);

    expect(values[0], wireLog).toMatchObject({ accessor: 'name', state: 'value', value: object.name });
    expect(values[1]?.accessor).toBe('card');
    expect(['value', 'missing']).toContain(values[1]?.state);
    if (values[1]?.reference) expect(values[1].reference.rid).toMatch(/^\d+$/);
  });
});
