interface NativeEditPageSnapshot {
  host: HTMLElement;
  inert: boolean;
  ariaHidden: string | null;
}

let tracked: NativeEditPageSnapshot | null = null;

function restore(snapshot: NativeEditPageSnapshot): void {
  snapshot.host.inert = snapshot.inert;
  if (snapshot.ariaHidden === null) snapshot.host.removeAttribute('aria-hidden');
  else snapshot.host.setAttribute('aria-hidden', snapshot.ariaHidden);
}

/** Track the native BMP EditPage that supplies the model canvas bounds.
 * Switching hosts restores the previous page before taking ownership of the
 * next one, which keeps SPA navigation and React remounts leak-free. */
export function trackNativeEditPage(host: Element): void {
  if (!(host instanceof HTMLElement) || tracked?.host === host) return;
  if (tracked) restore(tracked);
  tracked = {
    host,
    inert: host.inert,
    ariaHidden: host.getAttribute('aria-hidden'),
  };
}

/** The opaque model canvas owns interaction while visible. Peek mode restores
 * the native form so keyboard and assistive-technology state matches what is
 * actually on screen. */
export function setNativeEditPageSuppressed(suppressed: boolean): void {
  if (!tracked) return;
  if (suppressed) {
    tracked.host.inert = true;
    tracked.host.setAttribute('aria-hidden', 'true');
  } else {
    restore(tracked);
  }
}

/** Release the native form when Blueprint exits. */
export function releaseNativeEditPage(): void {
  if (!tracked) return;
  restore(tracked);
  tracked = null;
}
