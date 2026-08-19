import type { InspectorMessage } from '../lib/types';

type FetchColorSets = Extract<InspectorMessage, { type: 'FETCH_COLOR_SETS' }>;
type ColorSetsData = Extract<InspectorMessage, { type: 'COLOR_SETS_DATA' }>;

/**
 * Object View is an extension iframe, not the side panel. It therefore cannot
 * rely on the worker's panel broadcast to feed the shared colour picker: it
 * must consume the one-shot response itself and route it into the picker.
 */
export async function requestObjectViewColorSets(
  message: FetchColorSets,
  request: (message: FetchColorSets) => Promise<ColorSetsData | undefined>,
  deliver: (message: ColorSetsData) => void,
): Promise<void> {
  try {
    const response = await request(message);
    deliver(response ?? {
      type: 'COLOR_SETS_DATA',
      environment: '',
      sets: [],
      error: 'No response from the extension',
    });
  } catch (error) {
    deliver({
      type: 'COLOR_SETS_DATA',
      environment: '',
      sets: [],
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
