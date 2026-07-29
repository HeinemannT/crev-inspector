// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest'
import { buildObjectCard } from '../object-card'

function editableCard(onSave = vi.fn(async (identity: { businessId: string; name: string; templateBusinessId?: string }) => ({
  ok: true,
  ...identity,
}))) {
  return {
    card: buildObjectCard({
      businessId: 'old_id',
      name: 'Old name',
      templateBusinessId: 'old_template',
      type: 'Label',
      rid: '9007199254740993',
      color: '#8a3ffc',
    }, { onSaveIdentity: onSave }),
    onSave,
  }
}

describe('object card identity editor', () => {
  it('opens from the pencil and discards with Escape', () => {
    const { card, onSave } = editableCard()
    card.querySelector<HTMLButtonElement>('.crev-tt-edit-open')!.click()

    const id = card.querySelector<HTMLInputElement>('input[name="businessId"]')!
    id.value = 'changed_id'
    id.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

    expect(card.querySelector('input[name="businessId"]')).toBeNull()
    expect(card.textContent).toContain('old_id')
    expect(onSave).not.toHaveBeenCalled()
  })

  it('edits the existing title and ID row in place', () => {
    const { card } = editableCard()
    card.querySelector<HTMLButtonElement>('.crev-tt-edit-open')!.click()

    expect(card.querySelector('.crev-tt-nm > input[name="name"]')).not.toBeNull()
    expect(card.querySelector('.crev-tt-edit-idrow > input[name="businessId"]')).not.toBeNull()
    expect(card.querySelector('.crev-tt-edit-idrow > input[name="templateBusinessId"]')).not.toBeNull()
    expect(card.querySelector('.crev-tt-body input[name="name"]')).toBeNull()
    expect(card.querySelectorAll('.crev-tt-edit-idrow')).toHaveLength(2)
  })

  it('saves on Enter and shows verified inline feedback', async () => {
    const { card, onSave } = editableCard()
    card.querySelector<HTMLButtonElement>('.crev-tt-edit-open')!.click()

    const id = card.querySelector<HTMLInputElement>('input[name="businessId"]')!
    const name = card.querySelector<HTMLInputElement>('input[name="name"]')!
    const template = card.querySelector<HTMLInputElement>('input[name="templateBusinessId"]')!
    id.value = 'new_id'
    name.value = 'New name'
    template.value = 'new_template'
    name.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    }))
    await Promise.resolve()

    expect(onSave).toHaveBeenCalledWith({
      businessId: 'new_id',
      name: 'New name',
      templateBusinessId: 'new_template',
    })
    expect(card.querySelector('.crev-tt-edit-status--success')?.textContent).toContain('Saved and verified')
  })

  it('keeps invalid IDs in the card with quiet inline validation', () => {
    const { card, onSave } = editableCard()
    card.querySelector<HTMLButtonElement>('.crev-tt-edit-open')!.click()
    card.querySelector<HTMLInputElement>('input[name="businessId"]')!.value = 'bad id'
    card.querySelector<HTMLButtonElement>('.crev-tt-edit-save')!.click()

    expect(card.querySelector('.crev-tt-edit-status--error')?.textContent).toContain('letters, numbers, and underscores')
    expect(onSave).not.toHaveBeenCalled()
  })

  it('validates the template ID in place', () => {
    const { card, onSave } = editableCard()
    card.querySelector<HTMLButtonElement>('.crev-tt-edit-open')!.click()
    card.querySelector<HTMLInputElement>('input[name="templateBusinessId"]')!.value = 'bad template'
    card.querySelector<HTMLButtonElement>('.crev-tt-edit-save')!.click()

    expect(card.querySelector('.crev-tt-edit-status--error')?.textContent).toContain('template ID')
    expect(onSave).not.toHaveBeenCalled()
  })

  it('focuses a field-addressable verification error returned by the service worker', async () => {
    const onSave = vi.fn(async (identity: { businessId: string; name: string; templateBusinessId?: string }) => ({
      ok: false,
      field: 'templateBusinessId' as const,
      error: 'Template ID is already in use.',
      ...identity,
    }))
    const { card } = editableCard(onSave)
    document.body.appendChild(card)
    card.querySelector<HTMLButtonElement>('.crev-tt-edit-open')!.click()
    card.querySelector<HTMLInputElement>('input[name="templateBusinessId"]')!.value = 'duplicate_template'
    card.querySelector<HTMLButtonElement>('.crev-tt-edit-save')!.click()
    await Promise.resolve()

    expect(document.activeElement).toBe(card.querySelector('input[name="templateBusinessId"]'))
    expect(card.querySelector('.crev-tt-edit-status--error')?.textContent).toContain('already in use')
    card.remove()
  })
})
