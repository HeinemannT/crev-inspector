/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { captureTypingFocus, FOCUS_INTENT_MS } from '../focus-keep';

function input(value = 'hello'): HTMLInputElement {
  const el = document.createElement('input');
  el.value = value;
  document.body.appendChild(el);
  return el;
}

afterEach(() => { document.body.innerHTML = ''; vi.useRealTimers(); });

describe('captureTypingFocus', () => {
  it('restores focus + caret when the input was focused and recently typed', () => {
    const el = input();
    el.focus(); el.setSelectionRange(2, 2);
    const restore = captureTypingFocus({ el, at: Date.now() });
    el.blur(); // simulate the render dropping focus
    restore();
    expect(document.activeElement).toBe(el);
    expect(el.selectionStart).toBe(2);
  });

  it('restores even when focus has fallen to <body> (streamed-blur case)', () => {
    const el = input();
    el.focus(); el.setSelectionRange(3, 3);
    el.blur(); // focus already on body BEFORE capture
    expect(document.activeElement).toBe(document.body);
    const restore = captureTypingFocus({ el, at: Date.now() });
    restore();
    expect(document.activeElement).toBe(el);
    expect(el.selectionStart).toBe(3); // caret read from the persistent node
  });

  it('does NOT restore when focus is on another control (deliberate move)', () => {
    const el = input();
    const btn = document.createElement('button'); document.body.appendChild(btn);
    el.focus();
    el.setSelectionRange(1, 1);
    btn.focus(); // user moved focus to a button
    const restore = captureTypingFocus({ el, at: Date.now() });
    restore();
    expect(document.activeElement).toBe(btn); // not stolen back to the input
  });

  it('does NOT restore after the intent window elapses', () => {
    vi.useFakeTimers();
    const el = input();
    el.focus();
    const restore = captureTypingFocus({ el, at: Date.now() - FOCUS_INTENT_MS - 1 });
    el.blur();
    restore();
    expect(document.activeElement).toBe(document.body);
  });

  it('does NOT restore when the input is no longer attached after render', () => {
    const el = input();
    el.focus();
    const restore = captureTypingFocus({ el, at: Date.now() }, () => false);
    el.blur();
    restore();
    expect(document.activeElement).toBe(document.body);
  });

  it('is a no-op when there is no tracked input', () => {
    const restore = captureTypingFocus({ el: null, at: Date.now() });
    expect(() => restore()).not.toThrow();
  });
});
