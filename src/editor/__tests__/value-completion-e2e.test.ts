/**
 * @vitest-environment happy-dom
 *
 * End-to-end check of the LIST/TAG VALUE autocomplete — the full chain, not
 * just the parsers: given `_risk := SELECT ceRiskAssessment WHERE subtype = |`,
 * the source must infer the SELECT class, look up `subtype`'s option set, and
 * offer its ListPropertySet items as `t.<businessId>` (t.master / t.instance).
 *
 * Options are seeded exactly as the SW's FETCH_TYPE_OPTIONS handler returns
 * them, so this exercises resolveValueContext → findWhereClass → pascal() →
 * getOption → buildValueResult together.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { CompletionContext } from '@codemirror/autocomplete';
import { valueCompletions } from '../ec/propertyCompletions';
import * as ti from '../ec/typeInference';
import type { TypeOptionSet } from '../../lib/types';

const OPTIONS: TypeOptionSet[] = [
  { accessor: 'subtype', multi: false, items: [
    { ref: 't.master', name: 'Master' },
    { ref: 't.instance', name: 'Instance' },
  ] },
  { accessor: 'domain_tags', multi: true, items: [
    { ref: 't.tag_dom_sox', name: 'SOX' },
    { ref: 't.tag_dom_esg', name: 'ESG' },
  ] },
];

async function flushAsync() {
  for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0));
}

beforeEach(() => {
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: { sendMessage: vi.fn(() => Promise.resolve({ ok: false })) },
  };
  ti._resetForTests();
});

/** Seed typeInference's option cache for a class as the SW would. */
async function seedOptions(className: string, options: TypeOptionSet[]) {
  (globalThis as unknown as { chrome: { runtime: { sendMessage: ReturnType<typeof vi.fn> } } }).chrome.runtime.sendMessage =
    vi.fn((msg) => {
      const m = msg as { type: string; className?: string };
      if (m.type === 'FETCH_TYPE_OPTIONS' && m.className) {
        return Promise.resolve({ type: 'FETCH_TYPE_OPTIONS_RESULT', className: m.className, ok: true, options });
      }
      return Promise.resolve({ ok: false });
    });
  ti.ensureOptionsNow(className);
  await flushAsync();
}

/** Run valueCompletions with the cursor at the end of `doc`. */
async function valuesAt(doc: string) {
  const state = EditorState.create({ doc });
  const res = await valueCompletions(new CompletionContext(state, doc.length, false));
  return res ? res.options.map(o => o.label) : null;
}

describe('list/tag value autocomplete — end to end', () => {
  it('infers subtype’s ListPropertySet items after WHERE subtype = (camelCase class)', async () => {
    await seedOptions('CeRiskAssessment', OPTIONS);
    expect(await valuesAt('_risk := SELECT ceRiskAssessment WHERE subtype = '))
      .toEqual(['t.master', 't.instance']);
  });

  it('works without the trailing space (cursor right after =)', async () => {
    await seedOptions('CeRiskAssessment', OPTIONS);
    expect(await valuesAt('_risk := SELECT ceRiskAssessment WHERE subtype ='))
      .toEqual(['t.master', 't.instance']);
  });

  it('offers tag items after CONTAINS', async () => {
    await seedOptions('CeRiskAssessment', OPTIONS);
    expect(await valuesAt('SELECT CeRiskAssessment WHERE domain_tags CONTAINS '))
      .toEqual(['t.tag_dom_sox', 't.tag_dom_esg']);
  });

  it('filters live against a half-typed t.<id>', async () => {
    await seedOptions('CeRiskAssessment', OPTIONS);
    // valueCompletions returns the full set from the value-token start; CM then
    // filters by what's typed. We assert the set + that `from` covers `t.ma`.
    const state = EditorState.create({ doc: 'SELECT CeRiskAssessment WHERE subtype = t.ma' });
    const res = await valueCompletions(new CompletionContext(state, state.doc.length, false));
    expect(res).not.toBeNull();
    expect(res!.options.map(o => o.label)).toContain('t.master');
    expect(state.doc.sliceString(res!.from)).toBe('t.ma');
  });

  it('declines for a non-list/tag property (no spurious values)', async () => {
    await seedOptions('CeRiskAssessment', OPTIONS);
    expect(await valuesAt('SELECT CeRiskAssessment WHERE code = ')).toBeNull();
  });

  it('also works inside a .filter() predicate via receiver inference', async () => {
    await seedOptions('CeRiskAssessment', OPTIONS);
    ti.scanDocForInferences({
      lines: 1, line: () => ({ text: '_l := SELECT ceRiskAssessment' }),
    });
    expect(await valuesAt('_l.filter(subtype = ')).toEqual(['t.master', 't.instance']);
  });
});
