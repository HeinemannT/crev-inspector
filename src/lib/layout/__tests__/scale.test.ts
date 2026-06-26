import { describe, it, expect } from 'vitest';
import type { LModel } from '../types';
import { addTab, addContainer, addWidget } from '../edit';
import { diff } from '../diff';
import { compile } from '../ec';

const base = (): LModel => ({ pageId: '4957', pageClass: 'Scorecard', tabsetId: 'crev_demo_tabset', tabs: [], target: 'template', hasTemplate: true });
const TYPES = ['SimpleStatus', 'BarChart', 'PieChart', 'ExtendedTable', 'DescriptionView', 'TextElement', 'FunctionStatus', 'RiskList'];

/** Scale guard: a large, deeply-nested layout must diff + compile correctly (no throw, one step
 *  per created node, valid variable-threaded EC). Live timing was build 17ms / diff 5.9ms /
 *  compile 1.8ms for this 320-object tree, and BMP executed an 84-object subset in 62ms. */
describe('layout scale', () => {
  it('diffs + compiles a 320-object, 5-deep tree', () => {
    const NTABS = 8, NCOLS = 3, DEEP = 4;
    let d = base();
    let widgets = 0, conts = 0;
    for (let t = 0; t < NTABS; t++) {
      const tab = addTab(d, t, `Tab ${t}`); d = tab.model;
      for (let col = 0; col < NCOLS; col++) {
        const c = addContainer(d, tab.id, col, 2, `col ${t}.${col}`); d = c.model; conts++;
        let parent = c.id;
        for (let depth = 0; depth < DEEP; depth++) {
          d = addWidget(d, parent, 99, TYPES[(t + col + depth) % TYPES.length], `w ${t}.${col}.${depth}`).model; widgets++;
          const inner = addContainer(d, parent, 99, 6, `box ${t}.${col}.${depth}`); d = inner.model; conts++;
          parent = inner.id;
        }
        for (let k = 0; k < 3; k++) { d = addWidget(d, parent, k, TYPES[k % TYPES.length], `leaf ${t}.${col}.${k}`).model; widgets++; }
      }
      for (let k = 0; k < 3; k++) { d = addWidget(d, tab.id, 99, TYPES[k % TYPES.length], `tabw ${t}.${k}`).model; widgets++; }
    }
    const total = NTABS + conts + widgets;
    const steps = diff(base(), d);
    expect(steps.length).toBe(total);                 // all-creates: one step per node
    expect(steps.every(s => s.kind === 'create')).toBe(true);

    const { script } = compile(steps, d);
    const lines = script.split('\n');
    // preamble (_scr/_sc/_ts) + one line per create
    expect(lines.length).toBe(total + 3);
    // a deep widget binds to its container VARIABLE, never to a t.<tempid>
    expect(script).not.toMatch(/container := t\.(box|w|leaf|tab):/);
    expect(script.match(/container := _n\d+/g)!.length).toBeGreaterThan(widgets / 2);
  });
});
