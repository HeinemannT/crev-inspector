import { describe, it, expect } from 'vitest';
import type { LModel, LNode } from '../types';
import { createTabset } from '../edit';
import { diff } from '../diff';
import { compile } from '../ec';

const n = (p: Partial<LNode> & Pick<LNode, 'id' | 'kind' | 'className'>): LNode => ({ name: p.id, cols: { L: 6 }, children: [], ...p });

/** A RESULT-only page: no dedicated tabset, widgets sit on the phantom Result tab. */
const resultOnly = (): LModel => ({
  pageId: 'xpl_lt_sc', pageClass: 'Scorecard', tabsetId: 'default_tabset',
  target: 'instance', hasTemplate: false, resultOnly: true,
  tabs: [n({ id: 'RESULT', kind: 'tab', className: 'Tab', name: 'Result', children: [
    n({ id: 'w1', kind: 'widget', className: 'CustomVisualization', name: 'Left' }),
    n({ id: 'w2', kind: 'widget', className: 'CustomVisualization', name: 'Right' }),
  ] })],
});

describe('edit.createTabset (virtual tabset staging)', () => {
  it('stages a virtual tabset with a Main tab that carries the Result widgets', () => {
    const { model: m, id } = createTabset(resultOnly());
    expect(m.tabsetVirtual).toBe(true);
    expect(m.resultOnly).toBeFalsy();
    expect(m.tabsetName).toContain('New');
    expect(m.tabs).toHaveLength(1);
    expect(m.tabs[0].id).toBe(id);
    expect(m.tabs[0].name).toBe('Main');
    expect(m.tabs[0].children.map(c => c.id)).toEqual(['w1', 'w2']); // widgets rehomed onto the new tab
  });

  it('is a no-op on a page that already owns a tabset (returns the model untouched)', () => {
    const normal: LModel = {
      pageId: '4957', pageClass: 'Scorecard', tabsetId: 'ts1', target: 'template', hasTemplate: true,
      tabs: [n({ id: 'tab1', kind: 'tab', className: 'Tab', children: [] })],
    };
    const r = createTabset(normal);
    expect(r.model).toBe(normal);
    expect(r.model.tabsetVirtual).toBeUndefined();
  });
});

describe('createTabset → diff → compile (one atomic apply EC)', () => {
  it('diff creates the Main tab + reparents widgets, and never deletes the phantom RESULT tab', () => {
    const plan = diff(resultOnly(), createTabset(resultOnly()).model);
    expect(plan.filter(s => s.kind === 'create')).toHaveLength(1);      // the Main tab
    expect(plan.filter(s => s.kind === 'reparent')).toHaveLength(2);    // w1, w2 onto Main
    expect(plan.some(s => s.kind === 'delete')).toBe(false);            // RESULT tab is NOT deleted
  });

  it('compile emits the tabset creation in the SAME EC as its tab, landing it in the ONE support Category', () => {
    const staged = createTabset(resultOnly());
    const { script } = compile(diff(resultOnly(), staged.model), staged.model);
    // FIX: the virtual tabset no longer lands bare under the portal — it goes in the page's support
    // Category (named after the page — here the pageId, since this fixture has no display name), so a
    // page's new tabset + any new sets/pages all live in ONE folder.
    expect(script).toContain('_fcat := root.portal.add(Category, name := "xpl_lt_sc")'); // ONE support Category
    expect(script).toContain('_ts := _fcat.add(TabSet, name :=');    // tabset created in that Category
    expect(script).not.toContain('_ts := t.');                       // NOT referenced by business id
    expect(script).toContain('_ts.add(Tab, name := "Main"');         // its tab, same program
    expect(script).toMatch(/t\.w1\.change\(container := _n\d\)/);     // widget binds to the just-created tab var
    expect(script).not.toMatch(/\.delete\(\)/);                       // no RESULT delete leaks in
  });
});
