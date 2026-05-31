/**
 * Window launcher handlers — object view, diff, code search.
 */

import { register } from '../handler-registry';
import { getCtx } from '../sw-context';
import { COMMON_DIFF_PROPS } from '../constants';
import { CODE_PROPS_FOR_TYPE } from '../types';
import { errorMessage } from '../logger';
import { openObjectViewWindow } from '../objectview-launcher';
import { openDiffWindow } from '../diff-launcher';
import { openCodeSearchWindow } from '../codesearch-launcher';
import { startCodeSearch, stopCodeSearch } from '../code-search';

register('OPEN_OBJECT_VIEW', (msg, _respond, meta) => {
  openObjectViewWindow(msg.rid, { tabId: meta.senderTabId, windowId: meta.panelWindowId });
});

register('OPEN_LAYOUT_FOR', (msg, _respond, meta) => {
  // Popout-to-side-panel cross-window hop. The window-scoped sender
  // is the popout; we forward to whatever panel is bound to the
  // SAME window context so the user lands in the side panel they
  // were already working with. Falls back to the broadcast helper
  // if windowId routing can't pin a panel.
  const ctx = getCtx();
  if (meta.panelWindowId != null) {
    ctx.sendToPanelByWindow(meta.panelWindowId, msg);
  } else {
    ctx.sendToPanel(msg);
  }
});

register('OPEN_DIFF', (msg, _respond, meta) => {
  openDiffWindow(msg.leftRid, msg.rightRid, undefined, { tabId: meta.senderTabId, windowId: meta.panelWindowId });
});

register('OPEN_TEMPLATE_DIFF', async (msg, _respond, meta) => {
  const ctx = getCtx();
  if (!ctx.client) return;
  const tmpl = await ctx.client.resolveTemplate(msg.rid);
  if (tmpl.templateRid) {
    openDiffWindow(tmpl.templateRid, msg.rid, 'template', { tabId: meta.senderTabId, windowId: meta.panelWindowId });
  }
});

register('OPEN_CODE_SEARCH', (_msg, _respond, meta) => {
  openCodeSearchWindow({ tabId: meta.senderTabId, windowId: meta.panelWindowId });
});

register('CODE_SEARCH_START', (msg) => {
  startCodeSearch(msg.query, msg.subtreeRid, msg.types, { caseSensitive: msg.caseSensitive ?? true });
});

register('SEARCH_REFERENCES', (msg) => {
  // Search for references to this object's businessId across all code
  const query = msg.businessId || msg.rid;
  if (!query) return;
  const ctx = getCtx();
  ctx.logActivity('info', `Searching references for ${query}…`);
  // BIDs are exact strings — case-sensitive search hits the fast
  // server-side path AND avoids spurious matches in BMP code that
  // happens to contain similarly-cased substrings.
  startCodeSearch(query, undefined, undefined, { caseSensitive: true });
  // Tell panel to show reference results view
  ctx.sendToPanel({ type: 'SEARCH_REFERENCES', rid: msg.rid, businessId: msg.businessId, objectType: msg.objectType, name: msg.name });
});

register('CODE_SEARCH_STOP', () => {
  stopCodeSearch();
});

/** Resolve a BID-style reference ("t.someBid") to a numeric RID via EC.
 *  Returns null if EC didn't yield a usable rid (object missing, syntax bad).
 *  Used by the Diff page so users can paste either form interchangeably. */
async function resolveBidToRid(ref: string): Promise<string | null> {
  const ctx = getCtx();
  if (!ctx.client) return null;
  // Sanitize: namespace.id format only — anything weirder gets rejected at
  // the EC parser anyway, but we don't want to dump arbitrary user input
  // into the script body. Allowed: lowercase prefix + dot + alphanumeric/_/-
  if (!/^[a-z]+\.[A-Za-z0-9_-]+$/.test(ref)) return null;
  try {
    // Wrap the value in output() so EC reliably writes a "Result: <rid>" line
    // to the log. Without output(), some EC versions only return the value
    // without logging it, and a bare `.rid` expression's result wasn't
    // appearing in result.log reliably.
    const result = await ctx.client.executeEc(`output(${ref}.rid)`);
    if (!result.ok || !result.log) return null;
    // Walk the log lines from the LAST one back — EC writes the result line
    // at the end. Greedy-matching the first 6+ digit run would catch
    // unrelated long numbers in earlier log noise (timestamps, line numbers).
    const lines = result.log.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const trimmed = lines[i].trim();
      // Standalone numeric line or "Result: <n>" / "Message: Result: <n>"
      const m = trimmed.match(/^(?:.*Result\s*:\s*)?(-?\d{6,})\s*$/);
      if (m) return m[1];
    }
    return null;
  } catch {
    return null;
  }
}

register('FETCH_DIFF_PROPS', async (msg, respond) => {
  const ctx = getCtx();
  if (!ctx.client) {
    respond({ type: 'DIFF_PROPS_RESULT', rid: msg.rid, props: {}, identity: {}, error: 'Not connected' });
    return;
  }
  try {
    // Accept either a numeric RID or a "ns.bid" reference. BID form goes
    // through one extra EC round-trip up front; numeric goes direct.
    let rid = msg.rid;
    if (!/^-?\d+$/.test(rid)) {
      const resolved = await resolveBidToRid(rid);
      if (!resolved) {
        respond({ type: 'DIFF_PROPS_RESULT', rid: msg.rid, props: {}, identity: {}, error: `Could not resolve "${rid}": expected RID or namespace.bid form` });
        return;
      }
      rid = resolved;
    }
    const identity = await ctx.client.lookupIdentity(rid);
    if (!identity) {
      respond({ type: 'DIFF_PROPS_RESULT', rid, props: {}, identity: {}, error: 'Object not found' });
      return;
    }
    const type = identity.type ?? '';
    const codePropsForType = CODE_PROPS_FOR_TYPE[type] ?? [];
    const allProps = [...new Set([...COMMON_DIFF_PROPS, ...codePropsForType])];
    const props = await ctx.client.fetchCodeViaEc(rid, allProps);
    respond({ type: 'DIFF_PROPS_RESULT', rid, props, identity });
  } catch (e) {
    respond({ type: 'DIFF_PROPS_RESULT', rid: msg.rid, props: {}, identity: {}, error: errorMessage(e) });
  }
});
