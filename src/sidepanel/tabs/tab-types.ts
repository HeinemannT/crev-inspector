/**
 * Tab interface — contract for self-contained side panel tab components.
 * Each tab owns its state, handles its messages, and renders independently.
 */

import type { InspectorMessage, InspectorSettings, ConnectionState, FavoriteEntry, PaintPhase } from '../../lib/types';

/** Read-only shared state accessible to all tabs */
export interface SharedCtx {
  readonly settings: InspectorSettings;
  readonly connState: ConnectionState;
  readonly inspectActive: boolean;
  readonly paintPhase: PaintPhase;
  readonly paintSourceName: string | null;
  readonly cacheCount: number;
  readonly favoriteEntries: readonly FavoriteEntry[];
}

export type SendFn = (msg: InspectorMessage) => void;

export interface Tab {
  /** Handle an incoming message. Return true if state changed (triggers render). */
  handleMessage(msg: InspectorMessage): boolean;

  /** Render tab content into the given container. */
  render(container: HTMLElement): void;

  /** Called when tab becomes active — request fresh data from service worker. */
  activate(): void;

  /** Called when tab is deactivated — cleanup timers, etc. */
  deactivate(): void;
}
