/**
 * Lock only the editable regions of the current object-view window.
 *
 * `inert` covers pointer, keyboard and focus interaction without introducing
 * any service-worker, storage or BMP-side lock state.
 */
export function syncObjectViewInteractionLock(root: HTMLElement, locked: boolean): void {
  const shell = root.querySelector<HTMLElement>('.ov-shell');
  if (!shell) return;

  if (locked) shell.setAttribute('aria-busy', 'true');
  else shell.removeAttribute('aria-busy');

  for (const region of shell.querySelectorAll<HTMLElement>(':scope > .ov-header, :scope > .ov-body')) {
    region.inert = locked;
    region.toggleAttribute('inert', locked);
  }
}
