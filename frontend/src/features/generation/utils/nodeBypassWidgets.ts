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

/**
 * Targets a sidecar asked to start bypassed (`default_node_bypass`). The flag
 * is inert on widgets the panel gives no bypass choice to.
 */
export function collectDefaultNodeBypassWidgetTargets(
  widgetInputs: readonly WorkflowWidgetInput[],
): ReadonlySet<string> {
  const targets = new Set<string>();
  for (const widget of widgetInputs) {
    if (widget.config.nodeBypassOption && widget.config.defaultNodeBypass) {
      targets.add(getNodeBypassWidgetKey(widget.nodeId, widget.param));
    }
  }
  return targets;
}

export interface NodeBypassTargetReconciliationOptions {
  readonly widgetInputs: readonly WorkflowWidgetInput[];
  readonly previousTargets: ReadonlySet<string>;
  /**
   * Targets whose rule default has already been applied for the mounted
   * workflow. Deliberately never pruned while the workflow stays mounted: the
   * widget list flips identity on unrelated re-renders, and re-applying a
   * default would silently undo a user who turned the loader back on.
   */
  readonly appliedDefaults: ReadonlySet<string>;
}

export interface NodeBypassTargetReconciliationResult {
  readonly targets: ReadonlySet<string>;
  readonly appliedDefaults: ReadonlySet<string>;
  readonly changed: boolean;
}

/**
 * Drop selections whose widget no longer offers a bypass choice, then apply
 * any rule default that has not been applied yet for this workflow.
 */
export function reconcileNodeBypassWidgetTargets({
  widgetInputs,
  previousTargets,
  appliedDefaults,
}: NodeBypassTargetReconciliationOptions): NodeBypassTargetReconciliationResult {
  const bypassableTargets = new Set<string>();
  const defaultTargets = new Set<string>();
  for (const widget of widgetInputs) {
    if (!widget.config.nodeBypassOption) continue;
    const key = getNodeBypassWidgetKey(widget.nodeId, widget.param);
    bypassableTargets.add(key);
    if (widget.config.defaultNodeBypass) {
      defaultTargets.add(key);
    }
  }

  const targets = new Set<string>();
  for (const target of previousTargets) {
    if (bypassableTargets.has(target)) {
      targets.add(target);
    }
  }

  let nextAppliedDefaults = appliedDefaults;
  for (const target of defaultTargets) {
    if (appliedDefaults.has(target)) continue;
    if (nextAppliedDefaults === appliedDefaults) {
      nextAppliedDefaults = new Set(appliedDefaults);
    }
    (nextAppliedDefaults as Set<string>).add(target);
    targets.add(target);
  }

  const changed =
    targets.size !== previousTargets.size ||
    [...targets].some((target) => !previousTargets.has(target));

  return {
    targets: changed ? targets : previousTargets,
    appliedDefaults: nextAppliedDefaults,
    changed,
  };
}
