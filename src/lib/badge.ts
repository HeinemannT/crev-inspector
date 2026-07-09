import type { ConnectionState } from './types';

/** Update the extension toolbar badge to reflect connection state. */
export function updateBadge(display: ConnectionState['display']): void {
  switch (display) {
    case 'connected':
    case 'online':
    case 'checking':
      void chrome.action.setBadgeText({ text: '' });
      break;
    case 'auth-failed':
    case 'server-down':
    case 'unreachable':
    case 'needs-login':
    case 'no-config-access':
    case 'needs-access':
      void chrome.action.setBadgeText({ text: '!' });
      void chrome.action.setBadgeBackgroundColor({ color: '#f2b8b5' });
      break;
    case 'not-configured':
      void chrome.action.setBadgeText({ text: '?' });
      void chrome.action.setBadgeBackgroundColor({ color: '#938f99' });
      break;
    default: {
      // Exhaustiveness guard: a new ConnectionState['display'] must add a case
      // here (this is what silently went stale for needs-login/no-config-access).
      const _exhaustive: never = display;
      void _exhaustive;
      void chrome.action.setBadgeText({ text: '' });
    }
  }
}
