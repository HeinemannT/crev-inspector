import type { ConnectionState } from './types';

/** Update the extension toolbar badge to reflect connection state. */
export function updateBadge(display: ConnectionState['display']): void {
  switch (display) {
    case 'connected':
    case 'online':
    case 'checking':
      chrome.action.setBadgeText({ text: '' });
      break;
    case 'auth-failed':
    case 'server-down':
    case 'unreachable':
      chrome.action.setBadgeText({ text: '!' });
      chrome.action.setBadgeBackgroundColor({ color: '#f2b8b5' });
      break;
    case 'not-configured':
      chrome.action.setBadgeText({ text: '?' });
      chrome.action.setBadgeBackgroundColor({ color: '#938f99' });
      break;
  }
}
