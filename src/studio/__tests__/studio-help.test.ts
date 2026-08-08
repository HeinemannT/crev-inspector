/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it } from 'vitest'
import { showStudioHelp } from '../studio-help'
import { STUDIO_MODES } from '../studio-mode'

afterEach(() => document.body.replaceChildren())

describe('studio quick reference', () => {
  it('explains TextElement sanitization and points executable content to CVOs', () => {
    const anchor = document.createElement('button')
    document.body.appendChild(anchor)

    showStudioHelp(anchor, 'Ctrl', STUDIO_MODES.text)

    const help = document.getElementById('studio-help-popover')
    expect(help?.textContent).toContain('Text studio: quick reference')
    expect(help?.textContent).toContain('text + longText')

    const contentTab = [...help!.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
      .find(button => button.textContent === 'Content')!
    contentTab.click()

    expect(help?.textContent).toContain('scripts and event handlers are removed by BMP')
    expect(help?.textContent).toContain('Use a Custom Visualization')
    expect(help?.textContent).not.toContain('Mock / Live')
  })

  it('keeps the CVO-specific data guidance in CVO mode', () => {
    const anchor = document.createElement('button')
    document.body.appendChild(anchor)

    showStudioHelp(anchor, 'Ctrl', STUDIO_MODES.cvo)

    const help = document.getElementById('studio-help-popover')
    expect(help?.textContent).toContain('CVO studio: quick reference')
    const dataTab = [...help!.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
      .find(button => button.textContent === 'Data')!
    dataTab.click()
    expect(help?.textContent).toContain('Mock / Live')
  })
})
