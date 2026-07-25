import type { InspectorMessage } from '../../lib/types'
import { sendRequestBounded } from '../../lib/messaging'
import {
  inferJsonShape,
  resolveJsonShapePath,
  type JsonShape,
} from '../../lib/json-shape'
import type { JsonLocator } from './json-source'

export type JsonShapeState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; shape: JsonShape }
  | { status: 'error'; error: string }

interface Entry {
  state: JsonShapeState
  inflight?: Promise<JsonShape>
  failedAt?: number
}

const ERROR_RETRY_MS = 30_000

export class JsonShapeStore {
  private entries = new Map<string, Entry>()
  private listeners = new Set<() => void>()

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }

  private key(locator: JsonLocator, objectRid?: string): string {
    const root = locator.root.kind === 'literal'
      ? `literal:${locator.root.text}`
      : `runtime:${objectRid ?? ''}:${locator.root.expression}`
    return root
  }

  private rootEntry(locator: JsonLocator, objectRid?: string): Entry {
    const key = this.key(locator, objectRid)
    let entry = this.entries.get(key)
    if (entry) return entry
    if (locator.root.kind === 'literal') {
      try {
        entry = { state: { status: 'ready', shape: inferJsonShape(locator.root.text) } }
      } catch (error) {
        entry = { state: { status: 'error', error: error instanceof Error ? error.message : 'Invalid JSON' } }
      }
    } else {
      entry = { state: { status: 'idle' } }
    }
    this.entries.set(key, entry)
    return entry
  }

  peek(locator: JsonLocator, objectRid?: string): JsonShapeState {
    const state = this.rootEntry(locator, objectRid).state
    if (state.status !== 'ready') return state
    const shape = resolveJsonShapePath(state.shape, locator.steps)
    return shape
      ? { status: 'ready', shape }
      : { status: 'error', error: 'This path does not exist in the JSON shape' }
  }

  load(locator: JsonLocator, objectRid?: string): Promise<JsonShape> {
    const entry = this.rootEntry(locator, objectRid)
    if (entry.state.status === 'ready') {
      const shape = resolveJsonShapePath(entry.state.shape, locator.steps)
      return shape ? Promise.resolve(shape) : Promise.reject(new Error('This path does not exist in the JSON shape'))
    }
    if (entry.inflight) {
      return entry.inflight.then(shape => {
        const resolved = resolveJsonShapePath(shape, locator.steps)
        if (!resolved) throw new Error('This path does not exist in the JSON shape')
        return resolved
      })
    }
    if (entry.state.status === 'error' && entry.failedAt && Date.now() - entry.failedAt < ERROR_RETRY_MS) {
      return Promise.reject(new Error(entry.state.error))
    }
    if (locator.root.kind === 'literal') {
      return Promise.reject(new Error(entry.state.status === 'error' ? entry.state.error : 'Invalid JSON'))
    }

    entry.state = { status: 'loading' }
    this.notify()
    const source = locator.root.expression
    entry.inflight = sendRequestBounded<InspectorMessage>(
      { type: 'JSON_SHAPE_READ', source, objectRid },
      { timeoutMs: 10_000 },
    ).then(response => {
      if (response.type !== 'JSON_SHAPE_RESULT' || !response.ok || !response.shape) {
        throw new Error(response.type === 'JSON_SHAPE_RESULT' ? response.error ?? 'Could not inspect JSON' : 'Unexpected response')
      }
      entry.state = { status: 'ready', shape: response.shape }
      return response.shape
    }).catch(error => {
      entry.state = { status: 'error', error: error instanceof Error ? error.message : 'Could not inspect JSON' }
      entry.failedAt = Date.now()
      throw error
    }).finally(() => {
      entry.inflight = undefined
      this.notify()
    })

    return entry.inflight.then(shape => {
      const resolved = resolveJsonShapePath(shape, locator.steps)
      if (!resolved) throw new Error('This path does not exist in the JSON shape')
      return resolved
    })
  }

  refresh(locator: JsonLocator, objectRid?: string): Promise<JsonShape> {
    this.entries.delete(this.key(locator, objectRid))
    this.notify()
    return this.load(locator, objectRid)
  }

  clear(): void {
    if (this.entries.size === 0) return
    this.entries.clear()
    this.notify()
  }
}

export const jsonShapeStore = new JsonShapeStore()
