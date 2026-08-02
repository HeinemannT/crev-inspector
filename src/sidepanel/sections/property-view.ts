/**
 * Compact sidebar view for master Property definitions.
 *
 * The definition is useful immediately. The reverse-reference scan that finds
 * ClassConfig applications is deliberately opt-in because it can be expensive.
 */

import { h, svg } from '../../lib/dom';
import { ecPreviewSpan } from '../../lib/ec-format';
import { ICON_CHEVRON } from '../../lib/icons';
import type {
  InspectorMessage,
  ObjectPaneIdentity,
  PropertyApplication,
} from '../../lib/types';
import { firstNonEmptyLine, renderCodeRow } from './code-fields';

type SendFn = (msg: InspectorMessage) => void;

export interface PropertyViewInput {
  identity: ObjectPaneIdentity;
  props: Record<string, string>;
  codeFields: Record<string, string>;
  applications: PropertyApplication[];
  applicationsError?: string | null;
  applicationsState: 'idle' | 'loading' | 'loaded' | 'error';
  applicationsTotal?: number;
  applicationsTruncated?: boolean;
  onLoadApplications: () => void;
  sendMessage: SendFn;
}

export function renderPropertyView(input: PropertyViewInput): HTMLElement {
  const rows = [
    ['Name', input.identity.name || '—'],
    ['ID', input.identity.businessId || '—'],
    ['Type', humanizePropertyType(input.identity.type)],
    ['Category', input.props.category || '—'],
  ] as const;

  const definition = h('section', { class: 'prop-group property-definition' },
    h('div', { class: 'property-section-head' }, 'Property'),
    h('div', { class: 'property-facts' },
      ...rows.map(([label, value]) => h('div', { class: 'property-fact' },
        h('span', { class: 'property-fact-label' }, label),
        h('span', {
          class: `property-fact-value${label === 'ID' ? ' mono' : ''}`,
          title: value,
        }, value),
      )),
    ),
  );

  const children: HTMLElement[] = [definition];
  const expression = input.codeFields.expression;
  if (expression) children.push(renderExpression(input.identity.rid, expression, input.sendMessage));
  children.push(renderApplications(input));

  return h('div', { class: 'property-detail' }, ...children);
}

function renderExpression(rid: string, expression: string, sendMessage: SendFn): HTMLElement {
  return h('div', { class: 'prop-group code-section code-section--bare property-code' },
    renderCodeRow({
      label: 'expression',
      prop: 'expression',
      content: expression,
      rid,
      sendMessage,
    }),
  );
}

function renderApplications(input: PropertyViewInput): HTMLElement {
  const applications = [...input.applications].sort((a, b) => {
    const aInherited = Object.keys(a.overrides).length === 0;
    const bInherited = Object.keys(b.overrides).length === 0;
    if (aInherited !== bInherited) return aInherited ? 1 : -1;
    return a.classId.localeCompare(b.classId);
  });
  const overridden = applications.filter(a => Object.keys(a.overrides).length > 0).length;
  const inherited = applications.length - overridden;
  const loaded = input.applicationsState === 'loaded';
  const actionLabel = input.applicationsState === 'error'
    ? 'Retry'
    : loaded
      ? 'Refresh'
      : 'Load applications';

  const section = h('section', { class: 'prop-group property-applications' },
    h('div', { class: 'property-apps-head' },
      h('div', { class: 'property-apps-head-main' },
        h('span', { class: 'property-apps-title' },
          'Object type applications',
          loaded
            ? h('span', { class: 'property-apps-total' }, String(input.applicationsTotal ?? applications.length))
            : null,
        ),
        h('button', {
          class: 'property-apps-action',
          type: 'button',
          disabled: input.applicationsState === 'loading',
          onClick: input.onLoadApplications,
        }, input.applicationsState === 'loading' ? 'Loading…' : actionLabel),
      ),
      loaded
        ? h('span', { class: 'property-apps-summary' }, `${overridden} overridden · ${inherited} inherited`)
        : null,
    ),
  );

  if (input.applicationsState === 'idle') {
    section.appendChild(h('div', { class: 'property-apps-note' },
      'Find which object types inherit or override this property.',
    ));
    return section;
  }
  if (input.applicationsState === 'loading') {
    section.appendChild(h('div', { class: 'property-apps-note' },
      applications.length ? 'Refreshing applications…' : 'Loading applications…',
    ));
    return section;
  }
  if (input.applicationsState === 'error') {
    section.appendChild(h('div', { class: 'property-apps-note property-apps-note--error' },
      input.applicationsError || 'Property applications unavailable.',
    ));
    return section;
  }
  if (applications.length === 0) {
    section.appendChild(h('div', { class: 'property-apps-note' }, 'No object type applications.'));
    return section;
  }

  for (const application of applications) section.appendChild(renderApplication(application, input));
  if (input.applicationsTruncated) {
    section.appendChild(h('div', { class: 'property-apps-note' },
      `Showing the first ${applications.length} of ${input.applicationsTotal ?? applications.length} applications.`,
    ));
  }
  return section;
}

function renderApplication(application: PropertyApplication, input: PropertyViewInput): HTMLElement {
  const fields = Object.entries(application.overrides);
  const inherited = fields.length === 0;
  const details = h('details', { class: 'property-app' },
    h('summary', { class: 'property-app-summary' },
      h('code', { class: 'property-app-id' }, application.classId),
      h('span', { class: 'property-app-state' },
        inherited ? 'inherited' : `${fields.length} ${fields.length === 1 ? 'override' : 'overrides'}`,
      ),
      h('span', { class: 'property-app-chevron', 'aria-hidden': 'true' }, svg(ICON_CHEVRON)),
    ),
  );

  const body = h('div', { class: 'property-app-body' });
  if (inherited) {
    body.appendChild(h('div', { class: 'property-app-inherited' },
      h('span', { class: 'property-delta-label' }, 'Overrides'),
      h('span', {}, 'None · inherits the property definition'),
    ));
  } else {
    for (const [field, literal] of fields) {
      body.appendChild(renderDelta(field, literal, masterValue(field, input)));
    }
  }
  details.appendChild(body);
  return details;
}

function renderDelta(field: string, literal: string, master: string): HTMLElement {
  const override = decodeEcLiteral(literal);
  const normalizedField = field.toLowerCase();
  const codeLike = normalizedField.endsWith('expression')
    || normalizedField === 'javascript'
    || normalizedField === 'script'
    || normalizedField === 'code';
  const value = codeLike
    ? ecPreviewSpan(firstNonEmptyLine(override) || '(empty)', 'property-delta-code mono')
    : h('span', { class: 'property-delta-value', title: override }, override || '(empty)');
  const before = master
    ? h('span', { class: 'property-delta-before', title: master }, master)
    : null;

  return h('div', { class: 'property-delta' },
    h('span', { class: 'property-delta-label' }, humanizeField(field)),
    h('div', { class: 'property-delta-change' },
      before,
      before ? h('span', { class: 'property-delta-arrow', 'aria-hidden': 'true' }, '→') : null,
      value,
    ),
  );
}

function masterValue(field: string, input: PropertyViewInput): string {
  if (field === 'name') return input.identity.name;
  if (field === 'id') return input.identity.businessId;
  if (field === 'expression') return input.codeFields.expression ?? '';
  return input.props[field] ?? input.codeFields[field] ?? '';
}

export function decodeEcLiteral(literal: string): string {
  const trimmed = literal.trim();
  if (trimmed.length < 2) return trimmed;
  const quote = trimmed[0];
  if ((quote !== "'" && quote !== '"') || trimmed[trimmed.length - 1] !== quote) return trimmed;
  return trimmed.slice(1, -1)
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

function humanizePropertyType(type: string): string {
  const base = type.replace(/MethodConfig$/, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim();
  if (!base) return type || '—';
  return base[0].toUpperCase() + base.slice(1).toLowerCase();
}

function humanizeField(field: string): string {
  const spaced = field.replace(/[_-]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return spaced ? spaced[0].toUpperCase() + spaced.slice(1) : field;
}
