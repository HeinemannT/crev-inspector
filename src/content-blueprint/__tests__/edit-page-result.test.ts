/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FlowNode, LModel } from '../../lib/layout/types';
import { resetState, bp } from '../state';
import { duplicateEditFieldMappings, renderEditPage } from '../edit-page-result';
import { sendFireForget } from '../../lib/messaging';

vi.mock('../../lib/messaging', () => ({ sendFireForget: vi.fn() }));

const box = (left: number, top: number, width: number, height: number): DOMRect => ({
  x: left, y: top, left, top, right: left + width, bottom: top + height,
  width, height, toJSON: () => ({}),
} as DOMRect);

const place = (element: Element, rect: DOMRect): void => {
  element.getBoundingClientRect = () => rect;
};

const children: FlowNode[] = [
  { id: 'step', rid: '1001', className: 'EditPageBreak', name: 'Details', isBreak: true },
  { id: 'field', rid: '1002', className: 'EditField', name: 'Edit field', prop: 'name', isBreak: false },
  { id: 'info', rid: '1003', className: 'EditPageInfo', name: 'Introduction', isBreak: false },
  { id: 'column', rid: '1004', className: 'EditPageColumnBreak', name: 'Classification', isBreak: true },
  { id: 'field-2', rid: '1005', className: 'EditField', name: 'Edit field', prop: 'code', isBreak: false },
  { id: 'field-3', rid: '1006', className: 'EditField', name: 'Edit field', prop: 'description', isBreak: false },
];

const model = (): LModel => ({
  pageId: 'edit_page',
  pageName: 'Create Process',
  editPageTitle: 'Create new Process',
  editPageTypes: ['CeProcess'],
  pageClass: 'EditPage',
  tabsetId: '',
  tabs: [],
  target: 'instance',
  hasTemplate: false,
  flows: {
    edit_page: {
      ownerId: 'edit_page',
      ownerClass: 'EditPage',
      ownerName: 'Create Process',
      kind: 'editpage',
      refId: 'edit_page',
      refClass: 'EditPage',
      children,
    },
  },
  flowEdits: {},
});

function mountLivePage(): void {
  const host = document.createElement('main');
  host.className = 'edit-page';
  const title = document.createElement('h1');
  title.textContent = 'Create new Process';
  const nav = document.createElement('div');
  nav.dataset.testid = 'EDIT_PAGE_PAGINATION_STEPPER_ID_x';
  const navRow = document.createElement('div');
  const tab = document.createElement('button');
  tab.textContent = 'Details';
  navRow.appendChild(tab);
  nav.appendChild(navRow);
  const content = document.createElement('div');
  content.className = 'edit-page-content';
  const left = document.createElement('div');
  const right = document.createElement('div');
  const slots = ['field', 'info', 'field-2', 'field-3'].map(id => {
    const slot = document.createElement('section');
    slot.id = `native-${id}`;
    if (id !== 'info') slot.className = 'property-editor';
    return slot;
  });
  left.append(slots[0], slots[1]);
  right.append(slots[2], slots[3]);
  content.append(left, right);
  host.append(title, nav, content);
  document.body.appendChild(host);

  place(host, box(100, 50, 650, 500));
  place(title, box(100, 65, 650, 34));
  place(nav, box(101, 110, 633, 72));
  place(navRow, box(101, 110, 633, 72));
  place(tab, box(101, 134, 210, 24));
  place(content, box(101, 182, 633, 175));
  place(left, box(101, 182, 309, 175));
  place(right, box(425, 182, 309, 175));
  place(slots[0], box(101, 182, 309, 80));
  place(slots[1], box(101, 277, 309, 80));
  place(slots[2], box(425, 182, 309, 80));
  place(slots[3], box(425, 277, 309, 80));
}

afterEach(() => {
  resetState();
  vi.clearAllMocks();
  document.body.replaceChildren();
});

describe('standalone EditPage Blueprint', () => {
  it('covers the native form with a model-driven Blueprint and selects on click', () => {
    mountLivePage();
    const layer = document.createElement('div');
    expect(renderEditPage(model(), layer)).toBe(true);

    const workspace = layer.querySelector<HTMLElement>('.bp-editpage-workspace');
    const field = layer.querySelector<HTMLElement>('[data-flowid="field"]');
    expect(document.querySelector('.edit-page h1')?.textContent).toBe('Create new Process');
    expect(layer.textContent).toContain('Create Process');
    expect(workspace?.style.left).toBe('100px');
    expect(workspace?.style.top).toBe('50px');
    expect(workspace?.classList.contains('is-model-driven')).toBe(true);
    expect(field?.querySelector('.bp-ep-field-id')?.textContent).toBe('field');

    field?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(bp.selectedId).toBeNull();
    field?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(bp.selectedId).toBe('field');
  });

  it('makes page breaks, column breaks, and info objects selectable', () => {
    mountLivePage();
    const current = model();
    bp.baseline = current;
    const layer = document.createElement('div');
    renderEditPage(current, layer);

    expect(layer.querySelector('[data-flowid="step"].bp-ep-page')).not.toBeNull();
    expect(layer.querySelector('[data-flowid="column"].bp-ep-column-object')).not.toBeNull();
    expect(layer.querySelector('[data-flowid="info"].bp-ep-field')).not.toBeNull();

    layer.querySelector<HTMLElement>('[data-flowid="column"]')?.click();
    expect(bp.selectedId).toBe('column');
  });

  it('uses a compact selection toolbar and opens the mapped property object', () => {
    mountLivePage();
    const current = model();
    bp.baseline = current;
    bp.selectedId = 'field';
    bp.propertySchemas.set('CeProcess', [{
      accessor: 'name',
      label: 'Name',
      configClass: 'TextPropertyConfig',
      systemobject: false,
      propertyRid: '8123456789012345678',
      propertyId: 'ceProcessName',
    }]);
    const layer = document.createElement('div');
    renderEditPage(current, layer);

    expect(layer.querySelector('.bp-ep-details')).toBeNull();
    expect(layer.querySelector('.bp-ep-toolbar .bp-ep-object-id')?.textContent).toBe('field');
    const property = layer.querySelector<HTMLInputElement>('.crev-property-picker__input');
    expect(property?.value).toBe('ceProcessName');
    expect(layer.querySelector('[data-flowid="field"] .bp-ep-field-property')?.textContent)
      .toBe('ceProcessName');
    property?.click();
    expect(layer.querySelector('.crev-property-picker__list')?.textContent).toContain('ceProcessName');
    expect(layer.querySelector('.crev-property-picker__list')?.textContent).toContain('Name');
    expect(layer.querySelector('.crev-property-picker__option-state')).toBeNull();
    layer.querySelector<HTMLButtonElement>('.bp-ep-property-open')?.click();
    expect(sendFireForget).toHaveBeenCalledWith({
      type: 'SELECT_OBJECT',
      rid: '8123456789012345678',
      openPanel: true,
    });
  });

  it('keeps the live-aligned layer inert during Peek and retains Add element', () => {
    mountLivePage();
    const current = model();
    bp.baseline = current;
    bp.peek = true;
    const layer = document.createElement('div');
    layer.classList.add('bp-peek');
    renderEditPage(current, layer);

    const workspace = layer.querySelector<HTMLElement>('.bp-editpage-workspace');
    expect(workspace?.inert).toBe(true);
    expect(workspace?.getAttribute('aria-hidden')).toBe('true');

    bp.peek = false;
    layer.querySelector<HTMLButtonElement>('.bp-ep-add')?.click();
    expect(bp.flowPicker).toMatchObject({ key: 'edit_page', className: 'EditPage' });
  });

  it('renders staged order directly in the model canvas', () => {
    mountLivePage();
    const current = model();
    current.flowEdits = {
      edit_page: {
        order: ['step', 'info', 'field', 'column', 'field-2', 'field-3'],
      },
    };
    const layer = document.createElement('div');
    renderEditPage(current, layer);

    expect(layer.querySelector('.bp-editpage-workspace.is-model-driven')).not.toBeNull();
    expect(layer.querySelector('.bp-ep-model-surface')).not.toBeNull();
    expect([...layer.querySelectorAll('.bp-ep-field .bp-ep-field-id')]
      .map(element => element.textContent)).toEqual([
      'info',
      'field',
      'field-2',
      'field-3',
    ]);
    expect(layer.querySelectorAll('.bp-ep-field')).toHaveLength(4);
  });

  it('shows a staged page break in the compact page strip', () => {
    mountLivePage();
    const current = model();
    current.flowEdits = {
      edit_page: {
        adds: [{
          id: 'new:page',
          className: 'EditPageBreak',
          name: 'Review',
          isBreak: true,
        }],
        order: [...children.map(child => child.id), 'new:page'],
      },
    };
    const layer = document.createElement('div');
    renderEditPage(current, layer);

    expect(layer.querySelectorAll('.bp-ep-page')).toHaveLength(2);
    expect(layer.querySelector('[data-flowid="new:page"] .bp-ep-page-label')?.textContent)
      .toBe('Review');
  });

  it('does not invent a Column 1 object and marks structural rows distinctly', () => {
    mountLivePage();
    const layer = document.createElement('div');
    renderEditPage(model(), layer);

    expect(layer.textContent).not.toContain('Column 1');
    expect(layer.querySelector('[data-flowid="column"]')?.closest('.bp-ep-column')?.classList)
      .toContain('has-break');
    expect(layer.querySelector('[data-flowid="info"]')?.classList)
      .toContain('kind-EditPageInfo');
    expect(layer.querySelector('[data-flowid="info"] [aria-label="Information (read-only content)"]'))
      .not.toBeNull();
    expect(layer.querySelector('[data-flowid="column"] [aria-label="Column break (layout structure)"]'))
      .not.toBeNull();
    expect(layer.querySelector('[data-flowid="field"]')?.getAttribute('data-flowfirst')).toBe('true');
  });

  it('shows the effective EditPage name as an inline rename target', () => {
    mountLivePage();
    const current = model();
    current.flowEdits = { edit_page: { rename: 'Renamed process page' } };
    const layer = document.createElement('div');
    renderEditPage(current, layer);

    const name = layer.querySelector<HTMLElement>('.bp-ep-context [data-bprename="edit_page"]');
    expect(name?.textContent).toBe('Renamed process page');
    expect(layer.querySelector<HTMLButtonElement>('.bp-ep-context [aria-label="Rename EditPage"]'))
      .not.toBeNull();
  });

  it('keeps an explicit start-of-page anchor when opening the add picker', () => {
    mountLivePage();
    const current = model();
    current.flows!.edit_page.children = children.slice(1);
    const layer = document.createElement('div');
    renderEditPage(current, layer);

    layer.querySelector<HTMLButtonElement>('.bp-ep-insert')?.click();
    expect(bp.flowPicker).toMatchObject({
      key: 'edit_page',
      className: 'EditPage',
      afterId: null,
    });
  });

  it('warns only when multiple EditFields map to the same non-empty property', () => {
    const duplicates = duplicateEditFieldMappings([
      { id: 'a', className: 'EditField', name: 'A', prop: 'name' },
      { id: 'b', className: 'EditField', name: 'B', prop: 'name' },
      { id: 'c', className: 'EditField', name: 'C', prop: '' },
      { id: 'd', className: 'EditPageInfo', name: 'D', prop: 'name' },
    ]);
    expect(duplicates).toEqual(new Map([['name', ['a', 'b']]]));
  });
});
