import { describe, expect, it, vi } from 'vitest';
import { EcQueryService } from '../ec-query-service';

function separatorFrom(code: string): string {
  const separator = code.match(/<<<CREV_PROPERTY_[0-9a-f]{32}>>>/)?.[0];
  if (!separator) throw new Error('Generated EC has no selected-property separator');
  return separator;
}

describe('EcQueryService selected property reads', () => {
  it('reads scalar and reference properties in one bounded EC round trip', async () => {
    const executeEc = vi.fn(async (code: string) => {
      const sep = separatorFrom(code);
      return { ok: true, log: [
        '', 'state_visible', 'value\n',
        'value_visible', 'true\n',
        'state_card', 'value\n',
        'value_card', 'Risk card\n',
        'rid_card', '99\n',
        'id_card', 'risk_card\n',
        'name_card', 'Risk card\n',
        'type_card', 'Card\n',
        'DONE', '',
      ].join(sep) };
    });
    const service = new EcQueryService(executeEc, vi.fn(async () => 't.selected'), []);

    const result = await service.fetchSelectedProperties('42', [
      { accessor: 'visible', reference: false },
      { accessor: 'card', reference: true },
    ]);

    expect(result).toEqual([
      { accessor: 'visible', state: 'value', value: 'true' },
      { accessor: 'card', state: 'value', value: 'Risk card', reference: { rid: '99', businessId: 'risk_card', name: 'Risk card', type: 'Card' } },
    ]);
    const code = executeEc.mock.calls[0][0];
    expect(code).toContain('_v := _o.visible');
    expect(code).toContain('_v := _o.card');
    expect(code).toContain('IF _v.isMissing() THEN');
    expect(code).toContain('_v.rid.whenMissing("")');
    expect(executeEc).toHaveBeenCalledOnce();
  });

  it('preserves explicit missing state instead of conflating it with an empty string', async () => {
    const service = new EcQueryService(vi.fn(async (code: string) => {
      const sep = separatorFrom(code);
      return { ok: true, log: `${sep}state_visible${sep}missing\n${sep}DONE` };
    }), vi.fn(async () => 't.selected'), []);
    await expect(service.fetchSelectedProperties('42', [{ accessor: 'visible', reference: false }]))
      .resolves.toEqual([{ accessor: 'visible', state: 'missing', value: '' }]);
  });

  it('rejects an incomplete successful response instead of inventing a value state', async () => {
    const service = new EcQueryService(vi.fn(async (code: string) => {
      const sep = separatorFrom(code);
      return { ok: true, log: `${sep}value_visible${sep}true\n${sep}DONE` };
    }), vi.fn(async () => 't.selected'), []);

    await expect(service.fetchSelectedProperties('42', [{ accessor: 'visible', reference: false }]))
      .rejects.toThrow('incomplete result');
  });

  it('preserves scalar content that resembles a property-wire delimiter', async () => {
    const dangerousValue = 'user text <<<CREV_PROPERTY_SEP>>>state_text<<<CREV_PROPERTY_SEP>>>missing';
    const service = new EcQueryService(vi.fn(async (code: string) => {
      const sep = separatorFrom(code);
      return { ok: true, log: [
        '', 'state_text', 'value\n',
        'value_text', `${dangerousValue}\n`,
        'DONE', '',
      ].join(sep) };
    }), vi.fn(async () => 't.selected'), []);

    await expect(service.fetchSelectedProperties('42', [{ accessor: 'text', reference: false }]))
      .resolves.toEqual([{ accessor: 'text', state: 'value', value: dangerousValue }]);
  });
});
