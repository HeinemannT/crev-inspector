/**
 * @vitest-environment happy-dom
 *
 * End-to-end check of PROPERTY autocomplete at a dot-member position — the full
 * async chain, not just the parser. The riskiest part is the dot-member ns.bid
 * path, which is TWO-STAGE: resolveContext returns a `ref`, the first ensure()
 * pass fires HOVER_RESOLVE (ref → class), and only the NEXT ensure() pass (after
 * a notify) fetches that class's schema. This test drives propertyCompletions
 * through a CompletionContext with a mocked SW so that staged notify/subscribe
 * timing is actually exercised — a bug there wouldn't show in the pure-parse
 * unit tests.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { CompletionContext } from '@codemirror/autocomplete';
import { propertyCompletions } from '../ec/propertyCompletions';
import * as ti from '../ec/typeInference';
import type { TypeSchemaProp } from '../../lib/types';

const RISK_PROPS: TypeSchemaProp[] = [
  { accessor: 'id', label: 'id', configClass: 'SystemMethodConfig', systemobject: true },
  { accessor: 'name', label: 'name', configClass: 'SystemMethodConfig', systemobject: true },
  { accessor: 'subtype', label: 'Subtype', configClass: 'ListMethodConfig', systemobject: false },
  { accessor: 'owning_org', label: 'Owning Organisation', configClass: 'ReferenceMethodConfig', systemobject: false },
];
const ORG_PROPS: TypeSchemaProp[] = [
  { accessor: 'id', label: 'id', configClass: 'SystemMethodConfig', systemobject: true },
  { accessor: 'orgType', label: 'Org Type', configClass: 'ListMethodConfig', systemobject: false },
];

async function flushAsync() {
  for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0));
}

/** Mock the SW: HOVER_RESOLVE maps a ref → objectType; FETCH_TYPE_SCHEMA maps a
 *  class → props. Both straight from the tables above. */
function mockSw(refTypes: Record<string, string>, schemas: Record<string, TypeSchemaProp[]>) {
  (globalThis as unknown as { chrome: { runtime: { sendMessage: ReturnType<typeof vi.fn> } } }).chrome = {
    runtime: {
      sendMessage: vi.fn((msg: unknown) => {
        const m = msg as { type: string; ref?: string; className?: string };
        if (m.type === 'HOVER_RESOLVE' && m.ref) {
          return Promise.resolve({ type: 'HOVER_RESOLVE_RESULT', ref: m.ref, objectType: refTypes[m.ref] });
        }
        if (m.type === 'FETCH_TYPE_SCHEMA' && m.className) {
          const props = schemas[m.className.toLowerCase()];
          return Promise.resolve(props
            ? { type: 'FETCH_TYPE_SCHEMA_RESULT', className: m.className, ok: true, props, canonicalClassName: m.className }
            : { type: 'FETCH_TYPE_SCHEMA_RESULT', className: m.className, ok: false, error: 'unknown' });
        }
        return Promise.resolve({ ok: false });
      }),
    },
  };
}

/** Seed a class's schema as if already fetched (skips the SW round-trip). */
function seedSchema(className: string, props: TypeSchemaProp[]) {
  (globalThis as unknown as { chrome: { runtime: { sendMessage: ReturnType<typeof vi.fn> } } }).chrome.runtime.sendMessage =
    vi.fn(() => Promise.resolve({ type: 'FETCH_TYPE_SCHEMA_RESULT', className, ok: true, props, canonicalClassName: className }));
  ti.ensureSchemaNow(className);
}

/** Run propertyCompletions at the end of `doc`, draining async stages. */
async function propsAt(doc: string): Promise<string[] | null> {
  const state = EditorState.create({ doc });
  const res = await propertyCompletions(new CompletionContext(state, doc.length, false));
  return res ? res.options.map(o => o.label) : null;
}

/** Like propsAt but returns the full options (label + boost) for ranking checks. */
async function optionsAt(doc: string) {
  const state = EditorState.create({ doc });
  const res = await propertyCompletions(new CompletionContext(state, doc.length, false));
  return res ? res.options.map(o => ({ label: o.label, boost: o.boost })) : null;
}

beforeEach(() => {
  mockSw({}, {});
  ti._resetForTests();
});

describe('property autocomplete at a dot-member — end to end', () => {
  it('offers a SCALAR var’s props (_o := _l.first(); _o.)', async () => {
    mockSw({}, { ceriskassessment: RISK_PROPS });
    ti.scanDocForInferences({
      lines: 2,
      line: (n: number) => ({ text: ['_l := SELECT CeRiskAssessment', '_o := _l.first()'][n - 1] }),
    });
    await seedSchema('CeRiskAssessment', RISK_PROPS); await flushAsync();
    expect(await propsAt('_o.')).toEqual(['id', 'name', 'subtype', 'owning_org']);
  });

  it('stays silent for a LIST var at a bare dot (methods, not props)', async () => {
    ti.scanDocForInferences({ lines: 1, line: () => ({ text: '_l := SELECT CeRiskAssessment' }) });
    expect(await propsAt('_l.')).toBeNull();
  });

  it('two-stage: ns.bid ref resolves class THEN fetches schema (ceras.foo.)', async () => {
    mockSw({ 'ceras.stmt_supplier_failure': 'CeRiskAssessment' }, { ceriskassessment: RISK_PROPS });
    // Nothing pre-seeded: this drives HOVER_RESOLVE → FETCH_TYPE_SCHEMA via the
    // staged ensure()/notify loop inside awaitCompletion.
    expect(await propsAt('ceras.stmt_supplier_failure.')).toEqual(['id', 'name', 'subtype', 'owning_org']);
  });

  it('two-stage CONCRETE nested hop (ceras.foo.owning_org. → Organisation props)', async () => {
    mockSw({ 'ceras.stmt_supplier_failure.owning_org': 'Organisation' }, { organisation: ORG_PROPS });
    expect(await propsAt('ceras.stmt_supplier_failure.owning_org.')).toEqual(['id', 'orgType']);
  });

  it('a ns.bid that resolves to NO class yields no props (giveUp, no hang)', async () => {
    mockSw({}, {}); // HOVER_RESOLVE returns objectType undefined → null cache
    expect(await propsAt('ceras.nonexistent.')).toBeNull();
  });

  it('dot-member props ALL outrank methods (boost ≥ 1) so system props aren’t buried', async () => {
    // In a `obj.` slot every property — custom (+2) AND system (+1) — must rank
    // above the method list (boost 0), so `name`/`id`/`location` aren't lost below
    // ~30 methods (the real Organisation case: 26 system props, 0 custom).
    mockSw({ 'ceras.foo': 'Organisation' }, { organisation: ORG_PROPS });
    const opts = await optionsAt('ceras.foo.');
    expect(opts).not.toBeNull();
    // Every system prop is boosted to +1 (above methods at 0) in member context.
    expect(opts!.every(o => (o.boost ?? 0) >= 1)).toBe(true);
    expect(opts!.map(o => o.label)).toContain('orgType'); // sanity: real props present
  });

  it('refuses a nested hop off a non-concrete base (_o.owning_org.) — no SELECT scan', async () => {
    mockSw({}, { ceriskassessment: RISK_PROPS });
    ti.scanDocForInferences({
      lines: 2,
      line: (n: number) => ({ text: ['_l := SELECT CeRiskAssessment', '_o := _l.first()'][n - 1] }),
    });
    await seedSchema('CeRiskAssessment', RISK_PROPS); await flushAsync();
    expect(await propsAt('_o.owning_org.')).toBeNull();
  });
});

describe('property autocomplete at a NAMED loop variable (forEach/lambda param)', () => {
  const scan = (lines: string[]) => ti.scanDocForInferences({ lines: lines.length, line: (n: number) => ({ text: lines[n - 1] }) });

  it('completes a loop var over a SELECT, across lines (_risks.forEach(_risk: … _risk.))', async () => {
    mockSw({}, { ceriskassessment: RISK_PROPS });
    const lines = ['_risks := SELECT CeRiskAssessment', '_risks.forEach(_risk:', '     _x := _risk.'];
    scan(lines);
    await seedSchema('CeRiskAssessment', RISK_PROPS); await flushAsync();
    expect(await propsAt(lines.join('\n'))).toEqual(['id', 'name', 'subtype', 'owning_org']);
  });

  it('follows a filter-preserved element type (_count := _risks.filter(…); _count.forEach(_risk: _risk.))', async () => {
    mockSw({}, { ceriskassessment: RISK_PROPS });
    const lines = ['_risks := SELECT CeRiskAssessment', '_count := _risks.filter(name = "x")', '_count.forEach(_risk:', '     _x := _risk.'];
    scan(lines);
    await seedSchema('CeRiskAssessment', RISK_PROPS); await flushAsync();
    expect(await propsAt(lines.join('\n'))).toEqual(['id', 'name', 'subtype', 'owning_org']);
  });

  it('the loop binding wins over a same-named outer assignment (no shadow leak inside the body)', async () => {
    mockSw({}, { ceriskassessment: RISK_PROPS, organisation: ORG_PROPS });
    // _risk is ALSO bound to an Organisation list at top level, but inside the forEach it is the element.
    const lines = ['_risk := SELECT Organisation', '_risks := SELECT CeRiskAssessment', '_risks.forEach(_risk:', '     _x := _risk.'];
    scan(lines);
    await seedSchema('CeRiskAssessment', RISK_PROPS); await seedSchema('Organisation', ORG_PROPS); await flushAsync();
    expect(await propsAt(lines.join('\n'))).toEqual(['id', 'name', 'subtype', 'owning_org']); // the element type, not Organisation
  });

  it('stays silent for a non-bound identifier inside the body (fail-silent)', async () => {
    const lines = ['_risks := SELECT CeRiskAssessment', '_risks.forEach(_risk:', '     _x := _other.'];
    scan(lines);
    expect(await propsAt(lines.join('\n'))).toBeNull();
  });

  it('matches the method name case-insensitively — lowercase `foreach` (real EC), not just camelCase', async () => {
    mockSw({}, { ceriskassessment: RISK_PROPS });
    const lines = ['_risks := SELECT CeRiskAssessment', '_risks.foreach(_risk:', '     _x := _risk.'];
    scan(lines);
    await seedSchema('CeRiskAssessment', RISK_PROPS); await flushAsync();
    expect(await propsAt(lines.join('\n'))).toEqual(['id', 'name', 'subtype', 'owning_org']);
  });

  it('resolves the INNER loop var of a nested lowercase foreach (…children().foreach(_cat: …_count.foreach(_risk: _risk.)))', async () => {
    mockSw({}, { ceriskassessment: RISK_PROPS });
    const lines = [
      '_risks := SELECT CeRiskAssessment',
      't.risk_categories.children().foreach(_cat:',
      '     _count := _risks.filter(mainCats = _cat)',
      '     _count.foreach(_risk:',
      '          _x := _risk.',
    ];
    scan(lines);
    await seedSchema('CeRiskAssessment', RISK_PROPS); await flushAsync();
    expect(await propsAt(lines.join('\n'))).toEqual(['id', 'name', 'subtype', 'owning_org']);
  });
});
