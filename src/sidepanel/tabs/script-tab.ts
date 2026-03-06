import { h, render } from '../../lib/dom';
import { delegate } from '../delegate';
import { S, sendMessage } from '../state';

// Preserve textarea reference across re-renders so cursor position isn't lost
let cachedTextarea: HTMLTextAreaElement | null = null;

export function renderScriptTab() {
  const panel = document.getElementById('panel-script');
  if (!panel) return;

  const contextHint = S.pageInfo?.rid ? `Page RID: ${S.pageInfo.rid}` : 'No page context';

  // Reuse textarea if it already exists to preserve cursor/selection
  if (!cachedTextarea || !panel.contains(cachedTextarea)) {
    cachedTextarea = h('textarea', {
      id: 'ec-input',
      class: 'script-input',
      placeholder: 'lookup(RID).name',
      rows: 6,
    }) as HTMLTextAreaElement;
    cachedTextarea.value = S.ecConsoleCode;
    cachedTextarea.addEventListener('input', () => { S.ecConsoleCode = cachedTextarea!.value; });
    cachedTextarea.addEventListener('keydown', (e) => {
      const ke = e as KeyboardEvent;
      if (ke.key === 'Enter' && (ke.ctrlKey || ke.metaKey)) {
        ke.preventDefault();
        runScriptEc(ke.shiftKey);
      }
    });
  }

  const toolbarRight = h('div', { class: 'script-toolbar-right' },
    S.ecConsoleOutput != null && h('button', { class: 'btn btn-small', 'data-action': 'clear' }, 'Clear'),
    h('button', {
      class: 'btn btn-small btn-accent',
      'data-action': 'preview',
      disabled: S.ecConsoleWaiting,
    }, S.ecConsoleWaiting ? 'Running\u2026' : 'Preview'),
    h('button', {
      class: 'btn btn-small btn-danger',
      'data-action': 'run',
      disabled: S.ecConsoleWaiting,
    }, 'Run'),
  );

  const editor = h('div', { class: 'script-editor' },
    h('div', { class: 'script-hint' }, 'Extended Code \u2014 query and modify BMP objects'),
    cachedTextarea,
    h('div', { class: 'script-toolbar' },
      h('span', { class: 'script-hint' }, contextHint),
      toolbarRight,
    ),
  );

  // Output section
  if (S.ecConsoleOutput != null) {
    const resultClass = !S.ecConsoleOk ? 'error' : S.ecConsoleHasWarning ? 'warning' : 'ok';
    const modeLabel = S.ecConsoleMode === 'execute' ? 'Executed' : 'Preview';
    const durationLabel = S.ecConsoleDurationMs != null ? ` \u00b7 ${S.ecConsoleDurationMs}ms` : '';
    const expandLabel = S.ecConsoleExpanded ? '\u25B4 Collapse' : '\u25BE Expand';

    editor.appendChild(
      h('div', { class: 'script-result-header' },
        h('span', { class: `script-result-mode ${resultClass}` }, modeLabel),
        h('span', { class: 'script-result-duration' }, durationLabel),
        h('button', { class: 'detail-expand-output', 'data-action': 'expand' }, expandLabel),
      )
    );
    const pre = h('pre', { class: `script-result ${resultClass}${S.ecConsoleExpanded ? ' expanded' : ''}` }, S.ecConsoleOutput);
    editor.appendChild(pre);
  }

  render(panel, editor);

  delegate(panel, {
    preview: () => runScriptEc(false),
    run: () => runScriptEc(true),
    clear: () => {
      S.ecConsoleOutput = null;
      S.ecConsoleExpanded = false;
      renderScriptTab();
    },
    expand: () => {
      S.ecConsoleExpanded = !S.ecConsoleExpanded;
      renderScriptTab();
    },
  });
}

function runScriptEc(transactional = false) {
  const code = S.ecConsoleCode.trim();
  if (!code || S.ecConsoleWaiting) {
    if (!code && !S.ecConsoleWaiting && cachedTextarea) {
      cachedTextarea.classList.add('field-input--invalid');
      setTimeout(() => cachedTextarea?.classList.remove('field-input--invalid'), 800);
    }
    return;
  }
  S.ecConsoleWaiting = true;
  S.ecConsoleOutput = null;
  S.ecConsoleStartTime = Date.now();
  S.ecConsoleMode = transactional ? 'execute' : 'preview';
  sendMessage({ type: 'EC_EXECUTE', code, objectRid: S.pageInfo?.rid, transactional });
  renderScriptTab();
}

export function updateScriptOutput() {
  renderScriptTab();
}
