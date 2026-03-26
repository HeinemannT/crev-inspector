/**
 * Detail view — shows full properties, scripts, and EC preview for a single object.
 * Push/pop navigation within Page or Objects tab.
 */

import type { BmpObject, InspectorMessage } from '../lib/types';
import { getTypeColor, getTypeAbbr, SCRIPT_PROPS } from '../lib/types';
import { h, render, svg } from '../lib/dom';
import { delegate } from './delegate';
import { copyBtn, copyBtnIdentity, copyText, ICON_ARROW_LEFT, ICON_STAR_FILLED, ICON_STAR_HOLLOW } from './utils';
import { log } from '../lib/logger';
import { LOOKUP_WATCHDOG_TIMEOUT } from '../lib/constants';
import { S } from './state';

// Script property names as Set for fast lookup
const SCRIPT_PROPS_SET = new Set<string>(SCRIPT_PROPS);

// Properties to skip from the general properties section
const IDENTITY_PROPS = new Set(['rid', 'id', 'name', 'type', '__typename', 'typename']);
const SKIP_PROPS = new Set([...IDENTITY_PROPS, 'source', 'discoveredAt', 'updatedAt', 'properties', 'treePath', 'webParentRid', 'hasChildren']);

// Callbacks
let onBackCb: (() => void) | null = null;
let sendMessageCb: ((msg: InspectorMessage) => void) | null = null;

// Current detail state
let currentObj: BmpObject | null = null;
let serverLookupDone = false;
let serverLookupError: string | null = null;

// Per-script-block output
interface ScriptOutput {
  ok: boolean;
  hasWarning: boolean;
  log?: string;
  error?: string;
  mode: 'preview' | 'execute';
  durationMs: number | null;
}
let ecOutputs = new Map<string, ScriptOutput>();
let ecRunningProp: string | null = null;
let ecRunningMode: 'preview' | 'execute' = 'preview';
let ecStartTime = 0;
let expandedOutputs = new Set<string>();
let lookupTimeout: ReturnType<typeof setTimeout> | null = null;

// Linked objects state (InputView→InputSet, CreateObjectView→EditPage, etc.)
interface LinkedState {
  label: string;
  data: { id?: string; name?: string; rid?: string } | null;
  error: string | null;
}
let linkedObjects = new Map<string, LinkedState>();

/** Trigger linked object lookups if the type has any configured. */
function triggerLinkedLookups(obj: BmpObject): void {
  if (!obj.type) return;
  // Send a single LINKED_LOOKUP — the service worker knows which links exist for this type
  sendMessageCb?.({ type: 'LINKED_LOOKUP', rid: obj.rid, objectType: obj.type });
}

/** Initialize the detail view module */
export function initDetailView(
  onBack: () => void,
  sendMessage: (msg: InspectorMessage) => void,
): void {
  onBackCb = onBack;
  sendMessageCb = sendMessage;
}

/** Start a watchdog that fires timeout error if SERVER_LOOKUP_RESULT never arrives */
function startLookupWatchdog(rid: string, panel: HTMLElement): void {
  clearLookupWatchdog();
  lookupTimeout = setTimeout(() => {
    lookupTimeout = null;
    if (!serverLookupDone && currentObj?.rid === rid) {
      serverLookupDone = true;
      serverLookupError = 'Request timed out';
      renderDetail(panel);
    }
  }, LOOKUP_WATCHDOG_TIMEOUT);
}

function clearLookupWatchdog(): void {
  if (lookupTimeout) { clearTimeout(lookupTimeout); lookupTimeout = null; }
}

/** Show the detail view for an object */
export function showDetail(obj: BmpObject, panel: HTMLElement): void {
  currentObj = obj;
  serverLookupDone = false;
  serverLookupError = null;
  ecOutputs = new Map();
  ecRunningProp = null;
  ecStartTime = 0;
  expandedOutputs = new Set();
  linkedObjects = new Map();
  renderDetail(panel);

  if (!obj.properties) {
    sendMessageCb?.({ type: 'SERVER_LOOKUP', rid: obj.rid });
    startLookupWatchdog(obj.rid, panel);
  } else {
    serverLookupDone = true;
    triggerLinkedLookups(obj);
  }
}

/** Handle incoming messages relevant to the detail view */
export function handleDetailMessage(msg: InspectorMessage, panel: HTMLElement): boolean {
  if (!currentObj) return false;

  if (msg.type === 'SERVER_LOOKUP_RESULT' && 'rid' in msg && msg.rid === currentObj.rid) {
    clearLookupWatchdog();
    serverLookupDone = true;
    serverLookupError = msg.error ?? null;
    if (msg.object) {
      currentObj = {
        ...currentObj,
        name: msg.object.name ?? currentObj.name,
        type: msg.object.type ?? currentObj.type,
        businessId: msg.object.businessId ?? currentObj.businessId,
        templateBusinessId: msg.object.templateBusinessId ?? currentObj.templateBusinessId,
        properties: msg.object.properties ?? currentObj.properties,
      };
      // Trigger linked object lookups if not already done
      if (linkedObjects.size === 0) {
        triggerLinkedLookups(currentObj);
      }
    }
    renderDetail(panel);
    return true;
  }

  if (msg.type === 'LINKED_LOOKUP_RESULT' && 'rid' in msg && msg.rid === currentObj.rid) {
    const state: LinkedState = {
      label: msg.label,
      data: (msg.linkedId || msg.linkedRid) ? { id: msg.linkedId, name: msg.linkedName, rid: msg.linkedRid } : null,
      error: msg.error ?? null,
    };
    linkedObjects.set(msg.key, state);
    renderDetail(panel);
    return true;
  }

  if (msg.type === 'EC_RESULT' && ecRunningProp) {
    const durationMs = ecStartTime ? Date.now() - ecStartTime : null;
    const output: ScriptOutput = {
      ok: msg.ok,
      hasWarning: msg.hasWarning ?? false,
      log: msg.log,
      error: msg.error,
      mode: ecRunningMode,
      durationMs,
    };
    ecOutputs.set(ecRunningProp, output);
    ecRunningProp = null;
    ecStartTime = 0;
    renderDetail(panel);
    return true;
  }

  return false;
}

/** Check if detail view is active */
export function isDetailActive(): boolean {
  return currentObj != null;
}

/** Clear detail state */
export function clearDetail(): void {
  clearLookupWatchdog();
  currentObj = null;
  serverLookupDone = false;
  serverLookupError = null;
  ecOutputs = new Map();
  ecRunningProp = null;
  ecStartTime = 0;
  linkedObjects = new Map();
}

// ── Rendering ────────────────────────────────────────────────────

function renderDetail(panel: HTMLElement): void {
  if (!currentObj) return;
  const obj = currentObj;
  const color = getTypeColor(obj.type);
  const abbr = getTypeAbbr(obj.type);

  const isFav = S.favoriteEntries.some(f => f.rid === obj.rid);

  const children: (HTMLElement | false | null)[] = [
    // Back button
    h('button', { class: 'detail-back', 'data-action': 'back' }, svg(ICON_ARROW_LEFT), ' Back'),

    // Identity header
    h('div', { class: 'detail-identity', style: `--type-color:${color}` },
      h('button', { class: `detail-star${isFav ? ' active' : ''}`, 'data-action': 'toggle-star', title: isFav ? 'Remove from pinned' : 'Pin this object', 'aria-label': isFav ? 'Remove from pinned' : 'Pin this object' },
        svg(isFav ? ICON_STAR_FILLED : ICON_STAR_HOLLOW)),
      h('span', { class: 'type-badge', style: `--type-color:${color}` }, abbr),
      h('span', { class: 'detail-name' }, obj.name ?? 'unnamed'),
    ),

    // Core identity fields
    h('table', { class: 'prop-table' },
      h('tr', null,
        h('td', { class: 'prop-key' }, 'RID'),
        h('td', { class: 'prop-value has-copy' }, h('span', { class: 'mono' }, obj.rid), copyBtn(obj.rid)),
      ),
      obj.businessId && h('tr', null,
        h('td', { class: 'prop-key' }, 'ID'),
        h('td', { class: 'prop-value has-copy' },
          h('span', { class: 'mono' }, obj.businessId),
          copyBtnIdentity({ rid: obj.rid, businessId: obj.businessId, type: obj.type, templateBusinessId: obj.templateBusinessId }),
        ),
      ),
      obj.templateBusinessId && h('tr', null,
        h('td', { class: 'prop-key' }, 'Template ID'),
        h('td', { class: 'prop-value has-copy' },
          h('span', { class: 'mono' }, obj.templateBusinessId),
          copyBtn(obj.templateBusinessId),
        ),
      ),
      obj.type && h('tr', null,
        h('td', { class: 'prop-key' }, 'Type'),
        h('td', { class: 'prop-value' }, obj.type),
      ),
    ),
  ];

  // Linked object badges (InputView→InputSet, CreateObjectView→EditPage, etc.)
  for (const [, link] of linkedObjects) {
    children.push(renderLinkedBadge(link));
  }

  // Loading state
  if (!serverLookupDone) {
    children.push(h('div', { class: 'detail-loading' }, h('span', { class: 'detection-spinner' }), ' Loading properties\u2026'));
    render(panel, ...children);
    wireDelegate(panel);
    return;
  }

  // Properties
  const props = obj.properties as Record<string, unknown> | undefined;
  if (props && typeof props === 'object') {
    const scriptEntries: [string, string][] = [];
    const regularEntries: [string, unknown][] = [];

    for (const [key, value] of Object.entries(props)) {
      if (SKIP_PROPS.has(key)) continue;
      if (SCRIPT_PROPS_SET.has(key) && typeof value === 'string' && value.trim().length > 0) {
        scriptEntries.push([key, value]);
      } else if (value != null && value !== '' && value !== false) {
        regularEntries.push([key, value]);
      }
    }

    // Regular properties
    if (regularEntries.length > 0) {
      children.push(
        h('div', { class: 'section-title' }, 'Properties'),
        h('table', { class: 'prop-table' },
          ...regularEntries.map(([key, value]) =>
            h('tr', null,
              h('td', { class: 'prop-key' }, key),
              h('td', { class: 'prop-value' }, formatValue(value)),
            ),
          ),
        ),
      );
    }

    // Script sections
    if (scriptEntries.length > 0) {
      children.push(h('div', { class: 'section-title' }, 'Scripts'));
      for (const [key, code] of scriptEntries) {
        children.push(renderScriptBlock(key, code));
      }
    }

    if (regularEntries.length === 0 && scriptEntries.length === 0) {
      children.push(h('div', { class: 'detail-hint' }, 'No additional properties'));
    }
  } else if (serverLookupError) {
    children.push(
      h('div', { class: 'detail-error' }, serverLookupError),
      h('div', { class: 'detail-hint' }, 'Check the Connect tab if your server is offline.'),
      h('button', { class: 'detail-retry btn btn-small', 'data-action': 'retry' }, 'Retry'),
    );
  } else if (S.connState.display !== 'connected') {
    children.push(h('div', { class: 'detail-hint' }, 'Connect to see full properties'));
  } else {
    children.push(h('div', { class: 'detail-hint' }, 'Add a server in Connect tab to view properties'));
  }

  render(panel, ...children);
  wireDelegate(panel);
}

function renderLinkedBadge(link: LinkedState): HTMLElement {
  const dim = !link.data;
  const inner: (HTMLElement | false)[] = [
    h('span', { class: 'detail-linked-type' }, link.label),
  ];

  if (link.data) {
    const displayId = link.data.id || link.data.name || link.data.rid || '\u2014';
    const copyValue = link.data.id || link.data.rid;
    inner.push(h('span', { class: 'detail-linked-id mono' }, displayId));
    if (copyValue) inner.push(copyBtn(copyValue));
  } else {
    inner.push(h('span', { class: 'detail-linked-dim' }, link.error ? 'unavailable' : 'none'));
  }

  return h('div', { class: 'detail-linked' },
    h('div', { class: 'detail-linked-line' }),
    h('div', { class: `detail-linked-badge${dim ? ' detail-linked--dim' : ''}` }, ...inner),
  );
}

function renderScriptBlock(key: string, code: string): HTMLElement {
  const running = ecRunningProp === key;
  const output = ecOutputs.get(key);
  const connected = S.connState.display === 'connected';
  const disabledTitle = connected ? '' : 'Not connected';

  const section = h('div', { class: 'script-section' },
    h('div', { class: 'script-header' },
      h('span', { class: 'script-label' }, key),
    ),
    h('pre', { class: 'script-code' }, code),
    h('div', { class: 'script-actions' },
      h('button', { class: 'btn btn-small', 'data-action': 'copy-script', 'data-prop': key }, 'Copy'),
      h('button', { class: 'btn btn-small btn-accent', 'data-action': 'preview-script', 'data-prop': key, disabled: running || !connected, title: disabledTitle }, running ? 'Running\u2026' : 'Preview'),
      h('button', { class: 'btn btn-small btn-danger', 'data-action': 'run-script', 'data-prop': key, disabled: running || !connected, title: disabledTitle }, 'Run'),
      h('button', { class: 'btn btn-small', 'data-action': 'open-editor', 'data-prop': key }, 'Editor'),
    ),
  );

  if (output) {
    const resultClass = !output.ok ? 'error' : output.hasWarning ? 'warning' : 'ok';
    const modeLabel = output.mode === 'execute' ? 'Executed' : 'Preview';
    const durationLabel = output.durationMs != null ? ` \u00b7 ${output.durationMs}ms` : '';
    const content = output.ok ? (output.log ?? '(no output)') : (output.error ?? 'Unknown error');
    const isExpanded = expandedOutputs.has(key);
    const expandLabel = isExpanded ? '\u25B4 Collapse' : '\u25BE Expand';

    section.appendChild(
      h('div', { class: 'script-result-header' },
        h('span', { class: `script-result-mode ${resultClass}` }, modeLabel),
        h('span', { class: 'script-result-duration' }, durationLabel),
        h('button', { class: 'detail-expand-output', 'data-action': 'toggle-expand', 'data-prop': key }, expandLabel),
        h('button', { class: 'btn btn-small detail-clear-output', 'data-action': 'clear-output', 'data-prop': key }, 'Clear'),
      ),
    );
    section.appendChild(
      h('pre', { class: `script-result ${resultClass}${isExpanded ? ' expanded' : ''}` }, content),
    );
  }

  return section;
}

function wireDelegate(panel: HTMLElement): void {
  const props = currentObj?.properties as Record<string, unknown> | undefined;

  function executeScript(prop: string, transactional: boolean): void {
    if (!props) return;
    const code = props[prop];
    if (typeof code !== 'string' || ecRunningProp) return;
    ecRunningProp = prop;
    ecRunningMode = transactional ? 'execute' : 'preview';
    ecStartTime = Date.now();
    sendMessageCb?.({ type: 'EC_EXECUTE', code, objectRid: currentObj?.rid, transactional });
    renderDetail(panel);
  }

  delegate(panel, {
    back: () => { clearDetail(); onBackCb?.(); },
    'toggle-star': () => {
      if (!currentObj) return;
      sendMessageCb?.({ type: 'TOGGLE_FAVORITE', rid: currentObj.rid, name: currentObj.name, objectType: currentObj.type, businessId: currentObj.businessId });
    },
    retry: () => {
      if (!currentObj) return;
      serverLookupDone = false;
      serverLookupError = null;
      renderDetail(panel);
      sendMessageCb?.({ type: 'SERVER_LOOKUP', rid: currentObj.rid });
      startLookupWatchdog(currentObj.rid, panel);
    },
    'copy-script': (el) => {
      const prop = el.dataset.prop;
      if (!prop || !props) return;
      const code = props[prop];
      if (typeof code === 'string') copyText(code);
    },
    'preview-script': (el) => {
      const prop = el.dataset.prop;
      if (prop) executeScript(prop, false);
    },
    'run-script': (el) => {
      const prop = el.dataset.prop;
      if (prop) executeScript(prop, true);
    },
    'open-editor': () => {
      if (!currentObj) return;
      sendMessageCb?.({ type: 'OPEN_EDITOR', rid: currentObj.rid });
    },
    'toggle-expand': (el) => {
      const prop = el.dataset.prop;
      if (!prop) return;
      if (expandedOutputs.has(prop)) expandedOutputs.delete(prop);
      else expandedOutputs.add(prop);
      renderDetail(panel);
    },
    'clear-output': (el) => {
      const prop = el.dataset.prop;
      if (!prop) return;
      ecOutputs.delete(prop);
      expandedOutputs.delete(prop);
      renderDetail(panel);
    },
  });
}

function formatValue(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(String).join(', ');
  if (typeof value === 'object') {
    try { return JSON.stringify(value); } catch (e) { log.swallow('detail:formatValue', e); return String(value); }
  }
  return String(value);
}
