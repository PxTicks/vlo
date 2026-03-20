import { isRecord } from "../parsers";
import { normalizeWorkflowRules } from "./normalize";
import { toFiniteNumber, toPositiveInteger } from "./shared";
import type {
  DerivedWorkflowWidgetInput,
  WidgetInputConfig,
  WorkflowParamReference,
  WorkflowWidgetInput,
} from "../../types";
import type {
  WorkflowDualSamplerDenoiseRule,
  WorkflowRules,
} from "./types";

const DERIVED_WIDGET_NODE_ID_PREFIX = "derived:";
const DERIVED_WIDGET_VALUE_PARAM = "__value";

function getWorkflowParamValue(
  workflow: Record<string, unknown>,
  ref: WorkflowParamReference,
): unknown {
  const node = workflow[ref.nodeId];
  if (!isRecord(node)) return null;
  const inputs = isRecord(node.inputs) ? node.inputs : {};
  return inputs[ref.param];
}

function getWorkflowParamNumber(
  workflow: Record<string, unknown>,
  ref: WorkflowParamReference,
): number | null {
  return toFiniteNumber(getWorkflowParamValue(workflow, ref));
}

function getDerivedWidgetNodeId(derivedWidgetId: string): string {
  return `${DERIVED_WIDGET_NODE_ID_PREFIX}${derivedWidgetId}`;
}

function resolveDualSamplerDenoiseWidget(
  workflow: Record<string, unknown>,
  rule: WorkflowDualSamplerDenoiseRule,
): DerivedWorkflowWidgetInput | null {
  const totalSteps = toPositiveInteger(
    getWorkflowParamNumber(workflow, rule.total_steps),
  );
  const startStep = getWorkflowParamNumber(workflow, rule.start_step);
  const baseSplitStep = getWorkflowParamNumber(workflow, rule.base_split_step);

  if (
    totalSteps === null ||
    startStep === null ||
    baseSplitStep === null
  ) {
    console.warn(
      "[resolveWidgetInputs] Skipping derived widget '%s': missing numeric workflow params",
      rule.id,
    );
    return null;
  }

  const normalizedStartStep = Math.min(
    Math.max(0, Math.round(startStep)),
    totalSteps - 1,
  );
  const normalizedBaseSplitStep = Math.max(0, Math.round(baseSplitStep));
  const denoiseSteps = Math.min(
    totalSteps,
    Math.max(1, totalSteps - normalizedStartStep),
  );
  const step = 1 / totalSteps;
  const currentValue = denoiseSteps / totalSteps;

  return {
    kind: "derived",
    deriveKind: "dual_sampler_denoise",
    derivedWidgetId: rule.id,
    nodeId: getDerivedWidgetNodeId(rule.id),
    param: DERIVED_WIDGET_VALUE_PARAM,
    currentValue,
    sources: {
      totalSteps,
      startStep: normalizedStartStep,
      baseSplitStep: normalizedBaseSplitStep,
    },
    config: {
      label: rule.label ?? "Denoise",
      controlAfterGenerate: false,
      frontendOnly: true,
      min: step,
      max: 1,
      step,
      control: "slider",
      valueType: "float",
      groupId: rule.group_id,
      groupTitle: rule.group_title,
      groupOrder: rule.group_order,
    },
  };
}

function resolveDerivedWidgetInputs(
  workflow: Record<string, unknown>,
  rules: WorkflowRules,
): WorkflowWidgetInput[] {
  const result: WorkflowWidgetInput[] = [];
  for (const rule of rules.derived_widgets ?? []) {
    if (rule.kind !== "dual_sampler_denoise") continue;
    const widget = resolveDualSamplerDenoiseWidget(workflow, rule);
    if (widget) {
      result.push(widget);
    }
  }
  return result;
}

export function resolveWidgetInputsFromRules(
  workflow: Record<string, unknown> | null,
  rules: WorkflowRules,
): WorkflowWidgetInput[] {
  if (!workflow) {
    console.debug("[resolveWidgetInputs] No workflow provided");
    return [];
  }

  const nodesWithWidgets = Object.entries(rules.nodes).filter(
    ([, nodeRule]) => nodeRule.widgets && Object.keys(nodeRule.widgets).length > 0,
  );
  console.info(
    "[resolveWidgetInputs] Rules have %d nodes with widgets: %s",
    nodesWithWidgets.length,
    nodesWithWidgets.map(([id]) => id),
  );
  console.info(
    "[resolveWidgetInputs] Workflow has %d node IDs: %s",
    Object.keys(workflow).length,
    Object.keys(workflow).slice(0, 20),
  );

  const rawWidgets: WorkflowWidgetInput[] = [];

  for (const [nodeId, nodeRule] of Object.entries(rules.nodes)) {
    if (nodeRule.ignore) continue;
    const widgetDefs = nodeRule.widgets;
    if (!widgetDefs) continue;

    const nodeData = workflow[nodeId];
    if (!isRecord(nodeData)) {
      console.warn(
        "[resolveWidgetInputs] Node %s has widget rules but is not in workflow (keys sample: %s)",
        nodeId,
        Object.keys(workflow).slice(0, 10),
      );
      continue;
    }
    const nodeInputs = isRecord(nodeData.inputs) ? nodeData.inputs : {};

    for (const [param, entry] of Object.entries(widgetDefs)) {
      // Skip params whose value in the workflow is a link [nodeId, outputIndex]
      const rawValue = nodeInputs[param];
      if (Array.isArray(rawValue) && rawValue.length === 2) {
        console.debug(
          "[resolveWidgetInputs] Skipping %s.%s: value is a link",
          nodeId,
          param,
        );
        continue;
      }

      const config: WidgetInputConfig = {
        label: entry.label ?? param,
        controlAfterGenerate: entry.control_after_generate ?? false,
        defaultRandomize: entry.default_randomize,
        frontendOnly: entry.frontend_only,
        hidden: entry.hidden,
        groupId: entry.group_id,
        groupTitle: entry.group_title,
        groupOrder: entry.group_order,
        min: entry.min,
        max: entry.max,
        defaultValue: entry.default,
        nodeTitle: nodeRule.node_title,
        valueType: entry.value_type,
        options: entry.options,
      };
      if (config.hidden) {
        continue;
      }

      rawWidgets.push({
        nodeId,
        param,
        config,
        currentValue: rawValue ?? config.defaultValue ?? null,
      });
    }
  }

  const derivedWidgets = resolveDerivedWidgetInputs(workflow, rules);
  const result = [...rawWidgets, ...derivedWidgets];

  console.info("[resolveWidgetInputs] Resolved %d widget inputs", result.length);
  return result;
}

/**
 * Resolves widget inputs from the workflow and rules.
 *
 * Widget entries are populated by the backend via explicit .rules.json
 * sidecar files and/or auto-discovery from object_info (for any node
 * with control_after_generate inputs).
 */
export function resolveWidgetInputs(
  workflow: Record<string, unknown> | null,
  rawRules: unknown,
): WorkflowWidgetInput[] {
  const { rules } = normalizeWorkflowRules(rawRules);
  return resolveWidgetInputsFromRules(workflow, rules);
}
