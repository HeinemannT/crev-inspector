import type { ObjectReference } from '../../lib/types';
import type { AiContextEnvelope, AiContextSource } from '../../lib/ai/types';

export interface AiContextView {
  selection: ObjectReference | null;
  page: AiContextEnvelope['page'] | null;
}

export interface AiContextSnapshot extends AiContextView {
  server: AiContextEnvelope['server'];
}

/**
 * Session-lived owner of the AI Sidebar's attached context. It turns the live
 * panel snapshot into effective editor/selection sources while preserving the
 * webpage fallback across explicit selection detach, pinning, enrichment, and
 * profile changes.
 */
export class AiContextSession {
  private editorSource: AiContextSource | null = null;
  private pinnedSelection: AiContextSource | null = null;
  private webpageSelection: AiContextSource | null = null;
  private pinned = false;
  private detachedSelectionRid: string | null = null;
  private detachedEditorRid: string | null = null;

  get selectionPinned(): boolean { return this.pinned; }

  /** Adopt a normal editor broadcast. A different object reattaches itself;
   * an unchanged, explicitly detached editor stays detached. */
  setEditor(source: AiContextSource | null): void {
    this.editorSource = source;
    if (source && source.object.rid !== this.detachedEditorRid) this.detachedEditorRid = null;
  }

  /** A deliberate command-strip handoff always reattaches its editor source. */
  adoptEditor(source: AiContextSource): void {
    this.editorSource = source;
    this.detachedEditorRid = null;
  }

  /** Apply the authoritative panel selection update. Pinning freezes the
   * object choice, but still accepts identity enrichment for that same RID. */
  syncSelection(view: AiContextView): void {
    const { selection, page } = view;
    if (selection && selection.rid === page?.rid) {
      this.webpageSelection = sourceForObject(selection);
    }
    if (selection && selection.rid !== this.detachedSelectionRid) {
      this.detachedSelectionRid = null;
    }
    if (this.pinnedSelection && selection?.rid === this.pinnedSelection.object.rid) {
      this.pinnedSelection = enrichSource(this.pinnedSelection, selection);
    }
  }

  selection(view: AiContextView): AiContextSource | null {
    if (this.pinned && this.pinnedSelection) return this.pinnedSelection;
    const { selection, page } = view;
    if (selection?.rid && selection.rid !== this.detachedSelectionRid) {
      const source = sourceForObject(selection);
      if (selection.rid === page?.rid) this.webpageSelection = source;
      return source;
    }

    const pageRid = page?.rid;
    if (!pageRid) return null;
    if (this.webpageSelection?.object.rid === pageRid) return this.webpageSelection;
    this.webpageSelection = sourceForObject({ rid: pageRid });
    return this.webpageSelection;
  }

  editor(): AiContextSource | null {
    if (!this.editorSource || this.editorSource.object.rid === this.detachedEditorRid) return null;
    return this.editorSource;
  }

  envelope(snapshot: AiContextSnapshot): AiContextEnvelope {
    const sources: AiContextSource[] = [];
    const editor = this.editor();
    const selection = this.selection(snapshot);
    if (editor) sources.push(editor);
    if (selection) sources.push(selection);
    return {
      v: 1,
      server: snapshot.server,
      ...(snapshot.page ? { page: { ...snapshot.page } } : {}),
      sources,
    };
  }

  toggleSelectionPin(view: AiContextView): void {
    if (this.pinned) {
      this.pinned = false;
      this.pinnedSelection = null;
      return;
    }
    const selection = this.selection(view);
    if (!selection || this.isPageFallback(selection, view)) return;
    this.pinned = true;
    this.pinnedSelection = selection;
  }

  isPageFallback(source: AiContextSource, view: AiContextView): boolean {
    return source.kind === 'selection' && source.object.rid === view.page?.rid;
  }

  detach(source: AiContextSource): void {
    if (source.kind === 'selection') {
      this.detachedSelectionRid = source.object.rid;
      this.pinned = false;
      this.pinnedSelection = null;
      return;
    }
    this.detachedEditorRid = source.object.rid;
  }

  reset(): void {
    this.editorSource = null;
    this.pinnedSelection = null;
    this.webpageSelection = null;
    this.pinned = false;
    this.detachedSelectionRid = null;
    this.detachedEditorRid = null;
  }
}

function sourceForObject(object: ObjectReference): AiContextSource {
  return {
    kind: 'selection',
    object: {
      rid: object.rid,
      businessId: object.businessId ?? '',
      name: object.name ?? '',
      type: object.type ?? '',
    },
  };
}

function enrichSource(source: AiContextSource, object: ObjectReference): AiContextSource {
  return {
    ...source,
    object: {
      ...source.object,
      businessId: source.object.businessId || object.businessId || '',
      name: source.object.name || object.name || '',
      type: source.object.type || object.type || '',
    },
  };
}
