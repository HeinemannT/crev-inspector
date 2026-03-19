import { h, render } from '../../lib/dom';
import { delegate } from '../delegate';
import { S, sendMessage } from '../state';
import { relativeTime } from '../utils';
import { getCode, setCode, ensureScriptEditor, setExecuteCallback, getCmContainer, focusEditor } from '../script-cm';

function isConnected(): boolean {
  return S.connState.display === 'connected';
}

// Track whether CM is initializing to prevent double-init
let cmInitializing = false;
// Persistent container for CodeMirror (survives re-renders)
let cmHostDiv: HTMLDivElement | null = null;

export function renderScriptTab() {
  const panel = document.getElementById('panel-script');
  if (!panel) return;

  const contextHint = S.pageInfo?.rid ? `Page RID: ${S.pageInfo.rid}` : 'No page context';
  const contextRid = S.pageInfo?.rid ?? '';

  const connected = isConnected();
  const previewDisabled = S.ecConsoleWaiting || !connected;
  const runDisabled = S.ecConsoleWaiting || !connected;
  const previewTitle = connected ? '' : 'Not connected';
  const runTitle = connected ? '' : 'Not connected';

  // CodeMirror host — preserve across renders
  if (!cmHostDiv) {
    cmHostDiv = document.createElement('div');
    cmHostDiv.className = 'script-cm-host';
  }

  // Snippet popover
  const snippetPopover = S.snippetPopoverOpen
    ? h('div', { class: 'snippet-popover' },
        h('div', { class: 'snippet-item', 'data-action': 'snippet-lookup' }, 'lookup()'),
        h('div', { class: 'snippet-item', 'data-action': 'snippet-children' }, 'children()'),
        h('div', { class: 'snippet-item', 'data-action': 'snippet-find' }, 'find by ID'),
      )
    : null;

  const toolbarRight = h('div', { class: 'script-toolbar-right' },
    S.ecConsoleOutput != null && h('button', { class: 'btn btn-small', 'data-action': 'clear' }, 'Clear'),
    h('div', { class: 'snippet-anchor' },
      h('button', { class: 'btn btn-small', 'data-action': 'toggle-snippets' }, 'Snippets'),
      snippetPopover,
    ),
    h('button', {
      class: 'btn btn-small btn-accent',
      'data-action': 'preview',
      disabled: previewDisabled,
      title: previewTitle,
    }, S.ecConsoleWaiting ? 'Running\u2026' : 'Preview'),
    h('button', {
      class: 'btn btn-small btn-danger',
      'data-action': 'run',
      disabled: runDisabled,
      title: runTitle,
    }, 'Run'),
  );

  // History — collapsible list (matches objects tab Recent pattern)
  const historyEntries = S.scriptHistory ?? [];
  let historySection: HTMLElement | null = null;
  if (historyEntries.length > 0) {
    const headerLabel = S.scriptHistoryExpanded
      ? `\u25BE History (${historyEntries.length})`
      : `\u25B8 History (${historyEntries.length})`;

    historySection = h('div', { class: `recent-section${S.scriptHistoryExpanded ? ' expanded' : ''}` },
      h('div', { class: 'section-title section-title--flush recent-header', 'data-action': 'toggle-script-history' }, headerLabel),
      S.scriptHistoryExpanded && h('div', { class: 'recent-list' },
        ...historyEntries.map((entry, i) =>
          h('div', { class: 'recent-row', 'data-action': 'script-history-click', 'data-idx': String(i) },
            h('span', { class: 'recent-action' }, entry.mode === 'execute' ? '\u26A1' : '\u25B6'),
            h('span', { class: `sh-status ${entry.ok ? 'sh-status--ok' : 'sh-status--fail'}` }, entry.ok ? '\u2713' : '\u2717'),
            h('span', { class: 'sh-code' }, entry.code.split('\n')[0].slice(0, 50)),
            h('span', { class: 'recent-time' }, relativeTime(entry.timestamp)),
          ),
        ),
      ),
    );
  }

  const editor = h('div', { class: 'script-editor' },
    cmHostDiv,
    h('div', { class: 'script-toolbar' },
      h('span', { class: 'script-hint' }, contextHint),
      toolbarRight,
    ),
    historySection,
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

  // Initialize CodeMirror lazily
  if (!cmInitializing && !getCmContainer()) {
    cmInitializing = true;
    setExecuteCallback(runScriptEc);
    ensureScriptEditor(cmHostDiv).then(() => {
      cmInitializing = false;
      if (S.ecConsoleCode) setCode(S.ecConsoleCode);
      focusEditor();
    }).catch(() => { cmInitializing = false; });
  } else if (getCmContainer() && cmHostDiv && !cmHostDiv.contains(getCmContainer()!)) {
    // Re-attach CM container after render() cleared the DOM
    cmHostDiv.appendChild(getCmContainer()!);
  }

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
    'toggle-snippets': () => {
      S.snippetPopoverOpen = !S.snippetPopoverOpen;
      renderScriptTab();
    },
    'snippet-lookup': () => {
      S.snippetPopoverOpen = false;
      const code = contextRid
        ? `lookup(${contextRid}).name`
        : 'lookup(RID).name';
      setCode(code);
      focusEditor();
    },
    'snippet-children': () => {
      S.snippetPopoverOpen = false;
      const code = contextRid
        ? `lookup(${contextRid}).children().forEach(_c:\n  output(_c.name)\n)`
        : 'lookup(RID).children().forEach(_c:\n  output(_c.name)\n)';
      setCode(code);
      focusEditor();
    },
    'snippet-find': () => {
      S.snippetPopoverOpen = false;
      setCode('root.allDescendants().filter(_o: _o.id == "...").first().name');
      focusEditor();
    },
    'toggle-script-history': () => {
      S.scriptHistoryExpanded = !S.scriptHistoryExpanded;
      renderScriptTab();
    },
    'script-history-click': (el) => {
      const idx = parseInt(el.dataset.idx ?? '', 10);
      const entries = S.scriptHistory ?? [];
      if (entries[idx]) {
        setCode(entries[idx].code);
        focusEditor();
      }
    },
  });
}

function runScriptEc(transactional = false) {
  const code = getCode().trim();
  if (!code || S.ecConsoleWaiting) return;

  S.ecConsoleCode = code;
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
