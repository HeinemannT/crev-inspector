import type { FlowNode, LModel } from '../lib/layout/types';
import { effectiveFlowChildren } from '../lib/layout/flow';
import { ICON_PENCIL, ICON_PLUS, ICON_X } from '../lib/icons';
import { isTempId } from '../lib/layout/model';
import { bp } from './state';
import { beginRename, cancelFlowAdd, openFlowPicker, viewEditPage } from './actions';
import { armFlowRow } from './gestures';
import { setIcon, docX, docY } from './geometry';
import { flowBadge } from './result-flow';
import { projectEditPage } from './edit-page-model';

function tap(el: HTMLElement, fn: (e: MouseEvent) => void): void {
  el.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); fn(e); });
}

function pencil(id: string, title: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.className = 'bp-ep-pencil';
  button.title = title;
  setIcon(button, ICON_PENCIL);
  tap(button, () => beginRename(id));
  return button;
}

function cancelAdd(pageId: string, id: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.className = 'bp-ep-cancel';
  button.title = 'Cancel this staged add';
  setIcon(button, ICON_X);
  tap(button, () => cancelFlowAdd(pageId, id));
  return button;
}

function dragHandle(): HTMLElement {
  const handle = document.createElement('span');
  handle.className = 'bp-ep-drag';
  handle.title = 'Drag to reorder';
  for (let i = 0; i < 3; i++) handle.appendChild(document.createElement('i'));
  return handle;
}

/** Stock BMP EditFields are often all named literally "Edit field". In that case the property
 * mapping is the only useful label available in this bounded read; configured names still win. */
export function editPageFieldLabel(node: FlowNode): string {
  if (node.className === 'EditField' && /^edit field$/i.test(node.name.trim()) && node.prop) {
    return node.prop.replace(/[_-]+/g, ' ').toUpperCase();
  }
  return node.name || node.className;
}

function field(node: FlowNode, pageId: string): HTMLElement {
  const row = document.createElement('div');
  row.className = `bp-ep-field kind-${node.className}`;
  row.dataset.flowkey = pageId;
  row.dataset.flowid = node.id;
  row.dataset.bpflip = `flow:${pageId}:${node.id}`;

  const drag = dragHandle();
  armFlowRow(drag, row, pageId, node.id, false);
  const body = document.createElement('div');
  body.className = 'bp-ep-field-body';
  const label = document.createElement('div');
  label.className = 'bp-ep-label';
  label.appendChild(flowBadge(node.className, node.id.includes(':'), true));
  const name = document.createElement('span');
  name.textContent = editPageFieldLabel(node);
  name.dataset.bprename = node.id;
  label.appendChild(name);
  if (node.required) {
    const required = document.createElement('b');
    required.textContent = '*';
    required.title = 'Required';
    label.appendChild(required);
  }
  label.appendChild(pencil(node.id, `Rename "${node.name}"`));
  if (isTempId(node.id)) label.appendChild(cancelAdd(pageId, node.id));
  if (node.prop) {
    const prop = document.createElement('code');
    prop.textContent = node.prop;
    prop.title = 'Property mapping';
    label.appendChild(prop);
  }
  body.appendChild(label);

  const preview = document.createElement('div');
  preview.className = 'bp-ep-control';
  if (node.className === 'ButtonInput') {
    const button = document.createElement('button');
    button.textContent = node.name || 'Button';
    button.disabled = true;
    preview.appendChild(button);
  } else if (node.className === 'EditPageInfo' || node.className === 'Label') {
    preview.classList.add('info');
    preview.textContent = node.className === 'Label' ? 'Text / instructions' : 'Information shown with this page';
  } else if (node.className === 'EditPageValidation') {
    preview.classList.add('validation');
    preview.textContent = 'Validation rule';
  } else {
    const input = document.createElement('div');
    input.className = 'bp-ep-input';
    input.textContent = node.prop ? `Value for ${node.prop}` : 'Value';
    preview.appendChild(input);
  }
  body.appendChild(preview);
  row.append(drag, body);
  return row;
}

function columnBreak(node: FlowNode, pageId: string): HTMLElement {
  const divider = document.createElement('div');
  divider.className = 'bp-ep-colbreak';
  divider.dataset.flowkey = pageId;
  divider.dataset.flowid = node.id;
  const drag = dragHandle();
  armFlowRow(drag, divider, pageId, node.id, false);
  const text = document.createElement('span');
  text.textContent = 'COLUMN';
  divider.append(drag, text);
  if (isTempId(node.id)) divider.appendChild(cancelAdd(pageId, node.id));
  return divider;
}

function liveFormRect(): DOMRect | null {
  const host = document.querySelector('.edit-page, [class*="edit-page"]');
  const rect = host?.getBoundingClientRect();
  return rect && rect.width > 120 ? rect : null;
}

/** Render a standalone EditPage as BMP presents it, while retaining the flat stream for edits. */
export function renderEditPage(m: LModel, layer: HTMLElement): boolean {
  const children = effectiveFlowChildren(m, m.pageId);
  const steps = projectEditPage(children);
  const selected = steps.find(s => s.key === bp.viewTabId) ?? steps[0];
  if (!selected) return false;
  if (bp.viewTabId !== selected.key) bp.viewTabId = selected.key;

  const live = liveFormRect();
  const frame = document.createElement('section');
  frame.className = 'bp-editpage';
  const width = live?.width ?? Math.min(1100, window.innerWidth - 48);
  frame.style.left = `${live ? docX(live.left) : docX((window.innerWidth - width) / 2)}px`;
  frame.style.top = `${live ? docY(live.top) : docY(110)}px`;
  frame.style.width = `${width}px`;

  const title = document.createElement('div');
  title.className = 'bp-ep-title';
  const titleText = document.createElement('span');
  titleText.textContent = m.editPageTitle || m.pageName || 'Edit page';
  title.append(titleText);

  const nav = document.createElement('nav');
  nav.className = 'bp-ep-nav';
  nav.setAttribute('aria-label', 'Edit page steps');
  steps.forEach((step, index) => {
    const button = document.createElement('button');
    button.className = step.key === selected.key ? 'on' : '';
    const number = document.createElement('b');
    number.textContent = String(index + 1);
    const name = document.createElement('span');
    name.textContent = step.title;
    if (step.breakNode) name.dataset.bprename = step.breakNode.id;
    button.append(number, name);
    button.title = `Show ${step.title}`;
    tap(button, () => viewEditPage(step.key));
    if (step.breakNode) button.appendChild(pencil(step.breakNode.id, `Rename page "${step.title}"`));
    if (step.breakNode && isTempId(step.breakNode.id)) button.appendChild(cancelAdd(m.pageId, step.breakNode.id));
    nav.appendChild(button);
  });

  const form = document.createElement('div');
  form.className = 'bp-ep-columns';
  form.style.setProperty('--ep-cols', String(Math.max(1, selected.columns.length)));
  for (const columnNodes of selected.columns) {
    const column = document.createElement('div');
    column.className = 'bp-ep-column';
    for (const node of columnNodes) {
      column.appendChild(node.className === 'EditPageColumnBreak'
        ? columnBreak(node, m.pageId)
        : field(node, m.pageId));
    }
    form.appendChild(column);
  }

  const add = document.createElement('button');
  add.className = 'bp-ep-add';
  const icon = document.createElement('span');
  setIcon(icon, ICON_PLUS);
  add.append(icon, document.createTextNode('Add element'));
  const pageNodes = selected.columns.flat();
  const afterId = pageNodes.at(-1)?.id ?? selected.breakNode?.id;
  tap(add, (e) => openFlowPicker(m.pageId, 'EditPage', { afterId, at: { x: e.clientX, y: e.clientY } }));

  frame.append(title, nav, form, add);
  layer.appendChild(frame);
  return true;
}
