/**
 * @vitest-environment happy-dom
 *
 * Verifies the CVO sandbox render core — the riskiest novel logic in the
 * studio keystone: reproducing BMP's `_data` contract, running arbitrary CVO
 * javascript, surfacing thrown errors (the silent-blank-widget failure), and
 * tearing down between runs. The postMessage shell around it is thin; this
 * locks the behaviour the studio depends on.
 */
import { describe, it, expect, vi } from 'vitest'
import { runCvo, freshRoot, injectLibs, installConsoleCapture, type RenderRequest } from '../sandbox'
import type { CvoSandboxOutbound as OutboundMessage } from '../cvo-protocol'

function req(over: Partial<RenderRequest>): RenderRequest {
  return { type: 'CVO_RENDER', runId: 1, html: '', javascript: '', data: {}, ...over }
}

describe('runCvo', () => {
  it('injects html into the container', () => {
    const root = document.createElement('div')
    const emit = vi.fn()
    runCvo(root, req({ html: '<button id="b">Hi</button>' }), emit)
    expect(root.querySelector('#b')?.textContent).toBe('Hi')
  })

  it('runs javascript with _data in scope, reaching _data.element and _data.context', () => {
    const root = document.createElement('div')
    const emit = vi.fn<(m: OutboundMessage) => void>()
    runCvo(root, req({
      html: '<p id="out"></p>',
      javascript: `_data.element.querySelector('#out').textContent = _data.context.orgid`,
      data: { context: { orgid: 'org_demo' } },
    }), emit)
    expect(root.querySelector('#out')?.textContent).toBe('org_demo')
  })

  it('wires DOM events the CVO registers (interactive CVO)', () => {
    const root = document.createElement('div')
    runCvo(root, req({
      html: '<button id="b">x</button><p id="out" style="display:none"></p>',
      javascript: `var b=_data.element.querySelector('#b'); b.addEventListener('click',function(){_data.element.querySelector('#out').style.display='block';});`,
    }), vi.fn())
    const out = root.querySelector('#out') as HTMLElement
    expect(out.style.display).toBe('none')
    ;(root.querySelector('#b') as HTMLElement).click()
    expect(out.style.display).toBe('block')
  })

  it('emits CVO_RENDERED ok:true on success', () => {
    const msgs: OutboundMessage[] = []
    runCvo(document.createElement('div'), req({ runId: 7, javascript: 'var x = 1' }), m => msgs.push(m))
    expect(msgs).toContainEqual({ type: 'CVO_RENDERED', runId: 7, ok: true })
  })

  it('surfaces a thrown CVO as CVO_ERROR + CVO_RENDERED ok:false (and stops)', () => {
    const msgs: OutboundMessage[] = []
    runCvo(document.createElement('div'), req({ runId: 3, javascript: `throw new Error('boom')` }), m => msgs.push(m))
    const err = msgs.find(m => m.type === 'CVO_ERROR')
    expect(err).toBeTruthy()
    expect(err && 'message' in err && err.message).toBe('boom')
    expect(msgs).toContainEqual({ type: 'CVO_RENDERED', runId: 3, ok: false })
    expect(msgs.some(m => m.type === 'CVO_RENDERED' && m.ok === true)).toBe(false)
  })

  it('skips the js step cleanly when javascript is blank', () => {
    const msgs: OutboundMessage[] = []
    runCvo(document.createElement('div'), req({ runId: 5, html: '<div>static</div>', javascript: '   ' }), m => msgs.push(m))
    expect(msgs).toEqual([{ type: 'CVO_RENDERED', runId: 5, ok: true }])
  })
})

describe('freshRoot', () => {
  it('replaces the previous #cvo-root so a re-run starts clean', () => {
    const a = freshRoot(document)
    a.dataset.wired = '1'
    a.innerHTML = '<span>old</span>'
    const b = freshRoot(document)
    expect(b).not.toBe(a)
    expect(b.dataset.wired).toBeUndefined()
    expect(b.innerHTML).toBe('')
    // Only one #cvo-root exists after teardown.
    expect(document.querySelectorAll('#cvo-root').length).toBe(1)
    expect(document.getElementById('cvo-root')).toBe(b)
  })
})

describe('injectLibs', () => {
  it('appends each lib as a tagged <script> in document order', () => {
    document.head.innerHTML = ''
    injectLibs(document, ['window.__A = 1', 'window.__B = 2'])
    const scripts = document.head.querySelectorAll('script[data-cvo-lib]')
    expect(scripts.length).toBe(2)
    expect(scripts[0].textContent).toBe('window.__A = 1')
    expect(scripts[1].textContent).toBe('window.__B = 2')
  })

  it('no-ops on an empty lib list', () => {
    document.head.innerHTML = ''
    injectLibs(document, [])
    expect(document.head.querySelectorAll('script[data-cvo-lib]').length).toBe(0)
  })
})

describe('installConsoleCapture', () => {
  it('forwards console.log/warn to emit tagged with the live runId, then restores', () => {
    const msgs: OutboundMessage[] = []
    let runId = 42
    const restore = installConsoleCapture(m => msgs.push(m), () => runId)
    console.log('hello', 1)
    console.warn('careful')
    runId = 43
    console.error('later')
    restore()
    console.log('after restore — not captured')

    expect(msgs).toEqual([
      { type: 'CVO_CONSOLE', runId: 42, level: 'log', text: 'hello 1' },
      { type: 'CVO_CONSOLE', runId: 42, level: 'warn', text: 'careful' },
      { type: 'CVO_CONSOLE', runId: 43, level: 'error', text: 'later' },
    ])
  })
})
