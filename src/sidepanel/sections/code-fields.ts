/**
 * Code section renderer — lists EC-bearing properties on the current object,
 * including direct fields (gated by `enabledBy` if applicable) and indirect
 * fields (ref → target.<prop>). [Edit] opens the editor overlay at the field.
 */

import { h, svg } from '../../lib/dom';
import { ICON_PENCIL } from '../../lib/icons';
import { codeFieldsFor, indirectCodeFieldsFor } from '../../lib/widget-metadata';
import { ecPreviewSpan } from '../../lib/ec-format';
import type { InspectorMessage } from '../../lib/types';

type SendFn = (msg: InspectorMessage) => void;

export interface CodeSectionInput {
  type: string;
  rid: string;
  codeFields: Record<string, string>;
  indirectCode: Record<string, string>;
  /** Target RIDs for indirect EC fields. When present, Edit dispatches to
   *  the target object's property (e.g. ExtendedExpression.expression)
   *  instead of the source's same-named ref handle. */
  indirectCodeRids?: Record<string, string>;
  gateValues: Record<string, string>;
  sendMessage: SendFn;
}

/** Returns null if the object's type has no code rows worth rendering. */
export function renderCodeSection(input: CodeSectionInput): HTMLElement | null {
  const direct = codeFieldsFor(input.type);
  const indirect = indirectCodeFieldsFor(input.type);
  const rows: HTMLElement[] = [];

  for (const def of direct) {
    const content = input.codeFields[def.prop] ?? '';
    if (!content) continue;
    const gateProp = def.enabledBy;
    const gateValue = gateProp ? input.gateValues[gateProp] : undefined;
    const disabled = gateProp ? !isTruthy(gateValue) : false;
    rows.push(renderCodeRow({
      label: def.label ?? def.prop,
      prop: def.prop,
      content,
      rid: input.rid,
      sendMessage: input.sendMessage,
      gateProp: disabled ? gateProp : undefined,
      gateValue: disabled ? gateValue ?? '' : undefined,
    }));
  }

  for (const def of indirect) {
    const key = `${def.prop}_${def.targetProp}`;
    const content = input.indirectCode[key] ?? '';
    if (!content) continue;
    // Edit must target the resolved object (e.g. ExtendedExpression).expression,
    // not the source's Reference handle. The walker captured that RID.
    const targetRid = input.indirectCodeRids?.[key];
    rows.push(renderCodeRow({
      label: def.label ?? def.prop,
      prop: def.prop,
      content,
      rid: targetRid || input.rid,
      editProp: targetRid ? def.targetProp : def.prop,
      sendMessage: input.sendMessage,
      subtitle: `via ${def.prop} → ${def.targetProp}`,
    }));
  }

  if (rows.length === 0) return null;

  // No section header — rows render directly. A "Code (N fields)"
  // banner was visual clutter once the row labels already say what
  // each field is. Gated state is shown on the row itself.
  return h('div', { class: 'prop-group code-section code-section--bare' }, ...rows);
}

function renderCodeRow(opts: {
  label: string;
  prop: string;
  content: string;
  rid: string;
  /** Property the Edit button dispatches with. Defaults to `prop`. Set
   *  separately when the indirection redirect changes the editable field
   *  (e.g. row label says `showExpression` but edit opens `.expression`). */
  editProp?: string;
  sendMessage: SendFn;
  subtitle?: string;
  /** Set when the field is gated by an `enabledBy` flag that's currently false. */
  gateProp?: string;
  gateValue?: string;
}): HTMLElement {
  const lines = opts.content.split('\n').length;
  const firstLine = firstNonEmptyLine(opts.content);
  const disabled = opts.gateProp != null;

  return h('div', { class: `code-row${disabled ? ' code-row--disabled' : ''}` },
    h('div', { class: 'code-row-head' },
      h('span', { class: 'code-row-prop' }, opts.label),
      h('span', { class: 'code-row-meta' }, `${lines} ${lines === 1 ? 'line' : 'lines'}`),
      h('button', {
        class: 'btn btn-small btn-ghost code-row-edit',
        title: `Edit ${opts.label} in the floating editor`,
        onClick: () => opts.sendMessage({ type: 'OPEN_EDITOR', rid: opts.rid, property: opts.editProp ?? opts.prop }),
      }, svg(ICON_PENCIL), 'Edit'),
    ),
    opts.subtitle ? h('div', { class: 'code-row-subtitle' }, opts.subtitle) : null,
    disabled
      ? h('div', { class: 'code-row-gate' },
          `Off: ${opts.gateProp} = ${opts.gateValue || 'false'}`,
        )
      : null,
    firstLine
      ? ecPreviewSpan(firstLine, 'code-row-preview mono')
      : h('div', { class: 'code-row-preview mono code-row-preview--empty' }, '(empty first line)'),
  );
}

function firstNonEmptyLine(s: string): string {
  for (const line of s.split('\n')) {
    const t = line.trimStart();
    if (t) return t.length > 200 ? t.slice(0, 200) + '…' : t;
  }
  return '';
}

function isTruthy(v: string | undefined): boolean {
  if (!v) return false;
  return v === 'true' || v === 'TRUE' || v === '1';
}
