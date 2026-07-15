// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import type { LModel, LNode } from '../../lib/layout/types';
import { actionMenuPanel } from '../result-flow';

const tab: LNode = {
  id: 'tab1', rid: 'r_tab1', kind: 'tab', className: 'Tab', name: 'Overview',
  cols: { L: 6 }, children: [],
};

function model(allTabs: boolean): LModel {
  return {
    pageId: 'sc_test', pageClass: 'Scorecard', tabsetId: 'ts_test',
    tabs: [tab], target: 'instance', hasTemplate: false,
    flows: {
      action1: {
        ownerId: 'action1', ownerRid: 'r_action1', ownerClass: 'ActionButton',
        ownerName: 'Approve', kind: 'plain', container: 'tab1', children: [],
        displayOnActionMenu: true, displayOnAllTabs: allTabs,
      },
    },
  };
}

describe('action-menu controls', () => {
  it('uses a slashed scope glyph and explicit tooltip for this-tab-only', () => {
    const panel = actionMenuPanel(model(false), 'tab1');
    const scope = panel.querySelector('.bp-fic-scope') as HTMLButtonElement;
    expect(scope.classList.contains('single-tab')).toBe(true);
    expect(scope.classList.contains('all-tabs')).toBe(false);
    expect(scope.title).toContain('This tab only');
    expect(scope.title).toContain('slash means');
    expect(scope.getAttribute('aria-pressed')).toBe('false');
  });

  it('uses the plain tabs glyph and explicit tooltip for all-tabs', () => {
    const panel = actionMenuPanel(model(true), 'tab1');
    const scope = panel.querySelector('.bp-fic-scope') as HTMLButtonElement;
    expect(scope.classList.contains('all-tabs')).toBe(true);
    expect(scope.classList.contains('single-tab')).toBe(false);
    expect(scope.title).toContain('All tabs');
    expect(scope.getAttribute('aria-pressed')).toBe('true');
  });
});
