/**
 * Renderer tests for the Context section (enum / boolean / list-ref chips).
 *
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi } from 'vitest';
import { renderContextSection } from '../sections/context-fields';
import type { PaneGroupsCtx } from '../sections/property-groups';

function inputs(overrides: Partial<Parameters<typeof renderContextSection>[0]> = {}) {
  return {
    type: 'ActionButton',
    contextValues: {} as Record<string, string>,
    lists: {} as Record<string, ReturnType<() => ReturnType<typeof renderContextSection>>[]>,
    onNavigate: vi.fn(),
    ...overrides,
  } as Parameters<typeof renderContextSection>[0];
}

describe('renderContextSection', () => {
  it('returns null when type has no contextFields', () => {
    const el = renderContextSection(inputs({ type: 'NotAType' }));
    expect(el).toBeNull();
  });

  it('returns null when type has contextFields but no values populated', () => {
    const el = renderContextSection(inputs({ type: 'ActionButton' }));
    expect(el).toBeNull();
  });

  it('renders enum chip with the prefix stripped (ActionType.action → ACTION)', () => {
    const el = renderContextSection(inputs({
      contextValues: { actionType: 'ActionType.action' },
    }));
    const chip = el!.querySelector('.ctx-chip--enum');
    expect(chip).toBeTruthy();
    expect(chip!.querySelector('.ctx-chip-val')!.textContent).toBe('ACTION');
    // Tooltip preserves the raw value so the user can see exactly what BMP returned
    expect(chip!.getAttribute('title')).toContain('ActionType.action');
  });

  it('renders boolean chips as on / off', () => {
    const el = renderContextSection(inputs({
      type: 'ButtonInput',
      contextValues: { useShowExpression: 'true', useEnableExpression: 'false' },
    }));
    const on = el!.querySelector('.ctx-chip--on');
    const off = el!.querySelector('.ctx-chip--off');
    expect(on).toBeTruthy();
    expect(off).toBeTruthy();
    expect(on!.querySelector('.ctx-chip-val')!.textContent).toBe('on');
    expect(off!.querySelector('.ctx-chip-val')!.textContent).toBe('off');
  });

  it('renders a list-ref group with clickable rows that call onNavigate', () => {
    const onNavigate = vi.fn();
    const el = renderContextSection(inputs({
      lists: { addableItems: [
        { rid: '999', businessId: 't.thing', name: 'Thing', type: 'Template' },
      ] },
      onNavigate,
    }));
    const row = el!.querySelector<HTMLElement>('.ctx-list-row');
    expect(row).toBeTruthy();
    row!.click();
    expect(onNavigate).toHaveBeenCalledWith('999');
  });

  it('renders the chip strip and list rows when both are present', () => {
    // Replaces the old "section title surfaces value + list summary" — the
    // header was dropped in the UX pass (the chip strip + tinted band carry
    // the affordance on their own). The data still needs to render; only
    // the title text disappeared.
    const el = renderContextSection(inputs({
      contextValues: { actionType: 'ActionType.action' },
      lists: { addableItems: [{ rid: '999', businessId: 't.thing', name: 'Thing', type: 'Template' }] },
    }));
    expect(el!.classList.contains('context-section')).toBe(true);
    // No prop-group-title wrapper anymore
    expect(el!.querySelector('.prop-group-title')).toBeNull();
    // Chip strip + list rows both render
    expect(el!.querySelector('.ctx-chips')).toBeTruthy();
    expect(el!.querySelectorAll('.ctx-list-row').length).toBe(1);
  });

  it('renders Label context properties as writable controls when given an editor', () => {
    const drafts: Record<string, string> = {};
    const values: Record<string, string> = {
      textInputType: 'TextType.rich',
      advancedDefault: 'false',
    };
    const editor: PaneGroupsCtx = {
      objectType: 'Label',
      isAvailable: () => true,
      displayValue: prop => drafts[prop] ?? values[prop] ?? '',
      serverValue: prop => values[prop] ?? '',
      isDirty: prop => drafts[prop] != null,
      setDraft: (prop, value) => { drafts[prop] = value; },
      openColorPicker: vi.fn(),
    };
    const el = renderContextSection(inputs({ type: 'Label', contextValues: values, editor }));

    const select = el!.querySelector<HTMLSelectElement>('select');
    const toggle = el!.querySelector<HTMLButtonElement>('[role="switch"]');
    expect(select?.value).toBe('RICH');
    expect(toggle?.getAttribute('aria-checked')).toBe('false');
    toggle!.click();
    expect(drafts.advancedDefault).toBe('true');
    expect(el!.querySelector('.ctx-chips')).toBeNull();
  });
});
