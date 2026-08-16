import { describe, expect, it } from 'vitest';
import { ChangeTicketLifecycle, type ChangePreviewScope } from '../change-ticket';

const scope: ChangePreviewScope = {
  profileId: 'demo',
  serverUrl: 'https://bmp.example/Steadfast/',
  actor: 'admin',
};

describe('ChangeTicketLifecycle', () => {
  it('returns the exact previewed code and target once in the same environment', () => {
    let now = 100;
    const store = new ChangeTicketLifecycle(1_000, () => now, () => 'preview-1');
    const id = store.issue('t.page.change(name := "New")', scope, 'Preview OK', {
      rid: '118',
      businessId: 'landing_template',
    });

    expect(id).toBe('preview-1');
    expect(store.consume(id, scope)).toEqual({
      ok: true,
      code: 't.page.change(name := "New")',
      previewResult: 'Preview OK',
      issuedAt: 100,
      target: { rid: '118', businessId: 'landing_template' },
    });
    expect(store.consume(id, scope)).toEqual({ ok: false, reason: 'missing' });
    now += 1;
  });

  it('consumes and rejects an expired capability', () => {
    let now = 100;
    const store = new ChangeTicketLifecycle(10, () => now, () => 'expired');
    store.issue('output(1)', scope, 'Preview OK');
    now = 111;

    expect(store.consume('expired', scope)).toEqual({ ok: false, reason: 'expired' });
    expect(store.consume('expired', scope)).toEqual({ ok: false, reason: 'missing' });
  });

  it.each([
    ['profile', { ...scope, profileId: 'other' }],
    ['server', { ...scope, serverUrl: 'https://bmp.example/Other/' }],
    ['actor', { ...scope, actor: 'configurator' }],
  ])('binds a capability to the previewed %s', (_label, changedScope) => {
    const store = new ChangeTicketLifecycle(1_000, () => 100, () => 'scoped');
    store.issue('output(1)', scope, 'Preview OK');

    expect(store.consume('scoped', changedScope)).toEqual({ ok: false, reason: 'scope-changed' });
  });
});
