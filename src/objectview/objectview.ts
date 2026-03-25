/**
 * Object View Page — standalone popup showing full object properties, template, and children.
 * Reads RID from URL hash, loads context from storage, then fetches deep data via FULL_LOOKUP.
 */

import type { InspectorMessage, BmpObject } from '../lib/types';
import { getTypeColor, getTypeAbbr, SCRIPT_PROPS } from '../lib/types';
import { h, render } from '../lib/dom';
import { resolveCopyText, getModifier } from '../lib/namespace';

const SCRIPT_PROPS_SET = new Set<string>(SCRIPT_PROPS);
const IDENTITY_KEYS = new Set(['rid', 'id', 'name', 'type', '__typename', 'typename']);
const SKIP_KEYS = new Set([...IDENTITY_KEYS, 'source', 'discoveredAt', 'updatedAt', 'properties', 'treePath', 'webParentRid', 'hasChildren']);

const root = document.getElementById('objectview-root')!;
const rid = location.hash.slice(1);

if (!rid) {
  render(root, h('div', { class: 'ov-error' }, 'No RID specified'));
} else {
  init();
}

async function init() {
  // Show loading
  render(root, h('div', { class: 'ov-loading' }, 'Loading\u2026'));

  // Read initial context from storage
  const stored = await chrome.storage.local.get(`crev_objectview_ctx_${rid}`);
  const ctx = stored[`crev_objectview_ctx_${rid}`] as { rid: string; name?: string; type?: string; businessId?: string } | undefined;

  if (ctx?.name) {
    document.title = `${ctx.name} \u2014 CREV Object View`;
  }

  // Request full lookup from service worker
  chrome.runtime.sendMessage(
    { type: 'FULL_LOOKUP', rid } as InspectorMessage,
    (response: any) => {
      if (chrome.runtime.lastError) {
        renderError(chrome.runtime.lastError.message ?? 'Communication error');
        return;
      }
      if (!response || response.type !== 'FULL_LOOKUP_RESULT') {
        renderError('Unexpected response');
        return;
      }
      if (response.error) {
        renderError(response.error);
        return;
      }
      renderObject(response.object, response.template, response.children);
    },
  );
}

function renderError(error: string) {
  render(root, h('div', { class: 'ov-error' }, error));
}

function renderObject(
  obj: BmpObject | null,
  template?: { rid: string; name: string; type: string; businessId?: string },
  children?: Array<{ rid: string; name?: string; type?: string; businessId?: string }>,
) {
  if (!obj) {
    renderError('Object not found');
    return;
  }

  document.title = `${obj.name ?? obj.rid} \u2014 CREV Object View`;

  const color = getTypeColor(obj.type);
  const abbr = getTypeAbbr(obj.type);

  const elements: (HTMLElement | false | null)[] = [];

  // Header
  elements.push(
    h('div', { class: 'ov-header' },
      h('span', { class: 'ov-type-badge', style: `background:${color}` }, abbr),
      h('span', { class: 'ov-name' }, obj.name ?? 'unnamed'),
      h('button', { class: 'ov-btn', 'data-action': 'diff' }, 'Diff'),
    ),
  );

  // Identity fields
  const identityRows: HTMLElement[] = [];
  identityRows.push(
    h('span', { class: 'ov-id-label' }, 'RID'),
    h('span', { class: 'ov-id-value', 'data-copy': obj.rid }, obj.rid),
  );
  if (obj.businessId) {
    identityRows.push(
      h('span', { class: 'ov-id-label' }, 'ID'),
      h('span', {
        class: 'ov-id-value',
        'data-copy': obj.businessId,
        'data-copy-rid': obj.rid,
        'data-copy-type': obj.type ?? '',
        'data-copy-tmpl': obj.templateBusinessId ?? '',
      }, obj.businessId),
    );
  }
  if (obj.type) {
    identityRows.push(
      h('span', { class: 'ov-id-label' }, 'Type'),
      h('span', { class: 'ov-id-value' }, obj.type),
    );
  }
  elements.push(h('div', { class: 'ov-identity' }, ...identityRows));

  // Properties
  const props = obj.properties as Record<string, unknown> | undefined;
  if (props && typeof props === 'object') {
    const scriptEntries: [string, string][] = [];
    const regularEntries: [string, unknown][] = [];

    for (const [key, value] of Object.entries(props)) {
      if (SKIP_KEYS.has(key)) continue;
      if (SCRIPT_PROPS_SET.has(key) && typeof value === 'string' && value.trim().length > 0) {
        scriptEntries.push([key, value]);
      } else if (value != null && value !== '' && value !== false) {
        regularEntries.push([key, value]);
      }
    }

    if (regularEntries.length > 0) {
      elements.push(
        h('div', { class: 'ov-section' },
          h('div', { class: 'ov-section-title' }, 'Properties'),
          h('table', { class: 'ov-prop-table' },
            ...regularEntries.map(([key, value]) =>
              h('tr', null,
                h('td', { class: 'ov-prop-key' }, key),
                h('td', { class: 'ov-prop-value' }, formatValue(value)),
              ),
            ),
          ),
        ),
      );
    }

    if (scriptEntries.length > 0) {
      elements.push(
        h('div', { class: 'ov-section' },
          h('div', { class: 'ov-section-title' }, 'Scripts'),
          ...scriptEntries.map(([key, code]) =>
            h('div', null,
              h('div', { style: 'font-size:10px;font-weight:600;color:var(--md-on-surface-variant);margin-bottom:2px' }, key),
              h('pre', { class: 'ov-code-block' }, code),
            ),
          ),
        ),
      );
    }
  }

  // Template
  if (template) {
    const tmplColor = getTypeColor(template.type);
    elements.push(
      h('div', { class: 'ov-section' },
        h('div', { class: 'ov-section-title' }, 'Template'),
        h('div', { class: 'ov-template-link', 'data-open-rid': template.rid },
          h('span', { class: 'ov-type-badge', style: `background:${tmplColor}` }, getTypeAbbr(template.type)),
          h('span', { style: 'font-size:11px;font-weight:500;color:var(--md-on-surface)' }, template.name || 'unnamed'),
          template.businessId
            ? h('span', { class: 'ov-id-value', 'data-copy': template.businessId, style: 'font-size:10px;margin-left:8px' }, template.businessId)
            : false,
          h('span', { style: 'font-size:10px;font-family:var(--md-font-mono);color:var(--md-on-surface-variant);margin-left:auto' }, template.rid),
        ),
        h('button', { class: 'ov-btn', 'data-action': 'template-diff', style: 'margin-top:6px' }, 'Compare to Template'),
      ),
    );
  }

  // Children
  if (children && children.length > 0) {
    elements.push(
      h('div', { class: 'ov-section' },
        h('div', { class: 'ov-section-title' }, `Children (${children.length})`),
        ...children.map(child =>
          h('div', { class: 'ov-child-row', 'data-open-rid': child.rid },
            h('span', { class: 'ov-type-badge', style: `background:${getTypeColor(child.type)}` }, getTypeAbbr(child.type)),
            h('span', { class: 'ov-child-name' }, child.name ?? 'unnamed'),
            h('span', { class: 'ov-child-bid' }, child.businessId ?? ''),
          ),
        ),
      ),
    );
  }

  render(root, ...elements);

  // Wire click handlers
  root.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;

    // Diff action buttons
    const actionEl = target.closest<HTMLElement>('[data-action]');
    if (actionEl) {
      if (actionEl.dataset.action === 'diff') {
        chrome.runtime.sendMessage({ type: 'OPEN_DIFF', leftRid: rid });
      }
      if (actionEl.dataset.action === 'template-diff') {
        chrome.runtime.sendMessage({ type: 'OPEN_TEMPLATE_DIFF', rid });
      }
      return;
    }

    // Copy on click for identity values (supports modifiers: shift=template, ctrl=reference)
    const copyEl = target.closest<HTMLElement>('[data-copy]');
    if (copyEl) {
      const { text } = resolveCopyText({
        rid: copyEl.dataset.copyRid ?? copyEl.dataset.copy ?? '',
        businessId: copyEl.dataset.copy,
        type: copyEl.dataset.copyType,
        templateBusinessId: copyEl.dataset.copyTmpl,
      }, getModifier(e as MouseEvent));
      if (text) {
        navigator.clipboard.writeText(text).then(() => {
          copyEl.classList.add('copied');
          setTimeout(() => copyEl.classList.remove('copied'), 800);
        }).catch(() => {});
      }
      return;
    }

    // Open new Object View for template/child clicks
    const openEl = target.closest<HTMLElement>('[data-open-rid]');
    if (openEl) {
      const openRid = openEl.dataset.openRid;
      if (openRid) {
        chrome.runtime.sendMessage({ type: 'OPEN_OBJECT_VIEW', rid: openRid });
      }
    }
  });
}

function formatValue(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(String).join(', ');
  if (typeof value === 'object') {
    try { return JSON.stringify(value); } catch { return String(value); }
  }
  return String(value);
}
