/**
 * Characterization goldens for bmp-client.ts methods whose row-building EC
 * lives inline (not a standalone exported pure function) — fetchChildren and
 * batchEnrich. Captures the exact EC these methods sent to BMP, and their
 * exact parse of a representative log, before the plan-014 ec-row-codec
 * migration. `client.executeEc` is stubbed to capture + short-circuit,
 * mirroring the harness in bmp-client-codegen.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import { mockChromeStorage } from './chrome-mock';

async function createClient() {
  mockChromeStorage();
  const { BmpClient } = await import('../bmp-client');
  const client: any = new BmpClient('https://bmp.test/', 'admin', 'pass', 'p1');
  client.applyVersionFlags('5.6.7.2'); // supportsLookup=true → resolveRef returns lookup(rid)
  return client;
}

describe('BmpClient.fetchChildren (golden)', () => {
  it('emits the exact rid|||id|||className|||name row EC', async () => {
    const client = await createClient();
    let captured = '';
    client.executeEc = vi.fn(async (ec: string) => {
      captured = ec;
      return { ok: true, log: '' };
    });
    await client.fetchChildren('123');
    expect(captured).toBe([
      '_o := lookup(123)',
      '_r := ""',
      '_o.children().forEach(_c:',
      '  _r := _r + _c.rid.whenMissing("SKIP") + "|||" + _c.id.whenMissing("") + "|||" + _c.className.whenMissing("") + "|||" + _c.name.whenMissing("") + "\\n"',
      ')',
      '_r',
    ].join('\n'));
  });

  it('parses a representative log into children', async () => {
    const client = await createClient();
    client.executeEc = vi.fn(async () => ({
      ok: true,
      log: [
        '111|||b1|||Container|||Widgets',
        '222|||b2|||Tab|||Overview',
        'SKIP|||||||', // an unresolvable child — dropped
      ].join('\n'),
    }));
    const children = await client.fetchChildren('123');
    expect(children).toEqual([
      { rid: '111', businessId: 'b1', type: 'Container', name: 'Widgets' },
      { rid: '222', businessId: 'b2', type: 'Tab', name: 'Overview' },
    ]);
  });

  it('preserves a `|||` inside a name (name is the last, rejoined field)', async () => {
    const client = await createClient();
    client.executeEc = vi.fn(async () => ({ ok: true, log: '111|||b1|||Container|||A|||B' }));
    const children = await client.fetchChildren('123');
    expect(children[0].name).toBe('A|||B');
  });
});

describe('BmpClient.batchEnrich (golden)', () => {
  it('emits the exact 9-field row for one resolved rid', async () => {
    const client = await createClient();
    let captured = '';
    client.executeEc = vi.fn(async (ec: string) => {
      captured = ec;
      return { ok: true, log: '' };
    });
    await client.batchEnrich(['123']);
    // The row's field VALUES/order/whenMissing-defaults are unchanged from
    // pre-codec — only the literal grouping of the `|||` separators changed
    // (from the `_d` EC variable to inline literals), which is provably the
    // same runtime string. Assert on the row fragment, not the unrelated
    // preamble (template resolution, cascade branches) generated per-rid.
    expect(captured).toContain(
      '  _r := _r + "123" + "|||" + _o.id.whenMissing("") + "|||" + _cls.whenMissing("") + "|||" + _o.name.whenMissing("") + "|||" + _tid + "|||" + _cRid + "|||" + _cBid + "|||" + _cType + "|||" + _cName + "\\n"',
    );
  });

  it('parses a representative 9-field log row', async () => {
    const client = await createClient();
    client.executeEc = vi.fn(async () => ({
      ok: true,
      log: '123|||b1|||Scorecard|||Risk Register|||tb1|||456|||cb1|||InputSet|||My Set\n',
    }));
    const { results } = await client.batchEnrich(['123']);
    expect(results['123']).toEqual({
      businessId: 'b1', type: 'Scorecard', name: 'Risk Register', templateBusinessId: 'tb1',
      cascade: { rid: '456', businessId: 'cb1', type: 'InputSet', name: 'My Set' },
    });
  });

  it('omits cascade when the cascade rid is blank', async () => {
    const client = await createClient();
    client.executeEc = vi.fn(async () => ({
      ok: true,
      log: '123|||b1|||Scorecard|||Risk Register|||tb1|||||||||\n',
    }));
    const { results } = await client.batchEnrich(['123']);
    expect(results['123'].cascade).toBeUndefined();
  });
});
