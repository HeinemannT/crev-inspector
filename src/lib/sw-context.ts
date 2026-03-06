import type { BmpClient } from './bmp-client';
import type { ObjectCache } from './object-cache';
import type { InspectorMessage, InspectorSettings, ActivityEntry } from './types';

/** Shared mutable context passed to all service-worker modules. */
export interface SwContext {
  client: BmpClient | null;
  panelPort: chrome.runtime.Port | null;
  contentPorts: Map<number, chrome.runtime.Port>;
  cache: ObjectCache;
  settings: InspectorSettings;
  inspectActive: boolean;
  settingsReady: Promise<void>;

  logActivity(level: ActivityEntry['level'], message: string, detail?: string): void;
  sendToPanel(msg: InspectorMessage): void;
  broadcastToContent(msg: InspectorMessage): void;
}

// ── Global context accessor ──────────────────────────────────────

let _ctx: SwContext | null = null;

/** Set the shared context (called once at SW boot). */
export function setSwContext(ctx: SwContext): void {
  _ctx = ctx;
}

/** Get the shared context. Throws if called before setSwContext(). */
export function getCtx(): SwContext {
  if (!_ctx) throw new Error('SwContext not initialized — call setSwContext() first');
  return _ctx;
}
