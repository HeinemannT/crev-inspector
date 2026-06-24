/**
 * The CVO preview's console buffer + its rendering. A clear ownership split:
 * this owns WHAT the console contains (the line buffer, its counts, how a line
 * renders); studio.ts owns WHEN the panel is shown. The studio forwards sandbox
 * console/error messages here and asks it to render into the panel element.
 */
import { h, render as renderDom } from '../lib/dom'
import type { CvoConsoleLevel } from './cvo-protocol'

interface ConsoleLine { level: CvoConsoleLevel; text: string }

export class StudioConsole {
  private lines: ConsoleLine[] = []

  get count(): number {
    return this.lines.length
  }

  get errorCount(): number {
    return this.lines.reduce((n, l) => n + (l.level === 'error' ? 1 : 0), 0)
  }

  push(level: CvoConsoleLevel, text: string): void {
    this.lines.push({ level, text })
  }

  clear(): void {
    this.lines = []
  }

  renderInto(el: HTMLElement): void {
    if (this.lines.length === 0) {
      renderDom(el, h('div', { class: 'studio-panel-empty' }, 'No console output'))
      return
    }
    renderDom(el, ...this.lines.map(l => h('div', { class: `studio-console-line studio-console-line--${l.level}` }, l.text)))
    el.scrollTop = el.scrollHeight
  }
}
