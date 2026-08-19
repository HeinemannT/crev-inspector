import { h } from '../lib/dom';

/** Stable action-row status shell. Cursor metadata is passive; transient
 * feedback owns the live region so moving the caret does not chatter through
 * assistive technology. */
export function createEditorStatus(): HTMLElement {
  return h('span', { class: 'editor-status', id: 'status-bar' },
    h('span', { class: 'editor-status-cursor', 'aria-hidden': 'true' },
      h('span', { class: 'editor-status-full' }, 'Ln 1, Col 1'),
      h('span', { class: 'editor-status-compact' }, '1/1'),
    ),
    h('span', {
      class: 'editor-status-message',
      role: 'status',
      'aria-live': 'polite',
      'aria-atomic': 'true',
    }),
  );
}

export function paintEditorStatus(
  root: HTMLElement,
  line: number,
  column: number,
  message: string | null,
): void {
  const full = root.querySelector<HTMLElement>('.editor-status-full');
  const compact = root.querySelector<HTMLElement>('.editor-status-compact');
  const feedback = root.querySelector<HTMLElement>('.editor-status-message');
  if (full) full.textContent = `Ln ${line}, Col ${column}`;
  if (compact) compact.textContent = `${line}/${column}`;
  if (feedback) feedback.textContent = message ?? '';
  root.classList.toggle('editor-status--message', message !== null);
}
