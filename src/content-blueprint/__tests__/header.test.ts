/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BlueprintCtx } from '../../lib/layout/sync';
import { bp, resetState } from '../state';
import { renderChip, settingsPanel } from '../view-panels';
import { disableBlueprint } from '../../content-blueprint';
import { resetObjectPreview } from '../../lib/object-chip';

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
  resetObjectPreview();
  resetState();
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe('Blueprint command header', () => {
  it('uses the standard object badge and places settings before the edit target', () => {
    const chip = renderChip(ctx, 0);
    const page = chip.querySelector('.bp-page-chip');
    const settings = chip.querySelector<HTMLButtonElement>('.bp-settings-trigger');
    const target = chip.querySelector('.bp-target');

    expect(page?.querySelector('.bdg')).not.toBeNull();
    expect(page?.classList.contains('object-chip--preview')).toBe(true);
    expect(page?.querySelector('.object-chip-label')?.textContent).toBe('sc_risk_register');
    expect(chip.querySelector('.bp-word')).toBeNull();
    expect(chip.textContent).not.toContain('BLUEPRINT');
    expect(chip.textContent).not.toContain('STYLE');
    expect(settings).not.toBeNull();
    expect(target).not.toBeNull();
    expect(Array.from(chip.children).indexOf(settings!)).toBeLessThan(Array.from(chip.children).indexOf(target!));
    const exit = chip.querySelector<HTMLButtonElement>('.bp-exit');
    const commitActions = chip.querySelector('.bp-commit-actions');
    expect(exit?.getAttribute('aria-label')).toBe('Exit blueprint mode');
    expect(chip.lastElementChild).toBe(commitActions);
    expect(commitActions?.lastElementChild).toBe(exit);
  });

  it('opens settings from the header control', () => {
    const chip = renderChip(ctx, 0);
    const settings = chip.querySelector<HTMLButtonElement>('.bp-settings-trigger');

    settings?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

    expect(bp.settingsOpen).toBe(true);
  });

  it('removes the body-level page preview when Blueprint closes', async () => {
    vi.useFakeTimers();
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: {
        sendMessage: vi.fn().mockResolvedValue({
          type: 'HOVER_LOOKUP_RESULT',
          rid: ctx.pageRid,
          name: ctx.pageId,
          objectType: ctx.pageClass,
          businessId: ctx.pageId,
        }),
      },
    };
    const chip = renderChip(ctx, 0);
    document.body.appendChild(chip);
    const page = chip.querySelector<HTMLElement>('.bp-page-chip')!;
    page.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(0);

    expect(document.querySelector('.object-preview-host')).not.toBeNull();
    bp.active = true;
    bp.layer = document.createElement('div');
    document.body.appendChild(bp.layer);

    disableBlueprint();

    expect(document.querySelector('.object-preview-host')).toBeNull();
  });

  it('keeps live-page peek in the header rather than settings', () => {
    const chip = renderChip(ctx, 0);
    const panel = settingsPanel({ left: 12, top: 60 });
    const peek = chip.querySelector<HTMLButtonElement>('.bp-peek-trigger');

    expect(panel.querySelector('[aria-label="Show live page"]')).toBeNull();
    expect(peek?.getAttribute('aria-pressed')).toBe('false');
    peek?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(bp.peek).toBe(true);
  });

  it('shows portable ID configuration only for the template target', () => {
    bp.ctx = ctx;
    bp.idConfig = { enabled: true, pattern: '{page}_{parent}_{class}_{name}' };
    bp.idConfigStatus = 'ready';

    const templatePanel = settingsPanel({ left: 12, top: 60 });
    const toggle = templatePanel.querySelector<HTMLButtonElement>('.bp-settings-section [role="switch"]');
    const pattern = templatePanel.querySelector<HTMLInputElement>('.bp-id-pattern');

    expect(toggle?.disabled).toBe(false);
    expect(pattern?.value).toBe('{page}_{parent}_{class}_{name}');
    expect(templatePanel.textContent).toContain('Automatic ID Assignment');
    expect(templatePanel.querySelector('.bp-id-example')?.textContent).toContain('_txt_');
    expect(Array.from(templatePanel.querySelectorAll('.bp-id-tags button')).map(button => button.textContent))
      .toContain('{hash4}');

    bp.ctx = { ...ctx, target: 'instance' };
    const instancePanel = settingsPanel({ left: 12, top: 60 });
    const instanceToggle = instancePanel.querySelector<HTMLButtonElement>('.bp-settings-section [role="switch"]');
    expect(instanceToggle?.disabled).toBe(true);
    expect(instancePanel.querySelector('.bp-id-pattern')).toBeNull();
    expect(instancePanel.textContent).toContain('Available while editing Template');
  });
});
