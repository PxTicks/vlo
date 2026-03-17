import type {
  WorkflowMaskCroppingMode,
  WorkflowInput,
  WorkflowManualSlotSelectionConfig,
  WorkflowPostprocessingConfig,
  WorkflowRuleSlotInputType,
  WorkflowWidgetInput,
  WidgetInputConfig,
  WidgetValueType,
} from "../types";
import type {
  DerivedMaskMapping,
  DerivedMaskType,
} from "../pipeline/types";
import { isRecord } from "./parsers";

export interface WorkflowRuleWarning {
  code: string;
  message: string;
  node_id?: string;
  output_index?: number;
  details?: Record<string, unknown>;
}

export interface WorkflowRuleNodePresent {
  enabled?: boolean;
  required?: boolean;
  input_type?: string;
  param?: string;
  label?: string;
  class_type?: string;
}

export interface WorkflowInputCondition {
  kind: "at_least_one";
  inputs: string[];
  message?: string;
}

export interface WorkflowRuleWidgetEntry {
  label?: string;
  control_after_generate?: boolean;
  default_randomize?: boolean;
  frontend_only?: boolean;
  group_id?: string;
  group_title?: string;
  group_order?: number;
  min?: number;
  max?: number;
  default?: unknown;
  value_type?: WidgetValueType;
  options?: Array<string | number | boolean>;
}

export interface WorkflowRuleNode {
  ignore?: boolean;
  present?: WorkflowRuleNodePresent;
  widgets_mode?: "control_after_generate" | "all";
  widgets?: Record<string, WorkflowRuleWidgetEntry>;
  node_title?: string;
  selection?: WorkflowRuleSelectionConfig;
  binary_derived_mask_of?: string;
  soft_derived_mask_of?: string;
}

export interface WorkflowRuleSelectionConfig {
  export_fps?: number;
  frame_step?: number;
  max_frames?: number;
}

export interface WorkflowRuleSlot {
  input_type?: string;
  label?: string;
  param?: string;
  experimental?: boolean;
  export_fps?: number;
  frame_step?: number;
  max_frames?: number;
}

export interface WorkflowMaskCroppingConfig {
  mode: WorkflowMaskCroppingMode;
}

export const DEFAULT_WORKFLOW_POSTPROCESSING: WorkflowPostprocessingConfig = {
  mode: "auto",
  panel_preview: "raw_outputs",
  on_failure: "fallback_raw",
};

export const DEFAULT_WORKFLOW_MASK_CROPPING: WorkflowMaskCroppingConfig = {
  mode: "crop",
};
export const DEFAULT_GENERATION_TARGET_RESOLUTION = 1080;
export const DEFAULT_GENERATION_RESOLUTION_OPTIONS = [
  360,
  480,
  720,
  1080,
] as const;

export interface WorkflowAspectRatioProcessingConfig {
  enabled: boolean;
  stride: number;
  search_steps: number;
  resolutions: number[];
  target_nodes: Array<{
    node_id: string;
    width_param: string;
    height_param: string;
  }>;
  postprocess: {
    enabled: boolean;
    mode: string;
    apply_to: string;
  };
}

export interface WorkflowRules {
  version: number;
  nodes: Record<string, WorkflowRuleNode>;
  input_conditions?: WorkflowInputCondition[];
  output_injections: Record<
    string,
    Record<
      string,
      {
        source?: {
          kind?: string;
          node_id?: string;
          output_index?: number;
          slot_id?: string;
        };
      }
    >
  >;
  slots: Record<string, WorkflowRuleSlot>;
  mask_cropping: WorkflowMaskCroppingConfig;
  postprocessing: WorkflowPostprocessingConfig;
  aspect_ratio_processing?: WorkflowAspectRatioProcessingConfig;
}

export interface WorkflowRulesResponse {
  workflow_id: string;
  rules: WorkflowRules;
  warnings: WorkflowRuleWarning[];
}

export interface ResolvePresentedInputsResult {
  inputs: WorkflowInput[];
  widgetInputs: WorkflowWidgetInput[];
  hasInferredInputs: boolean;
  presentationWarnings: WorkflowRuleWarning[];
  derivedMaskMappings: DerivedMaskMapping[];
}

export type { DerivedMaskMapping, DerivedMaskType };

function toStringRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function toRulesWarning(
  code: string,
  message: string,
  nodeId?: string,
): WorkflowRuleWarning {
  return nodeId ? { code, message, node_id: nodeId } : { code, message };
}

function toPositiveInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const normalized = Math.round(value);
  return normalized > 0 ? normalized : null;
}

export function getSupportedWorkflowResolutions(
  rules: WorkflowRules | null | undefined,
): number[] {
  const rawResolutions = rules?.aspect_ratio_processing;
  if (!rawResolutions?.enabled) return [];

  const seen = new Set<number>();
  const supported: number[] = [];
  for (const resolution of rawResolutions.resolutions) {
    const normalized = toPositiveInteger(resolution);
    if (normalized === null || seen.has(normalized)) continue;
    seen.add(normalized);
    supported.push(normalized);
  }
  return supported;
}

export function getClosestWorkflowResolution(
  targetResolution: number,
  supportedResolutions: readonly number[],
): number {
  const normalizedTarget = toPositiveInteger(targetResolution);
  if (supportedResolutions.length === 0 || normalizedTarget === null) {
    return targetResolution;
  }

  let closest = supportedResolutions[0];
  let closestDistance = Math.abs(closest - normalizedTarget);
  for (const resolution of supportedResolutions.slice(1)) {
    const distance = Math.abs(resolution - normalizedTarget);
    if (distance < closestDistance) {
      closest = resolution;
      closestDistance = distance;
    }
  }

  return closest;
}

export function isWorkflowInputRequired(
  rules: WorkflowRules | null | undefined,
  inputId: string,
): boolean {
  return rules?.nodes[inputId]?.present?.required !== false;
}

export function findUnsatisfiedInputConditions(
  rules: WorkflowRules | null | undefined,
  providedInputIds: ReadonlySet<string>,
): WorkflowInputCondition[] {
  const conditions = rules?.input_conditions;
  if (!conditions || conditions.length === 0) {
    return [];
  }

  return conditions.filter((condition) => {
    if (condition.kind !== "at_least_one") {
      return false;
    }
    return !condition.inputs.some((inputId) => providedInputIds.has(inputId));
  });
}

export function areInputConditionsSatisfied(
  rules: WorkflowRules | null | undefined,
  providedInputIds: ReadonlySet<string>,
): boolean {
  return findUnsatisfiedInputConditions(rules, providedInputIds).length === 0;
}

const SUPPORTED_WIDGET_VALUE_TYPES: readonly WidgetValueType[] = [
  "int",
  "float",
  "string",
  "boolean",
  "enum",
  "unknown",
];

function toWidgetValueType(value: unknown): WidgetValueType | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase() as WidgetValueType;
  return SUPPORTED_WIDGET_VALUE_TYPES.includes(normalized)
    ? normalized
    : undefined;
}

function toWidgetOptions(
  value: unknown,
): Array<string | number | boolean> | undefined {
  if (!Array.isArray(value)) return undefined;
  const options = value.filter(
    (item): item is string | number | boolean =>
      typeof item === "string" ||
      typeof item === "number" ||
      typeof item === "boolean",
  );
  return options.length > 0 ? options : undefined;
}

export function normalizeWorkflowRules(rawRules: unknown): {
  rules: WorkflowRules;
  warnings: WorkflowRuleWarning[];
} {
  const warnings: WorkflowRuleWarning[] = [];
  const raw = toStringRecord(rawRules);

  const versionValue = raw.version;
  const version = typeof versionValue === "number" ? versionValue : 1;
  if (versionValue !== undefined && typeof versionValue !== "number") {
    warnings.push(
      toRulesWarning(
        "invalid_rules_version",
        "Rules version is invalid; falling back to version 1",
      ),
    );
  }

  const rawNodes = toStringRecord(raw.nodes);
  const nodes: Record<string, WorkflowRuleNode> = {};
  for (const [nodeId, nodeRuleUnknown] of Object.entries(rawNodes)) {
    if (!isRecord(nodeRuleUnknown)) {
      warnings.push(
        toRulesWarning(
          "invalid_node_rule",
          "Node rule must be an object",
          nodeId,
        ),
      );
      continue;
    }
    const nodeRule: WorkflowRuleNode = {};
    if ("ignore" in nodeRuleUnknown) {
      nodeRule.ignore = Boolean(nodeRuleUnknown.ignore);
    }
    if (
      nodeRuleUnknown.widgets_mode === "control_after_generate" ||
      nodeRuleUnknown.widgets_mode === "all"
    ) {
      nodeRule.widgets_mode = nodeRuleUnknown.widgets_mode;
    }
    if (isRecord(nodeRuleUnknown.present)) {
      const present: WorkflowRuleNodePresent = {};
      if ("enabled" in nodeRuleUnknown.present) {
        present.enabled = Boolean(nodeRuleUnknown.present.enabled);
      }
      if ("required" in nodeRuleUnknown.present) {
        present.required = Boolean(nodeRuleUnknown.present.required);
      }
      if (typeof nodeRuleUnknown.present.input_type === "string") {
        present.input_type = nodeRuleUnknown.present.input_type;
      }
      if (typeof nodeRuleUnknown.present.param === "string") {
        present.param = nodeRuleUnknown.present.param;
      }
      if (typeof nodeRuleUnknown.present.label === "string") {
        present.label = nodeRuleUnknown.present.label;
      }
      if (typeof nodeRuleUnknown.present.class_type === "string") {
        present.class_type = nodeRuleUnknown.present.class_type;
      }
      nodeRule.present = present;
    }
    if (isRecord(nodeRuleUnknown.widgets)) {
      const widgets: Record<string, WorkflowRuleWidgetEntry> = {};
      for (const [wName, wRaw] of Object.entries(nodeRuleUnknown.widgets)) {
        if (!isRecord(wRaw)) continue;
        const entry: WorkflowRuleWidgetEntry = {};
        if (typeof wRaw.label === "string") entry.label = wRaw.label;
        if (typeof wRaw.control_after_generate === "boolean") {
          entry.control_after_generate = wRaw.control_after_generate;
        }
        if (typeof wRaw.default_randomize === "boolean") {
          entry.default_randomize = wRaw.default_randomize;
        }
        if (typeof wRaw.frontend_only === "boolean") {
          entry.frontend_only = wRaw.frontend_only;
        }
        if (typeof wRaw.group_id === "string") {
          const groupId = wRaw.group_id.trim();
          if (groupId.length > 0) entry.group_id = groupId;
        }
        if (typeof wRaw.group_title === "string") {
          const groupTitle = wRaw.group_title.trim();
          if (groupTitle.length > 0) entry.group_title = groupTitle;
        }
        if (typeof wRaw.group_order === "number" && wRaw.group_order >= 0) {
          entry.group_order = Math.floor(wRaw.group_order);
        }
        if (typeof wRaw.min === "number") entry.min = wRaw.min;
        if (typeof wRaw.max === "number") entry.max = wRaw.max;
        if ("default" in wRaw) entry.default = wRaw.default;
        const valueType = toWidgetValueType(wRaw.value_type);
        if (valueType) entry.value_type = valueType;
        const options = toWidgetOptions(wRaw.options);
        if (options) entry.options = options;
        widgets[wName] = entry;
      }
      if (Object.keys(widgets).length > 0) {
        nodeRule.widgets = widgets;
      }
    }
    if (typeof nodeRuleUnknown.node_title === "string") {
      nodeRule.node_title = nodeRuleUnknown.node_title;
    }
    if (isRecord(nodeRuleUnknown.selection)) {
      const selection: WorkflowRuleSelectionConfig = {};
      const exportFps = toPositiveInteger(nodeRuleUnknown.selection.export_fps);
      if (exportFps !== null) {
        selection.export_fps = exportFps;
      } else if (nodeRuleUnknown.selection.export_fps !== undefined) {
        warnings.push(
          toRulesWarning(
            "invalid_node_selection_export_fps",
            `Node '${nodeId}' has invalid selection.export_fps`,
            nodeId,
          ),
        );
      }

      const frameStep = toPositiveInteger(nodeRuleUnknown.selection.frame_step);
      if (frameStep !== null) {
        selection.frame_step = frameStep;
      } else if (nodeRuleUnknown.selection.frame_step !== undefined) {
        warnings.push(
          toRulesWarning(
            "invalid_node_selection_frame_step",
            `Node '${nodeId}' has invalid selection.frame_step`,
            nodeId,
          ),
        );
      }

      const maxFrames = toPositiveInteger(nodeRuleUnknown.selection.max_frames);
      if (maxFrames !== null) {
        selection.max_frames = maxFrames;
      } else if (nodeRuleUnknown.selection.max_frames !== undefined) {
        warnings.push(
          toRulesWarning(
            "invalid_node_selection_max_frames",
            `Node '${nodeId}' has invalid selection.max_frames`,
            nodeId,
          ),
        );
      }

      if (Object.keys(selection).length > 0) {
        nodeRule.selection = selection;
      }
    }
    if (typeof nodeRuleUnknown.binary_derived_mask_of === "string") {
      nodeRule.binary_derived_mask_of = nodeRuleUnknown.binary_derived_mask_of;
    }
    if (typeof nodeRuleUnknown.soft_derived_mask_of === "string") {
      nodeRule.soft_derived_mask_of = nodeRuleUnknown.soft_derived_mask_of;
    }
    nodes[nodeId] = nodeRule;
  }

  const rawSlots = toStringRecord(raw.slots);
  const slots: Record<string, WorkflowRuleSlot> = {};
  for (const [slotId, rawSlotUnknown] of Object.entries(rawSlots)) {
    if (!isRecord(rawSlotUnknown)) {
      warnings.push(
        toRulesWarning(
          "invalid_slot_rule",
          "Slot rule must be an object",
          slotId,
        ),
      );
      continue;
    }

    const slotRule: WorkflowRuleSlot = {};
    if (typeof rawSlotUnknown.input_type === "string") {
      slotRule.input_type = rawSlotUnknown.input_type;
    }
    if (typeof rawSlotUnknown.label === "string") {
      slotRule.label = rawSlotUnknown.label;
    }
    if (typeof rawSlotUnknown.param === "string") {
      slotRule.param = rawSlotUnknown.param;
    }
    if ("experimental" in rawSlotUnknown) {
      slotRule.experimental = Boolean(rawSlotUnknown.experimental);
    }

    const exportFps = toPositiveInteger(rawSlotUnknown.export_fps);
    if (exportFps !== null) {
      slotRule.export_fps = exportFps;
    } else if (rawSlotUnknown.export_fps !== undefined) {
      warnings.push(
        toRulesWarning(
          "invalid_slot_export_fps",
          `Slot '${slotId}' has invalid export_fps`,
        ),
      );
    }

    const frameStep = toPositiveInteger(rawSlotUnknown.frame_step);
    if (frameStep !== null) {
      slotRule.frame_step = frameStep;
    } else if (rawSlotUnknown.frame_step !== undefined) {
      warnings.push(
        toRulesWarning(
          "invalid_slot_frame_step",
          `Slot '${slotId}' has invalid frame_step`,
        ),
      );
    }

    const maxFrames = toPositiveInteger(rawSlotUnknown.max_frames);
    if (maxFrames !== null) {
      slotRule.max_frames = maxFrames;
    } else if (rawSlotUnknown.max_frames !== undefined) {
      warnings.push(
        toRulesWarning(
          "invalid_slot_max_frames",
          `Slot '${slotId}' has invalid max_frames`,
        ),
      );
    }

    if (Object.keys(slotRule).length > 0) {
      slots[slotId] = slotRule;
    }
  }

  let inputConditions: WorkflowInputCondition[] | undefined;
  if (Array.isArray(raw.input_conditions)) {
    const normalizedConditions = raw.input_conditions.flatMap((condition) => {
      if (!isRecord(condition)) return [];
      if (condition.kind !== "at_least_one") return [];
      if (!Array.isArray(condition.inputs)) return [];

      const inputs = condition.inputs
        .filter((inputId): inputId is string => typeof inputId === "string")
        .map((inputId) => inputId.trim())
        .filter((inputId) => inputId.length > 0);
      if (inputs.length === 0) return [];

      return [
        {
          kind: "at_least_one" as const,
          inputs,
          ...(typeof condition.message === "string" &&
          condition.message.trim().length > 0
            ? { message: condition.message.trim() }
            : {}),
        },
      ];
    });

    if (normalizedConditions.length > 0) {
      inputConditions = normalizedConditions;
    }
  }

  const maskCropping: WorkflowMaskCroppingConfig = {
    ...DEFAULT_WORKFLOW_MASK_CROPPING,
  };
  const rawMaskCropping = raw.mask_cropping;
  if (rawMaskCropping !== undefined && !isRecord(rawMaskCropping)) {
    warnings.push(
      toRulesWarning(
        "invalid_mask_cropping_rule",
        "mask_cropping must be an object",
      ),
    );
  }
  const maskCroppingRecord = toStringRecord(rawMaskCropping);
  if ("mode" in maskCroppingRecord) {
    if (
      maskCroppingRecord.mode === "crop" ||
      maskCroppingRecord.mode === "full"
    ) {
      maskCropping.mode = maskCroppingRecord.mode;
    } else {
      warnings.push(
        toRulesWarning(
          "invalid_mask_cropping_mode",
          "mask_cropping.mode must be 'crop' or 'full'; defaulting to crop",
        ),
      );
    }
  } else if ("enabled" in maskCroppingRecord) {
    if (typeof maskCroppingRecord.enabled === "boolean") {
      maskCropping.mode = maskCroppingRecord.enabled ? "crop" : "full";
    } else {
      warnings.push(
        toRulesWarning(
          "invalid_mask_cropping_enabled",
          "mask_cropping.enabled must be a boolean; defaulting to crop",
        ),
      );
    }
  }

  const postprocessing: WorkflowPostprocessingConfig = {
    ...DEFAULT_WORKFLOW_POSTPROCESSING,
  };
  const rawPostprocessing = raw.postprocessing;
  if (rawPostprocessing !== undefined && !isRecord(rawPostprocessing)) {
    warnings.push(
      toRulesWarning(
        "invalid_postprocessing_rule",
        "postprocessing must be an object",
      ),
    );
  }
  const postprocessingRecord = toStringRecord(rawPostprocessing);
  if ("mode" in postprocessingRecord) {
    const rawMode = postprocessingRecord.mode;
    if (
      rawMode === "auto" ||
      rawMode === "stitch_frames_with_audio" ||
      rawMode === "none"
    ) {
      postprocessing.mode = rawMode;
    } else {
      warnings.push(
        toRulesWarning(
          "invalid_postprocessing_mode",
          "postprocessing.mode is invalid; defaulting to 'auto'",
        ),
      );
    }
  }
  if ("panel_preview" in postprocessingRecord) {
    const rawPanelPreview = postprocessingRecord.panel_preview;
    if (
      rawPanelPreview === "raw_outputs" ||
      rawPanelPreview === "replace_outputs"
    ) {
      postprocessing.panel_preview = rawPanelPreview;
    } else {
      warnings.push(
        toRulesWarning(
          "invalid_postprocessing_panel_preview",
          "postprocessing.panel_preview is invalid; defaulting to 'raw_outputs'",
        ),
      );
    }
  }
  if ("on_failure" in postprocessingRecord) {
    const rawOnFailure = postprocessingRecord.on_failure;
    if (rawOnFailure === "fallback_raw" || rawOnFailure === "show_error") {
      postprocessing.on_failure = rawOnFailure;
    } else {
      warnings.push(
        toRulesWarning(
          "invalid_postprocessing_on_failure",
          "postprocessing.on_failure is invalid; defaulting to 'fallback_raw'",
        ),
      );
    }
  }
  if ("stitch_fps" in postprocessingRecord) {
    const rawStitchFps = toPositiveInteger(postprocessingRecord.stitch_fps);
    if (rawStitchFps !== null) {
      postprocessing.stitch_fps = rawStitchFps;
    } else {
      warnings.push(
        toRulesWarning(
          "invalid_postprocessing_stitch_fps",
          "postprocessing.stitch_fps is invalid; ignoring override",
        ),
      );
    }
  }

  let aspectRatioProcessing: WorkflowAspectRatioProcessingConfig | undefined;
  const rawArp = raw.aspect_ratio_processing;
  if (isRecord(rawArp)) {
    const resolutions: number[] = [];
    if (Array.isArray(rawArp.resolutions)) {
      for (const r of rawArp.resolutions) {
        if (typeof r === "number" && Number.isFinite(r) && r > 0) {
          resolutions.push(Math.round(r));
        }
      }
    }

    const targetNodes: WorkflowAspectRatioProcessingConfig["target_nodes"] = [];
    if (Array.isArray(rawArp.target_nodes)) {
      for (const tn of rawArp.target_nodes) {
        if (
          isRecord(tn) &&
          typeof tn.node_id === "string" &&
          typeof tn.width_param === "string" &&
          typeof tn.height_param === "string"
        ) {
          targetNodes.push({
            node_id: tn.node_id,
            width_param: tn.width_param,
            height_param: tn.height_param,
          });
        }
      }
    }

    const arpPostprocess = isRecord(rawArp.postprocess)
      ? rawArp.postprocess
      : {};
    aspectRatioProcessing = {
      enabled: Boolean(rawArp.enabled),
      stride:
        typeof rawArp.stride === "number" && rawArp.stride > 0
          ? rawArp.stride
          : 16,
      search_steps:
        typeof rawArp.search_steps === "number" && rawArp.search_steps >= 0
          ? rawArp.search_steps
          : 2,
      resolutions,
      target_nodes: targetNodes,
      postprocess: {
        enabled: arpPostprocess.enabled !== false,
        mode:
          typeof arpPostprocess.mode === "string"
            ? arpPostprocess.mode
            : "stretch_exact",
        apply_to:
          typeof arpPostprocess.apply_to === "string"
            ? arpPostprocess.apply_to
            : "all_visual_outputs",
      },
    };
  }

  return {
    rules: {
      version,
      nodes,
      ...(inputConditions ? { input_conditions: inputConditions } : {}),
      output_injections: toStringRecord(
        raw.output_injections,
      ) as WorkflowRules["output_injections"],
      slots,
      mask_cropping: maskCropping,
      postprocessing,
      ...(aspectRatioProcessing
        ? { aspect_ratio_processing: aspectRatioProcessing }
        : {}),
    },
    warnings,
  };
}

function toWorkflowInputType(value: string): WorkflowInput["inputType"] | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === "text") return "text";
  if (normalized === "image") return "image";
  if (normalized === "video") return "video";
  return null;
}

function toSlotInputType(
  value: string,
): {
  uiInputType: WorkflowInput["inputType"];
  slotInputType: WorkflowRuleSlotInputType;
} | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === "text") {
    return { uiInputType: "text", slotInputType: "text" };
  }
  if (normalized === "image") {
    return { uiInputType: "image", slotInputType: "image" };
  }
  if (normalized === "video") {
    return { uiInputType: "video", slotInputType: "video" };
  }
  if (normalized === "audio") {
    // Audio slots use a video source in the UI so preprocessing can extract audio.
    return { uiInputType: "video", slotInputType: "audio" };
  }
  return null;
}

function toSelectionConfig(
  selection: WorkflowRuleSelectionConfig | undefined,
): WorkflowManualSlotSelectionConfig | undefined {
  if (!selection) return undefined;

  const next: WorkflowManualSlotSelectionConfig = {};
  if (typeof selection.export_fps === "number" && selection.export_fps > 0) {
    next.exportFps = selection.export_fps;
  }
  if (typeof selection.frame_step === "number" && selection.frame_step > 0) {
    next.frameStep = selection.frame_step;
  }
  if (typeof selection.max_frames === "number" && selection.max_frames > 0) {
    next.maxFrames = selection.max_frames;
  }

  return Object.keys(next).length > 0 ? next : undefined;
}

function collectReferencedManualSlots(
  outputInjections: WorkflowRules["output_injections"],
): Set<string> {
  const slotIds = new Set<string>();
  for (const targetNode of Object.values(outputInjections)) {
    if (!isRecord(targetNode)) continue;
    for (const outputRule of Object.values(targetNode)) {
      if (!isRecord(outputRule)) continue;
      const source = outputRule.source;
      if (!isRecord(source)) continue;
      if (source.kind !== "manual_slot") continue;
      if (typeof source.slot_id !== "string" || source.slot_id.trim() === "") {
        continue;
      }
      slotIds.add(source.slot_id);
    }
  }
  return slotIds;
}

function hasPresentOverrides(
  present: WorkflowRuleNodePresent | undefined,
): boolean {
  if (!present) return false;
  const keys = Object.keys(present);
  return keys.some((key) => key !== "enabled");
}

type ConditioningRole = "positive" | "negative";

function toConditioningRole(value: string | undefined): ConditioningRole | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized.includes("positive")) return "positive";
  if (normalized.includes("negative")) return "negative";
  return null;
}

function toConditioningLabel(role: ConditioningRole): string {
  return role === "positive" ? "Positive Prompt" : "Negative Prompt";
}

function resolveConditioningRoles(
  inferredInputs: WorkflowInput[],
  workflow: Record<string, unknown> | null | undefined,
): Map<string, ConditioningRole> {
  const roles = new Map<string, ConditioningRole>();
  const directlyResolvedNodeIds = new Set<string>();
  const ambiguousDirectNodeIds = new Set<string>();

  for (const input of inferredInputs) {
    if (input.inputType !== "text") continue;
    const role = toConditioningRole(input.label);
    if (role) {
      roles.set(input.nodeId, role);
    }
  }

  if (!workflow) return roles;

  for (const node of Object.values(workflow)) {
    if (!isRecord(node)) continue;
    const nodeInputs = isRecord(node.inputs) ? node.inputs : {};

    for (const [inputName, inputValue] of Object.entries(nodeInputs)) {
      const role = toConditioningRole(inputName);
      if (!role) continue;
      if (!Array.isArray(inputValue) || typeof inputValue[0] !== "string") {
        continue;
      }

      const sourceNodeId = inputValue[0];
      if (ambiguousDirectNodeIds.has(sourceNodeId)) continue;

      const existing = roles.get(sourceNodeId);
      if (
        directlyResolvedNodeIds.has(sourceNodeId) &&
        existing &&
        existing !== role
      ) {
        roles.delete(sourceNodeId);
        ambiguousDirectNodeIds.add(sourceNodeId);
        continue;
      }

      roles.set(sourceNodeId, role);
      directlyResolvedNodeIds.add(sourceNodeId);
    }
  }

  return roles;
}

function sortConditioningInputs(
  inputs: WorkflowInput[],
  conditioningRoles: ReadonlyMap<string, ConditioningRole>,
): WorkflowInput[] {
  const indexedConditioningInputs = inputs
    .map((input, index) => ({
      index,
      input,
      role:
        input.inputType === "text"
          ? (conditioningRoles.get(input.nodeId) ?? null)
          : null,
    }))
    .filter(
      (
        entry,
      ): entry is {
        index: number;
        input: WorkflowInput;
        role: ConditioningRole;
      } => entry.role !== null,
    );

  if (indexedConditioningInputs.length < 2) return inputs;

  const hasPositive = indexedConditioningInputs.some(
    (entry) => entry.role === "positive",
  );
  const hasNegative = indexedConditioningInputs.some(
    (entry) => entry.role === "negative",
  );
  if (!hasPositive || !hasNegative) return inputs;

  const sorted = [...indexedConditioningInputs].sort((left, right) => {
    if (left.role === right.role) return left.index - right.index;
    return left.role === "positive" ? -1 : 1;
  });
  const nextInputs = [...inputs];

  indexedConditioningInputs.forEach((entry, orderIndex) => {
    nextInputs[entry.index] = sorted[orderIndex].input;
  });

  return nextInputs;
}

export function resolvePresentedInputs(
  inferredInputs: WorkflowInput[],
  rawRules: unknown,
  workflow?: Record<string, unknown> | null,
): ResolvePresentedInputsResult {
  const { rules, warnings: normalizeWarnings } =
    normalizeWorkflowRules(rawRules);
  const presentationWarnings: WorkflowRuleWarning[] = [...normalizeWarnings];
  const inferredMap = new Map(
    inferredInputs.map((input) => [input.nodeId, input]),
  );
  const conditioningRoles = resolveConditioningRoles(inferredInputs, workflow);
  const resolved: WorkflowInput[] = [];
  const derivedMaskMappings: DerivedMaskMapping[] = [];

  for (const inferred of inferredInputs) {
    const nodeRule = rules.nodes[inferred.nodeId];
    const present = nodeRule?.present;
    const selectionConfig = toSelectionConfig(nodeRule?.selection);
    if (nodeRule?.ignore) {
      continue;
    }
    if (present?.enabled === false) {
      continue;
    }
    // Nodes with a derived mask rule are hidden from the UI; they are
    // auto-populated during preprocessing with the rendered mask.
    const derivedMask = nodeRule?.binary_derived_mask_of
      ? ({ sourceNodeId: nodeRule.binary_derived_mask_of, maskType: "binary" } as const)
      : nodeRule?.soft_derived_mask_of
        ? ({ sourceNodeId: nodeRule.soft_derived_mask_of, maskType: "soft" } as const)
        : null;
    if (derivedMask) {
      derivedMaskMappings.push({
        maskNodeId: inferred.nodeId,
        maskParam: present?.param ?? inferred.param,
        sourceNodeId: derivedMask.sourceNodeId,
        maskType: derivedMask.maskType,
      });
      continue;
    }

    const nextInput: WorkflowInput = {
      ...inferred,
      origin: nodeRule && hasPresentOverrides(present) ? "rule" : "inferred",
      dispatch:
        inferred.dispatch ??
        {
          kind: "node",
          ...(selectionConfig ? { selectionConfig } : {}),
        },
    };

    if (selectionConfig && nextInput.dispatch?.kind === "node") {
      nextInput.dispatch = {
        ...nextInput.dispatch,
        selectionConfig,
      };
    }

    if (present?.label) {
      nextInput.label = present.label;
    }
    if (present?.param) {
      nextInput.param = present.param;
    }
    if (present?.class_type) {
      nextInput.classType = present.class_type;
    }
    if (present?.input_type) {
      const mappedInputType = toWorkflowInputType(present.input_type);
      if (mappedInputType) {
        nextInput.inputType = mappedInputType;
      } else {
        presentationWarnings.push(
          toRulesWarning(
            "unsupported_present_input_type",
            `Unsupported present input type '${present.input_type}'`,
            inferred.nodeId,
          ),
        );
      }
    }

    if (!present?.label && nextInput.inputType === "text") {
      const role = conditioningRoles.get(nextInput.nodeId);
      if (role) {
        nextInput.label = toConditioningLabel(role);
      }
    }

    resolved.push(nextInput);
  }

  for (const [nodeId, nodeRule] of Object.entries(rules.nodes)) {
    if (inferredMap.has(nodeId) || nodeRule.ignore) continue;
    const present = nodeRule.present;
    const selectionConfig = toSelectionConfig(nodeRule.selection);
    if (!present || present.enabled === false) continue;
    if (!present.input_type) {
      presentationWarnings.push(
        toRulesWarning(
          "missing_present_input_type",
          "Rule-defined input requires present.input_type",
          nodeId,
        ),
      );
      continue;
    }
    const inputType = toWorkflowInputType(present.input_type);
    if (!inputType) {
      presentationWarnings.push(
        toRulesWarning(
          "unsupported_present_input_type",
          `Unsupported present input type '${present.input_type}'`,
          nodeId,
        ),
      );
      continue;
    }
    if (!present.param) {
      presentationWarnings.push(
        toRulesWarning(
          "missing_present_param",
          "Rule-defined input requires present.param",
          nodeId,
        ),
      );
      continue;
    }

    const classType = present.class_type ?? "RuleInput";
    resolved.push({
      nodeId,
      classType,
      inputType,
      param: present.param,
      label: present.label ?? classType,
      currentValue: null,
      origin: "rule",
      dispatch: {
        kind: "node",
        ...(selectionConfig ? { selectionConfig } : {}),
      },
    });
  }

  const referencedSlots = collectReferencedManualSlots(rules.output_injections);
  for (const slotId of referencedSlots) {
    const slotRule = rules.slots[slotId];
    if (!slotRule) {
      presentationWarnings.push(
        toRulesWarning(
          "missing_slot_definition",
          `Missing slot definition for '${slotId}'`,
        ),
      );
      continue;
    }
    if (typeof slotRule.input_type !== "string") {
      presentationWarnings.push(
        toRulesWarning(
          "missing_slot_input_type",
          `Slot '${slotId}' is missing input_type`,
        ),
      );
      continue;
    }

    const mapped = toSlotInputType(slotRule.input_type);
    if (!mapped) {
      presentationWarnings.push(
        toRulesWarning(
          "unsupported_slot_input_type",
          `Unsupported slot input type '${slotRule.input_type}'`,
        ),
      );
      continue;
    }

    const syntheticNodeId = `slot:${slotId}`;
    if (resolved.some((input) => input.nodeId === syntheticNodeId)) {
      continue;
    }

    const selectionConfig: {
      exportFps?: number;
      frameStep?: number;
      maxFrames?: number;
    } = {};
    if (typeof slotRule.export_fps === "number" && slotRule.export_fps > 0) {
      selectionConfig.exportFps = slotRule.export_fps;
    }
    if (typeof slotRule.frame_step === "number" && slotRule.frame_step > 0) {
      selectionConfig.frameStep = slotRule.frame_step;
    }
    if (typeof slotRule.max_frames === "number" && slotRule.max_frames > 0) {
      selectionConfig.maxFrames = slotRule.max_frames;
    }
    const hasSelectionConfig = Object.keys(selectionConfig).length > 0;

    resolved.push({
      nodeId: syntheticNodeId,
      classType: "ManualSlot",
      inputType: mapped.uiInputType,
      param: slotRule.param ?? slotId,
      label: slotRule.label ?? slotId,
      currentValue: null,
      origin: "rule",
      dispatch: {
        kind: "manual_slot",
        slotId,
        slotInputType: mapped.slotInputType,
        ...(hasSelectionConfig ? { selectionConfig } : {}),
      },
    });
  }

  const sortedInputs = sortConditioningInputs(resolved, conditioningRoles);

  return {
    inputs: sortedInputs,
    widgetInputs: [],
    hasInferredInputs: sortedInputs.some((input) => input.origin === "inferred"),
    derivedMaskMappings,
    presentationWarnings,
  };
}

// ---------------------------------------------------------------------------
// Widget input resolution
// ---------------------------------------------------------------------------

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
  if (!workflow) {
    console.debug("[resolveWidgetInputs] No workflow provided");
    return [];
  }

  const { rules } = normalizeWorkflowRules(rawRules);
  const nodesWithWidgets = Object.entries(rules.nodes).filter(
    ([, nr]) => nr.widgets && Object.keys(nr.widgets).length > 0,
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

  const result: WorkflowWidgetInput[] = [];

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
      result.push({
        nodeId,
        param,
        config,
        currentValue: rawValue ?? config.defaultValue ?? null,
      });
    }
  }

  console.info("[resolveWidgetInputs] Resolved %d widget inputs", result.length);
  return result;
}
