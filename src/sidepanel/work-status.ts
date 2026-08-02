import type { ActivityEntry, InspectorMessage } from '../lib/types';

export interface WorkStatus {
  text: string;
  title?: string;
  working: boolean;
}

const working = (text: string, title?: string): WorkStatus => ({ text, title, working: true });
const settled = (text: string, title?: string): WorkStatus => ({ text, title, working: false });

/**
 * Small, user-facing summary of work crossing the panel port.
 *
 * This intentionally covers meaningful waits and outcomes rather than every
 * protocol message. Background state sync (GET_SETTINGS, GET_PAGE_INFO, …)
 * should not make the footer chatter during startup.
 */
export function workStatusForMessage(msg: InspectorMessage): WorkStatus | null {
  switch (msg.type) {
    case 'CONNECTION_TEST': return working('Checking connection…');
    case 'SET_ACTIVE_PROFILE': return working('Switching server…');
    case 'SAVE_PROFILE': return working('Saving server…');
    case 'CLEAR_CACHE': return working('Clearing cache…');
    case 'RESET_ALL': return working('Resetting state…');

    case 'FETCH_OBJECT_PANE':
    case 'FULL_LOOKUP':
    case 'SERVER_LOOKUP':
    case 'SERVER_LOOKUP_BATCH':
      return working('Loading object…');
    case 'OBJECT_PANE_DATA':
    case 'FULL_LOOKUP_RESULT':
    case 'SERVER_LOOKUP_RESULT':
    case 'SERVER_LOOKUP_BATCH_RESULT':
      return settled(msg.error ? 'Object load failed' : 'Object loaded');
    case 'FETCH_CHILDREN': return working('Loading children…');
    case 'FETCH_CHILDREN_RESULT': return settled(msg.error ? 'Children load failed' : 'Children loaded');
    case 'FETCH_LAYOUT_TREE': return working('Loading layout…');
    case 'LAYOUT_TREE_RESULT': return settled(msg.error ? 'Layout load failed' : 'Layout loaded');
    case 'FETCH_FLOW_CHAIN': return working('Loading flow…');
    case 'FLOW_CHAIN_DATA': return settled(msg.error ? 'Flow load failed' : 'Flow loaded');
    case 'FETCH_CONNECTIONS':
    case 'FETCH_INBOUND':
      return working('Loading relations…');
    case 'CONNECTIONS_RESULT':
    case 'INBOUND_RESULT':
      return settled(!msg.ok ? 'Relations load failed' : 'Relations loaded');

    case 'FETCH_ACCESS_SUBJECTS': return working('Loading access…');
    case 'ACCESS_SUBJECTS_DATA': return settled(msg.error ? 'Access load failed' : 'Access loaded');
    case 'REQUEST_ACCESS_TRACE': return working('Tracing access…');
    case 'ACCESS_TRACE_RESULT': return settled(msg.error ? 'Access trace failed' : 'Access trace ready');

    case 'BROWSE_SEARCH': return working('Searching workspace…');
    case 'BROWSE_SEARCH_RESULT':
      return settled(msg.ok ? `${msg.totalHits ?? msg.objects?.length ?? 0} found` : 'Search failed');
    case 'CODE_SEARCH_START': return working('Searching code…');
    case 'CODE_SEARCH_PROGRESS':
      return working(msg.total > 0 ? `Searching code ${msg.searched}/${msg.total}` : 'Searching code…');
    case 'CODE_SEARCH_DONE':
      return settled(msg.error ? 'Code search failed' : `${msg.totalResults} matches`);
    case 'SEARCH_REFERENCES': return working('Searching references…');

    case 'FETCH_COLOR_SETS': return working('Loading colors…');
    case 'COLOR_SETS_DATA': return settled(msg.error ? 'Color load failed' : 'Colors loaded');
    case 'FETCH_TYPE_SCHEMA':
    case 'FETCH_TYPE_SCHEMAS':
    case 'FETCH_TYPE_OPTIONS':
      return working('Loading fields…');
    case 'FETCH_TYPE_SCHEMA_RESULT':
    case 'FETCH_TYPE_SCHEMAS_RESULT':
    case 'FETCH_TYPE_OPTIONS_RESULT':
      return settled('ok' in msg && !msg.ok ? 'Field load failed' : 'Fields loaded');
    case 'FETCH_PROPERTY_APPLICATIONS': return working('Loading applicationsâ€¦');
    case 'PROPERTY_APPLICATIONS_RESULT':
      return settled(msg.ok ? 'Applications loaded' : 'Application load failed');

    case 'SAVE_PROPERTY':
    case 'SAVE_IDENTITY':
    case 'APPLY_OBJECT_CHANGES':
      return working('Saving changes…');
    case 'SAVE_RESULT':
    case 'SAVE_IDENTITY_RESULT':
    case 'APPLY_CHANGES_RESULT':
      return settled(msg.ok ? 'Changes saved' : 'Save failed');

    case 'REFRESH_ENRICHMENT':
    case 'RE_ENRICH':
      return working('Refreshing badges…');
    case 'BADGE_ENRICHMENT': {
      const count = Object.keys(msg.enrichments).length;
      return settled(`${count} ${count === 1 ? 'object' : 'objects'} enriched`);
    }

    case 'LAYOUT_LOAD': return working('Loading Blueprint…');
    case 'LAYOUT_LOAD_RESULT': return settled(msg.ok ? 'Blueprint ready' : 'Blueprint load failed');
    case 'LAYOUT_APPLY': return working('Applying Blueprint…');
    case 'LAYOUT_APPLY_RESULT':
      return settled(msg.ok ? (msg.noop ? 'Blueprint unchanged' : 'Blueprint applied') : 'Blueprint apply failed');
    case 'LAYOUT_PORTABLE_ID_PREFLIGHT': return working('Checking IDs…');
    case 'LAYOUT_PORTABLE_ID_PREFLIGHT_RESULT':
      return settled(msg.ok ? 'IDs ready' : 'ID check failed');
    case 'LAYOUT_BLAST': return working('Checking impact…');
    case 'LAYOUT_BLAST_RESULT': return settled('Impact check ready');
    case 'LAYOUT_FLOW_REFS':
    case 'LAYOUT_FLOW_REF_CHILDREN':
      return working('Loading flow options…');
    case 'LAYOUT_FLOW_REFS_RESULT':
    case 'LAYOUT_FLOW_REF_CHILDREN_RESULT':
      return settled(msg.ok ? 'Flow options ready' : 'Flow options failed');

    case 'AI_TEST': return working('Testing AI…');
    case 'AI_LIST_MODELS': return working('Loading AI models…');
    case 'AI_CHAT_SEND':
    case 'AI_REQUEST':
      return working('AI working…');
    case 'AI_PREVIEW_CODE': return working('Previewing code…');
    case 'AI_TEST_RESULT': return settled(msg.ok ? 'AI connected' : 'AI test failed');
    case 'AI_MODELS_RESULT': return settled(msg.ok ? 'AI models loaded' : 'AI models failed');
    case 'AI_PREVIEW_RESULT': return settled(msg.ok ? 'Preview ready' : 'Preview failed');

    default:
      return null;
  }
}

/**
 * Activity-log copy can be descriptive; the footer cannot. Keep its summary
 * terse while retaining the original entry as the hover title.
 */
export function compactActivityStatus(entry: ActivityEntry): WorkStatus {
  const message = entry.message.trim();
  const enriching = /^Enriching\s+(\d+)(?:\s+objects?)?(?:\s+from\s+server)?(?:\.\.\.|…)?$/i.exec(message);
  if (enriching) return working(`Enriching ${enriching[1]}…`, message);

  const enriched = /^Enriched\s+(\d+)\s+objects?/i.exec(message);
  if (enriched) {
    const count = Number(enriched[1]);
    return settled(`${count} ${count === 1 ? 'object' : 'objects'} enriched`, message);
  }

  if (/^Testing (?:command )?connection/i.test(message)) return working('Checking connection…', message);
  if (/^Injecting content script/i.test(message)) return working('Starting inspector…', message);
  if (/^Content script connected/i.test(message)) return settled('Inspector ready', message);
  if (/^Searching references/i.test(message)) return working('Searching references…', message);

  return {
    text: message,
    title: message,
    working: /(?:\.\.\.|…)$/.test(message),
  };
}
