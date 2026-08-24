// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import type { LModel, LNode } from '../../lib/layout/types';
import { addFlowChild } from '../../lib/layout/flow';
import { actionMenuPanel, flowPanel } from '../result-flow';
import { bp, resetState } from '../state';

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

afterEach(() => resetState());

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

describe('template flow references', () => {
  it('explains that an instance may own the missing EditPage link', () => {
    const createObject: LNode = {
      id: 'cov1', rid: 'r_cov1', kind: 'widget', className: 'CreateObjectView', name: 'Create',
      cols: { L: 6 }, children: [],
    };
    const template: LModel = {
      pageId: 'template_flow', pageClass: 'Scorecard', tabsetId: 'ts_test', tabs: [],
      target: 'template', hasTemplate: false,
      flows: {
        cov1: { ownerId: 'cov1', ownerClass: 'CreateObjectView', kind: 'editpage', children: [] },
      },
    };

    expect(flowPanel(template, createObject)?.textContent).toContain(
      'No edit page linked in this template. Switch to This instance to edit its page link.',
    );
  });

  it('renders a referenced EditPage as a localized editor without replacing root tab state', () => {
    const createObject: LNode = {
      id: 'cov1', rid: 'r_cov1', kind: 'widget', className: 'CreateObjectView', name: 'Create risk',
      cols: { L: 6 }, children: [],
    };
    const page: LModel = {
      pageId: 'risk_workshop',
      pageClass: 'ModelPage',
      tabsetId: 'risk_tabs',
      tabs: [{ ...tab, children: [createObject] }],
      target: 'instance',
      hasTemplate: false,
      flows: {
        cov1: {
          ownerId: 'cov1',
          ownerClass: 'CreateObjectView',
          kind: 'editpage',
          refId: 'risk_edit_page',
          refClass: 'EditPage',
          refName: 'Create risk statement',
          objectTypeClass: 'CeRiskAssessment',
          children: [
            { id: 'details', className: 'EditPageBreak', name: 'Details', isBreak: true },
            { id: 'risk_subtype', className: 'EditField', name: 'Edit field', prop: 'risk_subtype' },
            { id: 'review', className: 'EditPageBreak', name: 'Review', isBreak: true },
            { id: 'owner', className: 'EditField', name: 'Edit field', prop: 'owner' },
          ],
        },
      },
    };
    bp.viewTabId = 'tab1';

    const panel = flowPanel(page, createObject)!;

    expect(panel.querySelector('.bp-editpage.is-embedded')).not.toBeNull();
    expect(panel.querySelector('[data-flowid="risk_subtype"] .bp-ep-field-property')?.textContent)
      .toBe('risk_subtype');
    expect(panel.querySelector('.bp-frow')).toBeNull();

    panel.querySelector<HTMLElement>('[data-flowpagekey="review"]')?.click();
    expect(bp.viewTabId).toBe('tab1');
    expect(bp.editPageViewKeys.get('risk_edit_page')).toBe('review');
  });

  it('renders a staged-new EditPage in the same dedicated editor', () => {
    const createObject: LNode = {
      id: 'cov1', rid: 'r_cov1', kind: 'widget', className: 'CreateObjectView', name: 'Create risk',
      cols: { L: 6 }, children: [],
    };
    const page: LModel = {
      pageId: 'risk_workshop', pageClass: 'ModelPage', tabsetId: 'risk_tabs',
      tabs: [{ ...tab, children: [createObject] }], target: 'instance', hasTemplate: false,
      flowEdits: {
        cov1: {
          wireRef: {
            prop: 'editPage', targetId: 'new:edit-page', targetClass: 'EditPage',
            targetName: 'Create risk statement', setCreateMode: true,
          },
        },
        'new:edit-page': {
          newContainer: {
            className: 'EditPage', name: 'Create risk statement', editPageType: 'CeRiskAssessment',
          },
          adds: [{ id: 'new:risk-subtype', className: 'EditField', name: 'New EditField', prop: 'risk_subtype' }],
        },
      },
    };

    const panel = flowPanel(page, createObject)!;

    expect(panel.querySelector('.bp-editpage.is-embedded')).not.toBeNull();
    expect(panel.querySelector('[data-flowid="new:risk-subtype"] .bp-ep-field-property')?.textContent)
      .toBe('risk_subtype');
    expect(panel.querySelector('.bp-frow')).toBeNull();
  });
});

describe('ButtonGroup add affordance', () => {
  it('opens a ButtonGroup-scoped picker even when the group is empty', () => {
    const inputView: LNode = {
      id: 'iv1', rid: 'r_iv1', kind: 'widget', className: 'InputView', name: 'Inputs',
      cols: { L: 6 }, children: [],
    };
    const m: LModel = {
      ...model(false),
      flows: {
        iv1: {
          ownerId: 'iv1',
          ownerRid: 'r_iv1',
          ownerClass: 'InputView',
          kind: 'inputset',
          refId: 'set1',
          refRid: 'r_set1',
          refClass: 'InputSet',
          refName: 'Input set',
          children: [{ id: 'group1', rid: 'r_group1', className: 'ButtonGroup', name: 'Actions' }],
        },
      },
    };

    const panel = flowPanel(m, inputView)!;
    const add = [...panel.querySelectorAll<HTMLButtonElement>('.bp-faddrow')]
      .find(button => button.textContent?.includes('Add button'));
    expect(add).toBeDefined();
    add!.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true,
      clientX: 240,
      clientY: 320,
    }));

    expect(bp.flowPicker).toEqual({
      key: 'group1',
      className: 'ButtonGroup',
      at: { x: 240, y: 320 },
    });
    expect(bp.picker).toBeNull();
  });

  it('renders the ButtonInput staged inside a ButtonGroup', () => {
    const inputView: LNode = {
      id: 'iv1', rid: 'r_iv1', kind: 'widget', className: 'InputView', name: 'Inputs',
      cols: { L: 6 }, children: [],
    };
    const m: LModel = {
      ...model(false),
      flows: {
        iv1: {
          ownerId: 'iv1',
          ownerRid: 'r_iv1',
          ownerClass: 'InputView',
          kind: 'inputset',
          refId: 'set1',
          refRid: 'r_set1',
          refClass: 'InputSet',
          refName: 'Input set',
          children: [{ id: 'group1', rid: 'r_group1', className: 'ButtonGroup', name: 'Actions' }],
        },
      },
    };
    const staged = addFlowChild(m, 'group1', 'ButtonInput');

    const panel = flowPanel(staged.model, inputView)!;
    const rows = panel.querySelectorAll('.bp-fnest .bp-frow');

    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('New ButtonInput');
    expect(rows[0].querySelector('.bp-ftag.new')?.textContent).toBe('NEW');
  });
});
