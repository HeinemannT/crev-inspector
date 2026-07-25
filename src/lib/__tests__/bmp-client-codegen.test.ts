/**
 * Tests for BmpClient EC codegen paths that are version-sensitive.
 *
 * Specifically:
 * - resolveRef(rid) version branches:
 *     - supportsLookup === true  → `lookup(rid)`
 *     - supportsLookup === false → `{ns}.{bid}` (via cache) or `{ns}.{bid}` (via binary identity fetch)
 *     - cache miss + no identity → throws
 * - saveCodeViaEc():
 *     - escapes backslashes, double quotes, CR, LF
 *     - dispatches to template vs instance (per saveTarget) — implemented at the
 *       caller layer; here we verify it writes to whichever RID is passed in.
 */
import { describe, it, expect, vi } from 'vitest';
import { mockChromeStorage } from './chrome-mock';

interface CodegenHarness {
  client: any;
  executeEcCalls: string[];
  transportMock: ReturnType<typeof vi.fn>;
}

async function createClientHarness(): Promise<CodegenHarness> {
  mockChromeStorage();
  const { BmpClient } = await import('../bmp-client');
  const client = new BmpClient('https://bmp.test/', 'admin', 'pass', 'p1');

  const transportMock = vi.fn<(...args: any[]) => Promise<any[]>>();
  (client as any).transport = {
    sendStreamingCommand: transportMock,
    sendCommands: vi.fn(),
    sendRequest: vi.fn(),
    deserializeResponse: vi.fn(),
    formatError: (e: unknown) => e instanceof Error ? e.message : String(e),
  };
  (client as any).auth = {
    ensureAuth: vi.fn(async () => 'mock-jwt'),
    login: vi.fn(async () => 'mock-jwt'),
    logout: vi.fn(),
    invalidateLoginTicket: vi.fn(),
    refreshLoginTicket: vi.fn(async () => 'mock-ticket'),
    recoverAuth: vi.fn(async () => 'mock-jwt'),
    absorbAuth: vi.fn(),
    refreshAuth: vi.fn(async () => null),
    _jwt: 'mock-jwt',
  };

  // Capture every EC code string that goes through executeEc()
  const executeEcCalls: string[] = [];
  const realExecuteEc = client.executeEc.bind(client);
  client.executeEc = vi.fn(async (code: string, objectRid?: string, transactional = false) => {
    executeEcCalls.push(code);
    return realExecuteEc(code, objectRid, transactional);
  });

  return { client, executeEcCalls, transportMock };
}

describe('BmpClient.resolveRef — version branches', () => {
  it('supportsLookup === true → lookup(rid)', async () => {
    const { client } = await createClientHarness();
    client.applyVersionFlags('5.6.7.2');
    expect(client.supportsLookup).toBe(true);

    const ref = await client.resolveRef('1234567890123456789');
    expect(ref).toBe('lookup(1234567890123456789)');
  });

  it('supportsLookup === null (not yet detected) → lookup(rid) — safe default', async () => {
    const { client } = await createClientHarness();
    // No version flags applied → supportsLookup is null
    expect(client.supportsLookup).toBeNull();

    const ref = await client.resolveRef('111');
    expect(ref).toBe('lookup(111)');
  });

  it('supportsLookup === false + cache hit → namespace prefix + businessId', async () => {
    const { client } = await createClientHarness();
    client.assumeOldBmp();
    expect(client.supportsLookup).toBe(false);

    // Inject cache that knows the businessId + type
    client.cache = {
      get: vi.fn((_rid: string) => ({ businessId: 'sc_main', type: 'Scorecard' })),
    };

    const ref = await client.resolveRef('111');
    // Scorecard isn't in NAMESPACE_MAP → falls back to 't'
    expect(ref).toBe('t.sc_main');
  });

  it('supportsLookup === false + cache hit for ExtendedMethodConfig → k.{bid}', async () => {
    const { client } = await createClientHarness();
    client.assumeOldBmp();
    client.cache = {
      get: vi.fn((_rid: string) => ({ businessId: 'pMyProp', type: 'ExtendedMethodConfig' })),
    };

    const ref = await client.resolveRef('111');
    // ExtendedMethodConfig → "k" namespace
    expect(ref).toBe('k.pMyProp');
  });

  it('supportsLookup === false + cache miss → binary identity fetch fallback', async () => {
    const { client } = await createClientHarness();
    client.assumeOldBmp();
    // No cache attached
    client.cache = { get: vi.fn(() => undefined) };

    // Mock transport.sendCommands → JavaReader-style ArrayList wrapping a TreeNodeInformationDto
    (client as any).transport.sendCommands = vi.fn(async () => {
      // sendCommands returns the raw buffer that deserializeStream consumes.
      // To keep this test focused on the resolveRef branch, we bypass
      // deserializeStream by intercepting fetchTreeItem via prototype.
      return new Uint8Array().buffer;
    });

    // Easier: stub the private fetchTreeItem indirectly via getObjectIdentity result
    // by spying on transport.sendCommands to return a buffer that deserializes
    // to a TreeNodeInformationDto. The cleanest route is to monkey-patch
    // getObjectIdentity through the prototype.
    const proto = Object.getPrototypeOf(client);
    const origGetIdentity = proto.getObjectIdentity;
    proto.getObjectIdentity = async (_rid: string) => ({
      rid: _rid, businessId: 'sc_fetched', type: 'Scorecard', name: 'Fetched',
    });
    try {
      const ref = await client.resolveRef('999');
      expect(ref).toBe('t.sc_fetched');
    } finally {
      proto.getObjectIdentity = origGetIdentity;
    }
  });

  it('supportsLookup === false + cache miss + identity fetch fails → throws', async () => {
    const { client } = await createClientHarness();
    client.assumeOldBmp();
    client.cache = { get: vi.fn(() => undefined) };

    const proto = Object.getPrototypeOf(client);
    const origGetIdentity = proto.getObjectIdentity;
    proto.getObjectIdentity = async () => null;
    try {
      await expect(client.resolveRef('999')).rejects.toThrow(/Cannot resolve object 999/);
    } finally {
      proto.getObjectIdentity = origGetIdentity;
    }
  });

  it('rejects non-numeric RIDs (EC injection guard)', async () => {
    const { client } = await createClientHarness();
    await expect(client.resolveRef('1; evil()')).rejects.toThrow(/Invalid RID/);
    await expect(client.resolveRef('abc')).rejects.toThrow(/Invalid RID/);
    await expect(client.resolveRef('')).rejects.toThrow(/Invalid RID/);
  });

  it('accepts negative RIDs (valid Java long)', async () => {
    const { client } = await createClientHarness();
    client.applyVersionFlags('5.6.7.2');
    const ref = await client.resolveRef('-7302918475028293741');
    expect(ref).toBe('lookup(-7302918475028293741)');
  });
});

describe('BmpClient.applyVersionFlags', () => {
  it('5.6.3+ enables lookup', async () => {
    const { client } = await createClientHarness();
    client.applyVersionFlags('5.6.3.0');
    expect(client.supportsLookup).toBe(true);
  });

  it('pre-5.6.3 disables lookup', async () => {
    const { client } = await createClientHarness();
    client.applyVersionFlags('5.6.2.99');
    expect(client.supportsLookup).toBe(false);
  });

  it('strips leading "v." prefix from version string', async () => {
    const { client } = await createClientHarness();
    client.applyVersionFlags('v.5.6.7.2');
    expect(client.supportsLookup).toBe(true);
  });

  it('assumeOldBmp() disables lookup', async () => {
    const { client } = await createClientHarness();
    client.assumeOldBmp();
    expect(client.supportsLookup).toBe(false);
  });
});

describe('BmpClient.saveCodeViaEc — escaping', () => {
  async function captureSaveCode(client: any, code: string): Promise<string> {
    // Mock executeEc to capture the EC string and short-circuit
    let captured = '';
    client.executeEc = vi.fn(async (ec: string) => {
      captured = ec;
      return { ok: true };
    });
    client.applyVersionFlags('5.6.7.2'); // ensure lookup() path is used
    await client.saveCodeViaEc('1234567890123456789', 'expression', code);
    return captured;
  }

  it('escapes backslashes', async () => {
    const { client } = await createClientHarness();
    const ec = await captureSaveCode(client, 'path \\ thing');
    // Each \ in the source code becomes \\\\ in the EC literal
    expect(ec).toContain('"path \\\\ thing"');
  });

  it('escapes double quotes', async () => {
    const { client } = await createClientHarness();
    const ec = await captureSaveCode(client, 'say "hi"');
    expect(ec).toContain('"say \\"hi\\""');
  });

  it('escapes LF (regression: \\n in value must NOT break EC literal)', async () => {
    const { client } = await createClientHarness();
    const ec = await captureSaveCode(client, 'line1\nline2');
    // The EC literal stays single-quoted-line — the inner LF becomes \n
    expect(ec).toContain('"line1\\nline2"');
    // The change line itself must still be a single EC statement
    const changeLine = ec.split('\n').find(l => l.includes('_o.change'))!;
    expect(changeLine).toContain('line1\\nline2');
  });

  it('escapes CR', async () => {
    const { client } = await createClientHarness();
    const ec = await captureSaveCode(client, 'a\rb');
    expect(ec).toContain('"a\\rb"');
  });

  it('order-of-escapes: backslash escape happens first (no double-escape of injected backslashes)', async () => {
    const { client } = await createClientHarness();
    // Single backslash before quote: the user wrote \" — should become \\" in EC
    const ec = await captureSaveCode(client, '\\"');
    // Source: \  "    → after \-escape: \\  "  → after "-escape: \\  \"
    expect(ec).toContain('"\\\\\\""');
  });

  it('uses lookup(rid) reference under supportsLookup=true', async () => {
    const { client } = await createClientHarness();
    const ec = await captureSaveCode(client, 'test');
    expect(ec).toContain('_o := lookup(1234567890123456789)');
    expect(ec).toContain('_o.change(expression := "test")');
  });

  it('uses namespace.bid reference under supportsLookup=false', async () => {
    const { client } = await createClientHarness();
    client.assumeOldBmp();
    client.cache = { get: vi.fn(() => ({ businessId: 'sc_main', type: 'Scorecard' })) };

    let captured = '';
    client.executeEc = vi.fn(async (ec: string) => { captured = ec; return { ok: true }; });
    await client.saveCodeViaEc('1234567890123456789', 'expression', 'test');

    expect(captured).toContain('_o := t.sc_main');
    expect(captured).toContain('_o.change(expression := "test")');
  });
});

describe('BmpClient.saveCodeViaEc — template vs instance routing', () => {
  // saveCodeViaEc takes the resolved RID directly; the template-vs-instance
  // decision is made by the *caller* (which uses saveTarget to pick which RID
  // to pass). We assert that whatever RID is passed is what saveCodeViaEc
  // writes to.
  it('writes to whichever RID is passed (instance RID)', async () => {
    const { client } = await createClientHarness();
    client.applyVersionFlags('5.6.7.2');
    let captured = '';
    client.executeEc = vi.fn(async (ec: string) => { captured = ec; return { ok: true }; });

    await client.saveCodeViaEc('1111', 'expression', 'inst');
    expect(captured).toContain('_o := lookup(1111)');
  });

  it('writes to whichever RID is passed (template RID)', async () => {
    const { client } = await createClientHarness();
    client.applyVersionFlags('5.6.7.2');
    let captured = '';
    client.executeEc = vi.fn(async (ec: string) => { captured = ec; return { ok: true }; });

    await client.saveCodeViaEc('2222', 'expression', 'tmpl');
    expect(captured).toContain('_o := lookup(2222)');
  });

  it('uses the property name verbatim (html / javascript / expression)', async () => {
    const { client } = await createClientHarness();
    client.applyVersionFlags('5.6.7.2');

    for (const prop of ['expression', 'html', 'javascript']) {
      let captured = '';
      client.executeEc = vi.fn(async (ec: string) => { captured = ec; return { ok: true }; });
      await client.saveCodeViaEc('111', prop, 'x');
      expect(captured).toContain(`_o.change(${prop} := "x")`);
    }
  });

  it('returns { ok: false } with error text when EC fails', async () => {
    const { client } = await createClientHarness();
    client.applyVersionFlags('5.6.7.2');
    client.executeEc = vi.fn(async () => ({ ok: false, error: 'permission denied' }));
    const result = await client.saveCodeViaEc('111', 'expression', 'x');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('permission denied');
  });
});
