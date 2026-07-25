import { describe, it, expect, vi } from 'vitest';
import {
  buildFetchEc, parseFetchLog, parseOverrides, parseStyles, loadModel, loadStructureModel, applyModel,
  resolvePageContext, buildContextEc, DEFAULT_TABSET, parsePageName,
  buildFlowRefChildrenEc, parseFlowRefChildren, type LayoutIO, type BlueprintCtx,
} from '../sync';
import { addContainer, rename } from '../edit';
import { addFlowChild } from '../flow';
import { findNode } from '../model';

const CTX: BlueprintCtx = {
  pageId: '4957', pageRid: '451704949656267090', pageClass: 'Scorecard',
  tabsetId: 'crev_demo_tabset', target: 'template', hasTemplate: true,
};
const SCRID = '451704949656267090';

/** The exact fetch-EC log returned by live demo scorecard 4957 on 2026-06-26, INCLUDING the
 *  persisted ButtonContainer composite (5919 in Controls, buttons 5920/5921 nested under it).
 *  Wire fields (see layout-wire.ts): rid|bid|type|parentRid|containerRid|L|M|S|height|name — `name`
 *  LAST. Grid nodes carry parentRid (container empty); org nodes carry parentRid=scorecard AND a
 *  portal containerRid (RESULT→empty); composite children carry parentRid=ButtonContainer with empty
 *  containerRid. The fixtures below are authored in SOURCE order and reordered by `toWire`. */
const SEP = '<<<CREV_LAYOUT>>>';
// The fetch-log fixtures below are authored as readable tuples in SOURCE order
// (rid|bid|name|type|parent|container|L|M|S[|height]); toWire reorders each into the live wire format
// where `name` is the LAST field (see layout-wire.ts). Authoring stays legible; the parser still sees
// the real format. The semantic assertions (names, hierarchy, heights) catch any reorder slip.
const toWire = (l: string): string => {
  const [rid, bid, name, type, parent = '', cont = '', L = '', M = '', S = '', height = ''] = l.split('|');
  return [rid, bid, type, parent, cont, L, M, S, height, name].join('|');
};
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
].map(l => SEP + toWire(l)).join('\n');

const fakeIo = (log: string, ok = true): LayoutIO => ({ exec: vi.fn(async () => ({ ok, log })) });

describe('sync.buildFetchEc', () => {
  it('resolves org root with lookup(rid), tabset with t.<id>, recurses both models', () => {
    const ec = buildFetchEc(CTX);
    expect(ec).toContain('_ts := t.crev_demo_tabset');
    expect(ec).toContain('_sc := lookup(451704949656267090)');
    expect(ec).toContain('_ts.descendants().forEach');
    expect(ec).toContain('_sc.descendants().forEach');   // org side recurses (composites)
    expect(ec).toContain('_res := t.RESULT');            // the shared Result tab is adopted into the strip
    expect(ec).toContain('|RESULT|Tab|');                // ...emitted as a Tab node with its real parent
  });
  it('rejects an unsafe rid / business id (no EC injection)', () => {
    expect(() => buildFetchEc({ ...CTX, pageRid: '1); delete()' })).toThrow(/Invalid RID/);
    expect(() => buildFetchEc({ ...CTX, tabsetId: 't"; x' })).toThrow(/Invalid business id/);
  });
  it('emits the F2 override channel for INSTANCE loads only + parseOverrides reads it', () => {
    // Template-target loads skip the channel entirely — a template's widgets have no linkedTo, so
    // every per-widget comparison would be dead weight (the heavy-page fetch-timeout fix).
    expect(buildFetchEc(CTX)).not.toContain('<<<CREV_OVER>>>');
    const ec = buildFetchEc({ ...CTX, target: 'instance' });
    expect(ec).toContain('<<<CREV_OVER>>>');                // the channel is emitted
    expect(ec).toContain('_w.columnsLargeScreen.whenMissing("") <> _lt.columnsLargeScreen'); // compares vs linkedTo
    // parser: only OVER lines are read, layout (SEP) lines are ignored; props split on comma.
    const log = `${SEP}${toWire('1|w1|W|BarChart|451|cell|2|6|6')}\n<<<CREV_OVER>>>w1|columnsLargeScreen,name\n`;
    const map = parseOverrides(log);
    expect(map.get('w1')).toEqual(['columnsLargeScreen', 'name']);
    expect(parseFetchLog(log).map(n => n.businessId)).toEqual(['w1']); // layout parser unaffected by OVER lines
  });
  it('emits the G3 style channel + parseStyles normalises BMP enum strings', () => {
    const ec = buildFetchEc(CTX);
    expect(ec).toContain('<<<CREV_STY>>>');                 // the style channel is emitted
    expect(ec).toContain('_w.headerColor.id.whenMissing("")'); // colour LINK as a bid, not a value
    // BMP stringifies enums prefixed + lowercased — parseStyles must reduce to the bare uppercase member.
    const log = `${SEP}${toWire('1|w1|W|BarChart|451|cell|2|6|6')}\n`
      + `<<<CREV_STY>>>w1|C_BLUE|C_INK|true|HeaderStyle.inside|BorderStyle.line|40\n`
      + `<<<CREV_STY>>>w2|||false||NONE|0\n`;
    const map = parseStyles(log);
    expect(map.get('w1')).toEqual({
      headerColorBid: 'C_BLUE', fontColorBid: 'C_INK', shadow: true,
      headerStyle: 'INSIDE', borderStyle: 'LINE', transparency: 40,
    });
    // w2: no colours/headerStyle, but explicit shadow=false + borderStyle NONE + transparency 0 are kept.
    expect(map.get('w2')).toEqual({ shadow: false, borderStyle: 'NONE', transparency: 0 });
    expect(parseFetchLog(log).map(n => n.businessId)).toEqual(['w1']); // layout parser ignores STY lines
  });
  it('parses the widget flags: visibility enum (normalised) + tools/search + shownOn trio', () => {
    // Empty fields = the type lacks the trait (the UI gate); BMP stringifies the
    // enum as "Visibillity.novisible" → enumMember → NOVISIBLE.
    const log = `<<<CREV_STY>>>w1|||||NONE|0|Visibillity.novisible|true|false|false|true|false\n`
      + `<<<CREV_STY>>>w2|||||NONE|0||||||\n`;
    const map = parseStyles(log);
    expect(map.get('w1')).toEqual({
      borderStyle: 'NONE', transparency: 0,
      visibility: 'NOVISIBLE', showToolMenu: true, disableSearch: false,
      shownOnLargeDisplay: false, shownOnMediumDisplay: true, shownOnSmallDisplay: false,
    });
    // w2 carries none of the flags → none of the fields exist (trait absent).
    expect(map.get('w2')).toEqual({ borderStyle: 'NONE', transparency: 0 });
  });
  it('resultOnly: emits the Result tab + org widgets only — NOT default_tabset\'s shared scaffold', () => {
    const ec = buildFetchEc({ ...CTX, resultOnly: true });
    expect(ec).toContain('_res := t.RESULT');          // the Result tab node...
    expect(ec).toContain('|RESULT|Tab|');              // ...emitted as a Tab
    expect(ec).toContain('_sc.descendants().forEach'); // the page's own widgets
    expect(ec).not.toContain('_ts.descendants()');     // NOT the shared Row/Column scaffold
    expect(ec).not.toContain('_ts := ');               // no tabset root walk at all
  });

  it('structure projection preserves layout fields but removes Blueprint-only channels', () => {
    const ec = buildFetchEc({ ...CTX, target: 'instance' }, {
      projection: 'structure',
      chunkSize: 32,
      includeHeight: false,
    });
    expect(ec).toContain('_ts.descendants().forEach');
    expect(ec).toContain('_layoutNodes := _sc.children()');
    expect(ec).toContain('_sc.descendants(ButtonContainer)');
    expect(ec).toContain('_sc.descendants(ButtonGroup)');
    expect(ec).not.toContain('_sc.descendants().forEach(_w:');
    expect(ec).toContain('_w.columnsLargeScreen.whenMissing("")');
    expect(ec).toContain('IF _i > 31 THEN');
    expect(ec).toContain('_structureEmitted > 599');
    expect(ec).toContain('<<<CREV_LAYOUT_LIMIT>>>600');
    expect(ec).not.toContain('chartHeight');
    expect(ec).not.toContain('<<<CREV_OVER>>>');
    expect(ec).not.toContain('<<<CREV_STY>>>');
    expect(ec).not.toContain('<<<CREV_FREF>>>');
    expect(ec.length).toBeLessThan(buildFetchEc({ ...CTX, target: 'instance' }).length / 3);
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
  it('reads chartHeight (10th field) so height edits start from the real value, not a default', () => {
    // regression for the stress-test bug: the fetch omitted chartHeight, so a height edit started
    // from the 200 default and clobbered the live 470.
    const chart = parseFetchLog(`${SEP}${toWire('900|cd|Chart|BarChart|451|75384|4|6|6|470')}`)[0];
    expect(chart.chartHeight).toBe(470);
    // a line with an empty height field still parses fine — height undefined
    expect(parseFetchLog(`${SEP}${toWire('901|x|W|Status|451|75384|6|6|6')}`)[0].chartHeight).toBeUndefined();
  });
  it('preserves a pipe in a name without shifting structural fields (name is the last field)', () => {
    // "Revenue | 2024" — a realistic name. The old name-in-the-middle format shifted every field
    // after it and misclassified the node; name-last joins the remainder back intact.
    const n = parseFetchLog(`${SEP}900|cd|BarChart|451|75384|3|6|6|470|Revenue | 2024`)[0];
    expect(n.name).toBe('Revenue | 2024');
    expect(n.type).toBe('BarChart');           // structure intact despite the pipe in the name
    expect(n.parentRid).toBe('451');
    expect(n.containerRid).toBe('75384');
    expect(n.columnsLargeScreen).toBe(3);
    expect(n.chartHeight).toBe(470);
  });
  it('degrades a newline in a name to truncation, never a dropped or shifted node', () => {
    // A literal newline used to truncate the SEP block before field 9 → the node vanished entirely.
    // With name last, the structural fields all precede it, so the node survives (name truncated).
    const n = parseFetchLog(`${SEP}900|cd|BarChart|451|75384|3|6|6||First\nSecond`)[0];
    expect(n).toBeDefined();
    expect(n.type).toBe('BarChart');
    expect(n.parentRid).toBe('451');
    expect(n.name).toBe('First');              // truncated at the newline, but the node is kept
  });
  it('does not turn an embedded layout marker in a name into a phantom node', () => {
    const injected = `${SEP}999|phantom|Tab||||6|6||Injected`;
    const nodes = parseFetchLog(
      `${SEP}900|real|BarChart|451|75384|3|6|6|470|Customer text ${injected}`,
    );
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({
      rid: '900',
      businessId: 'real',
      name: `Customer text ${injected}`,
    });
  });
  it('sanitizes the reserved marker prefix in every emitted layout name', () => {
    const ec = buildFetchEc(CTX);
    expect(ec).toContain('(IF _w.name.whenMissing("") = "*<<<CREV_*" THEN "[reserved CREV marker]" ELSE _w.name.whenMissing("") ENDIF)');
    expect(ec).toContain('(IF _n.name.whenMissing("") = "*<<<CREV_*" THEN "[reserved CREV marker]" ELSE _n.name.whenMissing("") ENDIF)');
    expect(ec).toContain('(IF _sc.name.whenMissing("") = "*<<<CREV_*" THEN "[reserved CREV marker]" ELSE _sc.name.whenMissing("") ENDIF)');
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
    const stray = `${SEP}${toWire(`999|9001|Stray|TextElement|${SCRID}||||`)}`; // parent=scorecard, no container
    const { model, orphans } = await loadModel(fakeIo(LIVE_LOG + '\n' + stray), CTX);
    expect(orphans.map(o => o.businessId)).toEqual(['9001']);
    expect(findNode(model, '9001')).toBeNull();
  });
  it('drops list-widget member content generically (any leaf widget, not a hardcoded class)', async () => {
    // Mirrors bmw_sharepoint_sc: a list widget sits in the grid, and each member has its container bound
    // to a real page tab (Overview) with its own detail portal under it. Members are list CONTENT — they
    // must not appear as standalone cells, nor leak into orphans. Two DIFFERENT list types (IndicatorList
    // + the RiskList already in LIVE_LOG as '4964') prove the rule is keyed on the layout taxonomy — a
    // leaf widget that isn't a container/tab/tabset/composite holds content — not on a class allowlist.
    const memberRows = [
      `5100|il1|Cases|IndicatorList|${SCRID}|3067221467472413579|6|6|6`,        // list widget, in the Summary container
      `5101|ind1|CASE-0042|Indicator|5100|2187765926705871955|6|6|6`,           // member — container bound to the Overview TAB
      `5102|cvo1|Documents|CustomVisualization|5101|2187765926705871955|6|6|6`, // member's own detail portal (deeper)
      `5200|risk1|R-01|Risk|7838696810607414624|2187765926705871955|6|6|6`,     // member of the existing RiskList 4964
    ].map(l => SEP + toWire(l)).join('\n');
    const { model, orphans } = await loadModel(fakeIo(LIVE_LOG + '\n' + memberRows), CTX);
    expect(findNode(model, 'il1')).not.toBeNull();          // the list widgets themselves stay…
    expect(findNode(model, 'il1')!.node.children).toEqual([]); // …as atomic leaves — members stripped
    expect(findNode(model, 'ind1')).toBeNull();  // IndicatorList member not surfaced
    expect(findNode(model, 'cvo1')).toBeNull();  // …nor its deeper detail CVO
    expect(findNode(model, 'risk1')).toBeNull(); // RiskList member (different class) also stripped
    const strayIds = orphans.map(o => o.businessId);
    for (const id of ['ind1', 'cvo1', 'risk1']) expect(strayIds).not.toContain(id); // and none leak to orphans
    // Composite children are NOT content — the ButtonContainer's buttons stay nested (regression guard).
    expect(findNode(model, '5919')!.node.children.map(c => c.name)).toEqual(['Run Audit', 'Export']);
  });
  it('throws when the fetch EC fails', async () => {
    await expect(loadModel(fakeIo('', false), CTX)).rejects.toThrow(/layout fetch failed/);
  });
});

/** Enterprise page: a CeIssue (102) links to EnterpriseTemplate 5923; the template's widgets are
 *  bound to a Tab/Container in the SHARED default_tabset. These ids are the real live objects
 *  (created + verified on 2026-06-26), plus one decoy tab ("My KPIs", a real default_tabset tab)
 *  carrying a structural container but none of THIS template's widgets — it must be filtered out. */
const TMPL_RID = '6657825841951873912';
const ENTERPRISE_CTX: BlueprintCtx = {
  pageId: '5923', pageRid: TMPL_RID, pageClass: 'EnterpriseTemplate',
  tabsetId: DEFAULT_TABSET, target: 'template', hasTemplate: true, tabScope: 'withContent',
};
const ENTERPRISE_LOG = [
  '900|default_tabset|Tab set|TabSet|||||',
  '3490092378368822362|5930|Issue Overview|Tab|900||6|6|6',     // our tab
  '901|316|My KPIs|Tab|900||6|6|6',                              // decoy tab (shared, not ours)
  '432431197368212130|5931|Main|Container|3490092378368822362||6|6|6',
  '902|cont_decoy|Decoy|Container|901||6|6|6',                   // structural, no widgets
  `212997087683636707|w1|Issue Status|SimpleStatus|${TMPL_RID}|432431197368212130|6|6|6`,
  `3010690603757079917|w2|Issue Summary|DescriptionView|${TMPL_RID}|432431197368212130|6|6|6`,
  `5194505591298034683|w3|Issue Trend|BarChart|${TMPL_RID}|432431197368212130|6|6|6`,
].map(l => SEP + toWire(l)).join('\n');

describe('sync.resolvePageContext', () => {
  it('enterprise: points the page root at the linked template + shared tabset, scoped to content', async () => {
    const probe = `${'<<<CREV_CTX>>>'}enterprise|${TMPL_RID}|5923|EnterpriseTemplate|default_tabset`;
    const r = await resolvePageContext({ exec: vi.fn(async () => ({ ok: true, log: probe })) }, '5977812347502735400');
    expect(r).not.toBeNull();
    const ctx = r as BlueprintCtx;
    expect(ctx.pageId).toBe('5923');            // edit the TEMPLATE, not the instance
    expect(ctx.pageRid).toBe(TMPL_RID);
    expect(ctx.tabsetId).toBe(DEFAULT_TABSET);
    expect(ctx.tabScope).toBe('withContent');
    expect(ctx.target).toBe('template');
  });
  it('enterprise: preserves a dedicated tabset discovered from template widget placement', async () => {
    const probe = `${'<<<CREV_CTX>>>'}enterprise|${TMPL_RID}|5923|EnterpriseTemplate|org_custom_tabs`;
    const r = await resolvePageContext({ exec: vi.fn(async () => ({ ok: true, log: probe })) }, '5977812347502735400');
    expect(r).toMatchObject({
      pageId: '5923', pageRid: TMPL_RID, tabsetId: 'org_custom_tabs',
      tabScope: 'withContent', target: 'template',
    });
  });
  it('direct: edits the object itself with its discovered dedicated tabset', async () => {
    const probe = `${'<<<CREV_CTX>>>'}direct|451704949656267090|4957|Scorecard|crev_demo_tabset|n|9|||y`;
    const r = await resolvePageContext({ exec: vi.fn(async () => ({ ok: true, log: probe })) }, '451704949656267090');
    expect(r).not.toBeNull();
    const ctx = r as BlueprintCtx;
    expect(ctx.pageId).toBe('4957');
    expect(ctx.pageRid).toBe('451704949656267090');
    expect(ctx.tabsetId).toBe('crev_demo_tabset');
    expect(ctx.tabScope).toBe('all');           // dedicated tabset → keep all tabs
    expect(ctx.resultOnly).toBeFalsy();
    expect(ctx.templateRid).toBeUndefined();    // hasLink='n' → no template to toggle to
  });
  it('direct + linkedTo: surfaces the template rid + id for the instance/template toggle', async () => {
    const probe = `${'<<<CREV_CTX>>>'}direct|451704949656267090|4957|Scorecard|crev_demo_tabset|y|9|6921053769472535971|crev_demo_complex|y`;
    const r = await resolvePageContext({ exec: vi.fn(async () => ({ ok: true, log: probe })) }, '451704949656267090');
    expect(r).toMatchObject({
      pageId: '4957', target: 'instance', hasTemplate: true,
      templateRid: '6921053769472535971', templateId: 'crev_demo_complex',
    });
  });
  it('no dedicated tabset but RESULT widgets → loadable resultOnly ctx (via default_tabset)', async () => {
    const probe = `${'<<<CREV_CTX>>>'}direct|999|888|Scorecard||n|4|||y`; // empty tabsetId, 4 widgets
    const r = await resolvePageContext({ exec: vi.fn(async () => ({ ok: true, log: probe })) }, '999');
    expect(r).toMatchObject({
      pageRid: '999', pageId: '888', pageClass: 'Scorecard',
      tabsetId: DEFAULT_TABSET, tabScope: 'withContent', target: 'instance', resultOnly: true,
    });
  });
  it('loads an empty Card-bearing page through the create-tabset flow', async () => {
    const probe = `${'<<<CREV_CTX>>>'}direct|999|888|Scorecard||n|0|||y`;
    const ctx = await resolvePageContext({ exec: vi.fn(async () => ({ ok: true, log: probe })) }, '999');
    expect(ctx).toMatchObject({ pageId: '888', resultOnly: true, tabsetId: DEFAULT_TABSET });
  });
  it('returns null when no tabset, widgets, or page-host Card exist', async () => {
    const probe = `${'<<<CREV_CTX>>>'}direct|999|888|Category||n|0|||n`;
    const ctx = await resolvePageContext({ exec: vi.fn(async () => ({ ok: true, log: probe })) }, '999');
    expect(ctx).toBeNull();
  });
  it('refuses an Organisation root (never a page host — guards a transient org-resolve mid-nav)', async () => {
    const probe = `${'<<<CREV_CTX>>>'}direct|1234|steadfast_sbx|Organisation||n|12|||y`; // org: has children, no tabset
    const ctx = await resolvePageContext({ exec: vi.fn(async () => ({ ok: true, log: probe })) }, '1234');
    expect(ctx).toBeNull();
  });
  it('returns null when the probe EC fails', async () => {
    const ctx = await resolvePageContext({ exec: vi.fn(async () => ({ ok: false })) }, '999');
    expect(ctx).toBeNull();
  });
});

describe('sync.buildContextEc (org redirect)', () => {
  it('redirects an Organisation rid to its first Scorecard/ModelPage child', () => {
    const ec = buildContextEc('645827105214156857');
    expect(ec).toContain('= "Organisation"'); // detects an org rid
    expect(ec).toContain('"Scorecard"');       // and hunts for a page child
    expect(ec).toContain('"ModelPage"');
    expect(ec).toContain('_probe := _c');       // reassigning the probe to that landing page
  });
  it('discovers an enterprise template tabset from its placed widgets before falling back', () => {
    const ec = buildContextEc('645827105214156857');
    const enterprise = ec.slice(ec.indexOf('IF _tr <> "" THEN'), ec.indexOf('ELSE', ec.indexOf('IF _tr <> "" THEN')));
    expect(enterprise).toContain('_tmpl.children().forEach(_ch:');
    expect(enterprise).toContain('_ch.container');
    expect(ec).toContain('IF _tsid = "" THEN _tsid := "default_tabset"');
    expect(ec).toContain('"|" + _tsid');
  });
});

describe('sync.loadModel (enterprise)', () => {
  it('reconstructs the template page and drops shared-tabset tabs with no template content', async () => {
    const { model } = await loadModel(fakeIo(ENTERPRISE_LOG), ENTERPRISE_CTX);
    // only "Issue Overview" survives; the decoy "My KPIs" tab is filtered out by withContent
    expect(model.tabs.map(t => t.name)).toEqual(['Issue Overview']);
    const main = findNode(model, '5931')!;
    expect(main.node.children.map(c => c.name)).toEqual(['Issue Status', 'Issue Summary', 'Issue Trend']);
  });
  it('with tabScope "all" the decoy tab would remain (proves the filter is what drops it)', async () => {
    const { model } = await loadModel(fakeIo(ENTERPRISE_LOG), { ...ENTERPRISE_CTX, tabScope: 'all' });
    expect(model.tabs.map(t => t.name)).toEqual(['Issue Overview', 'My KPIs']);
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
  it('stale-checks, executes the compiled script, then re-fetches to rebuild model + baseline', async () => {
    const io = fakeIo(LIVE_LOG);
    const { baseline } = await loadModel(io, CTX);
    let desired = addContainer(baseline, '4904', 0, 3, 'New KPIs').model;
    desired = rename(desired, '4969', 'Analyst Notes');
    const execed: { code: string; commit: boolean }[] = [];
    // The post-commit re-fetch must reflect the applied rename, else the structural rollback guard
    // (an unchanged page after a non-empty commit = a discarded transaction) correctly fails it.
    let committed = false;
    io.exec = vi.fn(async (code: string, commit = false) => {
      execed.push({ code, commit });
      if (commit) { committed = true; return { ok: true, log: LIVE_LOG }; }
      return { ok: true, log: committed ? LIVE_LOG.replace('|Notes', '|Analyst Notes') : LIVE_LOG };
    });
    const res = await applyModel(io, baseline, desired, CTX);
    expect(res.ok).toBe(true);
    expect(res.noop).toBe(false);
    expect(res.script).toContain('.add(Container');
    expect(res.script).toContain('name := "Analyst Notes"');
    // stale-check fetch (read) → commit (write) → re-fetch (read)
    expect(execed.map(e => e.commit)).toEqual([false, true, false]);
    expect(execed[0].code).toContain('descendants'); // stale-check re-fetch
    expect(execed[1].commit).toBe(true);             // the only committing call
    expect(res.model).toBeDefined();
    expect(res.baseline).toBeDefined();
  });
  it('blocks as STALE when the live page drifted from the baseline (no commit)', async () => {
    const io = fakeIo(LIVE_LOG);
    const { baseline } = await loadModel(io, CTX);
    const desired = rename(baseline, '4969', 'Analyst Notes');
    // live fetch now returns a DRIFTED page (widget 4964 renamed by someone else). `name` is the last
    // wire field, so the rename mutates the line's trailing `|Register` (the tab "Risk Register" ends
    // in `|Risk Register`, which this doesn't match).
    const drifted = LIVE_LOG.replace('|Register', '|Register RENAMED');
    let committed = false;
    io.exec = vi.fn(async (code: string, commit = false) => {
      if (commit) { committed = true; return { ok: true, log: drifted }; }
      return { ok: true, log: drifted };
    });
    const res = await applyModel(io, baseline, desired, CTX);
    expect(res.stale).toBe(true);
    expect(res.ok).toBe(false);
    expect(committed).toBe(false);          // nothing was written
    expect(res.model).toBeDefined();        // fresh live state handed back for rebase
    expect(findNode(res.model!, '4964')!.node.name).toBe('Register RENAMED');
  });
  it('detects a SILENT rollback: commit returns ok but the re-fetched page is unchanged', async () => {
    // BMP discarded the transaction and returned ok with no ERROR (the "200 but nothing changed" case).
    // The re-fetch still matches the baseline, so the structural guard must fail the apply rather than
    // letting the UI mark an unchanged page as saved — no log-phrase scraping involved.
    const io = fakeIo(LIVE_LOG);
    const { baseline } = await loadModel(io, CTX);
    const desired = rename(baseline, '4969', 'Analyst Notes');
    io.exec = vi.fn(async (_code: string, _commit = false) => ({ ok: true, log: LIVE_LOG })); // every fetch = unchanged
    const res = await applyModel(io, baseline, desired, CTX);
    expect(res.ok).toBe(false);
    expect(res.stale).toBeFalsy();
    expect(res.error).toMatch(/discarded|unchanged/i);
    expect(res.model).toBeDefined();         // fresh live state still handed back
  });
  it('on a commit ERROR with nothing landed, fails but hands back fresh state (EC is non-atomic)', async () => {
    const io = fakeIo(LIVE_LOG);
    const { baseline } = await loadModel(io, CTX);
    const desired = rename(baseline, '4969', 'X');
    // commit errors; the post-commit reload shows the page unchanged → nothing landed.
    io.exec = vi.fn(async (code: string, commit = false) =>
      commit ? { ok: false, error: 'rollback: bad' } : { ok: true, log: LIVE_LOG });
    const res = await applyModel(io, baseline, desired, CTX);
    expect(res.ok).toBe(false);
    expect(res.stale).toBeFalsy();
    expect(res.error).toMatch(/rollback/);
    expect(res.partial).toBeFalsy();      // reload shows unchanged → nothing committed
    expect(res.model).toBeDefined();      // re-fetched so the editor rebases onto reality, not a stale model
  });
  it('flags PARTIAL when the commit errors but the re-fetch shows some steps DID land (EC not atomic)', async () => {
    const io = fakeIo(LIVE_LOG);
    const { baseline } = await loadModel(io, CTX);
    const desired = rename(baseline, '4969', 'X');
    // A mid-script error, but a prior step (a rename of 4964) already committed → the reload differs.
    const partialLog = LIVE_LOG.replace('|Register', '|Register PARTIAL');
    let fetchCall = 0;
    io.exec = vi.fn(async (code: string, commit = false) => {
      if (commit) return { ok: false, error: 'boom' };
      fetchCall++;
      return { ok: true, log: fetchCall === 1 ? LIVE_LOG : partialLog }; // 1st = stale check (unchanged), then reload (changed)
    });
    const res = await applyModel(io, baseline, desired, CTX);
    expect(res.ok).toBe(false);
    expect(res.partial).toBe(true);
    expect(res.error).toMatch(/partway/i);
    expect(res.model).toBeDefined();
  });
  it('flags PARTIAL when the commit returns ok WITH warnings (a step may have soft-failed)', async () => {
    const io = fakeIo(LIVE_LOG);
    const { baseline } = await loadModel(io, CTX);
    const desired = rename(baseline, '4969', 'Analyst Notes');
    const changedLog = LIVE_LOG.replace('|Register', '|Register CHANGED');
    let fetchCall = 0;
    io.exec = vi.fn(async (code: string, commit = false) => {
      if (commit) return { ok: true, log: changedLog, hasWarning: true };
      fetchCall++;
      return { ok: true, log: fetchCall === 1 ? LIVE_LOG : changedLog }; // stale check unchanged; reload shows the landed change
    });
    const res = await applyModel(io, baseline, desired, CTX);
    expect(res.ok).toBe(true);
    expect(res.partial).toBe(true);
    expect(res.error).toMatch(/warning/i);
    expect(res.model).toBeDefined();
  });
  it('flags UNVERIFIED (not failed) when the post-commit re-fetch throws after a good commit (D4)', async () => {
    const io = fakeIo(LIVE_LOG);
    const { baseline } = await loadModel(io, CTX);
    const desired = rename(baseline, '4969', 'Analyst Notes');
    let fetchCall = 0;
    io.exec = vi.fn(async (_code: string, commit = false) => {
      if (commit) return { ok: true, log: LIVE_LOG };  // the write landed
      fetchCall++;
      if (fetchCall === 1) return { ok: true, log: LIVE_LOG }; // stale-check passes
      throw new Error('network blip on the reconcile fetch');   // the post-commit re-fetch dies
    });
    const res = await applyModel(io, baseline, desired, CTX);
    expect(res.unverified).toBe(true);
    expect(res.ok).toBe(true);              // reflects the commit's own result — NOT a failure
    expect(res.model).toBeUndefined();      // no re-fetch → nothing to rebase onto; the UI reloads instead
    expect(res.error).toMatch(/could not be verified/i);
  });
  it('UNVERIFIED carries ok:false when the commit errored AND the re-fetch then throws (D4)', async () => {
    const io = fakeIo(LIVE_LOG);
    const { baseline } = await loadModel(io, CTX);
    const desired = rename(baseline, '4969', 'X');
    let fetchCall = 0;
    io.exec = vi.fn(async (_code: string, commit = false) => {
      if (commit) return { ok: false, error: 'boom' };
      fetchCall++;
      if (fetchCall === 1) return { ok: true, log: LIVE_LOG };
      throw new Error('reconcile fetch failed');
    });
    const res = await applyModel(io, baseline, desired, CTX);
    expect(res.unverified).toBe(true);
    expect(res.ok).toBe(false);
    expect(res.model).toBeUndefined();
    expect(res.error).toMatch(/could not be verified/i);
  });
});

describe('sync.applyModel — flow steps (blueprint flow editing)', () => {
  // LIVE_LOG augmented with a flow projection for InputView 4971 → InputSet is1 (two children).
  const FREF = '<<<CREV_FREF>>>';
  const FCHD = '<<<CREV_FCHD>>>';
  const FLOW_LINES = [
    `${FREF}4971|7298791240939894938|InputView|inputset|is1|111|InputSet|||||RESULT|Category|cat1|Owner set`,
    `${FCHD}4971||f1|201|TextInput|0|0|0,0,0,0,0,|Name`,
    `${FCHD}4971||f2|202|NumberInput|0|0|0,0,0,0,0,|Score`,
  ].join('\n');
  const FLOW_LOG = LIVE_LOG + '\n' + FLOW_LINES;
  // the re-fetch after a successful flow commit: the staged TextInput now exists as a real child
  const FLOW_LOG_AFTER = FLOW_LOG + `\n${FCHD}4971||f3|203|TextInput|0|0|0,0,0,0,0,|New TextInput`;

  it('loadModel threads flow projections into the model (and the baseline)', async () => {
    const { model, baseline } = await loadModel(fakeIo(FLOW_LOG), CTX);
    expect(model.flows?.['4971']?.refId).toBe('is1');
    expect(model.flows?.['4971']?.children.map(c => c.id)).toEqual(['f1', 'f2']);
    expect(baseline.flows?.['4971']?.refId).toBe('is1');
    expect(model.flowEdits).toBeUndefined(); // fresh load stages nothing
  });

  it('a PURELY-flow apply commits and is NOT misread as a rollback (flow signature moved)', async () => {
    const io = fakeIo(FLOW_LOG);
    const { baseline, model } = await loadModel(io, CTX);
    const desired = addFlowChild(model, 'is1', 'TextInput').model;
    let committed = false;
    io.exec = vi.fn(async (code: string, commit = false) => {
      if (commit) { committed = true; return { ok: true, log: FLOW_LOG }; }
      return { ok: true, log: committed ? FLOW_LOG_AFTER : FLOW_LOG };
    });
    const res = await applyModel(io, baseline, desired, CTX);
    expect(res.ok).toBe(true);
    expect(res.script).toContain('t.is1.add(TextInput');
    expect(res.model?.flows?.['4971']?.children).toHaveLength(3); // re-fetched truth
  });

  it('a purely-flow apply whose re-fetch is unchanged IS a silent rollback', async () => {
    const io = fakeIo(FLOW_LOG);
    const { baseline, model } = await loadModel(io, CTX);
    const desired = addFlowChild(model, 'is1', 'TextInput').model;
    io.exec = vi.fn(async () => ({ ok: true, log: FLOW_LOG })); // nothing ever changes
    const res = await applyModel(io, baseline, desired, CTX);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/discarded|unchanged/i);
  });

  it('blocks as STALE when the FLOW drifted live (layout identical)', async () => {
    const io = fakeIo(FLOW_LOG);
    const { baseline, model } = await loadModel(io, CTX);
    const desired = addFlowChild(model, 'is1', 'TextInput').model;
    let committed = false;
    io.exec = vi.fn(async (_code: string, commit = false) => {
      if (commit) committed = true;
      return { ok: true, log: FLOW_LOG_AFTER }; // someone else already added a child
    });
    const res = await applyModel(io, baseline, desired, CTX);
    expect(res.stale).toBe(true);
    expect(committed).toBe(false);
  });

  it('buildFetchEc projects flow (FREF/FCHD markers) and keeps menu buttons out of the grid wire', () => {
    const ec = buildFetchEc({ ...CTX, pageRid: SCRID });
    expect(ec).toContain('<<<CREV_FREF>>>');
    expect(ec).toContain('<<<CREV_FCHD>>>');
    expect(ec).toContain('displayOnActionMenu'); // the menu-button grid exclusion branch
    expect(ec).toContain('_fref.children().forEach(_fc:'); // NOT `_c` — that's the chunk accumulator
  });
});

describe('sync — page name + on-demand ref children (support-Category + wire-to-existing)', () => {
  const PAGE = '<<<CREV_PAGE>>>';
  const FCHD = '<<<CREV_FCHD>>>';
  const FCPR = '<<<CREV_FCPR>>>';

  it('buildFetchEc emits the PAGE marker so the model can name its support Category', () => {
    expect(buildFetchEc({ ...CTX, pageRid: SCRID })).toContain('<<<CREV_PAGE>>>');
    // resultOnly path emits it too
    expect(buildFetchEc({ ...CTX, pageRid: SCRID, resultOnly: true, tabScope: 'withContent' })).toContain('<<<CREV_PAGE>>>');
  });

  it('parsePageName reads the display name (free-text last); empty/absent → undefined', () => {
    expect(parsePageName(`${PAGE}Example Flow objects\nother junk`)).toBe('Example Flow objects');
    expect(parsePageName('no marker here')).toBeUndefined();
    expect(parsePageName(`${PAGE}`)).toBeUndefined();
  });

  it('loadModel threads the page name onto model + baseline', async () => {
    const { model, baseline } = await loadModel(fakeIo(`${PAGE}My Scorecard\n` + LIVE_LOG), CTX);
    expect(model.pageName).toBe('My Scorecard');
    expect(baseline.pageName).toBe('My Scorecard');
  });

  it('loadStructureModel reconstructs the same tree without a baseline', async () => {
    const io = fakeIo(`${PAGE}My Scorecard\n` + LIVE_LOG);
    const full = await loadModel(fakeIo(`${PAGE}My Scorecard\n` + LIVE_LOG), CTX);
    const lean = await loadStructureModel(io, CTX);
    expect(lean.model.tabs).toEqual(full.model.tabs);
    expect(lean.model.pageName).toBe('My Scorecard');
    expect('baseline' in lean).toBe(false);
    expect(lean.truncated).toBe(false);
    expect(io.exec).toHaveBeenCalledWith(expect.not.stringContaining('<<<CREV_STY>>>'));
  });

  it('loadStructureModel reports when its source projection reached the safety cap', async () => {
    const lean = await loadStructureModel(fakeIo(`${LIVE_LOG}\n<<<CREV_LAYOUT_LIMIT>>>600`), CTX);
    expect(lean.truncated).toBe(true);
  });

  it('buildFlowRefChildrenEc addresses the ref by business id, one ButtonGroup nesting level', () => {
    const ec = buildFlowRefChildrenEc('is1');
    expect(ec).toContain('_ref := t.is1');
    expect(ec).toContain('_ref.children().forEach(_fc:');
    expect(ec).toContain('_fc.children().forEach(_fcc:');
    expect(() => buildFlowRefChildrenEc('is"; drop')).toThrow(/Invalid business id/); // injection-guarded
  });

  it('parseFlowRefChildren reads rows + captions, nesting ButtonGroup grandchildren', () => {
    const log = [
      `${FCHD}is1||c1|201|TextInput|1|0|0,0,0,0,0,|Name`,
      `${FCHD}is1||bg|202|ButtonGroup|0|0|0,0,0,0,0,|Buttons`,
      `${FCHD}is1|bg|b1|203|ButtonInput|0|0|0,0,0,0,0,|Go`,
      `${FCPR}is1|c1|code`,
    ].join('\n');
    const kids = parseFlowRefChildren(log);
    expect(kids.map(c => c.id)).toEqual(['c1', 'bg']);
    expect(kids[0]).toMatchObject({ required: true, prop: 'code' });
    expect(kids[1].children?.map(c => c.id)).toEqual(['b1']);
  });
});

describe('sync.resolvePageContext (blast radius)', () => {
  it('direct page → instance target, low blast radius; records a linked template', async () => {
    const probe = `${'<<<CREV_CTX>>>'}direct|451704949656267090|4957|Scorecard|crev_demo_tabset|y|9`;
    const ctx = await resolvePageContext({ exec: vi.fn(async () => ({ ok: true, log: probe })) }, '4957') as BlueprintCtx;
    expect(ctx.target).toBe('instance');    // edits the object's own widgets
    expect(ctx.hasTemplate).toBe(true);     // a linked template exists (SharedWebItems)
  });
  it('direct page with no linked template → hasTemplate false', async () => {
    const probe = `${'<<<CREV_CTX>>>'}direct|1|2|ModelPage|some_tabset|n|3`;
    const ctx = await resolvePageContext({ exec: vi.fn(async () => ({ ok: true, log: probe })) }, '1') as BlueprintCtx;
    expect(ctx.target).toBe('instance');
    expect(ctx.hasTemplate).toBe(false);
  });
});
