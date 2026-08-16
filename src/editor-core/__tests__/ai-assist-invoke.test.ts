/**
 * @vitest-environment happy-dom
 *
 * The compact mouse-first prompt (ai-assist.ts):
 *   - Enter follows the primary Suggest change action.
 *   - Ask in sidebar is an explicit, clickable handoff.
 *   - selection-local Ask AI is dormant; toolbar/Mod+K remain the entry points.
 *   - resize observation keeps the prompt attached in a resizable overlay or
 *     Studio code/HTML-preview split.
 *   - Esc closes the bar and restores the selection captured at open.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the messaging + config boundaries so no chrome runtime is needed.
vi.mock('../../lib/messaging', () => ({ sendFireForget: vi.fn(), sendRequest: vi.fn() }))
vi.mock('../ai-config', () => ({ fetchAiConfig: vi.fn(async () => ({ configured: true, model: 'test-model' })) }))

import { sendFireForget } from '../../lib/messaging'
import { createAiAssist, type AiAssistHost } from '../ai-assist'
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

describe('verb routing', () => {
  beforeEach(() => {
    vi.mocked(sendFireForget).mockClear()
    document.body.innerHTML = ''
  })

  it('Enter follows the primary Suggest change action', () => {
    const surface = mountSurface('output(t.x.name)')
    const assist = createAiAssist(makeHost(surface))
    assist.open()
    const input = barInput()
    input.value = 'wrap it in an IF'
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))

    const calls = vi.mocked(sendFireForget).mock.calls.map(c => c[0])
    const req = calls.find(m => m.type === 'AI_REQUEST')
    expect(req).toBeTruthy()
    expect((req as { payload: { instruction: string } }).payload.instruction).toBe('wrap it in an IF')
    expect(document.querySelector('.ai-inbar-input')).toBeNull()
  })

  it('labels and sends the sidebar handoff explicitly', () => {
    const surface = mountSurface('output(t.x.name)')
    const assist = createAiAssist(makeHost(surface))
    assist.open()
    const input = barInput()
    input.value = 'what does this do?'
    const ask = [...document.querySelectorAll<HTMLButtonElement>('.ai-action')]
      .find(button => button.textContent === 'Ask in sidebar')
    expect(ask).toBeTruthy()
    ask!.click()

    const calls = vi.mocked(sendFireForget).mock.calls.map(c => c[0])
    const handoff = calls.find(m => m.type === 'AI_CHAT_HANDOFF')
    expect(handoff).toBeTruthy()
    expect((handoff as { text: string }).text).toBe('what does this do?')
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

describe('mouse and resize behavior', () => {
  beforeEach(() => {
    vi.mocked(sendFireForget).mockClear()
    document.body.innerHTML = ''
  })

  it('keeps the selection popup dormant while toolbar invocation retains scope', async () => {
    const surface = mountSurface('aaaa\nbbbb\ncccc')
    const view = surface.view!
    Object.defineProperty(view.dom, 'offsetParent', { configurable: true, value: document.body })
    vi.spyOn(view.dom, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, right: 600, bottom: 400, width: 600, height: 400,
      toJSON: () => ({}),
    } as DOMRect)
    vi.spyOn(view, 'coordsAtPos').mockReturnValue({
      x: 180, y: 80, left: 180, top: 80, right: 180, bottom: 98, width: 0, height: 18,
      toJSON: () => ({}),
    } as DOMRect)
    // happy-dom does not naturally mirror the editor blur that precedes a
    // settled browser selection; avoid its CodeMirror-only re-entrant update.
    view.contentDOM.blur()
    surface.dispatch({ selection: { anchor: 5, head: 9 } })
    const assist = createAiAssist(makeHost(surface))
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))

    expect(document.querySelector('.ai-selection-trigger')).toBeNull()
    assist.open()
    expect(document.querySelector('.ai-prompt-scope')?.textContent).toBe('Line 2 selected')
  })

  it('repositions after editor-pane resize and disconnects on close', async () => {
    const observed: Element[] = []
    const disconnect = vi.fn()
    let resizeCallback!: ResizeObserverCallback
    class TestResizeObserver {
      constructor(readonly callback: ResizeObserverCallback) { resizeCallback = callback }
      observe(element: Element): void { observed.push(element) }
      disconnect(): void { disconnect() }
      unobserve(): void {}
    }
    vi.stubGlobal('ResizeObserver', TestResizeObserver)
    Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 800 })
    Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, value: 600 })
    const surface = mountSurface('code')
    const anchor = document.createElement('button')
    document.body.appendChild(anchor)
    let anchorRight = 120
    vi.spyOn(anchor, 'getBoundingClientRect').mockImplementation(() => ({
      x: anchorRight - 20, y: 40, left: anchorRight - 20, top: 40,
      right: anchorRight, bottom: 60, width: 20, height: 20, toJSON: () => ({}),
    } as DOMRect))
    const assist = createAiAssist({ ...makeHost(surface), anchorEl: () => anchor })
    assist.open()
    expect(observed).toContain(surface.view!.scrollDOM)
    const prompt = document.querySelector<HTMLElement>('.ai-strip')!
    Object.defineProperty(prompt, 'offsetWidth', { configurable: true, value: 200 })
    Object.defineProperty(prompt, 'offsetHeight', { configurable: true, value: 80 })
    anchorRight = 400
    resizeCallback([], {} as ResizeObserver)
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
    expect(prompt.style.left).toBe('200px')
    expect(prompt.style.top).toBe('66px')
    assist.close()
    expect(disconnect).toHaveBeenCalled()
    vi.unstubAllGlobals()
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
