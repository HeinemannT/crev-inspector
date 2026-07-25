import type { TypeSchemaProp } from '../lib/types';
import type { FlowNode, LModel } from '../lib/layout/types';
import { effectiveFlowChildren } from '../lib/layout/flow';
import { intersectTypeSchemas } from '../lib/type-schema-utils';
import { ICON_PENCIL, ICON_PLUS, ICON_X } from '../lib/icons';
import { isTempId } from '../lib/layout/model';
import { bp } from './state';
import { beginRename, cancelFlowAdd, openFlowPicker, selectEditPageField, viewEditPage } from './actions';
import { armFlowRow } from './gestures';
import { setIcon, docX, docY } from './geometry';
import { flowBadge } from './result-flow';
import { projectEditPage } from './edit-page-model';
import { readEditPageLiveGeometry, type EditPageLiveGeometry } from './edit-page-geometry';

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
export function editPageFieldLabel(node: FlowNode, property?: TypeSchemaProp): string {
  if (node.className === 'EditField' && /^edit field$/i.test(node.name.trim()) && node.prop) {
    return property?.label || node.prop.replace(/[_-]+/g, ' ').toUpperCase();
  }
  return node.name || node.className;
}

interface EditPageSchemaView {
  state: 'unavailable' | 'loading' | 'error' | 'ready';
  byAccessor: Map<string, TypeSchemaProp>;
  typeLabel: string;
}

function schemaView(types: readonly string[]): EditPageSchemaView {
  if (!types.length) return { state: 'unavailable', byAccessor: new Map(), typeLabel: '' };
  const schemas = types.flatMap(type => {
    const schema = bp.editPageSchemas.get(type);
    return schema ? [schema] : [];
  });
  const typeLabel = types.join(', ');
  if (schemas.length === types.length) {
    const shared = intersectTypeSchemas(schemas);
    return { state: 'ready', byAccessor: new Map(shared.map(prop => [prop.accessor, prop])), typeLabel };
  }
  if (types.some(type => bp.editPageSchemaPending.has(type))) {
    return { state: 'loading', byAccessor: new Map(), typeLabel };
  }
  if (types.some(type => bp.editPageSchemaErrors.has(type))) {
    return { state: 'error', byAccessor: new Map(), typeLabel };
  }
  return { state: 'loading', byAccessor: new Map(), typeLabel };
}

function humanType(configClass: string): string {
  return configClass
    .replace(/MethodConfig$/, '')
    .replace(/Config$/, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim() || configClass;
}

function propertyLabel(property: TypeSchemaProp): string {
  const label = property.label || property.accessor;
  return label ? label[0].toUpperCase() + label.slice(1) : label;
}

function propertyDetails(node: FlowNode, schema: EditPageSchemaView): HTMLElement | null {
  if (node.className !== 'EditField' || !node.prop) return null;
  const details = document.createElement('div');
  details.className = 'bp-ep-details';
  if (schema.state !== 'ready') {
    const status = document.createElement('span');
    status.className = `bp-ep-schema-state is-${schema.state}`;
    status.textContent = schema.state === 'loading' ? 'Loading property details…'
      : schema.state === 'error' ? 'Property details unavailable'
        : 'No object type configured';
    status.title = schema.typeLabel || 'This Edit Page does not expose a configured business-object type.';
    details.appendChild(status);
    return details;
  }

  const property = schema.byAccessor.get(node.prop);
  if (!property) {
    const status = document.createElement('span');
    status.className = 'bp-ep-schema-state is-error';
    status.textContent = 'Mapping not found in the configured type';
    status.title = `${node.prop} is not shared by ${schema.typeLabel}`;
    details.appendChild(status);
    return details;
  }
  const label = document.createElement('span');
  label.className = 'bp-ep-detail-main';
  label.textContent = propertyLabel(property);
  const kind = document.createElement('span');
  kind.textContent = humanType(property.configClass);
  kind.title = property.configClass;
  const origin = document.createElement('span');
  origin.textContent = property.systemobject ? 'System property' : 'Custom property';
  details.append(label, kind, origin);
  if (property.description) {
    const help = document.createElement('button');
    help.className = 'bp-ep-help';
    help.textContent = '?';
    help.title = property.description;
    help.setAttribute('aria-label', `About ${propertyLabel(property)}`);
    details.appendChild(help);
  }
  return details;
}

function field(node: FlowNode, pageId: string, types: readonly string[], schema: EditPageSchemaView): HTMLElement {
  const row = document.createElement('div');
  const selected = bp.selectedId === node.id;
  row.className = `bp-ep-field kind-${node.className}${selected ? ' selected' : ''}`;
  row.dataset.flowkey = pageId;
  row.dataset.flowid = node.id;
  row.dataset.bpflip = `flow:${pageId}:${node.id}`;
  row.setAttribute('role', 'group');
  row.tabIndex = 0;
  row.setAttribute('aria-label', `${editPageFieldLabel(node)}${selected ? ', selected' : ''}`);
  row.addEventListener('mousedown', (e) => {
    if ((e.target as HTMLElement).closest('button,.bp-ep-drag')) return;
    e.stopPropagation();
    selectEditPageField(node.id, node.className === 'EditField' ? types : []);
  });
  row.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    selectEditPageField(node.id, node.className === 'EditField' ? types : []);
  });

  const drag = dragHandle();
  armFlowRow(drag, row, pageId, node.id, false, true);
  const body = document.createElement('div');
  body.className = 'bp-ep-field-body';
  const label = document.createElement('div');
  label.className = 'bp-ep-label';
  label.appendChild(flowBadge(node.className, node.id.includes(':'), true));
  const name = document.createElement('span');
  const property = schema.state === 'ready' && node.prop ? schema.byAccessor.get(node.prop) : undefined;
  name.textContent = editPageFieldLabel(node, property
    ? { ...property, label: propertyLabel(property) }
    : undefined);
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
    // Blueprint shows the rendered control's footprint, not a second fake
    // form control. Property identity already lives in the header; this quiet
    // wireframe keeps the real row height legible without duplicating BMP's UI.
    preview.classList.add('wire');
    preview.setAttribute('aria-hidden', 'true');
    preview.appendChild(document.createElement('span'));
  }
  body.appendChild(preview);
  if (selected) {
    const details = propertyDetails(node, schema);
    if (details) body.appendChild(details);
  }
  row.append(drag, body);
  return row;
}

function columnGuide(node: FlowNode, pageId: string): HTMLElement {
  const divider = document.createElement('div');
  divider.className = 'bp-ep-colguide';
  divider.dataset.flowkey = pageId;
  divider.dataset.flowid = node.id;
  divider.title = 'Column boundary · drag to move';
  const drag = dragHandle();
  armFlowRow(drag, divider, pageId, node.id, false, true);
  divider.append(drag);
  if (isTempId(node.id)) divider.appendChild(cancelAdd(pageId, node.id));
  return divider;
}

function insertionPoint(
  pageId: string,
  afterId: string | undefined,
  title: string,
  opts: { start?: boolean; height?: number } = {},
): HTMLButtonElement {
  const button = document.createElement('button');
  button.className = `bp-ep-insert${opts.start ? ' is-start' : ''}`;
  if (opts.height !== undefined) button.style.height = `${opts.height}px`;
  button.title = title;
  button.setAttribute('aria-label', title);
  const icon = document.createElement('span');
  setIcon(icon, ICON_PLUS);
  button.appendChild(icon);
  tap(button, (e) => openFlowPicker(pageId, 'EditPage', {
    afterId,
    at: { x: e.clientX, y: e.clientY },
  }));
  return button;
}

interface MeasuredRows {
  geometry: EditPageLiveGeometry;
  heightById: Map<string, number>;
}

function measuredRows(stepKey: string): MeasuredRows | null {
  const geometry = readEditPageLiveGeometry();
  const baseline = bp.baseline;
  if (!geometry || !baseline) return null;
  const baselineSteps = projectEditPage(effectiveFlowChildren(baseline, baseline.pageId));
  const baselineStep = baselineSteps.find(step => step.key === stepKey);
  if (!baselineStep || baselineStep.columns.length !== geometry.columns.length) return null;
  if (baselineStep.columns.some((column, index) =>
    column.nodes.length !== geometry.columns[index]?.slots.length,
  )) return null;

  const heightById = new Map<string, number>();
  baselineStep.columns.forEach((column, columnIndex) => {
    column.nodes.forEach((node, nodeIndex) => {
      heightById.set(node.id, geometry.columns[columnIndex].slots[nodeIndex].height);
    });
  });
  return { geometry, heightById };
}

/** Render a standalone EditPage as BMP presents it, while retaining the flat stream for edits. */
export function renderEditPage(m: LModel, layer: HTMLElement): boolean {
  const children = effectiveFlowChildren(m, m.pageId);
  const steps = projectEditPage(children);
  const selected = steps.find(s => s.key === bp.viewTabId) ?? steps[0];
  if (!selected) return false;
  if (bp.viewTabId !== selected.key) bp.viewTabId = selected.key;

  const measured = measuredRows(selected.key);
  const live = measured?.geometry.host ?? null;
  const frame = document.createElement('section');
  frame.className = `bp-editpage${measured ? ' is-measured' : ''}`;
  const width = live?.width ?? Math.min(1100, window.innerWidth - 48);
  frame.style.left = `${live ? docX(live.left) : docX((window.innerWidth - width) / 2)}px`;
  frame.style.top = `${live ? docY(live.top) : docY(110)}px`;
  frame.style.width = `${width}px`;

  const title = document.createElement('div');
  title.className = 'bp-ep-title';
  const titleText = document.createElement('span');
  titleText.textContent = m.editPageTitle || m.pageName || 'Edit page';
  const widthNote = document.createElement('code');
  widthNote.className = 'bp-ep-width';
  widthNote.textContent = `${Math.round(width)} px`;
  widthNote.title = 'Rendered form width';
  title.append(titleText, widthNote);

  const nav = document.createElement('nav');
  nav.className = 'bp-ep-nav';
  nav.setAttribute('aria-label', 'Edit page steps');
  const selectedIndex = steps.indexOf(selected);
  steps.forEach((step, index) => {
    const item = document.createElement('div');
    item.className = `bp-ep-page${step.key === selected.key ? ' on' : ''}`;
    item.dataset.flowpagekey = step.key;
    item.dataset.flowpageafter = step.breakNode?.id ?? '';
    item.dataset.flowpageoffset = String(index - selectedIndex);
    item.dataset.flowpagetitle = step.title;
    const button = document.createElement('button');
    button.className = 'bp-ep-view';
    const number = document.createElement('b');
    number.textContent = String(index + 1);
    const name = document.createElement('span');
    name.textContent = step.title;
    if (step.breakNode) name.dataset.bprename = step.breakNode.id;
    button.append(number, name);
    button.title = `Show ${step.title}`;
    tap(button, () => viewEditPage(step.key, index - selectedIndex));
    item.appendChild(button);
    if (step.breakNode) item.appendChild(pencil(step.breakNode.id, `Rename page "${step.title}"`));
    if (step.breakNode && isTempId(step.breakNode.id)) item.appendChild(cancelAdd(m.pageId, step.breakNode.id));
    nav.appendChild(item);
  });

  const form = document.createElement('div');
  form.className = 'bp-ep-columns';
  form.style.setProperty('--ep-cols', String(Math.max(1, selected.columns.length)));
  const schema = schemaView(m.editPageTypes ?? []);
  const rowGap = measured?.geometry.rowGap ?? 12;
  const fallbackRowHeight = measured?.geometry.fallbackRowHeight ?? 75;
  selected.columns.forEach((columnModel, columnIndex) => {
    const column = document.createElement('div');
    column.className = `bp-ep-column${columnModel.breakNode ? ' has-guide' : ''}`;
    if (columnModel.breakNode) column.appendChild(columnGuide(columnModel.breakNode, m.pageId));
    const columnStart = columnModel.breakNode?.id
      ?? (columnIndex === 0 ? selected.breakNode?.id : undefined);
    if (columnStart) {
      column.appendChild(insertionPoint(
        m.pageId,
        columnStart,
        'Add at the start of this column',
        { start: true, height: measured ? 0 : undefined },
      ));
    }
    columnModel.nodes.forEach((node, nodeIndex) => {
      const row = field(node, m.pageId, m.editPageTypes ?? [], schema);
      if (measured) row.style.minHeight = `${measured.heightById.get(node.id) ?? fallbackRowHeight}px`;
      column.appendChild(row);
      const isFinalNode = columnIndex === selected.columns.length - 1
        && nodeIndex === columnModel.nodes.length - 1;
      if (!isFinalNode) {
        column.appendChild(insertionPoint(
          m.pageId,
          node.id,
          `Add after ${editPageFieldLabel(node)}`,
          { height: measured ? rowGap : undefined },
        ));
      }
    });
    form.appendChild(column);
  });

  const add = document.createElement('button');
  add.className = 'bp-ep-add';
  const icon = document.createElement('span');
  setIcon(icon, ICON_PLUS);
  add.append(icon, document.createTextNode('Add element'));
  const lastColumn = selected.columns.at(-1);
  const afterId = lastColumn?.nodes.at(-1)?.id ?? lastColumn?.breakNode?.id ?? selected.breakNode?.id;
  tap(add, (e) => openFlowPicker(m.pageId, 'EditPage', { afterId, at: { x: e.clientX, y: e.clientY } }));

  if (measured) {
    const { geometry } = measured;
    const titleBox = geometry.title;
    const navBox = geometry.nav;
    if (titleBox) {
      Object.assign(title.style, {
        left: `${titleBox.left - 1}px`, top: `${titleBox.top - 2}px`,
        width: `${titleBox.width}px`, height: `${titleBox.height}px`,
      });
    }
    if (navBox) {
      Object.assign(nav.style, {
        left: `${navBox.left - 1}px`, top: `${navBox.top - 2}px`,
        width: `${navBox.width}px`, height: `${navBox.height}px`,
        gridTemplateColumns: `repeat(${steps.length},minmax(0,1fr))`,
      });
    }
    Object.assign(form.style, {
      left: `${geometry.content.left - 1}px`, top: `${geometry.content.top - 2}px`,
      width: `${geometry.content.width}px`,
      gridTemplateColumns: geometry.columns.map(column => `${column.width}px`).join(' '),
      columnGap: `${geometry.columns.length > 1
        ? Math.max(0, geometry.columns[1].left - (geometry.columns[0].left + geometry.columns[0].width))
        : 0}px`,
    });
    const columnHeights = selected.columns.map(column =>
      column.nodes.reduce((sum, node, index) =>
        sum + (measured.heightById.get(node.id) ?? fallbackRowHeight)
          + (index < column.nodes.length - 1 ? rowGap : 0), 0),
    );
    const formHeight = Math.max(0, ...columnHeights);
    Object.assign(add.style, {
      left: `${geometry.content.left + 18}px`,
      top: `${geometry.content.top + formHeight + 8}px`,
    });
    frame.style.height = `${Math.max(
      live?.height ?? 0,
      geometry.content.top + formHeight + 52,
    )}px`;
  }

  frame.append(title, nav, form, add);
  layer.appendChild(frame);
  return true;
}
