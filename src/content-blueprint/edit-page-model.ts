import type { FlowNode } from '../lib/layout/types';

export interface EditPageColumn {
  key: string;
  /** The flat-stream marker that starts this rendered column. The first column has none. */
  breakNode?: FlowNode;
  nodes: FlowNode[];
}

export interface EditPageStep {
  key: string;
  title: string;
  breakNode?: FlowNode;
  columns: EditPageColumn[];
}

/** Project BMP's flat EditPage child order into its rendered page/column structure in one pass. */
export function projectEditPage(children: readonly FlowNode[]): EditPageStep[] {
  const steps: EditPageStep[] = [];
  let step: EditPageStep = {
    key: 'implicit',
    title: 'Page 1',
    columns: [{ key: 'implicit:column:1', nodes: [] }],
  };
  let hasContent = false;

  const push = (): void => {
    if (hasContent || step.breakNode || steps.length === 0) steps.push(step);
  };

  for (const child of children) {
    if (child.className === 'EditPageBreak') {
      if (hasContent || step.breakNode) push();
      step = {
        key: child.id,
        title: child.name || `Page ${steps.length + 1}`,
        breakNode: child,
        columns: [{ key: `${child.id}:column:1`, nodes: [] }],
      };
      hasContent = false;
    } else if (child.className === 'EditPageColumnBreak') {
      step.columns.push({ key: child.id, breakNode: child, nodes: [] });
      hasContent = true;
    } else {
      step.columns[step.columns.length - 1].nodes.push(child);
      hasContent = true;
    }
  }
  push();
  return steps;
}
