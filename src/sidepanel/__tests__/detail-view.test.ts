/**
 * Tests for the new object-pane DetailView.
 * Covers: FETCH_OBJECT_PANE flow, draft accumulation, save round-trip,
 * target toggle, tree navigation, watchdog.
 *
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DetailView } from '../detail-view';
import type { BmpObject, InspectorMessage } from '../../lib/types';

vi.mock('../state', () => ({
  S: {
    detailRid: null,
    activeTab: 'objects',
    settings: { profiles: [], activeProfileId: null },
    connState: { display: 'connected', version: null, responseMs: null, profileLabel: null, user: null, workspace: null, authError: null, networkOffline: false, lastUpdate: 0 },
    inspectActive: false,
    paintPhase: 'off',
    paintSourceName: null,
    cacheCount: 0,
    favoriteEntries: [],
  },
}));

function makeDetailView() {
  const sent: InspectorMessage[] = [];
  const onBack = vi.fn();
  const sendMessage = vi.fn((msg: InspectorMessage) => sent.push(msg));
  const dv = new DetailView(onBack, sendMessage);
  const panel = document.createElement('div');
  document.body.appendChild(panel);
  return { dv, onBack, sendMessage, sent, panel };
}

function makeObj(rid: string, overrides: Partial<BmpObject> = {}): BmpObject {
  return {
    rid,
    name: `Obj-${rid}`,
    type: 'ExtendedTable',
    businessId: `bid-${rid}`,
    source: 'server',
    discoveredAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function emptyProps(over: Partial<Record<string, string>> = {}): Record<string, string> {
  const base: Record<string, string> = {
    width: '', height: '', headerColor: '', fontColor: '',
    shadow: '', transparency: '', headerStyle: '', borderStyle: '', visible: '',
  };
  return { ...base, ...over } as Record<string, string>;
}

function paneData(rid: string, over: Partial<{
  parentRid: string;
  templateRid: string;
  cardRid: string;
  cardViaTemplate: boolean;
  instanceProps: Record<string, string>;
  templateProps: Record<string, string>;
  siblings: Array<{ rid: string; isCurrent: boolean }>;
  error: string;
}> = {}): InspectorMessage {
  return {
    type: 'OBJECT_PANE_DATA',
    rid,
    instance: { rid, businessId: `bid-${rid}`, type: 'ExtendedTable', name: `Obj-${rid}` },
    parent: over.parentRid
      ? { rid: over.parentRid, businessId: `bid-${over.parentRid}`, type: 'EditPage', name: 'Parent' }
      : null,
    template: over.templateRid
      ? { rid: over.templateRid, businessId: `tmpl-${over.templateRid}`, type: 'ExtendedTable', name: 'Template' }
      : null,
    card: over.cardRid
      ? { rid: over.cardRid, businessId: `card-${over.cardRid}`, type: 'Card', name: 'Detail card', viaTemplate: over.cardViaTemplate ?? false }
      : null,
    instanceProps: over.instanceProps ?? emptyProps({ width: '200', height: '100', headerColor: '#ff0000', shadow: 'false' }),
    templateProps: over.templateProps ?? emptyProps(),
    siblings: (over.siblings ?? [{ rid, isCurrent: true }]).map(s => ({
      rid: s.rid, businessId: `bid-${s.rid}`, name: `Sib-${s.rid}`, type: 'ExtendedTable', isCurrent: s.isCurrent,
    })),
    codeFields: {},
    references: {},
    indirectCode: {},
    indirectCodeRids: {},
    contextValues: {},
    gateValues: {},
    lists: {},
    ...(over.error ? { error: over.error } : {}),
  };
}

beforeEach(() => { document.body.innerHTML = ''; });
afterEach(() => { vi.useRealTimers(); });

describe('DetailView — fetch flow', () => {
  it('show() emits FETCH_OBJECT_PANE and renders identity hint immediately', () => {
    const { dv, panel, sent } = makeDetailView();
    dv.show(makeObj('100'), panel);
    expect(dv.isActive()).toBe(true);
    expect(sent.find(m => m.type === 'FETCH_OBJECT_PANE' && (m as { rid: string }).rid === '100')).toBeTruthy();
    expect(panel.querySelector('.pane-id-name')?.textContent).toContain('Obj-100');
    expect(panel.querySelector('.pane-loading')).toBeTruthy();
  });

  it('OBJECT_PANE_DATA renders the property editors', () => {
    const { dv, panel } = makeDetailView();
    dv.show(makeObj('100'), panel);
    const consumed = dv.handleMessage(paneData('100', {
      instanceProps: emptyProps({ width: '260', headerColor: '#ff5050' }),
    }), panel);
    expect(consumed).toBe(true);
    expect(panel.querySelector('.pane-loading')).toBeFalsy();
    const width = panel.querySelector<HTMLInputElement>('.prop-number-input');
    expect(width?.value).toBe('260');
  });

  it('ignores OBJECT_PANE_DATA for the wrong RID', () => {
    const { dv, panel } = makeDetailView();
    dv.show(makeObj('100'), panel);
    expect(dv.handleMessage(paneData('999'), panel)).toBe(false);
  });

  it('renders the card crumb and navigates BMP on click', () => {
    const { dv, panel, sent } = makeDetailView();
    dv.show(makeObj('100'), panel);
    dv.handleMessage(paneData('100', { cardRid: '777', cardViaTemplate: true }), panel);
    const crumb = panel.querySelector<HTMLElement>('.pane-card-crumb');
    expect(crumb).toBeTruthy();
    expect(crumb!.textContent).toContain('Detail card');
    expect(crumb!.textContent).toContain('via template'); // inherited badge
    crumb!.click();
    expect(sent.find(m => m.type === 'BMP_GOTO' && (m as { rid?: string }).rid === '777')).toBeTruthy();
  });

  it('shows no card crumb when the object has no card', () => {
    const { dv, panel } = makeDetailView();
    dv.show(makeObj('100'), panel);
    dv.handleMessage(paneData('100'), panel); // no cardRid
    expect(panel.querySelector('.pane-card-crumb')).toBeFalsy();
  });

  it('watchdog surfaces a timeout when OBJECT_PANE_DATA never arrives', async () => {
    // Mock the lookup constant to a tiny value so we don't burn 10s real time.
    // (LOOKUP_WATCHDOG_TIMEOUT is imported at module init; we can't mock it
    // retroactively, so we just monkey-patch setTimeout to fast-forward.)
    const realSetTimeout = global.setTimeout;
    const timers: Array<{ cb: () => void; ms: number }> = [];
    (global as unknown as { setTimeout: typeof setTimeout }).setTimeout = ((cb: () => void, ms: number) => {
      // Only intercept the watchdog (long timeouts); pass through micro-delays
      if (ms >= 1000) {
        timers.push({ cb, ms });
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }
      return realSetTimeout(cb, ms);
    }) as typeof setTimeout;
    try {
      const { dv, panel } = makeDetailView();
      dv.show(makeObj('100'), panel);
      // Initial loading text is short
      expect(panel.querySelector('.pane-loading')?.textContent).toBe('Loading…');
      // Fire the 3s slow timer
      const slow = timers.find(t => t.ms === 3000);
      slow?.cb();
      expect(panel.querySelector('.pane-loading')?.classList.contains('pane-loading--slow')).toBe(true);
      expect(panel.querySelector('.pane-loading')?.textContent).toContain('Still loading');
      // Fire the 7s very-slow timer
      const very = timers.find(t => t.ms === 7000);
      very?.cb();
      expect(panel.querySelector('.pane-loading')?.classList.contains('pane-loading--verySlow')).toBe(true);
      expect(panel.querySelector('.pane-loading')?.textContent).toContain('BMP is slow');
      // Fire the 15s watchdog
      const wd = timers.find(t => t.ms >= 10000);
      wd?.cb();
      expect(panel.querySelector('.pane-error')).toBeTruthy();
    } finally {
      (global as unknown as { setTimeout: typeof setTimeout }).setTimeout = realSetTimeout;
    }
  });

  it('slow-load timers stop firing once data arrives', async () => {
    // Verify clearLookupWatchdog also clears the slow-load timers — otherwise
    // a late 3s tick would re-bump loadingStage on stale state.
    const realSetTimeout = global.setTimeout;
    const realClearTimeout = global.clearTimeout;
    const live = new Set<number>();
    let nextId = 1;
    (global as unknown as { setTimeout: typeof setTimeout }).setTimeout = ((cb: () => void, ms: number) => {
      if (ms >= 1000) {
        const id = nextId++;
        live.add(id);
        return id as unknown as ReturnType<typeof setTimeout>;
      }
      return realSetTimeout(cb, ms);
    }) as typeof setTimeout;
    (global as unknown as { clearTimeout: typeof clearTimeout }).clearTimeout = ((id: number) => {
      live.delete(id);
    }) as typeof clearTimeout;
    try {
      const { dv, panel } = makeDetailView();
      dv.show(makeObj('100'), panel);
      expect(live.size).toBe(3); // 3s, 7s, watchdog
      dv.handleMessage(paneData('100'), panel);
      expect(live.size).toBe(0); // all cleared on successful load
    } finally {
      (global as unknown as { setTimeout: typeof setTimeout }).setTimeout = realSetTimeout;
      (global as unknown as { clearTimeout: typeof clearTimeout }).clearTimeout = realClearTimeout;
    }
  });
});

describe('DetailView — edit + save', () => {
  it('editing a property accumulates a draft and shows the action bar', () => {
    const { dv, panel } = makeDetailView();
    dv.show(makeObj('100'), panel);
    dv.handleMessage(paneData('100'), panel);

    expect(panel.querySelector('.pane-actionbar')).toBeFalsy();
    const widthInput = panel.querySelector<HTMLInputElement>('.prop-number-input')!;
    widthInput.value = '320';
    widthInput.dispatchEvent(new Event('input', { bubbles: true }));

    const bar = panel.querySelector('.pane-actionbar');
    expect(bar).toBeTruthy();
    expect(bar?.textContent).toMatch(/1.*pending/);
  });

  it('typing back the original value clears the draft', () => {
    const { dv, panel } = makeDetailView();
    dv.show(makeObj('100'), panel);
    dv.handleMessage(paneData('100'), panel);

    const input1 = panel.querySelector<HTMLInputElement>('.prop-number-input')!;
    input1.value = '500';
    input1.dispatchEvent(new Event('input', { bubbles: true }));
    expect(panel.querySelector('.pane-actionbar')).toBeTruthy();

    const input2 = panel.querySelector<HTMLInputElement>('.prop-number-input')!;
    input2.value = '200';
    input2.dispatchEvent(new Event('input', { bubbles: true }));
    expect(panel.querySelector('.pane-actionbar')).toBeFalsy();
  });

  it('Save click + modal confirm emits APPLY_OBJECT_CHANGES with typed values', async () => {
    const { dv, panel, sent } = makeDetailView();
    dv.show(makeObj('100'), panel);
    dv.handleMessage(paneData('100'), panel);

    const widthInput = panel.querySelector<HTMLInputElement>('.prop-number-input')!;
    widthInput.value = '320';
    widthInput.dispatchEvent(new Event('input', { bubbles: true }));

    const saveBtn = panel.querySelector<HTMLButtonElement>('.pane-actionbar .btn-success')!;
    saveBtn.click();

    // Confirm modal — yield once for the requestAnimationFrame focus call
    await new Promise(r => setTimeout(r, 0));
    const confirm = document.querySelector<HTMLButtonElement>('.crev-modal .btn-success')!;
    expect(confirm).toBeTruthy();
    confirm.click();
    // Yield for the async commitSave continuation after the modal resolves
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));

    const applied = sent.find(m => m.type === 'APPLY_OBJECT_CHANGES');
    expect(applied).toBeTruthy();
    const a = applied as { type: 'APPLY_OBJECT_CHANGES'; rid: string; target: string; changes: Record<string, unknown> };
    expect(a.rid).toBe('100');
    expect(a.target).toBe('instance');
    expect(a.changes.width).toBe(320);
  });

  it('APPLY_CHANGES_RESULT ok=true triggers a refetch', () => {
    const { dv, panel, sent } = makeDetailView();
    dv.show(makeObj('100'), panel);
    dv.handleMessage(paneData('100'), panel);

    const w = panel.querySelector<HTMLInputElement>('.prop-number-input')!;
    w.value = '320';
    w.dispatchEvent(new Event('input', { bubbles: true }));

    sent.length = 0;
    dv.handleMessage({ type: 'APPLY_CHANGES_RESULT', rid: '100', ok: true }, panel);

    expect(sent.find(m => m.type === 'FETCH_OBJECT_PANE' && (m as { rid: string }).rid === '100')).toBeTruthy();
  });

  it('APPLY_CHANGES_RESULT ok=true shows a Reload toast that sends RELOAD_BMP_TAB', () => {
    const { dv, panel, sent } = makeDetailView();
    dv.show(makeObj('100'), panel);
    dv.handleMessage(paneData('100'), panel);

    const w = panel.querySelector<HTMLInputElement>('.prop-number-input')!;
    w.value = '320';
    w.dispatchEvent(new Event('input', { bubbles: true }));

    sent.length = 0;
    dv.handleMessage({ type: 'APPLY_CHANGES_RESULT', rid: '100', ok: true }, panel);

    // BMP's React DOM doesn't re-render on out-of-band writes, so the save
    // offers a one-click reload of the BMP tab.
    const reloadBtn = document.querySelector<HTMLButtonElement>('.crev-toast__action');
    expect(reloadBtn, 'reload toast button should render').toBeTruthy();
    expect(reloadBtn!.textContent).toBe('Reload');
    reloadBtn!.click();
    expect(sent.find(m => m.type === 'RELOAD_BMP_TAB')).toBeTruthy();

    document.getElementById('crev-toast-container')?.remove();
  });

  it('APPLY_CHANGES_RESULT ok=false surfaces the error and keeps the draft', () => {
    const { dv, panel } = makeDetailView();
    dv.show(makeObj('100'), panel);
    dv.handleMessage(paneData('100'), panel);

    const w = panel.querySelector<HTMLInputElement>('.prop-number-input')!;
    w.value = '320';
    w.dispatchEvent(new Event('input', { bubbles: true }));

    dv.handleMessage({ type: 'APPLY_CHANGES_RESULT', rid: '100', ok: false, error: 'BMP is grumpy' }, panel);

    const bar = panel.querySelector('.pane-actionbar');
    expect(bar?.textContent).toContain('BMP is grumpy');
    const after = panel.querySelector<HTMLInputElement>('.prop-number-input')!;
    expect(after.value).toBe('320');
  });
});

describe('DetailView — target toggle', () => {
  it('disables the template button when there is no template', () => {
    const { dv, panel } = makeDetailView();
    dv.show(makeObj('100'), panel);
    dv.handleMessage(paneData('100'), panel);
    const btns = panel.querySelectorAll<HTMLButtonElement>('.pane-target-btn');
    const tmpl = Array.from(btns).find(b => b.textContent === 'template')!;
    expect(tmpl.disabled).toBe(true);
  });

  it('switching to template renders template values', () => {
    const { dv, panel } = makeDetailView();
    dv.show(makeObj('100'), panel);
    dv.handleMessage(paneData('100', {
      templateRid: '99',
      instanceProps: emptyProps({ width: '260' }),
      templateProps: emptyProps({ width: '180' }),
    }), panel);

    const tmplBtn = panel.querySelector<HTMLButtonElement>('.pane-target-btn:not(.active)')!;
    expect(tmplBtn.disabled).toBe(false);
    tmplBtn.click();

    const widthInput = panel.querySelector<HTMLInputElement>('.prop-number-input')!;
    expect(widthInput.value).toBe('180');
  });
});

describe('DetailView — tree navigation', () => {
  it('renders siblings and emits FETCH_OBJECT_PANE on click', () => {
    const { dv, panel, sent } = makeDetailView();
    dv.show(makeObj('100'), panel);
    dv.handleMessage(paneData('100', {
      parentRid: '50',
      siblings: [{ rid: '100', isCurrent: true }, { rid: '101', isCurrent: false }],
    }), panel);

    sent.length = 0;
    const sibling = panel.querySelector<HTMLElement>('[data-rid="101"]')!;
    expect(sibling).toBeTruthy();
    sibling.click();

    expect(sent.find(m => m.type === 'FETCH_OBJECT_PANE' && (m as { rid: string }).rid === '101')).toBeTruthy();
  });

  it('clicking the parent breadcrumb navigates to the parent', () => {
    const { dv, panel, sent } = makeDetailView();
    dv.show(makeObj('100'), panel);
    dv.handleMessage(paneData('100', { parentRid: '50' }), panel);

    sent.length = 0;
    const crumb = panel.querySelector<HTMLElement>('.pane-tree-crumb[data-rid="50"]')!;
    crumb.click();

    expect(sent.find(m => m.type === 'FETCH_OBJECT_PANE' && (m as { rid: string }).rid === '50')).toBeTruthy();
  });
});

describe('DetailView — Connections (relationships)', () => {
  function domainPane(rid: string) {
    const pd = paneData(rid) as InspectorMessage & { instance: { type: string } };
    pd.instance.type = 'CeRiskAssessment'; // a domain object (no curated widget refs)
    return pd;
  }

  it('a domain object fires FETCH_CONNECTIONS on pane load', () => {
    const { dv, panel, sent } = makeDetailView();
    dv.show(makeObj('100', { type: 'CeRiskAssessment' }), panel);
    dv.handleMessage(domainPane('100'), panel);
    expect(sent.find(m => m.type === 'FETCH_CONNECTIONS' && (m as { rid: string }).rid === '100')).toBeTruthy();
  });

  it('renders the Connections section from CONNECTIONS_RESULT, inlining the junction far side', () => {
    const { dv, panel } = makeDetailView();
    dv.show(makeObj('100', { type: 'CeRiskAssessment' }), panel);
    dv.handleMessage(domainPane('100'), panel);
    dv.handleMessage({
      type: 'CONNECTIONS_RESULT', rid: '100', ok: true,
      groups: [{
        field: 'risk_mitigations', label: 'risk mitigations', direction: 'in',
        targets: [{
          rid: '201', name: 'DDoS mitigation', type: 'CeWorkflow', businessId: 'mit_ddos',
          via: { rid: '301', name: 'WAF control', type: 'CeControlMeasure', businessId: 'cloc_waf' },
        }],
      }],
    } as InspectorMessage, panel);

    const conn = panel.querySelector('.lk-section');
    expect(conn).toBeTruthy();
    expect(conn!.textContent).toContain('DDoS mitigation');
    expect(conn!.textContent).toContain('WAF control'); // junction far side inlined
  });

  it('renders the lazy inbound scan button and fires FETCH_INBOUND on click', () => {
    const { dv, panel, sent } = makeDetailView();
    dv.show(makeObj('100', { type: 'CeRiskAssessment' }), panel);
    dv.handleMessage(domainPane('100'), panel);
    dv.handleMessage({
      type: 'CONNECTIONS_RESULT', rid: '100', ok: true,
      groups: [{ field: 'owner_reference', label: 'owner', direction: 'out', targets: [
        { rid: '5', name: 'Alice', type: 'User', businessId: 'u_alice' },
      ] }],
    } as InspectorMessage, panel);
    const scan = panel.querySelector<HTMLElement>('.lk-scan-btn');
    expect(scan).toBeTruthy();
    scan!.click();
    expect(sent.find(m => m.type === 'FETCH_INBOUND' && (m as { rid: string }).rid === '100')).toBeTruthy();
  });

  it('a widget type with curated refs does NOT fetch connections', () => {
    const { dv, panel, sent } = makeDetailView();
    dv.show(makeObj('100', { type: 'CustomVisualization' }), panel);
    const pd = paneData('100') as InspectorMessage & { instance: { type: string } };
    pd.instance.type = 'CustomVisualization'; // has a TYPE_META reference (data binding)
    dv.handleMessage(pd, panel);
    expect(sent.find(m => m.type === 'FETCH_CONNECTIONS')).toBeFalsy();
  });
});
