import { describe, expect, it, vi } from 'vitest';
import {
  createBmpTypeKnowledge,
  type TypeKnowledgeCache,
  type TypeKnowledgeSource,
} from '../bmp-type-knowledge';
import type { TypeSchemaProp } from '../types';
import { ENVIRONMENT_CHANGED_ERROR } from '../environment';
import * as persistentSchemaCache from '../type-schema-cache';

function memoryCache(): TypeKnowledgeCache {
  const entries = new Map<string, { props: TypeSchemaProp[]; canonical: string }>();
  const key = (environment: string, className: string) =>
    `${environment}::${className.toLowerCase()}`;
  return {
    load: vi.fn(async () => undefined),
    get: (environment, className) => entries.get(key(environment, className))?.props ?? null,
    getCanonical: (environment, className) => entries.get(key(environment, className))?.canonical,
    set: (environment, className, props, canonical) => {
      entries.set(key(environment, className), { props, canonical });
    },
  };
}

function knowledge(
  execute: TypeKnowledgeSource['execute'],
  environment: () => string = () => 'server-a',
) {
  return createBmpTypeKnowledge({
    environment,
    source: { execute },
    cache: memoryCache(),
  });
}

const schemaLog = (canonical = 'CeRiskAssessment') => [
  `__canon__|||root.${canonical}`,
  'name|||Risk title|||TextPropertyConfig|||false|||8123456789012345678|||ceRiskTitle|||TextMethodConfig',
].join('\n');

describe('BMP type knowledge', () => {
  it('returns a canonical property description through its interface', async () => {
    const execute = vi.fn(async () => ({ ok: true, log: schemaLog() }));
    const result = await knowledge(execute).properties({ className: 'ceRiskAssessment' });

    expect(result).toEqual({
      ok: true,
      canonical: 'CeRiskAssessment',
      props: [{
        accessor: 'name',
        label: 'Risk title',
        configClass: 'TextPropertyConfig',
        systemobject: false,
        propertyRid: '8123456789012345678',
        propertyId: 'ceRiskTitle',
        propertyConfigClass: 'TextMethodConfig',
      }],
    });
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('c.get(ceRiskAssessment.name)'));
  });

  it('accepts legacy four-column rows', async () => {
    const result = await knowledge(async () => ({
      ok: true,
      log: '__canon__|||Label\nname|||Name|||TextPropertyConfig|||true',
    })).properties({ className: 'Label' });

    expect(result).toMatchObject({
      ok: true,
      props: [{
        accessor: 'name',
        label: 'Name',
        configClass: 'TextPropertyConfig',
        systemobject: true,
      }],
    });
  });

  it('uses concrete-reference help only after empty class metadata', async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ ok: true, log: '__canon__|||EditField\n' })
      .mockResolvedValueOnce({
        ok: true,
        log: '|.available|Available|Is the object visible|\n|.custom_field|Custom field|Workspace value|',
      });

    const result = await knowledge(execute).properties({
      className: 'EditField',
      exampleRef: 't.5611',
    });

    expect(result).toMatchObject({
      ok: true,
      props: [
        { accessor: 'available', label: 'Available', systemobject: true },
        { accessor: 'custom_field', label: 'Custom field', systemobject: false },
      ],
    });
    expect(execute).toHaveBeenNthCalledWith(2, 'help(t.5611)');
  });

  it('rejects unsafe input before it reaches BMP', async () => {
    const execute = vi.fn(async () => ({ ok: true, log: '' }));
    const module = knowledge(execute);

    await expect(module.properties({
      className: 'EditField',
      exampleRef: 't.5611); output("owned")',
    })).resolves.toMatchObject({ ok: false });
    await expect(module.options('Risk; output("owned")')).resolves.toEqual({
      ok: false,
      error: 'Invalid class name: Risk; output("owned")',
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalledWith(expect.stringContaining('owned'));
  });

  it('coalesces same-type property reads across caller casing', async () => {
    let release: ((value: { ok: true; log: string }) => void) | undefined;
    const execute = vi.fn(() => new Promise<{ ok: true; log: string }>(resolve => {
      release = resolve;
    }));
    const module = knowledge(execute);

    const first = module.properties({ className: 'EditField' });
    const second = module.properties({ className: 'editField' });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    release?.({ ok: true, log: schemaLog('EditField') });

    await expect(second).resolves.toEqual(await first);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('serves later case variants from one cached description', async () => {
    const execute = vi.fn(async () => ({ ok: true, log: schemaLog() }));
    const module = knowledge(execute);

    await module.properties({ className: 'CeRiskAssessment' });
    const cached = await module.properties({ className: 'ceriskassessment' });

    expect(cached).toMatchObject({ ok: true, canonical: 'CeRiskAssessment' });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('bypasses both facet caches on an explicit refresh', async () => {
    const execute = vi.fn(async (code: string) => code.includes('__prop__')
      ? { ok: true, log: '__prop__|||kind|||list\n__opt__|||plain|||Plain' }
      : { ok: true, log: schemaLog('Label') });
    const module = knowledge(execute);

    await module.properties({ className: 'Label' });
    await module.properties({ className: 'Label', refresh: true });
    await module.options('Label');
    await module.options('Label', true);

    expect(execute).toHaveBeenCalledTimes(4);
  });

  it('deduplicates batches and keeps Java-long metadata as strings', async () => {
    const execute = vi.fn(async () => ({ ok: true, log: schemaLog() }));
    const result = await knowledge(execute).propertiesFor([
      'CeRiskAssessment',
      'CeRiskAssessment',
      'ceriskassessment',
      '',
    ]);

    expect(result.environment).toBe('server-a');
    expect(result.results).toHaveLength(2);
    expect(result.results[0]).toMatchObject({
      ok: true,
      props: [{ propertyRid: '8123456789012345678' }],
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('does not cache a description that lands after an environment change', async () => {
    let currentEnvironment = 'server-a';
    const execute = vi.fn(async () => {
      currentEnvironment = 'server-b';
      return { ok: true, log: schemaLog() };
    });
    const module = knowledge(execute, () => currentEnvironment);

    await expect(module.properties({ className: 'CeRiskAssessment' })).resolves.toEqual({
      ok: false,
      error: ENVIRONMENT_CHANGED_ERROR,
    });
  });

  it('groups and caches list/tag options behind the same interface', async () => {
    const execute = vi.fn(async (code: string) => ({
      ok: true,
      log: [
        '__prop__|||subtype|||list',
        '__opt__|||master|||Master',
        '__prop__|||domain_tags|||tag',
        '__opt__|||tag_dom_sox|||SOX|||regulated',
      ].join('\n'),
      code,
    }));
    const module = knowledge(execute);

    const first = await module.options('CeRiskAssessment');
    const second = await module.options('ceriskassessment');

    expect(first).toEqual({ ok: true, options: [
      { accessor: 'subtype', multi: false, items: [{ ref: 't.master', name: 'Master' }] },
      { accessor: 'domain_tags', multi: true, items: [{ ref: 't.tag_dom_sox', name: 'SOX|||regulated' }] },
    ] });
    expect(second).toEqual(first);
    expect(execute).toHaveBeenCalledTimes(1);
    const code = vi.mocked(execute).mock.calls[0][0];
    expect(code).toContain('HistoricalListMethodConfig');
    expect(code).toContain('TagMethodConfig');
    expect(code).toContain('_i.name.whenMissing(_i.id)');
  });

  it('coalesces option reads and translates source exceptions', async () => {
    let release: ((value: { ok: true; log: string }) => void) | undefined;
    const execute = vi.fn(() => new Promise<{ ok: true; log: string }>(resolve => {
      release = resolve;
    }));
    const module = knowledge(execute);
    const first = module.options('Label');
    const second = module.options('label');
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    release?.({ ok: true, log: '__prop__|||kind|||list\n__opt__|||plain|||Plain' });
    await expect(second).resolves.toEqual(await first);
    expect(execute).toHaveBeenCalledTimes(1);

    const failing = knowledge(async () => { throw new Error('bridge unavailable'); });
    await expect(failing.properties({ className: 'Label' })).resolves.toEqual({
      ok: false,
      error: 'bridge unavailable',
    });
    await expect(failing.options('Label')).resolves.toEqual({
      ok: false,
      error: 'bridge unavailable',
    });
  });

  it('returns cache-adapter failures through the same result interface', async () => {
    const execute = vi.fn(async () => ({ ok: true, log: schemaLog() }));
    const module = createBmpTypeKnowledge({
      environment: () => 'server-a',
      source: { execute },
      cache: {
        load: async () => { throw new Error('storage unavailable'); },
        get: () => null,
        getCanonical: () => undefined,
        set: () => undefined,
      },
    });

    await expect(module.properties({ className: 'Label' })).resolves.toEqual({
      ok: false,
      error: 'storage unavailable',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('uses one case-insensitive key in the persistent-cache adapter', () => {
    const environment = `case-${Date.now()}`;
    const props: TypeSchemaProp[] = [{
      accessor: 'name',
      label: 'Name',
      configClass: 'TextPropertyConfig',
      systemobject: true,
    }];

    persistentSchemaCache.set(environment, 'CeRiskAssessment', props, 'CeRiskAssessment');

    expect(persistentSchemaCache.get(environment, 'ceriskassessment')).toEqual(props);
    expect(persistentSchemaCache.getCanonical(environment, 'CERISKASSESSMENT')).toBe('CeRiskAssessment');
  });
});
