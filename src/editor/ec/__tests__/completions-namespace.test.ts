/**
 * extendedCompletions: object-method completions must be SUPPRESSED after a
 * namespace prefix (t. / r. / o. / GRC spaces like cetas.). `t.master` is a
 * business-id reference, not an object — offering .add / .ancestor / .children
 * there is noise. A real object/variable receiver (or a method chain) still
 * gets the method list.
 *
 * @vitest-environment happy-dom
 */
import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { CompletionContext } from '@codemirror/autocomplete';
import { extendedCompletions } from '../completions';

/** Run the source with the cursor at end of `doc` (which must end in `.`). */
function completeAfterDot(doc: string) {
  const state = EditorState.create({ doc });
  const ctx = new CompletionContext(state, doc.length, false);
  return extendedCompletions(ctx);
}

describe('extendedCompletions — namespace prefix suppression', () => {
  it('suppresses methods after `t.` (template namespace)', () => {
    expect(completeAfterDot('t.')).toBeNull();
  });

  it('suppresses methods after `r.` and `o.`', () => {
    expect(completeAfterDot('r.')).toBeNull();
    expect(completeAfterDot('o.')).toBeNull();
  });

  it('suppresses methods after a GRC id space (cetas.)', () => {
    expect(completeAfterDot('cetas.')).toBeNull();
  });

  it('suppresses when the prefix follows an operator/paren', () => {
    expect(completeAfterDot('_x := t.')).toBeNull();
    expect(completeAfterDot('SELECT X WHERE a = t.')).toBeNull();
  });

  it('STILL offers methods for a real variable receiver', () => {
    const r = completeAfterDot('_risks.');
    expect(r).not.toBeNull();
    expect(r!.options.some(o => o.label === 'filter')).toBe(true);
  });

  it('STILL offers methods inside a method chain (obj.t.)', () => {
    // `t` here is a member of obj's result, not the template namespace.
    const r = completeAfterDot('obj.t.');
    expect(r).not.toBeNull();
    expect(r!.options.some(o => o.label === 'ancestor')).toBe(true);
  });

  it('does not treat an underscore-var whose tail matches a prefix as a namespace', () => {
    // `_t.` — receiver is `_t`, not the bare prefix `t`.
    const r = completeAfterDot('_t.');
    expect(r).not.toBeNull();
    expect(r!.options.length).toBeGreaterThan(0);
  });
});
