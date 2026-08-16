/** @vitest-environment happy-dom */
import { describe, expect, it } from 'vitest';
import { moveCaretToEnd } from '../dom-selection';

describe('moveCaretToEnd', () => {
  it('returns false instead of creating a range for a field detached during focus', () => {
    const field = document.createElement('span');
    document.body.appendChild(field);
    field.focus = () => field.remove();
    field.focus();
    expect(() => moveCaretToEnd(field)).not.toThrow();
    expect(moveCaretToEnd(field)).toBe(false);
  });
});
