import { log } from './logger';

const ENABLED_KEY = 'crev_connection_trace_enabled';
const TRACE_KEY = 'crev_connection_trace';
const TRACE_CAP = 100;
const contextIncarnation = typeof crypto?.randomUUID === 'function'
  ? crypto.randomUUID()
  : `${Date.now()}`;

export interface ConnectionDiagnosticEvent {
  source: 'worker-state' | 'port' | 'content-notification';
  profileId?: string;
  semanticRevision?: number;
  portName?: string;
  attempt?: number;
  decision: string;
}

let writeChain: Promise<void> = Promise.resolve();

/** Append one bounded, sanitized lifecycle decision when explicitly enabled in
 * storage.session. Callers pass identifiers/decisions only—never credentials,
 * cookies, command payloads or BMP object content. */
export function traceConnectionDiagnostic(event: ConnectionDiagnosticEvent): void {
  if (typeof chrome === 'undefined' || !chrome.storage?.session) return;
  writeChain = writeChain.then(async () => {
    const current = await chrome.storage.session.get([ENABLED_KEY, TRACE_KEY]);
    if (current[ENABLED_KEY] !== true) return;
    const entries = Array.isArray(current[TRACE_KEY]) ? current[TRACE_KEY] as unknown[] : [];
    entries.push({ ...event, contextIncarnation, at: Date.now() });
    await chrome.storage.session.set({ [TRACE_KEY]: entries.slice(-TRACE_CAP) });
  }).catch(e => log.swallow('connection:trace', e));
}
