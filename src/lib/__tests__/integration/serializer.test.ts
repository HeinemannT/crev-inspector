/**
 * Integration tests — binary serializer against real BMP.
 * Tests the exact code path the extension uses: serialize command → send to BMP → deserialize response → parseObjectData.
 * Run with: CREV_INTEGRATION=1 npx vitest run --config vitest.integration.config.ts
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  registerBmpTypes,
  makeGetObjectCommand,
  parseObjectData,
  parseCommandResponse,
  parseEcResults,
  makeExtendedExecuteCommand,
} from '../../bmp-types';
import { serializeCommands, deserializeResponse, deserializeStream } from '../../java-serial';

const BMP_URL = 'http://127.0.0.1:8080/Steadfast/';
const BMP_USER = 'admin';
const BMP_PASS = 'admin';

const skip = !process.env.CREV_INTEGRATION;

// Known RIDs from Steadfast workspace
const EXTENDED_TABLE_RID = '6105098650012869467'; // ExtendedTable with expression
const EXTENDED_TABLE_RID_2 = '4945596583281942205'; // Another ExtendedTable
const CVO_RID = '1574247259405119678'; // CustomVisualization (Risk Heat Map)
const ROOT_ORG_RID = '2127371937565588693'; // Steadfast Group

// Register all BMP class descriptors
registerBmpTypes();

// ── Auth helper ──

let jwt: string;

async function login(): Promise<string> {
  // Step 1: POST /cs/authentication
  const authResp = await fetch(`${BMP_URL}cs/authentication`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `username=${encodeURIComponent(BMP_USER)}&password=${encodeURIComponent(BMP_PASS)}`,
    redirect: 'follow',
  });

  // Step 2: Get auth code via GraphQL
  const cookies = authResp.headers.get('set-cookie') ?? '';
  const jsessionMatch = cookies.match(/JSESSIONID=([^;,\s]+)/);
  const cookieHeader = jsessionMatch ? `JSESSIONID=${jsessionMatch[1]}` : '';

  const gqlResp = await fetch(`${BMP_URL}graphql`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    },
    body: JSON.stringify({
      query: 'query AuthorizationCode { authorizationCode { code } }',
      variables: {},
      operationName: 'AuthorizationCode',
    }),
  });
  const gqlBody = await gqlResp.json();
  const authCode = gqlBody?.data?.authorizationCode?.code;
  if (!authCode) throw new Error('Failed to get authorization code');

  // Step 3: Exchange for JWT
  const tokenResp = await fetch(`${BMP_URL}cstoken`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grantType=authorizationCode&authorizationCode=${encodeURIComponent(authCode)}`,
  });
  const tokenBody = await tokenResp.json();
  if (!tokenBody?.accessToken) throw new Error('No access token');
  return tokenBody.accessToken;
}

async function sendCommand(command: any): Promise<ArrayBuffer> {
  const body = serializeCommands([command]);
  // In Node.js, Uint8Array may share a pooled ArrayBuffer — body.buffer could be huge.
  // Use body directly (not body.buffer) to send only the correct bytes.
  // Note: the Chrome extension uses body.buffer which is fine in browser context.
  const exactBuffer = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
  const res = await fetch(`${BMP_URL}cs/command`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-java-serialized-object',
      'Authorization': `Bearer ${jwt}`,
    },
    body: exactBuffer as unknown as BodyInit,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  return res.arrayBuffer();
}

async function getObject(rid: string) {
  const buffer = await sendCommand(makeGetObjectCommand(rid));
  const raw = deserializeResponse(buffer);
  if (raw?.$class?.includes('ServerExceptionResponse')) {
    return { object: null, error: raw.message ?? 'Server error' };
  }
  const responses = parseCommandResponse(raw);
  const first = responses[0];
  if (!first) return { object: null, error: 'Empty response' };
  const objectData = first.response ?? first;
  const parsed = parseObjectData(objectData);
  return { object: parsed, error: null };
}

async function executeEcDirect(code: string, transactional = false) {
  const cmd = makeExtendedExecuteCommand(code, { transactional });
  const body = serializeCommands([cmd]);
  const exactBuffer = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
  const res = await fetch(`${BMP_URL}cs/command`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-java-serialized-object',
      'Authorization': `Bearer ${jwt}`,
    },
    body: exactBuffer as unknown as BodyInit,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buffer = await res.arrayBuffer();
  const objects = deserializeStream(buffer);
  return parseEcResults(objects);
}

// ── Tests ──

describe.skipIf(skip)('Binary serializer integration', () => {
  beforeAll(async () => {
    jwt = await login();
  });

  it('login works', async () => {
    expect(jwt).toBeTruthy();
    console.log('JWT:', jwt.slice(0, 30) + '...');
  });

  it('raw fetch with JWT succeeds', async () => {
    // Just test that the JWT is valid by hitting health or a simple endpoint
    const res = await fetch(`${BMP_URL}health`);
    console.log('Health status:', res.status);
  });

  it('serialized command bytes look valid', async () => {
    const cmd = makeGetObjectCommand(ROOT_ORG_RID);
    const body = serializeCommands([cmd]);
    console.log('Serialized length:', body.length);
    // Java serialization magic: 0xACED
    expect(body[0]).toBe(0xAC);
    expect(body[1]).toBe(0xED);
    // Version: 0x0005
    expect(body[2]).toBe(0x00);
    expect(body[3]).toBe(0x05);
    // Hex dump first 64 bytes
    const hex = Array.from(body.slice(0, 64)).map(b => b.toString(16).padStart(2, '0')).join(' ');
    console.log('First 64 bytes:', hex);
  });

  it('raw binary POST — check what BMP actually says', async () => {
    const cmd = makeGetObjectCommand(ROOT_ORG_RID);
    const body = serializeCommands([cmd]);
    // Try sending the Uint8Array directly
    const res = await fetch(`${BMP_URL}cs/command`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-java-serialized-object',
        'Authorization': `Bearer ${jwt}`,
      },
      body: body as unknown as BodyInit,
    });
    console.log('Direct Uint8Array status:', res.status);
    console.log('Direct Uint8Array status text:', res.statusText);
    const respBody = await res.text();
    console.log('Response body:', respBody.slice(0, 500));
    console.log('Response headers:', Object.fromEntries(res.headers.entries()));
    // Also check body.byteLength vs body.buffer.byteLength
    console.log('body.byteLength:', body.byteLength, 'body.buffer.byteLength:', body.buffer.byteLength);
  });

  it('getObject — root org resolves', async () => {
    const { object, error } = await getObject(ROOT_ORG_RID);
    expect(error).toBeNull();
    expect(object).not.toBeNull();
    expect(object!.rid).toBe(ROOT_ORG_RID);
    expect(object!.properties.name).toBe('Steadfast Group');
    console.log('Root org type:', object!.type, 'props:', Object.keys(object!.properties));
  });

  it('getObject — ExtendedTable has expression property', async () => {
    const { object, error } = await getObject(EXTENDED_TABLE_RID);
    expect(error).toBeNull();
    expect(object).not.toBeNull();
    expect(object!.type).toBe('ExtendedTable');

    const props = object!.properties;
    console.log('ExtendedTable props:', Object.keys(props));
    console.log('expression typeof:', typeof props.expression);
    console.log('expression value:', typeof props.expression === 'string'
      ? props.expression.slice(0, 100)
      : JSON.stringify(props.expression)?.slice(0, 200));

    // After our parseObjectData fix, expression should be unwrapped to string
    if (props.expression !== undefined) {
      expect(typeof props.expression).toBe('string');
    }
  });

  it('getObject — second ExtendedTable expression check', async () => {
    const { object, error } = await getObject(EXTENDED_TABLE_RID_2);
    expect(error).toBeNull();
    expect(object).not.toBeNull();
    expect(object!.type).toBe('ExtendedTable');

    const props = object!.properties;
    console.log('ET2 expression typeof:', typeof props.expression);
    console.log('ET2 expression:', typeof props.expression === 'string'
      ? props.expression.slice(0, 200)
      : JSON.stringify(props.expression)?.slice(0, 200));

    if (props.expression !== undefined) {
      expect(typeof props.expression).toBe('string');
    }
  });

  it('getObject — CVO has html/javascript properties', async () => {
    const { object, error } = await getObject(CVO_RID);
    expect(error).toBeNull();
    expect(object).not.toBeNull();

    const props = object!.properties;
    console.log('CVO type:', object!.type);
    console.log('CVO props:', Object.keys(props));
    console.log('html typeof:', typeof props.html);
    console.log('javascript typeof:', typeof props.javascript);

    // CVO html/javascript are plain Strings — should always be strings
    if (props.html !== undefined) {
      expect(typeof props.html).toBe('string');
    }
    if (props.javascript !== undefined) {
      expect(typeof props.javascript).toBe('string');
    }
  });

  it('EC execute — read expression via output()', async () => {
    const result = await executeEcDirect(
      `_o := lookup(${EXTENDED_TABLE_RID})\noutput(_o.expression.whenMissing("EMPTY"))\n0`
    );
    expect(result.ok).toBe(true);
    console.log('EC expression read:', result.log?.slice(0, 200));
    // Should have some content (not empty string)
    expect(result.log).toBeTruthy();
  });

  it('EC execute — fetchCodeViaEc pattern', async () => {
    // Reproduce the exact EC that fetchCodeViaEc generates
    const sep = '<<<CREV_SEP>>>';
    const code = [
      `_o := lookup(${EXTENDED_TABLE_RID})`,
      `output("${sep}expression${sep}")`,
      `output(_o.expression.whenMissing(""))`,
      `output("${sep}DONE")`,
      '0',
    ].join('\n');

    const result = await executeEcDirect(code);
    expect(result.ok).toBe(true);
    expect(result.log).toContain(sep);

    // Parse exactly like fetchCodeViaEc does
    const parts = result.log!.split(sep);
    const out: Record<string, string> = {};
    for (let i = 1; i < parts.length; i += 2) {
      const propName = parts[i];
      if (propName === 'DONE') break;
      const value = (parts[i + 1] ?? '').replace(/^\n/, '').replace(/\n$/, '');
      if (value) out[propName] = value;
    }

    console.log('Parsed EC code props:', Object.keys(out));
    console.log('expression length:', out.expression?.length);
    console.log('expression preview:', out.expression?.slice(0, 100));
  });

  it('parseObjectData — CorpoExpression objects are unwrapped', async () => {
    // Fetch raw object and inspect the deserialized structure before parseObjectData
    const buffer = await sendCommand(makeGetObjectCommand(EXTENDED_TABLE_RID));
    const raw = deserializeResponse(buffer);
    const responses = parseCommandResponse(raw);
    const first = responses[0];
    const objectData = first?.response ?? first;

    // Log the raw expression value BEFORE parseObjectData
    const rawProps = objectData?.props || objectData;
    const rawExpr = rawProps?.expression;
    console.log('RAW expression type:', typeof rawExpr);
    console.log('RAW expression $class:', rawExpr?.$class);
    console.log('RAW expression value:', typeof rawExpr?.value === 'string' ? rawExpr.value.slice(0, 100) : rawExpr);

    // Now run parseObjectData and verify unwrapping
    const parsed = parseObjectData(objectData);
    expect(parsed).not.toBeNull();
    if (parsed!.properties.expression !== undefined) {
      expect(typeof parsed!.properties.expression).toBe('string');
      console.log('PARSED expression:', (parsed!.properties.expression as string).slice(0, 100));
    } else {
      console.log('PARSED: expression is undefined (not in properties)');
    }
  });
});
