import type { LModel, LNode } from '../lib/layout/types';
import { descriptionViewSourceType, hasEditableDescriptionViewSource } from '../lib/layout/description-view';
import { propertyPicker } from '../lib/property-picker';
import { CE_TYPES } from '../lib/object-types';
import { ICON_X } from '../lib/icons';
import { setIcon } from './geometry';
import { bp } from './state';
import { saveDescriptionProperties, setDescriptionSource } from './actions';

function stopControls(element: HTMLElement): void {
  element.addEventListener('mousedown', event => event.stopPropagation());
  element.addEventListener('click', event => event.stopPropagation());
}

function sourceControl(model: LModel, node: LNode, source: string): HTMLElement {
  const group = document.createElement('label'); group.className = 'bp-dv-source';
  const caption = document.createElement('span'); caption.textContent = 'From'; group.appendChild(caption);
  if (!hasEditableDescriptionViewSource(model, node)) {
    const fixed = document.createElement('code'); fixed.textContent = source || model.pageClass;
    fixed.title = 'Classic Description Views use the current page object';
    group.appendChild(fixed);
    return group;
  }

  const select = document.createElement('select');
  select.setAttribute('aria-label', 'Description properties source');
  select.title = 'Enterprise object whose properties this view displays';
  const inferred = model.enterpriseObjectType ?? '';
  const choices = [...new Set([source, inferred, ...CE_TYPES].filter(Boolean))].sort((a, b) => a.localeCompare(b));
  if (!source) {
    const placeholder = document.createElement('option');
    placeholder.value = ''; placeholder.textContent = 'Select enterprise object'; placeholder.disabled = true;
    select.appendChild(placeholder);
  }
  for (const type of choices) {
    const option = document.createElement('option'); option.value = type;
    const human = type.replace(/^Ce/, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2');
    // Native select popups size themselves from option labels on Windows. Keep the visible label to
    // the exact BMP class token so a long explanatory suffix cannot escape a narrow DescriptionView.
    option.textContent = type;
    option.title = `${human}${type === inferred ? ' (current object)' : ''}`;
    select.appendChild(option);
  }
  select.value = source;
  select.addEventListener('change', () => { if (select.value) setDescriptionSource(node.id, select.value); });
  group.appendChild(select);
  stopControls(group);
  return group;
}

function rowAction(label: string, text: string, disabled: boolean, action: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'bp-dv-property-move'; button.textContent = text;
  button.disabled = disabled; button.title = label; button.setAttribute('aria-label', label);
  button.addEventListener('click', action);
  return button;
}

/** The model-native DescriptionView body. Summary rows remain visible when the cell is not selected;
 *  selecting it turns the same surface into an inline add/remove/reorder editor. */
export function descriptionViewBody(model: LModel, node: LNode, editing: boolean): HTMLElement {
  const source = descriptionViewSourceType(model, node);
  const schema = source ? bp.propertySchemas.get(source) : undefined;
  const loading = source ? bp.propertySchemaPending.has(source) : false;
  const error = source ? bp.propertySchemaErrors.get(source) : undefined;
  const selected = node.sortVisibility ?? [];
  const byAccessor = new Map((schema ?? []).map(property => [property.accessor, property]));

  const root = document.createElement('div'); root.className = `bp-dv-body${editing ? ' is-editing' : ''}`;
  const head = document.createElement('div'); head.className = 'bp-dv-head';
  const title = document.createElement('span'); title.className = 'bp-dv-title'; title.textContent = 'Properties';
  const count = document.createElement('code'); count.className = 'bp-dv-count'; count.textContent = String(selected.length);
  head.append(title, count, sourceControl(model, node, source)); root.appendChild(head);

  const list = document.createElement('div'); list.className = 'bp-dv-property-list';
  const shown = editing ? selected : selected.slice(0, 4);
  if (!shown.length) {
    const empty = document.createElement('div'); empty.className = 'bp-dv-empty';
    empty.textContent = selected.length ? '' : 'BMP default properties'; list.appendChild(empty);
  }
  shown.forEach((accessor, index) => {
    const property = byAccessor.get(accessor);
    const row = document.createElement('div'); row.className = 'bp-dv-property-row';
    const copy = document.createElement('span'); copy.className = 'bp-dv-property-copy';
    const name = document.createElement('span'); name.className = 'bp-dv-property-name'; name.textContent = property?.label || accessor;
    const id = document.createElement('code'); id.textContent = property?.propertyId || accessor;
    copy.append(name, id); row.appendChild(copy);
    if (editing) {
      const up = rowAction(`Move ${accessor} up`, '↑', index === 0, () => {
        const next = [...selected]; [next[index - 1], next[index]] = [next[index]!, next[index - 1]!];
        saveDescriptionProperties(node.id, next);
      });
      const down = rowAction(`Move ${accessor} down`, '↓', index === selected.length - 1, () => {
        const next = [...selected]; [next[index], next[index + 1]] = [next[index + 1]!, next[index]!];
        saveDescriptionProperties(node.id, next);
      });
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'bp-dv-property-remove';
      remove.title = `Hide ${accessor}`; remove.setAttribute('aria-label', remove.title); setIcon(remove, ICON_X);
      remove.addEventListener('click', () => saveDescriptionProperties(node.id, selected.filter(value => value !== accessor)));
      row.append(up, down, remove); stopControls(row);
    }
    list.appendChild(row);
  });
  if (!editing && selected.length > shown.length) {
    const more = document.createElement('div'); more.className = 'bp-dv-more';
    more.textContent = `+${selected.length - shown.length} more`; list.appendChild(more);
  }
  root.appendChild(list);

  if (editing) {
    if (schema) {
      const add = propertyPicker({
        value: '',
        options: schema.filter(property => !selected.includes(property.accessor)).map(property => ({
          value: property.accessor,
          label: property.label || property.accessor,
          propertyId: property.propertyId || property.accessor,
          configClass: property.propertyConfigClass || property.configClass,
        })),
        density: 'compact', allowClear: false, placeholder: 'Add property', ariaLabel: 'Add visible property',
        onChange: value => { if (value && !selected.includes(value)) saveDescriptionProperties(node.id, [...selected, value]); },
      });
      add.classList.add('bp-dv-property-add'); stopControls(add); root.appendChild(add);
    } else {
      const status = document.createElement('div'); status.className = 'bp-dv-schema-status';
      status.textContent = loading ? 'Loading properties…' : error || 'Property schema unavailable';
      root.appendChild(status);
    }
  }
  return root;
}
