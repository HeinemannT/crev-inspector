/**
 * @vitest-environment happy-dom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockChromeStorage } from './chrome-mock';
import { confirmCommandModal } from '../modal';

beforeEach(async () => {
  document.body.textContent = '';
  mockChromeStorage();
  const now = Date.now();
  await chrome.storage.session.set({
    crev_settings_snapshot: {
      schemaVersion: 1,
      profiles: [{
        id: 'p1', label: 'Steadfast', bmpUrl: 'https://bmp.test/Steadfast/',
        bmpUser: 'config.user', bmpPass: '', commandAuthMode: 'stored',
      }],
      activeProfileId: 'p1', autoDetect: true, saveTarget: 'instance', enrichMode: 'all',
    },
    crev_conn_snapshot: {
      schema: 1,
      profileId: 'p1',
      environment: 'p1@https://bmp.test/Steadfast/',
      commandAuthRevision: '',
      expiresAt: now + 60_000,
      state: {
        display: 'connected',
        identities: {
          portal: { status: 'connected', user: 'portal.user', source: 'portal-session' },
          command: { status: 'connected', user: 'config.user', source: 'stored-login' },
          sameUser: false,
        },
        version: null, responseMs: 1, profileLabel: 'Steadfast', workspace: 'Steadfast',
        authError: null, networkOffline: false, lastUpdate: now,
        validation: 'idle', verifiedAt: now, semanticRevision: 1,
        incidentEpoch: 0, recoveryEpoch: 0,
        environment: 'p1@https://bmp.test/Steadfast/',
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
