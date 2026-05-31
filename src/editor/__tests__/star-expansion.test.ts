/**
 * Tests for the `*` → property list expansion provider.
 *
 * Verifies:
 *   - Triggers only inside `.table(*)` with the `*` directly after `(`
 *   - Receiver must be a tracked var with a list/scalar inference
 *   - Multi-type lists return INTERSECTION accessors
 *   - System fields excluded from the default expansion
 *   - Schema not yet loaded → returns null (autocomplete will retry)
 *
 * The non-public state in typeInference is poked via the exported
 * functions to seed inferences/schemas without round-tripping to the SW.
 *
 * @vitest-environment happy-dom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import { EditorState } from '@codemirror/state';
import { starExpansionCompletions } from '../ec/starExpansion';

// Set up a fake chrome.runtime so typeInference's async fetches don't
// blow up when scanDocForInferences eagerly calls ensureSchema().
// Also reset module state so tests don't cross-pollute each other.
beforeEach(() => {
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: { sendMessage: vi.fn(() => Promise.resolve({ ok: false })) },
  };
  ti._resetForTests();
});

/** Build a CompletionContext positioned just after the given text. */
function ctxAfter(text: string): CompletionContext {
  const state = EditorState.create({ doc: text });
  return {
    state,
    pos: text.length,
    explicit: false,
    matchBefore(re: RegExp) {
      const line = state.doc.lineAt(text.length);
      const offset = text.length - line.from;
      const m = re.exec(line.text.slice(0, offset));
      if (!m) return null;
      return { from: line.from + offset - m[0].length, to: line.from + offset, text: m[0] };
    },
    aborted: false,
    addEventListener: () => {},
  } as unknown as CompletionContext;
}

/** Force-seed typeInference's state by running its scanner against a
 *  fake doc, then injecting schemas directly into the module's state
 *  via a re-import + private hatch.
 *
 *  Easier: have the doc include a SELECT for static inference, then
 *  poke the schema via the typeInference module's exported helpers.
 *  We have to import dynamically to access internal state. */
import * as ti from '../ec/typeInference';

function seed(doc: string, schemas: Record<string, Array<{ accessor: string; label: string; configClass: string; systemobject: boolean }>>): void {
  // 1. Install the mock FIRST.
  (globalThis as unknown as { chrome: { runtime: { sendMessage: ReturnType<typeof vi.fn> } } }).chrome.runtime.sendMessage = vi.fn((msg) => {
    const m = msg as { type: string; className?: string };
    if (m.type === 'FETCH_TYPE_SCHEMA' && m.className && schemas[m.className]) {
      return Promise.resolve({ type: 'FETCH_TYPE_SCHEMA_RESULT', className: m.className, ok: true, props: schemas[m.className] });
    }
    return Promise.resolve({ ok: false });
  });
  // 2. Populate inferences from RHS patterns (sync, no I/O).
  ti.scanDocForInferences({
    lines: doc.split('\n').length,
    line: (n: number) => ({ text: doc.split('\n')[n - 1] }),
  });
  // 3. Pre-warm the schema cache explicitly. Production code does this
  //    via the debounced prefetch listener, which doesn't run in unit
  //    tests; calling ensureSchemaNow directly matches what that listener
  //    eventually triggers, but synchronously enough for the tests to
  //    await via flushAsync(). Note: ensureSchema (the default) is now
  //    debounced 500ms — too slow for tests; use the eager variant.
  for (const className of Object.keys(schemas)) {
    ti.ensureSchemaNow(className);
  }
}

const RISK_PROPS = [
  { accessor: 'id',           label: 'id',           configClass: 'SystemMethodConfig', systemobject: true },
  { accessor: 'name',         label: 'name',         configClass: 'SystemMethodConfig', systemobject: true },
  { accessor: 'code',         label: 'Code',         configClass: 'TextMethodConfig',   systemobject: false },
  { accessor: 'domain_tags',  label: 'Domain Tags',  configClass: 'TagMethodConfig',    systemobject: false },
  { accessor: 'risk_taxonomy', label: 'Risk Taxonomy', configClass: 'TagMethodConfig',  systemobject: false },
];

const ISSUE_PROPS = [
  { accessor: 'id',           label: 'id',           configClass: 'SystemMethodConfig', systemobject: true },
  { accessor: 'name',         label: 'name',         configClass: 'SystemMethodConfig', systemobject: true },
  { accessor: 'code',         label: 'Code',         configClass: 'TextMethodConfig',   systemobject: false },
  { accessor: 'issue_title',  label: 'Title',        configClass: 'TextMethodConfig',   systemobject: false },
];

async function flushAsync() {
  // ensureSchema enqueues a task that awaits sendRequest then sets
  // the schema in module state. Each step is a microtask; mocked
  // sendRequest resolves immediately. Three macrotask ticks drains
  // the queue with margin to spare.
  for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0));
}

describe('starExpansionCompletions — trigger gating', () => {
  it('returns null when the char before cursor is not `*`', async () => {
    seed('_v := SELECT CeRiskAssessment', { CeRiskAssessment: RISK_PROPS });
    await flushAsync();
    const c = ctxAfter('_v.table(');
    expect(starExpansionCompletions(c)).toBeNull();
  });

  it('returns null when `*` is not directly after `(`', async () => {
    seed('_v := SELECT CeRiskAssessment', { CeRiskAssessment: RISK_PROPS });
    await flushAsync();
    const c = ctxAfter('_v.table(name, *');
    expect(starExpansionCompletions(c)).toBeNull();
  });

  it('returns null for unsupported methods like `.forEach(*`', async () => {
    seed('_v := SELECT CeRiskAssessment', { CeRiskAssessment: RISK_PROPS });
    await flushAsync();
    const c = ctxAfter('_v.forEach(*');
    expect(starExpansionCompletions(c)).toBeNull();
  });

  it('returns null when receiver is an unknown variable', async () => {
    seed('', {});
    const c = ctxAfter('_unknown.table(*');
    expect(starExpansionCompletions(c)).toBeNull();
  });
});

describe('starExpansionCompletions — happy path', () => {
  it('expands `_v.table(*` to the receiver type accessors (non-system)', async () => {
    seed('_v := SELECT CeRiskAssessment', { CeRiskAssessment: RISK_PROPS });
    await flushAsync();
    const c = ctxAfter('_v.table(*');
    const result = starExpansionCompletions(c) as CompletionResult;
    expect(result).not.toBeNull();
    expect(result.options).toHaveLength(1);
    const opt = result.options[0];
    // Default expansion EXCLUDES system fields → only code/domain_tags/risk_taxonomy
    expect(opt.apply).toBe('code, domain_tags, risk_taxonomy');
    expect(opt.detail).toContain('3 properties');
    expect(opt.detail).toContain('CeRiskAssessment');
  });

  it('multi-type list → intersection of accessors', async () => {
    seed('_v := SELECT CeRiskAssessment, CeIssue', {
      CeRiskAssessment: RISK_PROPS,
      CeIssue: ISSUE_PROPS,
    });
    await flushAsync();
    const c = ctxAfter('_v.table(*');
    const result = starExpansionCompletions(c) as CompletionResult;
    expect(result).not.toBeNull();
    const opt = result.options[0];
    // Intersection — non-system shared accessors. risk has {code, domain_tags, risk_taxonomy}
    // (non-system); issue has {code, issue_title}. Intersection: {code}.
    expect(opt.apply).toBe('code');
    expect(opt.detail).toContain('CeRiskAssessment ∩ CeIssue');
  });

  it('returns null when schema for the type has not loaded yet', () => {
    // No seed → no schema in cache, no inferences.
    const c = ctxAfter('_v.table(*');
    expect(starExpansionCompletions(c)).toBeNull();
  });

  it('replaces JUST the `*` token (from/to set correctly)', async () => {
    seed('_v := SELECT CeRiskAssessment', { CeRiskAssessment: RISK_PROPS });
    await flushAsync();
    const c = ctxAfter('_v.table(*');
    const result = starExpansionCompletions(c) as CompletionResult;
    // `*` is the last char (position text.length - 1), `from` should
    // point at it and `to` one past.
    const text = '_v.table(*';
    expect(result.from).toBe(text.indexOf('*'));
    expect(result.to).toBe(text.indexOf('*') + 1);
  });
});

describe('starExpansionCompletions — falls back to all when no custom props', () => {
  it('uses all props when every prop is system', async () => {
    const onlySystem = [
      { accessor: 'id',   label: 'id',   configClass: 'SystemMethodConfig', systemobject: true },
      { accessor: 'name', label: 'name', configClass: 'SystemMethodConfig', systemobject: true },
    ];
    seed('_v := SELECT SystemOnlyType', { SystemOnlyType: onlySystem });
    await flushAsync();
    const c = ctxAfter('_v.table(*');
    const result = starExpansionCompletions(c) as CompletionResult;
    expect(result.options[0].apply).toBe('id, name');
  });
});
