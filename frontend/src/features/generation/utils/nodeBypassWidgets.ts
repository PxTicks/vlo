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
  /** Nodes shipping bypassed that this submission turns on. */
  readonly activateNodeIds: readonly string[];
}

/**
 * Partition widget writes from mode changes, accounting for the node's shipped
 * mode when deciding whether bypass or activation needs to be emitted.
 */
export function partitionNodeBypassWidgetInputs(
  widgetInputs: readonly WorkflowWidgetInput[],
  bypassedWidgetTargets: ReadonlySet<string>,
): NodeBypassWidgetPartition {
  const bypassNodeIds = new Set<string>();
  const activateNodeIds = new Set<string>();
  const activeWidgetInputs: WorkflowWidgetInput[] = [];
  for (const widget of widgetInputs) {
    if (!widget.config.nodeBypassOption) {
      activeWidgetInputs.push(widget);
      continue;
    }
    const shipsBypassed = widget.config.nodeShipsBypassed === true;
    if (
      bypassedWidgetTargets.has(
        getNodeBypassWidgetKey(widget.nodeId, widget.param),
      )
    ) {
      // A node already bypassed in the file needs no effect to stay off.
      if (!shipsBypassed) bypassNodeIds.add(widget.nodeId);
      continue;
    }
    if (shipsBypassed) activateNodeIds.add(widget.nodeId);
    activeWidgetInputs.push(widget);
  }
  return {
    activeWidgetInputs,
    bypassNodeIds: [...bypassNodeIds],
    activateNodeIds: [...activateNodeIds],
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
  /**
   * Whether each target's node shipped bypassed when last seen. A change means
   * the node was bypassed or turned on inside ComfyUI, and the panel follows
   * the workflow instead of a choice made against the node's old mode.
   * Omitted, modes are not tracked across passes.
   */
  readonly previousShippedBypass?: ReadonlyMap<string, boolean>;
  /**
   * Keep selections whose widget is absent from this pass, for the same
   * reason as widget values: a reload of the same workflow empties the widget
   * list for its duration, and the defaults already counted as applied would
   * not come back to restore what was dropped.
   */
  readonly preserveMissing?: boolean;
}

export interface NodeBypassTargetReconciliationResult {
  readonly targets: ReadonlySet<string>;
  readonly appliedDefaults: ReadonlySet<string>;
  readonly shippedBypass: ReadonlyMap<string, boolean>;
  readonly changed: boolean;
}

/**
 * Drop selections whose widget no longer offers a bypass choice, follow nodes
 * whose mode changed in the workflow, then apply any rule default that has not
 * been applied yet for this workflow.
 */
export function reconcileNodeBypassWidgetTargets({
  widgetInputs,
  previousTargets,
  appliedDefaults,
  previousShippedBypass,
  preserveMissing = false,
}: NodeBypassTargetReconciliationOptions): NodeBypassTargetReconciliationResult {
  const bypassableTargets = new Set<string>();
  const defaultTargets = new Set<string>();
  const shippedBypass = new Map<string, boolean>(
    preserveMissing && previousShippedBypass ? previousShippedBypass : [],
  );
  for (const widget of widgetInputs) {
    if (!widget.config.nodeBypassOption) continue;
    const key = getNodeBypassWidgetKey(widget.nodeId, widget.param);
    bypassableTargets.add(key);
    shippedBypass.set(key, widget.config.nodeShipsBypassed === true);
    if (widget.config.defaultNodeBypass) {
      defaultTargets.add(key);
    }
  }

  const targets = new Set<string>();
  for (const target of previousTargets) {
    if (preserveMissing || bypassableTargets.has(target)) {
      targets.add(target);
    }
  }

  let nextAppliedDefaults = appliedDefaults;
  const markDefaultApplied = (target: string) => {
    if (nextAppliedDefaults.has(target)) return;
    if (nextAppliedDefaults === appliedDefaults) {
      nextAppliedDefaults = new Set(appliedDefaults);
    }
    (nextAppliedDefaults as Set<string>).add(target);
  };

  // 1. A node bypassed or turned on in ComfyUI takes the workflow's state, as
  //    does one returning after it dropped out (muted, then unmuted): its old
  //    selection was dropped with it. Either way it counts as its default
  //    applied, so a later pass cannot layer the rule default back over what
  //    the user just did in the editor.
  for (const target of previousShippedBypass ? bypassableTargets : []) {
    const wasShippedBypassed = previousShippedBypass?.get(target);
    const shipsBypassed = shippedBypass.get(target);
    const flipped =
      wasShippedBypassed !== undefined && wasShippedBypassed !== shipsBypassed;
    const returned =
      wasShippedBypassed === undefined && appliedDefaults.has(target);
    if (!flipped && !returned) continue;
    if (shipsBypassed) targets.add(target);
    else targets.delete(target);
    markDefaultApplied(target);
  }

  // 2. Rule defaults, once per target for the mounted workflow.
  for (const target of defaultTargets) {
    if (nextAppliedDefaults.has(target)) continue;
    markDefaultApplied(target);
    targets.add(target);
  }

  const changed =
    targets.size !== previousTargets.size ||
    [...targets].some((target) => !previousTargets.has(target));

  return {
    targets: changed ? targets : previousTargets,
    appliedDefaults: nextAppliedDefaults,
    shippedBypass,
    changed,
  };
}
