/**
 * Shared object hover card — ONE builder for the badge-hover card (content
 * script, `#crev-tooltip`) AND the EC editor's BID hover (iframe). Both used
 * to hand-roll their own card DOM; this is the single source so they look and
 * behave identically. Plain `document.createElement` so it works in either
 * document context (the editor runs in its own iframe document).
 *
 * The `.crev-tt-*` class contract is shared too — content-overlay.css and
 * editor.css both style these classes (light card, theme-independent).
 */
import { h, svg } from './dom'
import { ICON_ARROWS_OUT_SIMPLE, ICON_CODE } from './icons'

export interface ObjectCardData {
  name?: string
  type?: string
  /** Shown in the type line when `type` is absent (e.g. "Loading…" / "Unknown"). */
  typeFallback?: string
  businessId?: string
  templateBusinessId?: string
  rid?: string
  /** Type accent colour (hex) for the header tint + dot. */
  color: string
  /** A short source excerpt to show under the facts (EC / html / js). */
  codePreview?: string
}

export interface ObjectCardActions {
  /** Expand icon in the header — opens the full object view. Omit to hide. */
  onOpenFull?: () => void
  /** Code icon in the header — opens the EC editor / studio. Omit to hide. */
  onOpenEc?: () => void
}

/** One copy-on-click fact row (green ✓ flash), or null when the value is empty. */
function copyRow(k: string, value: string | undefined, dim = false): HTMLElement | null {
  if (!value) return null
  const v = h('span', { class: `crev-tt-v${dim ? ' crev-tt-v--dim' : ''}` }, value)
  return h('button', {
    class: 'crev-tt-cprow',
    type: 'button',
    title: `Copy ${k}`,
    onClick: (e: Event) => {
      e.stopPropagation()
      navigator.clipboard?.writeText(value).catch(() => { /* blocked — silent */ })
      const orig = v.textContent
      v.textContent = '✓ copied'
      v.classList.add('crev-tt-v--ok')
      setTimeout(() => { v.textContent = orig; v.classList.remove('crev-tt-v--ok') }, 700)
    },
  }, h('span', { class: 'crev-tt-k' }, k), v)
}

export function buildObjectCard(data: ObjectCardData, actions: ObjectCardActions = {}): HTMLElement {
  const typeName = data.type ?? data.typeFallback ?? 'Unknown'

  const headActions: HTMLElement[] = []
  if (actions.onOpenEc) {
    headActions.push(h('button', {
      class: 'crev-tt-open',
      title: 'Open in the Extended Code editor',
      'aria-label': 'Open in the Extended Code editor',
      onClick: (e: Event) => { e.stopPropagation(); actions.onOpenEc!() },
    }, svg(ICON_CODE)))
  }
  if (actions.onOpenFull) {
    headActions.push(h('button', {
      class: 'crev-tt-open',
      title: 'Open full object view',
      'aria-label': 'Open full object view',
      onClick: (e: Event) => { e.stopPropagation(); actions.onOpenFull!() },
    }, svg(ICON_ARROWS_OUT_SIMPLE)))
  }

  const card = h('div', { class: 'crev-tt-card' },
    h('div', { class: 'crev-tt-band' },
      h('div', { class: 'crev-tt-hd' },
        h('div', { class: 'crev-tt-nm' }, data.name || data.businessId || '(unnamed)'),
        h('div', { class: 'crev-tt-ty' },
          h('span', { class: 'crev-tt-tydot' }),
          typeName,
        ),
      ),
      ...headActions,
    ),
    h('div', { class: 'crev-tt-body' },
      copyRow('ID', data.businessId),
      copyRow('Template', data.templateBusinessId),
      copyRow('RID', data.rid, true),
    ),
  )
  card.style.setProperty('--tt-color', data.color)

  if (data.codePreview) {
    const code = h('pre', { class: 'crev-tt-code' }, data.codePreview)
    card.appendChild(code)
  }
  return card
}
