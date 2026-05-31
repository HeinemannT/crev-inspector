/**
 * "Highlight a tracked variable in the editor on demand" extension.
 *
 * The Vars panel calls `setHighlightedVar(view, name)` on mouse-enter
 * and `setHighlightedVar(view, null)` on mouse-leave. The StateField
 * holds the active name and recomputes mark decorations for every
 * whole-word occurrence in the document. Decorations are styled by
 * `.cm-var-highlight` in editor.css.
 *
 * Kept separate from `variableTracker` (which scans `:=` left-hand
 * sides for the Vars panel) so each module has one job.
 */
import { Decoration, EditorView } from '@codemirror/view';
import type { DecorationSet } from '@codemirror/view';
import { StateField, StateEffect, RangeSetBuilder } from '@codemirror/state';
import type { EditorState } from '@codemirror/state';

const setHighlight = StateEffect.define<string | null>();

const highlightMark = Decoration.mark({ class: 'cm-var-highlight' });

function buildDecorations(state: EditorState, name: string): DecorationSet {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\b${escaped}\\b`, 'g');
  const doc = state.doc.toString();
  const builder = new RangeSetBuilder<Decoration>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(doc)) !== null) {
    builder.add(m.index, m.index + m[0].length, highlightMark);
  }
  return builder.finish();
}

const highlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    let next: string | null | undefined;
    for (const e of tr.effects) {
      if (e.is(setHighlight)) next = e.value;
    }
    if (next === undefined) return deco.map(tr.changes);
    if (!next) return Decoration.none;
    return buildDecorations(tr.state, next);
  },
  provide: (f) => EditorView.decorations.from(f),
});

export const varHighlight = [highlightField];

export function setHighlightedVar(view: EditorView, name: string | null): void {
  view.dispatch({ effects: setHighlight.of(name) });
}
