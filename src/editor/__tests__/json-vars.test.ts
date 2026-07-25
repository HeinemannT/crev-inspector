/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it, vi } from 'vitest'
import { renderJsonVars } from '../json-vars'
import type { JsonLocator } from '../ec/json-source'

describe('JSON Vars pane', () => {
  it('renders a compact expandable tree and inserts valid keys only', () => {
    const locator: JsonLocator = {
      root: {
        kind: 'literal',
        text: '{"user":{"name":"A","display name":"B"},"rows":[{"id":1}]}',
      },
      steps: [],
    }
    const insert = vi.fn()
    const rerender = vi.fn()
    const pane = renderJsonVars({ name: '_cfg', locator, insert, rerender })
    document.body.append(pane)

    expect(pane.textContent).toContain('Inline JSON')
    expect(pane.textContent).toContain('user')
    expect(pane.textContent).toContain('rows')
    expect(pane.textContent).not.toContain('display name')

    const userRow = Array.from(pane.querySelectorAll<HTMLElement>('.editor-json-row'))
      .find(row => row.textContent?.includes('user'))!
    userRow.querySelector<HTMLButtonElement>('.editor-json-expand')!.click()
    expect(rerender).toHaveBeenCalledOnce()

    // Render again after expansion; nested valid and invalid keys are visible.
    const expandedPane = renderJsonVars({ name: '_cfg', locator, insert, rerender })
    const rows = Array.from(expandedPane.querySelectorAll<HTMLElement>('.editor-json-row'))
    const name = rows.find(row => row.textContent?.includes('name'))!
    const invalid = rows.find(row => row.textContent?.includes('display name'))!
    name.click()
    invalid.click()
    expect(insert).toHaveBeenCalledWith('name')
    expect(insert).toHaveBeenCalledTimes(1)
  })

  it('describes a derived scalar without calling it an empty object', () => {
    const pane = renderJsonVars({
      name: '_name',
      locator: {
        root: { kind: 'literal', text: '{"user":{"name":"A"}}' },
        steps: [{ kind: 'property', key: 'user' }, { kind: 'property', key: 'name' }],
      },
      insert: vi.fn(),
      rerender: vi.fn(),
    })
    expect(pane.textContent).toContain('string: JSON value, no nested properties.')
    expect(pane.textContent).not.toContain('Empty string')
  })
})
