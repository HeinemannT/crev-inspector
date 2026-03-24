/**
 * Tab interface — contract for self-contained side panel tabs.
 * Each tab owns its state, handles its messages, and renders independently.
 *
 * Phase 2 of the architecture refactor will convert each tab to implement this.
 * See: .claude/plans/federated-imagining-torvalds.md
 */

import type { InspectorMessage } from '../../lib/types';

export interface Tab {
  /** Handle an incoming message. Return true if handled (triggers render). */
  handleMessage(msg: InspectorMessage): boolean;

  /** Render tab content into the given container. */
  render(container: HTMLElement): void;

  /** Called when tab becomes active — request data from service worker. */
  activate(): void;

  /** Called when tab is deactivated — cleanup timers, etc. */
  deactivate(): void;
}
