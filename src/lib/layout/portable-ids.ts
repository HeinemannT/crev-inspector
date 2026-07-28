import { existingSupportCategory } from './flow';
import { walk } from './model';
import { formatEcLiteral, validateBusinessId } from '../ec-guards';
import type { LayoutIO } from './sync';
import type { FlowNode, LModel, LNode, PlanStep } from './types';

export interface PortableIdConfig {
  enabled: boolean;
  pattern: string;
}

export interface PortableIdRequest {
  key: string;
  base: string;
}

export type PortableIdPlan = Record<string, string>;

export const DEFAULT_PORTABLE_ID_PATTERN = '{page}_{parent}_{class}_{name}';
export const DEFAULT_PORTABLE_ID_CONFIG: PortableIdConfig = {
  enabled: false,
  pattern: DEFAULT_PORTABLE_ID_PATTERN,
};

export const PORTABLE_ID_TOKENS = ['page', 'parent', 'class', 'name'] as const;
export const SUPPORT_CATEGORY_KEY = '@support-category';
export const VIRTUAL_TABSET_KEY = '@virtual-tabset';

type Token = typeof PORTABLE_ID_TOKENS[number];
type TokenValues = Record<Token, string>;

const TOKEN_RE = /\{([a-z]+)\}/gi;
const KNOWN_TOKENS = new Set<string>(PORTABLE_ID_TOKENS);

/** BMP business IDs are case-insensitive and accept alphanumerics/underscores. Keep the output
 * deliberately boring so the same human text produces the same ID in every environment. */
export function portableIdSlug(value: string): string {
  return value
    .replace(/ß/g, 'ss')
    .replace(/&/g, ' and ')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
}

export function portableIdPatternError(pattern: string): string | null {
  if (!pattern.trim()) return 'Enter an ID pattern.';
  for (const match of pattern.matchAll(TOKEN_RE)) {
    if (!KNOWN_TOKENS.has(match[1].toLowerCase())) return `Unknown tag {${match[1]}}.`;
  }
  const bracesRemoved = pattern.replace(TOKEN_RE, '');
  if (/[{}]/.test(bracesRemoved)) return 'Tags must use matching braces.';
  if (![...pattern.matchAll(TOKEN_RE)].length) return 'Add at least one text tag.';
  return null;
}

export function renderPortableId(pattern: string, values: TokenValues): string {
  const error = portableIdPatternError(pattern);
  if (error) throw new Error(error);
  const expanded = pattern.replace(TOKEN_RE, (_whole, raw: string) => values[raw.toLowerCase() as Token]);
  return portableIdSlug(expanded) || 'object';
}

function nodeIndex(model: LModel): {
  nodes: Map<string, LNode>;
  parents: Map<string, LNode>;
} {
  const nodes = new Map<string, LNode>();
  const parents = new Map<string, LNode>();
  walk(model, (node, parent) => {
    nodes.set(node.id, node);
    if (parent) parents.set(node.id, parent);
  });
  return { nodes, parents };
}

/** Build one semantic base ID for every object Blueprint will create, including the implicit support
 * Category and virtual TabSet. Names come from the CURRENT staged model, so renaming "New Tab" before
 * Apply changes its generated ID without ever rewriting an existing object's ID. */
export function portableIdRequests(
  plan: PlanStep[],
  model: LModel,
  pattern: string,
): PortableIdRequest[] {
  const page = model.pageName || model.pageId;
  const { nodes, parents } = nodeIndex(model);
  const flowNodes = new Map<string, { name: string; className: string }>();
  const addFlow = (items: FlowNode[]): void => {
    for (const item of items) {
      flowNodes.set(item.id, item);
      if (item.children) addFlow(item.children);
    }
  };
  Object.values(model.flows ?? {}).forEach(flow => addFlow(flow.children));
  Object.values(model.flowEdits ?? {}).forEach(edit => { if (edit.adds) addFlow(edit.adds); });

  const requests: PortableIdRequest[] = [];
  const make = (
    key: string,
    className: string,
    name: string,
    parentName: string,
  ): void => {
    requests.push({
      key,
      base: renderPortableId(pattern, {
        page,
        parent: parentName || page,
        class: className,
        name,
      }),
    });
  };

  const createsSupportObject = plan.some(step =>
    (step.kind === 'flowCreate' && step.parentId === '*support*')
    || (step.kind === 'create' && step.node.kind === 'tab' && model.tabsetVirtual),
  );
  const existingCategory = existingSupportCategory(model);
  const supportName = existingCategory?.name ?? page;
  if (createsSupportObject && !existingCategory) {
    make(SUPPORT_CATEGORY_KEY, 'Category', supportName, 'Portal');
  }
  if (plan.some(step => step.kind === 'create' && step.node.kind === 'tab') && model.tabsetVirtual) {
    make(VIRTUAL_TABSET_KEY, 'TabSet', model.tabsetName ?? 'New TabSet', supportName);
  }

  for (const step of plan) {
    if (step.kind === 'create') {
      const parent = parents.get(step.node.id) ?? nodes.get(step.parentId);
      const tabset = step.node.kind === 'tab'
        ? model.tabsets?.find(item => item.id === step.parentId)
        : undefined;
      make(step.node.id, step.node.className, step.node.name, tabset?.name ?? parent?.name ?? page);
    } else if (step.kind === 'flowCreate') {
      const parent = flowNodes.get(step.parentId) ?? nodes.get(step.parentId);
      const parentName = step.parentId === '*support*'
        ? supportName
        : step.parentId === '*page*'
          ? page
          : parent?.name ?? step.parentClass;
      make(step.node.id, step.node.className, step.node.name, parentName);
    }
  }
  return requests;
}

export function suffixedPortableId(base: string, suffix: number): string {
  return suffix <= 1 ? base : `${base}_${suffix}`;
}

/** Deterministic local resolver used by tests and by callers once live occupied IDs are known. */
export function resolvePortableIdPlan(
  requests: PortableIdRequest[],
  occupiedIds: Iterable<string>,
): PortableIdPlan {
  const used = new Set([...occupiedIds].map(id => id.toLowerCase()));
  const result: PortableIdPlan = {};
  for (const request of requests) {
    let suffix = 1;
    let candidate = request.base;
    while (used.has(candidate.toLowerCase())) {
      suffix += 1;
      candidate = suffixedPortableId(request.base, suffix);
    }
    used.add(candidate.toLowerCase());
    result[request.key] = candidate;
  }
  return result;
}

export function portableIdExample(pattern: string, pageName = 'Risk register'): string {
  try {
    return renderPortableId(pattern, {
      page: pageName,
      parent: 'Overview',
      class: 'TextElement',
      name: 'Risk summary',
    });
  } catch {
    return '';
  }
}

const OCCUPIED_MARKER = '<PORTABLE_ID>';

/** One lean read checks every proposed ID in the shared template-category namespace. Dynamic
 * `t.get(_id)` is live-verified on Steadfast; numeric-looking IDs remain quoted text. */
export function buildPortableIdOccupancyEc(ids: readonly string[]): string {
  const unique = [...new Set(ids.map(validateBusinessId))];
  if (!unique.length) return '""';
  const items = unique.map(id => `"${formatEcLiteral(id)}"`).join(', ');
  return [
    `_ids := LIST(${items})`,
    `_out := ""`,
    `_ids.forEach(_id:`,
    `     _rid := t.get(_id).rid.whenMissing("")`,
    `     _out := _out + "${OCCUPIED_MARKER}" + _id + "|" + _rid + "\\n"`,
    `)`,
    `_out`,
  ].join('\n');
}

export function parseOccupiedPortableIds(log: string): Set<string> {
  const found = new Set<string>();
  const pattern = /<PORTABLE_ID>([A-Za-z0-9_]+)\|([^\r\n]*)/g;
  for (const match of log.matchAll(pattern)) {
    if (match[2].trim()) found.add(match[1].toLowerCase());
  }
  return found;
}

/** Resolve collisions against live BMP state and against earlier objects in the same Apply batch.
 * Usually one read is enough; a collision adds a suffix and performs one more batched read. */
export async function preflightPortableIdRequests(
  io: LayoutIO,
  requests: PortableIdRequest[],
): Promise<PortableIdPlan> {
  const pending = requests.map(request => ({ ...request, suffix: 1 }));
  const used = new Set<string>();
  const result: PortableIdPlan = {};
  for (let round = 0; pending.length && round < 100; round += 1) {
    const candidates = pending.map(item => suffixedPortableId(item.base, item.suffix));
    const response = await io.exec(buildPortableIdOccupancyEc(candidates));
    if (!response.ok) throw new Error(response.error || 'Could not check generated IDs.');
    const occupied = parseOccupiedPortableIds(response.log ?? '');
    const retry: typeof pending = [];
    for (const item of pending) {
      const candidate = suffixedPortableId(item.base, item.suffix);
      const key = candidate.toLowerCase();
      if (occupied.has(key) || used.has(key)) {
        retry.push({ ...item, suffix: item.suffix + 1 });
      } else {
        used.add(key);
        result[item.key] = candidate;
      }
    }
    pending.splice(0, pending.length, ...retry);
  }
  if (pending.length) throw new Error('Could not find a free generated ID after 100 attempts.');
  return result;
}

/** Recheck the exact previewed IDs immediately before commit. A collision appearing after preview
 * aborts safely instead of silently choosing a different ID than the user reviewed. */
export async function occupiedPortableIdPlan(
  io: LayoutIO,
  plan: PortableIdPlan,
): Promise<string[]> {
  const ids = Object.values(plan);
  if (!ids.length) return [];
  const response = await io.exec(buildPortableIdOccupancyEc(ids));
  if (!response.ok) throw new Error(response.error || 'Could not recheck generated IDs.');
  const occupied = parseOccupiedPortableIds(response.log ?? '');
  return ids.filter(id => occupied.has(id.toLowerCase()));
}
