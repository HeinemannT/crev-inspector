/**
 * The studio's `?` quick-reference popover — same idea as the EC editor's, but
 * tabbed: one tab per concern (Run / View / Edit / Data). The View tab explains
 * Wrap and Format; the others cover shortcuts, the layout switcher, and the
 * data/preview controls. Esc or an outside click dismisses.
 */
import { h, render as renderDom } from '../lib/dom'
import { anchorPopover } from '../lib/popover-anchor'
import type { StudioMode } from './studio-mode'

interface HelpTab { id: string; label: string; rows: Array<[string, string]> }

function installDismissal(popover: HTMLElement, anchor: HTMLElement): void {
  anchor.setAttribute('aria-expanded', 'true')
  const close = (event?: Event) => {
    if (event && popover.contains(event.target as Node)) return
    popover.remove()
    anchor.setAttribute('aria-expanded', 'false')
    document.removeEventListener('mousedown', close)
    document.removeEventListener('keydown', onKey)
  }
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return
    event.stopPropagation()
    close()
    anchor.focus()
  }
  setTimeout(() => {
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', onKey)
  }, 0)
}

export function showStudioHelp(anchor: HTMLElement, mod: string, mode: StudioMode): void {
  const existing = document.getElementById('studio-help-popover')
  if (existing) {
    existing.remove()
    anchor.setAttribute('aria-expanded', 'false')
    return
  }

  const cvoTabs: HelpTab[] = [
    { id: 'run', label: 'Run', rows: [
      [`${mod}+Enter`, 'Re-render the preview (retries failed dependencies)'],
      [`${mod}+S`, 'Save every changed field (html + javascript)'],
    ]},
    { id: 'view', label: 'View', rows: [
      ['Wrap', 'Soft-wrap long lines so they stay in view, without changing the file'],
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
  const textTabs: HelpTab[] = [
    { id: 'run', label: 'Save', rows: [
      [`${mod}+Enter`, 'Re-render the inert preview'],
      [`${mod}+S`, 'Save every changed field (text + longText), then read back BMP’s stored version'],
    ]},
    { id: 'view', label: 'View', rows: [
      ['Wrap', 'Soft-wrap long lines so they stay in view, without changing the HTML'],
      [`Format · ${mod}+Shift+F`, 'Reindent and reflow the active HTML field'],
      ['Code / Split / Preview', 'Show the editor only, both, or the preview only'],
      ['Full / 1280 / 768 / 375', 'Render at a container width to check responsive layout'],
      ['Drag the divider', 'Resize the editor/preview split'],
    ]},
    { id: 'edit', label: 'Edit', rows: [
      [`${mod}+F`, 'Find and replace (docked panel)'],
      [`${mod}+D`, 'Select the next occurrence (multi-cursor)'],
      ['Tab / Shift+Tab', 'Indent / outdent the selection'],
      ['Esc', 'Close the studio'],
    ]},
    { id: 'content', label: 'Content', rows: [
      ['Static HTML', 'TextElements store sanitized content; scripts and event handlers are removed by BMP'],
      ['Preview', 'The preview is inert and cannot execute or navigate active content'],
      ['After save', 'The editor reloads the exact value BMP persisted and reports any sanitization'],
      ['Executable UI', 'Use a Custom Visualization when the content needs JavaScript'],
    ]},
  ]
  const tabs = mode.key === 'text' ? textTabs : cvoTabs

  let active = tabs[0].id
  const popover = h('div', {
    id: 'studio-help-popover', class: 'studio-help-popover', role: 'dialog',
    'aria-label': 'Studio reference', style: 'top:-9999px; left:-9999px;',
  })

  const draw = () => {
    const tab = tabs.find(t => t.id === active)!
    renderDom(popover,
      h('div', { class: 'studio-help-title' }, `${mode.title}: quick reference`),
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
  installDismissal(popover, anchor)
}

/**
 * Explains the studio's bottom-panel concepts where they are encountered.
 * This deliberately stays separate from the shortcut reference: Inputs and
 * dependency hosting are product workflows, not keyboard commands.
 */
export function showStudioPanelHelp(anchor: HTMLElement): void {
  const existing = document.getElementById('studio-panel-help-popover')
  if (existing) {
    existing.remove()
    anchor.setAttribute('aria-expanded', 'false')
    return
  }

  const popover = h('div', {
    id: 'studio-panel-help-popover',
    class: 'studio-help-popover studio-panel-help-popover',
    role: 'dialog',
    'aria-label': 'Inputs and dependencies help',
    style: 'top:-9999px; left:-9999px;',
  },
    h('div', { class: 'studio-help-title' }, 'Inputs and dependencies'),
    h('section', { class: 'studio-panel-help-section' },
      h('h3', null, 'Inputs'),
      h('p', null, 'Inputs are child objects of this CVO. At render time BMP exposes them through _data, including expressions, tables, and connections.'),
      h('p', null, 'Add, Save, and Remove update the child objects in BMP. Mock values affect only your local preview; they are not saved as production data.'),
    ),
    h('section', { class: 'studio-panel-help-section' },
      h('h3', null, 'Deps'),
      h('p', null, 'Deps scans the current HTML and JavaScript for FileResource references and external CDN URLs. Re-render retries dependencies that previously failed.'),
      h('p', null, 'Host resource opens a local file picker. The selected file is created or updated as a FileResource under Resources > CREV Studio Assets, then the studio gives you a rid-based snippet to insert into the CVO.'),
      h('p', { class: 'studio-panel-help-note' }, 'CDN URLs require network access from the BMP browser. Host critical libraries as FileResources for air-gapped or restricted environments.'),
    ),
    h('div', { class: 'studio-help-footer' }, 'Press Esc to close'),
  )

  document.body.appendChild(popover)
  anchorPopover(popover, anchor)
  installDismissal(popover, anchor)
}
