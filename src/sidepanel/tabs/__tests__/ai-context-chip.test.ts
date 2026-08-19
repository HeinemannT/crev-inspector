/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/messaging', () => ({ sendFireForget: vi.fn(), sendRequest: vi.fn() }));

import { AiTab } from '../ai-tab';
import { S } from '../../state';

describe('AI context chip', () => {
  afterEach(() => { S.context = null; S.page = null; document.body.textContent = ''; });

  it('shows the object identity without the redundant Selection label', () => {
    S.context = {
      rid: '726548820039520945',
      businessId: 'bmw_sharepoint_sc',
      name: 'Sharepoint Integration',
      type: 'Scorecard',
    };
    const container = document.createElement('div');
    document.body.appendChild(container);
    new AiTab(() => {}).render(container);

    expect(container.querySelector('.ai-cchip-name')?.textContent).toBe('bmw_sharepoint_sc');
    expect(container.querySelector('.ai-cchip .bdg')?.classList.contains('icon-only')).toBe(true);
    expect(container.querySelector('.ai-cchip .bdg .lbl')).toBeNull();
    expect(container.querySelector('.ai-cchip-src')).toBeNull();
    expect(container.textContent?.toLowerCase()).not.toContain('selection');
  });

  it('keeps the viewed page as a non-detachable, non-pinnable fallback', () => {
    S.page = { rid: '100' };
    S.context = {
      rid: '100',
      businessId: 'webpage',
      name: 'Current webpage',
      type: 'Scorecard',
    };
    const container = document.createElement('div');
    document.body.appendChild(container);
    new AiTab(() => {}).render(container);

    expect(container.querySelector('.ai-cchip-name')?.textContent).toBe('webpage');
    expect(container.querySelector('.ai-cchip-pin')).toBeNull();
    expect(container.querySelector('.ai-cchip-x')).toBeNull();
  });

  it('keeps editor + object context on one compact line without a count badge', () => {
    S.context = {
      rid: '118',
      businessId: 'qa_table',
      name: 'Open Actions',
      type: 'ExtendedTable',
    };
    const container = document.createElement('div');
    document.body.appendChild(container);
    const tab = new AiTab(() => {});
    tab.setEditorSource({
      kind: 'editor',
      object: { rid: '118', businessId: 'qa_table', name: 'Open Actions', type: 'ExtendedTable' },
      slot: { name: 'expression', lang: 'extended', code: 'output(1)' },
    });
    tab.render(container);

    const editor = container.querySelector('.ai-cchip--editor');
    expect(editor?.querySelector('svg')).toBeTruthy();
    expect(editor?.querySelector('.type-badge')).toBeNull();
    expect(editor?.textContent).toBe('');
    expect(container.textContent).not.toContain('2 contexts');
    expect(container.querySelectorAll('.ai-composer-ctx > .ai-cchip')).toHaveLength(2);
  });

  it('labels a handoff as coming via the editor, without exposing its shortcut', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const tab = new AiTab(() => {});
    tab.render(container);
    tab.submitHandoff('What does this do?', undefined, {
      v: 1,
      server: { id: 'demo', url: 'https://bmp.test/' },
      sources: [{
        kind: 'editor',
        object: { rid: '118', businessId: 'qa_table', name: 'Open Actions', type: 'ExtendedTable' },
        slot: { name: 'expression', lang: 'extended', code: 'output(1)' },
      }],
    });

    expect(container.querySelector('.ai-u-via')?.textContent).toBe('via editor');
    expect(container.textContent).not.toContain('Ctrl+K');
  });

  it('returns from an explicit object override to the saved webpage context', () => {
    S.page = { rid: '100' };
    S.context = {
      rid: '100',
      businessId: 'webpage',
      name: 'Current webpage',
      type: 'Scorecard',
    };
    const container = document.createElement('div');
    document.body.appendChild(container);
    const tab = new AiTab(() => {});
    tab.render(container);

    S.context = {
      rid: '200',
      businessId: 'selected_widget',
      name: 'Selected widget',
      type: 'ExtendedTable',
    };
    tab.contextChanged();
    expect(container.querySelector('.ai-cchip-name')?.textContent).toBe('selected_widget');

    container.querySelector<HTMLButtonElement>('.ai-cchip-x')?.click();

    expect(container.querySelector('.ai-cchip-name')?.textContent).toBe('webpage');
    expect(container.querySelector<HTMLElement>('.ai-cchip .bdg')?.title).toBe('Page');
    expect(container.querySelector('.ai-cchip-pin')).toBeNull();
    expect(container.querySelector('.ai-cchip-x')).toBeNull();
  });

  it('can restore a RID-only webpage even when the panel opened on an explicit object', () => {
    S.page = { rid: '100' };
    S.context = {
      rid: '200',
      businessId: 'selected_widget',
      name: 'Selected widget',
      type: 'ExtendedTable',
    };
    const container = document.createElement('div');
    document.body.appendChild(container);
    new AiTab(() => {}).render(container);

    container.querySelector<HTMLButtonElement>('.ai-cchip-x')?.click();

    expect(container.querySelector('.ai-cchip-name')?.textContent).toBe('100');
    expect(container.querySelector<HTMLElement>('.ai-cchip .bdg')?.title).toBe('Page');
    expect(container.querySelector('.ai-cchip-pin')).toBeNull();
    expect(container.querySelector('.ai-cchip-x')).toBeNull();
  });
});
