/**
 * Tab interface — contract for self-contained side panel tab components.
 * Each tab owns its state, handles its messages, and renders independently.
 */

import type { InspectorMessage } from '../../lib/types';

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

  /** Find a cached object by RID. Used by detail navigation to avoid redundant SERVER_LOOKUP. */
  findObject?(rid: string): import('../../lib/types').BmpObject | null;
}
