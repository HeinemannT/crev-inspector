/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { showStudioPanelHelp } from '../studio-help'

afterEach(() => {
  vi.useRealTimers()
  document.body.replaceChildren()
})

describe('studio panel help', () => {
  it('explains Inputs, Deps, persistence, file hosting, and network constraints', () => {
    const anchor = document.createElement('button')
    document.body.appendChild(anchor)

    showStudioPanelHelp(anchor)

    const help = document.getElementById('studio-panel-help-popover')
    expect(help?.textContent).toContain('Inputs are child objects of this CVO')
    expect(help?.textContent).toContain('Add, Save, and Remove update')
    expect(help?.textContent).toContain('Mock values affect only your local preview')
    expect(help?.textContent).toContain('Host resource opens a local file picker')
    expect(help?.textContent).toContain('Resources > CREV Studio Assets')
    expect(help?.textContent).toContain('air-gapped or restricted environments')
    expect(anchor.getAttribute('aria-expanded')).toBe('true')
  })

  it('closes on Escape, restores focus, and resets expanded state', () => {
    vi.useFakeTimers()
    const anchor = document.createElement('button')
    document.body.appendChild(anchor)
    showStudioPanelHelp(anchor)
    vi.runAllTimers()

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))

    expect(document.getElementById('studio-panel-help-popover')).toBeNull()
    expect(anchor.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(anchor)
  })
})
