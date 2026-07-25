import { h, svg } from '../lib/dom'
import { ICON_CHEVRON, ICON_REFRESH } from '../lib/icons'
import { jsonShapeLabel, type JsonShape } from '../lib/json-shape'
import type { JsonLocator } from './ec/json-source'
import { jsonShapeStore } from './ec/json-shape-store'

const expanded = new Set<string>()

interface JsonVarsOptions {
  name: string
  locator: JsonLocator
  objectRid?: string
  insert: (text: string) => void
  rerender: () => void
}

const validAccessor = (key: string): boolean => /^[A-Za-z_]\w*$/.test(key)

function shapeRows(
  shape: JsonShape,
  path: string,
  depth: number,
  options: JsonVarsOptions,
): HTMLElement[] {
  if (shape.kind === 'object') {
    return shape.fields.map(field => {
      const fieldPath = path ? `${path}.${field.key}` : field.key
      const nested = field.shape.kind === 'object' || field.shape.kind === 'array'
      const open = expanded.has(fieldPath)
      const insertable = validAccessor(field.key)
      const row = h('div', {
        class: `editor-json-row${insertable ? '' : ' editor-json-row--invalid'}`,
        style: `padding-left:${8 + depth * 14}px`,
        title: insertable
          ? `Insert ${field.key}`
          : 'This key cannot be accessed with EC dot notation',
        onClick: () => { if (insertable) options.insert(field.key) },
      },
        nested
          ? h('button', {
              class: `editor-json-expand${open ? ' expanded' : ''}`,
              title: open ? 'Collapse' : 'Expand',
              onClick: (event: Event) => {
                event.stopPropagation()
                if (open) expanded.delete(fieldPath)
                else expanded.add(fieldPath)
                options.rerender()
              },
            }, svg(ICON_CHEVRON))
          : h('span', { class: 'editor-json-expand-spacer' }),
        h('span', { class: 'editor-json-key' }, field.key, field.optional ? '?' : ''),
        h('span', { class: 'editor-json-kind' }, jsonShapeLabel(field.shape)),
      )
      return open && nested
        ? h('div', { class: 'editor-json-group' }, row, ...shapeRows(field.shape, fieldPath, depth + 1, options))
        : row
    })
  }
  if (shape.kind === 'array') {
    const itemPath = `${path}[]`
    const nested = shape.element.kind === 'object' || shape.element.kind === 'array'
    const open = expanded.has(itemPath)
    const row = h('div', {
      class: 'editor-json-row editor-json-row--array',
      style: `padding-left:${8 + depth * 14}px`,
    },
      nested
        ? h('button', {
            class: `editor-json-expand${open ? ' expanded' : ''}`,
            title: open ? 'Collapse array element' : 'Expand array element',
            onClick: () => {
              if (open) expanded.delete(itemPath)
              else expanded.add(itemPath)
              options.rerender()
            },
          }, svg(ICON_CHEVRON))
        : h('span', { class: 'editor-json-expand-spacer' }),
      h('span', { class: 'editor-json-key' }, 'element'),
      h('span', { class: 'editor-json-kind' }, `${jsonShapeLabel(shape.element)} · ${shape.sampled} sampled`),
    )
    return open && nested
      ? [h('div', { class: 'editor-json-group' }, row, ...shapeRows(shape.element, itemPath, depth + 1, options))]
      : [row]
  }
  return []
}

export function renderJsonVars(options: JsonVarsOptions): HTMLElement {
  const state = jsonShapeStore.peek(options.locator, options.objectRid)
  const source = options.locator.root.kind === 'runtime'
    ? options.locator.root.expression
    : 'Inline JSON'

  const header = h('div', { class: 'editor-vars-props-head' },
    h('span', {
      class: 'editor-vars-props-title editor-json-source',
      title: options.locator.root.kind === 'runtime' ? options.locator.root.expression : 'Parsed locally from the EC source',
    }, source),
    options.locator.root.kind === 'runtime'
      ? h('button', {
          class: 'btn-micro',
          title: 'Re-read JSON shape from BMP',
          onClick: () => { void jsonShapeStore.refresh(options.locator, options.objectRid).catch(() => {}) },
        }, svg(ICON_REFRESH))
      : null,
  )

  if (state.status === 'idle') {
    queueMicrotask(() => { void jsonShapeStore.load(options.locator, options.objectRid).catch(() => {}) })
  }
  if (state.status === 'idle' || state.status === 'loading') {
    return h('div', { class: 'editor-vars-props-pane' },
      header,
      h('div', { class: 'editor-vars-props-empty' }, 'Loading JSON shape…'),
    )
  }
  if (state.status === 'error') {
    return h('div', { class: 'editor-vars-props-pane' },
      header,
      h('div', { class: 'editor-vars-props-error' },
        h('div', { class: 'editor-vars-props-error-head' }, 'Couldn’t inspect JSON'),
        h('div', { class: 'editor-vars-props-error-body' }, state.error),
        h('button', {
          class: 'btn btn-small',
          onClick: () => { void jsonShapeStore.refresh(options.locator, options.objectRid).catch(() => {}) },
        }, 'Retry'),
      ),
    )
  }

  const rows = shapeRows(state.shape, options.name, 0, options)
  const scalar = state.shape.kind !== 'object' && state.shape.kind !== 'array'
  return h('div', { class: 'editor-vars-props-pane' },
    header,
    state.shape.kind === 'array'
      ? h('div', { class: 'editor-json-note', title: 'Primitive JSON array items are wrapped NodeValues in EC.' },
          `${jsonShapeLabel(state.shape)}${state.shape.truncated ? ' · sampled' : ''}`)
      : null,
    h('div', { class: 'editor-vars-props-list editor-json-list' },
      rows.length > 0
        ? rows
        : h('div', { class: 'editor-vars-props-empty' },
            scalar ? `${state.shape.kind}: JSON value, no nested properties.` : `Empty ${state.shape.kind}.`),
    ),
  )
}
