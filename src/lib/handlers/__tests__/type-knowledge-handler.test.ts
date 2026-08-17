import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockChromeStorage } from '../../__tests__/chrome-mock';

describe('BMP type-knowledge message adapter', () => {
  beforeEach(() => {
    vi.resetModules();
    mockChromeStorage();
  });

  it('maps properties, batches, and options without exposing the load recipe', async () => {
    const executeEc = vi.fn(async (code: string) => {
      if (code.includes('root.ceRiskAssessments.children()')) {
        return { ok: true, log: 'CeRiskAssessment' };
      }
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

    await expect(invoke('RESOLVE_ROOT_CATEGORY', {
      category: 'ceRiskAssessments',
    })).resolves.toEqual({
      type: 'RESOLVE_ROOT_CATEGORY_RESULT',
      category: 'ceRiskAssessments',
      ok: true,
      className: 'CeRiskAssessment',
    });
  });

  it('includes persistent type knowledge in RESET_ALL', async () => {
    const clear = vi.fn();
    const logActivity = vi.fn();
    const toast = vi.fn();
    const { setSwContext } = await import('../../sw-context');
    setSwContext({
      settings: { activeProfileId: 'reset-profile' },
      cache: { clear },
      history: { clear: vi.fn() },
      scriptHistory: { clear: vi.fn() },
      logActivity,
      toast,
      broadcastToContent: vi.fn(),
      sendToPanel: vi.fn(),
    } as never);
    const { getHandler } = await import('../../handler-registry');
    await import('../objects');
    const responses: unknown[] = [];

    await getHandler('RESET_ALL')!({ type: 'RESET_ALL' }, response => responses.push(response), {
      isOneShot: true,
    });

    expect(clear).toHaveBeenCalledTimes(1);
    expect(chrome.storage.local.remove).toHaveBeenCalledWith([
      'crev_schema_cache_v2',
      'crev_root_category_cache_v1',
    ]);
    expect(logActivity).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith('Extension state reset', 'success');
    expect(responses).toContainEqual({ type: 'CACHE_STATS', count: 0 });
  });
});
