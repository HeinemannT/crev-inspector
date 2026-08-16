import type { AiContextSource } from './types';

interface StoredEditorContext {
  source: AiContextSource | null;
  generation: number;
}

/**
 * Editor context belongs to the BMP tab that hosts the editor frame. Keeping
 * this state per tab prevents an editor in one Chrome window from replacing or
 * clearing the context shown by another window's side panel.
 *
 * The generation token lets asynchronous handlers discard an older broadcast
 * after a newer open/close/focus update has already arrived for the same tab.
 */
const byTab = new Map<number, StoredEditorContext>();
let nextGeneration = 0;

export function storeEditorContext(tabId: number, source: AiContextSource | null): number {
  const generation = ++nextGeneration;
  byTab.set(tabId, { source, generation });
  return generation;
}

export function editorContextForTab(tabId: number | undefined): AiContextSource | null {
  if (tabId == null) return null;
  return byTab.get(tabId)?.source ?? null;
}

export function isCurrentEditorContext(tabId: number, generation: number): boolean {
  return byTab.get(tabId)?.generation === generation;
}

export function clearEditorContext(tabId: number): void {
  byTab.delete(tabId);
}

/** Test-only reset for the service-worker-lifetime registry. */
export function resetEditorContexts(): void {
  byTab.clear();
  nextGeneration = 0;
}
