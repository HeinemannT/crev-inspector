/**
 * Delegated event handler — single listener on container routes clicks via data-action.
 * Replaces per-element addEventListener calls across all tab renderers.
 *
 * Uses a WeakMap to track installed listeners per container, preventing accumulation
 * when render → delegate is called repeatedly on the same panel element.
 */

type ActionHandler = (el: HTMLElement, event: Event) => void;

const installed = new WeakMap<HTMLElement, (e: Event) => void>();

/** Register delegated click handlers keyed by data-action values */
export function delegate(
  container: HTMLElement,
  handlers: Record<string, ActionHandler>,
): void {
  // Remove previous listener if one exists for this container
  const prev = installed.get(container);
  if (prev) container.removeEventListener('click', prev);

  const listener = (e: Event) => {
    let target = e.target as HTMLElement | null;
    while (target && target !== container) {
      const action = target.dataset?.action;
      if (action && handlers[action]) {
        handlers[action](target, e);
        return;
      }
      target = target.parentElement;
    }
  };

  container.addEventListener('click', listener);
  installed.set(container, listener);
}
