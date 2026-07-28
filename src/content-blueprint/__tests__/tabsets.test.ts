// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import type { LModel, LNode } from '../../lib/layout/types';
import { tabsetColorMap } from '../view';

const tab = (id: string, tabsetId: string, withWidget = true): LNode => ({
  id,
  tabsetId,
  name: id,
  kind: 'tab',
  className: 'Tab',
  cols: { L: 6 },
  children: withWidget ? [{
    id: `w_${id}`,
    name: `Widget ${id}`,
    kind: 'widget',
    className: 'TextElement',
    cols: { L: 6 },
    children: [],
  }] : [],
});

const page = (...tabs: LNode[]): LModel => ({
  pageId: 'page',
  pageClass: 'Scorecard',
  tabsetId: 'zeta',
  tabsets: [
    { id: 'zeta', name: 'Zeta' },
    { id: 'alpha', name: 'Alpha' },
    { id: 'default_tabset', name: 'Tab set' },
  ],
  tabs,
  target: 'template',
  hasTemplate: true,
});

describe('Blueprint TabSet provenance colors', () => {
  it('uses no provenance color when only one non-Result TabSet contributes', () => {
    expect([...tabsetColorMap(page(tab('A', 'alpha')))]).toEqual([]);
  });

  it('assigns stable colors by TabSet id and ignores the shared Result TabSet', () => {
    const colors = tabsetColorMap(page(
      tab('Z', 'zeta'),
      tab('RESULT', 'default_tabset'),
      tab('A', 'alpha'),
    ));
    expect([...colors]).toEqual([['alpha', 0], ['zeta', 1]]);
    expect(colors.has('default_tabset')).toBe(false);
  });
});
