/**
 * Detail view — shows full properties, scripts, and EC preview for a single object.
 * Push/pop navigation within Page or Objects tab.
 */

import type { BmpObject, InspectorMessage } from '../lib/types';
import { getTypeColor, getTypeAbbr, SCRIPT_PROPS } from '../lib/types';
import { h, render, svg } from '../lib/dom';
import { delegate } from './delegate';
import { copyBtn, copyBtnDual, copyText, ICON_ARROW_LEFT, ICON_STAR_FILLED, ICON_STAR_HOLLOW } from './utils';
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

// InputSet state (for InputView objects)
interface InputSetData { id?: string; name?: string; rid?: string }
let inputsetData: InputSetData | null = null;
let inputsetLoading = false;

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
  inputsetData = null;
  inputsetLoading = false;
  renderDetail(panel);

  if (!obj.properties) {
    sendMessageCb?.({ type: 'SERVER_LOOKUP', rid: obj.rid });
    startLookupWatchdog(obj.rid, panel);
  } else {
    serverLookupDone = true;
    // Trigger InputSet lookup for InputView objects
    if (obj.type === 'InputView') {
      inputsetLoading = true;
      sendMessageCb?.({ type: 'INPUTSET_LOOKUP', rid: obj.rid });
    }
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
      // Trigger InputSet lookup for InputView objects
      const objType = currentObj.type ?? msg.object.type;
      if (objType === 'InputView' && !inputsetLoading && !inputsetData) {
        inputsetLoading = true;
        sendMessageCb?.({ type: 'INPUTSET_LOOKUP', rid: currentObj.rid });
      }
    }
    renderDetail(panel);
    return true;
  }

  if (msg.type === 'INPUTSET_LOOKUP_RESULT' && 'rid' in msg && msg.rid === currentObj.rid) {
    inputsetLoading = false;
    if (msg.inputsetId || msg.inputsetRid) {
      inputsetData = { id: msg.inputsetId, name: msg.inputsetName, rid: msg.inputsetRid };
    }
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
  inputsetData = null;
  inputsetLoading = false;
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
    h('div', { class: 'detail-identity' },
      h('button', { class: `detail-star${isFav ? ' active' : ''}`, 'data-action': 'toggle-star', title: isFav ? 'Remove from pinned' : 'Pin this object' },
        svg(isFav ? ICON_STAR_FILLED : ICON_STAR_HOLLOW)),
      h('span', { class: 'type-badge', style: `background:${color}` }, abbr),
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
          obj.templateBusinessId
            ? copyBtnDual(obj.businessId, obj.templateBusinessId, 'ID', 'Template ID')
            : copyBtn(obj.businessId),
        ),
      ),
      obj.templateBusinessId && h('tr', null,
        h('td', { class: 'prop-key' }, 'Template ID'),
        h('td', { class: 'prop-value has-copy' },
          h('span', { class: 'mono' }, obj.templateBusinessId),
          obj.businessId
            ? copyBtnDual(obj.templateBusinessId, obj.businessId, 'Template ID', 'ID')
            : copyBtn(obj.templateBusinessId),
        ),
      ),
      obj.type && h('tr', null,
        h('td', { class: 'prop-key' }, 'Type'),
        h('td', { class: 'prop-value' }, obj.type),
      ),
    ),
  ];

  // InputSet badge for InputView objects
  if (obj.type === 'InputView') {
    if (inputsetLoading) {
      children.push(h('div', { class: 'detail-inputset' }, h('span', { class: 'detection-spinner' }), ' Loading InputSet\u2026'));
    } else if (inputsetData) {
      const label = inputsetData.id || inputsetData.name || inputsetData.rid || 'unknown';
      children.push(
        h('div', { class: 'detail-inputset' },
          h('span', { class: 'detail-inputset-label' }, 'InputSet'),
          h('span', { class: 'mono' }, label),
          inputsetData.id ? copyBtn(inputsetData.id) : false,
        ),
      );
    }
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
