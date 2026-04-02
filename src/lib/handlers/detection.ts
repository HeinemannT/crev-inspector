/**
 * BMP detection and page info handlers.
 */

import { register } from '../handler-registry';
import { getCtx } from '../sw-context';
import { getTabDetection, setTabDetection, updateBadge } from '../detection';
import { sendPageInfoToPanel, handleGetDetection } from '../tab-awareness';
import { getContextRid } from '../context-rid';
import type { DetectionPhase } from '../types';

register('DETECTION_RESULT', (msg, respond, meta) => {
  const ctx = getCtx();
  const phase: DetectionPhase = msg.isBmp ? 'detected' : 'not-detected';
  const senderTabId = meta.senderTabId;

  // Only log when detection state actually changes
  const prevDet = senderTabId != null ? getTabDetection(senderTabId) : undefined;
  if (!prevDet || prevDet.phase !== phase) {
    const pct = Math.round(msg.confidence * 100);
    ctx.logActivity(msg.isBmp ? 'success' : 'info', msg.isBmp ? `Detection: BMP page (${pct}%)` : `Detection: not BMP (${pct}%)`);
  }
  if (senderTabId != null) {
    setTabDetection(senderTabId, { phase, confidence: msg.confidence, signals: msg.signals });
    updateBadge(senderTabId, msg.isBmp);
  }
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]?.id === senderTabId) {
      ctx.sendToPanel({ type: 'DETECTION_STATE', phase, confidence: msg.confidence, signals: msg.signals });
    }
  });
});

register('GET_PAGE_INFO', () => {
  sendPageInfoToPanel();
});

register('GET_DETECTION', () => {
  handleGetDetection();
});

register('GET_CONTEXT_RID', () => {
  const ctx = getCtx();
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tabId = tabs[0]?.id;
    const entry = tabId != null ? getContextRid(tabId) : undefined;
    ctx.sendToPanel({
      type: 'CONTEXT_RID_DATA',
      rid: entry?.rid,
      name: entry?.name,
      type: entry?.type,
      businessId: entry?.businessId,
    });
  });
});
