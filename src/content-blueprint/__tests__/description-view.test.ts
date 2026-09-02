/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it } from 'vitest';
import type { LModel, LNode } from '../../lib/layout/types';
import { descriptionViewSourceType, hasEditableDescriptionViewSource } from '../../lib/layout/description-view';
import { History } from '../../lib/layout/history';
import { findNode } from '../../lib/layout/model';
import { descriptionViewBody } from '../description-view-result';
import { bp, resetState } from '../state';

const view = (viewTypes: string[] = [], sortVisibility: string[] = []): LNode => ({
  id: 'description', rid: '42', kind: 'widget', className: 'DescriptionView',
  name: 'Properties', cols: { L: 6 }, children: [], viewTypes, sortVisibility,
});

const page = (node: LNode, enterprise = false): LModel => ({
  pageId: enterprise ? 'issue_template' : 'classic_page',
  pageRid: '1',
  pageClass: enterprise ? 'EnterpriseTemplate' : 'Scorecard',
  tabsetId: 'default_tabset',
  target: enterprise ? 'template' : 'instance',
  hasTemplate: enterprise,
  ...(enterprise ? { enterpriseObjectType: 'CeIssue' } : {}),
  tabs: [{ id: 'RESULT', kind: 'tab', className: 'Tab', name: 'Result', cols: { L: 6 }, children: [node] }],
});

const schema = [
  { accessor: 'name', label: 'Name', configClass: 'TextMethodConfig', systemobject: true },
  { accessor: 'owner_reference', label: 'Owner', configClass: 'ReferenceMethodConfig', systemobject: false },
  { accessor: 'due_date', label: 'Due date', configClass: 'DateMethodConfig', systemobject: false },
];

afterEach(() => {
  resetState();
  document.body.replaceChildren();
});

describe('Blueprint DescriptionView body', () => {
  it('shows Classic source as inferred but still exposes individual properties', () => {
    const node = view([], ['name']);
    const model = page(node);
    bp.history = new History(model);
    bp.propertySchemas.set('Scorecard', schema);

    const body = descriptionViewBody(model, node, true);

    expect(descriptionViewSourceType(model, node)).toBe('Scorecard');
    expect(hasEditableDescriptionViewSource(model, node)).toBe(false);
    expect(body.querySelector('.bp-dv-source code')?.textContent).toBe('Scorecard');
    expect(body.querySelector('.bp-dv-source select')).toBeNull();
    expect(body.querySelector('.bp-dv-property-name')?.textContent).toBe('Name');
    expect(body.querySelector('[aria-label="Add visible property"]')).not.toBeNull();
  });

  it('ignores stale enterprise-only source data on a Classic page', () => {
    const node = view(['CeIssue'], ['name']);
    const model = page(node);

    expect(descriptionViewSourceType(model, node)).toBe('Scorecard');
    expect(hasEditableDescriptionViewSource(model, node)).toBe(false);
  });

  it('keeps the inferred Enterprise source visible and configurable inside the view', () => {
    const node = view(['CeIssue']);
    const model = page(node, true);
    bp.history = new History(model);
    bp.propertySchemas.set('CeIssue', schema);

    const body = descriptionViewBody(model, node, true);
    const select = body.querySelector('select')!;

    expect(descriptionViewSourceType(model, node)).toBe('CeIssue');
    expect(hasEditableDescriptionViewSource(model, node)).toBe(true);
    expect(select.value).toBe('CeIssue');
    expect(select.selectedOptions[0]?.textContent).toBe('CeIssue');
    expect(select.selectedOptions[0]?.title).toBe('Issue (current object)');
    expect(select.getAttribute('aria-label')).toBe('Description properties source');
  });

  it('does not imply an unstaged source when no Enterprise object can be inferred', () => {
    const node = view();
    const model = { ...page(node, true), enterpriseObjectType: undefined };
    bp.history = new History(model);

    const select = descriptionViewBody(model, node, true).querySelector('select')!;

    expect(select.value).toBe('');
    expect(select.selectedOptions[0]?.textContent).toBe('Select enterprise object');
    expect(select.selectedOptions[0]?.disabled).toBe(true);
  });

  it('edits the ordered individual-property selection directly in the view body', () => {
    const node = view(['CeIssue'], ['name', 'owner_reference']);
    const model = page(node, true);
    bp.history = new History(model);
    bp.propertySchemas.set('CeIssue', schema);

    const body = descriptionViewBody(model, node, true);
    expect(body.querySelectorAll('.bp-dv-property-row')).toHaveLength(2);
    expect(body.querySelector('.bp-dv-count')?.textContent).toBe('2');
    expect(body.querySelector('[aria-label="Add visible property"]')).not.toBeNull();

    (body.querySelector('[aria-label="Hide owner_reference"]') as HTMLButtonElement).click();
    expect(findNode(bp.history.present(), node.id)?.node.sortVisibility).toEqual(['name']);
  });

  it('adds an individual property from the inline chooser', () => {
    const node = view(['CeIssue'], ['name']);
    const model = page(node, true);
    bp.history = new History(model);
    bp.propertySchemas.set('CeIssue', schema);
    const body = descriptionViewBody(model, node, true);

    (body.querySelector('[aria-label="Show properties"]') as HTMLButtonElement).click();
    const option = body.querySelector<HTMLElement>('[role="option"][data-value="due_date"]')!;
    option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));

    expect(findNode(bp.history.present(), node.id)?.node.sortVisibility).toEqual(['name', 'due_date']);
  });

  it('changes the Enterprise source and clears class-specific properties', () => {
    const node = view(['CeIssue'], ['name']);
    const model = page(node, true);
    bp.history = new History(model);
    const body = descriptionViewBody(model, node, true);
    const select = body.querySelector('select')!;

    select.value = 'CeTask';
    select.dispatchEvent(new Event('change'));

    expect(findNode(bp.history.present(), node.id)?.node).toMatchObject({
      viewTypes: ['CeTask'],
      sortVisibility: [],
    });
  });

  it('uses the same surface as a compact summary when the cell is not selected', () => {
    const node = view([], ['one', 'two', 'three', 'four', 'five']);
    const model = page(node);
    bp.history = new History(model);

    const body = descriptionViewBody(model, node, false);

    expect(body.querySelectorAll('.bp-dv-property-row')).toHaveLength(4);
    expect(body.querySelector('.bp-dv-more')?.textContent).toBe('+1 more');
    expect(body.querySelector('[aria-label="Add visible property"]')).toBeNull();
  });
});
