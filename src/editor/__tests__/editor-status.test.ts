// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createEditorStatus, paintEditorStatus } from '../editor-status';

describe('editor action-row status', () => {
  it('renders full and compact cursor representations from one value', () => {
    const status = createEditorStatus();
    paintEditorStatus(status, 12345, 999, null);

    expect(status.querySelector('.editor-status-full')?.textContent).toBe('Ln 12345, Col 999');
    expect(status.querySelector('.editor-status-compact')?.textContent).toBe('12345/999');
    expect(status.classList.contains('editor-status--message')).toBe(false);
  });

  it('keeps transient feedback separate from passive cursor metadata', () => {
    const status = createEditorStatus();
    paintEditorStatus(status, 8, 3, 'Formatted · undo available');

    expect(status.classList.contains('editor-status--message')).toBe(true);
    expect(status.querySelector('.editor-status-message')?.textContent).toBe('Formatted · undo available');
    expect(status.querySelector('.editor-status-message')?.getAttribute('role')).toBe('status');

    paintEditorStatus(status, 8, 3, null);
    expect(status.classList.contains('editor-status--message')).toBe(false);
    expect(status.querySelector('.editor-status-message')?.textContent).toBe('');
  });

  it('keeps the ordered compact and tight action-row contract in CSS', () => {
    const css = readFileSync(join(__dirname, '..', 'editor.css'), 'utf8');
    const compactAt = css.indexOf('@media (max-width: 760px)');
    const tightAt = css.indexOf('@media (max-width: 680px)');

    expect(compactAt).toBeGreaterThan(-1);
    expect(tightAt).toBeGreaterThan(compactAt);
    expect(css.slice(compactAt, tightAt)).toContain('.editor-status-compact { display: inline; }');
    expect(css.slice(tightAt)).toContain('.editor-status:not(.editor-status--message)');
  });
});
