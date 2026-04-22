import { isRecord } from "../parsers";
import { normalizeWorkflowRules } from "./normalize";
import { toFiniteNumber, toPositiveInteger } from "./shared";
import type {
  DerivedWorkflowWidgetInput,
  DualSamplerDenoiseDerivedWidgetInput,
  SingleSamplerDenoiseDerivedWidgetInput,
  VideoAudioRetakeDerivedWidgetInput,
  VideoAudioRetakeMode,
  WidgetInputConfig,
  WorkflowWidgetInput,
} from "../../types";
import type {
  WorkflowDualSamplerDenoiseRule,
  WorkflowFrontendControl,
  WorkflowParamReference,
  WorkflowRules,
  WorkflowSingleSamplerDenoiseRule,
  WorkflowVideoAudioRetakeRule,
} from "./types";

const DERIVED_WIDGET_NODE_ID_PREFIX = "derived:";
const DERIVED_WIDGET_VALUE_PARAM = "__value";
const FRONTEND_CONTROLS_NODE_ID = "__frontend_controls__";
const FRONTEND_CONTROLS_NODE_TITLE = "Workflow Controls";

function getWorkflowParamValue(
  workflow: Record<string, unknown>,
  ref: WorkflowParamReference,
): unknown {
  const node = workflow[ref.node_id];
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

function toOptionalString(value: string | null | undefined): string | undefined {
  return value ?? undefined;
}

function toOptionalNumber(value: number | null | undefined): number | undefined {
  return value ?? undefined;
}

function toOptionalBoolean(
  value: boolean | null | undefined,
): boolean | undefined {
  return value ?? undefined;
}

function valuesMatch(left: unknown, right: unknown): boolean {
  return Object.is(left, right);
}

function mapStoredWidgetValue(
  value: unknown,
  config: Pick<WidgetInputConfig, "valueType" | "trueValue" | "falseValue">,
): unknown {
  if (config.valueType !== "boolean") {
    return value;
  }
  if (config.trueValue !== undefined && valuesMatch(value, config.trueValue)) {
    return true;
  }
  if (config.falseValue !== undefined && valuesMatch(value, config.falseValue)) {
    return false;
  }
  return value;
}

function hasOwnKey(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function resolveDualSamplerDenoiseWidget(
  workflow: Record<string, unknown>,
  rule: WorkflowDualSamplerDenoiseRule,
): DualSamplerDenoiseDerivedWidgetInput | null {
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
      sliderDisplay: "percent",
      valueType: "float",
      groupId: toOptionalString(rule.group_id),
      groupTitle:
        toOptionalString(rule.group_title) ?? rule.label ?? "Denoise",
      groupOrder: toOptionalNumber(rule.group_order),
    },
  };
}

function resolveSingleSamplerDenoiseWidget(
  workflow: Record<string, unknown>,
  rule: WorkflowSingleSamplerDenoiseRule,
): SingleSamplerDenoiseDerivedWidgetInput | null {
  const totalSteps = toPositiveInteger(
    getWorkflowParamNumber(workflow, rule.total_steps),
  );
  const startStep = getWorkflowParamNumber(workflow, rule.start_step);

  if (totalSteps === null || startStep === null) {
    console.warn(
      "[resolveWidgetInputs] Skipping derived widget '%s': missing numeric workflow params",
      rule.id,
    );
    return null;
  }

  const normalizedStartStep = Math.min(
    Math.max(0, Math.round(startStep)),
    totalSteps,
  );
  const denoiseSteps = Math.min(
    totalSteps,
    Math.max(0, totalSteps - normalizedStartStep),
  );
  const step = 1 / totalSteps;
  const currentValue = denoiseSteps / totalSteps;

  return {
    kind: "derived",
    deriveKind: "single_sampler_denoise",
    derivedWidgetId: rule.id,
    nodeId: getDerivedWidgetNodeId(rule.id),
    param: DERIVED_WIDGET_VALUE_PARAM,
    currentValue,
    sources: {
      totalSteps,
      startStep: normalizedStartStep,
    },
    config: {
      label: rule.label ?? "Denoise",
      controlAfterGenerate: false,
      frontendOnly: true,
      min: 0,
      max: 1,
      step,
      control: "slider",
      sliderDisplay: "percent",
      valueType: "float",
      groupId: toOptionalString(rule.group_id),
      groupTitle:
        toOptionalString(rule.group_title) ?? rule.label ?? "Denoise",
      groupOrder: toOptionalNumber(rule.group_order),
    },
  };
}

const VIDEO_AUDIO_RETAKE_OPTIONS: VideoAudioRetakeMode[] = [
  "Video & Audio",
  "Video",
  "Audio",
];

function toBooleanParamValue(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

function resolveVideoAudioRetakeWidget(
  workflow: Record<string, unknown>,
  rule: WorkflowVideoAudioRetakeRule,
): VideoAudioRetakeDerivedWidgetInput | null {
  const videoBypassRaw = getWorkflowParamValue(workflow, rule.video_bypass);
  const audioBypassRaw = getWorkflowParamValue(workflow, rule.audio_bypass);
  const videoBypass = toBooleanParamValue(videoBypassRaw);
  const audioBypass = toBooleanParamValue(audioBypassRaw);

  const defaultMode: VideoAudioRetakeMode = rule.default ?? "Video & Audio";
  let currentValue: VideoAudioRetakeMode = defaultMode;
  if (videoBypass !== null && audioBypass !== null) {
    if (!videoBypass && !audioBypass) currentValue = "Video & Audio";
    else if (!videoBypass && audioBypass) currentValue = "Video";
    else if (videoBypass && !audioBypass) currentValue = "Audio";
    else currentValue = defaultMode;
  }

  return {
    kind: "derived",
    deriveKind: "video_audio_retake",
    derivedWidgetId: rule.id,
    nodeId: getDerivedWidgetNodeId(rule.id),
    param: DERIVED_WIDGET_VALUE_PARAM,
    currentValue,
    sources: {
      videoBypass: videoBypass ?? false,
      audioBypass: audioBypass ?? false,
    },
    config: {
      label: rule.label ?? "Retake",
      controlAfterGenerate: false,
      frontendOnly: true,
      valueType: "enum",
      options: [...VIDEO_AUDIO_RETAKE_OPTIONS],
      defaultValue: defaultMode,
      groupId: toOptionalString(rule.group_id),
      groupTitle: toOptionalString(rule.group_title) ?? rule.label ?? "Retake",
      groupOrder: toOptionalNumber(rule.group_order),
    },
  };
}

function resolveDerivedWidgetInputs(
  workflow: Record<string, unknown>,
  rules: WorkflowRules,
): WorkflowWidgetInput[] {
  const result: WorkflowWidgetInput[] = [];
  for (const rule of rules.derived_widgets ?? []) {
    let widget: DerivedWorkflowWidgetInput | null = null;
    if (rule.kind === "dual_sampler_denoise") {
      widget = resolveDualSamplerDenoiseWidget(workflow, rule);
    } else if (rule.kind === "single_sampler_denoise") {
      widget = resolveSingleSamplerDenoiseWidget(workflow, rule);
    } else if (rule.kind === "video_audio_retake") {
      widget = resolveVideoAudioRetakeWidget(workflow, rule);
    }
    if (widget) {
      result.push(widget);
    }
  }
  return result;
}

function resolveFrontendControlInput(
  controlId: string,
  entry: WorkflowFrontendControl,
): WorkflowWidgetInput {
  const config: WidgetInputConfig = {
    label: entry.label ?? controlId,
    controlAfterGenerate: entry.control_after_generate ?? false,
    defaultRandomize: toOptionalBoolean(entry.default_randomize),
    frontendOnly: true,
    hidden: toOptionalBoolean(entry.hidden),
    groupId: toOptionalString(entry.group_id),
    groupTitle: toOptionalString(entry.group_title),
    groupOrder: toOptionalNumber(entry.group_order),
    control: entry.control ?? undefined,
    min: toOptionalNumber(entry.min),
    max: toOptionalNumber(entry.max),
    step: toOptionalNumber(entry.step),
    defaultValue: entry.default,
    trueValue: entry.true_value,
    falseValue: entry.false_value,
    sliderDisplay: entry.slider_display ?? undefined,
    unit: toOptionalString(entry.unit),
    nodeTitle: FRONTEND_CONTROLS_NODE_TITLE,
    valueType: entry.value_type ?? undefined,
    options: entry.options ?? undefined,
  };

  return {
    nodeId: FRONTEND_CONTROLS_NODE_ID,
    param: controlId,
    frontendControlId: controlId,
    config,
    currentValue: mapStoredWidgetValue(entry.default ?? null, config),
  };
}

function resolveFrontendControlInputs(rules: WorkflowRules): WorkflowWidgetInput[] {
  const result: WorkflowWidgetInput[] = [];
  for (const [controlId, entry] of Object.entries(rules.frontend_controls ?? {})) {
    result.push(resolveFrontendControlInput(controlId, entry));
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

  const ruleNodes = rules.nodes ?? {};
  const nodesWithWidgets = Object.entries(ruleNodes).filter(
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

  for (const [nodeId, nodeRule] of Object.entries(ruleNodes)) {
    if (nodeRule.ignore) continue;
    const widgetDefs = nodeRule.widgets;
    if (!widgetDefs) continue;

    const nodeData = workflow[nodeId];
    const nodeExists = isRecord(nodeData);
    if (!nodeExists) {
      console.debug(
        "[resolveWidgetInputs] Node %s has widget rules but is not in workflow (keys sample: %s)",
        nodeId,
        Object.keys(workflow).slice(0, 10),
      );
    }
    const nodeInputs =
      nodeExists && isRecord(nodeData.inputs) ? nodeData.inputs : {};

    for (const [param, entry] of Object.entries(widgetDefs)) {
      const hasExplicitDefault = Object.prototype.hasOwnProperty.call(
        entry,
        "default",
      );
      if (!nodeExists && !(entry.frontend_only === true && hasExplicitDefault)) {
        console.debug(
          "[resolveWidgetInputs] Skipping %s.%s: node is not present in workflow",
          nodeId,
          param,
        );
        continue;
      }

      const hasWorkflowParam = hasOwnKey(nodeInputs, param);
      if (!hasWorkflowParam && entry.frontend_only !== true && !hasExplicitDefault) {
        console.debug(
          "[resolveWidgetInputs] Skipping %s.%s: param is not present in workflow node inputs",
          nodeId,
          param,
        );
        continue;
      }

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
        defaultRandomize: toOptionalBoolean(entry.default_randomize),
        frontendOnly: toOptionalBoolean(entry.frontend_only),
        hidden: toOptionalBoolean(entry.hidden),
        groupId: toOptionalString(entry.group_id),
        groupTitle: toOptionalString(entry.group_title),
        groupOrder: toOptionalNumber(entry.group_order),
        control: entry.control ?? undefined,
        min: toOptionalNumber(entry.min),
        max: toOptionalNumber(entry.max),
        step: toOptionalNumber(entry.step),
        defaultValue: entry.default,
        trueValue: entry.true_value,
        falseValue: entry.false_value,
        sliderDisplay: entry.slider_display ?? undefined,
        unit: toOptionalString(entry.unit),
        nodeTitle: toOptionalString(nodeRule.node_title),
        valueType: entry.value_type ?? undefined,
        options: entry.options ?? undefined,
      };
      if (config.hidden) {
        continue;
      }

      rawWidgets.push({
        nodeId,
        param,
        config,
        currentValue: mapStoredWidgetValue(
          rawValue ?? config.defaultValue ?? null,
          config,
        ),
      });
    }
  }

  const frontendControls = resolveFrontendControlInputs(rules);
  const derivedWidgets = resolveDerivedWidgetInputs(workflow, rules);
  const result = [...frontendControls, ...rawWidgets, ...derivedWidgets];

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
