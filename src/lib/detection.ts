import type { DetectionPhase } from './types';
import { debounce } from './util';
import { log } from './logger';

export type TabDetectionEntry = { phase: DetectionPhase; confidence: number; signals: string[] };

const tabDetection = new Map<number, TabDetectionEntry>();

export function getTabDetection(tabId: number): TabDetectionEntry | undefined {
  return tabDetection.get(tabId);
}

export function setTabDetection(tabId: number, entry: TabDetectionEntry) {
  tabDetection.set(tabId, entry);
  persistTabDetection();
}

export function deleteTabDetection(tabId: number) {
  tabDetection.delete(tabId);
  persistTabDetection();
}

const persistTabDetection = debounce(() => {
  const obj: Record<string, TabDetectionEntry> = {};
  for (const [id, det] of tabDetection) obj[String(id)] = det;
  chrome.storage.session.set({ crev_tab_detection: obj }).catch(e => log.swallow('detection:persist', e));
}, 300);

export async function loadTabDetection() {
  try {
    const stored = await chrome.storage.session.get('crev_tab_detection');
    const obj = stored.crev_tab_detection;
    if (obj && typeof obj === 'object') {
      for (const [key, val] of Object.entries(obj)) {
        const tabId = Number(key);
        if (!isNaN(tabId) && val && typeof val === 'object') {
          tabDetection.set(tabId, val as TabDetectionEntry);
        }
      }
    }
  } catch (e) { log.swallow('detection:load', e); }
}

export function updateBadge(tabId: number, isBmp: boolean) {
  if (isBmp) {
    chrome.action.setBadgeText({ tabId, text: ' ' }).catch(e => log.swallow('detection:badge', e));
    chrome.action.setBadgeBackgroundColor({ tabId, color: '#42be65' }).catch(e => log.swallow('detection:badgeColor', e));
  } else {
    chrome.action.setBadgeText({ tabId, text: '' }).catch(e => log.swallow('detection:clearBadge', e));
  }
}
