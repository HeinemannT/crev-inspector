/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it, vi } from 'vitest';
import { numberEditor } from '../property-editors';
import {
  renderPropertyElement,
  renderPropertyGroups,
  type PaneGroupsCtx,
} from '../sections/property-groups';
import { findPropDef } from '../pane-schema';

function makeContext(activeProp: string | null, request = vi.fn()): PaneGroupsCtx {
  const values: Record<string, string> = {
    columnsLargeScreen: '6',
    columnsMediumScreen: '6',
    columnsSmallScreen: '6',
    showToolMenu: 'true',
    disableSearch: 'false',
    shadow: 'false',
    headerStyle: 'NONE',
    borderStyle: 'NONE',
    transparency: '0',
    visible: 'true',
    shownOnLargeDisplay: 'true',
    shownOnMediumDisplay: 'true',
    shownOnSmallDisplay: 'true',
  };
  return {
    objectType: 'CustomVisualization',
    isAvailable: () => true,
    displayValue: prop => values[prop] ?? '',
    serverValue: prop => values[prop] ?? '',
    isDirty: () => false,
    setDraft: vi.fn(),
    openColorPicker: vi.fn(),
    editOnDemand: { activeProp, request },
  };
}

function rowFor(root: HTMLElement, label: string): HTMLElement {
  const row = [...root.querySelectorAll<HTMLElement>('.prop-row')]
    .find(candidate => candidate.querySelector('.prop-label')?.textContent === label);
  expect(row, `row "${label}" should render`).toBeTruthy();
  return row!;
}

describe('expanded-view on-demand property editing', () => {
  it('renders quiet values and requests the native editor on click', () => {
    const request = vi.fn();
    const groups = renderPropertyGroups(makeContext(null, request));
    const row = rowFor(groups, 'Tool menu');

    expect(row.querySelector('.prop-cell--ondemand')?.textContent).toBe('On');
    expect(row.querySelector('[role="switch"]')).toBeNull();

    row.querySelector<HTMLButtonElement>('.prop-cell--ondemand')!.click();
    expect(request).toHaveBeenCalledWith('showToolMenu');
  });

  it('reveals and marks the active native editor', () => {
    const groups = renderPropertyGroups(makeContext('showToolMenu'));
    const row = rowFor(groups, 'Tool menu');
    const editor = row.querySelector<HTMLElement>('[data-editing-prop="showToolMenu"]');

    expect(editor).toBeTruthy();
    expect(editor?.querySelector('[role="switch"]')).toBeTruthy();
    expect(row.querySelector('.prop-cell--ondemand')).toBeNull();
  });

  it('labels groups so the expanded view can build a scroll outline', () => {
    const groups = renderPropertyGroups(makeContext(null));
    const labels = [...groups.querySelectorAll<HTMLElement>(':scope > [data-section-label]')]
      .map(group => group.dataset.sectionLabel);

    expect(labels).toContain('Display');
    expect(labels).toContain('Visibility');
  });

  it('uses direct width steps for responsive columns without a dropdown', () => {
    const ctx = makeContext(null);
    const groups = renderPropertyGroups(ctx);
    const choices = groups.querySelectorAll<HTMLButtonElement>(
      '[data-property-prop="columnsLargeScreen"] .prop-column-step',
    );

    expect(choices).toHaveLength(7);
    expect(groups.querySelector('input[type="number"][aria-label="Large"]')).toBeNull();
    expect(groups.querySelector('[role="listbox"]')).toBeNull();
    choices[3].click();
    expect(ctx.setDraft).toHaveBeenCalledWith('columnsLargeScreen', '3');
  });

  it('shows only the reset arrow when a property has an instance override', () => {
    const ctx = makeContext(null);
    const toggleReset = vi.fn();
    ctx.cascade = {
      get: prop => ({
        overridden: prop === 'disableSearch',
        resetStaged: false,
      }),
      toggleReset,
    };
    const groups = renderPropertyGroups(ctx);
    const disableRow = rowFor(groups, 'Disable search');

    expect(disableRow.querySelector('.prop-source-reset')).toBeTruthy();
    expect(disableRow.querySelector('.prop-cascade-toggle')).toBeNull();
    expect(disableRow.querySelector('.prop-cascade')).toBeNull();
    disableRow.querySelector<HTMLButtonElement>('.prop-source-reset')!.click();
    expect(toggleReset).toHaveBeenCalledWith('disableSearch');
  });

  it('renders Show on as three direct breakpoint buttons without On/Off text', () => {
    const ctx = makeContext(null);
    const groups = renderPropertyGroups(ctx);
    const buttons = groups.querySelectorAll<HTMLButtonElement>('.prop-vis-breakpoint');

    expect(buttons).toHaveLength(3);
    expect([...buttons].map(button => button.textContent)).toEqual(['L', 'M', 'S']);
    buttons[1].click();
    expect(ctx.setDraft).toHaveBeenCalledWith('shownOnMediumDisplay', 'false');
  });

  it.each([
    'disableSearch',
    'columnsLargeScreen',
    'shownOnLargeDisplay',
  ])('uses the same property root for full and targeted rendering: %s', (prop) => {
    const ctx = makeContext(null);
    const def = findPropDef(prop);
    expect(def).toBeTruthy();

    const full = renderPropertyGroups(ctx)
      .querySelector<HTMLElement>(`[data-property-prop="${prop}"]`)!;
    const targeted = renderPropertyElement(ctx, def!);

    expect(targeted.dataset.propertyProp).toBe(prop);
    expect(targeted.className).toBe(full.className);
    expect(targeted.textContent).toBe(full.textContent);
    expect(targeted.querySelectorAll(`[data-property-prop="${prop}"]`)).toHaveLength(0);
  });
});

describe('number editor commit timing', () => {
  it('does not replace its host while a number is still being typed', () => {
    const onChange = vi.fn();
    const editor = numberEditor({ value: '6', original: '6', dirty: false, onChange });
    const input = editor.querySelector<HTMLInputElement>('input')!;

    input.value = '12';
    input.dispatchEvent(new Event('input'));
    expect(onChange).not.toHaveBeenCalled();

    input.dispatchEvent(new Event('change'));
    expect(onChange).toHaveBeenCalledWith('12');
  });
});
