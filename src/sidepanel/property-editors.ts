/**
 * Typed property editors for the object pane. Each function takes a current
 * value + onChange callback and returns a single HTMLElement. Editors stay
 * intentionally small — the DetailView owns dirty state and persistence.
 */

import { h } from '../lib/dom';

export type PropValue = string;

export interface PropEditorContext {
  value: PropValue;
  /** Original server value (drives the dirty-vs-original comparison) */
  original: PropValue;
  dirty: boolean;
  onChange: (next: PropValue) => void;
}

/** Hex-or-shorthand color check. BMP accepts #rgb and #rrggbb. */
const HEX_COLOR = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export function colorEditor(ctx: PropEditorContext): HTMLElement {
  const isValidColor = ctx.value === '' || HEX_COLOR.test(ctx.value);
  const swatch = h('span', {
    class: 'prop-color-swatch',
    style: ctx.value && isValidColor ? `background:${ctx.value}` : '',
    title: ctx.value || 'none',
  });
  const text = h('input', {
    class: `prop-color-input${!isValidColor ? ' prop-input--invalid' : ''}`,
    type: 'text',
    value: ctx.value,
    placeholder: '#000000',
    spellcheck: 'false',
  }) as HTMLInputElement;
  const native = h('input', {
    class: 'prop-color-picker',
    type: 'color',
    value: isValidColor && ctx.value ? expandColor(ctx.value) : '#000000',
    'aria-label': 'Color picker',
  }) as HTMLInputElement;

  text.addEventListener('input', () => ctx.onChange(text.value));
  native.addEventListener('input', () => {
    text.value = native.value;
    ctx.onChange(native.value);
  });

  return h('div', { class: `prop-cell prop-cell--color${ctx.dirty ? ' prop-cell--dirty' : ''}` },
    swatch, text, native,
  );
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

/** Expand #rgb → #rrggbb for the native color picker. */
function expandColor(c: string): string {
  if (c.length === 4) return `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}`;
  return c;
}

export function booleanEditor(ctx: PropEditorContext): HTMLElement {
  // BMP serializes booleans as the strings "true" / "false" (or empty when unset).
  const checked = ctx.value === 'true' || ctx.value === 'TRUE';
  const toggle = h('button', {
    class: `prop-toggle${checked ? ' prop-toggle--on' : ''}${ctx.dirty ? ' prop-cell--dirty' : ''}`,
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
    class: `prop-number-input${ctx.dirty ? ' prop-cell--dirty' : ''}`,
    type: 'number',
    value: ctx.value,
    ...(opts.min != null ? { min: opts.min } : {}),
    ...(opts.max != null ? { max: opts.max } : {}),
    ...(opts.step != null ? { step: opts.step } : { step: 1 }),
  }) as HTMLInputElement;
  input.addEventListener('input', () => ctx.onChange(input.value));
  const children: (HTMLElement | string)[] = [input];
  if (opts.unit) children.push(h('span', { class: 'prop-unit' }, opts.unit));
  return h('div', { class: `prop-cell prop-cell--number${ctx.dirty ? ' prop-cell--dirty' : ''}` }, ...children);
}

export interface EnumOption { value: string; label?: string }

/** BMP returns enum values as the qualified form "EnumName.VALUE" (e.g.
 *  "HeaderStyle.INSIDE", "BorderStyle.LINE") while our schema lists them as
 *  bare tokens ("INSIDE", "LINE") because that's what `_o.change(headerStyle
 *  := "INSIDE")` accepts on save. Strip the prefix before matching so a
 *  qualified server value lights up the correct option instead of falling
 *  through to "(custom)". Case-folded only for the comparison key — the
 *  display value is preserved as-is to avoid silently uppercasing legacy
 *  data on save. */
function enumCompareKey(raw: string): string {
  const trimmed = raw.trim();
  const dot = trimmed.lastIndexOf('.');
  const tail = dot >= 0 ? trimmed.slice(dot + 1) : trimmed;
  return tail.toUpperCase();
}

export function enumEditor(ctx: PropEditorContext, options: EnumOption[]): HTMLElement {
  const select = h('select', { class: 'prop-select' }) as HTMLSelectElement;
  const normalized = enumCompareKey(ctx.value);
  for (const opt of options) {
    const o = document.createElement('option');
    o.value = opt.value;
    o.textContent = opt.label ?? opt.value;
    if (enumCompareKey(opt.value) === normalized) o.selected = true;
    select.appendChild(o);
  }
  // If current value isn't in options, surface it explicitly so the user sees it.
  if (!options.find(o => enumCompareKey(o.value) === normalized)) {
    const o = document.createElement('option');
    o.value = ctx.value;
    o.textContent = ctx.value ? `${ctx.value} (custom)` : '(none)';
    o.selected = true;
    select.appendChild(o);
  }
  // Always save the bare token form — that's what _o.change() expects. If
  // the user picks "Inside" from the dropdown, send "INSIDE", not the
  // qualified "HeaderStyle.INSIDE" form.
  select.addEventListener('change', () => ctx.onChange(select.value));
  return h('div', { class: `prop-cell prop-cell--enum${ctx.dirty ? ' prop-cell--dirty' : ''}` }, select);
}

export function sliderEditor(
  ctx: PropEditorContext,
  opts: { min: number; max: number; step?: number; unit?: string },
): HTMLElement {
  const slider = h('input', {
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
