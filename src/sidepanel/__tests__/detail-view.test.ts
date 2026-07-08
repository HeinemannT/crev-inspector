/**
 * Tests for the object-pane DetailView (Path-Spine layout).
 * Covers: FETCH_OBJECT_PANE flow, the path bar / identity row / sub-row
 * header, the segmented body (Flow|Structure|Info), the draft save pipeline
 * (property editors moved to Blueprint; the pipeline is seeded directly),
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
    siblingTotal: (over.siblings ?? [{ rid, isCurrent: true }]).length,
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

/** Seed the (editor-less) draft pipeline directly — property editors moved to
 *  Blueprint, but the draft → action bar → APPLY_OBJECT_CHANGES pipeline stays
 *  for future editors, so it's driven through internal state here. */
function seedDraft(dv: DetailView, panel: HTMLElement, draft: Record<string, string>) {
  (dv as unknown as { draft: Record<string, string> }).draft = { ...draft };
  dv.refresh(panel);
}

/** Click the body segment button by its label (Flow/Code · Structure · Info). */
function clickSegment(panel: HTMLElement, label: string) {
  const seg = [...panel.querySelectorAll<HTMLButtonElement>('.dv-seg')]
    .find(b => b.textContent!.startsWith(label));
  expect(seg, `segment "${label}" should exist`).toBeTruthy();
  seg!.click();
}

beforeEach(() => { document.body.innerHTML = ''; });
afterEach(() => { vi.useRealTimers(); });

describe('DetailView — fetch flow', () => {
  it('show() emits FETCH_OBJECT_PANE and renders identity hint immediately', () => {
    const { dv, panel, sent } = makeDetailView();
    dv.show(makeObj('100'), panel);
    expect(dv.isActive()).toBe(true);
    expect(sent.find(m => m.type === 'FETCH_OBJECT_PANE' && (m as { rid: string }).rid === '100')).toBeTruthy();
    expect(panel.querySelector('.dv-idname')?.textContent).toContain('Obj-100');
    expect(panel.querySelector('.pane-loading')).toBeTruthy();
  });

  it('OBJECT_PANE_DATA renders the segmented body — property groups moved to Blueprint', () => {
    const { dv, panel } = makeDetailView();
    dv.show(makeObj('100'), panel);
    const consumed = dv.handleMessage(paneData('100', {
      instanceProps: emptyProps({ width: '260', headerColor: '#ff5050' }),
    }), panel);
    expect(consumed).toBe(true);
    expect(panel.querySelector('.pane-loading')).toBeFalsy();
    // Segment bar: Code (ExtendedTable is not a flow type) · Structure · Info.
    const segs = [...panel.querySelectorAll('.dv-segs .dv-seg')].map(b => b.textContent);
    expect(segs.length).toBe(3);
    expect(segs[0]).toContain('Code');
    expect(segs[1]).toContain('Structure');
    expect(segs[2]).toContain('Info');
    // Property editors no longer render in this view (Blueprint's job now).
    expect(panel.querySelector('.prop-number-input')).toBeFalsy();
    expect(panel.querySelector('.prop-group-title-text')).toBeFalsy();
  });

  it('ignores OBJECT_PANE_DATA for the wrong RID', () => {
    const { dv, panel } = makeDetailView();
    dv.show(makeObj('100'), panel);
    expect(dv.handleMessage(paneData('999'), panel)).toBe(false);
  });

  it('renders the card crumb in the Info pane and opens the card object on click', () => {
    const { dv, panel, sent } = makeDetailView();
    dv.show(makeObj('100'), panel);
    dv.handleMessage(paneData('100', { cardRid: '777', cardViaTemplate: true }), panel);
    // The card is a related object, not an ancestor — it lives in Info now.
    expect(panel.querySelector('.pane-card-crumb')).toBeFalsy();
    clickSegment(panel, 'Info');
    const crumb = panel.querySelector<HTMLElement>('.pane-card-crumb');
    expect(crumb).toBeTruthy();
    expect(crumb!.textContent).toContain('Detail card');
    expect(crumb!.textContent).toContain('via template'); // inherited tag
    crumb!.click();
    // The card is a detail-view object — it opens in the sidebar like any other.
    expect(sent.find(m => m.type === 'FETCH_OBJECT_PANE' && (m as { rid?: string }).rid === '777')).toBeTruthy();
  });

  it('the sub-row open-in-web icon button opens THIS object in the BMP portal', () => {
    const { dv, panel, sent } = makeDetailView();
    dv.show(makeObj('100'), panel);
    dv.handleMessage(paneData('100'), panel);
    const open = panel.querySelector<HTMLElement>('.dv-subrow .dv-act[aria-label="Open in web"]');
    expect(open).toBeTruthy();
    open!.click();
    expect(sent.find(m => m.type === 'BMP_OPEN_OBJECT' && (m as { rid?: string }).rid === '100')).toBeTruthy();
  });

  it('the identity-row name is inert; the badge is the click-to-copy affordance', () => {
    const writes: string[] = [];
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: { writeText: (t: string) => { writes.push(t); return Promise.resolve(); } },
      configurable: true,
    });
    const { dv, panel, sent } = makeDetailView();
    dv.show(makeObj('100'), panel);
    dv.handleMessage(paneData('100'), panel);
    // Name is a plain span now — no open-in-BMP gesture on it.
    const name = panel.querySelector<HTMLElement>('.dv-idrow .dv-idname')!;
    expect(name.tagName).toBe('SPAN');
    name.click();
    expect(sent.find(m => m.type === 'BMP_OPEN_OBJECT')).toBeFalsy();
    // The badge copies the business id.
    const badge = panel.querySelector<HTMLElement>('.dv-idrow .pane-id-bdg')!;
    expect(badge).toBeTruthy();
    badge.click();
    expect(writes).toContain('bid-100');
  });

  it('shows no card crumb in Info when the object has no card', () => {
    const { dv, panel } = makeDetailView();
    dv.show(makeObj('100'), panel);
    dv.handleMessage(paneData('100'), panel); // no cardRid
    clickSegment(panel, 'Info');
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

describe('DetailView — draft save pipeline (editors live in Blueprint now)', () => {
  it('a pending draft shows the floating action bar with the pending count', () => {
    const { dv, panel } = makeDetailView();
    dv.show(makeObj('100'), panel);
    dv.handleMessage(paneData('100'), panel);

    expect(panel.querySelector('.pane-actionbar')).toBeFalsy();
    seedDraft(dv, panel, { width: '320' });

    const bar = panel.querySelector('.pane-actionbar');
    expect(bar).toBeTruthy();
    expect(bar!.classList.contains('pane-action-bar--floating')).toBe(true);
    expect(bar?.textContent).toMatch(/1.*pending/);
    expect(dv.isDirty()).toBe(true);
  });

  it('Discard + modal confirm clears the draft and hides the action bar', async () => {
    const { dv, panel } = makeDetailView();
    dv.show(makeObj('100'), panel);
    dv.handleMessage(paneData('100'), panel);

    seedDraft(dv, panel, { width: '500' });
    expect(panel.querySelector('.pane-actionbar')).toBeTruthy();

    panel.querySelector<HTMLButtonElement>('.pane-actionbar .btn:not(.btn-success)')!.click();
    await new Promise(r => setTimeout(r, 0));
    document.querySelector<HTMLButtonElement>('.crev-modal .btn-danger')!.click();
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));

    expect(panel.querySelector('.pane-actionbar')).toBeFalsy();
    expect(dv.isDirty()).toBe(false);
  });

  it('Save click + modal confirm emits APPLY_OBJECT_CHANGES with typed values', async () => {
    const { dv, panel, sent } = makeDetailView();
    dv.show(makeObj('100'), panel);
    dv.handleMessage(paneData('100'), panel);

    seedDraft(dv, panel, { width: '320' });

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

    seedDraft(dv, panel, { width: '320' });

    sent.length = 0;
    dv.handleMessage({ type: 'APPLY_CHANGES_RESULT', rid: '100', ok: true }, panel);

    expect(sent.find(m => m.type === 'FETCH_OBJECT_PANE' && (m as { rid: string }).rid === '100')).toBeTruthy();
    expect(dv.isDirty()).toBe(false); // draft cleared on success
  });

  it('APPLY_CHANGES_RESULT ok=true shows a Reload toast that sends RELOAD_BMP_TAB', () => {
    const { dv, panel, sent } = makeDetailView();
    dv.show(makeObj('100'), panel);
    dv.handleMessage(paneData('100'), panel);

    seedDraft(dv, panel, { width: '320' });

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

    seedDraft(dv, panel, { width: '320' });

    dv.handleMessage({ type: 'APPLY_CHANGES_RESULT', rid: '100', ok: false, error: 'BMP is grumpy' }, panel);

    const bar = panel.querySelector('.pane-actionbar');
    expect(bar?.textContent).toContain('BMP is grumpy');
    expect(dv.isDirty()).toBe(true); // draft survives a failed save
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

  it('switching to template activates it and saves target the template', async () => {
    const { dv, panel, sent } = makeDetailView();
    dv.show(makeObj('100'), panel);
    dv.handleMessage(paneData('100', {
      templateRid: '99',
      instanceProps: emptyProps({ width: '260' }),
      templateProps: emptyProps({ width: '180' }),
    }), panel);

    const tmplBtn = panel.querySelector<HTMLButtonElement>('.pane-target-btn:not(.active)')!;
    expect(tmplBtn.disabled).toBe(false);
    tmplBtn.click();

    // Values no longer render here (editors moved to Blueprint) — the toggle
    // shows as active and steers the save target instead.
    const active = panel.querySelector<HTMLButtonElement>('.pane-target-btn.active')!;
    expect(active.textContent).toBe('template');

    seedDraft(dv, panel, { width: '320' });
    panel.querySelector<HTMLButtonElement>('.pane-actionbar .btn-success')!.click();
    await new Promise(r => setTimeout(r, 0));
    document.querySelector<HTMLButtonElement>('.crev-modal .btn-success')!.click();
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));

    const applied = sent.find(m => m.type === 'APPLY_OBJECT_CHANGES') as { target?: string } | undefined;
    expect(applied?.target).toBe('template');
  });
});

describe('DetailView — tree navigation', () => {
  it('the Structure segment renders siblings and emits FETCH_OBJECT_PANE on click', () => {
    const { dv, panel, sent } = makeDetailView();
    dv.show(makeObj('100'), panel);
    dv.handleMessage(paneData('100', {
      parentRid: '50',
      siblings: [{ rid: '100', isCurrent: true }, { rid: '101', isCurrent: false }],
    }), panel);

    // The local tree lives in the Structure segment now.
    clickSegment(panel, 'Structure');
    sent.length = 0;
    const sibling = panel.querySelector<HTMLElement>('.pane-tree-row[data-rid="101"]')!;
    expect(sibling).toBeTruthy();
    sibling.click();

    expect(sent.find(m => m.type === 'FETCH_OBJECT_PANE' && (m as { rid: string }).rid === '101')).toBeTruthy();
  });

  it('clicking the parent crumb in the path bar navigates to the parent', () => {
    const { dv, panel, sent } = makeDetailView();
    dv.show(makeObj('100'), panel);
    dv.handleMessage(paneData('100', { parentRid: '50' }), panel);

    sent.length = 0;
    const crumb = panel.querySelector<HTMLElement>('.dv-path .dv-crumb')!;
    expect(crumb).toBeTruthy();
    expect(crumb.textContent).toBe('Parent');
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

  it('renders the lazy inbound scan icon in the head and fires FETCH_INBOUND on click', () => {
    const { dv, panel, sent } = makeDetailView();
    dv.show(makeObj('100', { type: 'CeRiskAssessment' }), panel);
    dv.handleMessage(domainPane('100'), panel);
    dv.handleMessage({
      type: 'CONNECTIONS_RESULT', rid: '100', ok: true,
      groups: [{ field: 'owner_reference', label: 'owner', direction: 'out', targets: [
        { rid: '5', name: 'Alice', type: 'User', businessId: 'u_alice' },
      ] }],
    } as InspectorMessage, panel);
    const scan = panel.querySelector<HTMLElement>('.lk-head .lk-scan-ic');
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
