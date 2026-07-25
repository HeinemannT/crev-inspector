import type { FlowNode } from '../lib/layout/types';

export interface EditPageStep {
  key: string;
  title: string;
  breakNode?: FlowNode;
  columns: FlowNode[][];
}

/** Project BMP's flat EditPage child order into its rendered page/column structure in one pass. */
export function projectEditPage(children: readonly FlowNode[]): EditPageStep[] {
  const steps: EditPageStep[] = [];
  let step: EditPageStep = { key: 'implicit', title: 'Page 1', columns: [[]] };
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
        columns: [[]],
      };
      hasContent = false;
    } else if (child.className === 'EditPageColumnBreak') {
      step.columns.push([]);
      step.columns[step.columns.length - 1].push(child);
      hasContent = true;
    } else {
      step.columns[step.columns.length - 1].push(child);
      hasContent = true;
    }
  }
  push();
  return steps;
}

