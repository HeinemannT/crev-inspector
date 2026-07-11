/**
 * Tests for the Connect tab's AI Assistant card (server-row twin):
 *   - unconfigured → quiet row with a Set up button, no pill, no keyline
 *   - configured + untested → UNTESTED pill, no green keyline, Edit
 *   - configured + last test ok → READY pill, green keyline, latency + dot
 *   - row click expands the existing config form; AI_TEST_RESULT persists
 *     the lastTest into shared settings for the collapsed card.
 *
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { InspectorMessage, InspectorSettings } from '../../lib/types';
import { DEFAULT_SETTINGS } from '../../lib/types';

vi.mock('../state', () => ({
  S: {
    activeTab: 'connect',
    settings: { schemaVersion: 3, profiles: [], activeProfileId: '', autoDetect: true, saveTarget: 'template', enrichMode: 'widgets' },
    connState: { display: 'connected', version: null, responseMs: null, profileLabel: null, user: null, workspace: null, authError: null, networkOffline: false, lastUpdate: 0 },
    cacheCount: 0,
    context: null,
    lastEcMs: null,
  },
  getTabPanel: () => null,
  sendMessage: vi.fn(),
}));

import { ConnectTab } from '../tabs/connect-tab';
import { S as shared } from '../state';

// Minimal chrome surface the render path touches (update banner version).
(globalThis as { chrome?: unknown }).chrome = {
  runtime: { getManifest: () => ({ version: '0.0.0-test' }) },
};

function freshSettings(ai?: InspectorSettings['ai']): InspectorSettings {
  return { ...DEFAULT_SETTINGS, profiles: [], activeProfileId: '', ...(ai ? { ai } : {}) };
}

function renderTab(): { tab: ConnectTab; el: HTMLElement; sent: InspectorMessage[] } {
  const sent: InspectorMessage[] = [];
  const tab = new ConnectTab((m) => sent.push(m));
  // handleMessage(SETTINGS_DATA) is how aiConfigured normally syncs; mimic it.
  tab.handleMessage({ type: 'SETTINGS_DATA', settings: shared.settings });
  const el = document.createElement('div');
  document.body.appendChild(el);
  tab.render(el);
  return { tab, el, sent };
}

beforeEach(() => {
  document.body.textContent = '';
});

describe('AI Assistant card states', () => {
  it('unconfigured: quiet row, Set up button, no pill, no keyline', () => {
    shared.settings = freshSettings();
    const { el } = renderTab();
    const card = el.querySelector('.ai-card')!;
    expect(card).toBeTruthy();
    expect(card.classList.contains('ready')).toBe(false);
    expect(card.querySelector('.ai-pill')).toBeNull();
    expect(card.textContent).toContain('AI Assistant');
    expect(card.textContent).toContain('Set up');
    expect(card.textContent).toContain('Bring your own API key');
    // Collapsed by default — no form.
    expect(el.querySelector('.ai-form')).toBeNull();
    // Sparkle rendered directly, not in a tile.
    expect(card.querySelector('.ai-card-spark svg')).toBeTruthy();
  });

  it('configured but untested: UNTESTED pill, mono line, Edit, no keyline', () => {
    shared.settings = freshSettings({ provider: 'deepseek', model: 'deepseek-chat', apiKeyEnc: 'set' });
    const { el } = renderTab();
    const card = el.querySelector('.ai-card')!;
    expect(card.classList.contains('ready')).toBe(false);
    expect(card.querySelector('.ai-pill--warn')?.textContent).toBe('UNTESTED');
    expect(card.querySelector('.ai-card-ln2')?.textContent).toBe('DeepSeek · deepseek-chat · key saved');
    expect(card.querySelector('.ai-card-edit')?.textContent).toBe('Edit');
    expect(card.querySelector('.ai-card-latency')).toBeNull();
  });

  it('configured + verified: READY pill, green keyline, dot + latency', () => {
    shared.settings = freshSettings({
      provider: 'anthropic', model: 'claude-sonnet-5', apiKeyEnc: 'set',
      lastTest: { ok: true, ms: 412, at: Date.now() },
    });
    const { el } = renderTab();
    const card = el.querySelector('.ai-card')!;
    expect(card.classList.contains('ready')).toBe(true);
    expect(card.querySelector('.ai-pill--ok')?.textContent).toBe('READY');
    expect(card.querySelector('.ai-card-dot')).toBeTruthy();
    expect(card.querySelector('.ai-card-latency')?.textContent).toBe('412 ms');
  });

  it('a failed last test renders UNTESTED (no green keyline)', () => {
    shared.settings = freshSettings({
      provider: 'openai', model: 'gpt-5.2', apiKeyEnc: 'set',
      lastTest: { ok: false, ms: 900, at: Date.now() },
    });
    const { el } = renderTab();
    const card = el.querySelector('.ai-card')!;
    expect(card.classList.contains('ready')).toBe(false);
    expect(card.querySelector('.ai-pill--warn')?.textContent).toBe('UNTESTED');
  });

  it('clicking the row expands the existing config form (provider/model/key)', () => {
    shared.settings = freshSettings({ provider: 'deepseek', model: 'deepseek-chat', apiKeyEnc: 'set' });
    const { el } = renderTab();
    (el.querySelector('.ai-card') as HTMLElement).click();
    const form = el.querySelector('.ai-form')!;
    expect(form).toBeTruthy();
    expect(form.querySelector('#ai-provider')).toBeTruthy();
    expect(form.querySelector('#ai-model')).toBeTruthy();
    expect(form.textContent).toContain('saved'); // masked key row
    // Card button flips to Close.
    expect(el.querySelector('.ai-card-edit')?.textContent).toBe('Close');
  });

  it('AI_TEST_RESULT persists lastTest into shared settings for the card', () => {
    shared.settings = freshSettings({ provider: 'deepseek', model: 'deepseek-chat', apiKeyEnc: 'set' });
    const { tab, el } = renderTab();
    tab.handleMessage({ type: 'AI_TEST_RESULT', ok: true, model: 'deepseek-chat', ms: 233 });
    expect(shared.settings.ai?.lastTest).toMatchObject({ ok: true, ms: 233 });
    tab.render(el);
    const card = el.querySelector('.ai-card')!;
    expect(card.classList.contains('ready')).toBe(true);
    expect(card.querySelector('.ai-card-latency')?.textContent).toBe('233 ms');
  });
});
