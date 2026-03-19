/**
 * CodeMirror integration for the side panel script tab.
 * Lazy-loads CM6 modules and creates a compact editor.
 */

import type { EditorView } from '@codemirror/view';

let cmView: EditorView | null = null;
let cmContainer: HTMLDivElement | null = null;
let executeCallback: ((transactional: boolean) => void) | null = null;

/** Set the callback for Ctrl+Enter / Cmd+Enter */
export function setExecuteCallback(cb: (transactional: boolean) => void): void {
  executeCallback = cb;
}

/** Lazy-load CodeMirror and create a compact editor in the given host */
export async function ensureScriptEditor(host: HTMLDivElement): Promise<EditorView> {
  if (cmView && cmContainer) {
    // Re-append persistent container
    host.appendChild(cmContainer);
    return cmView;
  }

  // Dynamic imports
  const [
    { EditorView: EV, keymap, drawSelection, lineNumbers },
    { EditorState },
    { defaultKeymap, history, historyKeymap, indentWithTab },
    { bracketMatching },
    { closeBrackets, closeBracketsKeymap, autocompletion },
    { oneDark },
    { extendedLanguage },
    { extendedHighlighting },
    { extendedCompletions },
    { extendedHoverDocs },
  ] = await Promise.all([
    import('@codemirror/view'),
    import('@codemirror/state'),
    import('@codemirror/commands'),
    import('@codemirror/language'),
    import('@codemirror/autocomplete'),
    import('@codemirror/theme-one-dark'),
    import('../editor/ec/language'),
    import('../editor/ec/highlight'),
    import('../editor/ec/completions'),
    import('../editor/ec/hoverDocs'),
  ]);

  cmContainer = document.createElement('div');
  cmContainer.className = 'script-cm-container';

  const compactTheme = EV.theme({
    '&': { fontSize: '12px', flex: '1' },
    '.cm-content': { padding: '4px 0', fontFamily: "'Cascadia Code', 'Fira Code', 'SF Mono', Consolas, monospace" },
    '.cm-scroller': { overflow: 'auto' },
    '&.cm-focused': { outline: '1px solid var(--md-primary)' },
  });

  const state = EditorState.create({
    doc: '',
    extensions: [
      compactTheme,
      lineNumbers(),
      drawSelection(),
      bracketMatching(),
      closeBrackets(),
      history(),
      autocompletion({ override: [extendedCompletions] }),
      oneDark,
      extendedLanguage,
      extendedHighlighting,
      extendedHoverDocs,
      keymap.of([
        indentWithTab,
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...historyKeymap,
        {
          key: 'Ctrl-Enter',
          run: () => { executeCallback?.(false); return true; },
        },
        {
          key: 'Shift-Ctrl-Enter',
          run: () => { executeCallback?.(true); return true; },
        },
        {
          key: 'Mod-Enter',
          run: () => { executeCallback?.(false); return true; },
        },
      ]),
    ],
  });

  cmView = new EV({
    state,
    parent: cmContainer,
  });

  host.appendChild(cmContainer);
  return cmView;
}

/** Get current editor content */
export function getCode(): string {
  return cmView?.state.doc.toString() ?? '';
}

/** Set editor content */
export function setCode(code: string): void {
  if (!cmView) return;
  cmView.dispatch({
    changes: { from: 0, to: cmView.state.doc.length, insert: code },
  });
}

/** Get the persistent container element */
export function getCmContainer(): HTMLDivElement | null {
  return cmContainer;
}

/** Focus the editor */
export function focusEditor(): void {
  cmView?.focus();
}
