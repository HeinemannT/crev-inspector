// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContentState } from '../content-state';
import {
  OBJECT_CARD_INITIAL_DELAY,
  scheduleTooltipForElement,
  showTooltipForElement,
  wireObjectPopover,
} from '../content-tooltip';

vi.mock('../lib/messaging', () => ({
  sendRequest: vi.fn(),
  sendFireForget: vi.fn(),
}));

function mountLabel(rid: string): { label: HTMLElement; trigger: HTMLElement } {
  const label = document.createElement('span');
  label.className = 'crev-label';
  label.dataset.crevLabel = rid;
  const trigger = document.createElement('span');
  trigger.className = 'crev-stub';
  trigger.tabIndex = 0;
  label.appendChild(trigger);
  document.body.appendChild(label);
  return { label, trigger };
}

describe('rich object popover', () => {
  let state: ContentState;
  let tooltip: HTMLElement;

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
    document.querySelector('#crev-tooltip')?.remove();
    state = new ContentState();
    state.enrichments.set('123', {
      name: 'Risk register',
      type: 'ExtendedTable',
      businessId: 'sc_risk_register',
    });
    tooltip = document.createElement('div');
    tooltip.id = 'crev-tooltip';
    document.documentElement.appendChild(tooltip);
    wireObjectPopover(state, tooltip);
  });

  afterEach(() => {
    state.resetAll();
    tooltip.remove();
    vi.useRealTimers();
  });

  it('opens from keyboard focus with dialog semantics', () => {
    const { trigger } = mountLabel('123');

    trigger.focus();

    expect(tooltip.classList.contains('crev-visible')).toBe(true);
    expect(tooltip.getAttribute('role')).toBe('dialog');
    expect(tooltip.getAttribute('aria-label')).toBe('Object details');
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
  });

  it('moves from the trigger into the popover and Escape returns focus', () => {
    const { label, trigger } = mountLabel('123');
    showTooltipForElement(state, label, '123');

    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    expect(tooltip.contains(document.activeElement)).toBe(true);

    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    }));

    expect(tooltip.classList.contains('crev-visible')).toBe(false);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);
  });

  it('ignores pointer fly-over until the intent delay completes', async () => {
    const { label } = mountLabel('123');
    state.hoveredLabelEl = label;

    scheduleTooltipForElement(state, label, '123');
    await vi.advanceTimersByTimeAsync(OBJECT_CARD_INITIAL_DELAY - 1);
    expect(tooltip.classList.contains('crev-visible')).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(tooltip.classList.contains('crev-visible')).toBe(true);
  });
});
