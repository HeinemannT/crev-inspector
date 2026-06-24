/**
 * The studio's `?` quick-reference popover — same idea as the EC editor's, but
 * tabbed: one tab per concern (Run / View / Edit / Data). The View tab explains
 * Wrap and Format; the others cover shortcuts, the layout switcher, and the
 * data/preview controls. Esc or an outside click dismisses.
 */
import { h, render as renderDom } from '../lib/dom'
import { anchorPopover } from '../lib/popover-anchor'

interface HelpTab { id: string; label: string; rows: Array<[string, string]> }

export function showStudioHelp(anchor: HTMLElement, mod: string): void {
  const existing = document.getElementById('studio-help-popover')
  if (existing) { existing.remove(); return }

  const tabs: HelpTab[] = [
    { id: 'run', label: 'Run', rows: [
      [`${mod}+Enter`, 'Re-render the preview (retries failed dependencies)'],
      [`${mod}+S`, 'Save every changed field (html + javascript)'],
    ]},
    { id: 'view', label: 'View', rows: [
      ['Wrap', 'Soft-wrap long lines so they stay in view — no change to the file'],
      [`Format · ${mod}+Shift+F`, 'Reindent and reflow the active file (HTML or JavaScript)'],
      ['Code / Split / Preview', 'Show the editor only, both, or the preview only'],
      ['Full / 1280 / 768 / 375', 'Render the CVO at a container width to check responsiveness'],
      ['Drag the dividers', 'Resize the editor/preview split and the bottom panel'],
    ]},
    { id: 'edit', label: 'Edit', rows: [
      [`${mod}+F`, 'Find and replace (docked panel)'],
      [`${mod}+D`, 'Select the next occurrence (multi-cursor)'],
      [`${mod}+/`, 'Toggle a line comment'],
      ['Tab / Shift+Tab', 'Indent / outdent the selection'],
      ['Esc', 'Close the studio'],
    ]},
    { id: 'data', label: 'Data', rows: [
      ['Mock / Live', 'Preview against local mock _data or real BMP data'],
      ['Context', 'The scorecard or page rid the live-data servlet is gated on'],
      ['Inputs', 'Add expression inputs, each exposed as _data.expressions.<key>'],
      ['Deps', 'Detected FileResource libraries + CDN URLs; host a file as a FileResource'],
    ]},
  ]

  let active = tabs[0].id
  const popover = h('div', {
    id: 'studio-help-popover', class: 'studio-help-popover', role: 'dialog',
    'aria-label': 'Studio reference', style: 'top:-9999px; left:-9999px;',
  })

  const draw = () => {
    const tab = tabs.find(t => t.id === active)!
    renderDom(popover,
      h('div', { class: 'studio-help-title' }, 'CVO studio: quick reference'),
      h('div', { class: 'studio-help-tabs', role: 'tablist' },
        ...tabs.map(t => h('button', {
          class: `studio-help-tab${t.id === active ? ' active' : ''}`,
          role: 'tab', 'aria-selected': t.id === active ? 'true' : 'false',
          onClick: () => { active = t.id; draw() },
        }, t.label)),
      ),
      h('table', { class: 'studio-help-table' },
        ...tab.rows.map(([k, v]) => h('tr', null,
          h('td', { class: 'studio-help-key' }, h('kbd', null, k)),
          h('td', { class: 'studio-help-val' }, v),
        )),
      ),
      h('div', { class: 'studio-help-footer' }, 'Press Esc to close'),
    )
    if (popover.isConnected) anchorPopover(popover, anchor)
  }
  draw()
  document.body.appendChild(popover)
  anchorPopover(popover, anchor)

  const close = (e?: Event) => {
    if (e && popover.contains(e.target as Node)) return
    popover.remove()
    document.removeEventListener('mousedown', close)
    document.removeEventListener('keydown', onKey)
  }
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close() } }
  setTimeout(() => {
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', onKey)
  }, 0)
}
