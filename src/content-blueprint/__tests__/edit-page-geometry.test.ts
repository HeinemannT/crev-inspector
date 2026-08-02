/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it } from 'vitest';
import { readEditPageLiveGeometry } from '../edit-page-geometry';

const box = (left: number, top: number, width: number, height: number): DOMRect => ({
  x: left, y: top, left, top, right: left + width, bottom: top + height,
  width, height, toJSON: () => ({}),
} as DOMRect);

const place = (element: Element, rect: DOMRect): void => {
  element.getBoundingClientRect = () => rect;
};

afterEach(() => document.body.replaceChildren());

describe('EditPage live geometry', () => {
  it('treats direct property editors as one column', () => {
    const host = document.createElement('div');
    host.className = 'edit-page';
    const title = document.createElement('h1');
    const nav = document.createElement('div');
    nav.dataset.testid = 'EDIT_PAGE_PAGINATION_STEPPER_ID_x';
    const navRow = document.createElement('div');
    const tab = document.createElement('button');
    tab.textContent = 'Identity';
    navRow.appendChild(tab);
    nav.appendChild(navRow);
    const content = document.createElement('div');
    content.className = 'edit-page-content';
    const first = document.createElement('div');
    first.className = 'property-editor';
    const second = document.createElement('div');
    second.className = 'property-editor';
    content.append(first, second);
    host.append(title, nav, content);
    document.body.appendChild(host);
    place(host, box(100, 50, 650, 500));
    place(title, box(100, 75, 650, 34));
    place(nav, box(101, 125, 633, 72));
    place(navRow, box(101, 125, 633, 72));
    place(tab, box(101, 149, 210, 24));
    place(content, box(101, 197, 633, 175));
    place(first, box(101, 197, 633, 80));
    place(second, box(101, 292, 633, 80));

    const geometry = readEditPageLiveGeometry();
    expect(geometry?.columns).toHaveLength(1);
    expect(geometry?.columns[0].slots).toHaveLength(2);
    expect(geometry?.content).toMatchObject({ left: 1, top: 147, width: 633 });
    expect(geometry?.pageTabs).toEqual([{ left: 1, top: 99, width: 210, height: 24 }]);
    expect(geometry?.rowGap).toBe(15);
  });

  it('preserves BMP column widths, slots, and inter-column gap', () => {
    const host = document.createElement('div');
    host.className = 'edit-page';
    const content = document.createElement('div');
    content.className = 'edit-page-content';
    const left = document.createElement('div');
    const right = document.createElement('div');
    const leftA = document.createElement('div');
    const leftB = document.createElement('div');
    const rightA = document.createElement('div');
    const rightB = document.createElement('div');
    left.append(leftA, leftB);
    right.append(rightA, rightB);
    content.append(left, right);
    host.appendChild(content);
    document.body.appendChild(host);
    place(host, box(20, 100, 1_200, 600));
    place(content, box(40, 220, 1_160, 200));
    place(left, box(40, 220, 572, 175));
    place(right, box(628, 220, 572, 175));
    place(leftA, box(40, 220, 572, 80));
    place(leftB, box(40, 315, 572, 80));
    place(rightA, box(628, 220, 572, 80));
    place(rightB, box(628, 315, 572, 80));

    const geometry = readEditPageLiveGeometry();
    expect(geometry).not.toBeNull();
    if (!geometry) throw new Error('Expected live geometry');
    const columns = geometry.columns;
    expect(columns.map(column => ({
      left: column.left,
      width: column.width,
      slots: column.slots.length,
    }))).toEqual([
      { left: 20, width: 572, slots: 2 },
      { left: 608, width: 572, slots: 2 },
    ]);
    expect(columns[1].left - (columns[0].left + columns[0].width)).toBe(16);
  });

  it('recognizes horizontal one-field wrappers as separate columns', () => {
    const host = document.createElement('div');
    host.className = 'edit-page';
    const content = document.createElement('div');
    content.className = 'edit-page-content';
    const left = document.createElement('div');
    const right = document.createElement('div');
    const leftField = document.createElement('section');
    const rightField = document.createElement('section');
    left.appendChild(leftField);
    right.appendChild(rightField);
    content.append(left, right);
    host.appendChild(content);
    document.body.appendChild(host);
    place(host, box(20, 100, 700, 300));
    place(content, box(40, 160, 660, 100));
    place(left, box(40, 160, 320, 100));
    place(right, box(380, 160, 320, 100));
    place(leftField, box(40, 160, 320, 80));
    place(rightField, box(380, 160, 320, 80));

    const geometry = readEditPageLiveGeometry();
    expect(geometry?.columns.map(column => column.slots.length)).toEqual([1, 1]);
  });

  it('keeps narrow pagination tabs selectable', () => {
    const host = document.createElement('div');
    host.className = 'edit-page';
    const nav = document.createElement('div');
    nav.dataset.testid = 'EDIT_PAGE_PAGINATION_STEPPER_ID_x';
    const row = document.createElement('div');
    const tab = document.createElement('button');
    tab.textContent = 'Step';
    row.appendChild(tab);
    nav.appendChild(row);
    const content = document.createElement('div');
    content.className = 'edit-page-content';
    const field = document.createElement('section');
    content.appendChild(field);
    host.append(nav, content);
    document.body.appendChild(host);
    place(host, box(20, 100, 300, 300));
    place(nav, box(30, 120, 280, 50));
    place(row, box(30, 120, 280, 50));
    place(tab, box(30, 135, 72, 24));
    place(content, box(30, 180, 280, 80));
    place(field, box(30, 180, 280, 80));

    expect(readEditPageLiveGeometry()?.pageTabs).toEqual([
      { left: 10, top: 35, width: 72, height: 24 },
    ]);
  });

  it('ignores a stale hidden EditPage host when a visible host is rendered', () => {
    const staleHost = document.createElement('div');
    staleHost.className = 'edit-page';
    place(staleHost, box(0, 0, 0, 0));
    document.body.appendChild(staleHost);

    const visibleHost = document.createElement('div');
    visibleHost.className = 'edit-page';
    const content = document.createElement('div');
    content.className = 'edit-page-content';
    const field = document.createElement('section');
    content.appendChild(field);
    visibleHost.appendChild(content);
    document.body.appendChild(visibleHost);
    place(visibleHost, box(40, 80, 640, 420));
    place(content, box(60, 120, 600, 80));
    place(field, box(60, 120, 600, 80));

    const geometry = readEditPageLiveGeometry();

    expect(geometry?.hostElement).toBe(visibleHost);
    expect(geometry?.columns[0]?.slots).toHaveLength(1);
  });
});
