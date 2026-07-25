export const JSON_SHAPE_MAX_BYTES = 512 * 1024
export const JSON_SHAPE_MAX_DEPTH = 16
export const JSON_SHAPE_MAX_NODES = 2_000
export const JSON_SHAPE_MAX_ARRAY_ITEMS = 100

export type JsonScalarKind = 'string' | 'number' | 'boolean' | 'null' | 'mixed' | 'unknown'

export type JsonShape =
  | { kind: 'object'; fields: JsonField[]; truncated: boolean }
  | { kind: 'array'; element: JsonShape; sampled: number; truncated: boolean }
  | { kind: JsonScalarKind }

export interface JsonField {
  key: string
  shape: JsonShape
  optional: boolean
}

export class JsonShapeError extends Error {
  constructor(
    message: string,
    readonly code: 'too-large' | 'invalid' | 'unsupported-root',
  ) {
    super(message)
    this.name = 'JsonShapeError'
  }
}

interface Budget {
  nodes: number
  truncated: boolean
}

const unknown = (): JsonShape => ({ kind: 'unknown' })

function consume(budget: Budget): boolean {
  budget.nodes++
  if (budget.nodes <= JSON_SHAPE_MAX_NODES) return true
  budget.truncated = true
  return false
}

function inferValue(value: unknown, depth: number, budget: Budget): JsonShape {
  if (!consume(budget) || depth > JSON_SHAPE_MAX_DEPTH) {
    budget.truncated = true
    return unknown()
  }
  if (value === null) return { kind: 'null' }
  if (Array.isArray(value)) {
    const sampledValues = value.slice(0, JSON_SHAPE_MAX_ARRAY_ITEMS)
    let element: JsonShape = unknown()
    let sampled = 0
    for (let i = 0; i < sampledValues.length; i++) {
      const next = inferValue(sampledValues[i], depth + 1, budget)
      element = i === 0 ? next : mergeShapes(element, next, budget, depth + 1)
      sampled++
      if (budget.nodes > JSON_SHAPE_MAX_NODES) break
    }
    const truncated = value.length > sampledValues.length || budget.truncated
    return { kind: 'array', element, sampled, truncated }
  }
  if (typeof value === 'object') {
    const fields: JsonField[] = []
    for (const [key, fieldValue] of Object.entries(value as Record<string, unknown>)) {
      if (budget.nodes > JSON_SHAPE_MAX_NODES) {
        budget.truncated = true
        break
      }
      fields.push({ key, shape: inferValue(fieldValue, depth + 1, budget), optional: false })
    }
    return { kind: 'object', fields, truncated: budget.truncated }
  }
  if (typeof value === 'string') return { kind: 'string' }
  if (typeof value === 'number') return { kind: 'number' }
  if (typeof value === 'boolean') return { kind: 'boolean' }
  return unknown()
}

function mergeObjects(
  left: Extract<JsonShape, { kind: 'object' }>,
  right: Extract<JsonShape, { kind: 'object' }>,
  budget: Budget,
  depth: number,
): JsonShape {
  const rightByKey = new Map(right.fields.map(field => [field.key, field]))
  const leftKeys = new Set(left.fields.map(field => field.key))
  const fields: JsonField[] = left.fields.map(field => {
    const other = rightByKey.get(field.key)
    return {
      key: field.key,
      shape: other ? mergeShapes(field.shape, other.shape, budget, depth + 1) : field.shape,
      optional: field.optional || !other || Boolean(other?.optional),
    }
  })
  for (const field of right.fields) {
    if (!leftKeys.has(field.key)) fields.push({ ...field, optional: true })
  }
  return {
    kind: 'object',
    fields,
    truncated: left.truncated || right.truncated || budget.truncated,
  }
}

function mergeShapes(left: JsonShape, right: JsonShape, budget: Budget, depth: number): JsonShape {
  if (left.kind === 'unknown') return right
  if (right.kind === 'unknown') return left
  if (left.kind !== right.kind) return { kind: 'mixed' }
  if (left.kind === 'object' && right.kind === 'object') {
    return mergeObjects(left, right, budget, depth)
  }
  if (left.kind === 'array' && right.kind === 'array') {
    return {
      kind: 'array',
      element: mergeShapes(left.element, right.element, budget, depth + 1),
      sampled: left.sampled + right.sampled,
      truncated: left.truncated || right.truncated || budget.truncated,
    }
  }
  return left
}

/** Parse JSON and retain only its bounded structural shape. Scalar values are
 * deliberately discarded: consumers need authoring metadata, not a second
 * copy of potentially sensitive configuration data. */
export function inferJsonShape(text: string): JsonShape {
  if (new TextEncoder().encode(text).byteLength > JSON_SHAPE_MAX_BYTES) {
    throw new JsonShapeError('JSON is too large to inspect safely', 'too-large')
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new JsonShapeError('Invalid JSON', 'invalid')
  }
  if (value === null || (typeof value !== 'object')) {
    throw new JsonShapeError('EC JSON() requires an object or array', 'unsupported-root')
  }
  return inferValue(value, 0, { nodes: 0, truncated: false })
}

export function jsonShapeLabel(shape: JsonShape): string {
  if (shape.kind === 'array') return `array<${jsonShapeLabel(shape.element)}>`
  return shape.kind
}

export function resolveJsonShapePath(shape: JsonShape, steps: readonly JsonShapeStep[]): JsonShape | null {
  let current: JsonShape = shape
  for (const step of steps) {
    if (step.kind === 'element') {
      if (current.kind !== 'array') return null
      current = current.element
    } else {
      if (current.kind !== 'object') return null
      const field = current.fields.find(candidate => candidate.key === step.key)
      if (!field) return null
      current = field.shape
    }
  }
  return current
}

export type JsonShapeStep =
  | { kind: 'property'; key: string }
  | { kind: 'element' }
