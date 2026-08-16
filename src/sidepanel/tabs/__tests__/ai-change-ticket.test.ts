/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/messaging', () => ({
  sendFireForget: vi.fn(),
  sendRequest: vi.fn(),
}));
vi.mock('../../../lib/modal', () => ({
  confirmModal: vi.fn(async () => true),
}));

import { AiTab } from '../ai-tab';
import { sendFireForget, sendRequest } from '../../../lib/messaging';
import { confirmModal } from '../../../lib/modal';

const ticket = [
  '```crev-change',
  'summary: Assign the process owner',
  'target: org_group (Steadfast Corporate Governance Group) → crev_ai_evaluation_dashboard_scorecard_2026',
  'operation: update',
  'language: extended',
  '---',
  't.owner := lookup("admin")',
  '```',
].join('\n');

describe('AI Change Ticket rerender state', () => {
  afterEach(() => {
    vi.clearAllMocks();
    document.body.textContent = '';
  });

  it('keeps a preview token and ready state when later chat turns rebuild the thread', async () => {
    vi.mocked(sendRequest)
      .mockResolvedValueOnce({
        type: 'AI_PREVIEW_CHANGE_RESULT', requestId: 'preview', ok: true,
        resultText: [
          'Would write "admin" to property "owner" for object process_01 Annual Review',
          'Result : [process_01 Annual Review]',
        ].join('\n'),
        purpose: 'change', previewId: 'preview-id', runnable: true,
      } as any)
      .mockResolvedValueOnce({
        type: 'AI_RUN_CHANGE_RESULT', requestId: 'run', ok: true, resultText: 'run ok',
      } as any);
    const tab = new AiTab(() => {});
    const container = document.createElement('div');
    document.body.appendChild(container);
    tab.render(container);
    (tab as any).transcript = [{ turn: { role: 'assistant', text: ticket } }];
    (tab as any).renderThread();

    (container.querySelector('.ai-change-preview') as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(container.querySelector('.ai-change-receipt-summary')?.textContent).toBe('· 1 change');
      expect(container.querySelector('.ai-change-preview')?.textContent).toBe('Preview again');
      expect(container.querySelector('.ai-change-preview')?.classList.contains('ai-change-preview--success')).toBe(true);
      expect((container.querySelector('.ai-change-run') as HTMLButtonElement).disabled).toBe(false);
    });

    expect(container.querySelector('.ai-change-summary')?.textContent).toBe('Assign the process owner');
    expect(container.querySelector('.ai-change-target')).toBeNull();
    expect(container.querySelector('.ai-change-target-icon')).toBeNull();
    expect(container.querySelector('.ai-change-kicker')?.textContent).toBe('AI suggestion');
    expect(container.querySelector('.ai-change-sparkle svg')).not.toBeNull();
    expect(container.querySelector('.ai-change-editor svg')).not.toBeNull();
    expect(container.querySelector('.ai-change-actions + .ai-change-receipt')).not.toBeNull();

    // A later message commits and the full thread is reconstructed, including
    // the previous ticket rather than merely its current DOM instance.
    (tab as any).transcript.push(
      { turn: { role: 'user', text: 'Thanks — now explain the impact.' } },
      { turn: { role: 'assistant', text: 'It changes only the owner.' } },
    );
    (tab as any).renderThread();

    const rerenderedRun = container.querySelector('.ai-change-run') as HTMLButtonElement;
    expect(container.querySelector('.ai-change-receipt-summary')?.textContent).toBe('· 1 change');
    expect(rerenderedRun.disabled).toBe(false);

    const receiptToggle = container.querySelector('.ai-change-receipt-toggle') as HTMLButtonElement;
    receiptToggle.click();
    expect(receiptToggle.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('.ai-change-event-primary')?.textContent).toBe('Annual Review');
    expect(container.querySelector('.ai-change-event-detail')?.textContent).toBe('owner → admin');
    expect(container.querySelector('.ai-change-raw-toggle')?.getAttribute('aria-expanded')).toBe('true');
    expect((container.querySelector('.ai-change-raw-output') as HTMLElement).hidden).toBe(false);

    rerenderedRun.click();
    await vi.waitFor(() => expect(confirmModal).toHaveBeenCalledTimes(1));
    expect(confirmModal).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Run this previewed change?',
      body: 'Assign the process owner',
    }));
    await vi.waitFor(() => expect(sendRequest).toHaveBeenLastCalledWith(expect.objectContaining({
      type: 'AI_RUN_CHANGE', previewId: 'preview-id',
    })));
  });

  it('turns an unsuccessful preview into a retry action and keeps Run disabled', async () => {
    vi.mocked(sendRequest).mockResolvedValueOnce({
      type: 'AI_PREVIEW_CHANGE_RESULT', requestId: 'preview', ok: false,
      purpose: 'change', resultText: 'The parent object could not be resolved', runnable: false,
    } as any);
    const tab = new AiTab(() => {});
    const container = document.createElement('div');
    document.body.appendChild(container);
    tab.render(container);
    (tab as any).transcript = [{ turn: { role: 'assistant', text: ticket } }];
    (tab as any).renderThread();

    (container.querySelector('.ai-change-preview') as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(container.querySelector('.ai-change-preview')?.textContent).toBe('Retry preview');
      expect(container.querySelector('.ai-change-preview')?.classList.contains('ai-change-preview--error')).toBe(true);
      expect(container.querySelector('.ai-change-state')?.textContent).toBe('The parent object could not be resolved');
      expect((container.querySelector('.ai-change-run') as HTMLButtonElement).disabled).toBe(true);
    });
  });

  it('keeps the completed tool summary green when a later call recovers the failed tool', () => {
    const tab = new AiTab(() => {});
    const container = document.createElement('div');
    document.body.appendChild(container);
    tab.render(container);
    (tab as any).transcript = [{
      turn: {
        role: 'assistant',
        text: 'Done.',
        toolTrace: [
          { name: 'read_object', summary: 'read_object t.missing', ok: false },
          { name: 'read_object', summary: 'read_object 123', ok: true },
        ],
      },
    }];
    (tab as any).renderThread();

    const summary = container.querySelector('.ai-tg-sum') as HTMLButtonElement;
    expect(summary.textContent).toContain('Ran 2 tools');
    expect(summary.classList.contains('ai-tg-sum--err')).toBe(false);
    summary.click();
    expect(container.querySelectorAll('.ai-tl--err')).toHaveLength(1);
    expect(container.querySelectorAll('.ai-tl--ok')).toHaveLength(1);
  });

  it('renders a verified target token as an object identity instead of model syntax', () => {
    const objectTicket = ticket.replace(
      /^target:.*$/mu,
      'target: [[object:8510842252680580489]]',
    );
    const tab = new AiTab(() => {});
    const container = document.createElement('div');
    document.body.appendChild(container);
    tab.render(container);
    (tab as any).transcript = [{
      turn: {
        role: 'assistant',
        text: objectTicket,
        objects: [{
          rid: '8510842252680580489',
          businessId: 'global_governance_view',
          name: 'Global Governance View',
          type: 'Card',
        }],
      },
    }];
    (tab as any).renderThread();

    const target = container.querySelector('.ai-change-target') as HTMLElement;
    const object = target.querySelector('.ai-change-target-object') as HTMLButtonElement;
    expect(target.textContent).not.toContain('[[object:');
    expect(object.textContent).toBe('OBJ');
    expect(object.querySelector('.object-chip-label')).toBeNull();
    expect(object.title).toContain('Global Governance View');
    expect(object.title).toContain('global_governance_view');
    expect(object.title).toContain('8510842252680580489');
    expect(target.children).toHaveLength(1);
    expect(target.querySelector('.ai-change-target-icon')).toBeNull();

    object.click();
    expect(sendFireForget).toHaveBeenCalledWith({
      type: 'OPEN_OBJECT_VIEW',
      rid: '8510842252680580489',
    });
  });

  it('does not activate an unverified target token', () => {
    const objectTicket = ticket.replace(
      /^target:.*$/mu,
      'target: [[object:8510842252680580489]]',
    );
    const tab = new AiTab(() => {});
    const container = document.createElement('div');
    document.body.appendChild(container);
    tab.render(container);
    (tab as any).transcript = [{ turn: { role: 'assistant', text: objectTicket } }];
    (tab as any).renderThread();

    expect(container.querySelector('.ai-change-target')).toBeNull();
    expect(container.querySelector('.ai-change-target-object')).toBeNull();
  });

  it('renders a verified object token in a user message as a badge', () => {
    const tab = new AiTab(() => {});
    const container = document.createElement('div');
    document.body.appendChild(container);
    tab.render(container);
    (tab as any).transcript = [{ turn: {
      role: 'user',
      text: 'Change [[object:8510842252680580489]] card back to Default card',
      objects: [{ rid: '8510842252680580489', businessId: 'global_governance_view', name: 'Global Governance View', type: 'Card' }],
    } }];
    (tab as any).renderThread();

    expect(container.querySelector('.ai-u-text')?.textContent).not.toContain('[[object:');
    expect(container.querySelector('.ai-u-text .object-chip')?.textContent).toContain('Global Governance View');
    (container.querySelector('.ai-u-text .object-chip') as HTMLButtonElement).click();
    expect(sendFireForget).toHaveBeenCalledWith({ type: 'OPEN_OBJECT_VIEW', rid: '8510842252680580489' });
    expect((tab as any).editing).toBe(false);
  });
});
