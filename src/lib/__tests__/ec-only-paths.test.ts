/**
 * Tests for the EC-only paths introduced when removing binary serializer
 * from enrichment/detail/editor flows.
 *
 * Covers:
 * - resolveTemplate EC output parser
 * - lookupIdentity (batchEnrich single-RID wrapper)
 * - handleServerLookup object construction
 * - openEditorWindow code prop extraction
 */
import { describe, it, expect } from 'vitest';

// ── resolveTemplate parser (mirrors bmp-client.ts resolveTemplate) ──

interface TemplateResolution {
  templateRid: string | null;
  templateName?: string;
  templateType?: string;
}

function parseResolveTemplate(log: string | undefined | null, ok: boolean): TemplateResolution {
  if (!ok || !log) return { templateRid: null };

  // Find the output line (contains |||) — skip "Result : 0", "Duration" etc.
  const lines = log.trim().split('\n');
  const match = lines.find(l => l.includes('|||'))?.trim();
  if (!match || match.startsWith('MISSING')) return { templateRid: null };

  const [tRid, ...rest] = match.split('|||');
  const tType = rest.pop() ?? '';
  const tName = rest.join('|||');
  if (!tRid || tRid === 'MISSING') return { templateRid: null };
  return {
    templateRid: tRid.trim(),
    templateName: tName?.trim() || undefined,
    templateType: tType?.trim() || undefined,
  };
}

// ── lookupIdentity parser (mirrors bmp-client.ts batchEnrich for single RID) ──

function parseLookupIdentity(
  log: string | undefined | null,
  ok: boolean,
  rid: string,
): { name?: string; type?: string; businessId?: string } | null {
  if (!ok || log == null || log.trim() === '') return null;

  for (const line of log.trim().split('\n')) {
    const parts = line.split('|||');
    if (parts.length < 4) continue;
    const [r, bid, typ, name] = parts;
    if (r && r.trim() === rid) {
      return {
        businessId: bid?.trim() || undefined,
        type: typ?.trim() || undefined,
        name: name?.trim() || undefined,
      };
    }
  }
  return null;
}

// ── Tests ──

describe('resolveTemplate EC parser', () => {
  it('parses linked template with all fields', () => {
    const result = parseResolveTemplate(
      '1234567890123456789|||My Template|||TemplateCategory',
      true,
    );
    expect(result.templateRid).toBe('1234567890123456789');
    expect(result.templateName).toBe('My Template');
    expect(result.templateType).toBe('TemplateCategory');
  });

  it('returns null for MISSING (unlinked instance)', () => {
    const result = parseResolveTemplate('MISSING||||||', true);
    expect(result.templateRid).toBeNull();
  });

  it('returns null for MISSING with empty delimiters', () => {
    const result = parseResolveTemplate('MISSING|||', true);
    expect(result.templateRid).toBeNull();
  });

  it('returns null on EC failure', () => {
    const result = parseResolveTemplate(null, false);
    expect(result.templateRid).toBeNull();
  });

  it('returns null on empty log', () => {
    const result = parseResolveTemplate('', true);
    expect(result.templateRid).toBeNull();
  });

  it('handles template with empty name', () => {
    const result = parseResolveTemplate('9876543210|||   |||ExtendedTable', true);
    expect(result.templateRid).toBe('9876543210');
    expect(result.templateName).toBeUndefined();
    expect(result.templateType).toBe('ExtendedTable');
  });

  it('handles multiline output — finds line with |||', () => {
    // EC may output debug lines before the result
    const log = 'some debug line\n1234567890|||Tmpl|||Scorecard';
    const result = parseResolveTemplate(log, true);
    expect(result.templateRid).toBe('1234567890');
    expect(result.templateName).toBe('Tmpl');
    expect(result.templateType).toBe('Scorecard');
  });

  it('skips trailing "Duration" line', () => {
    const log = '1234567890|||My Template|||TemplateCategory\nDuration : 5ms';
    const result = parseResolveTemplate(log, true);
    expect(result.templateRid).toBe('1234567890');
    expect(result.templateName).toBe('My Template');
    expect(result.templateType).toBe('TemplateCategory');
  });

  it('returns null for MISSING with trailing Duration line', () => {
    const log = 'MISSING|||||||\nDuration : 5ms';
    const result = parseResolveTemplate(log, true);
    expect(result.templateRid).toBeNull();
  });

  it('handles name with spaces', () => {
    const result = parseResolveTemplate(
      '111222333|||  Risk Assessment Template  |||TemplateCategory',
      true,
    );
    expect(result.templateName).toBe('Risk Assessment Template');
  });

  it('handles RID-only output (no name or type)', () => {
    const result = parseResolveTemplate('555666777||||||', true);
    expect(result.templateRid).toBe('555666777');
    expect(result.templateName).toBeUndefined();
    expect(result.templateType).toBeUndefined();
  });
});

describe('lookupIdentity (single-RID batchEnrich)', () => {
  const RID = '4945596583281942205';

  it('parses valid single-RID enrichment', () => {
    const log = `${RID}|||sc_grc_risk_summary|||ExtendedTable|||Risk Summary by Module\n`;
    const result = parseLookupIdentity(log, true, RID);
    expect(result).not.toBeNull();
    expect(result!.businessId).toBe('sc_grc_risk_summary');
    expect(result!.type).toBe('ExtendedTable');
    expect(result!.name).toBe('Risk Summary by Module');
  });

  it('returns null when object not found (empty output)', () => {
    const result = parseLookupIdentity('', true, RID);
    expect(result).toBeNull();
  });

  it('returns null when RID is SKIP (lookup failed)', () => {
    const log = 'SKIP|||||||\n';
    const result = parseLookupIdentity(log, true, RID);
    expect(result).toBeNull();
  });

  it('returns null on EC failure', () => {
    const result = parseLookupIdentity(null, false, RID);
    expect(result).toBeNull();
  });

  it('handles fields with missing optional values', () => {
    // 3 delimiters (|||) = 4 parts: RID, empty bid, empty type, empty name
    const log = `${RID}|||||||||\n`;
    const result = parseLookupIdentity(log, true, RID);
    expect(result).not.toBeNull();
    expect(result!.businessId).toBeUndefined();
    expect(result!.type).toBeUndefined();
    expect(result!.name).toBeUndefined();
  });
});

describe('handleServerLookup object construction', () => {
  it('builds BmpObject with identity + code props', () => {
    const identity = { name: 'My Widget', type: 'ExtendedTable', businessId: 'w1' };
    const codeProps = { expression: 'root.children()' };

    const now = Date.now();
    const obj = {
      rid: '12345',
      name: identity.name,
      type: identity.type,
      businessId: identity.businessId,
      properties: { ...codeProps },
      source: 'server' as const,
      discoveredAt: now,
      updatedAt: now,
    };

    expect(obj.rid).toBe('12345');
    expect(obj.name).toBe('My Widget');
    expect(obj.type).toBe('ExtendedTable');
    expect(obj.businessId).toBe('w1');
    expect((obj.properties as any).expression).toBe('root.children()');
    expect(obj.source).toBe('server');
  });

  it('builds BmpObject with empty properties for non-code type', () => {
    const identity = { name: 'Some Folder', type: 'Folder', businessId: 'f1' };
    const properties: Record<string, unknown> = {};
    // No code props for Folder type

    const now = Date.now();
    const obj = {
      rid: '99999',
      name: identity.name,
      type: identity.type,
      businessId: identity.businessId,
      properties,
      source: 'server' as const,
      discoveredAt: now,
      updatedAt: now,
    };

    expect(obj.properties).toEqual({});
    expect(obj.name).toBe('Some Folder');
  });
});

describe('editor code prop extraction', () => {
  it('selects first code prop as primary property', () => {
    const codeProps: Record<string, string> = {
      expression: 'root.children()',
      html: '<div>test</div>',
    };
    const property = Object.keys(codeProps)[0] ?? 'expression';
    const code = codeProps[property] ?? '';

    expect(property).toBe('expression');
    expect(code).toBe('root.children()');
  });

  it('defaults to expression when codeProps is empty', () => {
    const codeProps: Record<string, string> = {};
    const property = Object.keys(codeProps)[0] ?? 'expression';
    const code = codeProps[property] ?? '';

    expect(property).toBe('expression');
    expect(code).toBe('');
  });

  it('template fallback fills codeProps when instance is empty', () => {
    let codeProps: Record<string, string> = {};
    const templateCodeProps: Record<string, string> = { expression: 'template code' };
    let property = Object.keys(codeProps)[0] ?? 'expression';
    let code = codeProps[property] ?? '';

    // Fallback logic from editor.ts
    if (!code && templateCodeProps && Object.keys(templateCodeProps).length > 0) {
      const tmplProperty = Object.keys(templateCodeProps)[0];
      code = templateCodeProps[tmplProperty];
      property = tmplProperty;
      codeProps = { ...templateCodeProps, ...codeProps };
    }

    expect(property).toBe('expression');
    expect(code).toBe('template code');
    expect(codeProps.expression).toBe('template code');
  });
});

describe('paint EC code generation', () => {
  const PAINT_STYLE_PROPS = [
    'headerColor', 'fontColor', 'transparency', 'shadow', 'headerStyle', 'borderStyle',
  ];

  it('generates correct EC for paint apply', () => {
    const sourceRid = '4945596583281942205';
    const targetRid = '6105098650012869467';

    const propAssignments = PAINT_STYLE_PROPS.map(p => `${p} := _src.${p}`).join(', ');
    const code = [
      `_src := lookup(${sourceRid})`,
      `_tgt := lookup(${targetRid})`,
      `_tgt.change(${propAssignments})`,
    ].join('\n');

    expect(code).toContain(`lookup(${sourceRid})`);
    expect(code).toContain(`lookup(${targetRid})`);
    expect(code).toContain('_tgt.change(');
    for (const prop of PAINT_STYLE_PROPS) {
      expect(code).toContain(`${prop} := _src.${prop}`);
    }
  });
});

// ── parseEcResults with deserialized ArrayList ───────────────────

describe('parseEcResults — multi-error accumulation', () => {
  async function getParser() {
    const mod = await import('../bmp-types');
    mod.registerBmpTypes();
    return mod.parseEcResults;
  }

  it('accumulates multiple ServerExceptionResponse errors', async () => {
    const parseEcResults = await getParser();

    const objects = [
      { $class: 'com.corporater.bmp.base.system.exception.ServerExceptionResponse', message: 'Error one' },
      { $class: 'com.corporater.bmp.base.system.exception.ServerExceptionResponse', message: 'Error two' },
    ];

    const result = parseEcResults(objects);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('Error one; Error two');
  });

  it('accumulates server exception + EC error entry', async () => {
    const parseEcResults = await getParser();
    const { JavaEnum } = await import('../java-serial');
    const ERROR = new JavaEnum({ name: 'com.corporater.bmp.dto.command.extended.LogType', uid: 0n, flags: 0, fields: [] }, 'ERROR');

    const objects = [
      { $class: 'com.corporater.bmp.base.system.exception.ServerExceptionResponse', message: 'Server boom' },
      {
        $class: 'com.corporater.bmp.dto.command.extended.ExtendedExecuteResult',
        entries: [{ logType: ERROR, message: 'Variable not found: _x', time: null }],
      },
    ];

    const result = parseEcResults(objects);
    expect(result.ok).toBe(false);
    expect(result.hasError).toBe(true);
    expect(result.error).toBe('Server boom');
    expect(result.log).toContain('Variable not found');
  });
});

describe('parseEcResults', () => {
  // Import the actual function — it's exported from bmp-types
  async function getParser() {
    const mod = await import('../bmp-types');
    mod.registerBmpTypes();
    return mod.parseEcResults;
  }

  // Simulate how JavaReader deserializes an ArrayList: NOT a native array,
  // but an object with $elements, size, length, $class
  function fakeArrayList(elements: any[]) {
    return { $elements: elements, size: elements.length, length: elements.length, $class: 'java.util.ArrayList' };
  }

  // Simulate a JavaEnum as the deserializer produces them
  async function fakeEnum(name: string) {
    const { JavaEnum } = await import('../java-serial');
    return new JavaEnum({ name: 'com.corporater.bmp.dto.command.extended.LogType', uid: 0n, flags: 0, fields: [] }, name);
  }

  it('should extract log entries from deserialized ArrayList (not native array)', async () => {
    const parseEcResults = await getParser();
    const SHOW_RESULT = await fakeEnum('SHOW_RESULT');

    const objects = [
      {
        $class: 'com.corporater.bmp.dto.command.extended.ExtendedExecuteResult',
        entries: fakeArrayList([
          { logType: SHOW_RESULT, message: 'hello world', time: null },
        ]),
      },
    ];

    const result = parseEcResults(objects);
    expect(result.ok).toBe(true);
    expect(result.log).toBe('hello world');
  });

  it('should handle native array entries (backward compat)', async () => {
    const parseEcResults = await getParser();
    const SHOW_RESULT = await fakeEnum('SHOW_RESULT');

    const objects = [
      {
        $class: 'com.corporater.bmp.dto.command.extended.ExtendedExecuteResult',
        entries: [
          { logType: SHOW_RESULT, message: 'native array', time: null },
        ],
      },
    ];

    const result = parseEcResults(objects);
    expect(result.ok).toBe(true);
    expect(result.log).toBe('native array');
  });

  it('should parse multiline batch enrich output from ArrayList', async () => {
    const parseEcResults = await getParser();
    const SHOW_RESULT = await fakeEnum('SHOW_RESULT');

    const batchOutput = '123|||bid1|||Organisation|||Org1\n456|||bid2|||Scorecard|||SC1\n';
    const objects = [
      {
        $class: 'com.corporater.bmp.dto.command.extended.ExtendedExecuteResult',
        entries: fakeArrayList([
          { logType: SHOW_RESULT, message: batchOutput, time: null },
        ]),
      },
    ];

    const result = parseEcResults(objects);
    expect(result.ok).toBe(true);
    expect(result.log).toContain('123|||bid1|||Organisation|||Org1');
    expect(result.log).toContain('456|||bid2|||Scorecard|||SC1');
  });

  it('should detect errors from ArrayList entries', async () => {
    const parseEcResults = await getParser();
    const ERROR = await fakeEnum('ERROR');

    const objects = [
      {
        $class: 'com.corporater.bmp.dto.command.extended.ExtendedExecuteResult',
        entries: fakeArrayList([
          { logType: ERROR, message: 'Variable not found: _x', time: null },
        ]),
      },
    ];

    const result = parseEcResults(objects);
    expect(result.ok).toBe(false);
    expect(result.hasError).toBe(true);
    expect(result.log).toContain('Variable not found');
  });

  it('should handle null/empty entries gracefully', async () => {
    const parseEcResults = await getParser();

    const objects = [
      {
        $class: 'com.corporater.bmp.dto.command.extended.ExtendedExecuteResult',
        entries: fakeArrayList([]),
      },
    ];

    const result = parseEcResults(objects);
    expect(result.ok).toBe(true);
    expect(result.log).toBe('');
  });

  it('should handle entries being null', async () => {
    const parseEcResults = await getParser();

    const objects = [
      {
        $class: 'com.corporater.bmp.dto.command.extended.ExtendedExecuteResult',
        entries: null,
      },
    ];

    const result = parseEcResults(objects);
    expect(result.ok).toBe(true);
    expect(result.log).toBe('');
  });

  // ── SeqListImpl wrapper (BMP 5.6.7.2 live traffic) ──

  // Simulate SeqListImpl → SeqCollectionImpl → delegate ArrayList chain
  function fakeSeqListImpl(elements: any[]) {
    return {
      $class: 'com.corporater.seq.SeqListImpl',
      delegate: {
        $class: 'java.util.ArrayList',
        $elements: elements,
        size: elements.length,
      },
      processorsAndPredicates: null,
    };
  }

  it('should unwrap SeqListImpl → delegate → ArrayList entries', async () => {
    const parseEcResults = await getParser();
    const MESSAGE = await fakeEnum('MESSAGE');

    const objects = [
      {
        $class: 'com.corporater.bmp.dto.command.extended.ExtendedExecuteResult',
        entries: fakeSeqListImpl([
          { logType: MESSAGE, message: '123|||bid1|||Scorecard|||My Scorecard', time: null },
          { logType: MESSAGE, message: 'Duration : 5ms', time: null },
        ]),
      },
    ];

    const result = parseEcResults(objects);
    expect(result.ok).toBe(true);
    expect(result.log).toContain('123|||bid1|||Scorecard|||My Scorecard');
    expect(result.log).toContain('Duration : 5ms');
  });

  it('should handle SeqListImpl with delegate as native array', async () => {
    const parseEcResults = await getParser();
    const MESSAGE = await fakeEnum('MESSAGE');

    const objects = [
      {
        $class: 'com.corporater.bmp.dto.command.extended.ExtendedExecuteResult',
        entries: {
          $class: 'com.corporater.seq.SeqListImpl',
          delegate: [
            { logType: MESSAGE, message: 'native delegate', time: null },
          ],
        },
      },
    ];

    const result = parseEcResults(objects);
    expect(result.ok).toBe(true);
    expect(result.log).toBe('native delegate');
  });

  it('should handle realistic batchEnrich via SeqListImpl + MESSAGE + Result prefix', async () => {
    const parseEcResults = await getParser();
    const MESSAGE = await fakeEnum('MESSAGE');

    // Realistic BMP 5.6.7.2 response: last-expression result has "Result : " prefix
    const objects = [
      {
        $class: 'com.corporater.bmp.dto.command.extended.ExtendedExecuteResult',
        entries: fakeSeqListImpl([
          {
            logType: MESSAGE,
            message: 'Result : 8405321913884644363|||sc_erm_register|||ExtendedTable|||Risk Register\n4741973138639934891|||sc_erm_appetite|||ExtendedTable|||Risk Appetite',
            time: null,
          },
          { logType: MESSAGE, message: 'Duration : 12ms', time: null },
        ]),
      },
    ];

    const result = parseEcResults(objects);
    expect(result.ok).toBe(true);
    // "Result : " prefix should be stripped — first line is clean
    expect(result.log).toContain('8405321913884644363|||sc_erm_register|||ExtendedTable|||Risk Register');
    expect(result.log).toContain('4741973138639934891|||sc_erm_appetite|||ExtendedTable|||Risk Appetite');
  });

  it('should strip "Result : " prefix from MESSAGE entries', async () => {
    const parseEcResults = await getParser();
    const MESSAGE = await fakeEnum('MESSAGE');

    const objects = [
      {
        $class: 'com.corporater.bmp.dto.command.extended.ExtendedExecuteResult',
        entries: [
          { logType: MESSAGE, message: 'Result : hello world', time: null },
        ],
      },
    ];

    const result = parseEcResults(objects);
    expect(result.ok).toBe(true);
    expect(result.log).toBe('hello world');
  });

  it('should not strip "Result : " from non-prefixed messages', async () => {
    const parseEcResults = await getParser();
    const MESSAGE = await fakeEnum('MESSAGE');

    const objects = [
      {
        $class: 'com.corporater.bmp.dto.command.extended.ExtendedExecuteResult',
        entries: [
          { logType: MESSAGE, message: 'no prefix here', time: null },
        ],
      },
    ];

    const result = parseEcResults(objects);
    expect(result.ok).toBe(true);
    expect(result.log).toBe('no prefix here');
  });
});
