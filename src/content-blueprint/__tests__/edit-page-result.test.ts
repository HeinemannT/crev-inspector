/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it } from 'vitest';
import type { FlowNode, LModel } from '../../lib/layout/types';
import { resetState, bp } from '../state';
import { renderEditPage } from '../edit-page-result';

const box = (left: number, top: number, width: number, height: number): DOMRect => ({
  x: left, y: top, left, top, right: left + width, bottom: top + height,
  width, height, toJSON: () => ({}),
} as DOMRect);

const place = (element: Element, rect: DOMRect): void => {
  element.getBoundingClientRect = () => rect;
};

const children: FlowNode[] = [
  { id: 'step', className: 'EditPageBreak', name: 'Details', isBreak: true },
  { id: 'field', className: 'EditField', name: 'Edit field', prop: 'name', isBreak: false },
];

const model = (): LModel => ({
  pageId: 'edit_page',
  pageName: 'Create Process',
  editPageTitle: 'Create new Process',
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

afterEach(() => {
  resetState();
  document.body.replaceChildren();
});

describe('standalone EditPage canvas', () => {
  it('masks BMP’s configured title and selects a property on completed click', () => {
    const layer = document.createElement('div');
    const rendered = renderEditPage(model(), layer);
    const field = layer.querySelector<HTMLElement>('.bp-ep-field');

    expect(rendered).toBe(true);
    expect(layer.querySelector('.bp-ep-kicker')?.textContent).toBe('EDIT PAGE');
    expect(layer.textContent).not.toContain('Create new Process');
    expect(field).not.toBeNull();

    field?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(bp.selectedId).toBeNull();
    field?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(bp.selectedId).toBe('field');
  });

  it('places its add action below the complete native form footprint', () => {
    const host = document.createElement('div');
    host.className = 'edit-page';
    const title = document.createElement('h1');
    const content = document.createElement('div');
    content.className = 'edit-page-content';
    const field = document.createElement('div');
    field.className = 'property-editor';
    content.appendChild(field);
    host.append(title, content);
    document.body.appendChild(host);
    place(host, box(100, 50, 700, 420));
    place(title, box(100, 65, 700, 35));
    place(content, box(100, 120, 700, 80));
    place(field, box(100, 120, 700, 80));

    const current = model();
    bp.baseline = current;
    const layer = document.createElement('div');
    renderEditPage(current, layer);

    const add = layer.querySelector<HTMLElement>('.bp-ep-add');
    const frame = layer.querySelector<HTMLElement>('.bp-editpage');
    expect(add?.style.top).toBe('432px');
    expect(Number.parseFloat(frame?.style.height ?? '0')).toBeGreaterThan(432);
  });
});
