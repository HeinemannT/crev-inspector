/**
 * Access Trace overlay — open → subjects → pick → verdict tree.
 * @vitest-environment happy-dom
 */
import { describe, it, expect, beforeEach } from 'vitest';

const sent: any[] = [];

import { openAccessTrace, routeAccessMessage, closeAccessTrace, isAccessTraceOpen, initAccessTrace } from '../access-trace';

beforeEach(() => {
  sent.length = 0;
  // The overlay's SW reach is injected by the host — capture it for assertions.
  initAccessTrace((m: any) => sent.push(m));
  closeAccessTrace();
  document.body.innerHTML = '';
});

describe('Access Trace overlay', () => {
  it('opens, requests subjects, picks one, fires a trace, renders the verdict tree', () => {
    openAccessTrace({ rid: '113', name: 'FX Volatility', type: 'CeRiskAssessment' });
    expect(isAccessTraceOpen()).toBe(true);
    expect(sent.find(m => m.type === 'FETCH_ACCESS_SUBJECTS')).toBeTruthy();
    expect(document.querySelector('.atrace-card')).toBeTruthy();

    routeAccessMessage({
      type: 'ACCESS_SUBJECTS_DATA',
      subjects: [{ rid: '5', name: 'Auditor Role', kind: 'role', businessId: 'role_auditor' }],
      canTrace: true,
    } as any);
    expect(document.querySelector('.atrace-search')).toBeTruthy();

    (document.querySelector('.atrace-opt') as HTMLButtonElement).click();
    expect(sent.find(m => m.type === 'REQUEST_ACCESS_TRACE')).toMatchObject({
      rid: '113', subjectRid: '5', action: 'READ',
    });

    routeAccessMessage({
      type: 'ACCESS_TRACE_RESULT', rid: '113',
      node: {
        element: 'TraceRequest', result: true, timedOut: false, details: {},
        children: [{
          element: 'Statement', result: true, timedOut: false, details: { statementIndex: '2' },
          children: [{ element: 'Subject', result: true, timedOut: false, details: { original: '[role:role_auditor]' }, children: [] }],
        }],
      },
    } as any);

    const verdict = document.querySelector('.atrace-verdict');
    expect(verdict?.classList.contains('atrace-verdict--ok')).toBe(true);
    expect(verdict?.textContent).toContain('Granted');
    // Rows read as the subject the statement grants to, not the bare word
    // "Statement" or a meaningless statement index; the Subject-match child is
    // folded into that line.
    const node = document.querySelector('.atrace-node')?.textContent ?? '';
    expect(node).toContain('role:role_auditor');
    expect(node).not.toContain('Statement');
    expect(node).not.toContain('statementIndex');
  });

  it('switching the action re-fires the trace once a subject is set', () => {
    openAccessTrace({ rid: '113', name: 'X', type: 'Scorecard' });
    routeAccessMessage({ type: 'ACCESS_SUBJECTS_DATA', subjects: [{ rid: '5', name: 'R', kind: 'role' }], canTrace: true } as any);
    (document.querySelector('.atrace-opt') as HTMLButtonElement).click();
    sent.length = 0;
    // Click the "Delete" action segment.
    const del = [...document.querySelectorAll('.atrace-seg-btn')].find(b => b.textContent === 'Delete') as HTMLButtonElement;
    del.click();
    expect(sent.find(m => m.type === 'REQUEST_ACCESS_TRACE')).toMatchObject({ subjectRid: '5', action: 'DELETE' });
  });

  it('shows an error + Retry when subject loading fails', () => {
    openAccessTrace({ rid: '1', name: 'X', type: 'Scorecard' });
    routeAccessMessage({ type: 'ACCESS_SUBJECTS_DATA', subjects: [], canTrace: false, error: 'rejected' } as any);
    expect(document.querySelector('.atrace-msg--err')?.textContent).toContain('Retry');
    expect(document.querySelector('.atrace-search')).toBeFalsy();
  });

  it('shows a capability message when there are no subjects and no error', () => {
    openAccessTrace({ rid: '1', name: 'X', type: 'Scorecard' });
    routeAccessMessage({ type: 'ACCESS_SUBJECTS_DATA', subjects: [], canTrace: false } as any);
    expect(document.querySelector('.atrace-msg--warn')?.textContent).toContain('admin');
    expect(document.querySelector('.atrace-search')).toBeFalsy();
  });

  it('copies the verdict + tree to the clipboard', async () => {
    const writes: string[] = [];
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: { writeText: (t: string) => { writes.push(t); return Promise.resolve(); } },
      configurable: true,
    });
    openAccessTrace({ rid: '113', name: 'FX', type: 'CeRiskAssessment' });
    routeAccessMessage({ type: 'ACCESS_SUBJECTS_DATA', subjects: [{ rid: '5', name: 'Auditor', kind: 'role' }], canTrace: true } as any);
    (document.querySelector('.atrace-opt') as HTMLButtonElement).click();
    routeAccessMessage({ type: 'ACCESS_TRACE_RESULT', rid: '113', node: {
      element: 'TraceRequest', result: false, timedOut: false, details: {},
      children: [{ element: 'Statement', result: false, timedOut: false, details: { statementIndex: '2' }, children: [] }],
    } } as any);
    const copyBtn = [...document.querySelectorAll('.atrace-link')].find(b => b.textContent === 'Copy') as HTMLButtonElement;
    copyBtn.click();
    await Promise.resolve();
    expect(writes[0]).toContain('DENIED');
    expect(writes[0]).toContain('Statement (statementIndex=2)');
  });

  it('claims but ignores a trace result for a different object', () => {
    openAccessTrace({ rid: '113', name: 'A', type: 'Scorecard' });
    routeAccessMessage({ type: 'ACCESS_SUBJECTS_DATA', subjects: [{ rid: '5', name: 'R', kind: 'role' }], canTrace: true } as any);
    const claimed = routeAccessMessage({
      type: 'ACCESS_TRACE_RESULT', rid: '999',
      node: { element: 'x', result: true, timedOut: false, details: {}, children: [] },
    } as any);
    expect(claimed).toBe(true);
    expect(document.querySelector('.atrace-verdict')).toBeFalsy();
  });
});
