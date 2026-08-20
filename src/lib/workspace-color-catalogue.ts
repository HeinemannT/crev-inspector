import { ColorSetIndex, type ColorRef } from './color-index';
import type { ColorSetData, InspectorMessage } from './types';

export type ColorCatalogueStatus = 'idle' | 'loading' | 'ready' | 'stale' | 'error';
export type ColorSetsMessage = Extract<InspectorMessage, { type: 'COLOR_SETS_DATA' }>;

export interface ColorCatalogueSnapshot {
  sets: ColorSetData[] | null;
  status: ColorCatalogueStatus;
  error: string | null;
}

type Subscriber = () => void;
type FetchColorSets = (force: boolean) => Promise<ColorSetsMessage | undefined>;

/**
 * One realm's workspace colour catalogue. It owns the raw snapshot, indexed
 * lookup, stale/error distinctions, request de-duplication, and reset races;
 * callers provide only the realm-appropriate transport and rendering adapter.
 */
export class WorkspaceColorCatalogue {
  private setsValue: ColorSetData[] | null = null;
  private statusValue: ColorCatalogueStatus = 'idle';
  private errorValue: string | null = null;
  private readonly index = new ColorSetIndex();
  private readonly subscribers = new Set<Subscriber>();
  private generation = 0;
  private inFlight: Promise<boolean> | null = null;

  snapshot(): ColorCatalogueSnapshot {
    return { sets: this.setsValue, status: this.statusValue, error: this.errorValue };
  }

  lookup(bid: string | null | undefined): ColorRef | null { return this.index.lookup(bid); }
  rgb(bid: string | null | undefined): string | null { return this.index.rgb(bid); }

  subscribe(subscriber: Subscriber): () => void {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  beginLoad(): void {
    this.statusValue = 'loading';
    this.errorValue = null;
    this.publish();
  }

  receive(message: ColorSetsMessage): void {
    this.errorValue = message.error ?? null;
    if (message.error && message.sets.length === 0) {
      this.statusValue = this.setsValue === null ? 'error' : 'stale';
      this.publish();
      return;
    }
    this.setsValue = message.sets;
    this.index.load(message.sets);
    this.statusValue = message.stale ? 'stale' : 'ready';
    this.publish();
  }

  /** Fetch through a request/response transport. Concurrent callers share one
   * request; a reset invalidates any response still in flight. */
  load(fetch: FetchColorSets, force = false): Promise<boolean> {
    if (this.inFlight) return this.inFlight.then(() => false);
    if (this.setsValue !== null && !force) return Promise.resolve(false);
    const generation = this.generation;
    this.beginLoad();
    let request!: Promise<boolean>;
    request = Promise.resolve().then(async () => {
      try {
        const response = await fetch(force);
        if (generation !== this.generation) return false;
        this.receive(response ?? failedMessage('No response from the extension'));
        return true;
      } catch (error) {
        if (generation !== this.generation) return false;
        this.receive(failedMessage(error instanceof Error ? error.message : String(error)));
        return true;
      } finally {
        if (this.inFlight === request) this.inFlight = null;
      }
    });
    this.inFlight = request;
    return request;
  }

  reset(): void {
    this.generation += 1;
    this.inFlight = null;
    this.setsValue = null;
    this.statusValue = 'idle';
    this.errorValue = null;
    this.index.clear();
    this.publish();
  }

  private publish(): void {
    for (const subscriber of this.subscribers) subscriber();
  }
}

function failedMessage(error: string): ColorSetsMessage {
  return { type: 'COLOR_SETS_DATA', environment: '', sets: [], error };
}
