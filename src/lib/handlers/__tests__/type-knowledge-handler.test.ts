import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockChromeStorage } from '../../__tests__/chrome-mock';

describe('BMP type-knowledge message adapter', () => {
  beforeEach(() => {
    vi.resetModules();
    mockChromeStorage();
  });

  it('maps properties, batches, and options without exposing the load recipe', async () => {
    const executeEc = vi.fn(async (code: string) => {
      if (code.includes('__prop__')) {
        return {
          ok: true,
          log: '__prop__|||subtype|||list\n__opt__|||master|||Master',
        };
      }
      const requested = /c\.get\(([^.]+)\.name\)/.exec(code)?.[1] ?? 'Unknown';
      return {
        ok: true,
        log: `__canon__|||root.${requested}\nname|||Name|||TextPropertyConfig|||true`,
      };
    });
    const { setSwContext } = await import('../../sw-context');
    setSwContext({
      settings: { activeProfileId: `type-adapter-${Date.now()}` },
      client: { serverUrl: 'https://bmp.test/Workspace/', executeEc },
    } as never);
    const { getHandler } = await import('../../handler-registry');
    await import('../objects');

    const invoke = async (type: string, message: Record<string, unknown>) => {
      const responses: unknown[] = [];
      await getHandler(type)!({ type, ...message } as never, response => responses.push(response), {
        isOneShot: true,
      });
      return responses[0];
    };

    await expect(invoke('FETCH_TYPE_SCHEMA', { className: 'Label' })).resolves.toMatchObject({
      type: 'FETCH_TYPE_SCHEMA_RESULT',
      className: 'Label',
      ok: true,
      canonicalClassName: 'Label',
      props: [{ accessor: 'name' }],
      environment: expect.stringContaining('type-adapter-'),
    });

    await expect(invoke('FETCH_TYPE_SCHEMAS', {
      classNames: ['Label', 'CeRiskAssessment'],
    })).resolves.toMatchObject({
      type: 'FETCH_TYPE_SCHEMAS_RESULT',
      results: [
        { className: 'Label', ok: true, canonicalClassName: 'Label' },
        { className: 'CeRiskAssessment', ok: true, canonicalClassName: 'CeRiskAssessment' },
      ],
    });

    await expect(invoke('FETCH_TYPE_OPTIONS', {
      className: 'CeRiskAssessment',
    })).resolves.toEqual({
      type: 'FETCH_TYPE_OPTIONS_RESULT',
      className: 'CeRiskAssessment',
      ok: true,
      options: [{
        accessor: 'subtype',
        multi: false,
        items: [{ ref: 't.master', name: 'Master' }],
      }],
    });
  });
});
