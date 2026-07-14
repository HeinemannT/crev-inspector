/**
 * G4 — saved-style library I/O for the blueprint paintbrush. Talks to the SW's per-profile
 * StylePresetStore over the one-shot channel (LIST/SAVE/DELETE_STYLE_PRESET → STYLE_PRESETS_DATA) and
 * mirrors the result into `bp.presets`, re-rendering so the Load popup stays current.
 */
import { sendRequest } from '../lib/messaging';
import type { InspectorMessage } from '../lib/types';
import type { NodeStyle } from '../lib/layout/types';
import { bp } from './state';
import { render } from './view';
import { showToast } from '../lib/toast';

type PresetsData = Extract<InspectorMessage, { type: 'STYLE_PRESETS_DATA' }>;
let syncSeq = 0;

async function sync(msg: InspectorMessage, action: 'load' | 'save' | 'delete'): Promise<void> {
  const seq = ++syncSeq;
  const gen = bp.gen;
  bp.presetStatus = 'loading';
  if (bp.active) render();
  const res = await sendRequest<PresetsData>(msg);
  // A newer library operation, close/reopen, or profile switch owns the visible state now.
  if (seq !== syncSeq || gen !== bp.gen || !bp.active) return;
  if (!res) {
    bp.presetStatus = 'error';
    showToast(`Blueprint: could not ${action} saved styles`, 'error');
    if (bp.active) render();
    return;
  }
  bp.presets = res.presets;
  bp.presetStatus = 'ready';
  if (bp.active) render();
}

/** Fetch the library once (called when the paint station first needs it). */
export function loadPresets(): Promise<void> { return sync({ type: 'LIST_STYLE_PRESETS' }, 'load'); }

/** Save `style` under `name` (replaces a same-name preset). The SW echoes the fresh list back. */
export function savePreset(name: string, style: NodeStyle): Promise<void> {
  return sync({ type: 'SAVE_STYLE_PRESET', name, style }, 'save');
}

export function deletePreset(id: string): Promise<void> { return sync({ type: 'DELETE_STYLE_PRESET', id }, 'delete'); }
