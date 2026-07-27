/**
 * Tests for the Connect tab's AI Assistant card (server-row twin). No READY/UNTESTED pills — status is
 * carried by the green keyline + connection dot + latency (present only when verified):
 *   - unconfigured → quiet row with a Set up button, no keyline
 *   - configured + untested → plain card (no keyline, no dot/latency), Edit
 *   - configured + last test ok → green keyline, latency + dot
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

  it('configured but untested: plain card (no keyline, no dot/latency), mono line, Edit', () => {
    shared.settings = freshSettings({ provider: 'deepseek', model: 'deepseek-chat', apiKeyEnc: 'set' });
    const { el } = renderTab();
    const card = el.querySelector('.ai-card')!;
    expect(card.classList.contains('ready')).toBe(false);
    expect(card.querySelector('.ai-pill')).toBeNull(); // no pill — absence of the keyline/dot carries "untested"
    expect(card.querySelector('.ai-card-ln2')?.textContent).toBe('DeepSeek · deepseek-chat · key saved');
    expect(card.querySelector('.ai-card-edit')?.textContent).toBe('Edit');
    expect(card.querySelector('.ai-card-latency')).toBeNull();
    expect(card.querySelector('.ai-card-dot')).toBeNull();
  });

  it('configured + verified: green keyline, dot + latency, no pill', () => {
    shared.settings = freshSettings({
      provider: 'anthropic', model: 'claude-sonnet-5', apiKeyEnc: 'set',
      lastTest: { ok: true, ms: 412, at: Date.now() },
    });
    const { el } = renderTab();
    const card = el.querySelector('.ai-card')!;
    expect(card.classList.contains('ready')).toBe(true);
    expect(card.querySelector('.ai-pill')).toBeNull();
    expect(card.querySelector('.ai-card-dot')).toBeTruthy();
    expect(card.querySelector('.ai-card-latency')?.textContent).toBe('412 ms');
  });

  it('a failed last test renders a plain card (no green keyline)', () => {
    shared.settings = freshSettings({
      provider: 'openai', model: 'gpt-5.2', apiKeyEnc: 'set',
      lastTest: { ok: false, ms: 900, at: Date.now() },
    });
    const { el } = renderTab();
    const card = el.querySelector('.ai-card')!;
    expect(card.classList.contains('ready')).toBe(false);
    expect(card.querySelector('.ai-pill')).toBeNull();
    expect(card.querySelector('.ai-card-dot')).toBeNull();
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

  it('renders a saved custom provider in the picker and redacts its key JSON', () => {
    shared.settings = freshSettings({
      provider: 'custom', model: 'agent', apiKeyEnc: 'set',
      customProvider: {
        name: 'Company Gateway', vendor: 'company', apiType: 'openai',
        models: [{ id: 'agent', name: 'Agent', url: 'https://ai.example.test/v1', toolCalling: true }],
      },
    });
    const { el } = renderTab();
    (el.querySelector('.ai-card') as HTMLElement).click();
    expect(el.querySelector('.ai-card-ln2')?.textContent).toContain('Company Gateway');
    expect((el.querySelector('#ai-provider') as HTMLSelectElement).value).toBe('custom');
    const json = (el.querySelector('#ai-provider-json') as HTMLTextAreaElement).value;
    expect(json).toContain('"Company Gateway"');
    expect(json).toContain('"apiKey": ""');
    expect(json).not.toContain('set');
    const helpButton = el.querySelector('.ai-json-help') as HTMLButtonElement;
    const helpText = el.querySelector('.ai-json-help-text') as HTMLElement;
    expect(helpButton.textContent).toBe('?');
    expect(helpButton.hasAttribute('title')).toBe(false);
    expect(helpButton.getAttribute('aria-expanded')).toBe('false');
    expect(helpText.hidden).toBe(true);
    helpButton.click();
    expect(helpButton.getAttribute('aria-expanded')).toBe('true');
    expect(helpText.hidden).toBe(false);
    expect(helpText.textContent).toContain('max_completion_tokens');
    expect(helpText.textContent).toContain('DeepSeek');
    (el.querySelector('.ai-model-caret') as HTMLElement).click();
    expect(el.querySelector('.ai-model-opt-name')?.textContent).toBe('Agent');
    expect(el.querySelector('.ai-model-opt-id')?.textContent).toBe('agent');
  });

  it('keeps invalid JSON visible and shows its error beside the editor', () => {
    shared.settings = freshSettings();
    const { el } = renderTab();
    (el.querySelector('.ai-card') as HTMLElement).click();
    const details = el.querySelector('.ai-json') as HTMLDetailsElement;
    details.open = true;
    details.dispatchEvent(new Event('toggle'));
    const textarea = el.querySelector('#ai-provider-json') as HTMLTextAreaElement;
    textarea.value = '{bad';
    textarea.dispatchEvent(new Event('input'));
    (el.querySelector('[data-action="ai-save-json"]') as HTMLElement).click();

    expect((el.querySelector('.ai-json') as HTMLDetailsElement).open).toBe(true);
    expect(el.querySelector('.ai-json-error')?.textContent).toContain('Invalid JSON');
    expect((el.querySelector('#ai-provider-json') as HTMLTextAreaElement).value).toBe('{bad');
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
