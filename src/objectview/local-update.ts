/**
 * Replace one property control without replacing its scroll-owning document.
 *
 * The expanded object view uses this for edit-on-demand interactions. Keeping
 * the existing `.ov-body` node is important: replacing it makes the browser
 * briefly paint the new container at scrollTop 0 before scroll restoration.
 */
export function replacePropertyElement(
  root: HTMLElement,
  prop: string,
  renderNext: () => HTMLElement | null,
): boolean {
  const selector = `[data-property-prop="${CSS.escape(prop)}"]`;
  const current = root.querySelector<HTMLElement>(selector);
  const next = renderNext();
  if (!current || !next) return false;
  current.replaceWith(next);
  return true;
}

/** Keep an optional shell-level element in sync without rebuilding the shell. */
export function syncOptionalElement(
  container: HTMLElement,
  selector: string,
  next: HTMLElement | null,
): void {
  const current = container.querySelector<HTMLElement>(`:scope > ${selector}`);
  if (current && next) current.replaceWith(next);
  else if (current) current.remove();
  else if (next) container.appendChild(next);
}
