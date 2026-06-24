/**
 * editor-core / overlay — shared wiring for an editor that lives in an in-page
 * frame overlay (the EC editor and the CVO studio): the Esc→close keybinding
 * and the unsaved-changes guards. Both surfaces had byte-identical copies of
 * this safety-critical code; one home prevents them drifting apart.
 */
import type { KeyBinding } from '@codemirror/view'
import { installCloseHandshake } from '../lib/frame-close-handshake'
import { confirmModal } from '../lib/modal'

/** postMessage type the in-page frame host listens for to close the overlay. */
export const OVERLAY_CLOSE_MESSAGE = 'CREV_OVERLAY_CLOSE_PLEASE'

/** CodeMirror Esc binding that asks the host overlay to close. CM's own Esc
 *  handlers (search-panel close, etc.) run earlier in the keymap chain and
 *  consume the event first, so this only fires when the user means "close". */
export const closeOverlayKeyBinding: KeyBinding = {
  key: 'Escape',
  run: () => {
    try { window.parent.postMessage({ type: OVERLAY_CLOSE_MESSAGE }, '*') } catch { /* ignore */ }
    return true
  },
}

/** Wire the two unsaved-changes guards an overlay editor needs: the host
 *  close-request handshake (an in-app confirm) and the browser `beforeunload`
 *  prompt (the only reliable signal when the BMP host page navigates and the
 *  overlay iframe is about to be destroyed). */
export function installDirtyGuards(opts: { isDirty: () => boolean; bodyText: string }): void {
  installCloseHandshake(async () => {
    if (!opts.isDirty()) return true
    return confirmModal({ title: 'Discard unsaved changes?', body: opts.bodyText, confirmLabel: 'Discard', confirmVariant: 'danger' })
  })
  window.addEventListener('beforeunload', e => {
    if (!opts.isDirty()) return
    e.preventDefault()
    e.returnValue = ''
  })
}
