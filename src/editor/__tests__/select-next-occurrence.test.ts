/**
 * Tests for selectNextOccurrence (Ctrl+D). Pins the fix for "found the
 * occurrence but didn't jump to it": the dispatch MUST request scrollIntoView,
 * otherwise an off-screen match (a later line, or further along one long line)
 * gets a cursor the viewport never follows.
 */
import { describe, it, expect, vi } from 'vitest';
import { EditorState, EditorSelection } from '@codemirror/state';
import { selectNextOccurrence } from '../ec/renameVariable';

function fakeView(doc: string, selection: EditorSelection) {
  const state = EditorState.create({ doc, selection });
  const dispatch = vi.fn();
  return { view: { state, dispatch } as any, dispatch };
}

describe('selectNextOccurrence', () => {
  it('empty selection selects the word at the cursor and scrolls to it', () => {
    const doc = 'alpha beta gamma';
    const { view, dispatch } = fakeView(doc, EditorSelection.single(7)); // inside "beta"
    expect(selectNextOccurrence(view)).toBe(true);
    const spec = dispatch.mock.calls[0][0];
    expect(spec.scrollIntoView).toBe(true);
    expect(spec.selection.main.from).toBe(doc.indexOf('beta'));
    expect(spec.selection.main.to).toBe(doc.indexOf('beta') + 4);
  });

  it('adds the next occurrence as the primary range AND scrolls into view', () => {
    const doc = 'needle aaa\nbbb needle ccc\nddd needle';
    const first = doc.indexOf('needle');
    const { view, dispatch } = fakeView(doc, EditorSelection.single(first, first + 6));
    expect(selectNextOccurrence(view)).toBe(true);

    const spec = dispatch.mock.calls[0][0];
    // The bug was the missing scrollIntoView — assert it explicitly.
    expect(spec.scrollIntoView).toBe(true);
    // Primary range is the SECOND occurrence; the first stays selected.
    const second = doc.indexOf('needle', first + 6);
    expect(spec.selection.main.from).toBe(second);
    expect(spec.selection.ranges).toHaveLength(2);
  });

  it('wraps to the first unselected occurrence when none follow the cursor', () => {
    const doc = 'x needle y needle z';
    const last = doc.lastIndexOf('needle');
    const { view, dispatch } = fakeView(doc, EditorSelection.single(last, last + 6));
    expect(selectNextOccurrence(view)).toBe(true);
    const spec = dispatch.mock.calls[0][0];
    expect(spec.scrollIntoView).toBe(true);
    expect(spec.selection.main.from).toBe(doc.indexOf('needle'));
  });
});
