/**
 * Renderer tests for the References section.
 *
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi } from 'vitest';
import { renderReferenceSection } from '../sections/reference-edges';

function inputs(overrides: Partial<Parameters<typeof renderReferenceSection>[0]> = {}) {
  return {
    type: 'InputView',
    references: {} as Record<string, { rid: string; businessId: string; type: string; name: string } | null>,
    onNavigate: vi.fn(),
    ...overrides,
  } as Parameters<typeof renderReferenceSection>[0];
}

describe('renderReferenceSection', () => {
  it('returns null for a type with no references in TYPE_META', () => {
    const el = renderReferenceSection(inputs({ type: 'TextElement' }));
    expect(el).toBeNull();
  });

  it('renders a set reference as a clickable row', () => {
    const onNavigate = vi.fn();
    const el = renderReferenceSection(inputs({
      references: {
        inputSet: { rid: '111', businessId: 'is_demo', type: 'InputSet', name: 'Demo IS' },
      },
      onNavigate,
    }));
    const row = el!.querySelector<HTMLElement>('.ref-row');
    expect(row).toBeTruthy();
    expect(row!.classList.contains('ref-row--empty')).toBe(false);
    expect(row!.textContent).toContain('Demo IS');
    expect(row!.textContent).toContain('is_demo');
    row!.click();
    expect(onNavigate).toHaveBeenCalledWith('111');
  });

  it('renders an unset reference as (none) with no click handler', () => {
    const onNavigate = vi.fn();
    const el = renderReferenceSection(inputs({
      references: { inputSet: null },
      onNavigate,
    }));
    const empty = el!.querySelector<HTMLElement>('.ref-row--empty');
    expect(empty).toBeTruthy();
    expect(empty!.textContent).toContain('(none)');
    // Clicking an empty row should NOT trigger navigation
    empty!.click();
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('section title surfaces set/total count', () => {
    const el = renderReferenceSection(inputs({
      type: 'CreateObjectView', // has editPage / destination / defaultObject
      references: {
        editPage: { rid: '1', businessId: 'ep', type: 'EditPage', name: 'EP' },
        destination: null,
        defaultObject: null,
      },
    }));
    const title = el!.querySelector('.prop-group-title')!;
    expect(title.textContent).toContain('References');
    expect(title.textContent).toContain('1/3 set');
  });
});
