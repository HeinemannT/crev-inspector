/**
 * Window launcher handlers — object view, diff, code search.
 */

import { register } from '../handler-registry';
import { getCtx } from '../sw-context';
import { COMMON_DIFF_PROPS } from '../constants';
import { CODE_PROPS_FOR_TYPE } from '../types';
import { errorMessage, log } from '../logger';

// Lazy-loaded modules
let objectViewLauncher: typeof import('../objectview-launcher') | null = null;
let diffLauncher: typeof import('../diff-launcher') | null = null;
let codeSearchModule: typeof import('../code-search') | null = null;
let codeSearchLauncher: typeof import('../codesearch-launcher') | null = null;

async function loadObjectViewLauncher() {
  if (!objectViewLauncher) objectViewLauncher = await import('../objectview-launcher');
  return objectViewLauncher;
}
async function loadDiffLauncher() {
  if (!diffLauncher) diffLauncher = await import('../diff-launcher');
  return diffLauncher;
}
async function loadCodeSearch() {
  if (!codeSearchModule) codeSearchModule = await import('../code-search');
  return codeSearchModule;
}
async function loadCodeSearchLauncher() {
  if (!codeSearchLauncher) codeSearchLauncher = await import('../codesearch-launcher');
  return codeSearchLauncher;
}

register('OPEN_OBJECT_VIEW', (msg) => {
  loadObjectViewLauncher().then(m => m.openObjectViewWindow(msg.rid)).catch(e => log.swallow('handler:openObjectView', e));
});

register('OPEN_DIFF', (msg) => {
  loadDiffLauncher().then(m => m.openDiffWindow(msg.leftRid, msg.rightRid)).catch(e => log.swallow('handler:openDiff', e));
});

register('OPEN_TEMPLATE_DIFF', (msg) => {
  const ctx = getCtx();
  ctx.settingsReady.then(async () => {
    if (!ctx.client) return;
    const tmpl = await ctx.client.resolveTemplate(msg.rid);
    if (tmpl.templateRid) {
      const m = await loadDiffLauncher();
      m.openDiffWindow(tmpl.templateRid, msg.rid, 'template');
    }
  });
});

register('OPEN_CODE_SEARCH', () => {
  loadCodeSearchLauncher().then(m => m.openCodeSearchWindow()).catch(e => log.swallow('handler:openCodeSearch', e));
});

register('CODE_SEARCH_START', (msg) => {
  loadCodeSearch().then(m => m.startCodeSearch(msg.query, msg.subtreeRid, msg.types)).catch(e => log.swallow('handler:codeSearch', e));
});

register('SEARCH_REFERENCES', (msg) => {
  // Search for references to this object's businessId across all code
  const query = msg.businessId || msg.rid;
  if (!query) return;
  const ctx = getCtx();
  ctx.logActivity('info', `Searching references for ${query}\u2026`);
  // Route results to panel (CODE_SEARCH_PROGRESS / DONE messages go to panel automatically)
  loadCodeSearch().then(m => m.startCodeSearch(query)).catch(e => log.swallow('handler:searchRefs', e));
  // Tell panel to show reference results view
  ctx.sendToPanel({ type: 'SEARCH_REFERENCES', rid: msg.rid, businessId: msg.businessId, objectType: msg.objectType, name: msg.name });
});

register('CODE_SEARCH_STOP', () => {
  loadCodeSearch().then(m => m.stopCodeSearch()).catch(e => log.swallow('handler:codeSearchStop', e));
});

register('FETCH_DIFF_PROPS', async (msg, respond) => {
  const ctx = getCtx();
  await ctx.settingsReady;
  if (!ctx.client) {
    respond({ type: 'DIFF_PROPS_RESULT', rid: msg.rid, props: {}, identity: {}, error: 'Not connected' });
    return;
  }
  try {
    const identity = await ctx.client.lookupIdentity(msg.rid);
    if (!identity) {
      respond({ type: 'DIFF_PROPS_RESULT', rid: msg.rid, props: {}, identity: {}, error: 'Object not found' });
      return;
    }
    const type = identity.type ?? '';
    const codePropsForType = CODE_PROPS_FOR_TYPE[type] ?? [];
    const allProps = [...new Set([...COMMON_DIFF_PROPS, ...codePropsForType])];
    const props = await ctx.client.fetchCodeViaEc(msg.rid, allProps);
    respond({ type: 'DIFF_PROPS_RESULT', rid: msg.rid, props, identity });
  } catch (e) {
    respond({ type: 'DIFF_PROPS_RESULT', rid: msg.rid, props: {}, identity: {}, error: errorMessage(e) });
  }
}, true);
