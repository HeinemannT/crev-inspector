/**
 * Renderer tests for the Code section. Verifies:
 *  - Section returns null when no fields populated
 *  - Each direct codeField in TYPE_META renders when content is provided
 *  - enabledBy gating marks rows with code-row--disabled and the gate hint
 *  - Indirect fields render the "via prop → targetProp" subtitle
 *  - Edit button click dispatches OPEN_EDITOR with rid + property
 *  - No "Code (N fields)" title bar — section renders rows directly
 *
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi } from 'vitest';
import { renderCodeSection } from '../sections/code-fields';
import type { InspectorMessage } from '../../lib/types';

function inputs(overrides: Partial<Parameters<typeof renderCodeSection>[0]> = {}) {
  return {
    type: 'ButtonInput',
    rid: '12345',
    codeFields: {} as Record<string, string>,
    indirectCode: {} as Record<string, string>,
    gateValues: {} as Record<string, string>,
    sendMessage: vi.fn(),
    ...overrides,
  };
}

describe('renderCodeSection', () => {
  it('returns null when no fields populated', () => {
    const el = renderCodeSection(inputs());
    expect(el).toBeNull();
  });

  it('renders direct code fields with line count + first-line preview', () => {
    const el = renderCodeSection(inputs({
      codeFields: { expression: 'root.foo()\n_x := 1\n_x' },
    }));
    expect(el).not.toBeNull();
    const row = el!.querySelector('.code-row');
    expect(row).toBeTruthy();
    expect(row!.querySelector('.code-row-prop')!.textContent).toBe('expression');
    expect(row!.querySelector('.code-row-meta')!.textContent).toBe('3 lines');
    // First non-empty line surfaces in the preview
    expect(row!.querySelector('.code-row-preview')!.textContent).toContain('root.foo()');
  });

  it('greys out a gated field when its enabledBy is false', () => {
    const el = renderCodeSection(inputs({
      codeFields: { showExpression: 'this.org.isAdmin' },
      gateValues: { useShowExpression: 'false' },
    }));
    const row = el!.querySelector('.code-row--disabled');
    expect(row).toBeTruthy();
    const gate = row!.querySelector('.code-row-gate');
    expect(gate!.textContent).toContain('Off');
    expect(gate!.textContent).toContain('useShowExpression');
  });

  it('does NOT grey out a gated field when its enabledBy is true', () => {
    const el = renderCodeSection(inputs({
      codeFields: { showExpression: 'this.org.isAdmin' },
      gateValues: { useShowExpression: 'true' },
    }));
    const row = el!.querySelector('.code-row');
    expect(row!.classList.contains('code-row--disabled')).toBe(false);
    expect(row!.querySelector('.code-row-gate')).toBeNull();
  });

  it('renders indirect fields with the via-prop subtitle', () => {
    const el = renderCodeSection(inputs({
      type: 'ActionButton',
      indirectCode: { showExpression_expression: 'this.org.isAdmin' },
    }));
    const subtitle = el!.querySelector('.code-row-subtitle');
    expect(subtitle).toBeTruthy();
    expect(subtitle!.textContent).toContain('via showExpression');
    expect(subtitle!.textContent).toContain('expression');
  });

  it('Edit on an indirect field redirects to the resolved target rid + prop', () => {
    // Same bug as the flow-walker test: AB.showExpression is a Reference. Edit
    // must hit the ExtendedExpression's .expression, not the AB's
    // .showExpression (which would silently fall back to .expression on the AB).
    const send = vi.fn();
    const el = renderCodeSection(inputs({
      type: 'ActionButton',
      indirectCode: { showExpression_expression: 'this.org.isAdmin' },
      indirectCodeRids: { showExpression_expression: '8123' },
      sendMessage: send,
    }));
    const btn = el!.querySelector<HTMLButtonElement>('.code-row-edit');
    btn!.click();
    const open = send.mock.calls.map(c => c[0]).find(m => m.type === 'OPEN_EDITOR');
    expect(open).toEqual({ type: 'OPEN_EDITOR', rid: '8123', property: 'expression' });
  });

  it('Edit on an indirect field with no target rid falls back to source (legacy / unset)', () => {
    const send = vi.fn();
    const el = renderCodeSection(inputs({
      type: 'ActionButton',
      indirectCode: { showExpression_expression: 'x' },
      sendMessage: send,
    }));
    const btn = el!.querySelector<HTMLButtonElement>('.code-row-edit');
    btn!.click();
    const open = send.mock.calls.map(c => c[0]).find(m => m.type === 'OPEN_EDITOR');
    // Without indirectCodeRids the renderer can't redirect — falls back to
    // the input rid + source prop. Better than crashing; matches old behavior.
    expect(open).toEqual({ type: 'OPEN_EDITOR', rid: '12345', property: 'showExpression' });
  });

  it('Edit button dispatches OPEN_EDITOR with rid + property', () => {
    const send = vi.fn();
    const el = renderCodeSection(inputs({
      codeFields: { expression: 'root.foo()' },
      sendMessage: send,
    }));
    const btn = el!.querySelector<HTMLButtonElement>('.code-row-edit');
    expect(btn).toBeTruthy();
    btn!.click();
    const calls = send.mock.calls.map(c => c[0] as InspectorMessage);
    const open = calls.find(m => m.type === 'OPEN_EDITOR') as { rid: string; property: string } | undefined;
    expect(open).toBeDefined();
    expect(open!.rid).toBe('12345');
    expect(open!.property).toBe('expression');
  });

  it('does NOT render a "Code (N fields)" title — rows speak for themselves', () => {
    const el = renderCodeSection(inputs({
      codeFields: {
        expression: 'root.foo()',
        showExpression: 'this.org.isAdmin',
      },
      gateValues: { useShowExpression: 'false' },
    }));
    // Title bar removed: the labels on each row already identify the
    // property, so the count was redundant decoration.
    expect(el!.querySelector('.prop-group-title')).toBeNull();
    // Section still groups all rows for layout / styling.
    expect(el!.classList.contains('code-section')).toBe(true);
    expect(el!.querySelectorAll('.code-row').length).toBe(2);
  });

  it('returns null for a type that has no codeFields in TYPE_META', () => {
    const el = renderCodeSection(inputs({ type: 'InputView' }));
    expect(el).toBeNull();
  });
});
