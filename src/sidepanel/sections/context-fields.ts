/**
 * Context section — surfaces enum / boolean / list values that shape how
 * other fields are interpreted (actionType, persistence, textInputType,
 * useShowExpression, addableItems …). Rendered as a compact chip strip
 * near the top of the pane so authors see "this is an ACTION-mode button"
 * before they scroll through the EC.
 */

import { h } from '../../lib/dom';
import { contextFieldsFor, normalizeBmpEnum } from '../../lib/widget-metadata';
import { typeBadge } from '../../lib/type-badge';
import type { ObjectPaneIdentity } from '../../lib/types';

export interface ContextSectionInput {
  type: string;
  contextValues: Record<string, string>;
  lists: Record<string, ObjectPaneIdentity[]>;
  onNavigate: (rid: string) => void;
}

export function renderContextSection(input: ContextSectionInput): HTMLElement | null {
  const defs = contextFieldsFor(input.type);
  if (defs.length === 0) return null;

  const chips: HTMLElement[] = [];
  const listGroups: HTMLElement[] = [];

  for (const def of defs) {
    if (def.kind === 'list-ref') {
      const items = input.lists[def.prop] ?? [];
      if (items.length === 0) continue;
      listGroups.push(renderListGroup(def.label ?? def.prop, items, input.onNavigate));
      continue;
    }
    const value = input.contextValues[def.prop];
    if (value == null || value === '') continue;
    chips.push(renderContextChip(def.label ?? def.prop, def.kind, value));
  }

  if (chips.length === 0 && listGroups.length === 0) return null;

  // No "Context" header — the chip strip carries enough signal on its own,
  // and the title duplicated the chip key labels. CSS gives the strip its
  // own zone (background + accent left border) so it doesn't get lost in
  // the surrounding dark-on-dark layout.
  return h('div', { class: 'context-section' },
    chips.length > 0 ? h('div', { class: 'ctx-chips' }, ...chips) : null,
    ...listGroups,
  );
}

function renderContextChip(label: string, kind: 'enum' | 'boolean', value: string): HTMLElement {
  // Enum values come back as "EnumName.value" — strip the prefix for display.
  // Booleans render as on/off chips.
  const display = kind === 'boolean'
    ? (isTruthy(value) ? 'on' : 'off')
    : normalizeBmpEnum(value);
  const variant = kind === 'boolean'
    ? (isTruthy(value) ? 'ctx-chip--on' : 'ctx-chip--off')
    : 'ctx-chip--enum';
  return h('span', { class: `ctx-chip ${variant}`, title: `${label} = ${value}` },
    h('span', { class: 'ctx-chip-key' }, label),
    h('span', { class: 'ctx-chip-sep' }, ':'),
    h('span', { class: 'ctx-chip-val' }, display),
  );
}

function renderListGroup(label: string, items: ObjectPaneIdentity[], onNavigate: (rid: string) => void): HTMLElement {
  return h('div', { class: 'ctx-list' },
    h('div', { class: 'ctx-list-title' }, `${label} · ${items.length}`),
    h('div', { class: 'ctx-list-rows' },
      ...items.map(item =>
        h('div', {
          class: 'ctx-list-row',
          role: 'button',
          tabindex: '0',
          title: `Open ${item.name || item.businessId || item.rid}`,
          onClick: () => onNavigate(item.rid),
          onKeydown: (e: KeyboardEvent) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onNavigate(item.rid); }
          },
        },
          typeBadge(item.type, { size: 'xs' }),
          h('span', { class: 'ctx-list-name' }, item.name || '(unnamed)'),
          item.businessId ? h('span', { class: 'ctx-list-bid' }, item.businessId) : null,
        ),
      ),
    ),
  );
}

function isTruthy(v: string): boolean {
  return v === 'true' || v === 'TRUE' || v === '1';
}
