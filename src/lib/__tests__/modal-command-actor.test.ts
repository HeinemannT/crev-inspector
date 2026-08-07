/**
 * @vitest-environment happy-dom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockChromeStorage } from './chrome-mock';
import { confirmCommandModal } from '../modal';

beforeEach(async () => {
  document.body.textContent = '';
  mockChromeStorage();
  await chrome.storage.session.set({
    crev_conn_snapshot: {
      identities: {
        portal: { status: 'connected', user: 'portal.user', source: 'portal-session' },
        command: { status: 'connected', user: 'config.user', source: 'stored-login' },
        sameUser: false,
      },
    },
  });
});

describe('confirmCommandModal', () => {
  it('shows the verified command actor without exposing auth material', async () => {
    const pending = confirmCommandModal({
      title: 'Save change',
      body: 'Write this value?',
      confirmLabel: 'Save',
    });
    await vi.waitFor(() => {
      const actor = document.querySelector('.crev-modal-actor');
      expect(actor?.textContent).toBe('Runs as config.user · stored configuration login');
    });
    expect(document.body.textContent).not.toContain('password');
    (document.querySelector('.crev-modal-actions .btn') as HTMLButtonElement).click();
    await expect(pending).resolves.toBe(false);
  });
});
