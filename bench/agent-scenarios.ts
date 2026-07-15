import type { AiChatTurn, AiContextEnvelope } from '../src/lib/ai/types';
import type { ToolCall, ToolResult } from '../src/lib/ai/tools';

export interface AgentScenario {
  id: string;
  description: string;
  envelope: AiContextEnvelope;
  history?: AiChatTurn[];
  prompt: string;
  maxCalls: number;
  expectedPrefix: string[];
  forbiddenTools: string[];
  answerPatterns: RegExp[];
  execute(call: ToolCall): ToolResult;
}

const source = (rid: string, businessId: string, name: string, type: string, templateBusinessId?: string): AiContextEnvelope => ({
  v: 1,
  server: { id: 'synthetic', url: 'https://example.invalid/' },
  sources: [{ kind: 'selection', object: { rid, businessId, name, type, ...(templateBusinessId ? { templateBusinessId } : {}) } }],
});

const ok = (content: string): ToolResult => ({ content, isError: false });
const bad = (call: ToolCall): ToolResult => ({
  content: `Fixture has no result for ${call.name} ${JSON.stringify(call.input)}. Reconsider the shortest route from the attached context.`,
  isError: true,
});

// Topology-preserving synthetic equivalents of patterns verified live in
// Steadfast. No tenant names, identifiers, rows, or source code are sent to an
// external model; only the platform relationships under test are retained.
const SHAREPOINT_LAYOUT = `Viewed rid=1000000000000000001
Effective page owner: SharePoint Document Workspace (Scorecard) bid=sc_synthetic_docs rid=1000000000000000001
Layout: 7 nodes
  Tab "Overview" bid=tab_synthetic_overview rid=1000000000000000011 span=12 model=portal-shared
    Container "Overview" bid=container_synthetic_overview rid=1000000000000000012 span=12 model=portal-shared
      TextElement "Workspace heading" bid=synthetic_heading rid=1000000000000000013 span=12 model=page-child code=text
      IndicatorList "Record Register" bid=synthetic_register rid=1000000000000000014 span=12 model=page-child
  Tab "Documentation" bid=tab_synthetic_documentation rid=1000000000000000015 span=12 model=portal-shared
    Container "Documentation" bid=container_synthetic_documentation span=12 model=portal-shared
      TextElement "Usage notes" bid=synthetic_notes span=12 model=page-child code=text`;

const RISK_LAYOUT = `Viewed rid=2000000000000000001
Effective page owner: Enterprise Risk Template (ModelPage) bid=mp_synthetic_risk rid=2000000000000000002
Layout: 8 nodes
Resolution: viewed enterprise instance → .template page owner
  Tab "Dashboard" bid=tab_synthetic_dashboard span=12 model=portal-shared
  Tab "Risk Register" bid=tab_synthetic_register rid=2000000000000000011 span=12 model=portal-shared
    Container "Risk Register" bid=container_synthetic_register span=12 model=portal-shared
      InputView "Register KPIs" bid=synthetic_kpis span=12 model=page-child
      RiskCharts "Risk overview" bid=synthetic_chart span=4 model=page-child
      ExtendedTable "Risk Register" bid=synthetic_risk_table rid=2000000000000000012 span=12 model=page-child code=expression
  Tab "Reports" bid=tab_synthetic_reports span=12 model=portal-shared`;

const RISK_EXPRESSION = [
  'Code: rid=2000000000000000012 property=expression (130 chars)',
  '```extended',
  '_risks := SELECT ceRiskAssessment WHERE subtype = t.instance',
  '',
  '_risks.table(code, name, description, lifecycle_state_risk)',
  '```',
  'Raw expression read is complete. If SELECT or table(...) directly names the requested class or properties, answer from this source now; do not call query_context, read_object or preview_ec merely to confirm those literals.',
].join('\n');

export const AGENT_SCENARIOS: AgentScenario[] = [
  {
    id: 'sharepoint-layout-hierarchy',
    description: 'Attached Scorecard hierarchy should be answered from one layout read.',
    envelope: source('1000000000000000001', 'sc_synthetic_docs', 'SharePoint Document Workspace', 'Scorecard'),
    prompt: 'Which tabs and widgets make up this page?',
    maxCalls: 1,
    expectedPrefix: ['read_layout'],
    forbiddenTools: ['search_objects', 'read_object', 'query_context'],
    answerPatterns: [/Overview/i, /Documentation/i, /Record Register/i],
    execute(call) {
      if (call.name === 'read_layout' && call.input.pageRid === '1000000000000000001') return ok(SHAREPOINT_LAYOUT);
      return bad(call);
    },
  },
  {
    id: 'risk-table-object-type',
    description: 'A table question should follow enterprise template layout to the table expression.',
    envelope: source('2000000000000000001', 'synthetic_risk_instance', 'Enterprise Risk', 'CeRiskModel', 'mp_synthetic_risk'),
    prompt: 'What object type are the risks in the Risk Register table?',
    maxCalls: 2,
    expectedPrefix: ['read_layout', 'read_code'],
    forbiddenTools: ['search_objects', 'read_object', 'query_context', 'read_type'],
    answerPatterns: [/ceRiskAssessment/i],
    execute(call) {
      if (call.name === 'read_layout' && call.input.pageRid === '2000000000000000001') return ok(RISK_LAYOUT);
      if (call.name === 'read_code' && call.input.ref === '2000000000000000012' && call.input.property === 'expression') return ok(RISK_EXPRESSION);
      return bad(call);
    },
  },
  {
    id: 'risk-table-properties-followup',
    description: 'Conversational “the table” still takes layout→raw expression, not descendants.',
    envelope: source('2000000000000000001', 'synthetic_risk_instance', 'Enterprise Risk', 'CeRiskModel', 'mp_synthetic_risk'),
    history: [
      { role: 'user', text: 'What is on the Risk Register tab?' },
      { role: 'assistant', text: 'I can inspect the attached page layout.' },
    ],
    prompt: 'Can you check the table and tell me a few of the properties it displays?',
    maxCalls: 2,
    expectedPrefix: ['read_layout', 'read_code'],
    forbiddenTools: ['search_objects', 'read_object', 'query_context', 'read_type'],
    answerPatterns: [/code/i, /name/i, /description/i],
    execute(call) {
      if (call.name === 'read_layout' && call.input.pageRid === '2000000000000000001') return ok(RISK_LAYOUT);
      if (call.name === 'read_code' && call.input.ref === '2000000000000000012' && call.input.property === 'expression') return ok(RISK_EXPRESSION);
      return bad(call);
    },
  },
  {
    id: 'semantic-process-not-task',
    description: 'Workspace nouns must be discovered semantically instead of mapped to Task.',
    envelope: source('7000000000000000001', 'sc_asset_process', 'Asset & Process Management', 'Scorecard'),
    prompt: 'What object type are the processes here?',
    maxCalls: 1,
    expectedPrefix: ['query_context'],
    forbiddenTools: ['search_objects', 'read_object', 'read_type', 'read_layout'],
    answerPatterns: [/Indicator/i],
    execute(call) {
      const q = typeof call.input.templateQuery === 'string' ? call.input.templateQuery : '';
      if (call.name === 'query_context' && /process/i.test(q) && !call.input.type) {
        return ok(`Viewed: Asset & Process Management (Scorecard) bid=sc_asset_process rid=7000000000000000001
Effective owner: Asset & Process Management (Scorecard) bid=sc_asset_process rid=7000000000000000001
Matched: 6
Classes: Indicator=6,
  Order-to-Cash (Indicator) bid=proc_o2c rid=7000000000000000011 template=Business Process
  Procure-to-Pay (Indicator) bid=proc_p2p rid=7000000000000000012 template=Business Process
Scope was resolved from the attached context and the count/filter evaluation is complete; rows may be capped as stated. For an object/class question this result is final: answer now without another query or exemplar read.`);
      }
      return bad(call);
    },
  },
];
