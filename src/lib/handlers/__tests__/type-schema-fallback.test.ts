import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockChromeStorage } from '../../__tests__/chrome-mock';
import { setSwContext } from '../../sw-context';
import { loadSchemaProps, parseReferenceHelp } from '../objects';

describe('concrete-reference schema fallback', () => {
  beforeEach(() => {
    mockChromeStorage();
  });

  it('parses BMP help(reference) tables', () => {
    expect(parseReferenceHelp([
      'Message : Result : Help',
      '===============================================================================',
      '|.available          |Available            |Is the object visible in the UI|',
      '|.custom_field       |Custom field         |Workspace-specific value|',
      '===============================================================================',
    ].join('\n'))).toEqual([
      {
        accessor: 'available',
        label: 'Available',
        description: 'Is the object visible in the UI',
        configClass: 'Property',
        systemobject: true,
      },
      {
        accessor: 'custom_field',
        label: 'Custom field',
        description: 'Workspace-specific value',
        configClass: 'Property',
        systemobject: false,
      },
    ]);
  });

  it('falls back only after empty class metadata and caches the result', async () => {
    const executeEc = vi.fn()
      .mockResolvedValueOnce({ ok: true, log: '__canon__|||EditField\n' })
      .mockResolvedValueOnce({
        ok: true,
        log: '|.available|Available|Is the object visible|',
      });
    setSwContext({
      client: { executeEc },
      settings: { activeProfileId: `help-fallback-${Date.now()}` },
    } as never);

    const result = await loadSchemaProps('EditField', false, 't.5611');
    expect(result).toMatchObject({
      ok: true,
      props: [{ accessor: 'available', label: 'Available' }],
    });
    expect(executeEc).toHaveBeenNthCalledWith(2, 'help(t.5611)', undefined, false);
  });

  it('never interpolates an invalid example reference', async () => {
    const executeEc = vi.fn().mockResolvedValue({ ok: true, log: '' });
    setSwContext({
      client: { executeEc },
      settings: { activeProfileId: `invalid-help-${Date.now()}` },
    } as never);

    const result = await loadSchemaProps('EditField', false, 't.5611); output("owned")');
    expect(result.ok).toBe(false);
    expect(executeEc).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent schema reads for the same server and type', async () => {
    let release: ((value: { ok: true; log: string }) => void) | undefined;
    const executeEc = vi.fn(() => new Promise<{ ok: true; log: string }>(resolve => {
      release = resolve;
    }));
    setSwContext({
      client: { executeEc },
      settings: { activeProfileId: `coalesced-schema-${Date.now()}` },
    } as never);

    const first = loadSchemaProps('EditField');
    const second = loadSchemaProps('EditField');
    await vi.waitFor(() => expect(executeEc).toHaveBeenCalledTimes(1));
    release?.({
      ok: true,
      log: '__canon__|||EditField\nname|||Name|||TextPropertyConfig|||false|||100|||name|||TextPropertyConfig',
    });

    const firstResult = await first;
    await expect(second).resolves.toEqual(firstResult);
    expect(firstResult).toMatchObject({ ok: true });
    expect(executeEc).toHaveBeenCalledTimes(1);
  });
});
