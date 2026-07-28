import {
  DEFAULT_PORTABLE_ID_CONFIG,
  portableIdPatternError,
  type PortableIdConfig,
} from '../lib/layout/portable-ids';
import { showToast } from '../lib/toast';
import { bp } from './state';
import { render } from './view';

/** Global by design: a portable-ID recipe should remain identical while the user moves between
 * environments. Storing it per server would recreate the very drift this feature prevents. */
const STORAGE_KEY = 'crev_blueprint_portable_ids';
let draftSaveTimer: ReturnType<typeof setTimeout> | null = null;

function normalize(raw: unknown): PortableIdConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_PORTABLE_ID_CONFIG };
  const candidate = raw as Partial<PortableIdConfig>;
  const pattern = typeof candidate.pattern === 'string' && !portableIdPatternError(candidate.pattern)
    ? candidate.pattern
    : DEFAULT_PORTABLE_ID_CONFIG.pattern;
  return { enabled: candidate.enabled === true, pattern };
}

export async function loadPortableIdConfig(): Promise<void> {
  bp.idConfigStatus = 'loading';
  try {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) {
      bp.idConfig = { ...DEFAULT_PORTABLE_ID_CONFIG };
    } else {
      const stored = await chrome.storage.local.get(STORAGE_KEY);
      bp.idConfig = normalize(stored[STORAGE_KEY]);
    }
    bp.idConfigStatus = 'ready';
  } catch {
    bp.idConfigStatus = 'error';
    bp.idConfig = { ...DEFAULT_PORTABLE_ID_CONFIG };
  }
  if (bp.active) render();
}

export function setPortableIdPatternDraft(pattern: string): string | null {
  bp.idConfig = { ...bp.idConfig, pattern };
  const error = portableIdPatternError(pattern);
  if (draftSaveTimer) clearTimeout(draftSaveTimer);
  if (!error) {
    const snapshot = { ...bp.idConfig };
    draftSaveTimer = setTimeout(() => {
      draftSaveTimer = null;
      if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        void chrome.storage.local.set({ [STORAGE_KEY]: snapshot }).catch(() => {});
      }
    }, 350);
  }
  return error;
}

export async function savePortableIdConfig(next: PortableIdConfig): Promise<boolean> {
  const error = portableIdPatternError(next.pattern);
  if (error) {
    showToast(`Blueprint IDs: ${error}`, 'error');
    return false;
  }
  if (draftSaveTimer) { clearTimeout(draftSaveTimer); draftSaveTimer = null; }
  bp.idConfig = { ...next };
  bp.idConfigStatus = 'ready';
  if (bp.active) render();
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      await chrome.storage.local.set({ [STORAGE_KEY]: bp.idConfig });
    }
    return true;
  } catch {
    showToast('Blueprint IDs: could not save the setting.', 'error');
    return false;
  }
}

export function setPortableIdsEnabled(enabled: boolean): void {
  void savePortableIdConfig({ ...bp.idConfig, enabled });
}

export function persistPortableIdPattern(): void {
  void savePortableIdConfig(bp.idConfig);
}
