import { describe, it, expect, vi } from 'vitest';
import { buildFetchEc, parseFetchLog, loadModel, applyModel, type LayoutIO, type BlueprintCtx } from '../sync';
import { addContainer, rename } from '../edit';
import { findNode } from '../model';

const CTX: BlueprintCtx = {
  scorecardId: '4957', scorecardRid: '451704949656267090', scorecardClass: 'Scorecard',
  tabsetId: 'crev_demo_tabset', target: 'template', hasTemplate: true,
};
const SCRID = '451704949656267090';

/** The exact fetch-EC log returned by live demo scorecard 4957 on 2026-06-26, INCLUDING the
 *  persisted ButtonContainer composite (5919 in Controls, buttons 5920/5921 nested under it).
 *  9 pipe fields: rid|bid|name|type|parentRid|containerRid|L|M|S. Grid nodes carry parentRid
 *  (container empty); org nodes carry parentRid=scorecard AND a portal containerRid (RESULT→
 *  empty); composite children carry parentRid=ButtonContainer with empty containerRid. */
const SEP = '<<<CREV_LAYOUT>>>';
const LIVE_LOG = [
  '7517622522816177423|crev_demo_tabset|CREV Demo Tabs|TabSet|||||',
  '2187765926705871955|4895|Overview|Tab|7517622522816177423||6|6|6',
  '3067221467472413579|cont_crev_demo_enterprise_4|Summary|Container|2187765926705871955||2|6|6',
  '2467555656767828279|cont_crev_demo_enterprise_7|Charts|Container|2187765926705871955||4|6|6',
  '7538488125611321093|4904|Risk Register|Tab|7517622522816177423||6|6|6',
  '5951754705969011584|cont_crev_demo_enterprise_14|KPIs|Container|7538488125611321093||2|6|6',
  '2828814662590274775|cont_crev_demo_enterprise_18|Side Panel|Container|7538488125611321093||2|6|6',
  '8214384550314311128|cont_crev_demo_enterprise_19|Detail|Container|2828814662590274775||6|6|6',
  '1450086538035735748|4914|Controls|Tab|7517622522816177423||6|6|6',
  '1492131184058647922|cont_crev_demo_enterprise_23|Control Library|Container|1450086538035735748||6|6|6',
  `2987796583641680440|4958|Exec Summary|DescriptionView|${SCRID}|3067221467472413579|6|6|6`,
  `2249095972374574164|4959|Overall Status|SimpleStatus|${SCRID}|3067221467472413579|6|6|6`,
  `3542663483585183547|4960|Losses by Cat|BarChart|${SCRID}|2467555656767828279|3|6|6`,
  `2250464429608538178|4961|Exposure Split|PieChart|${SCRID}|2467555656767828279|3|6|6`,
  `1354130434754666657|4962|Top Risks|ExtendedTable|${SCRID}|2467555656767828279|6|6|6`,
  `4493822552975655408|4963|Open Actions|ExtendedTable|${SCRID}|2187765926705871955|6|6|6`,
  `7838696810607414624|4964|Register|RiskList|${SCRID}|7538488125611321093|4|6|6`,
  `9151436265947860271|4965|Control Health|FunctionStatus|${SCRID}|5951754705969011584|6|6|6`,
  `388670279798408546|4966|Risk Appetite|Status|${SCRID}|5951754705969011584|6|6|6`,
  `7742132600897063386|4967|Trend vs Target|BarLineChart|${SCRID}|7538488125611321093|4|6|6`,
  `7057203363357744827|4968|By Owner|PieChart|${SCRID}|8214384550314311128|6|6|6`,
  `1797742395951481546|4969|Notes|TextElement|${SCRID}|8214384550314311128|6|6|6`,
  `3173231608073597930|4970|Scope|DescriptionView|${SCRID}|1492131184058647922|2|6|6`,
  `7298791240939894938|4971|Owner Input|InputView|${SCRID}|1492131184058647922|4|6|6`,
  `8155294424005531968|4972|Controls|ExtendedTable|${SCRID}|1492131184058647922|6|6|6`,
  `5673133064517788723|4973|Run Test|ActionButton|${SCRID}|1450086538035735748|2|6|6`,
  `2600934806794044554|4974|Checklist|CheckList|${SCRID}|1450086538035735748|4|6|6`,
  `4410778765552068593|5919|Test Buttons|ButtonContainer|${SCRID}|1450086538035735748|6|6|6`,
  '2047284016813479788|5920|Run Audit|ActionButton|4410778765552068593||6|6|6',
  '1764636994403434151|5921|Export|ActionButton|4410778765552068593||6|6|6',
].map(l => SEP + l).join('\n');

const fakeIo = (log: string, ok = true): LayoutIO => ({ exec: vi.fn(async () => ({ ok, log })) });

describe('sync.buildFetchEc', () => {
  it('resolves org root with lookup(rid), tabset with t.<id>, recurses both models', () => {
    const ec = buildFetchEc(CTX);
    expect(ec).toContain('_ts := t.crev_demo_tabset');
    expect(ec).toContain('_sc := lookup(451704949656267090)');
    expect(ec).toContain('_ts.descendants().forEach');
    expect(ec).toContain('_sc.descendants().forEach');   // org side recurses (composites)
    expect(ec).toContain('= "RESULT"');                  // phantom placement collapses to empty
  });
  it('rejects an unsafe rid / business id (no EC injection)', () => {
    expect(() => buildFetchEc({ ...CTX, scorecardRid: '1); delete()' })).toThrow(/unsafe EC rid/);
    expect(() => buildFetchEc({ ...CTX, tabsetId: 't"; x' })).toThrow(/unsafe EC business id/);
  });
});

describe('sync.parseFetchLog', () => {
  it('reads the live log into 30 wire nodes', () => {
    const nodes = parseFetchLog(LIVE_LOG);
    expect(nodes.length).toBe(30);
    const bc = nodes.find(n => n.businessId === '5919')!;
    expect(bc.type).toBe('ButtonContainer');
    expect(bc.containerRid).toBe('1450086538035735748'); // placed in Controls tab
    const btn = nodes.find(n => n.businessId === '5920')!;
    expect(btn.parentRid).toBe('4410778765552068593');   // nested under the ButtonContainer
    expect(btn.containerRid).toBeUndefined();             // RESULT collapsed to empty
  });
});

describe('sync.loadModel', () => {
  it('reconstructs the demo page: 3 tabs, nested Detail, tab-bound widgets', async () => {
    const { model, baseline, orphans } = await loadModel(fakeIo(LIVE_LOG), CTX);
    expect(model.tabs.map(t => t.name)).toEqual(['Overview', 'Risk Register', 'Controls']);
    expect(orphans).toEqual([]);
    const sidePanel = findNode(model, 'cont_crev_demo_enterprise_18')!;
    expect(sidePanel.node.children.map(c => c.id)).toContain('cont_crev_demo_enterprise_19');
    const risk = findNode(model, '4904')!;
    expect(risk.node.children.some(c => c.id === '4964')).toBe(true);
    expect(baseline).not.toBe(model);
  });
  it('nests a composite widget: ButtonContainer under Controls, buttons under it', async () => {
    const { model } = await loadModel(fakeIo(LIVE_LOG), CTX);
    const controls = findNode(model, '4914')!;
    const bc = controls.node.children.find(c => c.id === '5919')!;
    expect(bc.kind).toBe('widget');                       // composite is a widget-kind node…
    expect(bc.className).toBe('ButtonContainer');
    expect(bc.children.map(c => c.name)).toEqual(['Run Audit', 'Export']); // …with nested children
  });
  it('surfaces a container-less widget (RESULT-tab risk) as an orphan, not in the tree', async () => {
    const stray = `${SEP}999|9001|Stray|TextElement|${SCRID}||||`; // parent=scorecard, no container
    const { model, orphans } = await loadModel(fakeIo(LIVE_LOG + '\n' + stray), CTX);
    expect(orphans.map(o => o.businessId)).toEqual(['9001']);
    expect(findNode(model, '9001')).toBeNull();
  });
  it('throws when the fetch EC fails', async () => {
    await expect(loadModel(fakeIo('', false), CTX)).rejects.toThrow(/layout fetch failed/);
  });
});

describe('sync.applyModel', () => {
  it('no-ops when desired equals baseline (empty diff → nothing executed)', async () => {
    const io = fakeIo(LIVE_LOG);
    const { baseline, model } = await loadModel(io, CTX);
    (io.exec as ReturnType<typeof vi.fn>).mockClear(); // ignore loadModel's own fetch
    const res = await applyModel(io, baseline, model, CTX);
    expect(res.noop).toBe(true);
    expect(res.script).toBe('');
    expect(io.exec).not.toHaveBeenCalled();
  });
  it('executes the compiled script, then re-fetches to rebuild model + baseline', async () => {
    const io = fakeIo(LIVE_LOG);
    const { baseline } = await loadModel(io, CTX);
    let desired = addContainer(baseline, '4904', 0, 3, 'New KPIs').model;
    desired = rename(desired, '4969', 'Analyst Notes');
    const execed: string[] = [];
    io.exec = vi.fn(async (code: string) => { execed.push(code); return { ok: true, log: LIVE_LOG }; });
    const res = await applyModel(io, baseline, desired, CTX);
    expect(res.ok).toBe(true);
    expect(res.noop).toBe(false);
    expect(res.script).toContain('.add(Container');
    expect(res.script).toContain('name := "Analyst Notes"');
    expect(execed.length).toBe(2);              // apply script, then re-fetch
    expect(execed[1]).toContain('descendants'); // second call is the re-fetch
    expect(res.model).toBeDefined();
    expect(res.baseline).toBeDefined();
  });
  it('reports failure without re-fetching when the apply EC errors', async () => {
    const io = fakeIo(LIVE_LOG);
    const { baseline } = await loadModel(io, CTX);
    const desired = rename(baseline, '4969', 'X');
    io.exec = vi.fn(async () => ({ ok: false, error: 'rollback: bad' }));
    const res = await applyModel(io, baseline, desired, CTX);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/rollback/);
    expect(res.model).toBeUndefined();
  });
});
