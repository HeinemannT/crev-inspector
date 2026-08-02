import type { TypeSchemaProp } from '../lib/types';
import type { FlowNode, FlowProjection, LModel } from '../lib/layout/types';
import { effectiveFlowChildren } from '../lib/layout/flow';
import { intersectTypeSchemas } from '../lib/type-schema-utils';
import { propertyPicker } from '../lib/property-picker';
import {
  ICON_COLUMNS,
  ICON_INFO,
  ICON_PENCIL,
  ICON_PLUS,
  ICON_TRASH,
  ICON_VARIABLE,
  ICON_WARNING,
} from '../lib/icons';
import { isTempId } from '../lib/layout/model';
import { bp } from './state';
import {
  beginRename,
  changeEditFieldProperty,
  doDeleteFlowChild,
  inspectMappedProperty,
  openFlowPicker,
  selectEditPageField,
  viewEditPage,
} from './actions';
import { armFlowRow } from './gestures';
import { docX, docY, setIcon } from './geometry';
import { flowBadge } from './flow-badge';
import { projectEditPage } from './edit-page-model';
import { readEditPageLiveGeometry } from './edit-page-geometry';
import { setNativeEditPageSuppressed, trackNativeEditPage } from './edit-page-native';

interface EditPageSchemaView {
  state: 'unavailable' | 'loading' | 'error' | 'ready';
  properties: TypeSchemaProp[];
  byAccessor: Map<string, TypeSchemaProp>;
  typeLabel: string;
}

function schemaView(types: readonly string[]): EditPageSchemaView {
  if (!types.length) {
    return { state: 'unavailable', properties: [], byAccessor: new Map(), typeLabel: '' };
  }
  const schemas = types.flatMap(type => {
    const schema = bp.editPageSchemas.get(type);
    return schema ? [schema] : [];
  });
  const typeLabel = types.join(' + ');
  if (schemas.length === types.length) {
    const properties = intersectTypeSchemas(schemas).sort((a, b) =>
      Number(a.systemobject) - Number(b.systemobject)
      || (a.label || a.accessor).localeCompare(b.label || b.accessor));
    return {
      state: 'ready',
      properties,
      byAccessor: new Map(properties.map(property => [property.accessor, property])),
      typeLabel,
    };
  }
  if (types.some(type => bp.editPageSchemaErrors.has(type))) {
    return { state: 'error', properties: [], byAccessor: new Map(), typeLabel };
  }
  return { state: 'loading', properties: [], byAccessor: new Map(), typeLabel };
}

/** Property mappings used by more than one EditField. Empty mappings are not
 * duplicates because they intentionally mean "not configured". */
export function duplicateEditFieldMappings(children: readonly FlowNode[]): Map<string, string[]> {
  const byAccessor = new Map<string, string[]>();
  for (const child of children) {
    if (child.className !== 'EditField' || !child.prop?.trim()) continue;
    const ids = byAccessor.get(child.prop) ?? [];
    ids.push(child.id);
    byAccessor.set(child.prop, ids);
  }
  return new Map([...byAccessor].filter(([, ids]) => ids.length > 1));
}

/** Stock BMP EditFields are commonly all named "Edit field"; the property is
 * the useful canvas label in that case. */
export function editPageFieldLabel(node: FlowNode, property?: TypeSchemaProp): string {
  if (node.className === 'EditField' && /^edit field$/i.test(node.name.trim()) && node.prop) {
    return property?.label || node.prop.replace(/[_-]+/g, ' ').toUpperCase();
  }
  return node.name || node.className;
}

function activate(element: HTMLElement, action: () => void): void {
  element.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    action();
  });
}

function iconButton(icon: string, title: string, action: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.className = 'bp-ep-tool-action';
  button.title = title;
  button.setAttribute('aria-label', title);
  setIcon(button, icon);
  activate(button, action);
  return button;
}

function dragHandle(): HTMLElement {
  const handle = document.createElement('span');
  handle.className = 'bp-ep-drag';
  handle.title = 'Drag to reorder';
  for (let index = 0; index < 3; index++) handle.appendChild(document.createElement('i'));
  return handle;
}

function propertySelector(
  node: FlowNode,
  pageId: string,
  schema: EditPageSchemaView,
): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = 'bp-ep-property-control';

  const picker = propertyPicker({
    value: node.prop ?? '',
    options: schema.properties.map(property => ({
      value: property.accessor,
      label: property.label || property.accessor,
      propertyId: property.propertyId || property.accessor,
      configClass: property.propertyConfigClass || property.configClass,
    })),
    density: 'compact',
    disabled: schema.state !== 'ready',
    ariaLabel: `Property for ${node.id}`,
    title: schema.state === 'ready'
    ? `Properties shared by ${schema.typeLabel}`
    : schema.state === 'loading'
      ? 'Loading properties…'
      : schema.state === 'error'
        ? 'Properties unavailable'
        : 'No object type configured on this EditPage',
    placeholder: schema.state === 'loading'
      ? 'Loading…'
      : schema.state === 'error'
        ? 'Unavailable'
        : 'No property',
    onChange: value => {
      changeEditFieldProperty(pageId, node.id, value);
    },
  });
  picker.classList.add('bp-ep-property-picker');
  wrap.addEventListener('click', event => event.stopPropagation());
  wrap.addEventListener('mousedown', event => event.stopPropagation());
  wrap.appendChild(picker);

  const property = node.prop ? schema.byAccessor.get(node.prop) : undefined;
  const inspect = iconButton(
    ICON_VARIABLE,
    property?.propertyRid
      ? `Open property ${property.propertyId || property.accessor}`
      : 'Property object unavailable',
    () => {
      if (property?.propertyRid) inspectMappedProperty(property.propertyRid);
    },
  );
  inspect.classList.add('bp-ep-property-open');
  inspect.disabled = !property?.propertyRid;
  wrap.appendChild(inspect);
  return wrap;
}

function selectionToolbar(
  node: FlowNode,
  pageId: string,
  schema: EditPageSchemaView,
  protectedNode = false,
): HTMLElement {
  const toolbar = document.createElement('div');
  toolbar.className = 'bp-ep-toolbar';
  toolbar.setAttribute('role', 'toolbar');
  toolbar.setAttribute('aria-label', `${node.id} actions`);
  toolbar.appendChild(flowBadge(node.className, isTempId(node.id), true));

  const id = document.createElement('code');
  id.className = 'bp-ep-object-id';
  id.textContent = node.id;
  id.dataset.bprename = node.id;
  toolbar.appendChild(id);

  if (node.className === 'EditField') toolbar.appendChild(propertySelector(node, pageId, schema));
  toolbar.appendChild(iconButton(ICON_PENCIL, `Rename ${node.id}`, () => beginRename(node.id)));
  if (!protectedNode) {
    const remove = iconButton(
      ICON_TRASH,
      isTempId(node.id) ? 'Cancel staged add' : `Delete ${node.id}`,
      () => doDeleteFlowChild(pageId, node.id),
    );
    remove.classList.add('is-delete');
    toolbar.appendChild(remove);
  }
  return toolbar;
}

function selectable(
  node: FlowNode,
  pageId: string,
  types: readonly string[],
  schema: EditPageSchemaView,
  className: string,
  protectedNode = false,
): HTMLElement {
  const element = document.createElement('div');
  const selected = bp.selectedId === node.id;
  element.className = `${className}${selected ? ' selected' : ''}`;
  element.dataset.flowkey = pageId;
  element.dataset.flowid = node.id;
  element.dataset.bpflip = `flow:${pageId}:${node.id}`;
  element.tabIndex = 0;
  element.setAttribute('role', 'button');
  element.setAttribute('aria-label', `${node.className} ${node.id}${selected ? ', selected' : ''}`);
  element.addEventListener('click', event => {
    if ((event.target as HTMLElement).closest('button,select,.bp-ep-drag')) return;
    event.preventDefault();
    event.stopPropagation();
    selectEditPageField(node.id, node.className === 'EditField' ? types : []);
  });
  element.addEventListener('keydown', event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    selectEditPageField(node.id, node.className === 'EditField' ? types : []);
  });
  if (selected) element.appendChild(selectionToolbar(node, pageId, schema, protectedNode));
  return element;
}

function insertionPoint(pageId: string, afterId: string | null | undefined, label: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.className = 'bp-ep-insert';
  button.title = label;
  button.setAttribute('aria-label', label);
  const icon = document.createElement('span');
  setIcon(icon, ICON_PLUS);
  button.appendChild(icon);
  activate(button, () => openFlowPicker(pageId, 'EditPage', { afterId }));
  return button;
}

function fieldCard(
  node: FlowNode,
  pageId: string,
  types: readonly string[],
  schema: EditPageSchemaView,
  columnStartId: string | undefined,
  firstInColumn: boolean,
  duplicateIds: readonly string[] | undefined,
): HTMLElement {
  const card = selectable(node, pageId, types, schema, `bp-ep-field kind-${node.className}`);
  if (columnStartId) card.dataset.flowstart = columnStartId;
  if (firstInColumn) card.dataset.flowfirst = 'true';

  card.appendChild(flowBadge(node.className, isTempId(node.id), true));
  const identity = document.createElement('code');
  identity.className = 'bp-ep-field-id';
  identity.textContent = node.id;
  identity.title = node.name || node.className;
  card.appendChild(identity);

  if (node.className === 'EditField') {
    const property = schema.byAccessor.get(node.prop ?? '');
    const mapping = document.createElement('span');
    mapping.className = 'bp-ep-field-property';
    mapping.textContent = node.prop
      ? (property?.propertyId || node.prop)
      : 'No property';
    mapping.title = node.prop
      ? `${property?.label || node.prop} · propertyMapping`
      : 'This EditField has no property mapping';
    card.appendChild(mapping);
  } else if (node.className === 'EditPageInfo') {
    const icon = document.createElement('span');
    icon.className = 'bp-ep-structural-icon bp-ep-info-icon';
    icon.title = 'Information (read-only content)';
    icon.setAttribute('aria-label', 'Information (read-only content)');
    setIcon(icon, ICON_INFO);
    card.appendChild(icon);
  }

  if (duplicateIds) {
    const warning = document.createElement('span');
    warning.className = 'bp-ep-duplicate';
    warning.title = `Duplicate property mapping: also used by ${duplicateIds.filter(id => id !== node.id).join(', ')}`;
    setIcon(warning, ICON_WARNING);
    card.appendChild(warning);
  }

  const drag = dragHandle();
  armFlowRow(drag, card, pageId, node.id, false, true);
  card.appendChild(drag);
  return card;
}

function columnObject(
  node: FlowNode,
  pageId: string,
  schema: EditPageSchemaView,
): HTMLElement {
  const object = selectable(node, pageId, [], schema, 'bp-ep-column-object');
  object.appendChild(flowBadge(node.className, isTempId(node.id), true));
  const id = document.createElement('code');
  id.textContent = node.id;
  object.appendChild(id);
  const icon = document.createElement('span');
  icon.className = 'bp-ep-structural-icon bp-ep-column-icon';
  icon.title = 'Column break (layout structure)';
  icon.setAttribute('aria-label', 'Column break (layout structure)');
  setIcon(icon, ICON_COLUMNS);
  object.appendChild(icon);
  const drag = dragHandle();
  armFlowRow(drag, object, pageId, node.id, false, true);
  object.appendChild(drag);
  return object;
}

interface EditPageSurfaceOptions {
  pageId: string;
  pageName?: string;
  types: readonly string[];
  embedded: boolean;
  drivesNativeForm: boolean;
}

/** Build the model-driven part of an EditPage editor without deciding where it is hosted. Standalone
 * routes and inline CreateObjectViews deliberately share this renderer and the root model's history. */
function editPageSurface(m: LModel, options: EditPageSurfaceOptions): HTMLElement | null {
  const { pageId, pageName, types, embedded, drivesNativeForm } = options;
  const children = effectiveFlowChildren(m, pageId);
  const steps = projectEditPage(children);
  const selected = steps.find(step => step.key === bp.editPageViewKeys.get(pageId)) ?? steps[0];
  if (!selected) return null;
  if (bp.editPageViewKeys.get(pageId) !== selected.key) bp.editPageViewKeys.set(pageId, selected.key);

  const schema = schemaView(types);
  const duplicates = duplicateEditFieldMappings(children);
  const duplicateById = new Map<string, string[]>();
  for (const ids of duplicates.values()) for (const id of ids) duplicateById.set(id, ids);

  const frame = document.createElement('section');
  frame.className = `bp-editpage${embedded ? ' is-embedded' : ' is-standalone'}`;
  frame.setAttribute('aria-label', 'Edit page Blueprint');

  if (!embedded) {
    const context = document.createElement('div');
    context.className = 'bp-ep-context';
    const pageIdentity = document.createElement('span');
    pageIdentity.className = 'bp-ep-context-identity';
    const title = document.createElement('strong');
    title.textContent = m.flowEdits?.[pageId]?.rename ?? pageName ?? pageId;
    title.dataset.bprename = pageId;
    title.title = 'EditPage name';
    const rename = iconButton(ICON_PENCIL, 'Rename EditPage', () => beginRename(pageId));
    pageIdentity.append(title, rename);
    const type = document.createElement('code');
    type.textContent = types.join(' + ') || 'No object type';
    context.append(pageIdentity, type);
    frame.appendChild(context);
  }

  const pages = document.createElement('div');
  pages.className = 'bp-ep-pages';
  steps.forEach((step, index) => {
    let page: HTMLElement;
    if (step.breakNode) {
      page = selectable(
        step.breakNode,
        pageId,
        [],
        schema,
        `bp-ep-page${step.key === selected.key ? ' on' : ''}`,
        index === 0,
      );
      page.dataset.flowpageafter = step.breakNode.id;
      page.dataset.flowpageoffset = String(index - steps.indexOf(selected));
    } else {
      page = document.createElement('button');
      page.className = `bp-ep-page bp-ep-page--implicit${step.key === selected.key ? ' on' : ''}`;
    }
    page.dataset.flowpagekey = step.key;
    page.dataset.flowpagetitle = step.title;
    const label = document.createElement('span');
    label.className = 'bp-ep-page-label';
    label.textContent = step.title;
    page.appendChild(label);
    page.addEventListener('click', event => {
      if ((event.target as HTMLElement).closest('.bp-ep-toolbar')) return;
      event.preventDefault();
      event.stopPropagation();
      viewEditPage(pageId, step.key, 0, drivesNativeForm);
    });
    pages.appendChild(page);
  });
  frame.appendChild(pages);

  const surface = document.createElement('div');
  surface.className = 'bp-ep-model-surface';
  const columns = document.createElement('div');
  columns.className = 'bp-ep-columns';
  columns.style.gridTemplateColumns = `repeat(${Math.max(1, selected.columns.length)}, minmax(0, 1fr))`;
  selected.columns.forEach(columnModel => {
    const column = document.createElement('section');
    column.className = `bp-ep-column${columnModel.breakNode ? ' has-break' : ''}`;
    const columnStart = columnModel.breakNode?.id ?? selected.breakNode?.id;
    if (columnModel.breakNode) {
      column.appendChild(columnObject(columnModel.breakNode, pageId, schema));
    }

    columnModel.nodes.forEach((node, index) => {
      const afterId = index === 0 ? (columnStart ?? null) : columnModel.nodes[index - 1]?.id;
      column.appendChild(insertionPoint(
        pageId,
        afterId,
        index === 0 ? 'Add at the start of this column' : `Add before ${node.id}`,
      ));
      column.appendChild(fieldCard(
        node,
        pageId,
        types,
        schema,
        columnStart,
        index === 0,
        duplicateById.get(node.id),
      ));
    });
    const afterId = columnModel.nodes.at(-1)?.id ?? columnStart ?? null;
    const add = insertionPoint(pageId, afterId, 'Add element');
    add.classList.add('bp-ep-add');
    column.appendChild(add);
    columns.appendChild(column);
  });
  surface.appendChild(columns);
  frame.appendChild(surface);
  return frame;
}

/** Local EditPage editor used by a CreateObjectView inside the normal page Blueprint. It is a view
 * projection only: property/reorder/add mutations still target the root LModel's shared flowEdits. */
export function embeddedEditPage(m: LModel, projection: FlowProjection): HTMLElement | null {
  if (!projection.refId || projection.refClass !== 'EditPage') return null;
  return editPageSurface(m, {
    pageId: projection.refId,
    pageName: projection.refName,
    types: projection.objectTypeClass ? [projection.objectTypeClass] : [],
    embedded: true,
    drivesNativeForm: false,
  });
}

/** Render a fully model-driven standalone EditPage Blueprint. The native form supplies only the host
 * bounds; an opaque Blueprint representation is the editing surface from the first frame. */
export function renderEditPage(m: LModel, layer: HTMLElement): boolean {
  const live = readEditPageLiveGeometry();
  if (!live) return false;
  const frame = editPageSurface(m, {
    pageId: m.pageId,
    pageName: m.pageName,
    types: m.editPageTypes ?? [],
    embedded: false,
    drivesNativeForm: true,
  });
  if (!frame) return false;

  const workspace = document.createElement('div');
  workspace.className = 'bp-editpage-workspace is-model-driven';
  workspace.style.left = `${docX(live.host.left)}px`;
  workspace.style.top = `${docY(live.host.top)}px`;
  workspace.style.width = `${live.host.width}px`;
  workspace.style.minHeight = `${Math.max(live.host.height, 420)}px`;
  const peekActive = bp.peek || layer.classList.contains('bp-peek');
  trackNativeEditPage(live.hostElement);
  setNativeEditPageSuppressed(!peekActive);
  workspace.inert = peekActive;
  workspace.setAttribute('aria-hidden', String(peekActive));
  workspace.appendChild(frame);
  layer.appendChild(workspace);
  return true;
}
