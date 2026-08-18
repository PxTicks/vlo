import type { WorkflowWidgetInput } from "../types";

export function getNodeBypassWidgetKey(
  nodeId: string,
  param: string,
): string {
  return `${nodeId}\u0000${param}`;
}

export function isNodeBypassWidgetValue(
  widget: WorkflowWidgetInput,
  value: unknown,
): boolean {
  const bypassValue = widget.config.nodeBypassOption?.value;
  return bypassValue !== undefined && Object.is(value, bypassValue);
}

export interface NodeBypassWidgetPartition {
  readonly activeWidgetInputs: readonly WorkflowWidgetInput[];
  readonly bypassNodeIds: readonly string[];
}

export function partitionNodeBypassWidgetInputs(
  widgetInputs: readonly WorkflowWidgetInput[],
  bypassedWidgetTargets: ReadonlySet<string>,
): NodeBypassWidgetPartition {
  const nodeIds = new Set<string>();
  const activeWidgetInputs: WorkflowWidgetInput[] = [];
  for (const widget of widgetInputs) {
    if (
      widget.config.nodeBypassOption &&
      bypassedWidgetTargets.has(
        getNodeBypassWidgetKey(widget.nodeId, widget.param),
      )
    ) {
      nodeIds.add(widget.nodeId);
      continue;
    }
    activeWidgetInputs.push(widget);
  }
  return {
    activeWidgetInputs,
    bypassNodeIds: [...nodeIds],
  };
}
