/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it } from 'vitest';
import type { BlueprintCtx } from '../../lib/layout/sync';
import { bp, resetState } from '../state';
import { renderChip, settingsPanel } from '../view-panels';

const ctx: BlueprintCtx = {
  pageId: 'sc_risk_register',
  pageRid: '98357',
  pageClass: 'ModelPage',
  tabsetId: 'risk_tabs',
  target: 'template',
  hasTemplate: true,
  templateId: 'risk_template',
  instanceId: 'sc_risk_register',
};

afterEach(() => {
  resetState();
  document.body.replaceChildren();
});

describe('Blueprint command header', () => {
  it('uses the standard object badge and places settings before the edit target', () => {
    const chip = renderChip(ctx, 0);
    const page = chip.querySelector('.bp-page-chip');
    const settings = chip.querySelector<HTMLButtonElement>('.bp-settings-trigger');
    const target = chip.querySelector('.bp-target');

    expect(page?.querySelector('.bdg')).not.toBeNull();
    expect(page?.querySelector('.object-chip-label')?.textContent).toBe('sc_risk_register');
    expect(chip.querySelector('.bp-word')).toBeNull();
    expect(chip.textContent).not.toContain('BLUEPRINT');
    expect(chip.textContent).not.toContain('STYLE');
    expect(settings).not.toBeNull();
    expect(target).not.toBeNull();
    expect(Array.from(chip.children).indexOf(settings!)).toBeLessThan(Array.from(chip.children).indexOf(target!));
  });

  it('opens settings from the header control', () => {
    const chip = renderChip(ctx, 0);
    const settings = chip.querySelector<HTMLButtonElement>('.bp-settings-trigger');

    settings?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

    expect(bp.settingsOpen).toBe(true);
  });

  it('keeps the live-page peek as a real setting', () => {
    const panel = settingsPanel({ left: 12, top: 60 });
    const row = panel.querySelector<HTMLButtonElement>('.bp-settings-row');

    expect(row?.getAttribute('role')).toBe('switch');
    expect(row?.getAttribute('aria-checked')).toBe('false');
    row?.click();
    expect(bp.peek).toBe(true);
  });
});
