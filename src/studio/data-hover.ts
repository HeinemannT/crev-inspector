/**
 * Hover a `_data.…` path in the JavaScript editor to see its resolved value —
 * the studio analogue of the EC editor's object-on-hover. Reads the current
 * preview data (live or mock) so the author sees the exact shape they're coding
 * against, without leaving the editor.
 */
import { hoverTooltip, type Tooltip } from '@codemirror/view'

/** Dotted-path characters: identifiers + `.` + `$`. Stops at `(`, `[`, quotes. */
const PATH_CHAR = /[\w$.]/

export function resolvePath(data: unknown, path: string[]): unknown {
  let cur: unknown = data
  for (const k of path) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[k]
  }
  return cur
}

export function formatValue(v: unknown): string {
  if (v === undefined) return '(not present in _data)'
  if (v === null) return 'null'
  if (typeof v === 'string') return v.length > 2000 ? v.slice(0, 2000) + '\n… (truncated)' : (v || '(empty string)')
  try {
    const json = JSON.stringify(v, null, 2)
    return json.length > 4000 ? json.slice(0, 4000) + '\n… (truncated)' : json
  } catch {
    return String(v)
  }
}

/** Build the hover extension. `getData` returns the data object currently
 *  feeding the preview; `getMode` labels it ('mock' / 'live'). */
export function makeDataHover(getData: () => Record<string, unknown>, getMode: () => 'mock' | 'live') {
  return hoverTooltip((view, pos): Tooltip | null => {
    const line = view.state.doc.lineAt(pos)
    const text = line.text
    const off = pos - line.from
    let start = off
    let end = off
    while (start > 0 && PATH_CHAR.test(text[start - 1])) start--
    while (end < text.length && PATH_CHAR.test(text[end])) end++
    const token = text.slice(start, end).replace(/^\.+|\.+$/g, '')
    if (token !== '_data' && !token.startsWith('_data.')) return null

    const parts = token.split('.').filter(Boolean)
    const path = parts.slice(1) // drop the leading `_data`
    // `.element` is attached inside the sandbox at render time, not in the feed.
    const body = path[0] === 'element'
      ? '(the container <div>, attached at render time)'
      : formatValue(path.length === 0 ? getData() : resolvePath(getData(), path))
    const head = `${token}  ·  ${getMode()} data`

    return {
      pos: line.from + start,
      end: line.from + end,
      above: true,
      create() {
        const el = document.createElement('div')
        el.className = 'studio-data-hover'
        const h = document.createElement('div')
        h.className = 'studio-data-hover-head'
        h.textContent = head
        const pre = document.createElement('pre')
        pre.className = 'studio-data-hover-body'
        pre.textContent = body
        el.append(h, pre)
        return { dom: el }
      },
    }
  })
}
