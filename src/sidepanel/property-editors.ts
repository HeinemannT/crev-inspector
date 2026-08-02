/**
 * Typed property editors for the object pane. Each function takes a current
 * value + onChange callback and returns a single HTMLElement. Editors stay
 * intentionally small — the DetailView owns dirty state and persistence.
 */

import { h } from '../lib/dom';
import { enumMember } from '../lib/color-util';
import { propertyPicker } from '../lib/property-picker';

let editorId = 0;
const nextEditorId = (kind: string): string => `crev-prop-${kind}-${++editorId}`;

export type PropValue = string;

export interface PropEditorContext {
  value: PropValue;
  /** Original server value (drives the dirty-vs-original comparison) */
  original: PropValue;
  dirty: boolean;
  onChange: (next: PropValue) => void;
}

/** Linked-colour cell: a swatch + name button that opens the colour picker.
 *  BMP colours are CorpoColor LINKS, not hex — so there's no text input; the
 *  value flows back through ctx.onChange (called by the picker on pick). */
export function colorLinkEditor(
  ctx: PropEditorContext,
  opts: { name: string; rgb: string | null; onOpen: (anchor: HTMLElement) => void },
): HTMLElement {
  const btn = h('button', {
    class: 'prop-color-link',
    title: opts.name ? `Linked colour: ${opts.name}. Click to change.` : 'No linked colour. Click to pick one.',
    onClick: (e: Event) => opts.onOpen(e.currentTarget as HTMLElement),
  },
    h('span', { class: `prop-color-swatch${opts.rgb ? '' : ' prop-color-swatch--none'}`, style: opts.rgb ? `background:${opts.rgb}` : '' }),
    h('span', { class: 'prop-color-link-name' }, opts.name || 'Link a colour…'),
  );
  return h('div', { class: `prop-cell prop-cell--color${ctx.dirty ? ' prop-cell--dirty' : ''}` }, btn);
}

export function booleanEditor(ctx: PropEditorContext): HTMLElement {
  // BMP serializes booleans as the strings "true" / "false" (or empty when unset).
  const checked = ctx.value === 'true' || ctx.value === 'TRUE';
  const toggle = h('button', {
    class: `prop-toggle${checked ? ' prop-toggle--on' : ''}`,
    role: 'switch',
    'aria-checked': checked ? 'true' : 'false',
    onClick: () => ctx.onChange(checked ? 'false' : 'true'),
  },
    h('span', { class: 'prop-toggle-track' },
      h('span', { class: 'prop-toggle-thumb' }),
    ),
    h('span', { class: 'prop-toggle-label' }, checked ? 'On' : 'Off'),
  );
  return h('div', { class: `prop-cell prop-cell--bool${ctx.dirty ? ' prop-cell--dirty' : ''}` }, toggle);
}

export function numberEditor(ctx: PropEditorContext, opts: { unit?: string; min?: number; max?: number; step?: number } = {}): HTMLElement {
  const input = h('input', {
    id: nextEditorId('number'),
    class: `prop-number-input${ctx.dirty ? ' prop-cell--dirty' : ''}`,
    type: 'number',
    value: ctx.value,
    ...(opts.min != null ? { min: opts.min } : {}),
    ...(opts.max != null ? { max: opts.max } : {}),
    ...(opts.step != null ? { step: opts.step } : { step: 1 }),
  }) as HTMLInputElement;
  // Commit on change rather than every keystroke. Hosts rebuild their property
  // document after a draft changes; committing on input would replace the
  // focused field after the first digit.
  input.addEventListener('change', () => ctx.onChange(input.value));
  const children: (HTMLElement | string)[] = [input];
  if (opts.unit) children.push(h('span', { class: 'prop-unit' }, opts.unit));
  return h('div', { class: `prop-cell prop-cell--number${ctx.dirty ? ' prop-cell--dirty' : ''}` }, ...children);
}

/** Plain writable BMP string property. Keep this separate from the `text`
 * renderer, which deliberately presents structured/opaque values read-only. */
export function stringEditor(ctx: PropEditorContext, placeholder = ''): HTMLElement {
  const input = h('input', {
    id: nextEditorId('string'),
    class: `prop-string-input${ctx.dirty ? ' prop-cell--dirty' : ''}`,
    type: 'text',
    value: ctx.value,
    placeholder,
    autocomplete: 'off',
    spellcheck: 'false',
  }) as HTMLInputElement;
  // Commit on change (blur/Enter), not every keystroke. The object panes
  // rebuild their property tree after a draft changes; an `input` listener
  // would detach the focused control after the first character.
  input.addEventListener('change', () => ctx.onChange(input.value));
  return h('div', { class: `prop-cell prop-cell--string${ctx.dirty ? ' prop-cell--dirty' : ''}` }, input);
}

export interface EnumOption {
  value: string;
  label?: string;
  propertyId?: string;
  configClass?: string;
}

// BMP returns enum values qualified ("HeaderStyle.INSIDE") while the schema lists bare tokens ("INSIDE"),
// which is what `_o.change(headerStyle := "INSIDE")` accepts on save. enumMember (shared, color-util)
// strips the prefix + case-folds for the comparison key; the display value stays as-is so we never
// silently uppercase legacy data on save.
const enumCompareKey = enumMember;

export function enumEditor(ctx: PropEditorContext, options: EnumOption[]): HTMLElement {
  const select = h('select', {
    id: nextEditorId('enum'),
    class: 'prop-select',
  }) as HTMLSelectElement;
  const normalized = enumCompareKey(ctx.value);
  const matching = options.find(opt => enumCompareKey(opt.value) === normalized);
  for (const opt of options) {
    const o = document.createElement('option');
    o.value = opt.value;
    o.textContent = opt.label ?? opt.value;
    select.appendChild(o);
  }
  // If current value isn't in options, surface it explicitly so the user sees it.
  if (!matching) {
    const o = document.createElement('option');
    o.value = ctx.value;
    o.textContent = ctx.value ? `${ctx.value} (custom)` : '(none)';
    select.appendChild(o);
  }
  // Set the value after all options are attached. Some DOM implementations
  // reselect an adjacent option while later options are appended.
  select.value = matching?.value ?? ctx.value;
  // Always save the bare token form — that's what _o.change() expects. If
  // the user picks "Inside" from the dropdown, send "INSIDE", not the
  // qualified "HeaderStyle.INSIDE" form.
  select.addEventListener('change', () => ctx.onChange(select.value));
  return h('div', { class: `prop-cell prop-cell--enum${ctx.dirty ? ' prop-cell--dirty' : ''}` }, select);
}

/** EditField propertyMapping picker. The shared combobox keeps the exact BMP
 * accessor as its value while presenting the master property ID and type badge. */
export function propertyAccessorEditor(
  ctx: PropEditorContext,
  options: EnumOption[] | undefined,
  opts: { loading?: boolean; source?: string; error?: string } = {},
): HTMLElement {
  const effectiveOptions = [...(options ?? [])];
  if (ctx.value && !effectiveOptions.some(opt => opt.value === ctx.value)) {
    effectiveOptions.unshift({
      value: ctx.value,
      propertyId: ctx.value,
      label: `${ctx.value} (current)`,
    });
  }
  const ready = options !== undefined;
  const picker = propertyPicker({
    value: ctx.value,
    disabled: !ready,
    placeholder: opts.loading ? 'Loading properties…' : opts.error ? 'Properties unavailable' : 'Select property',
    title: opts.source ? `Properties shared by ${opts.source}` : 'Business-object property',
    options: effectiveOptions,
    onChange: ctx.onChange,
    density: 'standard',
  });
  return h('div', {
    class: `prop-cell prop-cell--property${ctx.dirty ? ' prop-cell--dirty' : ''}`,
  }, picker);
}

export function sliderEditor(
  ctx: PropEditorContext,
  opts: { min: number; max: number; step?: number; unit?: string },
): HTMLElement {
  const slider = h('input', {
    id: nextEditorId('slider'),
    class: 'prop-slider',
    type: 'range',
    min: opts.min,
    max: opts.max,
    step: opts.step ?? 1,
    value: ctx.value || String(opts.min),
  }) as HTMLInputElement;
  const unit = opts.unit ?? '';
  const display = h('span', { class: 'prop-slider-value' }, (ctx.value || String(opts.min)) + unit);
  // 'input' fires on every micro-movement during a drag. If we commit each
  // one through ctx.onChange, the parent re-renders the whole pane on every
  // tick and yanks the slider out from under the user's pointer — the drag
  // dies after a single tick because the DOM element is gone. Update the
  // display label only during the drag; commit the value when the user
  // releases (change event) or steps via keyboard.
  slider.addEventListener('input', () => {
    display.textContent = slider.value + unit;
  });
  slider.addEventListener('change', () => {
    ctx.onChange(slider.value);
  });
  return h('div', { class: `prop-cell prop-cell--slider${ctx.dirty ? ' prop-cell--dirty' : ''}` }, slider, display);
}

/** Format a value for display in the save-confirmation modal. Falls back to
 *  "(empty)" for unset values so the diff reads cleanly. */
export function displayValue(v: PropValue): string {
  if (v === '' || v == null) return '(empty)';
  if (v === 'true' || v === 'TRUE') return 'on';
  if (v === 'false' || v === 'FALSE') return 'off';
  return v;
}
