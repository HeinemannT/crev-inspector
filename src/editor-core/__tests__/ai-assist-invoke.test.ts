/**
 * @vitest-environment happy-dom
 *
 * The verb-at-send invoke bar (ai-assist.ts createAiAssist + shared content):
 *   - pickShell: inline needs a visible view, else the floating fallback.
 *   - verb routing: Enter → Ask handoff (AI_CHAT_HANDOFF), Ctrl+Enter → Edit
 *     request (AI_REQUEST). Both go through the SHARED buildBarContent, so the
 *     floating shell (what happy-dom resolves to, since offsetParent is null)
 *     exercises the same code path the inline widget uses.
 *   - Esc closes the bar and restores the selection captured at open.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the messaging + config boundaries so no chrome runtime is needed.
vi.mock('../../lib/messaging', () => ({ sendFireForget: vi.fn(), sendRequest: vi.fn() }))
vi.mock('../ai-config', () => ({ fetchAiConfig: vi.fn(async () => ({ configured: true, model: 'test-model' })) }))

import { sendFireForget } from '../../lib/messaging'
import { createAiAssist, pickShell, type AiAssistHost } from '../ai-assist'
import { CodeSurface } from '../code-surface'

// Minimal chrome shim — createAiAssist registers a runtime message listener.
;(globalThis as unknown as { chrome: unknown }).chrome = {
  runtime: { onMessage: { addListener: vi.fn() } },
}

function mountSurface(doc: string): CodeSurface {
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  const surface = new CodeSurface(() => parent, { buildExtensions: () => [] })
  surface.setSlots([{ key: 'ec', lang: 'ec', code: doc }])
  surface.activate('ec')
  return surface
}

function makeHost(surface: CodeSurface): AiAssistHost {
  const anchor = document.createElement('button')
  document.body.appendChild(anchor)
  return {
    surface: () => surface,
    lang: () => 'extended',
    context: () => ({}),
    anchorEl: () => anchor,
    contextSource: () => null,
  }
}

const barInput = (): HTMLInputElement => {
  const el = document.querySelector<HTMLInputElement>('.ai-inbar-input')
  if (!el) throw new Error('bar input not found')
  return el
}

describe('pickShell', () => {
  it('uses the inline shell only for a visible view', () => {
    expect(pickShell({ hasView: true, viewVisible: true })).toBe('inline')
    expect(pickShell({ hasView: true, viewVisible: false })).toBe('floating')
    expect(pickShell({ hasView: false, viewVisible: false })).toBe('floating')
  })
  it('falls back to the floating strip when the pane is too narrow (split view)', () => {
    expect(pickShell({ hasView: true, viewVisible: true, narrow: true })).toBe('floating')
    expect(pickShell({ hasView: true, viewVisible: true, narrow: false })).toBe('inline')
  })
})

describe('verb routing', () => {
  beforeEach(() => {
    vi.mocked(sendFireForget).mockClear()
    document.body.innerHTML = ''
  })

  it('Enter sends an Ask handoff', () => {
    const surface = mountSurface('output(t.x.name)')
    const assist = createAiAssist(makeHost(surface))
    assist.open()
    const input = barInput()
    input.value = 'what does this do?'
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))

    const calls = vi.mocked(sendFireForget).mock.calls.map(c => c[0])
    const handoff = calls.find(m => m.type === 'AI_CHAT_HANDOFF')
    expect(handoff).toBeTruthy()
    expect((handoff as { text: string }).text).toBe('what does this do?')
    // Bar closed after send.
    expect(document.querySelector('.ai-inbar-input')).toBeNull()
  })

  it('Ctrl+Enter sends an Edit request', () => {
    const surface = mountSurface('output(t.x.name)')
    const assist = createAiAssist(makeHost(surface))
    assist.open()
    const input = barInput()
    input.value = 'wrap it in an IF'
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }))

    const calls = vi.mocked(sendFireForget).mock.calls.map(c => c[0])
    const req = calls.find(m => m.type === 'AI_REQUEST')
    expect(req).toBeTruthy()
    expect((req as { payload: { intent: string; instruction: string } }).payload.intent).toBe('edit')
    expect((req as { payload: { instruction: string } }).payload.instruction).toBe('wrap it in an IF')
  })

  it('empty input does not send', () => {
    const surface = mountSurface('code')
    const assist = createAiAssist(makeHost(surface))
    assist.open()
    barInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(vi.mocked(sendFireForget).mock.calls.length).toBe(0)
  })
})

describe('Esc restores the selection', () => {
  beforeEach(() => { document.body.innerHTML = '' })

  it('re-selects the range captured at open and closes the bar', async () => {
    const surface = mountSurface('aaaa\nbbbb\ncccc')
    // Focusing the bar input blurs the editor in a real browser; happy-dom
    // doesn't cascade that, so blur explicitly to mirror the live focus state
    // (a non-empty selection dispatched while CM thinks it's focused re-enters
    // the update in happy-dom only — a headless artifact, not a code bug).
    const blur = () => surface.view!.contentDOM.blur()
    blur()
    // Select "bbbb" (positions 5..9).
    surface.dispatch({ selection: { anchor: 5, head: 9 } })
    const assist = createAiAssist(makeHost(surface))
    assist.open()
    // Move the selection while the bar is open.
    blur()
    surface.dispatch({ selection: { anchor: 0, head: 0 } })
    blur()
    barInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

    // Bar closes synchronously; selection is restored on the next frame.
    expect(document.querySelector('.ai-inbar-input')).toBeNull()
    await new Promise<void>(r => requestAnimationFrame(() => r()))
    const sel = surface.view!.state.selection.main
    expect(sel.from).toBe(5)
    expect(sel.to).toBe(9)
  })
})
