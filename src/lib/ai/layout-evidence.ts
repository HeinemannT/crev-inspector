/**
 * Deep projection module for AI layout evidence.
 *
 * One loaded BMP layout serves two audiences without mixing their contracts:
 * the provider sees structural facts and the UI sees rich object identities.
 */

import type { LoadPageStructureResult } from '../layout-service';
import type { LNode } from '../layout/types';
import type { ObjectReference } from '../types';
import { codeFieldsFor } from '../widget-metadata';
import { toolSuccess, type ToolDataMap } from './tool-results';
import { TOOL_RESULT_CAP } from './tools';

const AI_LAYOUT_NODE_CAP = 50;

export interface AiLayoutEvidence {
  text: string;
  modelFacts: ToolDataMap['read_layout'];
  uiObjects: ObjectReference[];
}

interface ProjectableNode {
  node: LNode;
  depth: number;
  parentRid?: string;
  order: number;
}

function countNodes(nodes: readonly LNode[]): number {
  return nodes.reduce((total, node) => total + 1 + countNodes(node.children), 0);
}

function findNode(nodes: readonly LNode[], rid: string): LNode | undefined {
  for (const node of nodes) {
    if (node.rid === rid) return node;
    const nested = findNode(node.children, rid);
    if (nested) return nested;
  }
  return undefined;
}

function flattenRoot(root: LNode, nextOrder: () => number): ProjectableNode[] {
  const entries: ProjectableNode[] = [];
  const visit = (node: LNode, depth: number, parentRid?: string): void => {
    entries.push({ node, depth, ...(parentRid ? { parentRid } : {}), order: nextOrder() });
    for (const child of node.children) visit(child, depth + 1, node.rid ?? parentRid);
  };
  visit(root, 0);
  return entries;
}

function projectNode(entry: ProjectableNode): ToolDataMap['read_layout']['nodes'][number] {
  const { node } = entry;
  const codeSlots = node.kind === 'widget'
    ? codeFieldsFor(node.className).map(field => field.prop)
    : [];
  return {
    ...(node.rid ? { rid: node.rid } : {}),
    businessId: node.id,
    ...(entry.parentRid ? { parentRid: entry.parentRid } : {}),
    depth: entry.depth,
    kind: node.kind,
    type: node.className,
    name: node.name,
    columns: {
      large: node.cols.L,
      ...(node.cols.M !== undefined ? { medium: node.cols.M } : {}),
      ...(node.cols.S !== undefined ? { small: node.cols.S } : {}),
    },
    storage: node.kind === 'widget' ? 'page-child' : 'portal-shared',
    ...(node.tabsetId ? { tabsetBusinessId: node.tabsetId } : {}),
    codeSlots,
    ...(node.linkedTemplate ? { linkedTemplateRid: node.linkedTemplate.rid } : {}),
  };
}

function buildFacts(
  viewedRid: string,
  page: NonNullable<LoadPageStructureResult>,
  tabsets: ToolDataMap['read_layout']['tabsets'],
  totalNodes: number,
  nodes: ToolDataMap['read_layout']['nodes'],
  focusRid: string | undefined,
  focusFound: boolean,
): ToolDataMap['read_layout'] {
  const { ctx, load } = page;
  const returnedNodes = nodes.length;
  return {
    viewedRid,
    pageOwnerRid: ctx.pageRid,
    ...(load.model.templateRid ? { pageTemplateRid: load.model.templateRid } : {}),
    ...(focusRid ? { focusRid } : {}),
    focusFound,
    resultOnly: !!load.model.resultOnly,
    tabsets,
    totalNodes,
    returnedNodes,
    omittedNodes: Math.max(0, totalNodes - returnedNodes),
    sourceTruncated: !!load.truncated,
    orphanCount: load.orphans.length,
    complete: focusFound && returnedNodes >= totalNodes && !load.truncated,
    nodes,
  };
}

function serializedFactsLength(facts: ToolDataMap['read_layout']): number {
  return JSON.stringify(toolSuccess('read_layout', facts)).length;
}

/**
 * Project one loaded layout through the provider and UI channels.
 * The provider shape is measured exactly while nodes are selected.
 */
export function projectLayoutEvidence(
  viewedRid: string,
  page: NonNullable<LoadPageStructureResult>,
  focusRid?: string,
): AiLayoutEvidence {
  const { ctx, load } = page;
  const model = load.model;
  const tabsets = (model.tabsets?.length
    ? model.tabsets
    : [{ id: model.tabsetId, name: model.tabsetId }])
    .map(tabset => ({
      businessId: tabset.id,
      name: tabset.name,
      ...(tabset.rid ? { rid: tabset.rid } : {}),
    }));

  const uiObjects: ObjectReference[] = [{
    rid: ctx.pageRid,
    businessId: model.pageId,
    type: model.pageClass,
    name: model.pageName,
  }];
  if (model.templateRid) {
    uiObjects.push({
      rid: model.templateRid,
      businessId: model.templateId,
      type: model.pageClass,
    });
  }

  const focus = focusRid ? findNode(model.tabs, focusRid) : undefined;
  const focusFound = !focusRid || !!focus;
  const roots = focus ? [focus] : focusRid ? [] : model.tabs;
  const totalNodes = focusRid && !focus ? countNodes(model.tabs) : countNodes(roots);

  if (!focusFound) {
    const modelFacts = buildFacts(viewedRid, page, tabsets, totalNodes, [], focusRid, false);
    return {
      text: `Layout focus rid=${focusRid} was not found on viewed page rid=${viewedRid}.`,
      modelFacts,
      uiObjects,
    };
  }

  let order = 0;
  const nextOrder = (): number => order++;
  const rootEntries = roots.map(root => flattenRoot(root, nextOrder));
  const cursors = rootEntries.map(() => 0);
  const blocked = rootEntries.map(entries => entries.length === 0);
  const selected: ProjectableNode[] = [];

  while (selected.length < AI_LAYOUT_NODE_CAP && blocked.some(value => !value)) {
    let added = false;
    for (let index = 0; index < rootEntries.length && selected.length < AI_LAYOUT_NODE_CAP; index++) {
      if (blocked[index]) continue;
      const candidate = rootEntries[index][cursors[index]];
      if (!candidate) {
        blocked[index] = true;
        continue;
      }
      const candidateEntries = [...selected, candidate].sort((a, b) => a.order - b.order);
      const candidateNodes = candidateEntries.map(projectNode);
      const candidateFacts = buildFacts(
        viewedRid,
        page,
        tabsets,
        totalNodes,
        candidateNodes,
        focusRid,
        true,
      );
      if (serializedFactsLength(candidateFacts) > TOOL_RESULT_CAP) {
        blocked[index] = true;
        continue;
      }
      selected.push(candidate);
      cursors[index] += 1;
      if (cursors[index] >= rootEntries[index].length) blocked[index] = true;
      added = true;
    }
    if (!added) break;
  }

  selected.sort((a, b) => a.order - b.order);
  const projectedNodes = selected.map(projectNode);
  const modelFacts = buildFacts(
    viewedRid,
    page,
    tabsets,
    totalNodes,
    projectedNodes,
    focusRid,
    true,
  );
  for (const entry of selected) {
    const { node } = entry;
    if (!node.rid) continue;
    uiObjects.push({
      rid: node.rid,
      businessId: node.id,
      type: node.className,
      name: node.name,
    });
    if (node.linkedTemplate) {
      uiObjects.push({
        rid: node.linkedTemplate.rid,
        businessId: node.linkedTemplate.id,
        type: node.linkedTemplate.className,
        name: node.linkedTemplate.name,
      });
    }
  }

  const lines = [
    `Viewed rid=${viewedRid}`,
    `Effective page owner: ${model.pageName || model.pageId} (${model.pageClass}) bid=${model.pageId} rid=${ctx.pageRid}`,
    `Contributing TabSets: ${tabsets.map(tabset => `${tabset.name} [${tabset.businessId}]`).join(', ')}`,
    `Layout: ${countNodes(model.tabs)} total node(s)${model.resultOnly ? ' on the shared Result tab' : ''}${focus ? `; focused subtree rid=${focus.rid} has ${totalNodes}` : ''}.`,
  ];
  for (const node of projectedNodes) {
    const widths = [
      `L=${node.columns.large}`,
      ...(node.columns.medium !== undefined ? [`M=${node.columns.medium}`] : []),
      ...(node.columns.small !== undefined ? [`S=${node.columns.small}`] : []),
    ].join('/');
    lines.push(
      `${'  '.repeat(node.depth + 1)}${node.type} "${node.name}" bid=${node.businessId}`
      + `${node.rid ? ` rid=${node.rid}` : ''}`
      + `${node.parentRid ? ` parentRid=${node.parentRid}` : ''}`
      + ` columns=${widths} storage=${node.storage}`
      + `${node.tabsetBusinessId ? ` tabset=${node.tabsetBusinessId}` : ''}`
      + `${node.codeSlots.length ? ` code=${node.codeSlots.join(',')}` : ''}`,
    );
  }
  if (modelFacts.omittedNodes > 0) {
    lines.push(
      `Showing ${modelFacts.returnedNodes} of ${modelFacts.totalNodes} node(s) in this scope; `
      + `${modelFacts.omittedNodes} omitted. Call read_layout again with pageRid="${viewedRid}" `
      + 'and focusRid="<returned rid>" to inspect one subtree.',
    );
  }
  if (load.truncated) {
    lines.push('The source read reached its safety limit. No widget-owned rows or later page nodes were loaded.');
  }
  if (load.orphans.length) lines.push(`Orphan widgets without a container: ${load.orphans.length}.`);
  if (modelFacts.complete) lines.push('Layout discovery is complete.');

  return {
    text: lines.join('\n'),
    modelFacts,
    uiObjects,
  };
}
