// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { objectChip, resetObjectPreview } from '../object-chip';
import { wireBadgeCopy, typeBadge } from '../type-badge';

const sendMessage = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  sendMessage.mockReset();
  sendMessage.mockResolvedValue({
    type: 'HOVER_LOOKUP_RESULT',
    rid: '9007199254740993',
    name: 'Resolved name',
    objectType: 'ExtendedTable',
    businessId: 't.results',
  });
  (globalThis as { chrome?: unknown }).chrome = {
    runtime: { sendMessage },
  };
});

afterEach(() => {
  resetObjectPreview();
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe('objectChip', () => {
  it('keeps the type badge passive and activates the object as one button', () => {
    const activate = vi.fn();
    const chip = objectChip({
      rid: '9007199254740993',
      type: 'ExtendedTable',
      businessId: 't.results',
      name: 'Results',
    }, {
      showId: true,
      onActivate: activate,
    });

    expect(chip.tagName).toBe('BUTTON');
    expect(chip.querySelector('.bdg')?.getAttribute('role')).toBeNull();
    expect(chip.querySelector('.object-chip-label')?.textContent).toBe('Results');
    expect(chip.querySelector('.object-chip-id')?.textContent).toBe('t.results');

    chip.click();
    expect(activate).toHaveBeenCalledOnce();
  });

  it('shows known identity immediately and enriches the shared preview lazily', async () => {
    const chip = objectChip({ rid: '9007199254740993' });
    document.body.appendChild(chip);

    chip.dispatchEvent(new Event('pointerenter'));
    await vi.advanceTimersByTimeAsync(449);
    expect(document.querySelector('.object-preview-host')).toBeNull();
    expect(sendMessage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    const host = document.querySelector('.object-preview-host');
    expect(host?.classList.contains('object-preview-host--visible')).toBe(true);
    expect(host?.textContent).toContain('9007199254740993');
    expect(sendMessage).toHaveBeenCalledWith({
      type: 'HOVER_LOOKUP',
      rid: '9007199254740993',
    });

    await Promise.resolve();
    expect(host?.textContent).toContain('Resolved name');
    expect(host?.textContent).toContain('t.results');
  });
});

describe('wireBadgeCopy', () => {
  it('provides keyboard parity for the legacy copy gesture', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const onCopied = vi.fn();
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const badge = wireBadgeCopy(typeBadge('Container'), () => 't.container', { onCopied });

    expect(badge.getAttribute('role')).toBe('button');
    expect(badge.tabIndex).toBe(0);
    badge.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));

    expect(writeText).toHaveBeenCalledWith('t.container');
    expect(onCopied).toHaveBeenCalledWith('t.container');
  });
});
