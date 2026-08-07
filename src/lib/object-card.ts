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
import { ICON_ARROWS_OUT_SIMPLE, ICON_CHECK, ICON_CODE, ICON_PENCIL, ICON_X } from './icons'
import {
  normalizeAndValidateIdentity,
  resolveDisplayIdentity,
  type IdentityEditInput,
  type IdentityField,
  type IdentitySaveResult,
} from './object-identity'
import { typeAffordances } from './widget-metadata'

/** Shared capability policy for every object-card surface. A resolved rid or a
 * preview string does not make a non-code BMP type editable. */
export function supportsObjectCardCode(type?: string): boolean {
  return !!type && typeAffordances(type).code
}

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
  /** Pencil icon in the header. Omit on read-only card instances. */
  onSaveIdentity?: (identity: IdentityEditInput) => Promise<IdentitySaveResult>
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
  let businessId = data.businessId ?? ''
  let name = data.name ?? ''
  let templateBusinessId = data.templateBusinessId ?? ''

  const headActions: HTMLElement[] = []
  if (actions.onSaveIdentity) {
    headActions.push(h('button', {
      class: 'crev-tt-open crev-tt-edit-open',
      type: 'button',
      title: 'Edit name, ID, and template ID',
      'aria-label': 'Edit name, ID, and template ID',
    }, svg(ICON_PENCIL)))
  }
  if (actions.onOpenEc) {
    headActions.push(h('button', {
      class: 'crev-tt-open',
      type: 'button',
      title: 'Open in the Extended Code editor',
      'aria-label': 'Open in the Extended Code editor',
      onClick: (e: Event) => { e.stopPropagation(); actions.onOpenEc!() },
    }, svg(ICON_CODE)))
  }
  if (actions.onOpenFull) {
    headActions.push(h('button', {
      class: 'crev-tt-open',
      type: 'button',
      title: 'Open full object view',
      'aria-label': 'Open full object view',
      onClick: (e: Event) => { e.stopPropagation(); actions.onOpenFull!() },
    }, svg(ICON_ARROWS_OUT_SIMPLE)))
  }

  const displayedIdentity = () => resolveDisplayIdentity({
    rid: data.rid,
    businessId,
    templateBusinessId,
  })
  const nameEl = h('div', { class: 'crev-tt-nm' }, name || displayedIdentity().primary || '(unnamed)')
  const actionBar = h('div', { class: 'crev-tt-actions' }, ...headActions)
  const body = h('div', { class: 'crev-tt-body' })
  const band = h('div', { class: 'crev-tt-band' },
      h('div', { class: 'crev-tt-hd' },
        nameEl,
        h('div', { class: 'crev-tt-ty' },
          h('span', { class: 'crev-tt-tydot' }),
          typeName,
        ),
      ),
      actionBar,
    )
  const card = h('div', { class: 'crev-tt-card' },
    band,
    body,
  )
  card.style.setProperty('--tt-color', data.color)

  const renderReadMode = (): void => {
    card.classList.remove('crev-tt-card--editing')
    const display = displayedIdentity()
    nameEl.textContent = name || display.primary || '(unnamed)'
    actionBar.replaceChildren(...headActions)
    body.replaceChildren(
      ...[
        copyRow(display.primaryLabel, display.primary),
        display.primaryKind === 'template' ? copyRow('Instance ID', display.secondary, true) : null,
        copyRow('RID', data.rid, true),
      ].filter((row): row is HTMLElement => row !== null),
    )
  }

  const renderEditMode = (): void => {
    if (!actions.onSaveIdentity) return
    card.classList.add('crev-tt-card--editing')

    const idInput = h('input', {
      class: 'crev-tt-edit-input crev-tt-edit-id',
      name: 'businessId',
      value: businessId,
      autocomplete: 'off',
      spellcheck: 'false',
      'aria-label': templateBusinessId ? 'Instance ID' : 'Object ID',
    }) as HTMLInputElement
    const nameInput = h('input', {
      class: 'crev-tt-edit-input crev-tt-edit-name',
      name: 'name',
      value: name,
      autocomplete: 'off',
      'aria-label': 'Object name',
    }) as HTMLInputElement
    const templateInput = templateBusinessId
      ? h('input', {
          class: 'crev-tt-edit-input crev-tt-edit-id',
          name: 'templateBusinessId',
          value: templateBusinessId,
          autocomplete: 'off',
          spellcheck: 'false',
          'aria-label': 'Template ID',
        }) as HTMLInputElement
      : null
    const focusIdentityField = (field: IdentityField | undefined): void => {
      const inputByField: Record<IdentityField, HTMLInputElement | null> = {
        businessId: idInput,
        name: nameInput,
        templateBusinessId: templateInput,
      }
      if (field) inputByField[field]?.focus()
    }
    const status = h('div', {
      class: 'crev-tt-edit-status',
      role: 'status',
      'aria-live': 'polite',
    })
    const saveButton = h('button', {
      class: 'crev-tt-open crev-tt-edit-save',
      type: 'button',
      title: 'Save and verify',
      'aria-label': 'Save and verify',
      onClick: (event: Event) => {
        event.preventDefault()
        event.stopPropagation()
        void submitIdentity()
      },
    }, svg(ICON_CHECK)) as HTMLButtonElement
    const discardButton = h('button', {
      class: 'crev-tt-open crev-tt-edit-discard',
      type: 'button',
      title: 'Discard changes',
      'aria-label': 'Discard changes',
      onClick: (event: Event) => {
        event.stopPropagation()
        renderReadMode()
      },
    }, svg(ICON_X)) as HTMLButtonElement

    const setError = (message: string): void => {
      status.className = 'crev-tt-edit-status crev-tt-edit-status--error'
      status.textContent = message
    }
    const submitIdentity = async (): Promise<void> => {
      const validation = normalizeAndValidateIdentity({
        businessId: idInput.value,
        name: nameInput.value,
        ...(templateInput ? { templateBusinessId: templateInput.value } : {}),
      })
      if (!validation.ok) {
        setError(validation.error)
        focusIdentityField(validation.field)
        return
      }
      const {
        businessId: nextId,
        name: nextName,
        templateBusinessId: nextTemplateId,
      } = validation.value
      if (nextId === businessId && nextName === name && nextTemplateId === templateBusinessId) {
        renderReadMode()
        return
      }

      idInput.disabled = true
      nameInput.disabled = true
      if (templateInput) templateInput.disabled = true
      saveButton.disabled = true
      discardButton.disabled = true
      status.className = 'crev-tt-edit-status crev-tt-edit-status--saving'
      status.textContent = 'Saving and verifying\u2026'

      try {
        const result = await actions.onSaveIdentity!(validation.value)
        if (!result.ok) {
          idInput.disabled = false
          nameInput.disabled = false
          if (templateInput) templateInput.disabled = false
          saveButton.disabled = false
          discardButton.disabled = false
          setError(result.error ?? 'Could not verify the saved values.')
          focusIdentityField(result.field)
          return
        }

        businessId = result.businessId ?? nextId
        name = result.name ?? nextName
        templateBusinessId = result.templateBusinessId ?? nextTemplateId ?? templateBusinessId
        status.className = 'crev-tt-edit-status crev-tt-edit-status--success'
        status.replaceChildren(svg(ICON_CHECK), 'Saved and verified')
        setTimeout(renderReadMode, 700)
      } catch {
        idInput.disabled = false
        nameInput.disabled = false
        if (templateInput) templateInput.disabled = false
        saveButton.disabled = false
        discardButton.disabled = false
        setError('Could not save and verify the changes.')
      }
    }
    const handleEditKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        renderReadMode()
        return
      }
      if (event.key === 'Enter' && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
        event.preventDefault()
        event.stopPropagation()
        void submitIdentity()
      }
    }
    idInput.addEventListener('keydown', handleEditKey)
    nameInput.addEventListener('keydown', handleEditKey)
    templateInput?.addEventListener('keydown', handleEditKey)

    actionBar.replaceChildren(saveButton, discardButton)
    nameEl.replaceChildren(nameInput)
    body.replaceChildren(
      ...[
        templateInput
          ? h('div', { class: 'crev-tt-cprow crev-tt-edit-idrow' },
              h('span', { class: 'crev-tt-k' }, 'Template ID'),
              templateInput,
            )
          : null,
      ].filter((row): row is HTMLElement => row !== null),
      h('div', { class: 'crev-tt-cprow crev-tt-edit-idrow' },
        h('span', { class: 'crev-tt-k' }, templateInput ? 'Instance ID' : 'ID'),
        idInput,
      ),
      ...[
        copyRow('RID', data.rid, true),
      ].filter((row): row is HTMLElement => row !== null),
      status,
    )
    nameInput.focus()
    nameInput.select()
  }

  headActions[0]?.classList.contains('crev-tt-edit-open')
    && headActions[0].addEventListener('click', (event) => {
      event.stopPropagation()
      renderEditMode()
    })

  renderReadMode()

  if (data.codePreview) {
    const code = h('pre', { class: 'crev-tt-code' }, data.codePreview)
    card.appendChild(code)
  }
  return card
}
