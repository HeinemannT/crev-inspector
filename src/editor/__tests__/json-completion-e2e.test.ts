/**
 * @vitest-environment happy-dom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EditorState } from '@codemirror/state'
import { CompletionContext } from '@codemirror/autocomplete'
import { jsonCompletions, setJsonCompletionContext } from '../ec/jsonCompletions'
import { jsonShapeStore } from '../ec/json-shape-store'
import * as inference from '../ec/typeInference'

const doc = (text: string) => ({
  lines: text.split('\n').length,
  line: (line: number) => ({ text: text.split('\n')[line - 1] }),
})

async function complete(text: string) {
  const state = EditorState.create({ doc: text })
  const result = await jsonCompletions(new CompletionContext(state, text.length, false))
  return result?.options.map(option => `${option.label}:${option.detail}`) ?? null
}

beforeEach(() => {
  inference._resetForTests()
  jsonShapeStore.clear()
  setJsonCompletionContext('9001')
  ;(globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: {
      sendMessage: vi.fn(() => Promise.resolve({
        type: 'JSON_SHAPE_RESULT',
        ok: true,
        shape: {
          kind: 'object',
          truncated: false,
          fields: [
            { key: 'name', optional: false, shape: { kind: 'string' } },
            {
              key: 'rows',
              optional: false,
              shape: {
                kind: 'array',
                sampled: 1,
                truncated: false,
                element: {
                  kind: 'object',
                  truncated: false,
                  fields: [
                    { key: 'id', optional: false, shape: { kind: 'number' } },
                    { key: 'display name', optional: true, shape: { kind: 'string' } },
                  ],
                },
              },
            },
          ],
        },
      })),
    },
  }
})

describe('JSON property completion', () => {
  it('completes raw JSON synchronously, including nested arrays', async () => {
    inference.scanDocForInferences(doc(`_cfg := JSON('{"rows":[{"id":1,"name":"A"}]}')`))
    expect(await complete('_cfg.')).toEqual(['rows:array<object>'])
    expect(await complete('_cfg.rows.first().')).toEqual(['id:number', 'name:string'])
  })

  it('reads a property-backed root once and shares the cached shape', async () => {
    inference.scanDocForInferences(doc('_cfg := JSON(this.object.description)'))
    expect(await complete('_cfg.')).toEqual(['name:string', 'rows:array<object>'])
    expect(await complete('_cfg.rows.first().')).toEqual(['id:number'])
    expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(1)
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'JSON_SHAPE_READ',
      source: 'this.object.description',
      objectRid: '9001',
    })
  })

  it('does not offer keys that cannot be written with EC dot access', async () => {
    inference.scanDocForInferences(doc('_cfg := JSON(this.object.description)'))
    expect(await complete('_cfg.rows.first().')).not.toContain('display name:string?')
  })

  it('is silent for BMP and unknown variables', async () => {
    inference.scanDocForInferences(doc('_rows := SELECT CeIssue'))
    expect(await complete('_rows.')).toBeNull()
    expect(await complete('_missing.')).toBeNull()
  })
})
