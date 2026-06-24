/** Platform helpers shared by the editor surfaces (EC editor + CVO studio). */
export const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform)

/** Modifier glyph for keyboard-shortcut hints — ⌘ on macOS, Ctrl elsewhere. */
export const KBD_MOD = isMac ? '⌘' : 'Ctrl'
